/** ADR-211 decision 2 — the `call:*` wire contract: what a client frame may carry, and what is dropped. */
import { describe, it, expect } from 'vitest';
import { CALL_EVENT, CALL_LIMITS, isCallEventType, parseCallClientEvent, parseCallServerEvent } from '../call-signal.js';

const CALL_ID = 'abcdefghijklmnopqrstuv';
const CONV = '6f1c2b1e-3a4d-4c5e-8f90-1a2b3c4d5e6f';
const TAG = 'A'.repeat(43);

describe('call signal contract', () => {
  it('names exactly the seven ADR events and the ring ack (`call:ringing`, step Д3a)', () => {
    expect(Object.values(CALL_EVENT).sort()).toEqual(
      ['call:accept', 'call:decline', 'call:end', 'call:ice', 'call:invite', 'call:ring', 'call:ringing', 'call:verify'],
    );
    expect(isCallEventType('call:ringing')).toBe(true);
    expect(isCallEventType('call:ice')).toBe(true);
    expect(isCallEventType('call:offer')).toBe(false);
    expect(isCallEventType(42)).toBe(false);
  });

  it('parses each client event and drops unknown extra fields', () => {
    expect(parseCallClientEvent({
      type: 'call:invite',
      payload: { requestId: 'req-12345', conversationId: CONV, deviceId: 'masia_u1_1', calleeUserId: 'someone-else' },
    })).toEqual({ type: 'call:invite', payload: { requestId: 'req-12345', conversationId: CONV, deviceId: 'masia_u1_1' } });
    expect(parseCallClientEvent({ type: 'call:accept', payload: { callId: CALL_ID, deviceId: 'masia_u2_3' } })?.type).toBe('call:accept');
    expect(parseCallClientEvent({ type: 'call:decline', payload: { callId: CALL_ID } })?.type).toBe('call:decline');
    expect(parseCallClientEvent({ type: 'call:verify', payload: { callId: CALL_ID, tag: TAG } })?.type).toBe('call:verify');
    expect(parseCallClientEvent({ type: 'call:end', payload: { callId: CALL_ID, reason: 'hangup' } })?.type).toBe('call:end');
  });

  it('call:ringing carries the call id only; a malformed one is dropped', () => {
    expect(parseCallClientEvent({ type: 'call:ringing', payload: { callId: CALL_ID, deviceId: 'masia_u2_3' } }))
      .toEqual({ type: 'call:ringing', payload: { callId: CALL_ID } });
    expect(parseCallClientEvent({ type: 'call:ringing', payload: { callId: 'short' } })).toBeNull();
    expect(parseCallClientEvent({ type: 'call:ringing', payload: {} })).toBeNull();
  });

  it('call:ice carries the SDP pair and candidates; anything else is dropped', () => {
    const ice = (signal: unknown) => parseCallClientEvent({ type: 'call:ice', payload: { callId: CALL_ID, signal } });
    expect(ice({ kind: 'offer', sdp: 'v=0' })).not.toBeNull();
    expect(ice({ kind: 'answer', sdp: 'v=0' })).not.toBeNull();
    expect(ice({ kind: 'candidate', candidate: 'candidate:1 1 udp 1 1.2.3.4 5 typ host', sdpMid: '0', sdpMLineIndex: 0 }))
      .toEqual({ type: 'call:ice', payload: { callId: CALL_ID, signal: {
        kind: 'candidate', candidate: 'candidate:1 1 udp 1 1.2.3.4 5 typ host', sdpMid: '0', sdpMLineIndex: 0,
      } } });
    expect(ice({ kind: 'end-of-candidates' })).not.toBeNull();
    expect(ice({ kind: 'offer', sdp: 'x'.repeat(CALL_LIMITS.sdpMaxChars + 1) })).toBeNull();
    expect(ice({ kind: 'offer', sdp: '' })).toBeNull();
    expect(ice({ kind: 'candidate', candidate: 'c', sdpMid: 5, sdpMLineIndex: 0 })).toBeNull();
    expect(ice({ kind: 'candidate', candidate: 'c', sdpMid: '0', sdpMLineIndex: -1 })).toBeNull();
    expect(ice({ kind: 'renegotiate' })).toBeNull();
  });

  it('a client may not choose a server-only end reason', () => {
    expect(parseCallClientEvent({ type: 'call:end', payload: { callId: CALL_ID, reason: 'answered-elsewhere' } })).toBeNull();
    expect(parseCallClientEvent({ type: 'call:end', payload: { callId: CALL_ID, reason: 'no-answer' } })).toBeNull();
  });

  it('malformed ids, tags and shapes are dropped', () => {
    expect(parseCallClientEvent({ type: 'call:decline', payload: { callId: 'short' } })).toBeNull();
    expect(parseCallClientEvent({ type: 'call:verify', payload: { callId: CALL_ID, tag: 'A'.repeat(44) } })).toBeNull();
    expect(parseCallClientEvent({ type: 'call:invite', payload: { requestId: 'r', conversationId: CONV, deviceId: 'd' } })).toBeNull();
    expect(parseCallClientEvent({ type: 'call:invite', payload: { requestId: 'req-12345', conversationId: 'nope', deviceId: 'd' } })).toBeNull();
    expect(parseCallClientEvent({ type: 'call:accept', payload: { callId: CALL_ID, deviceId: 'has space' } })).toBeNull();
    expect(parseCallClientEvent({ type: 'call:ring', payload: { callId: CALL_ID } })).toBeNull(); // server-only
    expect(parseCallClientEvent({ type: 'call:decline' })).toBeNull();
    expect(parseCallClientEvent(null)).toBeNull();
  });
});

