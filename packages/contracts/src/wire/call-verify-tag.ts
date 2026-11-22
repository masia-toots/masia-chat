/**
 * call-verify-tag — proof that the DTLS fingerprints of a call were not swapped by the server (ADR-211 decision 4).
 *
 * `K` is the MLS exporter output of the two people's 1:1 room (`label = CALL_FP_EXPORTER_LABEL`, context = callId),
 * derived inside the hub's MLS worker; it never leaves the worker, so this module is called INSIDE the worker with
 * the raw bytes (step Д2 wires that operation). Each side sends its OWN role's tag
 *
 *   HMAC-SHA256(K, "masia-call-fp-v1" ‖ role ‖ callId ‖ callerDeviceId ‖ calleeDeviceId ‖ fpCaller ‖ fpCallee)
 *
 * and checks the OTHER role's tag in constant time. A received tag equal to the one this side sent is a failure
 * (a server bouncing each side's own tag back — review finding V1).
 *
 * `‖` is made unambiguous here: every field is UTF-8, prefixed by its byte length as a 4-byte big-endian integer
 * (without a framing, "ab" ‖ "c" and "a" ‖ "bc" would hash the same). The ADR names the fields and their order; the
 * framing is this module's decision.
 *
 * Fingerprints are compared in one canonical form (`normalizeDtlsFingerprint`): `<hash-func lower> <HEX:HEX…>`, so the
 * two sides agree whatever casing their SDP used. Pure WebCrypto: runs in a browser, a worker and Node ≥ 20.
 *
 * The binding is validated HERE (role, the call-id and device-id patterns of the wire contract, two distinct devices,
 * canonical fingerprints): its fields arrive through the server, which is the party the tag defends against, so the
 * server's own validation is no guard. Its only import is that contract (`call-signal.ts`, itself import-free).
 */
import { CALL_DEVICE_ID_PATTERN, CALL_ID_PATTERN } from './call-signal.js';

/** The MLS exporter label `K` is derived under (context = the callId). */
export const CALL_FP_EXPORTER_LABEL = 'masia-call-fp';
/** The first field of every tag input — the version of this construction. */
export const CALL_TAG_LABEL = 'masia-call-fp-v1';
/** Bytes asked from the MLS exporter for `K`. */
export const CALL_FP_KEY_BYTES = 32;

export type CallTagRole = 'caller' | 'callee';

/** Everything the tag binds, apart from the role. */
export interface CallTagBinding {
  readonly callId: string;
  readonly callerDeviceId: string;
  readonly calleeDeviceId: string;
  /** Canonical (`normalizeDtlsFingerprint`) fingerprint of the caller's DTLS certificate. */
  readonly fingerprintCaller: string;
  /** Canonical fingerprint of the callee's DTLS certificate. */
  readonly fingerprintCallee: string;
}

const FINGERPRINT_PATTERN = /^([A-Za-z0-9-]{1,16})\s+((?:[0-9A-Fa-f]{2}:)*[0-9A-Fa-f]{2})$/;
const FIELD_LENGTH_BYTES = 4;
const UTF8 = new TextEncoder();

/**
 * The canonical form of a DTLS fingerprint as it appears after `a=fingerprint:` in an SDP
 * (`sha-256 AB:CD:…`): hash function lower-case, hex upper-case, one space. Null when it is not a fingerprint.
 */
export function normalizeDtlsFingerprint(raw: string): string | null {
  const m = FINGERPRINT_PATTERN.exec(raw.trim().replace(/^a=fingerprint:/i, ''));
  if (!m) return null;
  return `${m[1]!.toLowerCase()} ${m[2]!.toUpperCase()}`;
}

function assertCanonicalFingerprint(fp: string, which: string): void {
  if (typeof fp !== 'string' || normalizeDtlsFingerprint(fp) !== fp) {
    throw new Error(`call tag: ${which} fingerprint is not in canonical form`);
  }
}

function assertPattern(value: unknown, pattern: RegExp, which: string): void {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`call tag: ${which} is not well-formed`);
}

