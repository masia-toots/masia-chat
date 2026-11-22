import { afterEach, describe, expect, it } from 'vitest';
import { RELAY_PREFIX } from '../shared/paths.js';
import {
  EVENT_STREAM_TYPE,
  PROXY_BODY_MAX_BYTES,
  ProxyRefusal,
  proxyToRelay,
  relayTarget,
  STREAM_HEADERS,
} from './proxy.js';
import { listen, type Listening } from './test-kit.js';

const RELAY = new URL('http://relay.internal:3400');

describe('relayTarget', () => {
  it('maps a page URL under the prefix to the same path and query on the relay', () => {
    expect(relayTarget(`${RELAY_PREFIX}/conversations/dm_a_b/e2ee`, RELAY).href).toBe(
      'http://relay.internal:3400/conversations/dm_a_b/e2ee',
    );
    expect(relayTarget(`${RELAY_PREFIX}/x/handshakes?fromEpoch=0&afterSeq=3&limit=500`, RELAY).search).toBe(
      '?fromEpoch=0&afterSeq=3&limit=500',
    );
    expect(relayTarget(RELAY_PREFIX, RELAY).href).toBe('http://relay.internal:3400/');
  });

  it('answers 404 for a path that is not under the prefix', () => {
    for (const url of ['/', '/demo/login', '/relayx/a', '/relay-other']) {
      expect(() => relayTarget(url, RELAY), url).toThrow(ProxyRefusal);
      try {
        relayTarget(url, RELAY);
      } catch (error) {
        expect((error as ProxyRefusal).status).toBe(404);
      }
    }
  });

  it('answers 400 for anything that could climb out of the relay\'s routes', () => {
    const unsafe = [
      `${RELAY_PREFIX}/../admin`,
      `${RELAY_PREFIX}/a/../../b`,
      `${RELAY_PREFIX}/./a`,
      `${RELAY_PREFIX}//evil.example/x`,
      `${RELAY_PREFIX}/a//b`,
      `${RELAY_PREFIX}/a\\b`,
      `${RELAY_PREFIX}/%2e%2e/admin`,
      `${RELAY_PREFIX}/a%2fb`,
      `${RELAY_PREFIX}/a%5cb`,
      `${RELAY_PREFIX}/a%00`,
    ];
    for (const url of unsafe) {
      try {
        relayTarget(url, RELAY);
        throw new Error(`${url} was accepted`);
      } catch (error) {
        expect(error, url).toBeInstanceOf(ProxyRefusal);
        expect((error as ProxyRefusal).status, url).toBe(400);
      }
    }
  });
});

