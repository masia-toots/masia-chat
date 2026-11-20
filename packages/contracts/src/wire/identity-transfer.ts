/**
 * The identity transfer and «Це я» pairing (internal ADR-218 §1, §2, §5): the ONE home of their format
 * tags, sizes, lifetimes and canonical bytes, and of the checks the relay makes before it stores
 * anything. Every client and the relay import these; nobody keeps a copy.
 *
 * Who does what:
 *  - a NEW device N asks for the person's identity key with a request it signs with its own device key
 *    (`identityRequestBytes`); for `pair` the request carries a commitment to a nonce N reveals only
 *    after a holder has drawn its own (`pairingCommitment`);
 *  - a HOLDER B shows the person a number both screens derive (`pairingNumber`), which covers N's id,
 *    N's keys AND the identity key, so a relay that swaps any of them changes the number;
 *  - B seals the key to N's one-time key; the HPKE aad is `identityTransferAad` (the sealing itself is
 *    the messenger's: the relay never opens anything);
 *  - N proves it holds the key by signing a statement about itself with it (`holderStatementBytes`);
 *    the relay and every client check it with `verifyHolderProof` under the pinned key;
 *  - after an operator reset (ADR-218 §6) the device the ticket names pins the new key only with its
 *    device key's signature over it and the reset (`identityRebindBytes`), checked by the relay.
 *
 * Every canonical byte string is the UTF-8 of a JSON array of strings, bytes as standard base64: the
 * same shape as the 16-digit approval code's, and spelled out in ADR-218 § 2 "Formats". Golden vectors
 * pin them (`__tests__/identity-transfer.test.ts`).
 *
 * Pure data and pure functions over WebCrypto (SHA-256, Ed25519); no dependency, no I/O, no clock.
 */
import { ED25519_PUBLIC_KEY_BYTES, ED25519_SIGNATURE_BYTES, encodeBase64 } from './device-list.js';
import { verifyEd25519 } from './ed25519.js';
import { isWireId } from './vocabulary.js';

// --- Format tags -----------------------------------------------------------------------------------
// Generic on purpose, like `mls-device-list/v1`: no product name in a wire string.

/** The first element of the bytes a device signs to ask for the identity key. */
export const IDENTITY_REQUEST_FORMAT = 'mls-identity-request/v1';
/** The first element of the bytes N commits to before it sees the holder's nonce. */
export const PAIRING_COMMIT_FORMAT = 'mls-pairing-commit/v1';
/** The first element of the bytes the pairing number is derived from. */
export const PAIRING_NUMBER_FORMAT = 'mls-pairing-number/v1';
/** The first element of the statement a holder proof signs. */
export const IDENTITY_HOLDER_FORMAT = 'mls-identity-holder/v1';
/** The HPKE `info` of a sealed identity key, and the first element of its aad. */
export const IDENTITY_TRANSFER_FORMAT = 'mls-identity-transfer/v1';
/** The first element of the bytes the device an operator reset names signs to pin the new key. */
export const IDENTITY_REBIND_FORMAT = 'mls-identity-rebind/v1';

// --- The pairing number ----------------------------------------------------------------------------

/**
 * Digits of the number the person matches (founder, 2026-11-17: 2). A relay in the middle of a real
 * pairing wins once in `PAIRING_NUMBER_COUNT` visible attempts; the review trigger is 3 digits.
 */
export const PAIRING_NUMBER_DIGITS = 2;
/** Numbers the holder's sheet offers: the real one and `PAIRING_CHOICES - 1` decoys (Г1: 3). */
export const PAIRING_CHOICES = 3;
/** The smallest number: no leading zero, so every number shows as `PAIRING_NUMBER_DIGITS` digits. */
export const PAIRING_NUMBER_MIN = 10 ** (PAIRING_NUMBER_DIGITS - 1);
/** How many numbers there are (`PAIRING_NUMBER_MIN` … `PAIRING_NUMBER_MIN + COUNT - 1`). */
export const PAIRING_NUMBER_COUNT = 10 ** PAIRING_NUMBER_DIGITS - PAIRING_NUMBER_MIN;
/** Digest bytes reduced to the number: 64 bits mod 90 leaves a bias near 2^-58. */
const PAIRING_DIGEST_BYTES_USED = 8;