/** The exact bytes the HMAC runs over — exported for the test vectors. Throws on a binding that is not well-formed. */
export function callTagInput(role: CallTagRole, b: CallTagBinding): Uint8Array {
  if (role !== 'caller' && role !== 'callee') throw new Error('call tag: role must be caller or callee');
  assertPattern(b.callId, CALL_ID_PATTERN, 'call id');
  assertPattern(b.callerDeviceId, CALL_DEVICE_ID_PATTERN, 'caller device id');
  assertPattern(b.calleeDeviceId, CALL_DEVICE_ID_PATTERN, 'callee device id');
  if (b.callerDeviceId === b.calleeDeviceId) throw new Error('call tag: caller and callee are one device');
  assertCanonicalFingerprint(b.fingerprintCaller, 'caller');
  assertCanonicalFingerprint(b.fingerprintCallee, 'callee');
  const fields = [CALL_TAG_LABEL, role, b.callId, b.callerDeviceId, b.calleeDeviceId, b.fingerprintCaller, b.fingerprintCallee]
    .map((f) => UTF8.encode(f));
  const total = fields.reduce((n, f) => n + FIELD_LENGTH_BYTES + f.length, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let at = 0;
  for (const f of fields) {
    view.setUint32(at, f.length, false);
    at += FIELD_LENGTH_BYTES;
    out.set(f, at);
    at += f.length;
  }
  return out;
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  try {
    const bin = atob(padded);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** Constant-time equality of two byte strings (length is not secret: a tag is always 32 bytes). */
function bytesEqualConstantTime(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  if (key.length !== CALL_FP_KEY_BYTES) throw new Error('call tag: key must be the 32-byte exporter output');
  // Copies: WebCrypto's typing wants an ArrayBuffer-backed view (not a possibly shared one). The copy of `K` is ours
  // alone, so it is wiped as soon as WebCrypto has imported it (it keeps its own); the caller wipes its own buffer.
  const raw = new Uint8Array(key);
  let k: Awaited<ReturnType<typeof crypto.subtle.importKey>>;
  try {
    k = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  } finally {
    raw.fill(0);
  }
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, new Uint8Array(data)));
}

/** This side's tag for `role` (base64url, 43 chars) — what goes into `call:verify`. */
export async function computeCallTag(key: Uint8Array, role: CallTagRole, binding: CallTagBinding): Promise<string> {
  return toBase64Url(await hmac(key, callTagInput(role, binding)));
}

export interface VerifyPeerCallTagInput {
  readonly key: Uint8Array;
  /** THIS side's role; the peer's tag is checked under the other one. */
  readonly myRole: CallTagRole;
  readonly binding: CallTagBinding;
  /** The tag this side sent (or will send). */
  readonly sentTag: string;
  /** The tag that came back from the peer; null = missing or late — a failure, never «verified». */
  readonly receivedTag: string | null;
}

/**
 * Does the peer's tag prove the same `K` and the same two fingerprints and device ids? False for a missing tag, a
 * malformed one, our own tag reflected back, a binding that is not well-formed, and any mismatch. Every comparison is
 * constant-time.
 */
export async function verifyPeerCallTag(input: VerifyPeerCallTagInput): Promise<boolean> {
  if (input.receivedTag === null) return false;
  const received = fromBase64Url(input.receivedTag);
  const sent = fromBase64Url(input.sentTag);
  if (!received || !sent) return false;
  if (input.myRole !== 'caller' && input.myRole !== 'callee') return false;
  const peerRole: CallTagRole = input.myRole === 'caller' ? 'callee' : 'caller';
  let peerInput: Uint8Array;
  try {
    peerInput = callTagInput(peerRole, input.binding);
  } catch {
    return false; // fail closed: an ill-formed binding never verifies
  }
  const expected = await hmac(input.key, peerInput);
  // Both comparisons always run, so the time does not tell which one failed.
  const reflected = bytesEqualConstantTime(received, sent);
  const matches = bytesEqualConstantTime(received, expected);
  return matches && !reflected;
}
