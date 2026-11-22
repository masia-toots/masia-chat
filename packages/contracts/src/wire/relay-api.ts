import type { IdentityRequestPurpose } from './identity-transfer.js';
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
  /**
   * An identity-request action only a key holder may take (challenge, approve, reject): the caller is
   * not an unrevoked listed USER device of the account with a valid holder proof (ADR-218 §2, §5).
   */
  NOT_A_HOLDER: 'NOT_A_HOLDER',
  /**
   * The call channel (`call-relay.ts`) takes only a USER device, in a room whose current members are
   * USER devices of exactly two people, signalling a USER device of the OTHER person in that room.
   */
  CALL_NOT_ALLOWED: 'CALL_NOT_ALLOWED',
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
   * key; for the operator, the operator key). Not a silent overwrite: the pin is released only by a
   * reset, the family admin's (`DELETE /users/{userId}/identity-key`) or the relay operator's
   * (ADR-218 §6). The answer carries the pinned key (`IdentityKeyChangedBody`).
   */
  IDENTITY_KEY_CHANGED: 'IDENTITY_KEY_CHANGED',
  /** The identity-key reset was asked while the account still has an active USER or ASSISTANT device. */
  IDENTITY_KEY_IN_USE: 'IDENTITY_KEY_IN_USE',
  /**
   * An identity request in the wrong state for the action: a second challenge, a reveal before the
   * challenge, an approve before the reveal, or any action on an expired, approved or rejected one.
   */
  IDENTITY_REQUEST_STATE: 'IDENTITY_REQUEST_STATE',
  /**
   * An operator reset of the identity key is open, and only the device it names may pin the new key
   * (ADR-218 §6). The hub drops its provisional key and waits.
   */
  IDENTITY_RESET_PENDING: 'IDENTITY_RESET_PENDING',
  /**
   * The device an operator reset names offered a new identity key without its device key's signature
   * over it and the reset (`identityRebindBytes`), or with one that does not verify. The answer carries
   * the open reset's id (`IdentityRebindProofRequiredBody`): sign it and register again, once.
   */
  IDENTITY_REBIND_PROOF_REQUIRED: 'IDENTITY_REBIND_PROOF_REQUIRED',
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
  /**
   * An identity request whose signature does not verify under the requesting device's registered key
   * (`verifyIdentityRequestSignature`), or a reveal whose nonce does not open the commitment.
   */
  IDENTITY_REQUEST_SIGNATURE_INVALID: 'IDENTITY_REQUEST_SIGNATURE_INVALID',
  /** A holder proof that does not verify under the account's pinned identity key (`verifyHolderProof`). */
  HOLDER_PROOF_INVALID: 'HOLDER_PROOF_INVALID',
  // 429
  /**
   * An identity request over a cap: `IDENTITY_REQUEST_OPEN_LIMIT` open, or `IDENTITY_REQUEST_DAILY_LIMIT`
   * in a window. A rule, not load: a client does not retry it.
   */
  IDENTITY_REQUEST_LIMIT: 'IDENTITY_REQUEST_LIMIT',
  REBASE_LIMIT: 'REBASE_LIMIT',
  CLAIM_RATE_LIMITED: 'CLAIM_RATE_LIMITED',
  UPLOAD_RATE_LIMITED: 'UPLOAD_RATE_LIMITED',
  ACTOR_RATE_LIMITED: 'ACTOR_RATE_LIMITED',
  TARGET_RATE_LIMITED: 'TARGET_RATE_LIMITED',
  // 500 / 503
  INTERNAL: 'INTERNAL',
  /** The room's row stayed locked past the lock timeout; retry after `Retry-After`. */
  ROOM_BUSY: 'ROOM_BUSY',
  /** The relay holds as many open call streams as it takes (per person or in all); retry after `Retry-After`. */
  CALL_STREAMS_FULL: 'CALL_STREAMS_FULL',
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
 * A device as its owner (or a family admin) reads it: the FULL view of `GET /users/{userId}/devices`,
 * and the answer of `POST /devices` and of a revoke. Bytes are base64, dates ISO text.
 */
export interface DeviceDto {
  readonly id: string;
  readonly userId: string;
  readonly role: DeviceRole;
  readonly name: string | null;
  readonly platform: string | null;
  readonly identityKeyPub: string;
  readonly signatureKeyPub: string;
  readonly createdAt: string;
  readonly lastSeenAt: string | null;
  readonly revokedAt: string | null;
  /**
   * The device's proof that it holds the person's identity key (ADR-218 §5): the identity key's
   * Ed25519 signature (base64) over `holderStatementBytes` of this device. FULL view only; `null`
   * for a device that has posted none. Absent from a relay that predates it: read absent as `null`.
   * A client counts it only after `verifyHolderProof` under its own pin, never on the relay's word.
   */
  readonly holderProof?: string | null;
}

