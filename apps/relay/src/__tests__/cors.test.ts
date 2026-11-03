import { describe, expect, it } from 'vitest';
import { resolveRelayAllowedOrigins } from '../config.js';
import { buildServer } from '../server.js';
import { TEST_TOKEN_EXPECTATIONS, TEST_TOKEN_KEYS, unusedDatabase } from './support/harness.js';

// 2026-11-03: the reference host's iOS app shell (its pages are served from an origin of its own, under the
// `capacitor://` scheme) could not reach the relay at all — its preflight got a 404, so every call failed
// before it left the WebView. The origin below is that scheme's default; a deployment names its own.
const APP_ORIGIN = 'capacitor://localhost';

async function withApp<T>(
  allowedOrigins: readonly string[] | undefined,
  run: (app: Awaited<ReturnType<typeof buildServer>>) => Promise<T>,
): Promise<T> {
  const database = unusedDatabase();
  const app = await buildServer({
    database,
    tokenKeys: TEST_TOKEN_KEYS,
    tokenExpectations: TEST_TOKEN_EXPECTATIONS,
    basePath: '/relay',
    ...(allowedOrigins === undefined ? {} : { allowedOrigins }),
  });
  try {
    return await run(app);
  } finally {
    await app.close();
    await database.close();
  }
}

const preflight = (origin: string, url = '/relay/devices') => ({
  method: 'OPTIONS' as const,
  url,
  headers: {
    origin,
    'access-control-request-method': 'POST',
    'access-control-request-headers': 'authorization,content-type',
  },
});

describe('CORS for the origins a deployment names', () => {
  it('answers the preflight of a listed origin with what its calls need, and no credentials', async () => {
    await withApp([APP_ORIGIN], async (app) => {
      const response = await app.inject(preflight(APP_ORIGIN));
      expect(response.statusCode).toBe(204);
      expect(response.headers['access-control-allow-origin']).toBe(APP_ORIGIN);
      expect(String(response.headers['access-control-allow-methods'])).toContain('POST');
      expect(String(response.headers['access-control-allow-headers'])).toContain('authorization');
      expect(String(response.headers['access-control-allow-headers'])).toContain('content-type');
      expect(response.headers['access-control-allow-credentials']).toBeUndefined();
      expect(String(response.headers['vary'])).toContain('Origin');
    });
  });

  it('marks the real response readable for a listed origin, and the route still runs (401 without a token)', async () => {
    await withApp([APP_ORIGIN], async (app) => {
      const response = await app.inject({
        method: 'POST',
        url: '/relay/devices',
        headers: { origin: APP_ORIGIN },
        payload: {},
      });
      expect(response.statusCode).toBe(401);
      expect(response.headers['access-control-allow-origin']).toBe(APP_ORIGIN);
      const health = await app.inject({
        method: 'GET',
        url: '/relay/health',
        headers: { origin: APP_ORIGIN },
      });
      expect(health.statusCode).toBe(200);
      expect(health.headers['access-control-allow-origin']).toBe(APP_ORIGIN);
    });
  });

  it('gives an unlisted origin no CORS header at all', async () => {
    await withApp([APP_ORIGIN], async (app) => {
      const response = await app.inject(preflight('https://evil.example'));
      expect(response.statusCode).toBe(404);
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
      const call = await app.inject({
        method: 'GET',
        url: '/relay/health',
        headers: { origin: 'https://evil.example' },
      });
      expect(call.headers['access-control-allow-origin']).toBeUndefined();
    });
  });

  it('with no origins configured, behaves exactly as before (preflight is a 404)', async () => {
    for (const origins of [undefined, []]) {
      await withApp(origins, async (app) => {
        const response = await app.inject(preflight(APP_ORIGIN));
        expect(response.statusCode).toBe(404);
        expect(response.headers['access-control-allow-origin']).toBeUndefined();
      });
    }
  });
});

describe('resolveRelayAllowedOrigins', () => {
  it('reads nothing as no origins', () => {
    expect(resolveRelayAllowedOrigins({})).toEqual([]);
    expect(resolveRelayAllowedOrigins({ RELAY_ALLOWED_ORIGINS: '' })).toEqual([]);
    expect(resolveRelayAllowedOrigins({ RELAY_ALLOWED_ORIGINS: '  ' })).toEqual([]);
  });

  it('reads a comma-separated list of exact origins, trimmed and without repeats', () => {
    expect(
      resolveRelayAllowedOrigins({
        RELAY_ALLOWED_ORIGINS: 'capacitor://localhost, http://localhost:5173,capacitor://localhost',
      }),
    ).toEqual(['capacitor://localhost', 'http://localhost:5173']);
  });

  it('refuses a wildcard, a path, a trailing slash or a bare host', () => {
    for (const bad of [
      '*',
      'https://example.org/',
      'https://example.org/relay',
      'example.org',
      'https://*.example.org',
    ]) {
      expect(() => resolveRelayAllowedOrigins({ RELAY_ALLOWED_ORIGINS: bad }), bad).toThrow(
        /RELAY_ALLOWED_ORIGINS/,
      );
    }
  });
});
