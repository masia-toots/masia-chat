import { describe, expect, it } from 'vitest';
import { CALL_LIMITS, callRelayCap, type CallStreamSignal, type RelayCallSignal } from '@masia/contracts/wire';
import { type CallStreamSink, createCallChannel, SSE_KEEP_ALIVE, sseEvent } from '../call-channel.js';
import {
  CALL_ACCEPTED_IDLE_MS,
  CALL_ADMITTED_MAX,
  CALL_ADMITTED_PER_USER_MAX,
  CALL_CONTROL_PER_END_MAX,
  CALL_FRAME_BUDGETS_MAX,
  CALL_RING_PAIR_LIMIT,
  CALL_RING_USER_LIMIT,
  CALL_RING_VERDICTS_MAX,
  CALL_RING_WINDOW_MS,
  CALL_STREAM_BUFFER_MAX_BYTES,
  CALL_STREAMS_MAX,
  CALL_STREAMS_PER_USER_MAX,
  CALL_TALLIES_MAX,
  CALL_TALLY_IDLE_MS,
} from '../protocol.js';

const CALL_ID = 'abcdefghijklmnopqrstuv';
const ring = (id = CALL_ID): RelayCallSignal => ({ type: 'call:ring', callId: id });
const ALICE_PHONE = { deviceId: 'alice-phone', userId: 'alice' };
const ALICE_TABLET = { deviceId: 'alice-tablet', userId: 'alice' };
const BOB_PHONE = { deviceId: 'bob-phone', userId: 'bob' };
const BOB_TABLET = { deviceId: 'bob-tablet', userId: 'bob' };

function clock(start = 1_000_000) {
  let at = start;
  return {
    now: () => at,
    advance(ms: number) {
      at += ms;
    },
  };
}

interface FakeSink extends CallStreamSink {
  readonly frames: string[];
  readonly ended: string[];
  bufferedBytes: number;
}

function sink(): FakeSink {
  const frames: string[] = [];
  const ended: string[] = [];
  return {
    frames,
    ended,
    bufferedBytes: 0,
    write: (frame) => void frames.push(frame),
    end: (reason) => void ended.push(reason),
  };
}

function callId(n: number): string {
  return `call${String(n).padStart(18, '0')}`;
}

function event(signal: RelayCallSignal = { type: 'call:ring', callId: CALL_ID }): CallStreamSignal {
  return { conversationId: 'room', fromUserId: 'alice', fromDeviceId: 'alice-phone', signal };
}

