/**
 * The 1:1 audio call engine (ADR-211, step Д2a) with every port faked except the tag logic, which is the worker's
 * own (`call-engine-support.ts`). One engine per test, the server and the other side played by the test.
 *
 * The rules under test, in the order of the module header: no audio before the check; one fingerprint per SDP;
 * reflection fails at once; own epoch only, bounded retries; relay-only means relay-only; TURN renewed, and the live
 * path moved onto each fresh set by an ICE restart the caller alone offers; busy is invisible; honest ends; nothing
 * from the server trusted for shape or side.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  advance,
  advanceInSteps,
  ALICE,
  BOB,
  CALL,
  CALL_2,
  CERT_B,
  callerToOffer,
  callerToTags,
  calleeToTags,
  CAROL,
  CONV,
  DEV_A,
  DEV_B,
  fakeRoom,
  FP_A,
  FP_B,
  FP_M,
  HOST,
  ICE_ALL,
  ICE_RELAY,
  ICE_RELAY_NONE,
  ICE_TTL_MS,
  peerTag,
  RELAY,
  RELAY_SCRUBBED,
  RING_UNTIL,
  sdpWith,
  settle,
  setup,
  SRFLX,
  T0,
  turnServer,
  UFRAG,
  type SdpShape,
} from './call-engine-support.js';
import { CALL_LIMITS } from '@masia/contracts/wire';
import { AUDIO_CALL_ENGINE_LIMITS as L, CALL_CONTROL_CHANNEL, type CallIceAnswer } from '../index.js';
import { boundFingerprint, certificateFingerprint, sdpIceUfrag, sdpLayout } from '../index.js';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
});

const ring = (callId = CALL) => ({
  callId,
  conversationId: CONV,
  callerUserId: ALICE,
  callerDeviceId: DEV_A,
  ringUntil: RING_UNTIL,
});

/** Every value `track.enabled` is set to from now on, in order. */
function enabledLog(track: { enabled: boolean }): boolean[] {
  const log: boolean[] = [];
  let value = track.enabled;
  Object.defineProperty(track, 'enabled', {
    get: () => value,
    set: (next: boolean) => {
      value = next;
      log.push(next);
    },
  });
  return log;
}

describe('a call that works: caller side', () => {
  it('call → ack → accept → offer → answer → tags → verified → connected → hang up', async () => {
    const h = setup();
    expect(await h.engine.call(CONV)).toEqual({ ok: true });
    expect(h.socket.of('call:invite')).toEqual([
      { type: 'call:invite', payload: { requestId: 'request-1', conversationId: CONV, deviceId: DEV_A } },
    ]);
    expect(h.state().name).toBe('inviting');

    h.socket.server('call:invite', { requestId: 'request-1', callId: CALL, ringUntil: RING_UNTIL });
    await settle();
    expect(h.state().name).toBe('outgoing');
    expect(h.ice).not.toHaveBeenCalled(); // the route has nothing for a call that rings
    expect(h.peers).toHaveLength(0); // no media before the callee answers

    h.socket.server('call:accept', { callId: CALL, callerDeviceId: DEV_A, calleeDeviceId: DEV_B });
    await settle();
    expect(h.ice.mock.calls).toEqual([[CALL]]);
    expect(h.state()).toMatchObject({ name: 'connecting', role: 'caller', peerDeviceId: DEV_B });
    expect(h.peer().config).toEqual({ iceServers: ICE_ALL.iceServers, iceTransportPolicy: 'all', control: CALL_CONTROL_CHANNEL });
    expect(h.peer().added).toEqual([h.micTrack]);
    const offers = h.socket.of('call:ice').filter((e) => e.payload.signal.kind === 'offer');
    expect(offers).toHaveLength(1);

    h.socket.server('call:ice', { callId: CALL, signal: { kind: 'answer', sdp: sdpWith(FP_B) } });
    await settle();
    expect(h.peer().remoteSdp).toBe(sdpWith(FP_B));
    expect(h.socket.of('call:verify')).toHaveLength(1);
    expect(h.state().name).toBe('connecting');

    const track = h.peer().emitTrack();
    h.socket.server('call:verify', { callId: CALL, tag: await peerTag(h.room, 'callee') });
    await settle();
    expect(h.state().name).toBe('verified');
    expect(track.enabled).toBe(true);
    expect(h.speaker.attach).toHaveBeenCalledTimes(1);
    expect(h.snap().live).toBe(false); // verified, but the media path is not up yet

    h.peer().connect();
    await settle();
    expect(h.snap()).toMatchObject({ live: true, media: 'connected', problem: null });

    h.engine.hangUp();
    expect(h.socket.of('call:end')).toEqual([{ type: 'call:end', payload: { callId: CALL, reason: 'hangup' } }]);
    expect(h.state()).toMatchObject({ name: 'ended', reason: 'hangup' });
    expect(h.peer().closed).toBe(true);
    expect(h.micTrack.stopped).toBe(true);
    expect(h.speaker.detach).toHaveBeenCalled();
    expect(h.snap().live).toBe(false);
    h.engine.dismiss();
    expect(h.state().name).toBe('idle');
  });
});

describe('a call that works: callee side', () => {
  it('ring → answer (mic) → accept → offer → answer out → tags → verified', async () => {
    const h = setup({ self: 'callee' });
    h.socket.server('call:ring', ring());
    expect(h.state().name).toBe('incoming');
    expect(h.microphone).not.toHaveBeenCalled(); // a ring asks for nothing

    expect(await h.engine.answer()).toEqual({ ok: true });
    expect(h.socket.of('call:accept')).toEqual([{ type: 'call:accept', payload: { callId: CALL, deviceId: DEV_B } }]);
    expect(h.ice).not.toHaveBeenCalled(); // «Answer» is not yet an answered call: the server decides
    h.socket.server('call:accept', { callId: CALL, callerDeviceId: DEV_A, calleeDeviceId: DEV_B });
    await settle();
    expect(h.ice.mock.calls).toEqual([[CALL]]);
    h.socket.server('call:ice', { callId: CALL, signal: { kind: 'offer', sdp: sdpWith(FP_A) } });
    await settle();
    expect(h.peer().remoteSdp).toBe(sdpWith(FP_A));
    expect(h.socket.of('call:ice').map((e) => e.payload.signal.kind)).toEqual(['answer']);
    expect(h.socket.of('call:verify')).toHaveLength(1);

    h.socket.server('call:verify', { callId: CALL, tag: await peerTag(h.room, 'caller') });
    await settle();
    expect(h.state().name).toBe('verified');
  });
});

describe('no audio before the check (decision 4)', () => {
  it('the remote track stays muted and attached to nothing while the check is pending — even with media up', async () => {
    const h = setup();
    await callerToTags(h);
    const track = h.peer().emitTrack();
    h.peer().connect();
    await advance(L.verifyWindowMs - 1_000);
    expect(h.state().name).toBe('connecting');
    expect(track.enabled).toBe(false);
    expect(h.speaker.attach).not.toHaveBeenCalled();
    expect(h.snap().live).toBe(false);

    h.socket.server('call:verify', { callId: CALL, tag: await peerTag(h.room, 'callee') });
    await settle();
    expect(track.enabled).toBe(true);
    expect(h.speaker.attach).toHaveBeenCalledTimes(1);
  });

  it('a track that arrives after the check plays at once; before it, it is held', async () => {
    const h = setup();
    await callerToTags(h);
    h.socket.server('call:verify', { callId: CALL, tag: await peerTag(h.room, 'callee') });
    await settle();
    expect(h.state().name).toBe('verified');
    expect(h.speaker.attach).not.toHaveBeenCalled(); // nothing to play yet
    const track = h.peer().emitTrack();
    await settle();
    expect(track.enabled).toBe(true);
    expect(h.speaker.attach).toHaveBeenCalledTimes(1);
  });

  it('our microphone is off from the moment the peer gets it until the check passes — caller', async () => {
    const h = setup();
    await callerToTags(h);
    expect(h.peer().addedEnabled).toEqual([false]);
    h.peer().emitTrack();
    h.peer().connect();
    await settle();
    expect(h.state().name).toBe('connecting');
    expect(h.micTrack.enabled).toBe(false);
    h.socket.server('call:verify', { callId: CALL, tag: await peerTag(h.room, 'callee') });
    await settle();
    expect(h.state().name).toBe('verified');
    expect(h.micTrack.enabled).toBe(true);
  });

  it('our microphone is off until the check passes — callee: answering does not open it to whoever is on the line', async () => {
    const h = setup({ self: 'callee' });
    await calleeToTags(h);
    expect(h.peer().addedEnabled).toEqual([false]);
    expect(h.micTrack.enabled).toBe(false);
    h.socket.server('call:verify', { callId: CALL, tag: await peerTag(h.room, 'caller') });
    await settle();
    expect(h.state().name).toBe('verified');
    expect(h.micTrack.enabled).toBe(true);
  });

  it('a call that never verifies never turned our microphone on', async () => {
    const h = setup();
    const log = enabledLog(h.micTrack);
    await callerToTags(h, sdpWith(FP_M)); // a fingerprint swapped in the middle: the check cannot pass
    h.peer().connect();
    h.socket.server('call:verify', { callId: CALL, tag: await peerTag(h.room, 'callee') });
    await settle();
    await advance(L.verifyWindowMs);
    expect(h.state()).toMatchObject({ name: 'ended', reason: 'verify-failed' });
    expect(log).not.toContain(true);
  });

  it('a tag that never comes is a failure after the window, never "verified" — and nothing was played', async () => {
    const h = setup();
    await callerToTags(h);
    const track = h.peer().emitTrack();
    h.peer().connect();
    await advance(L.verifyWindowMs);
    expect(h.state()).toMatchObject({ name: 'ended', reason: 'verify-failed' });
    expect(h.snap().problem).toBe('cannot-verify');
    expect(h.socket.of('call:end')).toEqual([{ type: 'call:end', payload: { callId: CALL, reason: 'verify-failed' } }]);
    expect(track.enabled).toBe(false);
    expect(h.speaker.attach).not.toHaveBeenCalled();
  });
});

