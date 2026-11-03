/**
 * Signed device lists: the ONE format and the ONE verifier (canon section 3, ADR-117 amendment (і);
 * round 2, arch-M3). Every member (a person's hub, an assistant worker) verifies a list with
 * `verifyDeviceList` before the engine sees it as a `VerifiedDeviceList`; nobody keeps a second copy.
 *
 * The format itself, the canonical signed bytes and the signature check have ONE home,
 * `@masia/contracts/wire` (`deviceListSigningBytes`, `verifyDeviceListSignature`), because the relay
 * checks the same signature before it stores a version (a version no member would accept would block
 * every reader of the list). This module adapts it to the engine's types (`ListedDevice` carries the
 * signature key as bytes, the wire entry as base64) and adds what only a MEMBER can judge: whose list
 * it is and whether it is older than what the member already pinned.
 *
 * A person's list is signed by their long-lived IDENTITY key (Ed25519, raw 32-byte public key); an
 * operator's assistant list by the operator key, which plays the same part. An ASSISTANT entry carries
 * its `conversationId` INSIDE the signed bytes (the binding the engine checks); a USER or GUARDIAN
 * entry never does.
 *
 * What the verifier refuses (a typed `DeviceListError`, never a silent pass):
 *  - a signature that does not verify under the pinned identity key (`BAD_SIGNATURE`);
 *  - a list of another owner (`OWNER_MISMATCH`);
 *  - a version below the pinned one, or the same version with other contents (`ROLLBACK`): a relay
 *    cannot serve an older list to resurrect a removed device;
 *  - malformed entries: duplicate ids, too many devices, an ASSISTANT without its conversation, a
 *    USER/GUARDIAN with one, a key that is not 32 bytes (`MALFORMED`).
 *
 * Uses WebCrypto Ed25519 (browsers, Workers and Node alike); no third-party dependency.
 */
import {
  type DeviceListEntry,
  DEVICE_LIST_ERRORS,
  DeviceListError,
  deviceListSigningBytes as wireDeviceListSigningBytes,
  ed25519,
  encodeBase64,
  verifyDeviceListSignature,
} from '@masia/contracts/wire';
import type { ListedDevice, VerifiedDeviceList } from './mls-engine.js';

export {
  DEVICE_LIST_ERRORS,
  DEVICE_LIST_FORMAT,
  DeviceListError,
  type DeviceListErrorCode,
} from '@masia/contracts/wire';

/** A list as the relay serves it: the entries, the version, and the owner's signature over them. */
export interface SignedDeviceList {
  readonly userId: string;
  readonly version: number;
  readonly devices: readonly ListedDevice[];
  readonly signature: Uint8Array;
}

/** What a member pinned for an owner: the identity key (trust on first use) and the newest version seen. */
export interface DeviceListPin {
  readonly identityKey: Uint8Array;
  readonly version: number;
  /** The signed bytes of that version, so the same version with other contents is caught. */
  readonly signingBytes?: Uint8Array;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** The wire form of the engine's entries: what the relay stores and the signed bytes are built from. */
function wireEntries(devices: readonly ListedDevice[]): DeviceListEntry[] {
  return devices.map((d) => ({
    id: d.deviceId,
    role: d.role,
    signatureKey: encodeBase64(d.signatureKey),
    ...(d.conversationId ? { conversationId: d.conversationId } : {}),
  }));
}

/** The exact bytes an owner signs: fixed key order, entries sorted by device id. */
export function deviceListSigningBytes(
  userId: string,
  version: number,
  devices: readonly ListedDevice[],
): Uint8Array {
  return wireDeviceListSigningBytes(userId, version, wireEntries(devices));
}

/** A copy on its own ArrayBuffer (what WebCrypto's `BufferSource` type asks for). */
function own(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes);
}

/** A fresh identity key pair (Ed25519). The private half is extractable only so the host can store it. */
export async function generateIdentityKeyPair(): Promise<{
  readonly publicKey: Uint8Array;
  readonly privateKeyPkcs8: Uint8Array;
}> {
  const pair = (await crypto.subtle.generateKey(ed25519(), true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const privateKeyPkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  return { publicKey, privateKeyPkcs8 };
}

/** Signs `DeviceList v<version>` with the owner's identity key (PKCS#8 Ed25519 private key). */
export async function signDeviceList(
  privateKeyPkcs8: Uint8Array,
  list: Omit<SignedDeviceList, 'signature'>,
): Promise<SignedDeviceList> {
  const key = await crypto.subtle.importKey('pkcs8', own(privateKeyPkcs8), ed25519(), false, [
    'sign',
  ]);
  const bytes = deviceListSigningBytes(list.userId, list.version, list.devices);
  const signature = new Uint8Array(await crypto.subtle.sign(ed25519(), key, own(bytes)));
  return { ...list, signature };
}

/**
 * Verifies a served list against the owner's pinned identity key and newest pinned version. Answers
 * the verified list (for the engine) and the pin to store next; throws `DeviceListError` otherwise.
 */
export async function verifyDeviceList(
  expectedUserId: string,
  served: SignedDeviceList,
  pin: DeviceListPin,
): Promise<{ readonly list: VerifiedDeviceList; readonly pin: DeviceListPin }> {
  if (served.userId !== expectedUserId) {
    throw new DeviceListError(DEVICE_LIST_ERRORS.OWNER_MISMATCH);
  }
  const bytes = await verifyDeviceListSignature(pin.identityKey, {
    userId: served.userId,
    version: served.version,
    devices: wireEntries(served.devices),
    signature: served.signature,
  });
  if (served.version < pin.version) throw new DeviceListError(DEVICE_LIST_ERRORS.ROLLBACK);
  if (
    served.version === pin.version &&
    pin.signingBytes !== undefined &&
    !sameBytes(pin.signingBytes, bytes)
  ) {
    throw new DeviceListError(DEVICE_LIST_ERRORS.ROLLBACK, 'same version, other contents');
  }
  return {
    list: { userId: served.userId, version: served.version, devices: [...served.devices] },
    pin: { identityKey: pin.identityKey, version: served.version, signingBytes: bytes },
  };
}