/**
 * A device as another user sees it: what they need to verify and address it, and nothing about its
 * owner's habits (label, platform, last seen), its history or its holder proof.
 */
export type PublicDeviceDto = Pick<DeviceDto, 'id' | 'role' | 'identityKeyPub' | 'signatureKeyPub'>;

/** The body of `PUT /devices/me/holder-proof`: the calling device's own proof (base64). */
export interface HolderProofBody {
  readonly holderProof: string;
}

// --- Identity requests (ADR-218 §1, §2, §4) --------------------------------------------------------
// Routes under `/users/me/identity-requests`: N creates, reads its own and cancels (`DELETE`); a
// holder of the same account lists them and challenges, approves or rejects; N reveals. Bytes are
// base64, dates ISO text. The canonical bytes and sizes live in `./identity-transfer.ts`.

/**
 * Where a request is. `OPEN` → `CHALLENGED` (a holder posted `r_B`) → `REVEALED` (N posted `r_N`) →
 * `APPROVED` (the sealed key is waiting for N). A `backfill` request has no number step: `OPEN` →
 * `APPROVED`. `REJECTED` from any open state; `EXPIRED` when the TTL passed before approval (the relay
 * says so until retention purges the row, then the request is 404).
 */
export const IdentityRequestState = {
  OPEN: 'OPEN',
  CHALLENGED: 'CHALLENGED',
  REVEALED: 'REVEALED',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  EXPIRED: 'EXPIRED',
} as const;
export type IdentityRequestState = (typeof IdentityRequestState)[keyof typeof IdentityRequestState];

/** The body of `POST /users/me/identity-requests`. The calling device (token `did`) is N. */
export interface CreateIdentityRequestBody {
  readonly purpose: IdentityRequestPurpose;
  /** `T_N`, raw X25519, base64. */
  readonly transferKey: string;
  /** `pair` only: the commitment to `r_N`. Absent for `backfill`. */
  readonly commitment?: string;
  /** N's device-key signature over `identityRequestBytes`. */
  readonly signature: string;
}

/**
 * The body of `…/{id}/challenge` (a holder's `r_B`) and of `…/{id}/reveal` (N's `r_N`):
 * `PAIRING_NONCE_BYTES`, base64.
 */
export interface IdentityRequestNonceBody {
  readonly nonce: string;
}

/** An identity private key sealed with HPKE to `T_N` (ADR-218 §1). Ciphertext only. */
export interface SealedIdentityDto {
  /** The HPKE encapsulated key. */
  readonly enc: string;
  readonly ciphertext: string;
}

/** The body of `…/{id}/approve`: the list version that carries N (the aad's) and the sealed key. */
export interface ApproveIdentityRequestBody {
  readonly listVersion: number;
  readonly sealed: SealedIdentityDto;
}

/** One identity request, as `GET /users/me/identity-requests` and `GET …/{id}` serve it. */
export interface IdentityRequestDto {
  readonly id: string;
  /** N: the device asking. */
  readonly deviceId: string;
  readonly purpose: IdentityRequestPurpose;
  readonly state: IdentityRequestState;
  readonly transferKey: string;
  readonly commitment: string | null;
  readonly signature: string;
  /** The holder that challenged (other holders show «approving on <its name>»). */
  readonly challengerDeviceId: string | null;
  /** `r_B`, once challenged. */
  readonly holderNonce: string | null;
  /** `r_N`, once revealed. */
  readonly deviceNonce: string | null;
  /** The list version the approval named, once approved. */
  readonly listVersion: number | null;
  /**
   * The sealed key: served ONLY to the requesting device, from approval until its holder proof or
   * `SEALED_IDENTITY_TTL_MS`; `null` for every other reader and at every other time.
   */
  readonly sealed: SealedIdentityDto | null;
  readonly createdAt: string;
  readonly expiresAt: string;
}

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

/**
 * The body of a 409 IDENTITY_REBIND_PROOF_REQUIRED (ADR-218 §6): the open reset's id, which the device
 * the ticket names signs with its new identity key (`identityRebindBytes`) and sends back as
 * `rebindSignature`. Only that device's own token reaches it, and the id is no secret: the signature is
 * the proof.
 */
export interface IdentityRebindProofRequiredBody {
  readonly error: typeof RelayErrorCode.IDENTITY_REBIND_PROOF_REQUIRED;
  readonly message: string;
  readonly resetId: string;
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