describe('the fingerprint the tag binds (decision 4, review addition 1)', () => {
  it('a fingerprint swapped by the signalling path: the call never starts and nothing is played', async () => {
    const h = setup();
    // The server rewrote the callee's fingerprint in the answer; the callee's tag binds the real one.
    await callerToTags(h, sdpWith(FP_M));
    const track = h.peer().emitTrack();
    h.peer().connect();
    h.socket.server('call:verify', { callId: CALL, tag: await peerTag(h.room, 'callee') });
    await settle();
    for (let i = 1; i <= L.verifyRetries; i += 1) await advance(L.verifyRetryStepMs * i);
    expect(h.state()).toMatchObject({ name: 'ended', reason: 'verify-failed' });
    expect(h.snap().problem).toBe('cannot-verify');
    expect(track.enabled).toBe(false);
    expect(h.speaker.attach).not.toHaveBeenCalled();
    expect(h.binding.verify.mock.calls.length).toBeLessThanOrEqual(1 + L.verifyRetries);
  });

  it('a remote SDP with two distinct fingerprints is refused before the browser sees it', async () => {
    const h = setup();
    await callerToTags(h, sdpWith([FP_B, FP_M]));
    expect(h.peer().remoteSdp).toBeNull();
    expect(h.state()).toMatchObject({ name: 'ended', reason: 'verify-failed' });
    expect(h.socket.of('call:verify')).toEqual([]);
  });

  it('a remote SDP with no fingerprint is refused too', async () => {
    const h = setup({ self: 'callee' });
    await calleeToTags(h, sdpWith([]));
    expect(h.peer().remoteSdp).toBeNull();
    expect(h.state()).toMatchObject({ name: 'ended', reason: 'verify-failed' });
  });

  it('our own SDP with two distinct fingerprints is never sent', async () => {
    const h = setup({ localFingerprints: [FP_A, FP_M] });
    await callerToOffer(h);
    expect(h.socket.of('call:ice')).toEqual([]);
    expect(h.state()).toMatchObject({ name: 'ended', reason: 'verify-failed' });
  });

  it('where the browser names the certificate DTLS accepted, it must hash to the bound fingerprint', async () => {
    const der = new Uint8Array([48, 1, 2, 3]).buffer;
    const real = await certificateFingerprint(der, 'SHA-256');
    const h = setup();
    await callerToTags(h, sdpWith(real));
    h.peer().certs = [];
    const track = h.peer().emitTrack();
    h.socket.server('call:verify', { callId: CALL, tag: await peerTag(h.room, 'callee', { fingerprintCallee: real }) });
    await settle();
    // the tag checked out, but DTLS is not up yet: the certificate is not known — still held
    expect(h.state().name).toBe('connecting');
    expect(track.enabled).toBe(false);
    h.peer().certs = [der];
    h.peer().connect();
    await settle();
    expect(h.state().name).toBe('verified');
    expect(track.enabled).toBe(true);
  });

  // Review of step Д2a (low): the engine read the fingerprint from the text it handed the browser; what DTLS enforces
  // is what the browser parsed. Read back from the description the browser applied, it must be the same one value.
  describe('the fingerprint, read back from the description the browser applied, is the one the tag binds', () => {
    it('caller: the browser applied an answer whose fingerprint differs — ended before our tag goes out', async () => {
      const h = setup();
      await callerToOffer(h);
      h.peer().applied = sdpWith(FP_M);
      h.socket.server('call:ice', { callId: CALL, signal: { kind: 'answer', sdp: sdpWith(FP_B) } });
      await settle();
      expect(h.state()).toMatchObject({ name: 'ended', reason: 'verify-failed' });
      expect(h.socket.of('call:verify')).toEqual([]);
    });

    it('callee: the browser applied an offer whose fingerprint differs — no answer and no tag go out', async () => {
      const h = setup({ self: 'callee' });
      h.socket.server('call:ring', ring());
      await h.engine.answer();
      h.socket.server('call:accept', { callId: CALL, callerDeviceId: DEV_A, calleeDeviceId: DEV_B });
      await settle();
      h.peer().applied = sdpWith(FP_M); // the peer exists once the call is accepted
      h.socket.server('call:ice', { callId: CALL, signal: { kind: 'offer', sdp: sdpWith(FP_A) } });
      await settle();
      expect(h.state()).toMatchObject({ name: 'ended', reason: 'verify-failed' });
      expect(h.socket.of('call:ice')).toEqual([]);
      expect(h.socket.of('call:verify')).toEqual([]);
    });

    it('a description the browser does not show, or one that binds no single fingerprint, is refused too', async () => {
      for (const applied of [null, sdpWith([FP_B, FP_M]), sdpWith(FP_B, [], { bundle: null })]) {
        const h = setup();
        await callerToOffer(h);
        h.peer().applied = applied;
        h.socket.server('call:ice', { callId: CALL, signal: { kind: 'answer', sdp: sdpWith(FP_B) } });
        await settle();
        expect(h.state()).toMatchObject({ name: 'ended', reason: 'verify-failed' });
        expect(h.socket.of('call:verify')).toEqual([]);
      }
    });

    it('the same value, as the browser re-spells it, is the same value', async () => {
      const h = setup();
      await callerToOffer(h);
      h.peer().applied = sdpWith(`sha-256 ${FP_B.split(' ')[1]!.toLowerCase()}`);
      h.socket.server('call:ice', { callId: CALL, signal: { kind: 'answer', sdp: sdpWith(FP_B) } });
      await settle();
      expect(h.state().name).toBe('connecting');
      expect(h.socket.of('call:verify')).toHaveLength(1);
    });
  });

  // Review of step Д2a (low): a browser that names certificates and has none once DTLS is up has not said "I cannot
  // tell" — it has not said yet. The call waits for the certificate, and never verifies without it.
  it('connected with no certificate yet is not "cannot tell": held until the certificate shows, then checked', async () => {
    const der = new Uint8Array([48, 1, 2, 3]).buffer;
    const real = await certificateFingerprint(der, 'SHA-256');
    const h = setup();
    await callerToTags(h, sdpWith(real));
    h.peer().certs = [];
    const track = h.peer().emitTrack();
    h.socket.server('call:verify', { callId: CALL, tag: await peerTag(h.room, 'callee', { fingerprintCallee: real }) });
    h.peer().connect();
    await settle();
    expect(h.state().name).toBe('connecting');
    expect(track.enabled).toBe(false);
    h.peer().certs = [der]; // no state event: the engine looks again by itself
    await advance(L.certificatePollMs);
    expect(h.state().name).toBe('verified');
    expect(track.enabled).toBe(true);
  });

  it('…and a certificate that never shows ends the call at the connect deadline, nothing played or sent', async () => {
    const h = setup();
    await callerToTags(h);
    h.peer().certs = [];
    const track = h.peer().emitTrack();
    const mic = enabledLog(h.micTrack);
    h.socket.server('call:verify', { callId: CALL, tag: await peerTag(h.room, 'callee') });
    h.peer().connect();
    await settle(); // the tag checks out first: what ends this call is the missing certificate, not the tag
    expect(h.state().name).toBe('connecting');
    await advance(L.connectMs - 1);
    expect(h.state().name).toBe('connecting');
    await advance(1);
    expect(h.state()).toMatchObject({ name: 'ended', reason: 'verify-failed' });
    expect(track.enabled).toBe(false);
    expect(h.speaker.attach).not.toHaveBeenCalled();
    expect(mic).not.toContain(true);
  });

  it('a certificate in use other than the bound fingerprint fails the call, though the tag was right', async () => {
    const h = setup();
    await callerToTags(h);
    h.peer().certs = [new Uint8Array([9, 9, 9]).buffer]; // DTLS accepted something that is not FP_B
    const track = h.peer().emitTrack();
    h.socket.server('call:verify', { callId: CALL, tag: await peerTag(h.room, 'callee') });
    h.peer().connect();
    await settle();
    expect(h.state()).toMatchObject({ name: 'ended', reason: 'verify-failed' });
    expect(track.enabled).toBe(false);
    expect(h.speaker.attach).not.toHaveBeenCalled();
  });
});

describe('reflection and the peer\'s identity (decision 4)', () => {
  it('our own tag bounced back fails at once — no retries, nothing played', async () => {
    const h = setup();
    await callerToTags(h);
    const ours = h.socket.of('call:verify')[0]!.payload.tag;
    h.peer().emitTrack();
    h.socket.server('call:verify', { callId: CALL, tag: ours });
    expect(h.state()).toMatchObject({ name: 'ended', reason: 'verify-failed' });
    expect(h.binding.verify).not.toHaveBeenCalled();
    expect(h.speaker.attach).not.toHaveBeenCalled();
  });

  it('the server naming another device as us at accept: verify-failed, no media set up', async () => {
    const h = setup();
    await h.engine.call(CONV);
    h.socket.server('call:invite', { requestId: 'request-1', callId: CALL, ringUntil: RING_UNTIL });
    await settle();
    h.socket.server('call:accept', { callId: CALL, callerDeviceId: 'dev-a-other', calleeDeviceId: DEV_B });
    await settle();
    expect(h.state()).toMatchObject({ name: 'ended', reason: 'verify-failed' });
    expect(h.peers).toHaveLength(0);
  });

  it('a tag from another device of the callee (the server swapped who answered) fails', async () => {
    const room = fakeRoom({ extra: [{ userId: BOB, deviceId: 'dev-b2', role: 'USER' }] });
    const h = setup({ room });
    await callerToTags(h);
    // the right K, from a real member device — but not the one the server told us accepted
    const other = await peerTag(h.room, 'callee', { calleeDeviceId: 'dev-b2' });
    h.socket.server('call:verify', { callId: CALL, tag: other });
    await settle();
    for (let i = 1; i <= L.verifyRetries; i += 1) await advance(L.verifyRetryStepMs * i);
    expect(h.state()).toMatchObject({ name: 'ended', reason: 'verify-failed' });
  });

  it('a flood of peer tags is bounded', async () => {
    const h = setup();
    await callerToTags(h);
    for (let i = 0; i < L.peerTagsMax + 1; i += 1) {
      h.socket.server('call:verify', { callId: CALL, tag: `${'Z'.repeat(42)}${String.fromCharCode(65 + i)}` });
    }
    await settle();
    expect(h.state()).toMatchObject({ name: 'ended', reason: 'verify-failed' });
  });
});

describe('own epoch only: bounded retries (decision 4)', () => {
  it('this side is one epoch behind: it catches up, sends a new tag, and verifies', async () => {
    const room = fakeRoom({ epochs: { [DEV_A]: 2, [DEV_B]: 1 } });
    const h = setup({ self: 'callee', room });
    await calleeToTags(h);
    const callerTag = await peerTag(room, 'caller'); // epoch 2
    h.socket.server('call:verify', { callId: CALL, tag: callerTag });
    await settle();
    expect(h.state().name).toBe('connecting'); // epoch 1 here: no match yet
    await advance(L.verifyRetryStepMs);
    expect(h.binding.tag).toHaveBeenLastCalledWith(expect.objectContaining({ fresh: true }));
    const tags = h.socket.of('call:verify').map((e) => e.payload.tag);
    expect(tags).toHaveLength(2); // the epoch-2 tag went out for the caller
    expect(tags[0]).not.toBe(tags[1]);
    expect(h.state().name).toBe('verified');
  });

  it('the other side catches up later: its new tag is checked when it comes', async () => {
    const room = fakeRoom({ epochs: { [DEV_A]: 2, [DEV_B]: 1 } });
    const h = setup({ room });
    await callerToTags(h);
    h.socket.server('call:verify', { callId: CALL, tag: await peerTag(room, 'callee') }); // epoch 1
    await settle();
    expect(h.state().name).toBe('connecting');
    room.epochs[DEV_B] = 2;
    h.socket.server('call:verify', { callId: CALL, tag: await peerTag(room, 'callee') }); // epoch 2
    await advance(L.verifyRetryStepMs);
    expect(h.state().name).toBe('verified');
  });

  it('two sides that never meet: at most 3 retries within 10 s, then "cannot verify"', async () => {
    const room = fakeRoom({ epochs: { [DEV_A]: 3, [DEV_B]: 1 } });
    const h = setup({ room });
    await callerToTags(h);
    h.socket.server('call:verify', { callId: CALL, tag: await peerTag(room, 'callee') });
    await settle();
    for (let i = 1; i <= L.verifyRetries; i += 1) await advance(L.verifyRetryStepMs * i);
    expect(vi.getMockedSystemTime()!.valueOf() - T0).toBeLessThanOrEqual(L.verifyWindowMs);
    expect(h.state()).toMatchObject({ name: 'ended', reason: 'verify-failed' });
    expect(h.snap().problem).toBe('cannot-verify');
    expect(h.binding.verify).toHaveBeenCalledTimes(1 + L.verifyRetries);
    expect(h.binding.tag.mock.calls.filter(([r]) => r.fresh === true)).toHaveLength(L.verifyRetries);
  });
});