describe('proxyToRelay', () => {
  interface Seen {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string;
  }
  let door: Listening | undefined;

  afterEach(async () => {
    await door?.close();
    door = undefined;
  });

  /** A door with a fake relay behind it: `answer` builds the relay's response and `seen` records what it was sent. */
  async function open(answer: (seen: Seen) => Response | Promise<Response> = () => Response.json({ ok: true })) {
    const seen: Seen[] = [];
    const fakeRelay: typeof fetch = async (input, init) => {
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((value, key) => (headers[key] = value));
      const record: Seen = {
        url: String(input),
        method: init?.method ?? 'GET',
        headers,
        body: init?.body === undefined ? '' : Buffer.from(init.body as Uint8Array).toString('utf8'),
      };
      seen.push(record);
      return answer(record);
    };
    door = await listen((request, response) => {
      void proxyToRelay(request, response, RELAY, fakeRelay);
    });
    return { origin: door.origin, seen };
  }

  it('forwards the method, path, query, body and the three headers the relay uses, and nothing else', async () => {
    const { origin, seen } = await open();
    const answer = await fetch(`${origin}${RELAY_PREFIX}/conversations/r1/envelopes?afterSeq=2`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer t0k',
        'content-type': 'application/json',
        accept: 'application/json',
        cookie: 'secret=1',
        'x-forwarded-for': '10.0.0.1',
        'x-demo-session': 'must-not-cross',
      },
      body: '{"a":1}',
    });
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ ok: true });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe('http://relay.internal:3400/conversations/r1/envelopes?afterSeq=2');
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.body).toBe('{"a":1}');
    expect(Object.keys(seen[0]?.headers ?? {}).sort()).toEqual(['accept', 'authorization', 'content-type']);
    expect(seen[0]?.headers['authorization']).toBe('Bearer t0k');
  });

  it('hands back the relay\'s status, its error body and Retry-After, and no other header', async () => {
    const { origin } = await open(
      () =>
        new Response(JSON.stringify({ error: 'RATE_LIMITED' }), {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': '3', 'set-cookie': 'a=b', 'x-internal': '1' },
        }),
    );
    const answer = await fetch(`${origin}${RELAY_PREFIX}/users/u1/device-list`);
    expect(answer.status).toBe(429);
    expect(answer.headers.get('retry-after')).toBe('3');
    expect(answer.headers.get('set-cookie')).toBeNull();
    expect(answer.headers.get('x-internal')).toBeNull();
    expect(await answer.json()).toEqual({ error: 'RATE_LIMITED' });
  });

  it('sends no body with a GET', async () => {
    const { origin, seen } = await open();
    await fetch(`${origin}${RELAY_PREFIX}/health`);
    expect(seen[0]?.method).toBe('GET');
    expect(seen[0]?.body).toBe('');
  });

  it('refuses a method the relay does not use, with 405, without calling the relay', async () => {
    const { origin, seen } = await open();
    const answer = await fetch(`${origin}${RELAY_PREFIX}/devices`, { method: 'PUT', body: 'x' });
    expect(answer.status).toBe(405);
    expect(seen).toEqual([]);
  });

  it('refuses a body over the cap with 413, without calling the relay', async () => {
    const { origin, seen } = await open();
    const answer = await fetch(`${origin}${RELAY_PREFIX}/devices`, {
      method: 'POST',
      body: new Uint8Array(PROXY_BODY_MAX_BYTES + 1),
    });
    expect(answer.status).toBe(413);
    expect(seen).toEqual([]);
  });

  it('answers 502 when the relay does not answer, and says nothing about why', async () => {
    const { origin } = await open(() => {
      throw new Error('connect ECONNREFUSED 10.1.2.3:3400');
    });
    const answer = await fetch(`${origin}${RELAY_PREFIX}/health`);
    expect(answer.status).toBe(502);
    const text = await answer.text();
    expect(text).not.toContain('ECONNREFUSED');
    expect(text).not.toContain('10.1.2.3');
  });

  it('passes a live event stream on as the relay writes it, unbuffered, and lets go of it when the browser leaves', async () => {
    const encoder = new TextEncoder();
    let push: (text: string) => void = () => undefined;
    let cancelled!: () => void;
    const gone = new Promise<void>((resolve) => (cancelled = resolve));
    door = await listen((request, response) => {
      void proxyToRelay(request, response, RELAY, async (_input, init) => {
        init?.signal?.addEventListener('abort', () => cancelled());
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            push = (text) => controller.enqueue(encoder.encode(text));
          },
          cancel: () => cancelled(),
        });
        return new Response(body, { status: 200, headers: { 'content-type': `${EVENT_STREAM_TYPE}; charset=utf-8` } });
      });
    });

    const controller = new AbortController();
    const answer = await fetch(`${door.origin}${RELAY_PREFIX}/calls/stream`, {
      headers: { authorization: 'Bearer t0k', accept: EVENT_STREAM_TYPE },
      signal: controller.signal,
    });
    // The headers came before any event: the stream is open, not waiting to be read whole.
    expect(answer.status).toBe(200);
    expect(answer.headers.get('content-type')).toBe(`${EVENT_STREAM_TYPE}; charset=utf-8`);
    expect(answer.headers.get('content-length')).toBeNull();
    expect(answer.headers.get('cache-control')).toBe(STREAM_HEADERS['cache-control']);
    expect(answer.headers.get('x-accel-buffering')).toBe(STREAM_HEADERS['x-accel-buffering']);

    const reader = (answer.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    const first = 'event: ready\ndata: {"closesInMs":60000}\n\n';
    push(first);
    let seen = '';
    while (seen.length < first.length) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error('the stream ended before its first event');
      seen += decoder.decode(chunk.value, { stream: true });
    }
    // The first event arrived while the relay's stream is still open.
    expect(seen).toBe(first);

    // The browser leaves: the door cancels the relay's stream (or aborts its request) instead of holding it open.
    controller.abort();
    await reader.cancel().catch(() => undefined);
    await gone;
  });

  it('does not follow a redirect the relay sends', async () => {
    const seenOptions: (RequestRedirect | undefined)[] = [];
    door = await listen((request, response) => {
      void proxyToRelay(
        request,
        response,
        RELAY,
        async (_input, init) => {
          seenOptions.push(init?.redirect);
          return new Response(null, { status: 302, headers: { location: 'http://elsewhere.example/' } });
        },
      );
    });
    const answer = await fetch(`${door.origin}${RELAY_PREFIX}/health`, { redirect: 'manual' });
    expect(seenOptions).toEqual(['manual']);
    expect(answer.headers.get('location')).toBeNull();
  });
});
