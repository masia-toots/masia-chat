/**
 * ADR-211 decision 4 — the per-role verification tag. Vectors are checked against an independent HMAC (node:crypto
 * over a hand-framed buffer) and one pinned value; the reflection attack (review finding V1) must fail.
 */
import { createHmac, type webcrypto } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import {
  CALL_TAG_LABEL,
  callTagInput,
  computeCallTag,
  normalizeDtlsFingerprint,
  verifyPeerCallTag,
  type CallTagBinding,
} from '../call-verify-tag.js';

const K = new Uint8Array(32).map((_, i) => i + 1); // 01 02 … 20
const K_OTHER = new Uint8Array(32).map((_, i) => 0xff - i);

const FP_A = 'sha-256 ' + Array.from({ length: 32 }, (_, i) => (i * 7 + 3).toString(16).padStart(2, '0').toUpperCase()).join(':');
const FP_B = 'sha-256 ' + Array.from({ length: 32 }, (_, i) => (i * 5 + 9).toString(16).padStart(2, '0').toUpperCase()).join(':');
const FP_EVIL = 'sha-256 ' + Array.from({ length: 32 }, () => 'EE').join(':');

const binding: CallTagBinding = {
  callId: 'AAAAAAAAAAAAAAAAAAAAAA',
  callerDeviceId: 'masia_alice_1',
  calleeDeviceId: 'masia_bob_2',
  fingerprintCaller: FP_A,
  fingerprintCallee: FP_B,
};

/** Independent framing: u32 BE length + UTF-8, in the ADR's order. */
function frame(fields: string[]): Buffer {
  return Buffer.concat(
    fields.flatMap((f) => {
      const b = Buffer.from(f, 'utf8');
      const len = Buffer.alloc(4);
      len.writeUInt32BE(b.length);
      return [len, b];
    }),
  );
}

function referenceTag(key: Uint8Array, role: string, b: CallTagBinding): string {
  const input = frame([CALL_TAG_LABEL, role, b.callId, b.callerDeviceId, b.calleeDeviceId, b.fingerprintCaller, b.fingerprintCallee]);
  return createHmac('sha256', Buffer.from(key)).update(input).digest('base64url');
}