describe('relay-only means relay-only (decision 6, review addition 2)', () => {
  it('the peer gets the relay policy; non-relay candidates never leave, the relay ones go without our address', async () => {
    const h = setup({ ice: ICE_RELAY, localCandidates: [HOST, SRFLX, RELAY] });
    await callerToOffer(h);
    expect(h.peer().config.iceTransportPolicy).toBe('relay');
    const offer = h.socket.of('call:ice')[0]!.payload.signal;
    expect(offer.kind).toBe('offer');
    const sdp = offer.kind === 'offer' ? offer.sdp : '';
    expect(sdp).not.toContain('typ host');
    expect(sdp).not.toContain('typ srflx');
    expect(sdp).not.toContain('203.0.113.7');
    expect(sdp).toContain(`a=${RELAY_SCRUBBED}`);

    h.peer().emitCandidate(HOST);
    h.peer().emitCandidate(SRFLX);
    h.peer().emitCandidate(RELAY);
    const trickled = h.socket.of('call:ice').slice(1).map((e) => e.payload.signal);
    expect(trickled).toEqual([{ kind: 'candidate', candidate: RELAY_SCRUBBED, sdpMid: '0', sdpMLineIndex: 0 }]);
  });

  it('non-relay candidates from the peer never reach the browser — trickled or inside its SDP', async () => {
    const h = setup({ ice: ICE_RELAY });
    await callerToOffer(h);
    // before the answer: held; after: applied — host and srflx dropped either way
    h.socket.server('call:ice', { callId: CALL, signal: { kind: 'candidate', candidate: HOST, sdpMid: '0', sdpMLineIndex: 0 } });
    h.socket.server('call:ice', { callId: CALL, signal: { kind: 'answer', sdp: sdpWith(FP_B, [HOST, RELAY]) } });
    h.socket.server('call:ice', { callId: CALL, signal: { kind: 'candidate', candidate: SRFLX, sdpMid: '0', sdpMLineIndex: 0 } });
    h.socket.server('call:ice', { callId: CALL, signal: { kind: 'candidate', candidate: RELAY, sdpMid: '0', sdpMLineIndex: 0 } });
    await settle();
    expect(h.peer().remoteSdp).not.toContain('typ host');
    expect(h.peer().remoteSdp).toContain(`a=${RELAY_SCRUBBED}`);
    expect(h.peer().candidates).toEqual([{ candidate: RELAY_SCRUBBED, sdpMid: '0', sdpMLineIndex: 0 }]);
  });

  it('same family ("all"): candidates pass as they are', async () => {
    const h = setup({ ice: ICE_ALL, localCandidates: [HOST] });
    await callerToOffer(h);
    h.peer().emitCandidate(HOST);
    expect(h.socket.of('call:ice').map((e) => e.payload.signal.kind)).toEqual(['offer', 'candidate']);
    h.socket.server('call:ice', { callId: CALL, signal: { kind: 'answer', sdp: sdpWith(FP_B) } });
    h.socket.server('call:ice', { callId: CALL, signal: { kind: 'candidate', candidate: HOST, sdpMid: '0', sdpMLineIndex: 0 } });
    await settle();
    expect(h.peer().candidates).toHaveLength(1);
  });

  it('a relay-only call with no TURN to use ends right after the accept, honestly, with no peer made', async () => {
    // The route answers PENDING while the call rings, so «no TURN» is known only once the call is answered.
    const h = setup({ ice: ICE_RELAY_NONE });
    await callerToOffer(h);
    expect(h.state()).toMatchObject({ name: 'ended', reason: 'connect-failed' });
    expect(h.snap().problem).toBe('relay-unavailable');
    expect(h.socket.of('call:end')).toEqual([{ type: 'call:end', payload: { callId: CALL, reason: 'connect-failed' } }]);
    expect(h.peers).toHaveLength(0);
    expect(h.ice).toHaveBeenCalledTimes(1); // a final answer: not asked again
  });

  it('a provider failure is final too: relay-unavailable after one question, never retried', async () => {
    const h = setup({ ice: { status: 'PROVIDER_ERROR', iceServers: [], iceTransportPolicy: 'relay' } });
    await callerToOffer(h);
    expect(h.state()).toMatchObject({ name: 'ended', reason: 'connect-failed' });
    expect(h.snap().problem).toBe('relay-unavailable');
    await advance(L.connectMs);
    expect(h.ice).toHaveBeenCalledTimes(1);
    expect(h.peers).toHaveLength(0);
  });

  it('…and on the callee\'s side, the same answer ends it after the accept with no peer made', async () => {
    const h = setup({ self: 'callee', ice: ICE_RELAY_NONE });
    await calleeToTags(h);
    expect(h.state()).toMatchObject({ name: 'ended', reason: 'connect-failed' });
    expect(h.snap().problem).toBe('relay-unavailable');
    expect(h.peers).toHaveLength(0);
  });

  it('an unreadable ICE answer is not "direct": the call does not connect', async () => {
    const h = setup({ self: 'callee', ice: () => Promise.reject(new Error('503')) });
    await calleeToTags(h);
    expect(h.state()).toMatchObject({ name: 'ended', reason: 'connect-failed' });
    expect(h.snap().problem).toBe('cannot-connect');
    expect(h.peers).toHaveLength(0);
  });
});

// Docs pass, 2026-11-15: the route answers PENDING (no servers) until the server's record says `accepted`. The engine
// asked at the invite's ack and at «Answer», both while the call still rang, read PENDING as a failure, and never
// asked again — so no call placed from the first host could connect against the real server.
describe('TURN only for an answered call (ADR-211 amendment 3)', () => {
  const statuses = (turn: ReturnType<typeof turnServer>) => turn.answers.map((a) => a.status);

  it('caller: nothing is asked while it rings; the server\'s accept asks, once', async () => {
    const turn = turnServer();
    const h = setup({ ice: turn.answer });
    await h.engine.call(CONV);
    h.socket.server('call:invite', { requestId: 'request-1', callId: CALL, ringUntil: RING_UNTIL });
    await advance(10_000); // it rings on the other side
    expect(h.ice).not.toHaveBeenCalled();
    turn.accept();
    h.socket.server('call:accept', { callId: CALL, callerDeviceId: DEV_A, calleeDeviceId: DEV_B });
    await settle();
    expect(h.ice.mock.calls).toEqual([[CALL]]);
    expect(statuses(turn)).toEqual(['OK']);
    expect(h.peer().config.iceServers).toEqual(turn.answers[0]!.iceServers);
    expect(h.socket.of('call:ice').map((e) => e.payload.signal.kind)).toEqual(['offer']);
  });

  it('callee: «Answer» asks nothing; the server confirming this device\'s accept asks', async () => {
    const turn = turnServer();
    const h = setup({ self: 'callee', ice: turn.answer });
    h.socket.server('call:ring', ring());
    expect(await h.engine.answer()).toEqual({ ok: true });
    await settle();
    expect(h.state().name).toBe('accepting');
    expect(h.ice).not.toHaveBeenCalled();
    turn.accept();
    h.socket.server('call:accept', { callId: CALL, callerDeviceId: DEV_A, calleeDeviceId: DEV_B });
    await settle();
    expect(h.ice.mock.calls).toEqual([[CALL]]);
    expect(statuses(turn)).toEqual(['OK']);
    expect(h.peer().config.iceServers).toEqual(turn.answers[0]!.iceServers);
  });

  it('callee: an «Answer» that loses to another device asks nothing at all', async () => {
    const h = setup({ self: 'callee' });
    h.socket.server('call:ring', ring());
    await h.engine.answer();
    h.socket.server('call:end', { callId: CALL, reason: 'answered-elsewhere' });
    await advance(L.connectMs);
    expect(h.state()).toMatchObject({ name: 'ended', reason: 'answered-elsewhere' });
    expect(h.ice).not.toHaveBeenCalled();
  });

  it('a PENDING that still comes after the accept is asked again, backing off, and the call goes on', async () => {
    const turn = turnServer();
    const h = setup({ ice: turn.answer });
    await h.engine.call(CONV);
    h.socket.server('call:invite', { requestId: 'request-1', callId: CALL, ringUntil: RING_UNTIL });
    await settle();
    // The accept event outran the record the route reads (a race): PENDING, not yet the set.
    h.socket.server('call:accept', { callId: CALL, callerDeviceId: DEV_A, calleeDeviceId: DEV_B });
    await settle();
    expect(statuses(turn)).toEqual(['PENDING']);
    expect(h.state().name).toBe('connecting'); // not a failure
    expect(h.peers).toHaveLength(0);
    await advance(L.icePendingRetryMs);
    expect(statuses(turn)).toEqual(['PENDING', 'PENDING']);
    turn.accept();
    await advance(L.icePendingRetryMs * 2 - 1);
    expect(h.ice).toHaveBeenCalledTimes(2); // backing off: the second wait is twice the first
    await advance(1);
    expect(statuses(turn)).toEqual(['PENDING', 'PENDING', 'OK']);
    expect(h.peer().config.iceServers).toEqual(turn.answers[2]!.iceServers);
    expect(h.socket.of('call:ice').map((e) => e.payload.signal.kind)).toEqual(['offer']);
    expect(h.socket.of('call:end')).toEqual([]);
  });

  it('PENDING until the connect deadline: connect-failed, as any call that never connects, and the asking stops', async () => {
    const turn = turnServer(); // the server never records the accept
    const h = setup({ ice: turn.answer });
    await h.engine.call(CONV);
    h.socket.server('call:invite', { requestId: 'request-1', callId: CALL, ringUntil: RING_UNTIL });
    await settle();
    h.socket.server('call:accept', { callId: CALL, callerDeviceId: DEV_A, calleeDeviceId: DEV_B });
    await settle();
    await advanceInSteps(L.connectMs - 1, L.icePendingRetryMs);
    expect(h.state().name).toBe('connecting'); // PENDING alone never ends a call
    await advance(1);
    expect(h.state()).toMatchObject({ name: 'ended', reason: 'connect-failed' });
    expect(h.snap().problem).toBe('cannot-connect');
    expect(h.socket.of('call:end')).toEqual([{ type: 'call:end', payload: { callId: CALL, reason: 'connect-failed' } }]);
    expect(h.peers).toHaveLength(0);
    // Every wait doubles up to its cap, so the questions within the deadline are few and known.
    let asks = 1;
    for (let n = 0, waited = 0; ; n += 1) {
      waited += Math.min(L.icePendingRetryMs * 2 ** n, L.icePendingRetryMaxMs);
      if (waited >= L.connectMs) break;
      asks += 1;
    }
    expect(h.ice).toHaveBeenCalledTimes(asks);
    expect(vi.getTimerCount()).toBe(0);
    await advance(10 * 60_000);
    expect(h.ice).toHaveBeenCalledTimes(asks);
  });
});

/** The callee's browser as a test plays it once the call is up: it answers each ICE restart offer the caller sends. */
interface PlayedCallee {
  /** Its answers reach the caller (false: lost on the way, or never written). */
  answers: boolean;
  /** The certificate its answers name. */
  fingerprint: string;
  /** The candidates its answers carry. */
  candidates: string[];
  /** How its answers are laid out beyond that (restart n answers under the ufrag `callee-<n>` unless this says). */
  shape: SdpShape;
  /** The restart offers it heard, in order. */
  readonly offers: string[];
}

/**
 * Caller: a verified, connected call over the server's first set — the callee's browser played by `callee`, which
 * answers every ICE restart offer as a browser does (new ICE credentials, the same certificate and m-lines).
 */
async function liveCall(
  turn: ReturnType<typeof turnServer>,
  o: { readonly answer?: () => Promise<CallIceAnswer>; readonly localCandidates?: readonly string[] } = {},
) {
  const h = setup({ ice: o.answer ?? turn.answer, localCandidates: o.localCandidates ?? [] });
  await h.engine.call(CONV);
  h.socket.server('call:invite', { requestId: 'request-1', callId: CALL, ringUntil: RING_UNTIL });
  await settle();
  turn.accept();
  h.socket.server('call:accept', { callId: CALL, callerDeviceId: DEV_A, calleeDeviceId: DEV_B });
  await settle();
  h.socket.server('call:ice', { callId: CALL, signal: { kind: 'answer', sdp: sdpWith(FP_B) } });
  await settle();
  h.socket.server('call:verify', { callId: CALL, tag: await peerTag(h.room, 'callee') });
  h.peer().connect();
  await settle();
  expect(h.snap().live).toBe(true);
  expect(turn.minted).toHaveLength(1);
  const callee: PlayedCallee = { answers: true, fingerprint: FP_B, candidates: [], shape: {}, offers: [] };
  h.socket.state.onSend = (event) => {
    if (event.type !== 'call:ice') return;
    const signal = event.payload.signal;
    if (signal.kind !== 'offer') return;
    callee.offers.push(signal.sdp);
    if (!callee.answers) return;
    const shape = { ufrag: `callee-${callee.offers.length}`, ...callee.shape };
    h.socket.server('call:ice', { callId: CALL, signal: { kind: 'answer', sdp: sdpWith(callee.fingerprint, callee.candidates, shape) } });
  };
  return Object.assign(h, { callee });
}

/** Every offer SDP the engine sent, in order: the call's first, then each restart's. */
const offersSent = (h: ReturnType<typeof setup>): string[] =>
  h.socket.of('call:ice').flatMap((e) => (e.payload.signal.kind === 'offer' ? [e.payload.signal.sdp] : []));
const answersSent = (h: ReturnType<typeof setup>): string[] =>
  h.socket.of('call:ice').flatMap((e) => (e.payload.signal.kind === 'answer' ? [e.payload.signal.sdp] : []));