/**
 * The other direction: a hub reads every server frame through the same contract before it moves the call. The server
 * is not trusted for shape (a compromised or buggy one must not crash the engine or smuggle a field into the tag).
 */
describe('call signal contract — server frames, as a client reads them', () => {
  const USER = '11111111-2222-4333-8444-555555555555';
  const AT = '2026-11-15T10:00:45.000Z';

  it('parses each server event and drops unknown extra fields', () => {
    expect(parseCallServerEvent({ type: 'call:invite', payload: { requestId: 'req-12345', callId: CALL_ID, ringUntil: AT, x: 1 } }))
      .toEqual({ type: 'call:invite', payload: { requestId: 'req-12345', callId: CALL_ID, ringUntil: AT } });
    expect(parseCallServerEvent({
      type: 'call:ring',
      payload: { callId: CALL_ID, conversationId: CONV, callerUserId: USER, callerDeviceId: 'masia_u1_1', ringUntil: AT, silent: true },
    })).toEqual({
      type: 'call:ring',
      payload: { callId: CALL_ID, conversationId: CONV, callerUserId: USER, callerDeviceId: 'masia_u1_1', ringUntil: AT, silent: true },
    });
    expect(parseCallServerEvent({ type: 'call:accept', payload: { callId: CALL_ID, callerDeviceId: 'a1', calleeDeviceId: 'b1' } }))
      .toEqual({ type: 'call:accept', payload: { callId: CALL_ID, callerDeviceId: 'a1', calleeDeviceId: 'b1' } });
    expect(parseCallServerEvent({ type: 'call:ice', payload: { callId: CALL_ID, signal: { kind: 'answer', sdp: 'v=0' } } }))
      .toEqual({ type: 'call:ice', payload: { callId: CALL_ID, signal: { kind: 'answer', sdp: 'v=0' } } });
    expect(parseCallServerEvent({ type: 'call:verify', payload: { callId: CALL_ID, tag: TAG } })?.type).toBe('call:verify');
    // the server may end with any reason, its own included
    expect(parseCallServerEvent({ type: 'call:end', payload: { callId: CALL_ID, reason: 'answered-elsewhere' } }))
      .toEqual({ type: 'call:end', payload: { callId: CALL_ID, reason: 'answered-elsewhere' } });
  });

  it('`call:ring` names the room and the caller as wire ids: the API’s uuids, and a relay call channel’s ids', () => {
    const ring = parseCallServerEvent({
      type: 'call:ring',
      payload: { callId: CALL_ID, conversationId: 'dm_alice_bob', callerUserId: 'alice', callerDeviceId: 'alice-phone', ringUntil: AT },
    });
    expect(ring?.type === 'call:ring' ? ring.payload.conversationId : null).toBe('dm_alice_bob');
  });

  it('`call:ring`’s `silent` is true only when the server says exactly true: missing or anything else rings (review Д2б L2)', () => {
    const ring = (extra: Record<string, unknown>) =>
      parseCallServerEvent({
        type: 'call:ring',
        payload: { callId: CALL_ID, conversationId: CONV, callerUserId: USER, callerDeviceId: 'masia_u1_1', ringUntil: AT, ...extra },
      });
    const silentOf = (extra: Record<string, unknown>) => {
      const event = ring(extra);
      return event?.type === 'call:ring' ? event.payload.silent : 'dropped';
    };
    expect(silentOf({ silent: true })).toBe(true);
    expect(silentOf({ silent: false })).toBe(false);
    expect(silentOf({})).toBe(false); // a server from before the field
    expect(silentOf({ silent: 'yes' })).toBe(false); // the sound is a preference: a bad value never drops the ring
  });

  it('malformed server frames are dropped, not trusted', () => {
    expect(parseCallServerEvent({ type: 'call:end', payload: { callId: CALL_ID, reason: 'exploded' } })).toBeNull();
    expect(parseCallServerEvent({ type: 'call:end', payload: { callId: 'short', reason: 'hangup' } })).toBeNull();
    expect(parseCallServerEvent({ type: 'call:invite', payload: { requestId: 'req-12345', callId: CALL_ID, ringUntil: 'soon' } })).toBeNull();
    expect(parseCallServerEvent({
      type: 'call:ring',
      payload: { callId: CALL_ID, conversationId: 'not/a/wire/id', callerUserId: USER, callerDeviceId: 'd1', ringUntil: AT },
    })).toBeNull();
    expect(parseCallServerEvent({
      type: 'call:ring',
      payload: { callId: CALL_ID, conversationId: CONV, callerUserId: 'u'.repeat(129), callerDeviceId: 'd1', ringUntil: AT },
    })).toBeNull();
    expect(parseCallServerEvent({
      type: 'call:ring',
      payload: { callId: CALL_ID, conversationId: CONV, callerUserId: USER, callerDeviceId: 'has space', ringUntil: AT },
    })).toBeNull();
    expect(parseCallServerEvent({ type: 'call:accept', payload: { callId: CALL_ID, callerDeviceId: 'a1' } })).toBeNull();
    expect(parseCallServerEvent({ type: 'call:ice', payload: { callId: CALL_ID, signal: { kind: 'offer', sdp: 'x'.repeat(CALL_LIMITS.sdpMaxChars + 1) } } })).toBeNull();
    expect(parseCallServerEvent({ type: 'call:verify', payload: { callId: CALL_ID, tag: 'A'.repeat(42) } })).toBeNull();
    expect(parseCallServerEvent({ type: 'call:decline', payload: { callId: CALL_ID } })).toBeNull(); // client-only
    expect(parseCallServerEvent({ type: 'call:end' })).toBeNull();
    expect(parseCallServerEvent('call:end')).toBeNull();
  });
});
