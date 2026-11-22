import {
  CALL_LIMITS,
  CALL_RELAY_LIMITS,
  CALL_RING_PAIR_LIMIT,
  CALL_RING_WINDOW_MS,
  CALL_TALLY_IDLE_MS,
  DeviceRole,
  RELAY_TOKEN_TTL_SECONDS,
  RelayErrorCode,
} from '@masia/relay';
import type { FastifyInstance } from 'fastify';
import type { Server } from 'node:http';
import type { Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { buildServer, CONNECTION_TIMEOUT_MS, REQUEST_TIMEOUT_MS } from '../server.js';
import {
  type Caller,
  commitBody,
  databaseSuite,
  expectStatus,
  OPERATOR,
  signTestToken,
  TEST_TOKEN_EXPECTATIONS,
  TEST_TOKEN_KEYS,
  unusedDatabase,
} from './support/harness.js';

// The call channel (ADR-228): instant, never stored signalling between the two people of a one-to-one room.
const ROOM = 'dm_alice_bob';
const APP_ORIGIN = 'capacitor://localhost';
/** Short, so a test sees the keep-alive and the device re-check without waiting the real minute. */
const KEEP_ALIVE_MS = 100;
const DEVICE_RECHECK_MS = 150;
const WAIT_MS = 3_000;
/** Text that must never reach a log line. */
const SDP_MARKER = 'sdp-marker-7f3a9c';
const CANDIDATE_MARKER = 'candidate-marker-51d0';
const TAG = 'T'.repeat(43);

/** A well-formed call id (22 characters of the url-safe alphabet) from a short label. */
function callIdOf(label: string): string {
  return label.padEnd(22, '0').slice(0, 22);
}

const ring = (callId: string) => ({ type: 'call:ring', callId });
const offer = (callId: string) => ({
  type: 'call:ice',
  callId,
  signal: { kind: 'offer', sdp: `v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=${SDP_MARKER}\r\n` },
});
const candidate = (callId: string) => ({
  type: 'call:ice',
  callId,
  signal: { kind: 'candidate', candidate: `candidate:1 1 udp 1 127.0.0.1 9 typ host ${CANDIDATE_MARKER}`, sdpMid: '0', sdpMLineIndex: 0 },
});
const verify = (callId: string) => ({ type: 'call:verify', callId, tag: TAG });
const end = (callId: string, reason = 'hangup') => ({ type: 'call:end', callId, reason });

interface SseEvent {
  readonly event: string;
  readonly data: unknown;
}

/** One device's open stream, read the way the client reads it: fetch, the token in the header, no EventSource. */
interface StreamClient {
  readonly status: number;
  readonly headers: Headers;
  readonly events: readonly SseEvent[];
  comments(): number;
  waitFor(event: string, predicate?: (data: unknown) => boolean, timeoutMs?: number): Promise<SseEvent>;
  waitEnded(timeoutMs?: number): Promise<void>;
  abort(): void;
}

const openClients: StreamClient[] = [];
const openSockets = new Set<Socket>();
/** Listeners whose test is over: a socket that still connects to one is closed at once. */
const retired = new WeakSet<Server>();
const listeners = new Set<Server>();

function dropConnections(): void {
  for (const client of openClients.splice(0)) client.abort();
  for (const server of listeners) retired.add(server);
  listeners.clear();
  for (const socket of openSockets) socket.destroy();
  openSockets.clear();
}

afterEach(dropConnections);

async function openStream(
  baseUrl: string,
  token: string | null,
  extraHeaders: Record<string, string> = {},
): Promise<StreamClient> {
  const controller = new AbortController();
  const response = await fetch(`${baseUrl}/calls/stream`, {
    headers: {
      accept: 'text/event-stream',
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      ...extraHeaders,
    },
    signal: controller.signal,
  });
  const events: SseEvent[] = [];
  const waiters: Array<() => void> = [];
  let comments = 0;
  let ended = false;
  const notify = (): void => {
    for (const waiter of [...waiters]) waiter();
  };

  const reading = (async () => {
    if (response.body === null) return;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let cut = buffer.indexOf('\n\n');
        while (cut >= 0) {
          const block = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          let event = 'message';
          let data: string | null = null;
          for (const line of block.split('\n')) {
            if (line.startsWith(':')) comments += 1;
            else if (line.startsWith('event: ')) event = line.slice('event: '.length);
            else if (line.startsWith('data: ')) data = line.slice('data: '.length);
          }
          if (data !== null) events.push({ event, data: JSON.parse(data) as unknown });
          notify();
          cut = buffer.indexOf('\n\n');
        }
      }
    } catch {
      // Aborted by the test.
    } finally {
      ended = true;
      notify();
    }
  })();

  const client: StreamClient = {
    status: response.status,
    headers: response.headers,
    events,
    comments: () => comments,
    waitFor(event, predicate = () => true, timeoutMs = WAIT_MS) {
      return new Promise<SseEvent>((resolve, reject) => {
        const settle = (): boolean => {
          const found = events.find((candidateEvent) => candidateEvent.event === event && predicate(candidateEvent.data));
          if (found !== undefined) {
            resolve(found);
            return true;
          }
          if (ended) {
            reject(new Error(`the stream ended without a matching "${event}" event`));
            return true;
          }
          return false;
        };
        if (settle()) return;
        const waiter = (): void => {
          if (settle()) done();
        };
        const timer = setTimeout(() => {
          done();
          reject(new Error(`no matching "${event}" event within ${timeoutMs} ms`));
        }, timeoutMs);
        const done = (): void => {
          clearTimeout(timer);
          const at = waiters.indexOf(waiter);
          if (at >= 0) waiters.splice(at, 1);
        };
        waiters.push(waiter);
      });
    },
    async waitEnded(timeoutMs = WAIT_MS) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`the stream is still open after ${timeoutMs} ms`)), timeoutMs);
      });
      try {
        await Promise.race([reading, timeout]);
      } finally {
        clearTimeout(timer);
      }
    },
    abort: () => controller.abort(),
  };
  openClients.push(client);
  return client;
}

