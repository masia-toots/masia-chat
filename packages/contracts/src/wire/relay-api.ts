import type { DeviceRole } from './vocabulary.js';

/**
 * The relay's HTTP surface as a CLIENT reads it: the refusal codes it answers with, the shape of one
 * entry of a signed device list, the page cap of its read routes, the key-package upload budget a
 * client must pace itself by, the device label limit, and the facts of the two answers a client acts
 * on (a pinned identity key, a claim narrowed to devices). ONE home for every reader (architecture review round 2, M6/M14): the
 * custody worker and the hub used to import these from the AGPL relay library, which made a host
 * depend on the relay to speak to it.
 *
 * Re-exported from `./index.ts` (TODO-505, 2026-10-10): the relay library no longer keeps copies, it
 * takes these from here like every other reader. The subpath `@masia/contracts/wire/relay-api` stays a
 * valid alias.
 *
 * Pure data, no dependency.
 */

// --- Refusals --------------------------------------------------------------------------------------

/**
 * Every way the relay refuses a request: a stable machine code in the `error` field of the answer.
 * The HTTP status each travels under is the relay's (`RELAY_ERROR_STATUS` in `@masia/relay`); a client
 * branches on the code.
 */
export const RelayErrorCode = {
  // 400 / 401
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  // 403
  ACTOR_DEVICE_UNKNOWN: 'ACTOR_DEVICE_UNKNOWN',
  ACTOR_DEVICE_REVOKED: 'ACTOR_DEVICE_REVOKED',
  NOT_A_MEMBER: 'NOT_A_MEMBER',
  /** The device WAS a member and has been removed; it may still read what it was there for. */
  REMOVED: 'REMOVED',
  DEVICE_MISMATCH: 'DEVICE_MISMATCH',
  GUARDIAN_REMOVE_FORBIDDEN: 'GUARDIAN_REMOVE_FORBIDDEN',
  ROLE_FORBIDDEN: 'ROLE_FORBIDDEN',
  REVOKE_FORBIDDEN: 'REVOKE_FORBIDDEN',
  DEVICE_OWNED_BY_OTHER: 'DEVICE_OWNED_BY_OTHER',
  /** The caller shares no room with the user whose devices it asked for. */
  NOT_A_CONTACT: 'NOT_A_CONTACT',
  // 404
  DEVICE_LIST_NOT_FOUND: 'DEVICE_LIST_NOT_FOUND',
  NOT_FOUND: 'NOT_FOUND',
  // 409
  EPOCH_CONFLICT: 'EPOCH_CONFLICT',
  DEVICE_LIST_VERSION_CONFLICT: 'DEVICE_LIST_VERSION_CONFLICT',
  STILL_IN_ROOMS: 'STILL_IN_ROOMS',
  CONVERSATION_EXISTS: 'CONVERSATION_EXISTS',
  DEVICE_IDENTITY_IMMUTABLE: 'DEVICE_IDENTITY_IMMUTABLE',
  /** A `clientMsgId` this sender already used, with a different ciphertext. */
  CLIENT_MSG_ID_REUSED: 'CLIENT_MSG_ID_REUSED',
  KEY_PACKAGE_POOL_FULL: 'KEY_PACKAGE_POOL_FULL',
  /**
   * A USER or ASSISTANT device registered with an identity key other than the one pinned for its
   * account: one account has ONE identity key across all its USER and ASSISTANT devices (a person's
   * key; for the operator, the operator key). Not a silent overwrite: the pin is released only by the
   * explicit reset (`DELETE /users/{userId}/identity-key`). The answer carries the pinned key
   * (`IdentityKeyChangedBody`).
   */
  IDENTITY_KEY_CHANGED: 'IDENTITY_KEY_CHANGED',
  /** The identity-key reset was asked while the account still has an active USER or ASSISTANT device. */
  IDENTITY_KEY_IN_USE: 'IDENTITY_KEY_IN_USE',
  // 413 / 415
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  UNSUPPORTED_MEDIA_TYPE: 'UNSUPPORTED_MEDIA_TYPE',
  // 422
  DEVICE_NOT_IN_SIGNED_LIST: 'DEVICE_NOT_IN_SIGNED_LIST',
  DEVICE_REVOKED: 'DEVICE_REVOKED',
  LAST_RESORT_REQUIRED: 'LAST_RESORT_REQUIRED',
  ALREADY_MEMBER: 'ALREADY_MEMBER',
  REMOVE_TARGET_NOT_MEMBER: 'REMOVE_TARGET_NOT_MEMBER',
  INVALID_MEMBER_DELTA: 'INVALID_MEMBER_DELTA',
  MLS_HEADER_MISMATCH: 'MLS_HEADER_MISMATCH',
  KEY_PACKAGE_NOT_CLAIMED_BY_COMMITTER: 'KEY_PACKAGE_NOT_CLAIMED_BY_COMMITTER',
  HANDSHAKE_KIND_UNSUPPORTED: 'HANDSHAKE_KIND_UNSUPPORTED',
  KEY_PACKAGE_UNREADABLE: 'KEY_PACKAGE_UNREADABLE',
  KEY_PACKAGE_EXPIRED: 'KEY_PACKAGE_EXPIRED',
  /** A device-list entry breaks a binding rule: a `conversationId` on an entry that is not ASSISTANT. */
  DEVICE_LIST_ENTRY_INVALID: 'DEVICE_LIST_ENTRY_INVALID',
  /**
   * A device-list upload whose signature does not verify under the identity key pinned for the
   * account, or an account with no pinned key to verify it under. The relay checks the signature
   * before it stores a version, because a version no member can verify would block every reader of
   * the list for good (`verifyDeviceListSignature`, `mls-device-list/v1`).
   */
  DEVICE_LIST_SIGNATURE_INVALID: 'DEVICE_LIST_SIGNATURE_INVALID',
  // 429
  REBASE_LIMIT: 'REBASE_LIMIT',
  CLAIM_RATE_LIMITED: 'CLAIM_RATE_LIMITED',
  UPLOAD_RATE_LIMITED: 'UPLOAD_RATE_LIMITED',
  ACTOR_RATE_LIMITED: 'ACTOR_RATE_LIMITED',
  TARGET_RATE_LIMITED: 'TARGET_RATE_LIMITED',
  // 500 / 503
  INTERNAL: 'INTERNAL',
  /** The room's row stayed locked past the lock timeout; retry after `Retry-After`. */
  ROOM_BUSY: 'ROOM_BUSY',
} as const;
export type RelayErrorCode = (typeof RelayErrorCode)[keyof typeof RelayErrorCode];

