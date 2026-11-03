import { RELAY_PROTOCOL_VERSION, RelayErrorCode } from '@masia/relay';
import { describe, expect, it } from 'vitest';
import { resolveRelayBasePath, resolveRelayHost } from '../config.js';
import { buildServer, MAX_REQUEST_BODY_BYTES } from '../server.js';
import {
  signTestToken,
  TEST_TOKEN_EXPECTATIONS,
  TEST_TOKEN_KEYS,
  unusedDatabase,
} from './support/harness.js';

describe('GET /health', () => {
  it('answers ok together with the protocol version, without a token', async () => {
    const database = unusedDatabase();
    const app = await buildServer({
      database,
      tokenKeys: TEST_TOKEN_KEYS,
      tokenExpectations: TEST_TOKEN_EXPECTATIONS,
    });
    try {
      // The literal path is the public contract; do not read it from the constant under test.
      const response = await app.inject({ method: 'GET', url: '/health' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true, protocol: RELAY_PROTOCOL_VERSION });
    } finally {
      await app.close();
      await database.close();
    }
  });
});

describe('a base path mounts the whole relay under one prefix', () => {
  async function withApp<T>(
    basePath: string | undefined,
    run: (app: Awaited<ReturnType<typeof buildServer>>) => Promise<T>,
  ): Promise<T> {
    const database = unusedDatabase();
    const app = await buildServer({
      database,
      tokenKeys: TEST_TOKEN_KEYS,
      tokenExpectations: TEST_TOKEN_EXPECTATIONS,
      ...(basePath === undefined ? {} : { basePath }),
    });
    try {
      return await run(app);
    } finally {
      await app.close();
      await database.close();
    }
  }

  it('serves health and every route under the prefix, and nothing outside it', async () => {
    await withApp('/relay', async (app) => {
      // Literal paths: the prefix is the public contract the proxy rule and the hub depend on.
      const health = await app.inject({ method: 'GET', url: '/relay/health' });
      expect(health.statusCode).toBe(200);
      expect(health.json()).toEqual({ ok: true, protocol: RELAY_PROTOCOL_VERSION });

      // A protected route exists under the prefix (refused for want of a token, not "not found") ...
      const guarded = await app.inject({ method: 'POST', url: '/relay/devices', payload: {} });
      expect(guarded.statusCode).toBe(401);

      // ... and the bare paths are gone.
      for (const [method, url] of [
        ['GET', '/health'],
        ['POST', '/devices'],
        ['GET', '/relayhealth'],
        ['GET', '/relay'],
      ] as const) {
        const response = await app.inject({ method, url });
        expect(response.statusCode, `${method} ${url}`).toBe(404);
      }
    });
  });

  it('serves at the origin root when no prefix is given', async () => {
    for (const basePath of [undefined, '']) {
      await withApp(basePath, async (app) => {
        expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
        expect((await app.inject({ method: 'GET', url: '/relay/health' })).statusCode).toBe(404);
        expect(
          (await app.inject({ method: 'POST', url: '/devices', payload: {} })).statusCode,
        ).toBe(401);
      });
    }
  });

  it('answers over a real socket bound to the resolved host, at the prefixed URL a client builds', async () => {
    await withApp(resolveRelayBasePath({ RELAY_BASE_PATH: '/relay' }), async (app) => {
      const host = resolveRelayHost({ RELAY_HOST: '127.0.0.1' });
      // Port 0: the OS picks a free one, so the test never collides with a relay on this machine.
      await app.listen({ host, port: 0 });
      const address = app.server.address();
      if (address === null || typeof address === 'string') throw new Error('no TCP address');
      // The client joins `relayUrl` (as the host names it) and the path by concatenation.
      const relayUrl = `http://${host}:${address.port}/relay`;
      const response = await fetch(`${relayUrl}/health`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, protocol: RELAY_PROTOCOL_VERSION });
      expect(address.address).toBe('127.0.0.1');
    });
  });

  it('keeps the error contract under the prefix (a refusal is a coded body, not a bare 404)', async () => {
    await withApp('/relay', async (app) => {
      const response = await app.inject({ method: 'POST', url: '/relay/devices', payload: {} });
      expect(response.json()).toMatchObject({ error: RelayErrorCode.UNAUTHENTICATED });
    });
  });
});

describe('framework refusals carry a code from the status table (review round 1, 2026-10-10)', () => {
  async function inject(request: { headers: Record<string, string>; payload: string }) {
    const database = unusedDatabase();
    const app = await buildServer({
      database,
      tokenKeys: TEST_TOKEN_KEYS,
      tokenExpectations: TEST_TOKEN_EXPECTATIONS,
    });
    try {
      const token = await signTestToken({ sub: 'alice', did: 'alice-phone' });
      const response = await app.inject({
        method: 'POST',
        url: '/devices',
        headers: { ...request.headers, authorization: `Bearer ${token}` },
        payload: request.payload,
      });
      return { status: response.statusCode, body: response.json<{ error: string }>() };
    } finally {
      await app.close();
      await database.close();
    }
  }

  it.each([
    [
      'an unsupported media type',
      'application/xml',
      '<device/>',
      415,
      RelayErrorCode.UNSUPPORTED_MEDIA_TYPE,
    ],
    ['malformed JSON', 'application/json', '{', 400, RelayErrorCode.VALIDATION_FAILED],
    [
      'a body over the size limit',
      'application/json',
      JSON.stringify({ padding: 'x'.repeat(MAX_REQUEST_BODY_BYTES) }),
      413,
      RelayErrorCode.PAYLOAD_TOO_LARGE,
    ],
  ])('answers %s with its own code', async (_label, contentType, payload, status, code) => {
    const reply = await inject({ headers: { 'content-type': contentType }, payload });
    expect(reply.status, JSON.stringify(reply.body)).toBe(status);
    expect(reply.body).toMatchObject({ error: code });
  });
});
