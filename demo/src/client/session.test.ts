import { describe, expect, it } from 'vitest';
import { DEMO_PATHS, SESSION_HEADER } from '../../shared/paths.js';
import { createTokenSource, fetchPeople, signIn } from './session.js';

function replying(...answers: (Response | Error)[]): { fetch: typeof fetch; calls: { url: string; init?: RequestInit }[] } {
  const calls: { url: string; init?: RequestInit }[] = [];
  const queue = [...answers];
  const fake: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), ...(init === undefined ? {} : { init }) });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next === undefined) throw new Error('no answer prepared');
    if (next instanceof Error) throw next;
    return next.clone();
  };
  return { fetch: fake, calls };
}

describe('signIn', () => {
  const body = { userId: 'u-1', deviceId: 'd-1', displayName: 'Ada', session: 's3cret' };

  it('posts the name as JSON and returns the ids and the session secret', async () => {
    const { fetch: doFetch, calls } = replying(Response.json(body, { status: 201 }));
    expect(await signIn('Ada', doFetch)).toEqual(body);
    expect(calls[0]?.url).toBe(DEMO_PATHS.login);
    expect(calls[0]?.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ name: 'Ada' });
  });

  it('says BAD_NAME for a refused name and the status for any other failure', async () => {
    await expect(signIn('', replying(Response.json({}, { status: 422 })).fetch)).rejects.toThrow('BAD_NAME');
    await expect(signIn('x', replying(Response.json({}, { status: 500 })).fetch)).rejects.toThrow('LOGIN_500');
  });

  it('refuses an answer that is missing a field', async () => {
    const { session: _session, ...partial } = body;
    await expect(signIn('Ada', replying(Response.json(partial, { status: 201 })).fetch)).rejects.toThrow(
      'LOGIN_MALFORMED',
    );
  });
});

describe('the token source', () => {
  const answer = (token: string, expiresAt: number) => Response.json({ token, expiresAt });

  it('asks with the session header and keeps the token until shortly before it expires', async () => {
    let now = 1_000_000;
    const { fetch: doFetch, calls } = replying(answer('t1', now + 600_000), answer('t2', now + 1_200_000));
    const source = createTokenSource('sess', doFetch, () => now);

    expect(await source.token(false)).toBe('t1');
    expect(calls[0]?.url).toBe(DEMO_PATHS.token);
    expect((calls[0]?.init?.headers as Record<string, string>)[SESSION_HEADER]).toBe('sess');

    now += 500_000;
    expect(await source.token(false)).toBe('t1');
    expect(calls).toHaveLength(1);

    now += 80_000; // inside the 30 s slack before expiry
    expect(await source.token(false)).toBe('t2');
    expect(calls).toHaveLength(2);
  });

  it('fetches a new one when forced or invalidated', async () => {
    const { fetch: doFetch, calls } = replying(answer('a', 9e12), answer('b', 9e12), answer('c', 9e12));
    const source = createTokenSource('sess', doFetch);
    expect(await source.token(false)).toBe('a');
    expect(await source.token(true)).toBe('b');
    source.invalidate();
    expect(await source.token(false)).toBe('c');
    expect(calls).toHaveLength(3);
  });

  it('shares one request between callers that ask at the same moment', async () => {
    const { fetch: doFetch, calls } = replying(answer('a', 9e12));
    const source = createTokenSource('sess', doFetch);
    const tokens = await Promise.all([source.token(false), source.token(true), source.token(false)]);
    expect(tokens).toEqual(['a', 'a', 'a']);
    expect(calls).toHaveLength(1);
  });

  it('names the failure, and tries again on the next call', async () => {
    const { fetch: doFetch } = replying(Response.json({}, { status: 401 }), answer('ok', 9e12));
    const source = createTokenSource('sess', doFetch);
    await expect(source.token(false)).rejects.toThrow('TOKEN_401');
    expect(await source.token(false)).toBe('ok');
  });

  it('refuses a malformed answer', async () => {
    const source = createTokenSource('sess', replying(Response.json({ token: 1 })).fetch);
    await expect(source.token(false)).rejects.toThrow('TOKEN_MALFORMED');
  });
});

describe('fetchPeople', () => {
  it('returns the people with both fields and drops anything else', async () => {
    const { fetch: doFetch, calls } = replying(
      Response.json({
        people: [{ userId: 'u-1', displayName: 'Bo' }, { userId: 'u-2' }, null, 'x', { userId: 3, displayName: 'N' }],
      }),
    );
    expect(await fetchPeople('sess', doFetch)).toEqual([{ userId: 'u-1', displayName: 'Bo' }]);
    expect((calls[0]?.init?.headers as Record<string, string>)[SESSION_HEADER]).toBe('sess');
  });

  it('is an empty list when the answer has no list, and an error when the server says no', async () => {
    expect(await fetchPeople('s', replying(Response.json({})).fetch)).toEqual([]);
    await expect(fetchPeople('s', replying(Response.json({}, { status: 401 })).fetch)).rejects.toThrow('PEOPLE_401');
  });
});