/** True for an integer a pairing can produce. */
export function isPairingNumber(value: unknown): value is number {
  return (
    Number.isInteger(value) &&
    (value as number) >= PAIRING_NUMBER_MIN &&
    (value as number) < PAIRING_NUMBER_MIN + PAIRING_NUMBER_COUNT
  );
}

// --- Sizes -----------------------------------------------------------------------------------------

/** N's one-time transfer key `T_N`: an X25519 public key (the KEM of MLS suite 1). */
export const TRANSFER_KEY_BYTES = 32;
/** `r_N` and `r_B`: the nonces each side of a pairing draws. */
export const PAIRING_NONCE_BYTES = 32;
/** The commitment: a SHA-256 digest. */
export const PAIRING_COMMITMENT_BYTES = 32;
/** The HPKE encapsulated key of a sealed identity (X25519). */
export const SEALED_IDENTITY_ENC_BYTES = 32;
/**
 * The largest identity private key a holder seals. WebCrypto exports an Ed25519 key as a 48-byte
 * PKCS#8; the cap leaves room for a PKCS#8 that also carries its public key, and no more.
 */
export const IDENTITY_KEY_PKCS8_MAX_BYTES = 128;
/** The AES-128-GCM tag HPKE appends. */
const AEAD_TAG_BYTES = 16;
/** The largest sealed ciphertext the relay stores. */
export const SEALED_IDENTITY_MAX_BYTES = IDENTITY_KEY_PKCS8_MAX_BYTES + AEAD_TAG_BYTES;

// --- Lifetimes and caps ----------------------------------------------------------------------------

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** A request lives this long from creation, the number step included. N does not renew by itself. */
export const IDENTITY_REQUEST_TTL_MS = 10 * MINUTE_MS;
/** Open requests one account may have at once (`429 IDENTITY_REQUEST_LIMIT` beyond). */
export const IDENTITY_REQUEST_OPEN_LIMIT = 3;
/** Requests one account may create in `IDENTITY_REQUEST_LIMIT_WINDOW_MS`. */
export const IDENTITY_REQUEST_DAILY_LIMIT = 10;
/** The window `IDENTITY_REQUEST_DAILY_LIMIT` is counted in. */
export const IDENTITY_REQUEST_LIMIT_WINDOW_MS = DAY_MS;
/** A sealed key nobody fetched is purged this long after approval (sooner: on N's holder proof). */
export const SEALED_IDENTITY_TTL_MS = DAY_MS;
/** A rejected request stays readable to the person's devices this long, so each can say so once. */
export const REJECTED_IDENTITY_REQUEST_TTL_MS = DAY_MS;
/**
 * An operator reset's ticket (ADR-218 §6) lets its named device pin this long after the reset. Later it
 * counts as superseded: nobody pins (409 IDENTITY_RESET_PENDING) until the operator resets again. The
 * reset is run while the person has that device in hand, so a day is plenty.
 */
export const IDENTITY_RESET_TICKET_TTL_MS = DAY_MS;

// --- Purposes --------------------------------------------------------------------------------------

/**
 * Why a device asks. `pair`: a new device the person confirms by number. `backfill`: a device already
 * on the person's verified list that lacks the key; a holder serves it without a prompt (ADR-218 §4).
 * The value goes into the signed bytes.
 */
export const IdentityRequestPurpose = {
  PAIR: 'pair',
  BACKFILL: 'backfill',
} as const;
export type IdentityRequestPurpose =
  (typeof IdentityRequestPurpose)[keyof typeof IdentityRequestPurpose];

