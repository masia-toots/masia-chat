/**
 * The relay's own limits and shapes: rate limits, paging, the epoch serialiser, the sizes of fields
 * only the relay stores. Pure data. Nothing here touches a database, a socket or a clock.
 *
 * The WIRE vocabulary a client must share with the relay (device roles, handshake kinds, the size
 * limits both sides enforce, retention, the id alphabet, the token claims, the MLS header parser)
 * is not here: it lives in ONE home, `@masia/contracts/wire`, and this package re-exports it
 * (`index.ts`). Until 2026-10-10 it lived here and the engine kept copies (review round 1, M14).
 */

/** A UUID in its canonical text form: what the relay mints for key packages (Postgres `uuid`). */
export const UUID_PATTERN =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

// --- Epoch serializer (ADR-117 §2) -------------------------------------------------------------

/**
 * How many times in a row a device may lose the race for an epoch and rebase before the relay
 * answers 429. A client that keeps losing is either in a livelock or facing a serializer that
 * withholds commits (ADR-117 H5), and must show a security state instead of retrying forever.
 */
export const MAX_REBASES = 5;

/** Idle time after which a device's run of lost races is forgotten. */
export const REBASE_WINDOW_MS = 5 * 60_000;

// --- Key-package directory (ADR-117 §2, H6) ----------------------------------------------------

/** Claims one device may make in a window; an exhausted pool is a DoS and a presence oracle. */
export const CLAIM_LIMIT = 30;
export const CLAIM_WINDOW_MS = 10 * 60_000;

// The pool cap (`MAX_UNCLAIMED_KEY_PACKAGES_PER_DEVICE`) and the upload budget
// (`KEY_PACKAGE_UPLOAD_WINDOW_MS`, `_DEVICE_LIMIT`, `_USER_LIMIT`) are what a client paces itself by:
// wire vocabulary, `@masia/contracts/wire` (TODO-505).

// --- Lookup limits (security review 2026-10-10 §4, "Enumeration") ------------------------------
// A per-device limit alone is no limit: a user has up to MAX_DEVICES_PER_USER devices (and can
// register more users), so N devices x the per-device cap drains a victim's pool or maps a child's
// devices. Every lookup of ANOTHER user is therefore also counted per calling USER (all of the
// actor's devices together) and per TARGET user (all callers together). Looking up yourself is
// never counted against the target budget, so a flood from outside cannot lock an owner out of
// their own devices. The contact gate of ADR-115 is the real fix and belongs to the host (K4).

/** Claims across all devices of one calling user in a CLAIM_WINDOW_MS window. */
export const CLAIM_USER_LIMIT = 60;
/** Claims against one target user, from everyone, in a CLAIM_WINDOW_MS window. */
export const CLAIM_TARGET_LIMIT = 60;

export const DEVICE_LIST_WINDOW_MS = 10 * 60_000;
/**
 * Device-list reads are higher than claims: a read consumes nothing, and a client legitimately
 * re-reads the lists of everyone in a room whenever the roster changes. Still low enough that
 * walking the user-id space is slow.
 */
export const DEVICE_LIST_USER_LIMIT = 120;
export const DEVICE_LIST_TARGET_LIMIT = 120;

// --- Size limits, in decoded bytes -------------------------------------------------------------
// The relay stores what clients hand it, so every opaque field has a ceiling. The limits a client
// must also respect (handshake, envelope, key package, group id, devices per user) are wire
// vocabulary and live in `@masia/contracts/wire`; these are the relay's own.

export const MAX_KEY_PACKAGES_PER_UPLOAD = 100;
export const MAX_PUBLIC_KEY_BYTES = 256;
export const MAX_SIGNATURE_BYTES = 512;
export const MAX_TREE_HASH_BYTES = 64;
/** Adds plus removes in one commit. */
export const MAX_MEMBER_DELTA_ENTRIES = 256;
// The longest device label (`MAX_DEVICE_TEXT_LENGTH`) is what a client trims to before it registers:
// wire vocabulary, `@masia/contracts/wire` (TODO-513), re-exported by `index.ts`.

// --- Paging ------------------------------------------------------------------------------------

/** The page a read route returns when the client asks for none. The cap, `PAGE_MAX`, is wire vocabulary. */
export const PAGE_DEFAULT = 100;

/** Length of the base64 text for `bytes` decoded bytes (padded), for JSON-schema `maxLength`. */
export function base64Length(bytes: number): number {
  return Math.ceil(bytes / 3) * 4;
}