async function listeningUrl(app: FastifyInstance): Promise<string> {
  if (!app.server.listening) {
    // Every socket of this listener is closed after the test, and any that connects later at once. Some connect and
    // never send a request (seen on the Windows dev box, after a stream is aborted: none of the test's own fetches);
    // a server waits on those at close, and the next test's reset would time out.
    const server = app.server;
    listeners.add(server);
    server.on('connection', (socket: Socket) => {
      if (retired.has(server)) {
        socket.destroy();
        return;
      }
      openSockets.add(socket);
      socket.once('close', () => openSockets.delete(socket));
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
  }
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('the relay has no TCP address');
  return `http://127.0.0.1:${address.port}`;
}

interface RawReply {
  readonly status: number;
  readonly body: string;
  readonly headers: Readonly<Record<string, unknown>>;
  readonly error: unknown;
}

function rawReplyOf(response: { statusCode: number; body: string; headers: Record<string, unknown> }): RawReply {
  let error: unknown = null;
  try {
    error = (JSON.parse(response.body) as { error?: unknown }).error ?? null;
  } catch {
    // An empty body (the 202).
  }
  return { status: response.statusCode, body: response.body, headers: response.headers, error };
}

databaseSuite(
  'the call channel (ADR-228)',
  (harness) => {
    async function post(
      from: Pick<Caller, 'token'>,
      toDeviceId: string,
      signal: object,
      conversationId = ROOM,
    ): Promise<RawReply> {
      const response = await harness().app.inject({
        method: 'POST',
        url: '/calls/signal',
        headers: { authorization: `Bearer ${from.token}` },
        payload: { conversationId, toDeviceId, signal },
      });
      return rawReplyOf(response);
    }

    async function stream(caller: Pick<Caller, 'token'>, headers: Record<string, string> = {}): Promise<StreamClient> {
      const client = await openStream(await listeningUrl(harness().app), caller.token, headers);
      expect(client.status).toBe(200);
      await client.waitFor('ready');
      return client;
    }

    /** alice and bob, one USER device each, alone in a one-to-one room. */
    async function oneToOne(): Promise<{ alice: Caller; bob: Caller }> {
      const alice = await harness().enrol('alice', 'alice-phone');
      const bob = await harness().enrol('bob', 'bob-phone');
      await harness().createRoom(ROOM, alice);
      expectStatus(await harness().addToRoom(ROOM, alice, bob), 201);
      return { alice, bob };
    }

    const isSignalFor = (callId: string, type?: string) => (data: unknown) => {
      const signal = (data as { signal?: { callId?: string; type?: string } }).signal;
      return signal?.callId === callId && (type === undefined || signal.type === type);
    };

    describe('delivery', () => {
      it('hands a signal to the target only, stamped with the sender the relay knows', async () => {
        const { alice, bob } = await oneToOne();
        const bobStream = await stream(bob);
        const aliceStream = await stream(alice);
        const callId = callIdOf('deliver');
        expect((await post(alice, bob.deviceId, ring(callId))).status).toBe(202);
        await bobStream.waitFor('signal', isSignalFor(callId, 'call:ring'));

        // A sender named inside the signal is not the sender: the relay keeps only the signal's own fields.
        const forged = { ...offer(callId), fromUserId: 'mallory', fromDeviceId: 'mallory-phone' };
        const reply = await post(alice, bob.deviceId, forged);
        expect(reply.status).toBe(202);
        expect(reply.body).toBe('');

        const delivered = await bobStream.waitFor('signal', isSignalFor(callId, 'call:ice'));
        expect(delivered.data).toEqual({
          conversationId: ROOM,
          fromUserId: 'alice',
          fromDeviceId: 'alice-phone',
          signal: offer(callId),
        });
        // The sender's own stream gets nothing back.
        expect(aliceStream.events.filter((event) => event.event === 'signal')).toEqual([]);
      });

      it('opens with `ready` (the time left on the token), keeps the stream alive, and sends the SSE headers', async () => {
        const { bob } = await oneToOne();
        const bobStream = await stream(bob, { origin: APP_ORIGIN });
        const ready = bobStream.events[0];
        expect(ready?.event).toBe('ready');
        const closesInMs = (ready?.data as { closesInMs: number }).closesInMs;
        expect(closesInMs).toBeGreaterThan(0);
        expect(closesInMs).toBeLessThanOrEqual(RELAY_TOKEN_TTL_SECONDS * 1000);
        expect(bobStream.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
        expect(bobStream.headers.get('cache-control')).toBe('no-store');
        // The root's CORS headers survive the hijacked reply.
        expect(bobStream.headers.get('access-control-allow-origin')).toBe(APP_ORIGIN);
        await new Promise((resolve) => setTimeout(resolve, KEEP_ALIVE_MS * 3));
        expect(bobStream.comments()).toBeGreaterThan(0);
      });

      it('one stream per device: a new one ends the old one with `replaced`', async () => {
        const { alice, bob } = await oneToOne();
        const first = await stream(bob);
        const second = await stream(bob);
        await first.waitFor('replaced');
        await first.waitEnded();
        const callId = callIdOf('replaced');
        expect((await post(alice, bob.deviceId, ring(callId))).status).toBe(202);
        await second.waitFor('signal', isSignalFor(callId));
        expect(first.events.filter((event) => event.event === 'signal')).toEqual([]);
      });

      it('answers the same empty 202 whether the target is online or not (no `delivered`)', async () => {
        const { alice, bob } = await oneToOne();
        const offline = await post(alice, bob.deviceId, ring(callIdOf('offline')));
        const bobStream = await stream(bob);
        const online = await post(alice, bob.deviceId, ring(callIdOf('online')));
        await bobStream.waitFor('signal', isSignalFor(callIdOf('online')));
        expect(offline.status).toBe(202);
        expect(online.status).toBe(202);
        expect(offline.body).toBe('');
        expect(online.body).toBe('');
        const shapeOf = (reply: RawReply) =>
          Object.keys(reply.headers)
            .filter((name) => name !== 'date')
            .sort()
            .map((name) => `${name}: ${name === 'content-length' ? String(reply.headers[name]) : ''}`);
        expect(shapeOf(online)).toEqual(shapeOf(offline));
      });

      it('stores nothing: every table has the rows it had before the call', async () => {
        const { alice, bob } = await oneToOne();
        const before = await tableCounts();
        const bobStream = await stream(bob);
        const callId = callIdOf('nostore');
        for (const signal of [ring(callId), offer(callId), candidate(callId), verify(callId), end(callId)]) {
          expect((await post(alice, bob.deviceId, signal)).status).toBe(202);
        }
        await bobStream.waitFor('signal', isSignalFor(callId, 'call:end'));
        expect(await tableCounts()).toEqual(before);
      });
    });

    async function tableCounts(): Promise<Record<string, number>> {
      const { rows } = await harness().db.query<{ name: string }>(
        `SELECT table_name AS name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`,
      );
      const counts: Record<string, number> = {};
      for (const { name } of rows) {
        const result = await harness().db.query<{ n: string }>(`SELECT count(*) AS n FROM "${name}"`);
        counts[name] = Number(result.rows[0]?.n ?? 0);
      }
      return counts;
    }

    describe('who may signal whom', () => {
      it("stamps another device of the caller's person as itself: a peer pinned to one device can tell", async () => {
        const { alice, bob } = await oneToOne();
        const aliceTablet = await harness().enrol('alice', 'alice-tablet');
        expectStatus(await harness().addToRoom(ROOM, alice, aliceTablet), 201);
        const bobStream = await stream(bob);
        const callId = callIdOf('thirddevice');
        expect((await post(aliceTablet, bob.deviceId, ring(callId))).status).toBe(202);
        const delivered = await bobStream.waitFor('signal', isSignalFor(callId));
        expect(delivered.data).toMatchObject({ fromUserId: 'alice', fromDeviceId: 'alice-tablet' });
      });

      it('drops a signal of a call no ring admitted between the two devices (202 all the same); once rung, it passes both ways', async () => {
        const { alice, bob } = await oneToOne();
        const aliceTablet = await harness().enrol('alice', 'alice-tablet');
        expectStatus(await harness().addToRoom(ROOM, alice, aliceTablet), 201);
        const bobStream = await stream(bob);
        const aliceStream = await stream(alice);
        const callId = callIdOf('admitted');
        const inventedIds = [callIdOf('invented1'), callIdOf('invented2'), callIdOf('invented3')];

        // A made-up call id buys nothing: every kind of signal is taken (202, empty) and dropped.
        for (const id of inventedIds) {
          for (const signal of [offer(id), candidate(id), verify(id), end(id), { type: 'call:accept', callId: id }]) {
            const reply = await post(alice, bob.deviceId, signal);
            expect(reply.status).toBe(202);
            expect(reply.body).toBe('');
          }
        }
        // Rung: the call passes from the ringing device to the rung one and back.
        expect((await post(alice, bob.deviceId, ring(callId))).status).toBe(202);
        expect((await post(bob, alice.deviceId, { type: 'call:accept', callId })).status).toBe(202);
        expect((await post(alice, bob.deviceId, offer(callId))).status).toBe(202);
        expect((await post(bob, alice.deviceId, candidate(callId))).status).toBe(202);
        // ... and not to or from another device of the same person: the call is between two devices.
        expect((await post(aliceTablet, bob.deviceId, end(callId))).status).toBe(202);
        await bobStream.waitFor('signal', isSignalFor(callId, 'call:ice'));
        await aliceStream.waitFor('signal', isSignalFor(callId, 'call:ice'));
        // A last ring as a marker: everything posted before it has been written to the stream by now.
        const marker = callIdOf('marker');
        expect((await post(alice, bob.deviceId, ring(marker))).status).toBe(202);
        await bobStream.waitFor('signal', isSignalFor(marker));

        const received = (events: readonly SseEvent[]) =>
          events
            .filter((event) => event.event === 'signal')
            .map((event) => event.data as { fromDeviceId: string; signal: { type: string; callId: string } })
            .map(({ fromDeviceId, signal }) => `${fromDeviceId} ${signal.type} ${signal.callId}`);
        expect(received(bobStream.events)).toEqual([
          `alice-phone call:ring ${callId}`,
          `alice-phone call:ice ${callId}`,
          `alice-phone call:ring ${marker}`,
        ]);
        expect(received(aliceStream.events)).toEqual([`bob-phone call:accept ${callId}`, `bob-phone call:ice ${callId}`]);
      });

      it('refuses a room of three people, for every one of them', async () => {
        const { alice, bob } = await oneToOne();
        const carol = await harness().enrol('carol', 'carol-phone');
        expectStatus(await harness().addToRoom(ROOM, alice, carol), 201);
        const bobStream = await stream(bob);
        const callId = callIdOf('threepeople');
        for (const [from, to] of [
          [carol, bob],
          [alice, bob],
          [bob, carol],
        ] as const) {
          for (const signal of [offer(callId), verify(callId), end(callId)]) {
            const reply = await post(from, to.deviceId, signal);
            expect(reply.status).toBe(403);
            expect(reply.error).toBe(RelayErrorCode.CALL_NOT_ALLOWED);
          }
        }
        expect(bobStream.events.filter((event) => event.event === 'signal')).toEqual([]);
      });

      it('refuses a target of the same person, and a target outside the room', async () => {
        const { alice } = await oneToOne();
        const aliceTablet = await harness().enrol('alice', 'alice-tablet');
        expectStatus(await harness().addToRoom(ROOM, alice, aliceTablet), 201);
        const dave = await harness().enrol('dave', 'dave-phone');
        for (const target of [aliceTablet.deviceId, dave.deviceId, 'no-such-device']) {
          const reply = await post(alice, target, ring(callIdOf('target')));
          expect(reply.status).toBe(403);
          expect(reply.error).toBe(RelayErrorCode.CALL_NOT_ALLOWED);
        }
      });

      it('refuses a sender that is not a member of the room', async () => {
        const { bob } = await oneToOne();
        const dave = await harness().enrol('dave', 'dave-phone');
        const reply = await post(dave, bob.deviceId, ring(callIdOf('stranger')));
        expect(reply.status).toBe(403);
        expect(reply.error).toBe(RelayErrorCode.NOT_A_MEMBER);
      });

      it('refuses a removed member, and a target that was removed', async () => {
        const { alice, bob } = await oneToOne();
        expectStatus(
          await alice.post(
            `/conversations/${ROOM}/handshakes`,
            commitBody({ room: ROOM, expectedEpoch: 1, sender: alice, removed: [bob] }),
          ),
          201,
        );
        const fromBob = await post(bob, alice.deviceId, ring(callIdOf('removed')));
        expect(fromBob.status).toBe(403);
        expect(fromBob.error).toBe(RelayErrorCode.REMOVED);
        const toBob = await post(alice, bob.deviceId, ring(callIdOf('removed')));
        expect(toBob.status).toBe(403);
        expect(toBob.error).toBe(RelayErrorCode.CALL_NOT_ALLOWED);
      });

      it("refuses a guardian's device and an assistant device, on both routes", async () => {
        const { bob } = await oneToOne();
        const guardian = await harness().enrol('kid', 'kid-guardian', DeviceRole.GUARDIAN);
        const assistant = await harness().enrol(OPERATOR, 'assistant-1', DeviceRole.ASSISTANT);
        const baseUrl = await listeningUrl(harness().app);
        for (const device of [guardian, assistant]) {
          const opened = await openStream(baseUrl, device.token);
          expect(opened.status).toBe(403);
          const reply = await post(device, bob.deviceId, ring(callIdOf('nonuser')));
          expect(reply.status).toBe(403);
          expect(reply.error).toBe(RelayErrorCode.CALL_NOT_ALLOWED);
        }
      });

      it('refuses a room that holds a device that is not a USER device', async () => {
        const { alice, bob } = await oneToOne();
        await harness().enrol('bob', 'bob-guardian', DeviceRole.GUARDIAN);
        // Put there directly: what matters is the rule that reads the room, not how the device got in.
        await harness().db.query(
          'INSERT INTO room_members (conversation_id, device_id, added_at_epoch) VALUES ($1, $2, 1)',
          [ROOM, 'bob-guardian'],
        );
        const reply = await post(alice, bob.deviceId, ring(callIdOf('guardianroom')));
        expect(reply.status).toBe(403);
        expect(reply.error).toBe(RelayErrorCode.CALL_NOT_ALLOWED);
      });
    });

    describe('the shape of a signal', () => {
      it('refuses a malformed signal (400) and a body over the cap (413)', async () => {
        const { alice, bob } = await oneToOne();
        const callId = callIdOf('shape');
        for (const signal of [
          { type: 'call:ice', callId, signal: { kind: 'bogus' } },
          { type: 'call:end', callId, reason: 'because' },
          { type: 'call:verify', callId, tag: 'short' },
          { type: 'call:invite', callId },
          { type: 'call:ring', callId: 'too-short' },
        ]) {
          const reply = await post(alice, bob.deviceId, signal);
          expect(reply.status, JSON.stringify(signal)).toBe(400);
        }
        const huge = {
          type: 'call:ice',
          callId,
          signal: { kind: 'offer', sdp: 'x'.repeat(CALL_RELAY_LIMITS.signalBodyMaxBytes) },
        };
        expect((await post(alice, bob.deviceId, huge)).status).toBe(413);
      });
    });

    describe('budgets', () => {
      it('takes a burst of frames from one device, then 429 with Retry-After', async () => {
        const { alice, bob } = await oneToOne();
        const callId = callIdOf('flood');
        for (let sent = 0; sent < CALL_LIMITS.socketFramesBurst; sent += 1) {
          expect((await post(alice, bob.deviceId, end(callId))).status).toBe(202);
        }
        const limited = await post(alice, bob.deviceId, end(callId));
        expect(limited.status).toBe(429);
        expect(limited.error).toBe(RelayErrorCode.ACTOR_RATE_LIMITED);
        expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
      });

      it("spends the budget of the token's user and device before any database read: past it, even an unknown device gets only the 429", async () => {
        const { bob } = await oneToOne();
        const ghost = { token: await signTestToken({ sub: 'alice', did: 'alice-ghost' }) };
        for (let sent = 0; sent < CALL_LIMITS.socketFramesBurst; sent += 1) {
          expect((await post(ghost, bob.deviceId, ring(callIdOf('ghost')))).error).toBe(RelayErrorCode.ACTOR_DEVICE_UNKNOWN);
        }
        const limited = await post(ghost, bob.deviceId, ring(callIdOf('ghost')));
        expect(limited.status).toBe(429);
        expect(limited.error).toBe(RelayErrorCode.ACTOR_RATE_LIMITED);
        const opened = await openStream(await listeningUrl(harness().app), ghost.token);
        expect(opened.status).toBe(429);
        // The budget is the pair's: the same device id under another account's token has its own, and reaches the
        // device check.
        const otherAccount = { token: await signTestToken({ sub: 'carol', did: 'alice-ghost' }) };
        expect((await post(otherAccount, bob.deviceId, ring(callIdOf('ghost')))).error).toBe(
          RelayErrorCode.ACTOR_DEVICE_UNKNOWN,
        );
      });

      it("a token of another account that names bob's device spends its own budget, never bob's", async () => {
        const { alice, bob } = await oneToOne();
        const mallory = { token: await signTestToken({ sub: 'mallory', did: bob.deviceId }) };
        for (let sent = 0; sent < CALL_LIMITS.socketFramesBurst; sent += 1) {
          expect((await post(mallory, alice.deviceId, ring(callIdOf('mallory')))).error).toBe(
            RelayErrorCode.ACTOR_DEVICE_UNKNOWN,
          );
        }
        const limited = await post(mallory, alice.deviceId, ring(callIdOf('mallory')));
        expect(limited.status).toBe(429);
        expect(limited.error).toBe(RelayErrorCode.ACTOR_RATE_LIMITED);
        // Bob is untouched: his post is taken and his stream opens.
        const aliceStream = await stream(alice);
        const callId = callIdOf('bobstill');
        expect((await post(bob, alice.deviceId, ring(callId))).status).toBe(202);
        await stream(bob);
        await aliceStream.waitFor('signal', isSignalFor(callId, 'call:ring'));
      });

      it('caps the calls to one person per hour, whatever new call id each ring carries', async () => {
        const { alice, bob } = await oneToOne();
        const bobTablet = await harness().enrol('bob', 'bob-tablet');
        expectStatus(await harness().addToRoom(ROOM, alice, bobTablet), 201);
        for (let call = 0; call < CALL_RING_PAIR_LIMIT; call += 1) {
          const callId = callIdOf(`ring${call}`);
          // One call rings both of bob's devices and counts once.
          expect((await post(alice, bob.deviceId, ring(callId))).status).toBe(202);
          expect((await post(alice, bobTablet.deviceId, ring(callId))).status).toBe(202);
        }
        const rotated = await post(alice, bob.deviceId, ring(callIdOf('rotated')));
        expect(rotated.status).toBe(429);
        expect(rotated.error).toBe(RelayErrorCode.TARGET_RATE_LIMITED);
        // ... and the refused call stays refused on bob's other device.
        expect((await post(alice, bobTablet.deviceId, ring(callIdOf('rotated')))).status).toBe(429);
        // The window passes: calls go through again.
        harness().clock.advance(CALL_RING_WINDOW_MS);
        expect((await post(alice, bob.deviceId, ring(callIdOf('later')))).status).toBe(202);
      });

      it('a ring refused by a cap admits nothing: later signals of that call reach no one (202 all the same)', async () => {
        const { alice, bob } = await oneToOne();
        const bobStream = await stream(bob);
        const aliceStream = await stream(alice);
        for (let call = 0; call < CALL_RING_PAIR_LIMIT; call += 1) {
          expect((await post(alice, bob.deviceId, ring(callIdOf(`allowed${call}`)))).status).toBe(202);
        }
        const refused = callIdOf('refused');
        const reply = await post(alice, bob.deviceId, ring(refused));
        expect(reply.status).toBe(429);
        expect(reply.error).toBe(RelayErrorCode.TARGET_RATE_LIMITED);
        for (const [from, to, signal] of [
          [alice, bob, offer(refused)],
          [alice, bob, candidate(refused)],
          [alice, bob, verify(refused)],
          [bob, alice, { type: 'call:accept', callId: refused }],
          [bob, alice, end(refused)],
        ] as const) {
          const taken = await post(from, to.deviceId, signal);
          expect(taken.status).toBe(202);
          expect(taken.body).toBe('');
        }
        // Markers inside a call that was admitted: everything posted before them has been written by now.
        const admitted = callIdOf('allowed0');
        expect((await post(alice, bob.deviceId, offer(admitted))).status).toBe(202);
        expect((await post(bob, alice.deviceId, candidate(admitted))).status).toBe(202);
        await bobStream.waitFor('signal', isSignalFor(admitted, 'call:ice'));
        await aliceStream.waitFor('signal', isSignalFor(admitted, 'call:ice'));
        const ofRefused = (events: readonly SseEvent[]) =>
          events.filter((event) => event.event === 'signal' && isSignalFor(refused)(event.data));
        expect(ofRefused(bobStream.events)).toEqual([]);
        expect(ofRefused(aliceStream.events)).toEqual([]);
      });

      it('a connected call keeps its place through long quiet stretches; its end is delivered and closes it', async () => {
        const { alice, bob } = await oneToOne();
        const bobStream = await stream(bob);
        const aliceStream = await stream(alice);
        const callId = callIdOf('longcall');
        expect((await post(alice, bob.deviceId, ring(callId))).status).toBe(202);
        expect((await post(bob, alice.deviceId, { type: 'call:accept', callId })).status).toBe(202);
        expect((await post(alice, bob.deviceId, { type: 'call:accepted', callId })).status).toBe(202);
        // Half an hour without a signal, then an ICE restart (a TURN renewal); half an hour more, then the hang-up.
        harness().clock.advance(3 * CALL_TALLY_IDLE_MS);
        expect((await post(alice, bob.deviceId, offer(callId))).status).toBe(202);
        await bobStream.waitFor('signal', isSignalFor(callId, 'call:ice'));
        harness().clock.advance(3 * CALL_TALLY_IDLE_MS);
        expect((await post(bob, alice.deviceId, end(callId))).status).toBe(202);
        await aliceStream.waitFor('signal', isSignalFor(callId, 'call:end'));
        // Closed: nothing more of the call passes, either way.
        expect((await post(alice, bob.deviceId, candidate(callId))).status).toBe(202);
        expect((await post(bob, alice.deviceId, verify(callId))).status).toBe(202);
        const marker = callIdOf('longmarker');
        expect((await post(alice, bob.deviceId, ring(marker))).status).toBe(202);
        expect((await post(bob, alice.deviceId, { type: 'call:accept', callId: marker })).status).toBe(202);
        await bobStream.waitFor('signal', isSignalFor(marker));
        await aliceStream.waitFor('signal', isSignalFor(marker));
        const ofCall = (events: readonly SseEvent[]) =>
          events
            .filter((event) => event.event === 'signal' && isSignalFor(callId)(event.data))
            .map((event) => (event.data as { signal: { type: string } }).signal.type);
        expect(ofCall(bobStream.events)).toEqual(['call:ring', 'call:accepted', 'call:ice']);
        expect(ofCall(aliceStream.events)).toEqual(['call:accept', 'call:end']);
      });
    });

    describe('a stream that may no longer stay open', () => {
      it('closes the stream of a device that gets revoked, and refuses its signals', async () => {
        const { alice, bob } = await oneToOne();
        // A device in no room (a member must be removed from its rooms before it can be revoked): a stream does
        // not need a room.
        const bobTablet = await harness().enrol('bob', 'bob-tablet');
        const tabletStream = await stream(bobTablet);
        expectStatus(await bob.post(`/devices/${bobTablet.deviceId}/revoke`), 200);
        await tabletStream.waitEnded(DEVICE_RECHECK_MS * 10);
        const reply = await post(bobTablet, alice.deviceId, ring(callIdOf('revoked')));
        expect(reply.status).toBe(403);
        expect(reply.error).toBe(RelayErrorCode.ACTOR_DEVICE_REVOKED);
      });

      it('closes the stream when its token expires', { timeout: 10_000 }, async () => {
        await oneToOne();
        const shortLived = await signTestToken({ sub: 'bob', did: 'bob-phone' }, { expiresInSeconds: 2 });
        const bobStream = await stream({ token: shortLived });
        const closesInMs = (bobStream.events[0]?.data as { closesInMs: number }).closesInMs;
        expect(closesInMs).toBeLessThanOrEqual(2_000);
        await bobStream.waitEnded(closesInMs + 2_000);
        expect(bobStream.events.map((event) => event.event)).toEqual(['ready']);
      });

      it('refuses an expired token on both routes', async () => {
        const { alice } = await oneToOne();
        const expired = await signTestToken({ sub: 'bob', did: 'bob-phone' }, { expiresInSeconds: -3_600 });
        const opened = await openStream(await listeningUrl(harness().app), expired);
        expect(opened.status).toBe(401);
        const reply = await post({ token: expired }, alice.deviceId, ring(callIdOf('expired')));
        expect(reply.status).toBe(401);
      });

      it('never takes the token from the query string', async () => {
        const { alice, bob } = await oneToOne();
        const opened = await openStream(await listeningUrl(harness().app), null);
        expect(opened.status).toBe(401);
        for (const url of [`/calls/stream?access_token=${bob.token}`, `/calls/signal?token=${bob.token}`]) {
          const response = await harness().app.inject({
            method: url.startsWith('/calls/stream') ? 'GET' : 'POST',
            url,
            payload: url.startsWith('/calls/signal')
              ? { conversationId: ROOM, toDeviceId: alice.deviceId, signal: ring(callIdOf('query')) }
              : undefined,
          });
          expect(response.statusCode, url).toBe(401);
        }
      });
    });

    it('ends every stream when the relay closes, also under a base path (the hook lives in the prefixed scope)', async () => {
      const { bob } = await oneToOne();
      const prefixed = await buildServer({
        database: harness().db,
        tokenKeys: TEST_TOKEN_KEYS,
        tokenExpectations: TEST_TOKEN_EXPECTATIONS,
        callsEnabled: true,
        basePath: '/relay',
      });
      const bobStream = await openStream(`${await listeningUrl(prefixed)}/relay`, bob.token);
      expect(bobStream.status).toBe(200);
      await bobStream.waitFor('ready');
      // An open stream keeps its connection busy: without the hook, close() would wait on it for ever.
      const closing = prefixed.close();
      await bobStream.waitEnded();
      await closing;
      expect(bobStream.events.map((event) => event.event)).toEqual(['ready']);
    });

    it.runIf(process.env['RELAY_TEST_REAL_TIMINGS'] === '1')(
      "stays open past the server's request and connection timeouts, on the real keep-alive and re-check",
      { timeout: CONNECTION_TIMEOUT_MS + 60_000 },
      async () => {
        const { alice, bob } = await oneToOne();
        // Default timings: a keep-alive every 15 s, the device re-checked every 60 s; the server's own 30 s request
        // and 60 s connection timeouts, which a test with shortened timings never reaches.
        const real = await buildServer({
          database: harness().db,
          tokenKeys: TEST_TOKEN_KEYS,
          tokenExpectations: TEST_TOKEN_EXPECTATIONS,
          callsEnabled: true,
        });
        try {
          const baseUrl = await listeningUrl(real);
          const bobStream = await openStream(baseUrl, bob.token);
          await bobStream.waitFor('ready');
          const heldMs = CONNECTION_TIMEOUT_MS + CALL_RELAY_LIMITS.keepAliveMs;
          await new Promise((resolve) => setTimeout(resolve, heldMs));
          expect(bobStream.comments()).toBeGreaterThanOrEqual(Math.floor(heldMs / CALL_RELAY_LIMITS.keepAliveMs) - 1);
          expect(REQUEST_TIMEOUT_MS).toBeLessThan(heldMs);
          const callId = callIdOf('realtimings');
          const response = await fetch(`${baseUrl}/calls/signal`, {
            method: 'POST',
            headers: { authorization: `Bearer ${alice.token}`, 'content-type': 'application/json' },
            body: JSON.stringify({ conversationId: ROOM, toDeviceId: bob.deviceId, signal: ring(callId) }),
          });
          expect(response.status).toBe(202);
          await bobStream.waitFor('signal', isSignalFor(callId));
        } finally {
          dropConnections();
          await real.close();
        }
      },
    );

    it('logs no SDP, no candidate and no token', async () => {
      const { alice, bob } = await oneToOne();
      const lines: string[] = [];
      const logged = await buildServer({
        logger: { stream: { write: (line: string) => void lines.push(line) } },
        database: harness().db,
        tokenKeys: TEST_TOKEN_KEYS,
        tokenExpectations: TEST_TOKEN_EXPECTATIONS,
        callsEnabled: true,
      });
      try {
        const baseUrl = await listeningUrl(logged);
        const bobStream = await openStream(baseUrl, bob.token);
        await bobStream.waitFor('ready');
        const callId = callIdOf('logs');
        const signals = [ring(callId), offer(callId), candidate(callId), verify(callId), end(callId)];
        // Every kind of signal, and a malformed one: the error path logs too.
        const bodies = [
          ...signals,
          { type: 'call:ice', callId, signal: { kind: 'bogus', sdp: SDP_MARKER, candidate: CANDIDATE_MARKER } },
        ];
        for (const signal of bodies) {
          await fetch(`${baseUrl}/calls/signal`, {
            method: 'POST',
            headers: { authorization: `Bearer ${alice.token}`, 'content-type': 'application/json' },
            body: JSON.stringify({ conversationId: ROOM, toDeviceId: bob.deviceId, signal }),
          });
        }
        await bobStream.waitFor('signal', isSignalFor(callId, 'call:end'));
      } finally {
        dropConnections();
        await logged.close();
      }
      const log = lines.join('');
      expect(log.length).toBeGreaterThan(0);
      expect(log).not.toContain(SDP_MARKER);
      expect(log).not.toContain(CANDIDATE_MARKER);
      expect(log).not.toContain(alice.token);
      expect(log).not.toContain(bob.token);
      expect(log.toLowerCase()).not.toContain('bearer');
    });
  },
  {
    server: {
      callsEnabled: true,
      callStreamTimings: { keepAliveMs: KEEP_ALIVE_MS, deviceRecheckMs: DEVICE_RECHECK_MS },
      allowedOrigins: [APP_ORIGIN],
    },
  },
);

describe('the call channel, switched off (the default)', () => {
  it('has no routes at all', async () => {
    const database = unusedDatabase();
    const app = await buildServer({ database, tokenKeys: TEST_TOKEN_KEYS, tokenExpectations: TEST_TOKEN_EXPECTATIONS });
    try {
      const token = await signTestToken({ sub: 'alice', did: 'alice-phone' });
      for (const [method, url] of [
        ['GET', '/calls/stream'],
        ['POST', '/calls/signal'],
      ] as const) {
        const response = await app.inject({ method, url, headers: { authorization: `Bearer ${token}` } });
        expect(response.statusCode, `${method} ${url}`).toBe(404);
      }
    } finally {
      await app.close();
      await database.close();
    }
  });
});
