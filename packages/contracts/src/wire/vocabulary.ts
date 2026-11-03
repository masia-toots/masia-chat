/**
 * The wire vocabulary: the names, limits and byte layouts that every client (the MLS engine in
 * `@masia/messenger`) and every relay (`@masia/relay`) must agree on. ONE home. Before 2026-10-10 the
 * engine and the relay each kept a copy and a parity test held them together (architecture review,
 * round 1); a copy that drifts makes one side refuse what the other sends, so now both import this.
 *
 * Pure data and pure functions. No dependency, no I/O, no clock: a third-party client or relay can
 * read it on its own and implement the same wire.
 */

/** Bumped when the wire format between clients and the relay changes incompatibly. */
export const RELAY_PROTOCOL_VERSION = 1;

/** Where a relay answers "are you alive, and which protocol do you speak". */
export const RELAY_HEALTH_PATH = '/health';

// --- Identifiers -----------------------------------------------------------------------------------

/** Longest id (user, device, conversation), in bytes. An id is ASCII, so also in characters. */
export const MAX_ID_BYTES = 128;

/**
 * An identifier minted by a client or by the host (device, user, conversation). The alphabet has no
 * `:`/`.`/`/`, so two ids joined with `:` can never collide and an id is safe in a URL path. As a
 * string, because a relay puts it into JSON-schema `pattern`s; `ID_REGEXP` is the same rule compiled.
 */
export const ID_PATTERN = `^[A-Za-z0-9_-]{1,${MAX_ID_BYTES}}$`;
export const ID_REGEXP = new RegExp(ID_PATTERN);

/** True for a string in the id alphabet and length. */
export function isWireId(value: unknown): value is string {
  return typeof value === 'string' && ID_REGEXP.test(value);
}

// --- Device roles ----------------------------------------------------------------------------------

/**
 * What a device is to a room. The role is part of the signed device list and of the MLS credential,
 * so every member sees it:
 *
 * - `USER`: a person's own device.
 * - `GUARDIAN`: a parent's device on a MINOR's account. It reads the minor's rooms, and every member
 *   of those rooms is shown that it does (the household model is part of this protocol, not an
 *   add-on: a guardian leaf is a statement about a child's rooms).
 * - `ASSISTANT`: a device that an AI assistant run by the host's operator holds, one per room. Rooms
 *   with one in them are readable by whoever runs that assistant, and say so.
 *
 * Until 2026-10-10 the third role was spelled with the reference host's product name; it was renamed
 * before 1.0 so the wire names no product (internal ADR-117 amendment (д), summarised in the
 * messenger's docs/adr/0001). A host maps its own assistant onto `ASSISTANT` in one place.
 */
export const DeviceRole = {
  USER: 'USER',
  GUARDIAN: 'GUARDIAN',
  ASSISTANT: 'ASSISTANT',
} as const;
export type DeviceRole = (typeof DeviceRole)[keyof typeof DeviceRole];
export const DEVICE_ROLES: readonly DeviceRole[] = Object.values(DeviceRole);

/** True for one of the three role strings (an inherited property name is not a role). */
export function isDeviceRole(value: unknown): value is DeviceRole {
  return typeof value === 'string' && (DEVICE_ROLES as readonly string[]).includes(value);
}

/**
 * The role as one byte inside the MLS credential (see `CREDENTIAL_IDENTITY_VERSION`). The bytes did
 * not change when the third role was renamed: code 3 was and is the assistant's.
 */
export const DEVICE_ROLE_CODES: Readonly<Record<DeviceRole, number>> = {
  [DeviceRole.USER]: 1,
  [DeviceRole.GUARDIAN]: 2,
  [DeviceRole.ASSISTANT]: 3,
};

/**
 * Layout version of the identity inside a leaf's BASIC credential:
 *
 *   u8 version = 1 · u8 role code · u8 len(userId) · userId · u8 len(deviceId) · deviceId
 *
 * Canonical (one byte string per identity), ids from the id alphabet so a length fits one byte.
 */
export const CREDENTIAL_IDENTITY_VERSION = 1;