/** To the moment the caller renews the set it holds (the server's set: its expiry, less the lead). */
const toRenewal = (turn: ReturnType<typeof turnServer>): Promise<void> =>
  advance(turn.minted.at(-1)!.expiresAt - L.iceRenewLeadMs - turn.serverNow());

describe('the TURN set is renewed while the call lives (ADR-211 amendment 3)', () => {
  it('asked again inside the server\'s renew window, before the set expires; the fresh set goes to the browser', async () => {
    const turn = turnServer();
    const h = await liveCall(turn);
    const first = turn.minted[0]!;
    // Before the window the server would hand the same set back: nothing is asked.
    await advance(first.expiresAt - CALL_LIMITS.turnRenewWindowMs - Date.now());
    expect(h.ice).toHaveBeenCalledTimes(1);
    await advance(CALL_LIMITS.turnRenewWindowMs - 1); // to the last millisecond of the first set
    expect(h.ice).toHaveBeenCalledTimes(2);
    expect(turn.minted).toHaveLength(2); // a fresh set, minted while the first still worked
    expect(h.peer().iceServerUpdates).toEqual([turn.answers[1]!.iceServers]);
    expect(h.snap()).toMatchObject({ live: true, problem: null });
    expect(h.socket.of('call:end')).toEqual([]);
    // …and the fresh one is renewed the same way.
    await advance(turn.minted[1]!.expiresAt - Date.now() - 1);
    expect(turn.minted).toHaveLength(3);
    expect(h.peer().iceServerUpdates).toEqual([turn.answers[1]!.iceServers, turn.answers[2]!.iceServers]);
  });

  it('a renewal that fails leaves the call as it is and is asked again later', async () => {
    const turn = turnServer();
    let failing = false;
    const h = await liveCall(turn, { answer: () => (failing ? Promise.reject(new Error('ice-servers: 429')) : turn.answer()) });
    failing = true;
    await advance(turn.minted[0]!.expiresAt - L.iceRenewLeadMs - Date.now()); // the renewal is due
    expect(h.ice).toHaveBeenCalledTimes(2);
    expect(h.snap()).toMatchObject({ live: true, problem: null });
    expect(h.state().name).toBe('verified');
    expect(h.socket.of('call:end')).toEqual([]);
    expect(h.peer().iceServerUpdates).toEqual([]);
    failing = false;
    await advance(L.iceRenewRetryMs);
    expect(h.ice).toHaveBeenCalledTimes(3);
    expect(h.peer().iceServerUpdates).toEqual([turn.answers.at(-1)!.iceServers]);
  });

  it('a server that says when, not how long: this device\'s clock 5 minutes ahead gets the kept set back, and backs off until the fresh one', async () => {
    // The server's clock reads 5 minutes less than this device's; it says `expiresAt` only (from before `expiresIn`).
    const turn = turnServer({ skewMs: -5 * 60_000, legacy: true });
    const h = await liveCall(turn);
    const first = turn.minted[0]!;
    // To the first set's last millisecond, by the server; every wait in play is at least `iceRenewMinMs`.
    await advanceInSteps(first.expiresAt - turn.serverNow() - 1, L.iceRenewMinMs);
    expect(turn.minted).toHaveLength(2); // renewed before it stopped working
    expect(h.peer().iceServerUpdates).toEqual([turn.answers.at(-1)!.iceServers]);
    // The kept set came back a few times, never in a loop: the waits double, up to the server's window.
    expect(h.ice.mock.calls.length).toBeLessThanOrEqual(1 + 6);
  });

  it('a server that says how long: the renewal is due by the device\'s own clock, however far it is from the server\'s', async () => {
    const turn = turnServer({ skewMs: -5 * 60_000 });
    const h = await liveCall(turn);
    const left = turn.answers[0]!.expiresInMs!;
    expect(left).toBe(ICE_TTL_MS);
    await advance(left - L.iceRenewLeadMs - 1);
    expect(h.ice).toHaveBeenCalledTimes(1);
    await advance(1);
    // Asked once, on time, inside the server's window by the server's own count: the fresh set at the first ask.
    expect(h.ice).toHaveBeenCalledTimes(2);
    expect(turn.minted).toHaveLength(2);
    expect(h.peer().iceServerUpdates).toEqual([turn.answers[1]!.iceServers]);
  });

  it('a set without an expiry (a direct call, no TURN configured) is never asked again', async () => {
    const h = setup({ ice: { status: 'NOT_CONFIGURED', iceServers: [], iceTransportPolicy: 'all' } });
    await callerToTags(h);
    h.socket.server('call:verify', { callId: CALL, tag: await peerTag(h.room, 'callee') });
    h.peer().connect();
    await settle();
    expect(h.snap().live).toBe(true);
    await advance(60 * 60_000);
    expect(h.ice).toHaveBeenCalledTimes(1);
  });

  it('no timer outlives the call: hung up, nothing is asked again', async () => {
    const turn = turnServer();
    const h = await liveCall(turn);
    await advance(turn.minted[0]!.expiresAt - Date.now() - 1);
    expect(h.ice).toHaveBeenCalledTimes(2); // the renewal ran, and the next one is due
    h.engine.hangUp();
    expect(h.state()).toMatchObject({ name: 'ended', reason: 'hangup' });
    expect(vi.getTimerCount()).toBe(0);
    await advance(60 * 60_000);
    expect(h.ice).toHaveBeenCalledTimes(2);
  });

  it('a renewal still on its way when the call ends touches nothing', async () => {
    const turn = turnServer();
    const held: { release?: (answer: CallIceAnswer) => void } = {};
    const h = await liveCall(turn, {
      answer: () =>
        turn.answers.length === 0 ? turn.answer() : new Promise<CallIceAnswer>((resolve) => (held.release = resolve)),
    });
    await advance(turn.minted[0]!.expiresAt - Date.now() - 1);
    expect(h.ice).toHaveBeenCalledTimes(2);
    const peer = h.peer();
    h.engine.hangUp();
    held.release!(await turn.answer());
    await settle();
    expect(peer.iceServerUpdates).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

/** Callee: a verified, connected call over its own first set from `turn`. */
async function liveCallee(turn: ReturnType<typeof turnServer>, ice: () => Promise<CallIceAnswer> = turn.answer) {
  const h = setup({ self: 'callee', ice });
  turn.accept();
  await calleeToTags(h);
  h.socket.server('call:verify', { callId: CALL, tag: await peerTag(h.room, 'caller') });
  h.peer().connect();
  await settle();
  expect(h.snap().live).toBe(true);
  return h;
}

/** The caller's ICE restart offer, as the callee gets it: new ICE credentials, by default nothing else new. */
const restartOffer = (o: { ufrag?: string; fingerprint?: string; shape?: SdpShape } = {}) => ({
  callId: CALL,
  signal: { kind: 'offer', sdp: sdpWith(o.fingerprint ?? FP_A, [], { ufrag: o.ufrag ?? 'caller-r1', ...o.shape }) },
});

/** A third m-line, inside the BUNDLE group: still one transport and one fingerprint, but not the call's m-lines. */
const ADDED_M_LINE: SdpShape = { bundle: '0 1 2', extra: ['m=audio 9 UDP/TLS/RTP/SAVPF 111', 'a=mid:2', 'a=rtcp-mux'] };

describe('a fresh TURN set carries the live call: an ICE restart, offered by the caller alone (ADR-211, 2026-11-15)', () => {
  it('the caller restarts ICE once the fresh set is in the browser: new ICE credentials, the same certificate and m-lines; the path moves onto it', async () => {
    const turn = turnServer();
    const h = await liveCall(turn);
    const peer = h.peer();
    await toRenewal(turn);
    expect(turn.minted).toHaveLength(2);
    // The fresh set first, then the restart that gathers with it, then the callee's answer.
    expect(peer.log.slice(-3)).toEqual(['setIceServers', 'restartIce', 'setAnswer']);
    const [first, restart] = offersSent(h);
    expect(offersSent(h)).toHaveLength(2);
    expect(sdpIceUfrag(restart!)).toBe('r1');
    expect(sdpIceUfrag(first!)).toBe(UFRAG);
    expect(boundFingerprint(restart!)).toBe(FP_A);
    expect(sdpLayout(restart!)).toBe(sdpLayout(first!));
    expect(peer.remoteSdps.at(-1)).toBe(sdpWith(FP_B, [], { ufrag: 'callee-1' }));
    expect(peer.pathUfrag()).toBe('r1');
    expect(h.snap()).toMatchObject({ live: true, problem: null });
    expect(h.socket.of('call:end')).toEqual([]);
    // Nothing waits on this restart any more; what is due next is the next renewal — and its own restart.
    expect(vi.getTimerCount()).toBe(1);
    await toRenewal(turn);
    expect(offersSent(h)).toHaveLength(3);
    expect(peer.pathUfrag()).toBe('r2');
  });

  it('the callee never restarts, nor renews on its own clock: its set is topped up when the caller\'s restart comes, then answered', async () => {
    const turn = turnServer(); // the callee's own sets
    const h = await liveCallee(turn);
    const peer = h.peer();
    // Past the moment its set would be renewed: this side asks nothing and offers nothing.
    await toRenewal(turn);
    await advance(L.iceRenewLeadMs - 1);
    expect(h.ice).toHaveBeenCalledTimes(1);
    expect(peer.log).toEqual(['acceptOffer']);
    expect(offersSent(h)).toEqual([]);
    // The caller's restart: the route asked first, the fresh set in the browser, THEN the offer answered with it.
    h.socket.server('call:ice', restartOffer());
    await settle();
    expect(h.ice).toHaveBeenCalledTimes(2);
    expect(turn.minted).toHaveLength(2);
    expect(peer.log).toEqual(['acceptOffer', 'setIceServers', 'acceptOffer']);
    expect(peer.iceServerUpdates).toEqual([turn.answers[1]!.iceServers]);
    const [, answer] = answersSent(h);
    expect(answersSent(h)).toHaveLength(2);
    expect(sdpIceUfrag(answer!)).toBe('r1');
    expect(boundFingerprint(answer!)).toBe(FP_B);
    expect(h.snap()).toMatchObject({ live: true, problem: null });
    // Still nothing of its own scheduled: the next top-up comes with the next restart.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a restart far from the callee\'s renew window asks the route nothing (it would hand back the set held): answered at once with that', async () => {
    const turn = turnServer();
    const h = await liveCallee(turn);
    const peer = h.peer();
    await advance(60_000); // the caller restarts early (its own, earlier set): ours is far from its renew window
    h.socket.server('call:ice', restartOffer());
    await settle();
    expect(h.ice).toHaveBeenCalledTimes(1); // the first set only: no ask spent on the same set
    expect(turn.minted).toHaveLength(1);
    expect(peer.log).toEqual(['acceptOffer', 'acceptOffer']);
    expect(answersSent(h)).toHaveLength(2);
  });

  it('a hostile caller\'s stream of restart offers spends none of the callee\'s hourly ICE quota outside its renew window (review L2)', async () => {
    const turn = turnServer();
    const h = await liveCallee(turn);
    // As many restart offers as the server would relay at once (its SDP cap per end), each with new ICE credentials.
    const offers = CALL_LIMITS.sdpPerEndMax - 1;
    for (let n = 1; n <= offers; n += 1) {
      h.socket.server('call:ice', restartOffer({ ufrag: `caller-r${n}` }));
      await settle();
    }
    expect(answersSent(h)).toHaveLength(1 + offers); // every restart answered, the call untouched…
    expect(h.ice).toHaveBeenCalledTimes(1); // …and the route asked only for the first set
    expect(h.state().name).toBe('verified');
    // Inside the window the top-up is due again: one ask for the next restart, which brings the fresh set.
    await advance(turn.minted[0]!.expiresAt - CALL_LIMITS.turnRenewWindowMs - Date.now());
    h.socket.server('call:ice', restartOffer({ ufrag: 'caller-late' }));
    await settle();
    expect(h.ice).toHaveBeenCalledTimes(2);
    expect(turn.minted).toHaveLength(2);
    expect(h.peer().iceServerUpdates).toEqual([turn.answers[1]!.iceServers]);
  });

  it('a server that does not say how long (no `expiresIn`): the callee cannot place the window without comparing clocks, and tops up at every restart as before', async () => {
    const turn = turnServer({ legacy: true });
    const h = await liveCallee(turn);
    await advance(60_000);
    h.socket.server('call:ice', restartOffer());
    await settle();
    expect(h.ice).toHaveBeenCalledTimes(2);
    expect(answersSent(h)).toHaveLength(2);
  });

  it('a top-up the route does not answer in time does not hold the restart up: answered with the set held', async () => {
    const turn = turnServer();
    let hang = false;
    const h = await liveCallee(turn, () => (hang ? new Promise<CallIceAnswer>(() => undefined) : turn.answer()));
    hang = true;
    await toRenewal(turn);
    h.socket.server('call:ice', restartOffer());
    await settle(); // the offer is in; the top-up asked
    expect(h.ice).toHaveBeenCalledTimes(2);
    await advance(L.iceTopUpMs - 1);
    expect(answersSent(h)).toHaveLength(1);
    await advance(1);
    expect(answersSent(h)).toHaveLength(2);
    expect(h.peer().log).toEqual(['acceptOffer', 'acceptOffer']);
    expect(h.state().name).toBe('verified');
  });

  it('glare cannot happen: the callee never offers, and an offer to the caller while its restart waits is dropped', async () => {
    const turn = turnServer();
    const h = await liveCall(turn);
    h.callee.answers = false;
    await toRenewal(turn);
    expect(offersSent(h)).toHaveLength(2);
    const peer = h.peer();
    h.socket.server('call:ice', { callId: CALL, signal: { kind: 'offer', sdp: sdpWith(FP_B, [], { ufrag: 'callee-x' }) } });
    await settle();
    expect(peer.log.at(-1)).toBe('restartIce'); // nothing applied
    expect(peer.signaling).toBe('have-local-offer');
    h.socket.server('call:ice', { callId: CALL, signal: { kind: 'answer', sdp: sdpWith(FP_B, [], { ufrag: 'callee-1' }) } });
    await settle();
    expect(peer.pathUfrag()).toBe('r1');
    expect(h.snap().live).toBe(true);
  });

  it('one restart at a time: a renewal due while one waits for its answer hands the set over and starts no second', async () => {
    const turn = turnServer({ ttlMs: 70_000 }); // short sets: the renewals come every 10 s
    const h = await liveCall(turn);
    h.callee.answers = false;
    await toRenewal(turn);
    expect(offersSent(h)).toHaveLength(2);
    await toRenewal(turn); // the next renewal, inside the first restart's deadline
    expect(h.peer().iceServerUpdates).toHaveLength(2);
    expect(offersSent(h)).toHaveLength(2);
  });

  it('a restart answer that names another certificate ends the call before the browser gets it', async () => {
    const turn = turnServer();
    const h = await liveCall(turn);
    const track = h.peer().emitTrack();
    await settle();
    expect(track.enabled).toBe(true);
    h.callee.fingerprint = FP_M;
    await toRenewal(turn);
    expect(h.state()).toMatchObject({ name: 'ended', reason: 'verify-failed' });
    expect(h.snap().problem).toBe('cannot-verify');
    expect(h.peer().remoteSdps).toEqual([sdpWith(FP_B)]); // the first answer only
    expect(track.enabled).toBe(false);
    expect(h.socket.of('call:end').at(-1)?.payload.reason).toBe('verify-failed');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a restart answer that adds an m-line, or no longer muxes RTCP, ends the call the same way', async () => {
    for (const shape of [ADDED_M_LINE, { noMux: true }]) {
      const turn = turnServer();
      const h = await liveCall(turn);
      h.callee.shape = shape;
      await toRenewal(turn);
      expect(h.state()).toMatchObject({ name: 'ended', reason: 'verify-failed' });
      expect(h.peer().remoteSdps).toHaveLength(1);
      h.engine.dismiss();
    }
  });

  it('callee: a restart offer that names another certificate, adds an m-line or unmuxes RTCP ends the call — no answer', async () => {
    for (const offer of [restartOffer({ fingerprint: FP_M }), restartOffer({ shape: ADDED_M_LINE }), restartOffer({ shape: { noMux: true } })]) {
      const turn = turnServer();
      const h = await liveCallee(turn);
      h.socket.server('call:ice', offer);
      await settle();
      expect(h.state()).toMatchObject({ name: 'ended', reason: 'verify-failed' });
      expect(h.peer().log).toEqual(['acceptOffer']);
      expect(answersSent(h)).toHaveLength(1);
      expect(h.ice).toHaveBeenCalledTimes(1); // nothing asked for it either
      h.engine.dismiss();
    }
  });

  it('our own browser\'s restart offer under another certificate is never sent: the call ends', async () => {
    const turn = turnServer();
    const h = await liveCall(turn);
    h.peer().localFingerprints = FP_M;
    await toRenewal(turn);
    expect(offersSent(h)).toHaveLength(1);
    expect(h.state()).toMatchObject({ name: 'ended', reason: 'verify-failed' });
  });

  it('callee: an offer with the ICE credentials it has (not a restart) changes nothing and asks nothing', async () => {
    const turn = turnServer();
    const h = await liveCallee(turn);
    h.socket.server('call:ice', restartOffer({ ufrag: UFRAG }));
    await settle();
    expect(h.peer().log).toEqual(['acceptOffer']);
    expect(h.ice).toHaveBeenCalledTimes(1);
    expect(answersSent(h)).toHaveLength(1);
    expect(h.snap().live).toBe(true);
  });

  it('relay-only: the restart\'s candidates are filtered both ways, and its own wait for its offer', async () => {
    const turn = turnServer();
    const h = await liveCall(turn, { localCandidates: [HOST, RELAY] });
    const peer = h.peer();
    h.callee.candidates = [HOST, SRFLX, RELAY];
    peer.gatherOnRestart = [HOST, RELAY]; // trickled while the restart offer is being set
    const before = h.socket.of('call:ice').length;
    await toRenewal(turn);
    const after = h.socket.of('call:ice').slice(before).map((e) => e.payload.signal);
    // The offer first — a candidate of the new generation is no use before it — the host one dropped, the relay scrubbed.
    expect(after.map((s) => s.kind)).toEqual(['offer', 'candidate']);
    expect(after[1]).toMatchObject({ kind: 'candidate', candidate: RELAY_SCRUBBED });
    const offer = offersSent(h)[1]!;
    expect(offer).toContain(`a=${RELAY_SCRUBBED}`);
    expect(offer).not.toContain(HOST);
    expect(offer).not.toContain(RELAY);
    // The answer's, as the browser got it.
    const applied = peer.remoteSdps.at(-1)!;
    expect(applied).toContain(`a=${RELAY_SCRUBBED}`);
    expect(applied).not.toContain(HOST);
    expect(applied).not.toContain(SRFLX);
    // Trickled after it, both ways: the same rules.
    peer.emitCandidate(HOST);
    h.socket.server('call:ice', { callId: CALL, signal: { kind: 'candidate', candidate: SRFLX, sdpMid: '0', sdpMLineIndex: 0 } });
    h.socket.server('call:ice', { callId: CALL, signal: { kind: 'candidate', candidate: RELAY, sdpMid: '0', sdpMLineIndex: 0 } });
    await settle();
    expect(h.socket.of('call:ice').length).toBe(before + 2);
    expect(peer.candidates.at(-1)).toMatchObject({ candidate: RELAY_SCRUBBED });
    expect(peer.candidates.filter((c) => c?.candidate === SRFLX)).toEqual([]);
  });

  it('the microphone is not the restart\'s business: muted stays muted, nothing added, nothing switched', async () => {
    const turn = turnServer();
    const h = await liveCall(turn);
    h.engine.setMuted(true);
    expect(h.micTrack.enabled).toBe(false);
    const log = enabledLog(h.micTrack);
    await toRenewal(turn);
    expect(h.peer().restarts).toBe(1);
    expect(log).toEqual([]);
    expect(h.peer().added).toHaveLength(1);
    h.engine.setMuted(false);
    expect(h.micTrack.enabled).toBe(true);
  });

  it('a restart that misses its deadline is dropped, the route asked once more, and tried once more — never a third time', async () => {
    const turn = turnServer();
    const h = await liveCall(turn);
    const peer = h.peer();
    h.callee.answers = false;
    await toRenewal(turn);
    expect(offersSent(h)).toHaveLength(2);
    const asks = h.ice.mock.calls.length;
    await advance(L.iceRestartMs - 1);
    expect(peer.rollbacks).toBe(0);
    await advance(1);
    expect(peer.rollbacks).toBe(1);
    expect(h.ice).toHaveBeenCalledTimes(asks + 1); // the next renewal attempt
    expect(offersSent(h)).toHaveLength(3);
    expect(sdpIceUfrag(offersSent(h)[2]!)).toBe('r2');
    await advance(L.iceRestartMs);
    expect(peer.rollbacks).toBe(2);
    expect(offersSent(h)).toHaveLength(2 + L.iceRestartAttempts - 1);
    expect(h.ice).toHaveBeenCalledTimes(asks + 1);
    // The answer to the first, late, finds no offer waiting: dropped.
    h.socket.server('call:ice', { callId: CALL, signal: { kind: 'answer', sdp: sdpWith(FP_B, [], { ufrag: 'callee-1' }) } });
    await settle();
    expect(peer.remoteSdps).toHaveLength(1);
    // Nothing more until the next renewal; the call goes on as long as its path does.
    await advance(turn.minted.at(-1)!.expiresAt - L.iceRenewLeadMs - turn.serverNow() - 1);
    expect(offersSent(h)).toHaveLength(3);
    expect(h.state().name).toBe('verified');
    expect(h.socket.of('call:end')).toEqual([]);
  });

  it('an answer whose path never moves to the new generation counts as missed: tried once more', async () => {
    const turn = turnServer();
    const h = await liveCall(turn);
    const peer = h.peer();
    peer.followsRestart = false; // the new TURN allocation never answers: the audio stays on the old one
    await toRenewal(turn);
    expect(peer.remoteSdps).toHaveLength(2);
    expect(peer.pathUfrag()).toBe(UFRAG);
    await advance(L.iceRestartMs);
    expect(offersSent(h)).toHaveLength(3);
    await advance(L.iceRestartMs);
    expect(offersSent(h)).toHaveLength(3);
    expect(peer.rollbacks).toBe(0); // each was answered: there was never an offer to drop
  });

  it('a browser that cannot say which pair it uses: the answer applied is the end of the restart', async () => {
    const turn = turnServer();
    const h = await liveCall(turn);
    h.peer().followsRestart = false;
    h.peer().pathUnknown = true;
    await toRenewal(turn);
    await advance(2 * L.iceRestartMs);
    expect(offersSent(h)).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(1); // the next renewal only
  });

  it('the old allocation dies with no replacement: the media path down for mediaDownMs ends the call lost — not a hang', async () => {
    const turn = turnServer();
    const h = await liveCall(turn);
    h.callee.answers = false;
    await toRenewal(turn);
    await advance(2 * L.iceRestartMs);
    // The first set's last second passes; its allocation goes, and the path with it.
    h.peer().setState('disconnected');
    await advance(L.mediaDownMs - 1);
    expect(h.state().name).toBe('verified');
    expect(h.snap().live).toBe(false);
    await advance(1);
    expect(h.state()).toMatchObject({ name: 'ended', reason: 'lost' });
    expect(h.socket.of('call:end').at(-1)).toEqual({ type: 'call:end', payload: { callId: CALL, reason: 'connect-failed' } });
    expect(h.peer().closed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('…and a drop shorter than that leaves the call as it is', async () => {
    const turn = turnServer();
    const h = await liveCall(turn);
    h.peer().setState('disconnected');
    await advance(L.mediaDownMs - 1);
    h.peer().connect();
    await advance(L.mediaDownMs);
    expect(h.snap()).toMatchObject({ live: true, problem: null });
    h.peer().setState('disconnected');
    await advance(L.mediaDownMs - 1);
    expect(h.state().name).toBe('verified'); // a new drop counts from its own start
  });

  it('no timer outlives the call: hung up while a restart waits, nothing is asked or offered again', async () => {
    const turn = turnServer();
    const h = await liveCall(turn);
    h.callee.answers = false;
    await toRenewal(turn);
    expect(offersSent(h)).toHaveLength(2);
    const asks = h.ice.mock.calls.length;
    h.engine.hangUp();
    expect(vi.getTimerCount()).toBe(0);
    await advance(60 * 60_000);
    expect(offersSent(h)).toHaveLength(2);
    expect(h.ice).toHaveBeenCalledTimes(asks);
  });
});

describe('the microphone (typed reasons, nothing sent on a refusal)', () => {
  it('denied before calling: no invite, the reason for the screen', async () => {
    const h = setup({ microphone: () => Promise.reject(Object.assign(new Error('no'), { name: 'NotAllowedError' })) });
    expect(await h.engine.call(CONV)).toEqual({ ok: false, reason: 'microphone-denied' });
    expect(h.socket.sent).toEqual([]);
    expect(h.state().name).toBe('idle');
    expect(h.snap().problem).toBe('microphone-denied');
  });

  it('no microphone at all is another word', async () => {
    const h = setup({ microphone: () => Promise.reject(Object.assign(new Error('none'), { name: 'NotFoundError' })) });
    expect(await h.engine.call(CONV)).toEqual({ ok: false, reason: 'microphone-unavailable' });
  });

  it('denied on «Answer»: still ringing, nothing accepted', async () => {
    const h = setup({ self: 'callee', microphone: () => Promise.reject(Object.assign(new Error('no'), { name: 'NotAllowedError' })) });
    h.socket.server('call:ring', ring());
    expect(await h.engine.answer()).toEqual({ ok: false, reason: 'microphone-denied' });
    expect(h.state().name).toBe('incoming');
    expect(h.socket.sent).toEqual([]);
    expect(h.snap().problem).toBe('microphone-denied');
  });

  it('hung up while the microphone prompt was up: nothing goes out, the microphone is released', async () => {
    let grant: (s: MediaStream) => void = () => undefined;
    const h = setup({ microphone: () => new Promise((resolve) => { grant = resolve; }) });
    const pending = h.engine.call(CONV);
    h.engine.hangUp();
    const track = { stopped: false, enabled: true, stop() { this.stopped = true; } };
    grant({ getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream);
    expect(await pending).toEqual({ ok: false, reason: 'cancelled' });
    expect(track.stopped).toBe(true);
    expect(h.socket.sent).toEqual([]);
  });

  it('mute is the microphone track, not a message — a mute set before the check still holds after it', async () => {
    const h = setup();
    await callerToTags(h);
    h.engine.setMuted(true);
    expect(h.micTrack.enabled).toBe(false);
    expect(h.snap().muted).toBe(true);
    h.socket.server('call:verify', { callId: CALL, tag: await peerTag(h.room, 'callee') });
    await settle();
    expect(h.state().name).toBe('verified');
    expect(h.micTrack.enabled).toBe(false); // verifying does not unmute
    h.engine.setMuted(false);
    expect(h.micTrack.enabled).toBe(true);
    h.engine.setMuted(true);
    expect(h.micTrack.enabled).toBe(false);
  });

  it('unmuting before the check does not open the microphone early', async () => {
    const h = setup();
    await callerToTags(h);
    h.engine.setMuted(true);
    h.engine.setMuted(false);
    expect(h.snap().muted).toBe(false);
    expect(h.micTrack.enabled).toBe(false);
  });
});

describe('busy is invisible (decision 8, review addition 3)', () => {
  it('a second ring during a call is ignored — never declined, nothing sent', async () => {
    const h = setup();
    await callerToTags(h);
    const before = h.socket.sent.length;
    const state = h.state();
    h.socket.server('call:ring', ring(CALL_2));
    await settle();
    expect(h.state()).toBe(state);
    expect(h.socket.of('call:decline')).toEqual([]);
    expect(h.socket.sent.length).toBe(before);
  });

  it('a second ring while ringing is ignored too', async () => {
    const h = setup({ self: 'callee' });
    h.socket.server('call:ring', ring());
    h.socket.server('call:ring', ring(CALL_2));
    expect(h.state()).toMatchObject({ name: 'incoming', callId: CALL });
    expect(h.socket.sent).toEqual([]);
  });

  it('a ring that lands while our own call waits for the microphone wins; our call is not placed', async () => {
    let grant: (s: MediaStream) => void = () => undefined;
    const h = setup({ microphone: () => new Promise((resolve) => { grant = resolve; }) });
    const pending = h.engine.call(CONV);
    h.socket.server('call:ring', ring());
    const track = { stopped: false, enabled: true, stop() { this.stopped = true; } };
    grant({ getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream);
    expect(await pending).toEqual({ ok: false, reason: 'busy' });
    expect(track.stopped).toBe(true);
    expect(h.socket.of('call:invite')).toEqual([]);
    expect(h.state().name).toBe('incoming');
  });
});

describe('answered elsewhere, declined, no answer', () => {
  it('answered on another device: this one goes quiet', async () => {
    const h = setup({ self: 'callee' });
    h.socket.server('call:ring', ring());
    h.socket.server('call:end', { callId: CALL, reason: 'answered-elsewhere' });
    expect(h.state()).toMatchObject({ name: 'ended', reason: 'answered-elsewhere' });
    expect(await h.engine.answer()).toEqual({ ok: false, reason: 'not-ringing' });
  });

  it('decline sends the decline and ends here', () => {
    const h = setup({ self: 'callee' });
    h.socket.server('call:ring', ring());
    h.engine.decline();
    expect(h.socket.of('call:decline')).toEqual([{ type: 'call:decline', payload: { callId: CALL } }]);
    expect(h.state()).toMatchObject({ name: 'ended', reason: 'declined' });
  });

  it('the caller hears the server\'s no-answer; a server that never says ends it locally after the ring', async () => {
    const h = setup();
    await h.engine.call(CONV);
    h.socket.server('call:invite', { requestId: 'request-1', callId: CALL, ringUntil: RING_UNTIL });
    await settle();
    await advance(45_000 + L.ringGraceMs - 1);
    expect(h.state().name).toBe('outgoing');
    await advance(1);
    expect(h.state()).toMatchObject({ name: 'ended', reason: 'no-answer' });
    expect(h.socket.of('call:end')).toEqual([{ type: 'call:end', payload: { callId: CALL, reason: 'hangup' } }]);
  });

  it('a ring nobody answers stops ringing here after its deadline, without telling anyone', async () => {
    const h = setup({ self: 'callee' });
    h.socket.server('call:ring', ring());
    await advance(45_000 + L.ringGraceMs);
    expect(h.state()).toMatchObject({ name: 'ended', reason: 'no-answer' });
    expect(h.socket.sent).toEqual([]);
  });

  // Review of step Д2a, finding 3: `ringUntil` is the SERVER's clock. Set against this device's clock, a clock a
  // minute fast ended every ring the moment it arrived. The local deadline runs from when the ring got here.
  describe.each([
    ['60 s fast', 60_000],
    ['60 s slow', -60_000],
  ])('this device\'s clock is %s: the ring still lasts the ring\'s length from when it arrived', (_label, skew) => {
    it('callee', async () => {
      const h = setup({ self: 'callee' });
      vi.setSystemTime(T0 + skew);
      h.socket.server('call:ring', ring());
      await advance(45_000 + L.ringGraceMs - 1);
      expect(h.state().name).toBe('incoming');
      await advance(1);
      expect(h.state()).toMatchObject({ name: 'ended', reason: 'no-answer' });
    });

    it('caller', async () => {
      const h = setup();
      vi.setSystemTime(T0 + skew);
      await h.engine.call(CONV);
      h.socket.server('call:invite', { requestId: 'request-1', callId: CALL, ringUntil: RING_UNTIL });
      await settle();
      await advance(45_000 + L.ringGraceMs - 1);
      expect(h.state().name).toBe('outgoing');
      await advance(1);
      expect(h.state()).toMatchObject({ name: 'ended', reason: 'no-answer' });
    });
  });
});

describe('honest ends: socket, media, deadlines', () => {
  it('the socket closes under a call: ended lost, everything released', async () => {
    const h = setup();
    await callerToTags(h);
    h.socket.close(4408);
    expect(h.state()).toMatchObject({ name: 'ended', reason: 'lost' });
    expect(h.snap().problem).toBe('offline');
    expect(h.peer().closed).toBe(true);
    expect(h.micTrack.stopped).toBe(true);
  });

  it('…but a ring survives a socket close: the next socket can still answer it', () => {
    const h = setup({ self: 'callee' });
    h.socket.server('call:ring', ring());
    h.socket.close(1006);
    expect(h.state().name).toBe('incoming');
  });

  it('the network drops after the call was up: ended lost, the other side told', async () => {
    const h = setup();
    await callerToTags(h);
    h.socket.server('call:verify', { callId: CALL, tag: await peerTag(h.room, 'callee') });
    h.peer().connect();
    await settle();
    expect(h.snap().live).toBe(true);
    h.peer().setState('disconnected');
    expect(h.snap().live).toBe(false); // a blip: not "connected" while it lasts
    expect(h.state().name).toBe('verified');
    h.peer().setState('failed');
    expect(h.state()).toMatchObject({ name: 'ended', reason: 'lost' });
    expect(h.socket.of('call:end').at(-1)).toEqual({ type: 'call:end', payload: { callId: CALL, reason: 'connect-failed' } });
  });

  it('the media path never comes up: connect-failed', async () => {
    const h = setup();
    await callerToTags(h);
    h.peer().setState('failed');
    expect(h.state()).toMatchObject({ name: 'ended', reason: 'connect-failed' });
    expect(h.snap().problem).toBe('cannot-connect');
  });

  it('accepted but never connected within the deadline: connect-failed', async () => {
    const h = setup();
    await callerToTags(h);
    h.socket.server('call:verify', { callId: CALL, tag: await peerTag(h.room, 'callee') });
    await settle();
    expect(h.state().name).toBe('verified'); // this browser cannot name the certificate: the tag alone decides
    await advance(L.connectMs);
    expect(h.state()).toMatchObject({ name: 'ended', reason: 'connect-failed' });
  });

  it('an invite the server never acks ends as lost', async () => {
    const h = setup();
    await h.engine.call(CONV);
    await advance(L.inviteAckMs);
    expect(h.state()).toMatchObject({ name: 'ended', reason: 'lost', callId: null });
  });

  it('the other end hung up', async () => {
    const h = setup();
    await callerToTags(h);
    h.socket.server('call:end', { callId: CALL, reason: 'hangup' });
    expect(h.state()).toMatchObject({ name: 'ended', reason: 'hangup' });
    expect(h.peer().closed).toBe(true);
  });
});

describe('late answers to what we already left', () => {
  it('hung up before the ack: the ack that still comes is hung up for the server', async () => {
    const h = setup();
    await h.engine.call(CONV);
    h.engine.hangUp();
    expect(h.state()).toMatchObject({ name: 'ended', callId: null, reason: 'hangup' });
    h.socket.server('call:invite', { requestId: 'request-1', callId: CALL, ringUntil: RING_UNTIL });
    expect(h.socket.of('call:end')).toEqual([{ type: 'call:end', payload: { callId: CALL, reason: 'hangup' } }]);
  });

  it('hung up while our «Answer» was on its way: the accept that wins is hung up', async () => {
    const h = setup({ self: 'callee' });
    h.socket.server('call:ring', ring());
    await h.engine.answer();
    h.engine.hangUp();
    h.socket.server('call:accept', { callId: CALL, callerDeviceId: DEV_A, calleeDeviceId: DEV_B });
    await settle();
    expect(h.socket.of('call:end')).toEqual([{ type: 'call:end', payload: { callId: CALL, reason: 'hangup' } }]);
    expect(h.peers).toHaveLength(0);
  });
});

describe('nothing from the server is trusted for shape or side', () => {
  it('malformed frames and frames of another call move nothing', async () => {
    const h = setup();
    await callerToTags(h);
    const state = h.state();
    h.socket.server('call:end', { callId: CALL, reason: 'exploded' });
    h.socket.server('call:end', { callId: CALL_2, reason: 'hangup' });
    h.socket.server('call:verify', { callId: CALL_2, tag: await peerTag(h.room, 'callee') });
    h.socket.server('call:ice', { callId: CALL, signal: { kind: 'offer', sdp: 'x'.repeat(20_000) } });
    await settle();
    expect(h.state()).toBe(state);
  });

  it('an offer to the caller and a second answer are dropped', async () => {
    const h = setup();
    await callerToTags(h);
    const remote = h.peer().remoteSdp;
    h.socket.server('call:ice', { callId: CALL, signal: { kind: 'offer', sdp: sdpWith(FP_M) } });
    h.socket.server('call:ice', { callId: CALL, signal: { kind: 'answer', sdp: sdpWith(FP_M) } });
    await settle();
    expect(h.peer().remoteSdp).toBe(remote);
    expect(h.state().name).toBe('connecting');
  });

  it('an answer to the callee is dropped', async () => {
    const h = setup({ self: 'callee' });
    await calleeToTags(h);
    const remote = h.peer().remoteSdp;
    h.socket.server('call:ice', { callId: CALL, signal: { kind: 'answer', sdp: sdpWith(FP_M) } });
    await settle();
    expect(h.peer().remoteSdp).toBe(remote);
  });
});

const ASSISTANT_DEVICE = { userId: 'assistant-user', deviceId: 'dev-assistant', role: 'ASSISTANT' } as const;
/** Bob as a minor: his guardian's device holds a seat on HIS account (role GUARDIAN, his user id). */
const GUARDIAN_OF_BOB = { userId: BOB, deviceId: 'dev-guardian', role: 'GUARDIAN' } as const;
const ALICE_TABLET = { userId: ALICE, deviceId: 'dev-a2', role: 'USER' } as const;
const BOB_TABLET = { userId: BOB, deviceId: 'dev-b-tablet', role: 'USER' } as const;

describe('the badge: who else could listen (decision 5)', () => {
  it('the snapshot carries every other member device from the worker', async () => {
    const room = fakeRoom({ extra: [ASSISTANT_DEVICE, BOB_TABLET, GUARDIAN_OF_BOB] });
    const h = setup({ room });
    await callerToTags(h);
    expect(h.snap().others.map((o) => [o.deviceId, o.kind])).toEqual([
      ['dev-assistant', 'assistant'],
      ['dev-b-tablet', 'theirs'],
      ['dev-guardian', 'guardian'],
    ]);
  });
});

describe('the person on the other end (review of step Д2a, finding 2)', () => {
  /** Every state name the machine passes through from now on. */
  function statesOf(h: ReturnType<typeof setup>): string[] {
    const seen: string[] = [];
    h.machine.subscribe((s) => seen.push(s.name));
    return seen;
  }

  for (const [who, device] of [
    ["the assistant's device", ASSISTANT_DEVICE],
    ['a guardian device (it carries the child\'s user id)', GUARDIAN_OF_BOB],
    ['my own other device', ALICE_TABLET],
  ] as const) {
    it(`${who} answering, with the room's real K, is never verified — nothing heard either way`, async () => {
      const h = setup({ room: fakeRoom({ extra: [device] }) });
      const states = statesOf(h);
      const mic = enabledLog(h.micTrack);
      await callerToOffer(h, { calleeDeviceId: device.deviceId });
      const track = h.peer().emitTrack(); // media is up before anything is checked
      h.peer().connect();
      h.socket.server('call:ice', { callId: CALL, signal: { kind: 'answer', sdp: sdpWith(FP_B) } });
      await settle();
      // A member device holds K, so it CAN compute a correct tag naming itself.
      const forged = await peerTag(h.room, 'callee', { calleeDeviceId: device.deviceId });
      h.socket.server('call:verify', { callId: CALL, tag: forged });
      await settle();
      await advance(L.verifyWindowMs);
      expect(h.state()).toMatchObject({ name: 'ended', reason: 'verify-failed' });
      expect(states).not.toContain('verified');
      expect(track.enabled).toBe(false);
      expect(h.speaker.attach).not.toHaveBeenCalled();
      expect(mic).not.toContain(true);
      expect(h.snap().verifiedPeer).toBeNull();
    });
  }

  it('callee: a ring that names one person in a room whose other person is another — the call fails', async () => {
    const h = setup({ self: 'callee' });
    const states = statesOf(h);
    // The ring says Carol calls; the room's other person (who holds K and verifies) is Alice.
    await calleeToTags(h, sdpWith(FP_A), { callerUserId: CAROL });
    h.socket.server('call:verify', { callId: CALL, tag: await peerTag(h.room, 'caller') });
    await settle();
    await advance(L.verifyWindowMs);
    expect(h.state()).toMatchObject({ name: 'ended', reason: 'verify-failed' });
    expect(states).not.toContain('verified');
    expect(h.snap().verifiedPeer).toBeNull();
  });

  it('a room that holds a third person is not a 1:1 room: the call ends before our tag goes out', async () => {
    const h = setup({ room: fakeRoom({ extra: [{ userId: CAROL, deviceId: 'dev-c', role: 'USER' }] }) });
    await callerToTags(h);
    expect(h.socket.of('call:verify')).toEqual([]);
    expect(h.state()).toMatchObject({ name: 'ended', reason: 'verify-failed' });
  });

  it('a verdict that names nobody is not a verdict', async () => {
    const h = setup();
    const real = h.binding.verify.getMockImplementation()!;
    h.binding.verify.mockImplementation(async (request: Parameters<typeof real>[0]) => ({
      ...(await real(request)),
      peerUserId: null,
    }));
    await callerToTags(h);
    h.socket.server('call:verify', { callId: CALL, tag: await peerTag(h.room, 'callee') });
    await settle();
    await advance(L.verifyWindowMs);
    expect(h.state()).toMatchObject({ name: 'ended', reason: 'verify-failed' });
  });

  it('the snapshot names the verified peer — the person the worker verified, from the check on', async () => {
    const caller = setup();
    await callerToTags(caller);
    expect(caller.snap().verifiedPeer).toBeNull();
    caller.socket.server('call:verify', { callId: CALL, tag: await peerTag(caller.room, 'callee') });
    await settle();
    expect(caller.state().name).toBe('verified');
    expect(caller.snap().verifiedPeer).toEqual({ userId: BOB, deviceId: DEV_B });

    const callee = setup({ self: 'callee' });
    await calleeToTags(callee);
    expect(callee.snap().verifiedPeer).toBeNull();
    callee.socket.server('call:verify', { callId: CALL, tag: await peerTag(callee.room, 'caller') });
    await settle();
    expect(callee.state().name).toBe('verified');
    expect(callee.snap().verifiedPeer).toEqual({ userId: ALICE, deviceId: DEV_A });
  });
});

describe('the control channel (groundwork for ADR-215 decision 4; no protocol on it yet)', () => {
  /** Caller, DTLS up with the callee's real certificate on the shared transport, tags checked: `verified`. */
  async function verifiedCall() {
    const h = setup();
    await callerToTags(h);
    h.peer().presentCertificate(CERT_B);
    h.socket.server('call:verify', { callId: CALL, tag: await peerTag(h.room, 'callee') });
    await settle();
    expect(h.state().name).toBe('verified');
    return h;
  }

  /**
   * Open the channel on a verified call and wait until the engine shows it open. The transport check hashes a
   * certificate with WebCrypto, which finishes on the thread pool: on a loaded machine the check that started at
   * `verified` may still be running when the channel opens, and the newer check then decides — a bounded
   * `settle()` alone is a race (red on CI, 2026-11-15).
   */
  async function openTrusted(h: Awaited<ReturnType<typeof verifiedCall>>): Promise<void> {
    h.peer().openControl();
    for (let i = 0; i < 50 && !h.snap().controlOpen; i += 1) await settle();
  }

  it('is part of every peer from its creation — before the first offer — on both sides, negotiated with one fixed id', async () => {
    const caller = setup();
    await callerToOffer(caller);
    expect(caller.peer().config.control).toEqual(CALL_CONTROL_CHANNEL);
    expect(caller.peer().config.control).toEqual({ label: 'masia-call-ctl', id: 0 });
    const callee = setup({ self: 'callee' });
    await calleeToTags(callee);
    expect(callee.peer().config.control).toEqual(CALL_CONTROL_CHANNEL);
  });

  it('a message that arrives before the check passed is dropped — never surfaced, not even after it', async () => {
    const h = setup();
    const heard = vi.fn();
    h.engine.onControlMessage(heard);
    await callerToTags(h);
    h.peer().openControl();
    h.peer().controlFromPeer('early');
    h.peer().presentCertificate(CERT_B);
    h.socket.server('call:verify', { callId: CALL, tag: await peerTag(h.room, 'callee') });
    await settle();
    expect(h.state().name).toBe('verified');
    expect(heard).not.toHaveBeenCalled();
    h.peer().controlFromPeer('after');
    expect(heard).toHaveBeenCalledTimes(1);
    expect(heard).toHaveBeenCalledWith('after');
  });

  it('nothing is sent on it before the check passed, nor once the call is over', async () => {
    const h = setup();
    await callerToTags(h);
    h.peer().openControl();
    h.peer().presentCertificate(CERT_B);
    await settle();
    expect(h.snap().controlOpen).toBe(false);
    expect(h.engine.sendControl('too soon')).toBe(false);
    h.socket.server('call:verify', { callId: CALL, tag: await peerTag(h.room, 'callee') });
    await settle();
    expect(h.snap().controlOpen).toBe(true);
    expect(h.engine.sendControl('hello')).toBe(true);
    const peer = h.peer();
    h.engine.hangUp();
    expect(peer.closed).toBe(true); // the channel closes with the peer connection
    expect(h.snap().controlOpen).toBe(false);
    expect(h.engine.sendControl('too late')).toBe(false);
    expect(peer.controlSent).toEqual(['hello']);
  });

  it('a verified call with the channel not (yet) open: nothing sent, not shown open', async () => {
    const h = await verifiedCall();
    expect(h.snap().controlOpen).toBe(false);
    expect(h.engine.sendControl('x')).toBe(false);
    await openTrusted(h);
    expect(h.snap().controlOpen).toBe(true);
  });

  it('the channel closing under a live call is reported, and the call goes on', async () => {
    const h = await verifiedCall();
    h.peer().openControl();
    h.peer().peerClosesControl();
    expect(h.snap().controlOpen).toBe(false);
    expect(h.state().name).toBe('verified');
    expect(h.engine.sendControl('x')).toBe(false);
  });

  it('we send text only, within the size limit', async () => {
    const h = await verifiedCall();
    await openTrusted(h);
    expect(h.engine.sendControl('x'.repeat(L.controlMessageMaxChars + 1))).toBe(false);
    expect(h.engine.sendControl('x'.repeat(L.controlMessageMaxChars))).toBe(true);
  });

  // Review of step Д2a (low): the peer is bounded too. Breaking the channel's rules — binary, oversize, or more
  // messages a second than the cap — closes the channel (ADR-215: that counts as a leave); the audio call goes on.
  describe('a peer that breaks the channel\'s rules loses the channel; the call goes on', () => {
    async function openChannel() {
      const h = await verifiedCall();
      const heard = vi.fn();
      h.engine.onControlMessage(heard);
      await openTrusted(h);
      expect(h.snap().controlOpen).toBe(true);
      return { h, heard };
    }
    function expectShut(h: Awaited<ReturnType<typeof openChannel>>['h']) {
      expect(h.peer().controlClosedHere).toBe(1);
      expect(h.snap().controlOpen).toBe(false);
      expect(h.engine.sendControl('x')).toBe(false);
      expect(h.state().name).toBe('verified');
      expect(h.micTrack.enabled).toBe(true);
    }

    it('a message over the size limit', async () => {
      const { h, heard } = await openChannel();
      h.peer().controlFromPeer('x'.repeat(L.controlMessageMaxChars));
      h.peer().controlFromPeer('x'.repeat(L.controlMessageMaxChars + 1));
      expect(heard).toHaveBeenCalledTimes(1);
      expectShut(h);
    });

    it('a binary message', async () => {
      const { h, heard } = await openChannel();
      h.peer().controlFromPeer(new ArrayBuffer(4));
      expect(heard).not.toHaveBeenCalled();
      expectShut(h);
    });

    it(`more than ${L.controlMessagesPerSecond} messages in one second — and nothing after it is heard`, async () => {
      const { h, heard } = await openChannel();
      for (let i = 0; i < L.controlMessagesPerSecond; i += 1) h.peer().controlFromPeer(`m${i}`);
      expect(heard).toHaveBeenCalledTimes(L.controlMessagesPerSecond);
      expect(h.peer().controlClosedHere).toBe(0);
      h.peer().controlFromPeer('one too many');
      expectShut(h);
      await advance(1_000);
      h.peer().controlFromPeer('later'); // already queued in the browser when it closed
      expect(heard).toHaveBeenCalledTimes(L.controlMessagesPerSecond);
    });

    it(`…while ${L.controlMessagesPerSecond} a second, every second, is fine`, async () => {
      const { h, heard } = await openChannel();
      for (let second = 0; second < 3; second += 1) {
        for (let i = 0; i < L.controlMessagesPerSecond; i += 1) h.peer().controlFromPeer(`s${second}m${i}`);
        await advance(1_000);
      }
      expect(heard).toHaveBeenCalledTimes(3 * L.controlMessagesPerSecond);
      expect(h.peer().controlClosedHere).toBe(0);
      expect(h.snap().controlOpen).toBe(true);
    });

    it('a flood before the check passed counts too: it is not read, and it still closes the channel', async () => {
      const h = setup();
      await callerToTags(h);
      h.peer().openControl();
      for (let i = 0; i <= L.controlMessagesPerSecond; i += 1) h.peer().controlFromPeer(`early${i}`);
      expect(h.peer().controlClosedHere).toBe(1);
      h.peer().presentCertificate(CERT_B);
      h.socket.server('call:verify', { callId: CALL, tag: await peerTag(h.room, 'callee') });
      await settle();
      expect(h.state().name).toBe('verified'); // the audio call is not the channel
      expect(h.snap().controlOpen).toBe(false);
    });
  });

  it('the engine itself puts nothing on it — a whole call, no traffic', async () => {
    const h = await verifiedCall();
    h.peer().openControl();
    h.peer().connect();
    await settle();
    h.engine.hangUp();
    expect(h.peers.flatMap((p) => p.controlSent)).toEqual([]);
  });

  it('a listener stops hearing once it unsubscribes, and after dispose nobody does', async () => {
    const h = await verifiedCall();
    await openTrusted(h);
    const first = vi.fn();
    const second = vi.fn();
    const off = h.engine.onControlMessage(first);
    h.engine.onControlMessage(second);
    off();
    h.peer().controlFromPeer('one');
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith('one');
    h.engine.dispose();
    h.peer().controlFromPeer('two');
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe('the transport binding, on every call (ADR-215 decision 4)', () => {
  /**
   * Caller, the channel open, tags checked. By default DTLS is up with the callee's real certificate on the audio
   * transport, which the channel shares; `certificate: 'unknown'` = a browser that cannot say which one is in use.
   */
  async function boundCall(o: { certificate?: 'present' | 'unknown'; shared?: boolean } = {}) {
    const h = setup();
    await callerToTags(h);
    const heard = vi.fn();
    h.engine.onControlMessage(heard);
    const track = h.peer().emitTrack();
    h.peer().openControl();
    h.peer().sctpShared = o.shared ?? true;
    if (o.certificate === 'unknown') h.peer().connect();
    else h.peer().presentCertificate(CERT_B);
    h.socket.server('call:verify', { callId: CALL, tag: await peerTag(h.room, 'callee') });
    await settle();
    return { h, heard, track };
  }

  it('an SDP rewritten to unbundle (no BUNDLE group) fails verification: no tag, nothing played', async () => {
    const h = setup({ self: 'callee' });
    await calleeToTags(h, sdpWith(FP_A, [], { bundle: null }));
    expect(h.peer().remoteSdp).toBeNull();
    expect(h.state()).toMatchObject({ name: 'ended', reason: 'verify-failed' });
    expect(h.snap().problem).toBe('cannot-verify');
    expect(h.socket.of('call:verify')).toEqual([]);
    expect(h.socket.of('call:end').at(-1)?.payload.reason).toBe('verify-failed');
    expect(h.speaker.attach).not.toHaveBeenCalled();
  });

  it('an m-line left outside the BUNDLE group fails verification', async () => {
    const h = setup();
    await callerToTags(h, sdpWith(FP_B, [], { bundle: '0' }));
    expect(h.peer().remoteSdp).toBeNull();
    expect(h.state()).toMatchObject({ name: 'ended', reason: 'verify-failed' });
    expect(h.socket.of('call:verify')).toEqual([]);
  });

  it('an SDP that swaps only the application m-line\'s fingerprint fails verification', async () => {
    const h = setup({ self: 'callee' });
    // The audio m-line still names the caller's real certificate; the control channel's names the server's.
    await calleeToTags(h, sdpWith(FP_A, [], { app: FP_M }));
    expect(h.peer().remoteSdp).toBeNull();
    expect(h.state()).toMatchObject({ name: 'ended', reason: 'verify-failed' });
    expect(h.socket.of('call:verify')).toEqual([]);
    expect(h.speaker.attach).not.toHaveBeenCalled();
  });

  it('our own SDP unbundled is never sent', async () => {
    const h = setup({ localShape: { bundle: null } });
    await callerToOffer(h);
    expect(h.socket.of('call:ice')).toEqual([]);
    expect(h.state()).toMatchObject({ name: 'ended', reason: 'verify-failed' });
  });

  it('the channel opens on the audio sender\'s transport with the certificate the tag bound — and carries both ways', async () => {
    const { h, heard } = await boundCall();
    expect(h.state().name).toBe('verified');
    expect(h.snap().controlOpen).toBe(true);
    h.peer().controlFromPeer('hi');
    expect(heard).toHaveBeenCalledWith('hi');
    expect(h.engine.sendControl('hi back')).toBe(true);
  });

  it('a channel on another transport than the audio\'s: every message dropped, nothing sent — the audio still plays', async () => {
    const { h, heard, track } = await boundCall({ shared: false });
    expect(h.state().name).toBe('verified');
    expect(track.enabled).toBe(true);
    expect(h.snap().controlOpen).toBe(false);
    h.peer().controlFromPeer('accept');
    expect(heard).not.toHaveBeenCalled();
    expect(h.engine.sendControl('x')).toBe(false);
    expect(h.peer().controlSent).toEqual([]);
  });

  it('where the browser cannot name the certificate in use, the channel stays shut; the audio call goes on', async () => {
    const { h, heard, track } = await boundCall({ certificate: 'unknown' });
    expect(h.peer().certs).toBeNull();
    expect(h.state().name).toBe('verified');
    expect(track.enabled).toBe(true);
    expect(h.snap().controlOpen).toBe(false);
    h.peer().controlFromPeer('accept');
    expect(heard).not.toHaveBeenCalled();
    expect(h.engine.sendControl('x')).toBe(false);
  });

  it('a later change of the DTLS transport ends the call: the audio stops, the server is told', async () => {
    const { h, track } = await boundCall();
    expect(h.snap().live).toBe(true);
    const peer = h.peer();
    peer.changeTransport();
    await settle();
    expect(h.state()).toMatchObject({ name: 'ended', reason: 'verify-failed' });
    expect(track.enabled).toBe(false);
    expect(h.speaker.detach).toHaveBeenCalled();
    expect(peer.closed).toBe(true);
    expect(h.socket.of('call:end').at(-1)?.payload.reason).toBe('verify-failed');
    expect(h.snap().controlOpen).toBe(false);
  });

  it('a remote certificate that changes under the call ends it', async () => {
    const { h } = await boundCall();
    expect(h.state().name).toBe('verified');
    h.peer().certs = [new Uint8Array([48, 3, 1, 1, 0xe]).buffer];
    h.peer().switchPath();
    await settle();
    expect(h.state()).toMatchObject({ name: 'ended', reason: 'verify-failed' });
  });

  it('a new candidate pair keeps the DTLS transport: the call and the channel go on', async () => {
    const { h } = await boundCall();
    h.peer().switchPath();
    await settle();
    expect(h.state().name).toBe('verified');
    expect(h.snap().live).toBe(true);
    expect(h.snap().controlOpen).toBe(true);
  });
});

describe('no runtime, no call', () => {
  it('without the encryption runtime nothing is placed and the microphone is not asked', async () => {
    const h = setup({ noBinding: true });
    expect(await h.engine.call(CONV)).toEqual({ ok: false, reason: 'disabled' });
    expect(h.microphone).not.toHaveBeenCalled();
    expect(h.socket.sent).toEqual([]);
  });

  it('offline: refused before the microphone is asked', async () => {
    const h = setup();
    h.socket.state.open = false;
    expect(await h.engine.call(CONV)).toEqual({ ok: false, reason: 'offline' });
    expect(h.microphone).not.toHaveBeenCalled();
  });

  it('dispose hangs up a live call and stops listening', async () => {
    const h = setup();
    await callerToTags(h);
    h.engine.dispose();
    expect(h.socket.of('call:end')).toEqual([{ type: 'call:end', payload: { callId: CALL, reason: 'hangup' } }]);
    expect(h.socket.subscribed).toBe(false);
    expect(h.speaker.dispose).toHaveBeenCalledTimes(1);
  });

  it('dispose while ringing goes quiet without declining — the ring is still the person\'s, on their other devices', () => {
    const h = setup({ self: 'callee' });
    h.socket.server('call:ring', ring());
    h.engine.dispose();
    expect(h.socket.sent).toEqual([]);
    expect(h.state().name).not.toBe('incoming');
  });

  // Review of step Д2б (M3): the machine is the tab's one singleton, and a sign-out does not reload the page. A call
  // the last engine ended (dispose turns a ring into `ended lost`, a live call into `ended hangup`) must not be shown
  // by the next engine — to the next account signed in on this tab, with the old call's ids.
  describe('the next engine starts from nothing: a call an earlier engine ended is not carried over', () => {
    it('a ring the earlier engine dropped', () => {
      const first = setup({ self: 'callee' });
      first.socket.server('call:ring', ring());
      first.engine.dispose();
      expect(first.state().name).toBe('ended');
      const next = setup({ self: 'callee', machine: first.machine });
      expect(next.state()).toEqual({ name: 'idle' });
      expect(next.snap().call).toEqual({ name: 'idle' });
    });

    it('a live call the earlier engine hung up', async () => {
      const first = setup();
      await callerToTags(first);
      first.engine.dispose();
      const next = setup({ machine: first.machine });
      expect(next.state()).toEqual({ name: 'idle' });
      expect(next.socket.sent).toEqual([]); // nothing is said for a call this engine never held
    });
  });

  // Review of step Д2a (low): a call started or answered just before the engine went away is still acked by the
  // server. Without listening for that ack, nothing hung it up: the callee's phone rang on for the whole ring.
  describe('dispose while the server has not acked yet: the ack that comes later is still hung up', () => {
    it('while inviting', async () => {
      const h = setup();
      await h.engine.call(CONV);
      h.engine.dispose();
      expect(h.socket.subscribed).toBe(true);
      h.socket.server('call:invite', { requestId: 'request-1', callId: CALL, ringUntil: RING_UNTIL });
      expect(h.socket.of('call:end')).toEqual([{ type: 'call:end', payload: { callId: CALL, reason: 'hangup' } }]);
      expect(h.ice).not.toHaveBeenCalled();
      expect(h.state().name).not.toBe('outgoing');
    });

    it('while answering', async () => {
      const h = setup({ self: 'callee' });
      h.socket.server('call:ring', ring());
      await h.engine.answer();
      h.engine.dispose();
      h.socket.server('call:accept', { callId: CALL, callerDeviceId: DEV_A, calleeDeviceId: DEV_B });
      expect(h.socket.of('call:end')).toEqual([{ type: 'call:end', payload: { callId: CALL, reason: 'hangup' } }]);
      expect(h.peers).toEqual([]);
    });

    it('nothing else is handled meanwhile, and the engine stops listening once no ack can come', async () => {
      const h = setup();
      await h.engine.call(CONV);
      h.engine.dispose();
      h.socket.server('call:ring', ring(CALL_2));
      expect(h.state().name).not.toBe('incoming');
      await advance(Math.max(L.inviteAckMs, L.acceptAckMs));
      expect(h.socket.subscribed).toBe(false);
    });

    it('…and stops at once when the last ack it waited for came', async () => {
      const h = setup();
      await h.engine.call(CONV);
      h.engine.dispose();
      h.socket.server('call:invite', { requestId: 'request-1', callId: CALL, ringUntil: RING_UNTIL });
      expect(h.socket.subscribed).toBe(false);
    });
  });
});
