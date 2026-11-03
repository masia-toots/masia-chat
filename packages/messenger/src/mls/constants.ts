import {
  AAD_ID_LENGTH_PREFIX_BYTES,
  MAX_AAD_EXTRA_BYTES,
  MAX_ENVELOPE_BYTES,
  MAX_GROUP_ID_BYTES,
  MAX_ID_BYTES,
  MAX_KEY_PACKAGE_BYTES,
} from '@masia/contracts/wire';

/**
 * The numbers and names the MLS engine is pinned to. One place, so a reviewer can read the whole
 * attack-surface budget (suite, wire limits, time window) without opening the validator.
 *
 * Every value the relay must agree on is WIRE vocabulary and is imported from its one home,
 * `@masia/contracts/wire`, and re-exported here under the engine's names. Until 2026-10-10 they were
 * copies held to the relay's by `__tests__/relay-parity.test.ts` (architecture review round 1, M14).
 */

export {
  AAD_ID_LENGTH_PREFIX_BYTES,
  CONVERSATION_ID_EXTENSION_TYPE,
  ID_REGEXP as ID_PATTERN,
  MAX_AAD_EXTRA_BYTES,
  MAX_DEVICES_PER_USER as MAX_ADDS_PER_COMMIT,
  MAX_ENVELOPE_BYTES as MAX_CIPHERTEXT_BYTES,
  MAX_GROUP_ID_BYTES,
  MAX_GROUP_LEAVES,
  MAX_HANDSHAKE_BYTES,
  MAX_ID_BYTES,
  MAX_KEY_PACKAGE_BYTES,
  MLS_CIPHER_SUITE_ID,
  MLS_PROTOCOL_VERSION_10 as MLS_PROTOCOL_VERSION_ID,
  RELAY_BACKLOG_RETENTION_SECONDS,
} from '@masia/contracts/wire';

// --- Suite and protocol version (security review 2026-10-10 §1: "cipher suite pinned") ----------

/** RFC 9420 §17.1, suite 1: the mandatory-to-implement suite; every primitive is in WebCrypto. */
export const MLS_CIPHER_SUITE_NAME = 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519' as const;
// Its wire id is `MLS_CIPHER_SUITE_ID` (contracts/wire, re-exported above).
/** `ProtocolVersion mls10` as ts-mls names it. */
export const MLS_PROTOCOL_VERSION_NAME = 'mls10' as const;
// Its wire id is `MLS_PROTOCOL_VERSION_ID` (contracts/wire `MLS_PROTOCOL_VERSION_10`).

// The conversation-id GroupContext extension (`CONVERSATION_ID_EXTENSION_TYPE`, 0xf0c1), the id
// alphabet (`ID_PATTERN`, `MAX_ID_BYTES`) and the AAD frame (`AAD_ID_LENGTH_PREFIX_BYTES`,
// `MAX_AAD_EXTRA_BYTES`) are wire vocabulary: contracts/wire, re-exported above.

// --- Size caps, applied BEFORE any byte reaches a decoder (security review §1: "size-capped") ---
// The relay's limits are the engine's by construction (one module, contracts/wire): a message the
// relay would store is never refused here for size alone, and a message it would refuse is not
// worth decoding. `MAX_HANDSHAKE_BYTES` (a commit or a Welcome), `MAX_GROUP_ID_BYTES`,
// `MAX_KEY_PACKAGE_BYTES` and `MAX_CIPHERTEXT_BYTES` (the relay's `MAX_ENVELOPE_BYTES`: `encrypt`
// never produces more, `decrypt` refuses more before decoding a byte) are re-exported above.

/** Bytes of CSPRNG the engine uses for a new group id. */
export const GROUP_ID_BYTES = 32;
/**
 * Everything a suite-1 PrivateMessage adds around the plaintext, the group id and the authenticated
 * data (RFC 9420 §6.3), budgeted with room to spare. Measured: 136 bytes for a plaintext over 256
 * bytes, namely
 *   version and wire format 4 · group id length 2 · epoch 8 · content type 1 · authenticated data
 *   length 2 · encrypted sender data 29 (length 1, 12 sealed bytes, 16-byte tag) · ciphertext length 4 ·
 *   application data length 4 · signature 65 (length 1, 64 Ed25519 bytes) · AEAD tag 16.
 * ts-mls pads only up to 256 bytes of content (`padUntilLength`), so a large message carries no
 * padding. The 256-byte budget covers longer variable-length prefixes and a padding change; a
 * test pins the measured overhead below the budget, and `encrypt` checks every result anyway.
 */
export const PRIVATE_MESSAGE_FRAMING_BUDGET_BYTES = 256;
/**
 * One application plaintext: whatever is left of `MAX_CIPHERTEXT_BYTES` once the largest group id,
 * the largest conversation id, the largest extra authenticated data and the framing budget are
 * paid for. Text only; media never goes through here.
 */
