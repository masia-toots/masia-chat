/** ADR-228 — the relay call channel's wire contract: the peer signals, the stream events, the per-call caps. */
import { describe, expect, it } from 'vitest';
import {
  CALL_RELAY_LIMITS,
  CALL_STREAM_MAX_LIFETIME_MS,
  parseCallStreamReady,
  parseCallStreamSignal,
  parseRelayCallSignal,
  RELAY_CALL_END_REASONS,
} from '../call-relay.js';
import { CALL_LIMITS, CALL_END_REASONS, callRelayCap, callRelayKindOf, parseCallSignal } from '../call-signal.js';
import { RELAY_TOKEN_CLOCK_TOLERANCE_SECONDS, RELAY_TOKEN_TTL_SECONDS } from '../relay-token.js';

const CALL_ID = 'abcdefghijklmnopqrstuv';
const TAG = 'A'.repeat(43);

describe('the peer signals', () => {
  it('parses every signal and drops unknown extra fields', () => {
    for (const type of ['call:ring', 'call:accept', 'call:accepted', 'call:decline'] as const) {
      expect(parseRelayCallSignal({ type, callId: CALL_ID, deviceId: 'smuggled' })).toEqual({ type, callId: CALL_ID });
    }
    expect(parseRelayCallSignal({ type: 'call:ice', callId: CALL_ID, signal: { kind: 'offer', sdp: 'v=0', x: 1 } }))
      .toEqual({ type: 'call:ice', callId: CALL_ID, signal: { kind: 'offer', sdp: 'v=0' } });
    expect(parseRelayCallSignal({ type: 'call:verify', callId: CALL_ID, tag: TAG }))
      .toEqual({ type: 'call:verify', callId: CALL_ID, tag: TAG });
    expect(parseRelayCallSignal({ type: 'call:end', callId: CALL_ID, reason: 'answered-elsewhere' }))
      .toEqual({ type: 'call:end', callId: CALL_ID, reason: 'answered-elsewhere' });
  });

  it('refuses malformed, oversize and server-only shapes', () => {
    expect(parseRelayCallSignal({ type: 'call:ring', callId: 'short' })).toBeNull();
    expect(parseRelayCallSignal({ type: 'call:invite', callId: CALL_ID })).toBeNull();
    expect(parseRelayCallSignal({ type: 'call:ice', callId: CALL_ID, signal: { kind: 'offer', sdp: 'x'.repeat(CALL_LIMITS.sdpMaxChars + 1) } }))
      .toBeNull();
    expect(parseRelayCallSignal({ type: 'call:verify', callId: CALL_ID, tag: 'A'.repeat(42) })).toBeNull();
    // what the relay or a client decides is never a peer's to say
    expect(parseRelayCallSignal({ type: 'call:end', callId: CALL_ID, reason: 'rate-limited' })).toBeNull();
    expect(parseRelayCallSignal({ type: 'call:end', callId: CALL_ID, reason: 'unavailable' })).toBeNull();
    expect(parseRelayCallSignal(null)).toBeNull();
    expect(parseRelayCallSignal([])).toBeNull();
  });

  it('every peer end reason is a call end reason the engine reads', () => {
    for (const reason of RELAY_CALL_END_REASONS) expect(CALL_END_REASONS).toContain(reason);
  });
});

describe('the stream events', () => {
  it('reads a signal event and refuses ids outside the wire alphabet', () => {
    const event = { conversationId: 'dm_a_b', fromUserId: 'alice', fromDeviceId: 'alice-phone', signal: { type: 'call:ring', callId: CALL_ID } };
    expect(parseCallStreamSignal(event)).toEqual(event);
    expect(parseCallStreamSignal({ ...event, fromDeviceId: 'has space' })).toBeNull();
    expect(parseCallStreamSignal({ ...event, conversationId: 'c'.repeat(129) })).toBeNull();
    expect(parseCallStreamSignal({ ...event, signal: { type: 'call:ring' } })).toBeNull();
  });

  it('reads the ready event', () => {
    expect(parseCallStreamReady({ closesInMs: 1000 })).toEqual({ closesInMs: 1000 });
    expect(parseCallStreamReady({ closesInMs: -1 })).toBeNull();
    expect(parseCallStreamReady({ closesInMs: 'soon' })).toBeNull();
  });

  it('caps a closesInMs no real stream could have at the longest a stream lives (the token lifetime and tolerance)', () => {
    expect(CALL_STREAM_MAX_LIFETIME_MS).toBe((RELAY_TOKEN_TTL_SECONDS + RELAY_TOKEN_CLOCK_TOLERANCE_SECONDS) * 1000);
    expect(parseCallStreamReady({ closesInMs: CALL_STREAM_MAX_LIFETIME_MS })).toEqual({ closesInMs: CALL_STREAM_MAX_LIFETIME_MS });
    for (const huge of [CALL_STREAM_MAX_LIFETIME_MS + 1, 2 ** 31, 1e15, Number.MAX_VALUE]) {
      expect(parseCallStreamReady({ closesInMs: huge })).toEqual({ closesInMs: CALL_STREAM_MAX_LIFETIME_MS });
    }
  });

  it('a body cap that fits the longest SDP escaped character by character', () => {
    const body = JSON.stringify({
      conversationId: 'c'.repeat(128),
      toDeviceId: 'd'.repeat(128),
      signal: { type: 'call:ice', callId: CALL_ID, signal: { kind: 'offer', sdp: '\u0001'.repeat(CALL_LIMITS.sdpMaxChars) } },
    });
    expect(new TextEncoder().encode(body).length).toBeLessThanOrEqual(CALL_RELAY_LIMITS.signalBodyMaxBytes);
  });
});

describe('the per-call caps (shared by the API and the relay)', () => {
  it('start at the base caps and refill SDPs and candidates with the call’s age, never the tags', () => {
    expect(callRelayCap('sdp', 0)).toBe(CALL_LIMITS.sdpPerEndMax);
    expect(callRelayCap('candidate', 0)).toBe(CALL_LIMITS.candidatesPerEndMax);
    expect(callRelayCap('verify', 0)).toBe(CALL_LIMITS.verifyPerEndMax);
    const later = 3 * CALL_LIMITS.relayRefillMs + 1;
    expect(callRelayCap('sdp', later)).toBe(CALL_LIMITS.sdpPerEndMax + 3 * CALL_LIMITS.sdpPerRefill);
    expect(callRelayCap('candidate', later)).toBe(CALL_LIMITS.candidatesPerEndMax + 3 * CALL_LIMITS.candidatesPerRefill);
    expect(callRelayCap('verify', later)).toBe(CALL_LIMITS.verifyPerEndMax);
    expect(callRelayCap('sdp', -5)).toBe(CALL_LIMITS.sdpPerEndMax);
  });

  it('counts an SDP against the SDP cap and a candidate or the end of candidates against the candidate cap', () => {
    const kindOf = (raw: unknown) => {
      const signal = parseCallSignal(raw);
      return signal === null ? null : callRelayKindOf(signal);
    };
    expect(kindOf({ kind: 'offer', sdp: 'v=0' })).toBe('sdp');
    expect(kindOf({ kind: 'answer', sdp: 'v=0' })).toBe('sdp');
    expect(kindOf({ kind: 'candidate', candidate: 'c', sdpMid: null, sdpMLineIndex: null })).toBe('candidate');
    expect(kindOf({ kind: 'end-of-candidates' })).toBe('candidate');
  });
});