describe('call verification tag (ADR-211 decision 4)', () => {
  it('label is masia-call-fp-v1 and the input is length-framed in the ADR order', () => {
    expect(CALL_TAG_LABEL).toBe('masia-call-fp-v1');
    const input = callTagInput('caller', binding);
    expect(Buffer.from(input).equals(
      frame(['masia-call-fp-v1', 'caller', binding.callId, binding.callerDeviceId, binding.calleeDeviceId, FP_A, FP_B]),
    )).toBe(true);
  });

  it('vectors: each role matches an independent HMAC-SHA256, and the two roles differ', async () => {
    const caller = await computeCallTag(K, 'caller', binding);
    const callee = await computeCallTag(K, 'callee', binding);
    expect(caller).toBe(referenceTag(K, 'caller', binding));
    expect(callee).toBe(referenceTag(K, 'callee', binding));
    expect(caller).not.toBe(callee);
    expect(caller).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('pinned vector (a change to the construction must be a new label)', async () => {
    expect(await computeCallTag(K, 'caller', binding)).toBe(PINNED_CALLER_TAG);
  });

  it('the honest exchange verifies on both sides', async () => {
    const callerTag = await computeCallTag(K, 'caller', binding);
    const calleeTag = await computeCallTag(K, 'callee', binding);
    expect(await verifyPeerCallTag({ key: K, myRole: 'caller', binding, sentTag: callerTag, receivedTag: calleeTag })).toBe(true);
    expect(await verifyPeerCallTag({ key: K, myRole: 'callee', binding, sentTag: calleeTag, receivedTag: callerTag })).toBe(true);
  });

  it('REFLECTION ATTACK: the server bounces each side its own tag back → both fail', async () => {
    const callerTag = await computeCallTag(K, 'caller', binding);
    const calleeTag = await computeCallTag(K, 'callee', binding);
    expect(await verifyPeerCallTag({ key: K, myRole: 'caller', binding, sentTag: callerTag, receivedTag: callerTag })).toBe(false);
    expect(await verifyPeerCallTag({ key: K, myRole: 'callee', binding, sentTag: calleeTag, receivedTag: calleeTag })).toBe(false);
  });

  it('a received tag equal to the sent one fails even if it would otherwise match (sent == expected peer tag)', async () => {
    // A host bug that «sends» the peer's tag must not turn a reflection into a pass.
    const calleeTag = await computeCallTag(K, 'callee', binding);
    expect(await verifyPeerCallTag({ key: K, myRole: 'caller', binding, sentTag: calleeTag, receivedTag: calleeTag })).toBe(false);
  });

  it('a swapped fingerprint (server in the middle with its own certificate) fails', async () => {
    // The callee saw the attacker's fingerprint as the caller's; its tag binds FP_EVIL.
    const calleeView: CallTagBinding = { ...binding, fingerprintCaller: FP_EVIL };
    const calleeTag = await computeCallTag(K, 'callee', calleeView);
    const callerTag = await computeCallTag(K, 'caller', binding);
    expect(await verifyPeerCallTag({ key: K, myRole: 'caller', binding, sentTag: callerTag, receivedTag: calleeTag })).toBe(false);
  });

  it('another device id, another call id, or another K fails', async () => {
    const callerTag = await computeCallTag(K, 'caller', binding);
    for (const [key, b] of [
      [K, { ...binding, calleeDeviceId: 'masia_bob_3' }],
      [K, { ...binding, callId: 'BBBBBBBBBBBBBBBBBBBBBB' }],
      [K_OTHER, binding],
    ] as const) {
      const calleeTag = await computeCallTag(key, 'callee', b);
      expect(await verifyPeerCallTag({ key: K, myRole: 'caller', binding, sentTag: callerTag, receivedTag: calleeTag })).toBe(false);
    }
  });

  it('a missing (late) or malformed tag is a failure, never «verified»', async () => {
    const callerTag = await computeCallTag(K, 'caller', binding);
    expect(await verifyPeerCallTag({ key: K, myRole: 'caller', binding, sentTag: callerTag, receivedTag: null })).toBe(false);
    expect(await verifyPeerCallTag({ key: K, myRole: 'caller', binding, sentTag: callerTag, receivedTag: '!!' })).toBe(false);
    expect(await verifyPeerCallTag({ key: K, myRole: 'caller', binding, sentTag: callerTag, receivedTag: '' })).toBe(false);
  });

  it('fingerprints: normalised from SDP spelling; a non-canonical one is refused, not silently hashed', async () => {
    const lower = 'a=fingerprint:SHA-256 ' + FP_A.slice('sha-256 '.length).toLowerCase();
    expect(normalizeDtlsFingerprint(lower)).toBe(FP_A);
    expect(normalizeDtlsFingerprint('nonsense')).toBeNull();
    await expect(computeCallTag(K, 'caller', { ...binding, fingerprintCaller: lower })).rejects.toThrow(/canonical/);
  });

  it('the binding is checked here, not trusted from the server: role, call id, device ids', async () => {
    // The server relays these fields; it is the adversary the tag defends against, so its own regex is no guard.
    const bad: Array<[string, () => unknown]> = [
      ['role', () => callTagInput('observer' as 'caller', binding)],
      ['call id too short', () => callTagInput('caller', { ...binding, callId: 'AAAA' })],
      ['call id with a separator', () => callTagInput('caller', { ...binding, callId: 'AAAAAAAAAAA/AAAAAAAAAA' })],
      ['empty device id', () => callTagInput('caller', { ...binding, callerDeviceId: '' })],
      ['device id with a space', () => callTagInput('caller', { ...binding, calleeDeviceId: 'masia bob' })],
      ['oversize device id', () => callTagInput('caller', { ...binding, calleeDeviceId: 'x'.repeat(129) })],
      ['one device at both ends', () => callTagInput('caller', { ...binding, calleeDeviceId: binding.callerDeviceId })],
    ];
    for (const [what, run] of bad) {
      expect(run, what).toThrow(/call tag/);
    }
    await expect(computeCallTag(K, 'caller', { ...binding, callId: 'short' })).rejects.toThrow(/call tag/);
    // verifyPeerCallTag fails closed on a bad binding (false, not a throw the caller might mistake).
    const callerTag = await computeCallTag(K, 'caller', binding);
    const calleeTag = await computeCallTag(K, 'callee', binding);
    expect(await verifyPeerCallTag({
      key: K, myRole: 'caller', binding: { ...binding, callId: 'short' }, sentTag: callerTag, receivedTag: calleeTag,
    })).toBe(false);
  });

  it('the key must be the 32-byte exporter output', async () => {
    await expect(computeCallTag(new Uint8Array(16), 'caller', binding)).rejects.toThrow(/32-byte/);
  });

  // Review of step Д2a (low): the tag code copies `K` for WebCrypto. The copy is its own, so it is wiped as soon as
  // WebCrypto has imported it; the caller's buffer is the caller's to wipe, and stays as it was.
  it('the copy of K handed to WebCrypto is wiped once imported, both questions; the caller\'s K is untouched', async () => {
    const copies: Uint8Array[] = [];
    const importKey = crypto.subtle.importKey.bind(crypto.subtle);
    const spy = vi.spyOn(crypto.subtle, 'importKey').mockImplementation(((format: 'raw', raw: Uint8Array, ...rest: never[]) => {
      copies.push(raw);
      return (importKey as (...args: unknown[]) => Promise<webcrypto.CryptoKey>)(format, raw, ...rest);
    }) as typeof crypto.subtle.importKey);
    try {
      const key = K.slice();
      const callerTag = await computeCallTag(key, 'caller', binding);
      const calleeTag = await computeCallTag(K, 'callee', binding);
      expect(await verifyPeerCallTag({ key, myRole: 'caller', binding, sentTag: callerTag, receivedTag: calleeTag })).toBe(true);
      expect(copies).toHaveLength(3);
      for (const copy of copies) {
        expect(copy).not.toBe(key);
        expect(copy.every((byte) => byte === 0)).toBe(true);
      }
      expect(key).toEqual(K);
    } finally {
      spy.mockRestore();
    }
  });
});

const PINNED_CALLER_TAG = 'gleD2wMpMHbEiAUvcYUftwrtIR5H5QtP496FijLO4xE';
