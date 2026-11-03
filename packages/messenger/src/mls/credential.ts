import {
  CREDENTIAL_IDENTITY_VERSION,
  DEVICE_ROLE_CODES,
  DeviceRole,
  isDeviceRole,
} from '@masia/contracts/wire';
import { ID_PATTERN, MAX_ID_BYTES } from './constants.js';
import { fail, MlsEngineErrorCode } from './mls-error.js';

/**
 * What a device is to a room (internal ADR-117 §2 to §4, summarised in docs/adr/0001): USER,
 * GUARDIAN, ASSISTANT. Wire vocabulary with ONE home, `@masia/contracts/wire`, shared with the relay
 * (until 2026-10-10 a copy held by a parity test; the third role was then spelled after the
 * reference host's product, see `DeviceRole` there).
 */
export { CREDENTIAL_IDENTITY_VERSION, DeviceRole, isDeviceRole };

/** Whose device a leaf is, and in what capacity. The whole content of a leaf's credential. */
export interface DeviceIdentity {
  readonly userId: string;
  readonly deviceId: string;
  readonly role: DeviceRole;
}

/**
 * The identity lives in the BASIC CREDENTIAL of the leaf, not in a leaf extension.
 *
 * Why (security review 2026-10-10 §1): a leaf extension can be rewritten by the leaf's owner in
 * their own Update, so a guardian could silently drop a role badge kept there. The credential is
 * the one field a leaf update has to keep stable for the application to accept the update, and
 * the validator compares it with the previous leaf on every change (`ROLE_CHANGED`).
 *
 * Wire form (canonical: one byte string per identity, so equal identities compare byte-equal and
 * a decoder cannot be fed two spellings of one device):
 *
 *   u8 version = 1 · u8 role · u8 len(userId) · userId · u8 len(deviceId) · deviceId
 *
 * Ids are ASCII `[A-Za-z0-9_-]{1,128}` (the wire id alphabet), so a length fits one byte. The
 * version (`CREDENTIAL_IDENTITY_VERSION`) and the role bytes (`DEVICE_ROLE_CODES`) are wire
 * vocabulary from `@masia/contracts/wire`.
 */
const ROLE_CODES = DEVICE_ROLE_CODES;

const ROLE_BY_CODE: ReadonlyMap<number, DeviceRole> = new Map(
  (Object.entries(ROLE_CODES) as [DeviceRole, number][]).map(([role, code]) => [code, role]),
);

const HEADER_BYTES = 2; // version + role
const LENGTH_PREFIX_BYTES = 1;

export function isValidId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

// --- Ids as bytes: the one encoding every layout of the engine uses -----------------------------
// A valid id is ASCII (`ID_PATTERN`), so its bytes are its character codes and its length is at
// most `MAX_ID_BYTES`, which fits the one length byte every layout puts in front of it. Each layout
// (credential, AAD, state envelope, GroupContext extension) frames the bytes itself and turns a
// failure into its own error code; the encoding and the validity rule live only here.

/** The bytes of a valid id. A caller that has not checked `isValidId` first gets `INVALID_ARGUMENT`. */
export function encodeId(id: string): Uint8Array {
  if (!isValidId(id)) {
    throw fail(MlsEngineErrorCode.INVALID_ARGUMENT, 'An id is not a valid id.');
  }
  const out = new Uint8Array(id.length);
  for (let i = 0; i < id.length; i += 1) out[i] = id.charCodeAt(i);
  return out;
}

/** The id that `bytes` spell, or `undefined` when they do not spell a valid id (wrong length or alphabet). */
export function decodeId(bytes: Uint8Array): string | undefined {
  if (bytes.length === 0 || bytes.length > MAX_ID_BYTES) return undefined;
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return isValidId(text) ? text : undefined;
}

/** The canonical credential identity bytes of a device. Throws `CREDENTIAL_INVALID` on a bad id or role. */
export function encodeCredentialIdentity(identity: DeviceIdentity): Uint8Array {
  if (
    !isValidId(identity.userId) ||
    !isValidId(identity.deviceId) ||
    !isDeviceRole(identity.role)
  ) {
    throw fail(
      MlsEngineErrorCode.CREDENTIAL_INVALID,
      'The device identity is not a valid {userId, deviceId, role}.',
    );
  }
  const user = encodeId(identity.userId);
  const device = encodeId(identity.deviceId);
  const out = new Uint8Array(HEADER_BYTES + 2 * LENGTH_PREFIX_BYTES + user.length + device.length);
  let offset = 0;
  out[offset++] = CREDENTIAL_IDENTITY_VERSION;
  out[offset++] = ROLE_CODES[identity.role];
  out[offset++] = user.length;
  out.set(user, offset);
  offset += user.length;
  out[offset++] = device.length;
  out.set(device, offset);
  return out;
}

/**
 * Reads a credential identity back. Strict: wrong version, unknown role, an id outside the
 * alphabet, or any byte left over is `CREDENTIAL_INVALID`, so `encode(decode(b))` equals `b` for
 * every `b` that decodes.
 */
export function decodeCredentialIdentity(bytes: Uint8Array): DeviceIdentity {
  const invalid = (why: string) =>
    fail(MlsEngineErrorCode.CREDENTIAL_INVALID, `Credential identity: ${why}.`);
  if (bytes.length < HEADER_BYTES + 2 * LENGTH_PREFIX_BYTES) throw invalid('too short');
  if (bytes[0] !== CREDENTIAL_IDENTITY_VERSION) throw invalid('unknown version');
  const role = ROLE_BY_CODE.get(bytes[1] ?? 0);
  if (role === undefined) throw invalid('unknown role');

  let offset = HEADER_BYTES;
  const readId = (what: string): string => {
    const length = bytes[offset] ?? 0;
    offset += LENGTH_PREFIX_BYTES;
    if (offset + length > bytes.length) throw invalid(`${what} runs past the end`);
    const id = decodeId(bytes.subarray(offset, offset + length));
    offset += length;
    if (id === undefined) throw invalid(`${what} is not a valid id`);
    return id;
  };
  const userId = readId('userId');
  const deviceId = readId('deviceId');
  if (offset !== bytes.length) throw invalid('trailing bytes');
  return { userId, deviceId, role };
}

/** The slice of an MLS leaf this module reads. ts-mls's `LeafNode` satisfies it structurally. */
export interface LeafWithCredential {
  readonly credential: { readonly credentialType: string; readonly identity?: Uint8Array };
}

/** The identity a leaf's credential carries. Only the basic credential type is accepted. */
export function identityOf(leaf: LeafWithCredential): DeviceIdentity {
  const { credential } = leaf;
  if (credential.credentialType !== 'basic' || credential.identity === undefined) {
    throw fail(MlsEngineErrorCode.CREDENTIAL_INVALID, 'Only basic credentials are accepted.');
  }
  return decodeCredentialIdentity(credential.identity);
}