// --- MLS profile -----------------------------------------------------------------------------------

/** `ProtocolVersion mls10` as it appears in the clear on the wire (a `uint16`, RFC 9420 §6). */
export const MLS_PROTOCOL_VERSION_10 = 1;

/**
 * The one cipher suite (RFC 9420 §17.1, suite 1, `MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519`): the
 * mandatory-to-implement suite, every primitive in WebCrypto. As it appears on the wire (a `uint16`).
 */
export const MLS_CIPHER_SUITE_ID = 1;

/**
 * GroupContext extension type that carries the conversation id. RFC 9420 §17.3 reserves
 * 0xF000-0xFFFF for private use; this one is the messenger's. GroupContext is hashed into every
 * epoch's key schedule, so the id cannot be swapped by a relay, and no commit ever changes it.
 */
export const CONVERSATION_ID_EXTENSION_TYPE = 0xf0c1;

/**
 * The authenticated data of every application message is
 *
 *   u8 len(conversationId) · conversationId · extra
 *
 * so a ciphertext lifted from one conversation and replayed into another fails to open. This is the
 * length prefix; `extra` is the sender's own (a few counters, never content) and at most
 * `MAX_AAD_EXTRA_BYTES`, because it rides in the CLEARTEXT `authenticated_data` of a PrivateMessage.
 */
export const AAD_ID_LENGTH_PREFIX_BYTES = 1;
export const MAX_AAD_EXTRA_BYTES = 1024;

// --- Handshakes --------------------------------------------------------------------------------------

/**
 * The MLS handshake messages a relay stores and orders. A relay cannot read the body of any of them,
 * only the cleartext MLSMessage header (`mls-header.ts`). Only COMMIT moves the epoch.
 *
 * No GROUP_INFO: GroupInfo exists for external joins, which the messenger does not use, and one
 * stored "for later" is a surface every member can read and nothing needs. No PROPOSAL: the engine
 * commits its proposals inline and refuses a standalone one, so a stored proposal is a message no
 * member would accept.
 */
export const HandshakeKind = {
  COMMIT: 'COMMIT',
  WELCOME: 'WELCOME',
} as const;
export type HandshakeKind = (typeof HandshakeKind)[keyof typeof HandshakeKind];

/** The one kind a client posts to the handshake route; the relay files the WELCOME beside it. */
export const CLIENT_HANDSHAKE_KIND = HandshakeKind.COMMIT;

// --- Size limits, in decoded bytes ---------------------------------------------------------------
// A relay stores what clients hand it, and a client must never be refused for size alone by a relay
// that would store the message, so these are the same numbers on both sides by construction.

/** A commit or a Welcome. */
export const MAX_HANDSHAKE_BYTES = 256 * 1024;
/**
 * One application message as it travels (the ciphertext). Text only: media never travels through
 * the relay as an envelope.
 */
export const MAX_ENVELOPE_BYTES = 64 * 1024;
/** One KeyPackage. */
export const MAX_KEY_PACKAGE_BYTES = 16 * 1024;
/** An MLS group id. The engine mints 32-byte ids; a peer's header may claim at most this. */
export const MAX_GROUP_ID_BYTES = 256;
/** Devices one user may have; also the most Adds in one commit. */
export const MAX_DEVICES_PER_USER = 64;
/**
 * Leaves (devices) in one group. A household room is a handful of people with a few devices each;
 * this is far past that, and it bounds every loop over a tree.
 */
export const MAX_GROUP_LEAVES = 256;

// --- Retention -----------------------------------------------------------------------------------------

/**
 * How long a relay keeps a handshake or an envelope. Older rows are deleted by the relay's retention
 * job; a device offline for longer finds a gap and must be re-added. The engine relies on it: no
 * device ever replays a commit older than this, so the floor it judges KeyPackage lifetimes against
 * never sinks below `now - RELAY_BACKLOG_RETENTION_SECONDS`.
 */
export const RELAY_BACKLOG_RETENTION_SECONDS = 30 * 24 * 60 * 60;
