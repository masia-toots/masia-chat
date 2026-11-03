import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RELAY_HEALTH_PATH, readRelayTokenClaims } from '@masia/contracts/wire';
import { DEMO_PATHS, DISPLAY_NAME_MAX, RELAY_PREFIX, SESSION_HEADER } from '../shared/paths.js';
import { createDemoHandler } from './app.js';
import { createTokenIssuer } from './issuer.js';
import { createPeopleBook, PRESENCE_MS } from './people.js';
import { listen, type Listening } from './test-kit.js';

const EXPECTATIONS = { issuer: 'playground-web', audience: 'playground-relay' } as const;
const RELAY = new URL('http://relay.internal:3400');

interface Login {
  userId: string;
  deviceId: string;
  displayName: string;
  session: string;
}

describe('the playground server', () => {
  let dir: string;
  let site: Listening;
  let now = 5_000_000;
  let relayAnswers: (url: URL) => Response = () => Response.json({ status: 'ok' });
  const relayCalls: string[] = [];

  const header = (session: string) => ({ [SESSION_HEADER]: session });
  const get = (path: string, session?: string) =>
    fetch(`${site.origin}${path}`, session === undefined ? {} : { headers: header(session) });
  async function login(name: unknown): Promise<Response> {
    return fetch(`${site.origin}${DEMO_PATHS.login}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });
  }
  async function signIn(name: string): Promise<Login> {
    const answer = await login(name);
    expect(answer.status).toBe(201);
    return (await answer.json()) as Login;
  }

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'demo-app-'));
    await writeFile(join(dir, 'index.html'), '<!doctype html><title>page</title>');
    await writeFile(join(dir, 'contacts.json'), JSON.stringify({ contacts: [{ id: 'a', name: 'A' }] }));
    const handler = createDemoHandler({
      people: createPeopleBook(() => now),
      issuer: createTokenIssuer(generateKeyPairSync('ed25519').privateKey, EXPECTATIONS, () => now),
      relayUrl: RELAY,
      contactsFile: join(dir, 'contacts.json'),
      distDir: dir,
      fetch: async (input) => {
        const url = new URL(String(input));
        relayCalls.push(`${url.pathname}${url.search}`);
        return relayAnswers(url);
      },
    });
    site = await listen((request, response) => {
      void handler(request, response);
    });
  });

  afterAll(async () => {
    await site.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('signs a visitor in with a name and hands back ids and a session secret', async () => {
    const ada = await signIn('  Ada  ');
    expect(ada.displayName).toBe('Ada');
    expect(ada.userId).toMatch(/^u-/);
    expect(ada.deviceId).toMatch(/^d-/);
    expect(ada.session.length).toBeGreaterThan(20);
  });

  it('refuses a bad name with 422, and a body that is not JSON with 400', async () => {
    expect((await login('')).status).toBe(422);
    expect((await login(42)).status).toBe(422);
    expect((await login('x'.repeat(DISPLAY_NAME_MAX + 1))).status).toBe(422);
    const notJson = await fetch(`${site.origin}${DEMO_PATHS.login}`, { method: 'POST', body: '{nope' });
    expect(notJson.status).toBe(400);
    const tooBig = await fetch(`${site.origin}${DEMO_PATHS.login}`, { method: 'POST', body: 'x'.repeat(5000) });
    expect(tooBig.status).toBe(400);
  });

  it('asks for a sign-in on the calls that need one', async () => {
    expect((await get(DEMO_PATHS.token)).status).toBe(401);
    expect((await get(DEMO_PATHS.people)).status).toBe(401);
    expect((await get(DEMO_PATHS.token, 'not-a-session')).status).toBe(401);
  });

  it('mints a relay token that says who the visitor is and whom they were introduced to', async () => {
    const ada = await signIn('Ada');
    const bo = await signIn('Bo');
    const answer = await get(DEMO_PATHS.token, ada.session);
    expect(answer.status).toBe(200);
    expect(answer.headers.get('cache-control')).toBe('no-store');
    const body = (await answer.json()) as { token: string; expiresAt: number };
    const payload = JSON.parse(Buffer.from(body.token.split('.')[1] as string, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    const principal = readRelayTokenClaims(payload, EXPECTATIONS);
    expect(principal.userId).toBe(ada.userId);
    expect(principal.deviceId).toBe(ada.deviceId);
    expect(principal.actor).toBeNull();
    expect(principal.reach).toContain(bo.userId);
    expect(principal.reach).not.toContain(ada.userId);
    expect(body.expiresAt).toBeGreaterThan(now);
  });

  it('lists who else is here, never the asker, and drops a tab that went quiet', async () => {
    const ada = await signIn('Ada');
    const bo = await signIn('Bo');
    const seen = async (session: string) =>
      ((await (await get(DEMO_PATHS.people, session)).json()) as { people: { userId: string; displayName: string }[] })
        .people;

    expect((await seen(ada.session)).map((p) => p.userId)).toContain(bo.userId);
    expect((await seen(ada.session)).map((p) => p.userId)).not.toContain(ada.userId);

    now += PRESENCE_MS + 1;
    await get(DEMO_PATHS.people, ada.session); // Ada's tab calls in, Bo's does not
    expect((await seen(ada.session)).map((p) => p.userId)).not.toContain(bo.userId);
    await get(DEMO_PATHS.people, bo.session); // Bo's tab wakes up
    expect((await seen(ada.session)).map((p) => p.userId)).toContain(bo.userId);
  });

  it('serves the seed contacts, and an empty list when the file is gone', async () => {
    const answer = await get(DEMO_PATHS.contacts);
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ contacts: [{ id: 'a', name: 'A' }] });

    const lonely = createDemoHandler({
      people: createPeopleBook(),
      issuer: createTokenIssuer(generateKeyPairSync('ed25519').privateKey, EXPECTATIONS),
      relayUrl: RELAY,
      contactsFile: join(dir, 'missing.json'),
      distDir: dir,
    });
    const other = await listen((request, response) => void lonely(request, response));
    try {
      expect(await (await fetch(`${other.origin}${DEMO_PATHS.contacts}`)).json()).toEqual({ contacts: [] });
    } finally {
      await other.close();
    }
  });

  it('reports its own health, and the relay\'s, which the compose file waits on', async () => {
    expect((await get(DEMO_PATHS.health)).status).toBe(200);

    relayCalls.length = 0;
    expect((await get(DEMO_PATHS.relayHealth)).status).toBe(200);
    expect(relayCalls).toEqual([RELAY_HEALTH_PATH]);

    relayAnswers = () => new Response('down', { status: 500 });
    expect((await get(DEMO_PATHS.relayHealth)).status).toBe(503);
    relayAnswers = () => {
      throw new Error('refused');
    };
    expect((await get(DEMO_PATHS.relayHealth)).status).toBe(503);
    relayAnswers = () => Response.json({ status: 'ok' });
  });

  it('forwards the relay prefix to the relay without asking for a playground session', async () => {
    relayCalls.length = 0;
    const answer = await fetch(`${site.origin}${RELAY_PREFIX}/conversations/dm_a_b/handshakes?fromEpoch=0`, {
      headers: { authorization: 'Bearer abc' },
    });
    expect(answer.status).toBe(200);
    expect(relayCalls).toEqual(['/conversations/dm_a_b/handshakes?fromEpoch=0']);
  });

  it('serves the page for any other GET, and refuses other methods on it', async () => {
    const answer = await get('/some/route');
    expect(answer.status).toBe(200);
    expect(await answer.text()).toContain('<title>page</title>');
    const posted = await fetch(`${site.origin}/some/route`, { method: 'POST', body: '{}' });
    expect(posted.status).toBe(405);
  });

  it('answers 404 JSON for an unknown /demo path (after the sign-in check)', async () => {
    const ada = await signIn('Ada');
    expect((await get('/demo/nothing', ada.session)).status).toBe(404);
    expect((await get('/demo/nothing')).status).toBe(401);
  });
});
