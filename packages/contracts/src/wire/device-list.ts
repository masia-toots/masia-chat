/**
 * The signed device list, `mls-device-list/v1`: the ONE canonical encoding and the ONE signature
 * check (canon section 3). A person's devices are listed by a list the person signs on the client
 * with their long-lived identity key (Ed25519, raw 32-byte public key); every member verifies it
 * before it trusts a leaf, and the relay verifies it before it stores a version, so a list that no
 * member would accept is never served. Nobody keeps a second copy of this format: the relay, the
 * messenger and the assistant worker all import it from here.
 *
 * The signed bytes are `deviceListSigningBytes`: a fixed-order JSON of the format tag, the owner, the
 * version and the entries sorted by id, each with its signature key re-encoded as canonical base64. An
 * ASSISTANT entry carries its `conversationId` INSIDE the signed bytes (the binding the engine checks);
 * a USER or GUARDIAN entry never does.
 *
 * What is refused is a typed `DeviceListError`, never a silent pass:
 *  - a signature that does not verify under the identity key (`BAD_SIGNATURE`);
 *  - a list of another owner (`OWNER_MISMATCH`) and a rollback (`ROLLBACK`) are judged by the
 *    verifying MEMBER, which holds the pin (the owner and the newest version it has seen); they have
 *    their codes here so there is one vocabulary;
 *  - malformed entries: duplicate ids, too many devices, an unknown role, an ASSISTANT without its
 *    conversation, a USER or GUARDIAN with one, a key that is not 32 bytes, a version below 1
 *    (`MALFORMED`).
 *
 * Uses WebCrypto Ed25519 (browsers, Workers and Node alike); no third-party dependency.
 */
import type { DeviceListEntry } from './relay-api.js';
import { DeviceRole, isDeviceRole, MAX_DEVICES_PER_USER } from './vocabulary.js';

/** The format tag inside the signed bytes. Generic on purpose: no product name in a wire string. */
export const DEVICE_LIST_FORMAT = 'mls-device-list/v1';
export const ED25519_PUBLIC_KEY_BYTES = 32;
export const ED25519_SIGNATURE_BYTES = 64;

export const DEVICE_LIST_ERRORS = {
  BAD_SIGNATURE: 'BAD_SIGNATURE',
  OWNER_MISMATCH: 'OWNER_MISMATCH',
  ROLLBACK: 'ROLLBACK',
  MALFORMED: 'MALFORMED',
} as const;
export type DeviceListErrorCode = (typeof DEVICE_LIST_ERRORS)[keyof typeof DEVICE_LIST_ERRORS];

export class DeviceListError extends Error {
  readonly code: DeviceListErrorCode;
  constructor(code: DeviceListErrorCode, detail?: string) {
    super(`device list: ${code}${detail ? ` (${detail})` : ''}`);
    this.name = 'DeviceListError';
    this.code = code;
  }
}

/** Standard base64 (with padding) of `bytes`: the one spelling that goes into the signed bytes. */
export function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** The bytes of a base64 text, or `null` when it is not base64. */
export function decodeBase64(text: string): Uint8Array | null {
  try {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

/** Throws `MALFORMED` unless the entries are a list `deviceListSigningBytes` can encode. */
function checkEntries(devices: readonly DeviceListEntry[]): void {
  if (devices.length > MAX_DEVICES_PER_USER) {
    throw new DeviceListError(DEVICE_LIST_ERRORS.MALFORMED, 'too many devices');
  }
  const ids = new Set<string>();
  for (const device of devices) {
    if (ids.has(device.id)) {
      throw new DeviceListError(DEVICE_LIST_ERRORS.MALFORMED, 'duplicate device id');
    }
    ids.add(device.id);
    if (!isDeviceRole(device.role)) {
      throw new DeviceListError(DEVICE_LIST_ERRORS.MALFORMED, 'role');
    }
    if (decodeBase64(device.signatureKey)?.length !== ED25519_PUBLIC_KEY_BYTES) {
      throw new DeviceListError(DEVICE_LIST_ERRORS.MALFORMED, 'signature key');
    }
    const bound = device.conversationId !== undefined && device.conversationId !== '';
    if ((device.role === DeviceRole.ASSISTANT) !== bound) {
      throw new DeviceListError(DEVICE_LIST_ERRORS.MALFORMED, 'assistant conversation binding');
    }
  }
}

/** The exact bytes an owner signs: fixed key order, entries sorted by device id. */
export function deviceListSigningBytes(
  userId: string,
  version: number,
  devices: readonly DeviceListEntry[],
): Uint8Array {
  checkEntries(devices);
  const entries = [...devices]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((d) => ({
      id: d.id,
      role: d.role,
      // Re-encoded, so two spellings of the same key sign (and verify) as the same bytes.
      signatureKey: encodeBase64(decodeBase64(d.signatureKey) ?? new Uint8Array()),
      ...(d.conversationId ? { conversationId: d.conversationId } : {}),
    }));
  return new TextEncoder().encode(
    JSON.stringify({ format: DEVICE_LIST_FORMAT, userId, version, devices: entries }),
  );
}

/** A copy on its own ArrayBuffer (what WebCrypto's `BufferSource` type asks for). */
function own(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes);
}

/** The Ed25519 algorithm identifier WebCrypto takes. */
export function ed25519(): { name: string } {
  return { name: 'Ed25519' };
}

/** A list as an owner signs it: the entries, the version and the owner, plus the signature. */
export interface SignedDeviceListFields {
  readonly userId: string;
  readonly version: number;
  readonly devices: readonly DeviceListEntry[];
  readonly signature: Uint8Array;
}

/**
 * Checks that `list.signature` is `identityKey`'s Ed25519 signature over the canonical bytes of the
 * list, and answers those bytes (what a member pins to catch the same version with other contents).
 * Throws `DeviceListError`: `MALFORMED` for a version below 1 or entries that cannot be encoded,
 * `BAD_SIGNATURE` for a key or signature of the wrong size, a key WebCrypto cannot use, or a
 * signature that does not verify. It judges the signature only: whose list it is and whether it is
 * the newest are the caller's to judge.
 */
export async function verifyDeviceListSignature(
  identityKey: Uint8Array,
  list: SignedDeviceListFields,
): Promise<Uint8Array> {
  if (!Number.isInteger(list.version) || list.version < 1) {
    throw new DeviceListError(DEVICE_LIST_ERRORS.MALFORMED, 'version');
  }
  if (
    identityKey.length !== ED25519_PUBLIC_KEY_BYTES ||
    list.signature.length !== ED25519_SIGNATURE_BYTES
  ) {
    throw new DeviceListError(DEVICE_LIST_ERRORS.BAD_SIGNATURE);
  }
  const bytes = deviceListSigningBytes(list.userId, list.version, list.devices);
  let valid: boolean;
  try {
    const key = await crypto.subtle.importKey('raw', own(identityKey), ed25519(), false, [
      'verify',
    ]);
    valid = await crypto.subtle.verify(ed25519(), key, own(list.signature), own(bytes));
  } catch {
    // A 32-byte string that is not a point on the curve: no signature verifies under it.
    valid = false;
  }
  if (!valid) throw new DeviceListError(DEVICE_LIST_ERRORS.BAD_SIGNATURE);
  return bytes;
}