/** True for one of the two purpose strings. */
export function isIdentityRequestPurpose(value: unknown): value is IdentityRequestPurpose {
  return value === IdentityRequestPurpose.PAIR || value === IdentityRequestPurpose.BACKFILL;
}

// --- Refusals --------------------------------------------------------------------------------------

export const IDENTITY_TRANSFER_ERRORS = {
  /** Input the canonical bytes cannot encode: an id, a size, a purpose without its commitment. */
  MALFORMED: 'MALFORMED',
  /** A sealed key that does not open, or opens to a key that does not verify under the pin. */
  INVALID: 'INVALID',
} as const;
export type IdentityTransferErrorCode =
  (typeof IDENTITY_TRANSFER_ERRORS)[keyof typeof IDENTITY_TRANSFER_ERRORS];

export class IdentityTransferError extends Error {
  readonly code: IdentityTransferErrorCode;
  constructor(code: IdentityTransferErrorCode, detail?: string) {
    super(`identity transfer: ${code}${detail ? ` (${detail})` : ''}`);
    this.name = 'IdentityTransferError';
    this.code = code;
  }
}

// --- What the bytes are built from ----------------------------------------------------------------

/** A device as a holder statement names it: its owner, its id and its MLS signature public key. */
export interface HolderStatement {
  readonly userId: string;
  readonly deviceId: string;
  /** The device's registered MLS signature public key (raw Ed25519). */
  readonly signatureKey: Uint8Array;
}

/** The new device N of a pairing: its holder statement fields plus its one-time transfer key. */
export interface PairingDevice extends HolderStatement {
  /** `T_N`, raw X25519. */
  readonly transferKey: Uint8Array;
}

/** What N commits to: itself and its nonce `r_N`. */
export interface PairingCommitInput extends PairingDevice {
  readonly deviceNonce: Uint8Array;
}

/** What the number covers: N, the identity public key `IK`, and both nonces. */
export interface PairingNumberInput extends PairingCommitInput {
  /** The person's identity public key as this side pinned it (raw Ed25519). */
  readonly identityKey: Uint8Array;
  /** `r_B`, drawn by the holder that challenged. */
  readonly holderNonce: Uint8Array;
}

/** What a sealed identity key is bound to: the HPKE aad. */
export interface IdentityTransferBinding extends PairingDevice {
  readonly identityKey: Uint8Array;
  /** The list version that carries N (for backfill: the current version). */
  readonly listVersion: number;
}

/**
 * What the device an operator reset names signs, with its registered device key, to pin the person's
 * new identity key: proof that the caller holds that device, not only a session that names its id.
 */
export interface IdentityRebindFields {
  readonly userId: string;
  readonly deviceId: string;
  /** The new identity public key it pins (raw Ed25519). */
  readonly identityKey: Uint8Array;
  /** The reset whose ticket it uses (`identity_resets.id`), so a signature never serves another reset. */
  readonly resetId: string;
}

/** The request N signs with its device key. */
export interface IdentityRequestFields {
  readonly userId: string;
  readonly deviceId: string;
  readonly purpose: IdentityRequestPurpose;
  readonly transferKey: Uint8Array;
  /** The pairing commitment: present for `pair`, absent for `backfill`. */
  readonly commitment?: Uint8Array;
}

// --- Canonical bytes -------------------------------------------------------------------------------

function malformed(detail: string): IdentityTransferError {
  return new IdentityTransferError(IDENTITY_TRANSFER_ERRORS.MALFORMED, detail);
}

function ids(userId: string, deviceId: string): void {
  if (!isWireId(userId)) throw malformed('user id');
  if (!isWireId(deviceId)) throw malformed('device id');
}

function sized(bytes: Uint8Array, length: number, what: string): string {
  if (!(bytes instanceof Uint8Array) || bytes.length !== length) throw malformed(what);
  return encodeBase64(bytes);
}