describe('the call channel — streams', () => {
  it('delivers to the target stream only, as one SSE event', () => {
    const channel = createCallChannel();
    const bob = sink();
    const carol = sink();
    channel.openStream({ deviceId: 'bob-phone', userId: 'bob' }, bob);
    channel.openStream({ deviceId: 'carol-phone', userId: 'carol' }, carol);
    expect(channel.deliver('bob-phone', event())).toBe(true);
    expect(bob.frames).toEqual([sseEvent('signal', event())]);
    expect(carol.frames).toEqual([]);
    expect(channel.deliver('nobody', event())).toBe(false);
  });

  it('formats an event as one data line and a keep-alive as a comment', () => {
    const frame = sseEvent('signal', { text: 'two\nlines' });
    expect(frame).toBe('event: signal\ndata: {"text":"two\\nlines"}\n\n');
    expect(SSE_KEEP_ALIVE.startsWith(':')).toBe(true);
  });

  it('a new stream of the same device replaces the old one, which no longer receives', () => {
    const channel = createCallChannel();
    const first = sink();
    const second = sink();
    const opened = channel.openStream({ deviceId: 'bob-phone', userId: 'bob' }, first);
    channel.openStream({ deviceId: 'bob-phone', userId: 'bob' }, second);
    expect(first.ended).toEqual(['replaced']);
    channel.deliver('bob-phone', event());
    expect(first.frames).toEqual([]);
    expect(second.frames).toHaveLength(1);
    // The old stream's late release must not unregister the new one.
    if (opened.ok) opened.release();
    expect(channel.streams).toBe(1);
    expect(channel.deliver('bob-phone', event())).toBe(true);
  });

  it('release unregisters', () => {
    const channel = createCallChannel();
    const opened = channel.openStream({ deviceId: 'bob-phone', userId: 'bob' }, sink());
    expect(opened.ok).toBe(true);
    if (opened.ok) opened.release();
    expect(channel.streams).toBe(0);
    expect(channel.deliver('bob-phone', event())).toBe(false);
  });

  it('caps the streams of one person, and replacing does not count', () => {
    const channel = createCallChannel();
    for (let i = 0; i < CALL_STREAMS_PER_USER_MAX; i += 1) {
      expect(channel.openStream({ deviceId: `bob-${i}`, userId: 'bob' }, sink()).ok).toBe(true);
    }
    expect(channel.openStream({ deviceId: 'bob-extra', userId: 'bob' }, sink())).toEqual({ ok: false, scope: 'user' });
    expect(channel.openStream({ deviceId: 'bob-0', userId: 'bob' }, sink()).ok).toBe(true);
    expect(channel.openStream({ deviceId: 'carol-0', userId: 'carol' }, sink()).ok).toBe(true);
  });

  it('caps the streams of the whole relay', () => {
    const channel = createCallChannel();
    for (let i = 0; i < CALL_STREAMS_MAX; i += 1) {
      channel.openStream({ deviceId: `d-${i}`, userId: `u-${Math.floor(i / CALL_STREAMS_PER_USER_MAX)}` }, sink());
    }
    expect(channel.streams).toBe(CALL_STREAMS_MAX);
    expect(channel.openStream({ deviceId: 'late', userId: 'late' }, sink())).toEqual({ ok: false, scope: 'relay' });
  });

  it('a reader more than CALL_STREAM_BUFFER_MAX_BYTES behind gets nothing more (the signal is dropped)', () => {
    const channel = createCallChannel();
    const slow = sink();
    channel.openStream({ deviceId: 'bob-phone', userId: 'bob' }, slow);
    slow.bufferedBytes = CALL_STREAM_BUFFER_MAX_BYTES;
    expect(channel.deliver('bob-phone', event())).toBe(true);
    slow.bufferedBytes = CALL_STREAM_BUFFER_MAX_BYTES + 1;
    expect(channel.deliver('bob-phone', event())).toBe(false);
    expect(slow.frames).toHaveLength(1);
    slow.bufferedBytes = 0;
    expect(channel.deliver('bob-phone', event())).toBe(true);
  });

  it('closeAll ends every stream', () => {
    const channel = createCallChannel();
    const a = sink();
    const b = sink();
    channel.openStream({ deviceId: 'a', userId: 'a' }, a);
    channel.openStream({ deviceId: 'b', userId: 'b' }, b);
    channel.closeAll();
    expect([a.ended, b.ended]).toEqual([['closing'], ['closing']]);
    expect(channel.streams).toBe(0);
  });
});

