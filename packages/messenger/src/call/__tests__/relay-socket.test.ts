import {
  CALL_LIMITS,
  CALL_RELAY_LIMITS,
  CALL_STREAM_MAX_LIFETIME_MS,
  type CallSignalRequest,
  type RelayCallSignal,
} from '@masia/contracts/wire';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createRelayCallSocket,
  RELAY_SOCKET_CLOSE,
  type RelayCallSocket,
  type RelayFetch,
  type RelayFetchResponse,
} from '../relay-socket.js';

// The call socket over an open relay's call channel (internal ADR-228), against a relay faked in memory: it stamps the
// sender from the token's device as the real one does, delivers to the target's open stream, if any, and, as the real
// one does, passes a signal other than a ring only between the two devices a ring of that call went between. Every
// test ends by checking the adapter never posted outside such a call (the real relay would drop it).

const BASE = 'https://relay.test/relay';
const ROOM = 'dm_alice_bob';
const encoder = new TextEncoder();

interface FakeDevice {
  readonly userId: string;
  readonly deviceId: string;
  readonly token: string;
}

class FakeStream {
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  closed = false;
  readonly body: ReadableStream<Uint8Array>;

  constructor(signal: AbortSignal | undefined) {
    this.body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller;
      },
      cancel: () => {
        this.closed = true;
      },
    });
    signal?.addEventListener('abort', () => {
      if (this.closed) return;
      this.closed = true;
      this.controller?.error(new Error('aborted'));
    });
  }

  write(text: string): void {
    if (!this.closed) this.controller?.enqueue(encoder.encode(text));
  }

  event(name: string, data: unknown): void {
    this.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  end(): void {
    if (this.closed) return;
    this.closed = true;
    this.controller?.close();
  }
}

interface Post {
  readonly from: string;
  readonly url: string;
  readonly body: CallSignalRequest;
  readonly status: number;
}

function reply(status: number, retryAfter: string | null = null, body: ReadableStream<Uint8Array> | null = null): RelayFetchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => (name.toLowerCase() === 'retry-after' ? retryAfter : null) },
    body,
  };
}

