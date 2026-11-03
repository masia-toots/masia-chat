import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { RELAY_HEALTH_PATH } from '@masia/contracts/wire';
import { DEMO_PATHS, RELAY_PREFIX, SESSION_HEADER } from '../shared/paths.js';
import type { TokenIssuer } from './issuer.js';
import type { PeopleBook } from './people.js';
import { proxyToRelay } from './proxy.js';
import { serveStatic } from './static.js';

// The playground's whole server, as one request handler: sign in, mint a relay token, list who is here,
// hand over the seed contacts, forward `/relay/*`, serve the built page. DEMO ONLY: it mints a token
// for anyone who types a name. It listens on loopback unless the compose file says otherwise.

const JSON_BODY_MAX_BYTES = 4096;
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
} as const;

export interface DemoDeps {
  readonly people: PeopleBook;
  readonly issuer: TokenIssuer;
  readonly relayUrl: URL;
  readonly contactsFile: string;
  readonly distDir: string;
  /** Injectable for tests. */
  readonly fetch?: typeof fetch;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, { ...JSON_HEADERS, 'content-length': String(Buffer.byteLength(text)) });
  response.end(text);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const piece = chunk as Buffer;
    size += piece.length;
    if (size > JSON_BODY_MAX_BYTES) throw new Error('body too large');
    chunks.push(piece);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function sessionOf(request: IncomingMessage, people: PeopleBook) {
  const header = request.headers[SESSION_HEADER];
  return people.bySession(typeof header === 'string' ? header : undefined);
}

export function createDemoHandler(deps: DemoDeps) {
  const { people, issuer } = deps;

  async function handleDemo(
    request: IncomingMessage,
    response: ServerResponse,
    path: string,
  ): Promise<void> {
    const method = request.method ?? 'GET';

    if (path === DEMO_PATHS.health && method === 'GET') {
      sendJson(response, 200, { ok: true, people: people.size });
      return;
    }

    if (path === DEMO_PATHS.relayHealth && method === 'GET') {
      // The compose file waits on this: the page is only useful once the relay behind it answers.
      try {
        const answer = await (deps.fetch ?? fetch)(new URL(RELAY_HEALTH_PATH, deps.relayUrl));
        sendJson(response, answer.ok ? 200 : 503, { ok: answer.ok });
      } catch {
        sendJson(response, 503, { ok: false });
      }
      return;
    }

    if (path === DEMO_PATHS.contacts && method === 'GET') {
      try {
        const text = await readFile(deps.contactsFile, 'utf8');
        response.writeHead(200, { ...JSON_HEADERS, 'content-length': String(Buffer.byteLength(text)) });
        response.end(text);
      } catch {
        sendJson(response, 200, { contacts: [] });
      }
      return;
    }

    if (path === DEMO_PATHS.login && method === 'POST') {
      let name: unknown;
      try {
        name = ((await readJson(request)) as { name?: unknown } | null)?.name;
      } catch {
        sendJson(response, 400, { error: 'BAD_REQUEST' });
        return;
      }
      const signedIn = people.signIn(name);
      if (signedIn === null) {
        sendJson(response, 422, { error: 'BAD_NAME' });
        return;
      }
      const { person, session } = signedIn;
      sendJson(response, 201, {
        userId: person.userId,
        deviceId: person.deviceId,
        displayName: person.displayName,
        session,
      });
      return;
    }

    const person = sessionOf(request, people);
    if (person === null) {
      sendJson(response, 401, { error: 'SIGN_IN_REQUIRED' });
      return;
    }

    if (path === DEMO_PATHS.token && method === 'GET') {
      const minted = issuer.mint(people.subjectOf(person));
      sendJson(response, 200, { token: minted.token, expiresAt: minted.expiresAt });
      return;
    }

    if (path === DEMO_PATHS.people && method === 'GET') {
      sendJson(response, 200, { people: people.others(person.userId) });
      return;
    }

    sendJson(response, 404, { error: 'NOT_FOUND' });
  }

  return async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = request.url ?? '/';
    const path = url.split('?')[0] ?? '/';
    try {
      if (path === RELAY_PREFIX || path.startsWith(`${RELAY_PREFIX}/`)) {
        await proxyToRelay(request, response, deps.relayUrl, deps.fetch);
        return;
      }
      if (path.startsWith('/demo/')) {
        await handleDemo(request, response, path);
        return;
      }
      const method = request.method ?? 'GET';
      if (method !== 'GET' && method !== 'HEAD') {
        sendJson(response, 405, { error: 'METHOD_NOT_ALLOWED' });
        return;
      }
      await serveStatic(response, deps.distDir, url, method);
    } catch {
      if (!response.headersSent) sendJson(response, 500, { error: 'INTERNAL' });
      else response.destroy();
    }
  };
}

export function createDemoServer(deps: DemoDeps): Server {
  const handle = createDemoHandler(deps);
  return createServer((request, response) => {
    void handle(request, response);
  });
}