describe('the call channel — budgets', () => {
  it('a sender gets the burst, then the refill rate (a flood is cut)', () => {
    const time = clock();
    const channel = createCallChannel({ now: time.now });
    for (let i = 0; i < CALL_LIMITS.socketFramesBurst; i += 1) expect(channel.admit(ALICE_PHONE).ok).toBe(true);
    const refused = channel.admit(ALICE_PHONE);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.retryAfterMs).toBeGreaterThan(0);
    expect(channel.admit(ALICE_TABLET).ok).toBe(true);
    time.advance(1000);
    for (let i = 0; i < CALL_LIMITS.socketFramesPerSecond; i += 1) expect(channel.admit(ALICE_PHONE).ok).toBe(true);
    expect(channel.admit(ALICE_PHONE).ok).toBe(false);
  });

  it("keys the budget on the token's user and device: another account naming bob's device spends its own", () => {
    const channel = createCallChannel();
    const mallory = { deviceId: BOB_PHONE.deviceId, userId: 'mallory' };
    for (let i = 0; i < CALL_LIMITS.socketFramesBurst; i += 1) expect(channel.admit(mallory).ok).toBe(true);
    expect(channel.admit(mallory).ok).toBe(false);
    for (let i = 0; i < CALL_LIMITS.socketFramesBurst; i += 1) expect(channel.admit(BOB_PHONE).ok).toBe(true);
    expect(channel.admit(BOB_PHONE).ok).toBe(false);
  });

  it('holds at most CALL_FRAME_BUDGETS_MAX budgets: the oldest is forgotten, one in use is kept', () => {
    const channel = createCallChannel();
    const drain = (sender: { deviceId: string; userId: string }) => {
      for (let i = 0; i < CALL_LIMITS.socketFramesBurst; i += 1) channel.admit(sender);
      expect(channel.admit(sender).ok).toBe(false);
    };
    drain(ALICE_PHONE);
    drain(BOB_PHONE);
    for (let n = 0; n < CALL_FRAME_BUDGETS_MAX - 2; n += 1) channel.admit({ deviceId: `d${n}`, userId: `u${n}` });
    expect(channel.held.frameBudgets).toBe(CALL_FRAME_BUDGETS_MAX);
    // Bob, refused again, moves to the newest place; one more sender then pushes out the oldest, alice.
    expect(channel.admit(BOB_PHONE).ok).toBe(false);
    channel.admit({ deviceId: 'late', userId: 'late' });
    expect(channel.held.frameBudgets).toBe(CALL_FRAME_BUDGETS_MAX);
    expect(channel.admit(BOB_PHONE).ok).toBe(false);
    // Forgotten, alice starts again from a full burst.
    expect(channel.admit(ALICE_PHONE).ok).toBe(true);
    expect(channel.held.frameBudgets).toBe(CALL_FRAME_BUDGETS_MAX);
  });

  it('a call counts once against the ring caps however many devices it rings', () => {
    const channel = createCallChannel();
    for (let device = 0; device < 10; device += 1) expect(channel.countRing('alice', 'bob', CALL_ID)).toEqual({ ok: true });
    for (let n = 1; n < CALL_RING_PAIR_LIMIT; n += 1) expect(channel.countRing('alice', 'bob', callId(n)).ok).toBe(true);
    const refused = channel.countRing('alice', 'bob', callId(99));
    expect(refused).toMatchObject({ ok: false, scope: 'pair' });
  });

  it("remembers an allowed ring for the call's ring time, then judges it again", () => {
    const time = clock();
    const channel = createCallChannel({ now: time.now });
    for (let n = 0; n < CALL_RING_PAIR_LIMIT; n += 1) expect(channel.countRing('alice', 'bob', callId(n)).ok).toBe(true);
    // The pair cap is spent; call 0's other devices still ring, uncounted, for its ring time and no longer.
    time.advance(CALL_LIMITS.ringTimeoutMs - 1);
    expect(channel.countRing('alice', 'bob', callId(0)).ok).toBe(true);
    time.advance(1);
    expect(channel.countRing('alice', 'bob', callId(0))).toMatchObject({ ok: false, scope: 'pair' });
  });

  it('rotating the call id does not escape the per-person cap, and a refused call stays refused', () => {
    const time = clock();
    const channel = createCallChannel({ now: time.now });
    for (let n = 0; n < CALL_RING_USER_LIMIT; n += 1) {
      expect(channel.countRing('alice', `person-${n}`, callId(n)).ok).toBe(true);
    }
    const refused = channel.countRing('alice', 'someone-new', callId(500));
    expect(refused).toMatchObject({ ok: false, scope: 'user' });
    expect(channel.countRing('alice', 'someone-new', callId(500)).ok).toBe(false);
    expect(channel.countRing('mallory', 'bob', callId(500)).ok).toBe(true);
    time.advance(CALL_RING_WINDOW_MS + 1);
    expect(channel.countRing('alice', 'someone-new', callId(501)).ok).toBe(true);
  });

  it('caps SDPs, candidates and tags per call and per sending device, from the contract’s rule', () => {
    const time = clock();
    const channel = createCallChannel({ now: time.now });
    const offer: RelayCallSignal = { type: 'call:ice', callId: CALL_ID, signal: { kind: 'offer', sdp: 'v=0' } };
    const tag: RelayCallSignal = { type: 'call:verify', callId: CALL_ID, tag: 'A'.repeat(43) };
    expect(channel.countSignal(ALICE_PHONE, 'bob-phone', ring())).toBe(true);
    for (let i = 0; i < callRelayCap('sdp', 0); i += 1) expect(channel.countSignal(ALICE_PHONE, 'bob-phone', offer)).toBe(true);
    expect(channel.countSignal(ALICE_PHONE, 'bob-phone', offer)).toBe(false);
    expect(channel.countSignal(BOB_PHONE, 'alice-phone', offer)).toBe(true);
    for (let i = 0; i < callRelayCap('verify', 0); i += 1) expect(channel.countSignal(ALICE_PHONE, 'bob-phone', tag)).toBe(true);
    expect(channel.countSignal(ALICE_PHONE, 'bob-phone', tag)).toBe(false);
    time.advance(CALL_LIMITS.relayRefillMs);
    expect(channel.countSignal(ALICE_PHONE, 'bob-phone', offer)).toBe(true);
    expect(channel.countSignal(ALICE_PHONE, 'bob-phone', tag)).toBe(false);
  });

  it('caps the control signals one device sends for one call, across every device it rings', () => {
    const channel = createCallChannel();
    for (let i = 0; i < CALL_CONTROL_PER_END_MAX; i += 1) expect(channel.countSignal(ALICE_PHONE, `bob-${i}`, ring())).toBe(true);
    expect(channel.countSignal(ALICE_PHONE, `bob-${CALL_CONTROL_PER_END_MAX}`, ring())).toBe(false);
    expect(channel.countSignal(ALICE_PHONE, 'bob-0', { type: 'call:accepted', callId: CALL_ID })).toBe(false);
    // Over the cap, the ring admitted nothing.
    expect(channel.held.admittedCalls).toBe(CALL_CONTROL_PER_END_MAX);
  });
});