function canonical(parts: readonly string[]): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(parts));
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)));
}

/** Equal bytes, compared without an early exit. */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return difference === 0;
}

/** The fields of N that every pairing string carries, in their order. */
function pairingDeviceParts(device: PairingDevice): string[] {
  ids(device.userId, device.deviceId);
  return [
    device.userId,
    device.deviceId,
    sized(device.signatureKey, ED25519_PUBLIC_KEY_BYTES, 'signature key'),
    sized(device.transferKey, TRANSFER_KEY_BYTES, 'transfer key'),
  ];
}

/**
 * `JSON["mls-identity-request/v1", userId, deviceId, purpose, b64 T_N, b64 commitment | ""]`: the
 * bytes N signs with its device key. Throws `MALFORMED` for a `pair` without a commitment or a
 * `backfill` with one.
 */
export function identityRequestBytes(fields: IdentityRequestFields): Uint8Array {
  ids(fields.userId, fields.deviceId);
  if (!isIdentityRequestPurpose(fields.purpose)) throw malformed('purpose');
  const pair = fields.purpose === IdentityRequestPurpose.PAIR;
  if (pair !== (fields.commitment !== undefined)) throw malformed('commitment for the purpose');
  return canonical([
    IDENTITY_REQUEST_FORMAT,
    fields.userId,
    fields.deviceId,
    fields.purpose,
    sized(fields.transferKey, TRANSFER_KEY_BYTES, 'transfer key'),
    fields.commitment === undefined
      ? ''
      : sized(fields.commitment, PAIRING_COMMITMENT_BYTES, 'commitment'),
  ]);
}

/**
 * True when `signature` is the device key `signatureKey`'s signature over the request. The relay takes
 * the key from the registered row; a holder takes it from the row for `pair` (the number vouches) and
 * from the member-verified list entry for `backfill`. Anything malformed is `false`.
 */
export async function verifyIdentityRequestSignature(
  signatureKey: Uint8Array,
  fields: IdentityRequestFields,
  signature: Uint8Array,
): Promise<boolean> {
  if (
    signatureKey.length !== ED25519_PUBLIC_KEY_BYTES ||
    signature.length !== ED25519_SIGNATURE_BYTES
  ) {
    return false;
  }
  let bytes: Uint8Array;
  try {
    bytes = identityRequestBytes(fields);
  } catch {
    return false;
  }
  return verifyEd25519(signatureKey, signature, bytes);
}

/** `SHA-256(JSON["mls-pairing-commit/v1", userId, deviceId, b64 sigKey_N, b64 T_N, b64 r_N])`. */
export async function pairingCommitment(input: PairingCommitInput): Promise<Uint8Array> {
  return sha256(
    canonical([
      PAIRING_COMMIT_FORMAT,
      ...pairingDeviceParts(input),
      sized(input.deviceNonce, PAIRING_NONCE_BYTES, 'device nonce'),
    ]),
  );
}

/** True when `commitment` is N's commitment to `input.deviceNonce`. Anything malformed is `false`. */
export async function verifyPairingCommitment(
  input: PairingCommitInput,
  commitment: Uint8Array,
): Promise<boolean> {
  let expected: Uint8Array;
  try {
    expected = await pairingCommitment(input);
  } catch {
    return false;
  }
  return sameBytes(expected, commitment);
}

/**
 * The number both screens show: `PAIRING_NUMBER_MIN + (the first 8 bytes of SHA-256(JSON[
 * "mls-pairing-number/v1", userId, deviceId, b64 sigKey_N, b64 T_N, b64 IK, b64 r_N, b64 r_B]) as a
 * big-endian integer mod PAIRING_NUMBER_COUNT)`.
 */
