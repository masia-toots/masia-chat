import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { RELAY_PREFIX } from '../shared/paths.js';

// A same-origin door to the relay. The browser talks to `/relay/...` on the page's own origin, so the
// playground needs no CORS rules and the relay needs no published port. The proxy adds nothing and
// reads nothing: it forwards the caller's `Authorization` header (the relay checks the token itself)
// and the body bytes, and hands the relay's answer back.
//
// An ordinary answer is read whole and sent with its length. A live event stream (the call channel's
// `text/event-stream`) is passed on chunk by chunk as the relay writes it: buffered, a call's signals
// would arrive only when the stream ends. When the browser goes away, the relay's stream is let go too.
//
// What it refuses is the proxy's own business: a path that could leave the relay's routes, a body over
// the cap, and any header the relay has no use for.

/** Largest request body forwarded. A handshake is capped at 256 KiB, a Welcome rides inside one. */
export const PROXY_BODY_MAX_BYTES = 1024 * 1024;

/** Request headers that cross; everything else (cookies, host, forwarding chains) stays behind. */
const FORWARDED_REQUEST_HEADERS = ['authorization', 'content-type', 'accept'] as const;
/** Response headers that cross back. */
const FORWARDED_RESPONSE_HEADERS = ['content-type', 'retry-after'] as const;

/** The media type of a live event stream: such an answer is never buffered. */
export const EVENT_STREAM_TYPE = 'text/event-stream';
/** Added to a live stream, so nothing between this door and the browser holds its events back or rewrites them. */
export const STREAM_HEADERS = { 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' } as const;

const METHODS_WITH_BODY = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const ALLOWED_METHODS = new Set(['GET', 'POST', 'DELETE']);

/** Anything that could climb out of the relay's routes: dot segments, doubled or encoded separators, backslashes. */
const UNSAFE_PATH = /(^|\/)\.{1,2}(\/|$)|\/\/|\\|%2e|%2f|%5c|%00/i;

export class ProxyRefusal extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ProxyRefusal';
    this.status = status;
  }
}

/** The relay-side path and query for a browser URL, or a refusal. Pure, for tests. */
export function relayTarget(requestUrl: string, relayUrl: URL): URL {
  if (requestUrl !== RELAY_PREFIX && !requestUrl.startsWith(`${RELAY_PREFIX}/`)) {
    throw new ProxyRefusal(404, 'not a relay path');
  }
  const rest = requestUrl.slice(RELAY_PREFIX.length) || '/';
  if (!rest.startsWith('/') || UNSAFE_PATH.test(rest.split('?')[0] ?? '')) {
    throw new ProxyRefusal(400, 'unsafe path');
  }
  const target = new URL(rest, relayUrl);
  if (target.origin !== relayUrl.origin) throw new ProxyRefusal(400, 'unsafe path');
  return target;
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const piece = chunk as Buffer;
    size += piece.length;
    if (size > PROXY_BODY_MAX_BYTES) throw new ProxyRefusal(413, 'body too large');
    chunks.push(piece);
  }
  return Buffer.concat(chunks);
}

function refuse(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify({ error: 'PROXY_REFUSED', message }));
}

function isEventStream(answer: Response): boolean {
  const type = answer.headers.get('content-type') ?? '';
  return type.split(';')[0]?.trim().toLowerCase() === EVENT_STREAM_TYPE;
}

/** Passes a live stream on as it comes, with backpressure; resolves when either end is done. */
async function stream(answer: Response, response: ServerResponse, out: Record<string, string>): Promise<void> {
  response.writeHead(answer.status, { ...out, ...STREAM_HEADERS });
  // The browser's `fetch` resolves on the headers: send them now, not with the first event.
  response.flushHeaders();
  if (answer.body === null) {
    response.end();
    return;
  }
  // The DOM and Node name the same web stream with two types.
  await pipeline(Readable.fromWeb(answer.body as unknown as NodeReadableStream<Uint8Array>), response);
}

/** Forwards one `/relay/...` request. Never throws: every failure is an answer. */
export async function proxyToRelay(
  request: IncomingMessage,
  response: ServerResponse,
  relayUrl: URL,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  // The browser went away (or the answer is done): whatever the relay is still sending is let go.
  const upstream = new AbortController();
  response.on('close', () => upstream.abort());
  try {
    const method = request.method ?? 'GET';
    if (!ALLOWED_METHODS.has(method)) throw new ProxyRefusal(405, 'method not allowed');
    const target = relayTarget(request.url ?? '', relayUrl);
    const headers = new Headers();
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = request.headers[name];
      if (typeof value === 'string') headers.set(name, value);
    }
    const body = METHODS_WITH_BODY.has(method) ? await readBody(request) : undefined;
    const answer = await fetchImpl(target, {
      method,
      headers,
      ...(body !== undefined && body.length > 0 ? { body: new Uint8Array(body) } : {}),
      redirect: 'manual',
      signal: upstream.signal,
    });
    const out: Record<string, string> = {};
    for (const name of FORWARDED_RESPONSE_HEADERS) {
      const value = answer.headers.get(name);
      if (value !== null) out[name] = value;
    }
    if (isEventStream(answer)) {
      await stream(answer, response, out);
      return;
    }
    const bytes = Buffer.from(await answer.arrayBuffer());
    response.writeHead(answer.status, { ...out, 'content-length': String(bytes.length) });
    response.end(bytes);
  } catch (error) {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    if (error instanceof ProxyRefusal) {
      refuse(response, error.status, error.message);
      return;
    }
    refuse(response, 502, 'the relay did not answer');
  }
}
