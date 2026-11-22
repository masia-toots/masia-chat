/**
 * ADR-211 — one device's view of a 1:1 audio call: invite → ringing → accepted → verified → ended, decline,
 * no-answer, answered on another device, and the end reasons. Illegal pairs are no-ops (same reference).
 */
import { describe, it, expect } from 'vitest';
import {
  audioCallNext,
  createAudioCallMachine,
  currentAudioCallId,
  initialAudioCallState,
  isAudioCallAudible,
  isAudioCallBusy,
  isAudioCallRinging,
  isAudioCallUp,
  type AudioCallEvent,
  type AudioCallState,
} from '../audio-call-machine.js';

const CONV = 'conv-1';
const send = (s: AudioCallState, ...events: AudioCallEvent[]) => events.reduce(audioCallNext, s);

const outgoing = () =>
  send(
    initialAudioCallState,
    { type: 'INVITE', requestId: 'req-1', conversationId: CONV, localDeviceId: 'dev-a' },
    { type: 'INVITE_ACK', requestId: 'req-1', callId: 'call-1', ringUntil: '2026-11-15T10:00:45.000Z' },
  );
const ring = (callId = 'call-1'): AudioCallEvent => ({
  type: 'RING', callId, conversationId: CONV, callerUserId: 'u-a', callerDeviceId: 'dev-a', ringUntil: '2026-11-15T10:00:45.000Z',
});
const incoming = () => send(initialAudioCallState, ring());

describe('audio call machine — caller side', () => {
  it('invite → outgoing → accepted (connecting, silent) → verified (audible) → hangup', () => {
    const inviting = send(initialAudioCallState, { type: 'INVITE', requestId: 'req-1', conversationId: CONV, localDeviceId: 'dev-a' });
    expect(inviting.name).toBe('inviting');
    expect(currentAudioCallId(inviting)).toBeNull();
    const out = outgoing();
    expect(out.name).toBe('outgoing');
    expect(currentAudioCallId(out)).toBe('call-1');
    const connecting = audioCallNext(out, { type: 'ACCEPTED', callId: 'call-1', callerDeviceId: 'dev-a', calleeDeviceId: 'dev-b2' });
    expect(connecting).toMatchObject({ name: 'connecting', role: 'caller', localDeviceId: 'dev-a', peerDeviceId: 'dev-b2' });
    expect(isAudioCallAudible(connecting)).toBe(false);
    const verified = audioCallNext(connecting, { type: 'VERIFIED', callId: 'call-1' });
    expect(verified.name).toBe('verified');
    expect(isAudioCallAudible(verified)).toBe(true);
    expect(audioCallNext(verified, { type: 'HANGUP' })).toMatchObject({ name: 'ended', reason: 'hangup', callId: 'call-1' });
  });

  it('an ack for another request does not name this call', () => {
    const inviting = send(initialAudioCallState, { type: 'INVITE', requestId: 'req-1', conversationId: CONV, localDeviceId: 'dev-a' });
    expect(audioCallNext(inviting, { type: 'INVITE_ACK', requestId: 'req-2', callId: 'call-9', ringUntil: 'x' })).toBe(inviting);
  });

  it('no answer: the server ends it; the caller never learns why', () => {
    expect(audioCallNext(outgoing(), { type: 'END', callId: 'call-1', reason: 'no-answer' }))
      .toMatchObject({ name: 'ended', reason: 'no-answer' });
  });

  it('declined by the callee', () => {
    expect(audioCallNext(outgoing(), { type: 'END', callId: 'call-1', reason: 'declined' })).toMatchObject({ reason: 'declined' });
  });

  it('hang up before the ack → ended without a call id', () => {
    const inviting = send(initialAudioCallState, { type: 'INVITE', requestId: 'req-1', conversationId: CONV, localDeviceId: 'dev-a' });
    expect(audioCallNext(inviting, { type: 'HANGUP' })).toMatchObject({ name: 'ended', callId: null, reason: 'hangup' });
  });

  it('a second invite while busy is a no-op', () => {
    const out = outgoing();
    expect(audioCallNext(out, { type: 'INVITE', requestId: 'req-2', conversationId: CONV, localDeviceId: 'dev-a' })).toBe(out);
  });
});