export async function pairingNumber(input: PairingNumberInput): Promise<number> {
  const digest = await sha256(
    canonical([
      PAIRING_NUMBER_FORMAT,
      ...pairingDeviceParts(input),
      sized(input.identityKey, ED25519_PUBLIC_KEY_BYTES, 'identity key'),
      sized(input.deviceNonce, PAIRING_NONCE_BYTES, 'device nonce'),
      sized(input.holderNonce, PAIRING_NONCE_BYTES, 'holder nonce'),
    ]),
  );
  let value = 0n;
  for (const byte of digest.subarray(0, PAIRING_DIGEST_BYTES_USED)) {
    value = (value << 8n) | BigInt(byte);
  }
  return PAIRING_NUMBER_MIN + Number(value % BigInt(PAIRING_NUMBER_COUNT));
}

/** `JSON["mls-identity-holder/v1", userId, deviceId, b64 sigKey]`: what a holder proof signs. */
export function holderStatementBytes(statement: HolderStatement): Uint8Array {
  ids(statement.userId, statement.deviceId);
  return canonical([
    IDENTITY_HOLDER_FORMAT,
    statement.userId,
    statement.deviceId,
    sized(statement.signatureKey, ED25519_PUBLIC_KEY_BYTES, 'signature key'),
  ]);
}

/**
 * True when `proof` is the identity key `identityKey`'s signature over the device's holder statement:
 * only a device that holds the private key can make one. Anything malformed is `false`.
 */
export async function verifyHolderProof(
  identityKey: Uint8Array,
  statement: HolderStatement,
  proof: Uint8Array,
): Promise<boolean> {
  if (identityKey.length !== ED25519_PUBLIC_KEY_BYTES || proof.length !== ED25519_SIGNATURE_BYTES) {
    return false;
  }
  let bytes: Uint8Array;
  try {
    bytes = holderStatementBytes(statement);
  } catch {
    return false;
  }
  return verifyEd25519(identityKey, proof, bytes);
}

/**
 * `JSON["mls-identity-rebind/v1", userId, deviceId, b64 IK_new, resetId]`: what the device an operator
 * reset names signs, with its device key, to pin `IK_new`.
 */
export function identityRebindBytes(fields: IdentityRebindFields): Uint8Array {
  ids(fields.userId, fields.deviceId);
  if (!isWireId(fields.resetId)) throw malformed('reset id');
  return canonical([
    IDENTITY_REBIND_FORMAT,
    fields.userId,
    fields.deviceId,
    sized(fields.identityKey, ED25519_PUBLIC_KEY_BYTES, 'identity key'),
    fields.resetId,
  ]);
}

/**
 * True when `signature` is the device key `signatureKey`'s signature over the rebind. The relay takes
 * the key from the device's registered row. Anything malformed is `false`.
 */
export async function verifyIdentityRebindSignature(
  signatureKey: Uint8Array,
  fields: IdentityRebindFields,
  signature: Uint8Array,
): Promise<boolean> {
  if (
    signatureKey.length !== ED25519_PUBLIC_KEY_BYTES ||
    signature.length !== ED25519_SIGNATURE_BYTES
  ) {
    return false;
  }
  let bytes: Uint8Array;
  try {
    bytes = identityRebindBytes(fields);
  } catch {
    return false;
  }
  return verifyEd25519(signatureKey, signature, bytes);
}

/**
 * `JSON["mls-identity-transfer/v1", userId, deviceId_N, b64 sigKey_N, b64 T_N, b64 IK, listVersion]`:
 * the HPKE aad of a sealed identity key. Changing any field makes the open fail.
 */
export function identityTransferAad(binding: IdentityTransferBinding): Uint8Array {
  if (!Number.isInteger(binding.listVersion) || binding.listVersion < 1) {
    throw malformed('list version');
  }
  return canonical([
    IDENTITY_TRANSFER_FORMAT,
    ...pairingDeviceParts(binding),
    sized(binding.identityKey, ED25519_PUBLIC_KEY_BYTES, 'identity key'),
    String(binding.listVersion),
  ]);
}
