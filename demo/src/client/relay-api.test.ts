import { describe, expect, it } from 'vitest';
import { RelayErrorCode, ROOM_BUSY_RETRY_AFTER_SECONDS } from '@masia/contracts/wire';
import { toBase64 } from './bytes.js';
import { createRelayApi, NETWORK_ERROR, RelayHttpError } from './relay-api.js';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

type Reply = Response | Error;

/** An API whose relay answers from a script: the last reply repeats. Records what it was asked. */
function scripted(...replies: Reply[]) {
  const calls: Call[] = [];
  const tokens: boolean[] = [];
  const sleeps: number[] = [];
  const queue = [...replies];
  const doFetch: typeof fetch = async (input, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => (headers[key] = value));
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
    });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next === undefined) throw new Error('no reply prepared');
    if (next instanceof Error) throw next;
    return next.clone();
  };
  const api = createRelayApi({
    baseUrl: 'https://page.example/relay/',
    token: async (force) => {
      tokens.push(force);
      return force ? 'fresh' : 'cached';
    },
    fetch: doFetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { api, calls, tokens, sleeps };
}

const error = (status: number, code: string, extra: Record<string, unknown> = {}, headers: HeadersInit = {}) =>
  new Response(JSON.stringify({ error: code, message: code.toLowerCase(), ...extra }), { status, headers });

describe('the relay client', () => {
  it('sends the bearer token and a JSON body to the base address, and reads base64 back as bytes', async () => {
    const { api, calls } = scripted(Response.json({ rows: [{ deviceId: 'd1', keyPackageId: 'kp1', bytes: toBase64(new Uint8Array([1, 2, 3])), lastResort: true }] }));
    const rows = await api.claimKeyPackages('u 1');
    expect(calls[0]).toMatchObject({
      url: 'https://page.example/relay/key-packages/claim',
      method: 'POST',
      headers: { authorization: 'Bearer cached', 'content-type': 'application/json', accept: 'application/json' },
      body: { userId: 'u 1' },
    });
    expect(rows).toHaveLength(1);
    expect(Array.from(rows[0]?.bytes ?? [])).toEqual([1, 2, 3]);
    expect(rows[0]?.lastResort).toBe(true);
  });

  it('puts ids into the path encoded', async () => {
    const { api, calls } = scripted(Response.json({ rows: [], oldestAvailableSeq: 1 }));
    await api.listEnvelopes('dm_a/b', { afterSeq: 4 });
    expect(calls[0]?.url).toBe('https://page.example/relay/conversations/dm_a%2Fb/envelopes?afterSeq=4&limit=500');
  });

  it('asks for a fresh token once on a 401, and then gives up', async () => {
    const { api, calls, tokens } = scripted(error(401, 'TOKEN_EXPIRED'), Response.json({ epoch: 0 }));
    expect(await api.openRoom('r', { groupId: new Uint8Array(1), treeHash: new Uint8Array(1) })).toBe(0);
    expect(tokens).toEqual([false, true]);
    expect(calls[1]?.headers['authorization']).toBe('Bearer fresh');

    const denied = scripted(error(401, 'TOKEN_EXPIRED'));
    await expect(denied.api.openRoom('r', { groupId: new Uint8Array(1), treeHash: new Uint8Array(1) })).rejects.toMatchObject({
      status: 401,
      code: 'TOKEN_EXPIRED',
    });
    expect(denied.calls).toHaveLength(2);
  });

  it('waits for Retry-After on a 429 or 503, then tries again', async () => {
    const { api, sleeps, calls } = scripted(
      error(429, 'RATE_LIMITED', {}, { 'retry-after': '2' }),
      error(503, 'UNAVAILABLE'),
      Response.json({ seq: 9 }),
    );
    expect(await api.postEnvelope('r', { epoch: 1, senderDeviceId: 'd', ciphertext: new Uint8Array(1), clientMsgId: 'm' })).toEqual({
      seq: 9,
    });
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([2000, 800]); // Retry-After, then the second backoff step (400 ms, doubled)
  });

  it('waits the relay\'s own time when a room is busy', async () => {
    const { api, sleeps } = scripted(error(429, RelayErrorCode.ROOM_BUSY), Response.json({ seq: 1 }));
    await api.postEnvelope('r', { epoch: 1, senderDeviceId: 'd', ciphertext: new Uint8Array(1), clientMsgId: 'm' });
    expect(sleeps).toEqual([ROOM_BUSY_RETRY_AFTER_SECONDS * 1000]);
  });

  it('hands a rebase limit to the caller at once: it is a rule, not load', async () => {
    const { api, calls, sleeps } = scripted(error(429, RelayErrorCode.REBASE_LIMIT));
    await expect(api.putDeviceList({ version: 2, devices: [], signature: new Uint8Array(1) })).rejects.toMatchObject({
      code: RelayErrorCode.REBASE_LIMIT,
    });
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it('stops retrying after four attempts', async () => {
    const { api, calls } = scripted(error(503, 'UNAVAILABLE'));
    await expect(api.listEnvelopes('r', { afterSeq: 0 })).rejects.toMatchObject({ status: 503 });
    expect(calls).toHaveLength(4);
  });

  it('never retries what the next try would repeat', async () => {
    const { api, calls } = scripted(error(403, RelayErrorCode.NOT_A_MEMBER));
    await expect(api.listHandshakes('r', { fromEpoch: 0, afterSeq: 0 })).rejects.toMatchObject({
      status: 403,
      code: RelayErrorCode.NOT_A_MEMBER,
    });
    expect(calls).toHaveLength(1);
  });

  it('turns a network failure into status 0, which a commit reads as "may have landed"', async () => {
    const { api } = scripted(new TypeError('fetch failed'));
    const failure = await api.listEnvelopes('r', { afterSeq: 0 }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(RelayHttpError);
    expect(failure).toMatchObject({ status: 0, code: NETWORK_ERROR });
  });

  it('keeps the relay\'s details on the error: the epoch to rebuild on, the list version', async () => {
    const { api } = scripted(error(409, RelayErrorCode.EPOCH_CONFLICT, { currentEpoch: 7 }));
    const failure = (await api
      .postHandshake('r', {
        expectedEpoch: 3,
        senderDeviceId: 'd',
        bytes: new Uint8Array(1),
        memberDelta: { added: [], removed: [] },
        newTreeHash: new Uint8Array(1),
      })
      .catch((e: unknown) => e)) as RelayHttpError;
    expect(failure.currentEpoch).toBe(7);
    expect(failure.is(RelayErrorCode.EPOCH_CONFLICT)).toBe(true);
    expect(failure.currentVersion).toBeUndefined();
  });

  it('answers null for a person with no device list, and the list for one with', async () => {
    const none = scripted(error(404, RelayErrorCode.DEVICE_LIST_NOT_FOUND));
    expect(await none.api.getDeviceList('u1')).toBeNull();

    const some = scripted(
      Response.json({
        userId: 'u1',
        version: 3,
        devices: [{ id: 'd1', role: 'USER', signatureKey: 'AAEC' }],
        signature: toBase64(new Uint8Array([9, 9])),
      }),
    );
    const list = await some.api.getDeviceList('u1');
    expect(list).toMatchObject({ userId: 'u1', version: 3, devices: [{ id: 'd1' }] });
    expect(Array.from(list?.signature ?? [])).toEqual([9, 9]);
  });

  it('reads every page of a log until the relay stops giving a cursor', async () => {
    const row = (seq: number) => ({ seq, epoch: 0, senderDeviceId: 'd', ciphertext: toBase64(new Uint8Array([seq])), createdAt: 't' });
    const { api, calls } = scripted(
      Response.json({ rows: [row(1), row(2)], nextCursor: 'more', oldestAvailableSeq: 1 }),
      Response.json({ rows: [row(3)], oldestAvailableSeq: 1 }),
    );
    const page = await api.listEnvelopes('r', { afterSeq: 0 });
    expect(page.rows.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(calls.map((c) => c.url.split('?')[1])).toEqual(['afterSeq=0&limit=500', 'afterSeq=2&limit=500']);
  });

  it('reads a handshake row as a COMMIT unless it says WELCOME, and keeps the member delta', async () => {
    const { api } = scripted(
      Response.json({
        rows: [
          { seq: 1, epoch: 0, kind: 'COMMIT', senderDeviceId: 'd', bytes: toBase64(new Uint8Array([1])), memberDelta: { added: [], removed: [] }, createdAt: 't' },
          { seq: 2, epoch: 0, kind: 'WELCOME', senderDeviceId: 'd', bytes: toBase64(new Uint8Array([2])), createdAt: 't' },
        ],
        removedAtEpoch: 4,
      }),
    );
    const page = await api.listHandshakes('r', { fromEpoch: 0, afterSeq: 0 });
    expect(page.rows.map((r) => r.kind)).toEqual(['COMMIT', 'WELCOME']);
    expect(page.rows[0]?.memberDelta).toEqual({ added: [], removed: [] });
    expect(page.rows[1]?.memberDelta).toBeNull();
    expect(page.removedAtEpoch).toBe(4);
  });
});