describe('audio call machine — callee side', () => {
  it('ring → accept → the server confirms THIS device → connecting as callee', () => {
    const s = incoming();
    expect(isAudioCallRinging(s)).toBe(true);
    const accepting = audioCallNext(s, { type: 'ACCEPT', localDeviceId: 'dev-b1' });
    expect(accepting.name).toBe('accepting');
    expect(isAudioCallRinging(accepting)).toBe(false);
    expect(audioCallNext(accepting, { type: 'ACCEPTED', callId: 'call-1', callerDeviceId: 'dev-a', calleeDeviceId: 'dev-b1' }))
      .toMatchObject({ name: 'connecting', role: 'callee', localDeviceId: 'dev-b1', peerDeviceId: 'dev-a' });
  });

  it('answered on another device: the server says so and this one goes quiet', () => {
    const s = incoming();
    expect(audioCallNext(s, { type: 'END', callId: 'call-1', reason: 'answered-elsewhere' }))
      .toMatchObject({ name: 'ended', reason: 'answered-elsewhere' });
    // …and if this device had also pressed «Answer», a confirm naming the OTHER device does not connect it.
    const accepting = audioCallNext(s, { type: 'ACCEPT', localDeviceId: 'dev-b1' });
    expect(audioCallNext(accepting, { type: 'ACCEPTED', callId: 'call-1', callerDeviceId: 'dev-a', calleeDeviceId: 'dev-b2' }))
      .toBe(accepting);
  });

  it('decline here ends it', () => {
    expect(audioCallNext(incoming(), { type: 'DECLINE' })).toMatchObject({ name: 'ended', reason: 'declined' });
  });

  it('the caller cancelled while ringing', () => {
    expect(audioCallNext(incoming(), { type: 'END', callId: 'call-1', reason: 'cancelled' })).toMatchObject({ reason: 'cancelled' });
  });

  it('a ring while busy does not interrupt; a re-delivered ring of the ended call does not ring again', () => {
    const s = incoming();
    expect(audioCallNext(s, ring('call-2'))).toBe(s);
    const ended = audioCallNext(s, { type: 'DECLINE' });
    expect(audioCallNext(ended, ring('call-1'))).toBe(ended);
    expect(audioCallNext(ended, ring('call-2')).name).toBe('incoming');
  });
});

describe('audio call machine — verification and ends', () => {
  const connecting = () =>
    audioCallNext(outgoing(), { type: 'ACCEPTED', callId: 'call-1', callerDeviceId: 'dev-a', calleeDeviceId: 'dev-b1' });

  it('a failed tag ends the call before any audio', () => {
    const s = audioCallNext(connecting(), { type: 'VERIFY_FAILED', callId: 'call-1' });
    expect(s).toMatchObject({ name: 'ended', reason: 'verify-failed' });
    expect(isAudioCallAudible(s)).toBe(false);
  });

  it('VERIFIED only from connecting, and only for this call', () => {
    const c = connecting();
    expect(audioCallNext(c, { type: 'VERIFIED', callId: 'call-2' })).toBe(c);
    expect(audioCallNext(outgoing(), { type: 'VERIFIED', callId: 'call-1' }).name).toBe('outgoing');
  });

  it('lost: the other end died — an honest end; the first reason is kept', () => {
    const verified = audioCallNext(connecting(), { type: 'VERIFIED', callId: 'call-1' });
    const lost = audioCallNext(verified, { type: 'END', callId: 'call-1', reason: 'lost' });
    expect(lost).toMatchObject({ name: 'ended', reason: 'lost' });
    expect(audioCallNext(lost, { type: 'END', callId: 'call-1', reason: 'hangup' })).toBe(lost);
  });

  it('an END for another call never moves this one', () => {
    const c = connecting();
    expect(audioCallNext(c, { type: 'END', callId: 'call-2', reason: 'hangup' })).toBe(c);
  });

  it('CLOSE returns to idle only from ended', () => {
    const c = connecting();
    expect(audioCallNext(c, { type: 'CLOSE' })).toBe(c);
    const e = audioCallNext(c, { type: 'HANGUP' });
    expect(isAudioCallUp(e)).toBe(true);
    expect(isAudioCallBusy(e)).toBe(false);
    expect(audioCallNext(e, { type: 'CLOSE' })).toBe(initialAudioCallState);
  });

  it('ABORT: the host ends the call on what it knows itself, from any live state — inviting included', () => {
    const inviting = send(initialAudioCallState, { type: 'INVITE', requestId: 'req-1', conversationId: CONV, localDeviceId: 'dev-a' });
    expect(audioCallNext(inviting, { type: 'ABORT', reason: 'lost' }))
      .toMatchObject({ name: 'ended', callId: null, conversationId: CONV, reason: 'lost' });
    expect(audioCallNext(outgoing(), { type: 'ABORT', reason: 'no-answer' })).toMatchObject({ name: 'ended', callId: 'call-1', reason: 'no-answer' });
    expect(audioCallNext(incoming(), { type: 'ABORT', reason: 'lost' })).toMatchObject({ name: 'ended', reason: 'lost' });
    expect(audioCallNext(connecting(), { type: 'ABORT', reason: 'connect-failed' })).toMatchObject({ name: 'ended', reason: 'connect-failed' });
    // nothing to end, and the first reason is kept
    expect(audioCallNext(initialAudioCallState, { type: 'ABORT', reason: 'lost' })).toBe(initialAudioCallState);
    const e = audioCallNext(connecting(), { type: 'HANGUP' });
    expect(audioCallNext(e, { type: 'ABORT', reason: 'lost' })).toBe(e);
  });

  it('factory machines are isolated', () => {
    const m = createAudioCallMachine();
    m.send(ring());
    expect(m.getState().name).toBe('incoming');
    expect(createAudioCallMachine().getState().name).toBe('idle');
  });
});
