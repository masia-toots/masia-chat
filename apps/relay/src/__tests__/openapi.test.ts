import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../server.js';
import { TEST_TOKEN_EXPECTATIONS, TEST_TOKEN_KEYS, unusedDatabase } from './support/harness.js';

const OPENAPI_PATH = fileURLToPath(new URL('../../openapi.json', import.meta.url));
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

interface Operation {
  operationId?: string;
  security?: unknown[];
  responses?: Record<string, unknown>;
}
type Paths = Record<string, Partial<Record<(typeof HTTP_METHODS)[number], Operation>>>;

describe('the OpenAPI document', () => {
  const database = unusedDatabase();
  let document: { paths: Paths };

  beforeAll(async () => {
    const app = await buildServer({
      database,
      tokenKeys: TEST_TOKEN_KEYS,
      tokenExpectations: TEST_TOKEN_EXPECTATIONS,
    });
    await app.ready();
    document = JSON.parse(JSON.stringify(app.swagger())) as { paths: Paths };
    await app.close();
    await database.close();
  });

  function operations(): Array<{ route: string; method: string; operation: Operation }> {
    return Object.entries(document.paths).flatMap(([route, item]) =>
      HTTP_METHODS.flatMap((method) => {
        const operation = item[method];
        return operation === undefined ? [] : [{ route, method, operation }];
      }),
    );
  }

  it('names every operation, with names that are unique', () => {
    const ids = operations().map(({ operation }) => operation.operationId);
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('covers every route of the brief', () => {
    const routes = operations().map(({ method, route }) => `${method.toUpperCase()} ${route}`);
    expect(routes).toEqual(
      expect.arrayContaining([
        'POST /devices',
        'GET /users/{userId}/devices',
        'POST /users/me/device-list',
        'GET /users/{userId}/device-list',
        'POST /key-packages',
        'POST /key-packages/claim',
        'POST /conversations/{id}/handshakes',
        'GET /conversations/{id}/handshakes',
        'POST /conversations/{id}/envelopes',
        'GET /conversations/{id}/envelopes',
        'POST /devices/{id}/revoke',
        'GET /health',
      ]),
    );
  });

  it('requires the bearer token on every route except /health', () => {
    for (const { route, method, operation } of operations()) {
      const open = route === '/health';
      expect((operation.security?.length ?? 0) > 0, `${method} ${route}`).toBe(!open);
    }
  });

  it('documents the epoch conflict and the rebase limit on the handshake route', () => {
    const post = document.paths['/conversations/{id}/handshakes']?.post;
    expect(Object.keys(post?.responses ?? {})).toEqual(
      expect.arrayContaining(['201', '403', '409', '422', '429']),
    );
  });

  it('is the committed apps/relay/openapi.json (run `pnpm openapi` after changing a route)', () => {
    const committed = JSON.parse(readFileSync(OPENAPI_PATH, 'utf8')) as unknown;
    expect(committed).toEqual(document);
  });

  it('names the origin root as its server when served unprefixed', () => {
    expect((document as { servers?: unknown }).servers).toEqual([
      { url: '/', description: 'This relay, at its configured base path' },
    ]);
  });
});

describe('the OpenAPI document of a relay served under a base path', () => {
  it('keeps the unprefixed paths and names the prefix as the server URL', async () => {
    const database = unusedDatabase();
    const app = await buildServer({
      database,
      tokenKeys: TEST_TOKEN_KEYS,
      tokenExpectations: TEST_TOKEN_EXPECTATIONS,
      basePath: '/relay',
    });
    try {
      await app.ready();
      const prefixed = JSON.parse(JSON.stringify(app.swagger())) as {
        paths: Paths;
        servers?: Array<{ url: string }>;
      };
      expect(prefixed.servers?.map((server) => server.url)).toEqual(['/relay']);
      // Same operations as the committed (unprefixed) document: the prefix lives in `servers` alone.
      const committed = JSON.parse(readFileSync(OPENAPI_PATH, 'utf8')) as { paths: Paths };
      expect(Object.keys(prefixed.paths).sort()).toEqual(Object.keys(committed.paths).sort());
      expect(Object.keys(prefixed.paths)).toContain('/health');
    } finally {
      await app.close();
      await database.close();
    }
  });
});