function createFakeRelay() {
  const devices = new Map<string, FakeDevice>();
  const streams = new Map<string, FakeStream>();
  const opened: Array<{ deviceId: string; url: string; headers: Record<string, string> }> = [];
  const posts: Post[] = [];
  /** Posts the real relay would drop: a signal other than a ring outside every rung pair of its call. */
  const outsideCalls: Post[] = [];
  const tokensSeen: string[] = [];
  const counters = { postsStarted: 0 };
  let closesInMs = 600_000;
  let streamAnswer: (device: FakeDevice) => { status: number; retryAfter?: string } | null = () => null;
  let postAnswer: (from: FakeDevice, body: CallSignalRequest) => number | null = () => null;
  let postGate: Promise<void> | null = null;
  /** `callId:ringingDevice:rungDevice` for every ring that went through. */
  const admitted = new Set<string>();

  /** The relay's rule: a ring admits its call between its two devices; anything else passes only inside one. */
  function admits(from: FakeDevice, body: CallSignalRequest): boolean {
    const { callId } = body.signal;
    const key = `${callId}:${from.deviceId}:${body.toDeviceId}`;
    if (body.signal.type === 'call:ring') {
      admitted.add(key);
      return true;
    }
    return admitted.has(key) || admitted.has(`${callId}:${body.toDeviceId}:${from.deviceId}`);
  }

  /**
   * Hands `from`'s signal to its target as if `from` had posted it, but past the relay's rule: a test plays a device
   * (or a relay) that misbehaves with it. A ring still admits its call, as a posted one would.
   */
  function deliver(from: FakeDevice, body: CallSignalRequest): void {
    admits(from, body);
    const target = streams.get(body.toDeviceId);
    if (target === undefined || target.closed) return;
    target.event('signal', {
      conversationId: body.conversationId,
      fromUserId: from.userId,
      fromDeviceId: from.deviceId,
      signal: body.signal,
    });
  }

  const fetch: RelayFetch = async (url, init) => {
    const token = (init.headers['authorization'] ?? '').replace(/^Bearer /, '');
    tokensSeen.push(token);
    const device = devices.get(token);
    if (device === undefined) return reply(401);
    if (init.method === 'GET') {
      opened.push({ deviceId: device.deviceId, url, headers: init.headers });
      const forced = streamAnswer(device);
      if (forced !== null) return reply(forced.status, forced.retryAfter ?? null);
      const stream = new FakeStream(init.signal);
      const previous = streams.get(device.deviceId);
      streams.set(device.deviceId, stream);
      if (previous !== undefined) {
        previous.event('replaced', {});
        previous.end();
      }
      stream.event('ready', { closesInMs });
      return reply(200, null, stream.body);
    }
    const body = JSON.parse(init.body ?? '{}') as CallSignalRequest;
    counters.postsStarted += 1;
    if (postGate !== null) await postGate;
    const status = postAnswer(device, body) ?? 202;
    const post: Post = { from: device.deviceId, url, body, status };
    posts.push(post);
    if (status === 202) {
      if (admits(device, body)) deliver(device, body);
      else outsideCalls.push(post);
    }
    return reply(status);
  };

  return {
    fetch,
    devices,
    streams,
    opened,
    posts,
    outsideCalls,
    tokensSeen,
    counters,
    add(device: FakeDevice) {
      devices.set(device.token, device);
    },
    keepAlive() {
      for (const stream of streams.values()) stream.write(': keep-alive\n\n');
    },
    /** What `from` would get delivered by POSTing this: the relay stamps the real sender. */
    deliver,
    setClosesInMs(ms: number) {
      closesInMs = ms;
    },
    setStreamAnswer(answer: typeof streamAnswer) {
      streamAnswer = answer;
    },
    setPostAnswer(answer: typeof postAnswer) {
      postAnswer = answer;
    },
    setPostGate(gate: Promise<void> | null) {
      postGate = gate;
    },
    signalsTo(deviceId: string): RelayCallSignal[] {
      return posts.filter((post) => post.body.toDeviceId === deviceId && post.status === 202).map((post) => post.body.signal);
    },
  };
}

type FakeRelay = ReturnType<typeof createFakeRelay>;

interface Frame {
  readonly type: string;
  readonly payload: Record<string, unknown>;
}

interface Phone {
  readonly device: FakeDevice;
  readonly socket: RelayCallSocket;
  readonly frames: Frame[];
  readonly closes: number[];
  framesOf(type: string): Frame[];
}

let clock = 0;
let seed = 0;