// --- Device lists ----------------------------------------------------------------------------------

/**
 * One device in a user's signed `DeviceList` (ADR-117 §2a). The user's identity key signs the whole
 * list on the client; the relay stores it as given and never signs or re-orders it. `signatureKey` is
 * the device's MLS signature public key, base64, so a leaf can be matched to the list.
 *
 * `conversationId` binds an ASSISTANT entry to the one room it serves, and is part of the signed bytes
 * (`mls-device-list/v1`); the relay accepts it on an ASSISTANT entry only (422 DEVICE_LIST_ENTRY_INVALID
 * otherwise) and serves it back unchanged, so the client's verifier rebuilds exactly the bytes that
 * were signed.
 */
export interface DeviceListEntry {
  readonly id: string;
  readonly role: DeviceRole;
  readonly signatureKey: string;
  readonly conversationId?: string;
}

/** One stored version of a user's signed list, as `GET /users/{userId}/device-list/versions` serves it. */
export interface DeviceListVersion {
  readonly userId: string;
  readonly version: number;
  readonly devices: readonly DeviceListEntry[];
  /** The owner's signature (base64) over the `mls-device-list/v1` bytes of this version. */
  readonly signature: string;
}

/**
 * The most versions one page of `GET /users/{userId}/device-list/versions` returns. The relay keeps
 * every version (append-only), so a member that pinned version N reads every newer one and checks the
 * chain; a user rarely changes their list, so one page is almost always the whole tail.
 */
export const DEVICE_LIST_VERSIONS_PAGE_MAX = 64;

// --- Devices ---------------------------------------------------------------------------------------