export const MAX_PLAINTEXT_BYTES =
  MAX_ENVELOPE_BYTES -
  MAX_GROUP_ID_BYTES -
  (AAD_ID_LENGTH_PREFIX_BYTES + MAX_ID_BYTES) -
  MAX_AAD_EXTRA_BYTES -
  PRIVATE_MESSAGE_FRAMING_BUDGET_BYTES;
/** A serialized group state. 50 members is ~104 KB (library benchmark, docs/adr/0003); ample room to grow. */
export const MAX_STATE_BYTES = 16 * 1024 * 1024;
/** The secret half of a key package: the public package plus three keys and framing. */
export const MAX_KEY_PACKAGE_PRIVATE_BYTES = MAX_KEY_PACKAGE_BYTES + 1024;
/** One private key inside the stored KeyPackage secrets (an X25519 or Ed25519 key is 32 bytes). */
export const MAX_PRIVATE_KEY_BYTES = 256;
/** Longest label an exporter call may use (labels are short constants, never user input). */
export const MAX_EXPORTER_LABEL_BYTES = 128;
/** Longest secret an exporter call may ask for. */
export const MAX_EXPORTER_LENGTH = 1024;

// `MAX_ADDS_PER_COMMIT` is the wire's `MAX_DEVICES_PER_USER` (re-exported above).
export const MAX_REMOVES_PER_COMMIT = 64;
/*
 * `MAX_GROUP_LEAVES` (contracts/wire, re-exported above): leaves (devices) in a group, one number.
 * It bounds every loop, and a Welcome whose tree is wider is refused before the library reads that
 * tree (`joinFromWelcome`).
 *
 * What it costs, measured on a desktop (Node 22, the contract suite's benchmark, 16 self-updates in
 * a populated group of 64 devices): a receiver now takes about 60 to 80 ms per commit, slowest 75
 * to 105 ms. The commit-time parent-hash check walks the committer's path only (the engine code
 * review, docs/adr/0005); when it re-verified every chain of the tree the same run took 130 to 145
 * ms per commit, slowest 420 to 870 ms. Joining verifies the whole tree once and stays quadratic
 * in the library. A phone is several times slower; 256 devices has not been measured.
 */

// --- KeyPackage lifetime (security review §1: "key-package lifetime within limits") --------------

/** Clock skew tolerated between devices when a KeyPackage's lifetime is checked. */
export const KEY_PACKAGE_CLOCK_SKEW_SECONDS = 60 * 60;
/** A KeyPackage may not claim to be valid for longer than this from now (the upload pool is rotated). */
export const KEY_PACKAGE_MAX_HORIZON_SECONDS = 90 * 24 * 60 * 60;
/** How long a KeyPackage this engine creates is valid for: well inside the horizon. */
export const KEY_PACKAGE_LIFETIME_SECONDS = 30 * 24 * 60 * 60;
/**
 * A SENDER adds a KeyPackage only if it stays valid this long by the sender's own clock. Receivers
 * judge the package against the time the relay accepted the commit; a sender whose clock runs
 * hours behind could otherwise add a package that every receiver finds expired, and the room
 * would stall at that commit. A day is far more skew than a phone shows and far less than a
 * package lives (`KEY_PACKAGE_LIFETIME_SECONDS`).
 */
export const KEY_PACKAGE_MIN_REMAINING_SECONDS = 24 * 60 * 60;
/*
 * `RELAY_BACKLOG_RETENTION_SECONDS` (contracts/wire, re-exported above): how long the relay keeps a
 * handshake for a device that is offline, a HOST CONTRACT (canon §9.7). A commit older than this is
 * gone from the relay, so no device ever replays one, and a KeyPackage that expired before
 * `floor - skew` cannot be in a commit a device still receives. It is the lowest the floor
 * `processCommit` judges a KeyPackage against may sink (the engine code review, docs/adr/0005).
 */

// --- The host's directory (reliability review: a hanging host call must not block a room) ------

/**
 * How long the engine waits for one call into the host's `DeviceDirectory` before it gives up
 * with `DIRECTORY_UNAVAILABLE` (transient: retry later). A directory answers from a local cache or
 * one relay round trip; ten seconds is generous for both.
 */
export const DIRECTORY_TIMEOUT_MS = 10_000;

// --- Serialized formats (our own framing around ts-mls's) ------------------------------------

/**
 * First byte of a serialized state: bumped on any incompatible change. A state of another version
 * is `STATE_VERSION_UNSUPPORTED`, never `STATE_CORRUPT` (canon §9.7: never delete it).
 * 2: the state also carries the pinned device-list versions and the receive floor.
 */
export const STATE_FORMAT_VERSION = 2;
/** First byte of a serialized KeyPackage secret. */
export const KEY_PACKAGE_PRIVATE_FORMAT_VERSION = 1;
/** First byte of a serialized pending commit (`encodePendingCommit`). */
export const PENDING_COMMIT_FORMAT_VERSION = 1;

/** Milliseconds in a second: the clock hook returns ms, MLS lifetimes are seconds. */
export const MS_PER_SECOND = 1000;