async function settle(): Promise<void> {
  for (let round = 0; round < 6; round += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}


const ALICE: FakeDevice = { userId: 'alice', deviceId: 'alice-phone', token: 'token-alice-phone' };
const ALICE_TABLET: FakeDevice = { userId: 'alice', deviceId: 'alice-tablet', token: 'token-alice-tablet' };
const BOB: FakeDevice = { userId: 'bob', deviceId: 'bob-phone', token: 'token-bob-phone' };
const BOB_TABLET: FakeDevice = { userId: 'bob', deviceId: 'bob-tablet', token: 'token-bob-tablet' };

const TARGETS: Record<string, readonly string[]> = {
  alice: [BOB.deviceId, BOB_TABLET.deviceId],
  bob: [ALICE.deviceId, ALICE_TABLET.deviceId],
};

function phone(
  relay: FakeRelay,
  device: FakeDevice,
  overrides: { ringTargets?: (conversationId: string) => Promise<readonly string[]>; token?: () => string } = {},
): Phone {
  relay.add(device);
  const frames: Frame[] = [];
  const closes: number[] = [];
  const socket = createRelayCallSocket({
    baseUrl: `${BASE}/`,
    token: overrides.token ?? (() => device.token),
    ringTargets: overrides.ringTargets ?? (async () => TARGETS[device.userId] ?? []),
    fetch: relay.fetch,
    now: () => clock,
    random: () => 0.5,
    randomBytes: (bytes) => {
      seed += 1;
      bytes.fill(seed);
    },
  });
  socket.subscribe((raw) => frames.push(raw as Frame));
  socket.onClosed((code) => closes.push(code));
  return { device, socket, frames, closes, framesOf: (type) => frames.filter((frame) => frame.type === type) };
}

function invite(caller: Phone, requestId = 'request-0001'): boolean {
  return caller.socket.send({
    type: 'call:invite',
    payload: { requestId, conversationId: ROOM, deviceId: caller.device.deviceId },
  });
}

function callIdOf(caller: Phone): string {
  const ack = caller.framesOf('call:invite')[0];
  if (ack === undefined) throw new Error('no ack');
  return ack.payload['callId'] as string;
}

const offer = { kind: 'offer', sdp: 'v=0\r\n' } as const;
const answer = { kind: 'answer', sdp: 'v=0\r\n' } as const;
const candidate = { kind: 'candidate', candidate: 'candidate:1 1 udp 1 127.0.0.1 9 typ host', sdpMid: '0', sdpMLineIndex: 0 } as const;
const TAG = 'T'.repeat(43);

describe('createRelayCallSocket', () => {
  let relay: FakeRelay;
  const phones: Phone[] = [];

  /** Moves time on, the relay writing its keep-alives as it goes (unless told not to). */
  async function advance(ms: number, keepAlive = true): Promise<void> {
    let left = ms;
    while (left > 0) {
      const step = Math.min(left, CALL_RELAY_LIMITS.keepAliveMs);
      left -= step;
      clock += step;
      await vi.advanceTimersByTimeAsync(step);
      if (keepAlive) relay.keepAlive();
      await settle();
    }
  }

  function open(device: FakeDevice, overrides?: Parameters<typeof phone>[2]): Phone {
    const created = phone(relay, device, overrides);
    phones.push(created);
    return created;
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    clock = 1_000_000;
    relay = createFakeRelay();
  });

  afterEach(() => {
    for (const created of phones.splice(0)) created.socket.close();
    vi.useRealTimers();
    expect(relay.outsideCalls).toEqual([]);
  });

  /** alice calls; bob's phone and tablet ring. */
  async function ringing(): Promise<{ alice: Phone; bob: Phone; bobTablet: Phone; callId: string }> {
    const alice = open(ALICE);
    const bob = open(BOB);
    const bobTablet = open(BOB_TABLET);
    await settle();
    expect(invite(alice)).toBe(true);
    await settle();
    return { alice, bob, bobTablet, callId: callIdOf(alice) };
  }

  /** …and bob's phone answers. */
  async function answered() {
    const call = await ringing();
    call.bob.socket.send({ type: 'call:accept', payload: { callId: call.callId, deviceId: BOB.deviceId } });
    await settle();
    return call;
  }

  describe('placing a call', () => {
    it('answers the invite itself with a fresh call id, then rings each device, the token in the header only', async () => {
      const { alice, callId } = await ringing();
      expect(alice.framesOf('call:invite')).toEqual([
        {
          type: 'call:invite',
          payload: { requestId: 'request-0001', callId, ringUntil: new Date(clock + CALL_LIMITS.ringTimeoutMs).toISOString() },
        },
      ]);
      expect(callId).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(relay.posts.map((post) => [post.from, post.body.toDeviceId, post.body.signal.type])).toEqual([
        ['alice-phone', 'bob-phone', 'call:ring'],
        ['alice-phone', 'bob-tablet', 'call:ring'],
      ]);
      for (const post of relay.posts) expect(post.url).toBe(`${BASE}/calls/signal`);
      for (const stream of relay.opened) {
        expect(stream.url).toBe(`${BASE}/calls/stream`);
        expect(stream.headers['authorization']).toMatch(/^Bearer token-/);
      }
    });

    it('mints a new call id for every call', async () => {
      const { alice, callId } = await ringing();
      alice.socket.send({ type: 'call:end', payload: { callId, reason: 'hangup' } });
      invite(alice, 'request-0002');
      await settle();
      const ids = alice.framesOf('call:invite').map((frame) => frame.payload['callId']);
      expect(new Set(ids).size).toBe(2);
    });

    it('rings the callee with the caller as the relay knows it', async () => {
      const { bob, bobTablet, callId } = await ringing();
      for (const callee of [bob, bobTablet]) {
        expect(callee.framesOf('call:ring')).toEqual([
          {
            type: 'call:ring',
            payload: {
              callId,
              conversationId: ROOM,
              callerUserId: 'alice',
              callerDeviceId: 'alice-phone',
              ringUntil: new Date(clock + CALL_LIMITS.ringTimeoutMs).toISOString(),
              silent: false,
            },
          },
        ]);
      }
    });

    it('ends a call nobody can be rung for as unavailable', async () => {
      const alice = open(ALICE, { ringTargets: async () => [] });
      await settle();
      invite(alice);
      await settle();
      expect(alice.framesOf('call:end')).toEqual([{ type: 'call:end', payload: { callId: callIdOf(alice), reason: 'unavailable' } }]);
    });

    it('ends a call the relay rate-limits as rate-limited, and cancels what already rang', async () => {
      relay.setPostAnswer((_from, body) => (body.toDeviceId === BOB_TABLET.deviceId ? 429 : null));
      const { alice, bob, callId } = await ringing();
      expect(alice.framesOf('call:end')).toEqual([{ type: 'call:end', payload: { callId, reason: 'rate-limited' } }]);
      expect(bob.framesOf('call:end')).toEqual([{ type: 'call:end', payload: { callId, reason: 'cancelled' } }]);
    });
  });

  describe('answering', () => {
    it('the first device to accept wins; the others, and a late accept, hear answered-elsewhere', async () => {
      const { alice, bob, bobTablet, callId } = await answered();
      expect(alice.framesOf('call:accept')).toEqual([
        { type: 'call:accept', payload: { callId, callerDeviceId: 'alice-phone', calleeDeviceId: 'bob-phone' } },
      ]);
      expect(bob.framesOf('call:accept')).toEqual([
        { type: 'call:accept', payload: { callId, callerDeviceId: 'alice-phone', calleeDeviceId: 'bob-phone' } },
      ]);
      expect(bobTablet.framesOf('call:end')).toEqual([{ type: 'call:end', payload: { callId, reason: 'answered-elsewhere' } }]);

      // The tablet's accept was already on its way: it loses too, and the call goes on.
      relay.deliver(BOB_TABLET, { conversationId: ROOM, toDeviceId: ALICE.deviceId, signal: { type: 'call:accept', callId } });
      await settle();
      expect(alice.framesOf('call:accept')).toHaveLength(1);
      expect(relay.signalsTo(BOB_TABLET.deviceId).filter((signal) => signal.type === 'call:end')).toHaveLength(2);
    });

    it('a decline ends the call for the caller and stops the other devices', async () => {
      const { alice, bob, bobTablet, callId } = await ringing();
      bob.socket.send({ type: 'call:decline', payload: { callId } });
      await settle();
      expect(alice.framesOf('call:end')).toEqual([{ type: 'call:end', payload: { callId, reason: 'declined' } }]);
      expect(bobTablet.framesOf('call:end')).toEqual([{ type: 'call:end', payload: { callId, reason: 'declined' } }]);
    });

    it('the caller times the ring: no-answer on both sides', async () => {
      const { alice, bob, callId } = await ringing();
      await advance(CALL_LIMITS.ringTimeoutMs);
      expect(alice.framesOf('call:end')).toEqual([{ type: 'call:end', payload: { callId, reason: 'no-answer' } }]);
      expect(bob.framesOf('call:end')).toEqual([{ type: 'call:end', payload: { callId, reason: 'no-answer' } }]);
    });

    it('hanging up while it rings cancels it on every rung device', async () => {
      const { alice, bob, bobTablet, callId } = await ringing();
      alice.socket.send({ type: 'call:end', payload: { callId, reason: 'hangup' } });
      await settle();
      for (const callee of [bob, bobTablet]) {
        expect(callee.framesOf('call:end')).toEqual([{ type: 'call:end', payload: { callId, reason: 'cancelled' } }]);
      }
    });
  });

  describe('the pinned peer', () => {
    it('passes signals between the two devices of the call: the offer from the caller, the answer from the callee', async () => {
      const { alice, bob, callId } = await answered();
      alice.socket.send({ type: 'call:ice', payload: { callId, signal: offer } });
      bob.socket.send({ type: 'call:ice', payload: { callId, signal: answer } });
      alice.socket.send({ type: 'call:ice', payload: { callId, signal: candidate } });
      bob.socket.send({ type: 'call:verify', payload: { callId, tag: TAG } });
      alice.socket.send({ type: 'call:verify', payload: { callId, tag: TAG } });
      await settle();
      expect(bob.framesOf('call:ice').map((frame) => frame.payload['signal'])).toEqual([offer, candidate]);
      expect(alice.framesOf('call:ice').map((frame) => frame.payload['signal'])).toEqual([answer]);
      expect(alice.framesOf('call:verify')).toEqual([{ type: 'call:verify', payload: { callId, tag: TAG } }]);
      expect(bob.framesOf('call:verify')).toEqual([{ type: 'call:verify', payload: { callId, tag: TAG } }]);

      bob.socket.send({ type: 'call:end', payload: { callId, reason: 'hangup' } });
      await settle();
      expect(alice.framesOf('call:end')).toEqual([{ type: 'call:end', payload: { callId, reason: 'hangup' } }]);
    });

    it("drops an offer, a tag or an end of the call from any other device, even one of the same person's", async () => {
      const { alice, bob, callId } = await answered();
      open(ALICE_TABLET);
      await settle();
      // alice's tablet (a member of the room, so the relay lets it through) speaks for alice's call to bob…
      for (const signal of [
        { type: 'call:ice', callId, signal: offer },
        { type: 'call:verify', callId, tag: TAG },
        { type: 'call:end', callId, reason: 'hangup' },
      ] as const) {
        relay.deliver(ALICE_TABLET, { conversationId: ROOM, toDeviceId: BOB.deviceId, signal });
        // …and bob's tablet, which lost the call, for bob's side.
        relay.deliver(BOB_TABLET, { conversationId: ROOM, toDeviceId: ALICE.deviceId, signal });
      }
      await settle();
      expect(bob.framesOf('call:ice')).toEqual([]);
      expect(bob.framesOf('call:verify')).toEqual([]);
      expect(bob.framesOf('call:end')).toEqual([]);
      expect(alice.framesOf('call:ice')).toEqual([]);
      expect(alice.framesOf('call:verify')).toEqual([]);
      expect(alice.framesOf('call:end')).toEqual([]);
    });

    it('drops an offer from the callee and an answer from the caller', async () => {
      const { alice, bob, callId } = await answered();
      relay.deliver(BOB, { conversationId: ROOM, toDeviceId: ALICE.deviceId, signal: { type: 'call:ice', callId, signal: offer } });
      relay.deliver(ALICE, { conversationId: ROOM, toDeviceId: BOB.deviceId, signal: { type: 'call:ice', callId, signal: answer } });
      await settle();
      expect(alice.framesOf('call:ice')).toEqual([]);
      expect(bob.framesOf('call:ice')).toEqual([]);
    });

    it('drops a signal of the call that names another room', async () => {
      const { alice, callId } = await answered();
      relay.deliver(BOB, { conversationId: 'another-room', toDeviceId: ALICE.deviceId, signal: { type: 'call:end', callId, reason: 'hangup' } });
      await settle();
      expect(alice.framesOf('call:end')).toEqual([]);
    });

    it('drops a ring whose call id it has seen: a replay, also once the call is over', async () => {
      const { alice, bob, callId } = await ringing();
      relay.deliver(ALICE, { conversationId: ROOM, toDeviceId: BOB.deviceId, signal: { type: 'call:ring', callId } });
      await settle();
      expect(bob.framesOf('call:ring')).toHaveLength(1);
      alice.socket.send({ type: 'call:end', payload: { callId, reason: 'hangup' } });
      await settle();
      relay.deliver(ALICE, { conversationId: ROOM, toDeviceId: BOB.deviceId, signal: { type: 'call:ring', callId } });
      await settle();
      expect(bob.framesOf('call:ring')).toHaveLength(1);
    });
  });

  describe('the stream', () => {
    it('sends nothing until the stream is ready', async () => {
      const alice = open(ALICE);
      expect(alice.socket.isOpen()).toBe(false);
      expect(invite(alice)).toBe(false);
      await settle();
      expect(alice.socket.isOpen()).toBe(true);
      expect(alice.socket.status()).toBe('open');
      expect(relay.posts).toEqual([]);
    });

    it('a lost stream: one close, calls end (lost, to the peer), a waiting ring survives, reopened after a backoff', async () => {
      const { alice, bob, callId } = await answered();
      // A second call rings at alice from bob's tablet, and waits.
      const ringingCallId = 'R'.repeat(22);
      relay.deliver(BOB_TABLET, { conversationId: ROOM, toDeviceId: ALICE.deviceId, signal: { type: 'call:ring', callId: ringingCallId } });
      await settle();
      expect(alice.framesOf('call:ring')).toHaveLength(1);

      relay.streams.get(ALICE.deviceId)?.end();
      await settle();
      expect(alice.closes).toEqual([RELAY_SOCKET_CLOSE.LOST]);
      expect(alice.socket.isOpen()).toBe(false);
      expect(alice.socket.status()).toBe('waiting');
      expect(bob.framesOf('call:end')).toEqual([{ type: 'call:end', payload: { callId, reason: 'lost' } }]);
      const opens = relay.opened.filter((stream) => stream.deviceId === ALICE.deviceId).length;

      await advance(1_000);
      expect(relay.opened.filter((stream) => stream.deviceId === ALICE.deviceId)).toHaveLength(opens + 1);
      expect(alice.socket.isOpen()).toBe(true);
      // The waiting ring is still answerable on the new stream.
      alice.socket.send({ type: 'call:accept', payload: { callId: ringingCallId, deviceId: ALICE.deviceId } });
      await settle();
      expect(relay.signalsTo(BOB_TABLET.deviceId)).toContainEqual({ type: 'call:accept', callId: ringingCallId });
      expect(alice.closes).toEqual([RELAY_SOCKET_CLOSE.LOST]);
    });

    it('backs off longer after each failure, and never sooner than Retry-After', async () => {
      let answer: { status: number; retryAfter?: string } | null = { status: 500 };
      relay.setStreamAnswer(() => answer);
      const alice = open(ALICE);
      await settle();
      expect(relay.opened).toHaveLength(1);
      // With the jitter at its middle, three quarters of 1 s, then of 2 s.
      await advance(749);
      expect(relay.opened).toHaveLength(1);
      await advance(1);
      expect(relay.opened).toHaveLength(2);
      await advance(1_499);
      expect(relay.opened).toHaveLength(2);
      answer = { status: 503, retryAfter: '20' };
      await advance(1);
      expect(relay.opened).toHaveLength(3);
      await advance(19_999);
      expect(relay.opened).toHaveLength(3);
      answer = null;
      await advance(1);
      expect(relay.opened).toHaveLength(4);
      expect(alice.socket.isOpen()).toBe(true);
      expect(alice.closes).toEqual([]);
    });

    it('caps a Retry-After from the relay at its own backoff ceiling (30 s by default)', async () => {
      let answer: { status: number; retryAfter?: string } | null = { status: 503, retryAfter: '86400' };
      relay.setStreamAnswer(() => answer);
      const alice = open(ALICE);
      await settle();
      expect(relay.opened).toHaveLength(1);
      answer = null;
      await advance(30_000 - 1);
      expect(relay.opened).toHaveLength(1);
      await advance(1);
      expect(relay.opened).toHaveLength(2);
      expect(alice.socket.isOpen()).toBe(true);
    });

    it('caps a Retry-After on an early reopen too, while the old stream runs on', async () => {
      const alice = open(ALICE);
      await settle();
      relay.setStreamAnswer(() => ({ status: 503, retryAfter: '86400' }));
      // The reopen goes out its lead time (30 s) before the stream's end, and is refused.
      await advance(600_000 - 30_000);
      expect(relay.opened).toHaveLength(2);
      relay.setStreamAnswer(() => null);
      await advance(30_000 - 1);
      expect(relay.opened).toHaveLength(2);
      await advance(1);
      expect(relay.opened).toHaveLength(3);
      expect(alice.closes).toEqual([]);
      expect(alice.socket.isOpen()).toBe(true);
    });

    it('never schedules on a closesInMs no real stream could have', async () => {
      relay.setClosesInMs(1e12);
      const alice = open(ALICE);
      await settle();
      // Capped at the longest a stream lives; the next stream opens its lead time (30 s) before that.
      await advance(CALL_STREAM_MAX_LIFETIME_MS - 30_000 - 1);
      expect(relay.opened).toHaveLength(1);
      await advance(1);
      expect(relay.opened).toHaveLength(2);
      expect(alice.closes).toEqual([]);
      expect(alice.socket.isOpen()).toBe(true);
    });

    it('is quiet for too long, and reopens', async () => {
      const alice = open(ALICE);
      await settle();
      await advance(CALL_RELAY_LIMITS.silenceMs - 1, false);
      expect(alice.closes).toEqual([]);
      await advance(1, false);
      expect(alice.closes).toEqual([RELAY_SOCKET_CLOSE.LOST]);
      await advance(1_000);
      expect(alice.socket.isOpen()).toBe(true);
    });

    it('opens the next stream before the token expires, with no close in between', async () => {
      relay.setClosesInMs(120_000);
      let token = ALICE.token;
      const alice = open(ALICE, { token: () => token });
      await settle();
      relay.add({ ...ALICE, token: 'token-alice-phone-2' });
      token = 'token-alice-phone-2';
      await advance(120_000 - 30_000);
      expect(relay.opened).toHaveLength(2);
      expect(relay.tokensSeen.at(-1)).toBe('token-alice-phone-2');
      expect(alice.closes).toEqual([]);
      expect(alice.socket.isOpen()).toBe(true);
      // Signals reach it on the new stream.
      const bob = open(BOB);
      await settle();
      invite(bob);
      await settle();
      expect(alice.framesOf('call:ring')).toHaveLength(1);
    });

    it('stops for good when another stream takes the device (another tab)', async () => {
      const alice = open(ALICE);
      await settle();
      const otherTab = open(ALICE);
      await settle();
      expect(alice.closes).toEqual([RELAY_SOCKET_CLOSE.REPLACED]);
      expect(alice.socket.status()).toBe('stopped');
      await advance(60_000);
      expect(relay.opened).toHaveLength(2);
      expect(otherTab.socket.isOpen()).toBe(true);
    });

    it('stops for good when the relay refuses the device (403), and retries a refused token (401)', async () => {
      relay.setStreamAnswer(() => ({ status: 403 }));
      const refused = open(ALICE);
      await settle();
      expect(refused.socket.status()).toBe('stopped');
      await advance(60_000);
      expect(relay.opened).toHaveLength(1);

      relay.setStreamAnswer(() => null);
      let token = 'not-yet-valid';
      const late = open(BOB, { token: () => token });
      await settle();
      expect(late.socket.isOpen()).toBe(false);
      token = BOB.token;
      await advance(1_000);
      expect(late.socket.isOpen()).toBe(true);
    });

    it('sends the signals of one call one at a time, in order', async () => {
      const { alice, callId } = await answered();
      let release: () => void = () => undefined;
      relay.setPostGate(new Promise<void>((resolve) => (release = resolve)));
      const before = relay.posts.length;
      const started = relay.counters.postsStarted;
      alice.socket.send({ type: 'call:ice', payload: { callId, signal: offer } });
      alice.socket.send({ type: 'call:ice', payload: { callId, signal: candidate } });
      alice.socket.send({ type: 'call:verify', payload: { callId, tag: TAG } });
      await settle();
      // One on the wire, two waiting behind it.
      expect(relay.counters.postsStarted - started).toBe(1);
      expect(relay.posts.length).toBe(before);
      relay.setPostGate(null);
      release();
      await settle();
      expect(relay.posts.slice(before).map((post) => post.body.signal.type)).toEqual(['call:ice', 'call:ice', 'call:verify']);
      expect(relay.posts.slice(before).map((post) => (post.body.signal as { signal?: { kind: string } }).signal?.kind)).toEqual([
        'offer',
        'candidate',
        undefined,
      ]);
    });
  });
});