describe('the call channel — admitted calls', () => {
  const offer = (id = CALL_ID): RelayCallSignal => ({ type: 'call:ice', callId: id, signal: { kind: 'offer', sdp: 'v=0' } });
  const candidate = (id = CALL_ID): RelayCallSignal => ({
    type: 'call:ice',
    callId: id,
    signal: { kind: 'candidate', candidate: 'candidate:1 1 udp 1 127.0.0.1 9 typ host', sdpMid: '0', sdpMLineIndex: 0 },
  });
  const tag = (id = CALL_ID): RelayCallSignal => ({ type: 'call:verify', callId: id, tag: 'A'.repeat(43) });
  const answer = (id = CALL_ID): RelayCallSignal => ({ type: 'call:ice', callId: id, signal: { kind: 'answer', sdp: 'v=0' } });
  const end = (id = CALL_ID): RelayCallSignal => ({ type: 'call:end', callId: id, reason: 'hangup' });
  const accept = (id = CALL_ID): RelayCallSignal => ({ type: 'call:accept', callId: id });
  const accepted = (id = CALL_ID): RelayCallSignal => ({ type: 'call:accepted', callId: id });

  it('drops every signal but a ring for a call nobody rang, and keeps nothing for it', () => {
    const channel = createCallChannel();
    for (const signal of [offer(), candidate(), tag(), end(), accept(), accepted()]) {
      expect(channel.countSignal(ALICE_PHONE, 'bob-phone', signal), signal.type).toBe(false);
      expect(channel.countSignal(BOB_PHONE, 'alice-phone', signal), signal.type).toBe(false);
    }
    expect(channel.held).toEqual({ frameBudgets: 0, admittedCalls: 0, tallies: 0, ringVerdicts: 0 });
  });

  it('after a ring, passes the call both ways between the ringing device and the rung one, and no other pair', () => {
    const channel = createCallChannel();
    expect(channel.countSignal(ALICE_PHONE, 'bob-phone', ring())).toBe(true);
    expect(channel.countSignal(BOB_PHONE, 'alice-phone', accept())).toBe(true);
    expect(channel.countSignal(ALICE_PHONE, 'bob-phone', offer())).toBe(true);
    expect(channel.countSignal(BOB_PHONE, 'alice-phone', candidate())).toBe(true);
    expect(channel.countSignal(BOB_PHONE, 'alice-phone', tag())).toBe(true);
    // Another device of either person is outside the call, and so is another call id between the same two devices.
    expect(channel.countSignal(ALICE_TABLET, 'bob-phone', end())).toBe(false);
    expect(channel.countSignal(ALICE_PHONE, 'bob-tablet', end())).toBe(false);
    expect(channel.countSignal(BOB_TABLET, 'alice-phone', accept())).toBe(false);
    expect(channel.countSignal(ALICE_PHONE, 'bob-phone', end(callId(1)))).toBe(false);
    // Rung too, bob's tablet is in.
    expect(channel.countSignal(ALICE_PHONE, 'bob-tablet', ring())).toBe(true);
    expect(channel.countSignal(BOB_TABLET, 'alice-phone', { type: 'call:decline', callId: CALL_ID })).toBe(true);
    expect(channel.countSignal(ALICE_PHONE, 'bob-tablet', end())).toBe(true);
  });

  it('forgets a call that has not connected after CALL_TALLY_IDLE_MS of quiet; the signals that pass keep it alive', () => {
    const time = clock();
    const channel = createCallChannel({ now: time.now });
    expect(channel.countSignal(ALICE_PHONE, 'bob-phone', ring())).toBe(true);
    time.advance(CALL_TALLY_IDLE_MS - 1);
    expect(channel.countSignal(BOB_PHONE, 'alice-phone', accept())).toBe(true);
    time.advance(CALL_TALLY_IDLE_MS - 1);
    expect(channel.countSignal(ALICE_PHONE, 'bob-phone', offer())).toBe(true);
    time.advance(CALL_TALLY_IDLE_MS);
    expect(channel.countSignal(BOB_PHONE, 'alice-phone', end())).toBe(false);
    expect(channel.countSignal(ALICE_PHONE, 'bob-phone', end())).toBe(false);
    expect(channel.held).toMatchObject({ admittedCalls: 0, tallies: 0 });
    // A dropped signal does not keep a call alive either: a new ring is a new call.
    expect(channel.countSignal(ALICE_PHONE, 'bob-phone', ring())).toBe(true);
    expect(channel.held).toMatchObject({ admittedCalls: 1, tallies: 1 });
  });

  it('keeps a connected call through long quiet stretches: its restart offer and its end pass, then nothing does', () => {
    const time = clock();
    const channel = createCallChannel({ now: time.now });
    expect(channel.countSignal(ALICE_PHONE, 'bob-phone', ring())).toBe(true);
    expect(channel.countSignal(BOB_PHONE, 'alice-phone', accept())).toBe(true);
    expect(channel.countSignal(ALICE_PHONE, 'bob-phone', accepted())).toBe(true);
    time.advance(3 * CALL_TALLY_IDLE_MS);
    // An ICE restart half an hour in (a TURN renewal), both ways.
    expect(channel.countSignal(ALICE_PHONE, 'bob-phone', offer())).toBe(true);
    expect(channel.countSignal(BOB_PHONE, 'alice-phone', answer())).toBe(true);
    time.advance(CALL_ACCEPTED_IDLE_MS - 1);
    expect(channel.countSignal(BOB_PHONE, 'alice-phone', end())).toBe(true);
    // Closed: the end freed its place, and no signal of that call passes between the two devices any more.
    expect(channel.held.admittedCalls).toBe(0);
    for (const signal of [offer(), candidate(), tag(), accept(), accepted(), end()]) {
      expect(channel.countSignal(ALICE_PHONE, 'bob-phone', signal), signal.type).toBe(false);
      expect(channel.countSignal(BOB_PHONE, 'alice-phone', signal), signal.type).toBe(false);
    }
  });

  it('connects a call only when both ends have said so, and forgets a connected call after CALL_ACCEPTED_IDLE_MS', () => {
    const time = clock();
    const channel = createCallChannel({ now: time.now });
    // The ringing device alone, or the confirmation the wrong way round, connects nothing.
    expect(channel.countSignal(ALICE_PHONE, 'bob-phone', ring(callId(1)))).toBe(true);
    expect(channel.countSignal(ALICE_PHONE, 'bob-phone', accepted(callId(1)))).toBe(true);
    expect(channel.countSignal(ALICE_PHONE, 'bob-tablet', ring(callId(2)))).toBe(true);
    expect(channel.countSignal(BOB_TABLET, 'alice-phone', accepted(callId(2)))).toBe(true);
    expect(channel.countSignal(BOB_TABLET, 'alice-phone', accept(callId(2)))).toBe(true);
    // Both, in order: connected.
    expect(channel.countSignal(ALICE_PHONE, 'bob-phone', ring(callId(3)))).toBe(true);
    expect(channel.countSignal(BOB_PHONE, 'alice-phone', accept(callId(3)))).toBe(true);
    expect(channel.countSignal(ALICE_PHONE, 'bob-phone', accepted(callId(3)))).toBe(true);
    time.advance(CALL_TALLY_IDLE_MS);
    expect(channel.countSignal(BOB_PHONE, 'alice-phone', end(callId(1)))).toBe(false);
    expect(channel.countSignal(BOB_TABLET, 'alice-phone', end(callId(2)))).toBe(false);
    expect(channel.held.admittedCalls).toBe(1);
    time.advance(CALL_ACCEPTED_IDLE_MS - CALL_TALLY_IDLE_MS);
    expect(channel.countSignal(BOB_PHONE, 'alice-phone', end(callId(3)))).toBe(false);
    expect(channel.held.admittedCalls).toBe(0);
  });

  it("an end frees the call's place in the person's share, whichever end sends it", () => {
    const channel = createCallChannel();
    for (let n = 0; n < CALL_ADMITTED_PER_USER_MAX; n += 1) {
      expect(channel.countSignal(ALICE_PHONE, `bob-${n}`, ring(callId(n)))).toBe(true);
    }
    expect(channel.countSignal(ALICE_PHONE, 'bob-new', ring(callId(1_000)))).toBe(false);
    expect(channel.countSignal({ deviceId: 'bob-0', userId: 'bob' }, 'alice-phone', end(callId(0)))).toBe(true);
    expect(channel.countSignal(ALICE_PHONE, 'bob-new', ring(callId(1_000)))).toBe(true);
    expect(channel.countSignal(ALICE_PHONE, 'bob-newer', ring(callId(1_001)))).toBe(false);
    expect(channel.countSignal(ALICE_PHONE, 'bob-1', end(callId(1)))).toBe(true);
    expect(channel.countSignal(ALICE_PHONE, 'bob-newer', ring(callId(1_001)))).toBe(true);
    expect(channel.held.admittedCalls).toBe(CALL_ADMITTED_PER_USER_MAX);
  });

  it("holds connected calls within the person's share: at most CALL_ADMITTED_PER_USER_MAX of them, for as long as they live", () => {
    const time = clock();
    const channel = createCallChannel({ now: time.now });
    for (let n = 0; n < CALL_ADMITTED_PER_USER_MAX; n += 1) {
      const bob = { deviceId: `bob-${n}`, userId: 'bob' };
      expect(channel.countSignal(ALICE_PHONE, bob.deviceId, ring(callId(n)))).toBe(true);
      expect(channel.countSignal(bob, ALICE_PHONE.deviceId, accept(callId(n)))).toBe(true);
      expect(channel.countSignal(ALICE_PHONE, bob.deviceId, accepted(callId(n)))).toBe(true);
    }
    expect(channel.countSignal(ALICE_PHONE, 'bob-new', ring(callId(1_000)))).toBe(false);
    time.advance(CALL_ACCEPTED_IDLE_MS - 1);
    expect(channel.countSignal(ALICE_TABLET, 'bob-new', ring(callId(1_000)))).toBe(false);
    // Others are not held back by alice's share.
    expect(channel.countSignal(BOB_PHONE, 'alice-phone', ring(callId(2_000)))).toBe(true);
    time.advance(1);
    expect(channel.countSignal(ALICE_PHONE, 'bob-new', ring(callId(1_000)))).toBe(true);
    expect(channel.held.admittedCalls).toBe(2);
  });

  it("caps one person's share: rotated call ids from one person stop at it, and others still get in", () => {
    const time = clock();
    const channel = createCallChannel({ now: time.now });
    for (let n = 0; n < CALL_ADMITTED_PER_USER_MAX; n += 1) {
      // Spread over two of alice's devices: the share is the person's, not the device's.
      const from = n % 2 === 0 ? ALICE_PHONE : ALICE_TABLET;
      expect(channel.countSignal(from, 'bob-phone', ring(callId(n)))).toBe(true);
    }
    expect(channel.countSignal(ALICE_PHONE, 'bob-phone', ring(callId(CALL_ADMITTED_PER_USER_MAX)))).toBe(false);
    expect(channel.countSignal(ALICE_TABLET, 'bob-tablet', ring(callId(CALL_ADMITTED_PER_USER_MAX)))).toBe(false);
    // A call already in goes on; a ring to it again is not a new call.
    expect(channel.countSignal(ALICE_PHONE, 'bob-phone', ring(callId(0)))).toBe(true);
    expect(channel.countSignal(BOB_PHONE, 'alice-phone', accept(callId(0)))).toBe(true);
    expect(channel.countSignal(BOB_PHONE, 'alice-phone', ring(callId(0)))).toBe(true);
    expect(channel.held.admittedCalls).toBe(CALL_ADMITTED_PER_USER_MAX + 1);
    time.advance(CALL_TALLY_IDLE_MS);
    expect(channel.countSignal(ALICE_PHONE, 'bob-phone', ring(callId(CALL_ADMITTED_PER_USER_MAX)))).toBe(true);
  });

  it('stays bounded under rotated call ids from many people: a ring past the ceiling is dropped, calls in progress go on', () => {
    const time = clock();
    const channel = createCallChannel({ now: time.now });
    const person = (n: number) => {
      const k = Math.floor(n / CALL_ADMITTED_PER_USER_MAX);
      return { deviceId: `d${k}`, userId: `u${k}` };
    };
    for (let n = 0; n < CALL_ADMITTED_MAX; n += 1) {
      expect(channel.countSignal(person(n), 'bob-phone', ring(callId(n)))).toBe(true);
    }
    expect(channel.countSignal({ deviceId: 'late', userId: 'late' }, 'bob-phone', ring(callId(0)))).toBe(false);
    for (let n = 0; n < 1_000; n += 1) {
      expect(channel.countSignal(ALICE_PHONE, 'bob-phone', end(callId(CALL_ADMITTED_MAX + n)))).toBe(false);
    }
    expect(channel.held.admittedCalls).toBe(CALL_ADMITTED_MAX);
    expect(channel.countSignal(BOB_PHONE, 'd0', accept(callId(0)))).toBe(true);
    // Once the old calls go quiet, new ones get in, and the maps empty out.
    time.advance(CALL_TALLY_IDLE_MS);
    expect(channel.countSignal({ deviceId: 'late', userId: 'late' }, 'bob-phone', ring(callId(0)))).toBe(true);
    expect(channel.held).toMatchObject({ admittedCalls: 1, tallies: 1 });
  });

  it('stops at CALL_TALLIES_MAX tallies (ended calls leave theirs until they go quiet): a new call is dropped, one counted goes on', () => {
    const time = clock();
    const channel = createCallChannel({ now: time.now });
    expect(channel.countSignal(ALICE_TABLET, 'bob-tablet', ring())).toBe(true);
    expect(channel.countSignal(BOB_TABLET, 'alice-tablet', accept())).toBe(true);
    // Ring and end, over and over: each call is closed at once, and leaves the tallies of both its ends behind.
    for (let n = 0; n < (CALL_TALLIES_MAX - 2) / 2; n += 1) {
      expect(channel.countSignal(ALICE_PHONE, 'bob-phone', ring(callId(n)))).toBe(true);
      expect(channel.countSignal(BOB_PHONE, 'alice-phone', end(callId(n)))).toBe(true);
    }
    expect(channel.held).toMatchObject({ admittedCalls: 1, tallies: CALL_TALLIES_MAX });
    const late = { deviceId: 'late', userId: 'late' };
    expect(channel.countSignal(late, 'bob-phone', ring(callId(CALL_TALLIES_MAX)))).toBe(false);
    expect(channel.held).toMatchObject({ admittedCalls: 1, tallies: CALL_TALLIES_MAX });
    expect(channel.countSignal(ALICE_TABLET, 'bob-tablet', offer())).toBe(true);
    expect(channel.countSignal(BOB_TABLET, 'alice-tablet', answer())).toBe(true);
    // Quiet, the old tallies go, and new calls get in again.
    time.advance(CALL_TALLY_IDLE_MS);
    expect(channel.countSignal(late, 'bob-phone', ring(callId(CALL_TALLIES_MAX)))).toBe(true);
    expect(channel.held).toMatchObject({ admittedCalls: 1, tallies: 1 });
  });

  it('remembers only allowed rings, within a ceiling, and a ring it cannot remember is still judged', () => {
    const channel = createCallChannel();
    // Refused rings (alice is over her caps after a few) are never kept.
    for (let n = 0; n < 100; n += 1) channel.countRing('alice', 'bob', callId(n));
    expect(channel.held.ringVerdicts).toBe(CALL_RING_PAIR_LIMIT);
    for (let n = 0; n < CALL_RING_VERDICTS_MAX; n += 1) {
      expect(channel.countRing(`person-${n}`, 'bob', callId(n)).ok).toBe(true);
    }
    expect(channel.held.ringVerdicts).toBe(CALL_RING_VERDICTS_MAX);
    // Not remembered, so each ring of this call counts again: its pair cap is spent after a few devices.
    const unremembered = callId(CALL_RING_VERDICTS_MAX + 1);
    for (let n = 0; n < CALL_RING_PAIR_LIMIT; n += 1) expect(channel.countRing('carol', 'bob', unremembered).ok).toBe(true);
    expect(channel.countRing('carol', 'bob', unremembered).ok).toBe(false);
    expect(channel.held.ringVerdicts).toBe(CALL_RING_VERDICTS_MAX);
  });

  it('serialises the event whether the target listens or not: offline costs the same work as online', () => {
    const channel = createCallChannel();
    const unserialisable = { ...event(), signal: { type: 'call:ring', callId: CALL_ID, big: 1n } } as unknown as CallStreamSignal;
    expect(() => channel.deliver('nobody', unserialisable)).toThrow(TypeError);
  });
});