/**
 * The longest `name` or `platform` label of a device, in characters (`POST /devices`; a longer one is
 * 400 VALIDATION_FAILED). A label is for a person to tell their devices apart, never an identity, so a
 * client trims to this before it registers; the relay enforces the same number.
 */
export const MAX_DEVICE_TEXT_LENGTH = 128;

/**
 * The body of a 409 IDENTITY_KEY_CHANGED (ADR-117 amendments (м), (о), TODO-507, TODO-518). An account
 * has ONE identity key across its USER and ASSISTANT devices (a person's USER devices; the operator's
 * ASSISTANT devices, whose key is the operator key), pinned by the first one; a later device of either
 * role that registers with another key is refused, and the refusal carries the pinned key. That is how
 * a second device learns the key to register with BEFORE it is registered (it cannot list its own
 * user's devices until it is): it retries `POST /devices` with `identityKeyPub` as given here.
 *
 * `identityKeyPub` is the account's own pin, base64 of the raw public key (Ed25519: 32 bytes), and
 * only the account's own token reaches this refusal: a USER device is registered only for the token's
 * `sub`, and an ASSISTANT device only by the operator for itself, so the key in the answer is the
 * caller's own. It is a PUBLIC key, which a correspondent reads from `GET /users/{userId}/devices`
 * anyway.
 */
export interface IdentityKeyChangedBody {
  readonly error: typeof RelayErrorCode.IDENTITY_KEY_CHANGED;
  readonly message: string;
  readonly identityKeyPub: string;
}

// --- Key-package claims ----------------------------------------------------------------------------

/**
 * The body of `POST /key-packages/claim` (ADR-117 amendment (м), TODO-513). Without `deviceIds` the
 * relay hands out one package per ACTIVE device of `userId`, as it always has. With them it hands
 * out packages only for those devices, so a client that wants ONE device of a person (the assistant's
 * device of one room, a device missing from a room's tree) does not burn a package of each of the
 * person's other devices.
 *
 * `deviceIds` is a FILTER over the user's active devices, not a demand: an id that is unknown,
 * revoked, another person's, or has no package to give is simply absent from the answer (the same
 * answer for each, so the claim reveals nothing the contact gate does not already allow). Compare the
 * answer's `deviceId`s with what you asked for. 1 to `MAX_DEVICES_PER_USER` ids (a repeated id counts
 * once); an empty list is 400, never "all". The contact gate and the rate limits are those of a claim
 * without it, and the answer is the same `{ rows, nextCursor }`, oldest device first.
 */
export interface ClaimKeyPackagesRequest {
  readonly userId: string;
  readonly deviceIds?: readonly string[];
}

// --- Paging ----------------------------------------------------------------------------------------

/** The most rows one page of a relay read route returns, whatever `limit` the client asked for. */
export const PAGE_MAX = 500;

// --- Busy rooms ------------------------------------------------------------------------------------

/**
 * The `Retry-After` (seconds) of a 503 ROOM_BUSY: the room's row stayed locked past the relay's lock
 * timeout. A client honours the header; this is its value, for a client whose transport lost it.
 */
export const ROOM_BUSY_RETRY_AFTER_SECONDS = 1;

// --- Key-package uploads ---------------------------------------------------------------------------
// A client that tops its pool up faster than this is answered 429 UPLOAD_RATE_LIMITED with
// `Retry-After`. Every device of one user shares the user budget: a host that runs many devices under
// one account (an operator's assistant devices) must pace them together.

/** The window both upload budgets are counted in. */
export const KEY_PACKAGE_UPLOAD_WINDOW_MS = 10 * 60_000;
/** Uploads one device may make in a window. */
export const KEY_PACKAGE_UPLOAD_DEVICE_LIMIT = 20;
/** Uploads all devices of one user together may make in a window. */
export const KEY_PACKAGE_UPLOAD_USER_LIMIT = 60;
/**
 * Unclaimed ordinary key packages one device may hold at once (more is 409 KEY_PACKAGE_POOL_FULL). A
 * client tops its pool up to a few dozen; the cap stops a device (or a stolen token) filling the
 * relay's disk.
 */
export const MAX_UNCLAIMED_KEY_PACKAGES_PER_DEVICE = 200;
