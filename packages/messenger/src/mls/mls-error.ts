/**
 * The one error the MLS engine throws, whatever goes wrong inside (ours or the library's).
 *
 * Why a closed code list: callers branch on `code` (reject the commit, raise a security state,
 * ask for a fresh Welcome); they must never branch on a message, and they must never see a
 * `TypeError` or a library error leak out of a hostile buffer. The fuzz test holds the engine to
 * "throws `MlsEngineError` and nothing else".
 */
export const MlsEngineErrorCode = {
  // --- Input shape: every decode is size-capped first (security review 2026-10-10 §1) ---
  /** The input is bigger than the cap for its kind. Checked before a single byte is decoded. */
  DECODE_TOO_LARGE: 'DECODE_TOO_LARGE',
  /** The bytes are not the message they should be (truncated, bad framing, wrong version). */
  MALFORMED_MESSAGE: 'MALFORMED_MESSAGE',
  /** A well-formed message of the wrong kind for this call (a Welcome given as a commit...). */
  UNEXPECTED_MESSAGE_KIND: 'UNEXPECTED_MESSAGE_KIND',
  /** A serialized state, pending commit or key-package secret that does not decode: it is damaged. */
  STATE_CORRUPT: 'STATE_CORRUPT',
  /**
   * A serialized state (or pending commit, or key-package secret) in a format version this engine
   * does not read: written by a newer or an older build. NOT damage: the bytes are probably fine
   * for the build that wrote them, so the host must keep them and never delete them on this code
   * (canon §9.7).
   */
  STATE_VERSION_UNSUPPORTED: 'STATE_VERSION_UNSUPPORTED',
  /** A `GroupState` (or `PendingCommit`) that this engine did not produce. */
  INVALID_STATE: 'INVALID_STATE',
  /**
   * The CALLER passed an argument of the wrong type or outside its allowed range (a conversation
   * id outside the id alphabet, an empty list, a negative epoch, an exporter label too long). A bug
   * in the host, never something a peer or the relay can cause.
   */
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',

  // --- Pinned parameters ---
  /** Not cipher suite 1 / not MLS 1.0 (RFC 9420 §17.1). */
  SUITE_NOT_PINNED: 'SUITE_NOT_PINNED',
  /** The commit is for another group than the state it was given. */
  GROUP_MISMATCH: 'GROUP_MISMATCH',
  /** The commit is for another epoch than the state it was given (RFC 9420 §12.4.2). */
  EPOCH_MISMATCH: 'EPOCH_MISMATCH',
  /** The Welcome / GroupInfo names another conversation than the caller expects. */
  CONVERSATION_MISMATCH: 'CONVERSATION_MISMATCH',
  /** An extension this engine does not speak (group context, leaf, or missing capability). */
  UNSUPPORTED_EXTENSION: 'UNSUPPORTED_EXTENSION',

  // --- Commit rules (RFC 9420 §12.4; security review §1, §2) ---
  /** A commit that needs an UpdatePath came without one (the GHSA and F8b shape). */
  PATH_REQUIRED: 'PATH_REQUIRED',
  /** External join, ExternalInit, or an external / new-member sender: none exist in phase 1. */
  EXTERNAL_SENDER_FORBIDDEN: 'EXTERNAL_SENDER_FORBIDDEN',
  /** A commit that commits a proposal it did not carry (by reference). */
  PROPOSAL_BY_REFERENCE_FORBIDDEN: 'PROPOSAL_BY_REFERENCE_FORBIDDEN',
  /** A proposal sent on its own, outside a commit. */
  STANDALONE_PROPOSAL_FORBIDDEN: 'STANDALONE_PROPOSAL_FORBIDDEN',
  /** A proposal type phase 1 does not use (Update, PSK, ReInit, GroupContextExtensions...). */
  PROPOSAL_NOT_ALLOWED: 'PROPOSAL_NOT_ALLOWED',
  /**
   * More proposals in one commit than the engine allows (`MAX_ADDS_PER_COMMIT`,
   * `MAX_REMOVES_PER_COMMIT`): the same code whether we were about to send it or received it.
   */
  TOO_MANY_PROPOSALS: 'TOO_MANY_PROPOSALS',
  /** The commit would leave the group with more than `MAX_GROUP_LEAVES` devices (send and receive). */
  GROUP_FULL: 'GROUP_FULL',
  /** A Remove that names nobody, the committer itself, or the same leaf twice. */
  INVALID_REMOVE: 'INVALID_REMOVE',
  /**
   * A Remove of a GUARDIAN leaf by someone who may not evict it: neither an admin of that user nor
   * a registered guardian device of that user acting for its admin (internal ADR-117 §4, summarised
   * in docs/adr/0001; the engine code review, docs/adr/0005).
   */
  GUARDIAN_REMOVE_FORBIDDEN: 'GUARDIAN_REMOVE_FORBIDDEN',
  /**
   * An Add of an ASSISTANT leaf to a room with a minor by someone who does not administer every minor in
   * it (internal ADR-117 §3, summarised in docs/adr/0001: turning Masia on in a child's room is a
   * parent action).
   */
  ASSISTANT_ADD_FORBIDDEN: 'ASSISTANT_ADD_FORBIDDEN',
  /** The relay-served member delta is not the delta of the decrypted commit (review §4). */
  MEMBER_DELTA_MISMATCH: 'MEMBER_DELTA_MISMATCH',

  // --- Leaf rules (security review §1: "every LeafNode ... matches the signed list") ---
  /** The credential is not a canonical `{userId, deviceId, role}` basic credential. */
  CREDENTIAL_INVALID: 'CREDENTIAL_INVALID',
  /**
   * `(userId, deviceId, role, signatureKey)` is not on the owner's verified signed list. For an ASSISTANT
   * leaf the listed entry must also name THIS conversation. In backlog mode (`ProcessCommitInput.backlog`)
   * the device must have been listed in a verified version no older than the one pinned for its user.
   */
  LEAF_NOT_IN_SIGNED_LIST: 'LEAF_NOT_IN_SIGNED_LIST',
  /** A leaf update changed the role: a guardian could drop its badge (review §1). */
  ROLE_CHANGED: 'ROLE_CHANGED',
  /** A leaf update changed whose device the leaf is. */
  IDENTITY_CHANGED: 'IDENTITY_CHANGED',
  /** The device is already in the group (or is added twice in one commit). */
  DUPLICATE_DEVICE: 'DUPLICATE_DEVICE',
  /**
   * The KeyPackage's lifetime is outside the window: `notAfter` below `floor - skew` (on receive the
   * floor is about when the relay accepted the commit, see `ProcessCommitInput.acceptedAtMs`) or,
   * when WE are about to add it, below `now + KEY_PACKAGE_MIN_REMAINING_SECONDS`; or `notAfter`
   * beyond `now + 90 days`; or `notBefore` in the future beyond the skew.
   */
  LIFETIME_OUT_OF_RANGE: 'LIFETIME_OUT_OF_RANGE',
  /** A KeyPackage or leaf signature does not verify, or the init key equals the leaf key (RFC 9420 §10.1). */
  SIGNATURE_INVALID: 'SIGNATURE_INVALID',

  // --- Welcome rules (RFC 9420 §12.4.3.1) ---
  /** The tree hash, a parent hash or a leaf signature of a Welcome's tree does not verify. */
  WELCOME_TREE_MISMATCH: 'WELCOME_TREE_MISMATCH',

  // --- Application messages ---
  /** The authenticated data of a message is not what this conversation expects. */
  AAD_MISMATCH: 'AAD_MISMATCH',
  /** The caller asked to send in a group this device has been removed from. */
  NOT_ACTIVE: 'NOT_ACTIVE',

  // --- The host ---
  /**
   * The host's `DeviceDirectory` failed or did not answer within `DIRECTORY_TIMEOUT_MS`, so the
   * engine could not tell whether a device is on its signed list. TRANSIENT: nothing was adopted;
   * retry the same call later. Never a reason to treat the commit as invalid.
   */
  DIRECTORY_UNAVAILABLE: 'DIRECTORY_UNAVAILABLE',

  // --- Everything the library refuses that our own rules did not name ---
  /**
   * ts-mls rejected the input (signature, AEAD, confirmation tag...; `cause` has the original), or
   * what the library produced is not what the engine validated (`drift`), and was thrown away.
   */
  LIBRARY_REJECTED: 'LIBRARY_REJECTED',
} as const;
export type MlsEngineErrorCode = (typeof MlsEngineErrorCode)[keyof typeof MlsEngineErrorCode];

export class MlsEngineError extends Error {
  readonly code: MlsEngineErrorCode;

  constructor(code: MlsEngineErrorCode, message: string, options?: { cause?: unknown }) {
    super(`${code}: ${message}`, options);
    this.name = 'MlsEngineError';
    this.code = code;
  }
}

/** Shorthand used by every rule: `throw fail(MlsEngineErrorCode.X, '...')`. */
export function fail(code: MlsEngineErrorCode, message: string, cause?: unknown): MlsEngineError {
  return new MlsEngineError(code, message, cause === undefined ? undefined : { cause });
}

/**
 * The library's result is not what the engine validated (the shape of GHSA-gwp3-968w-m7gv: the
 * library applied less, or more, than the message said). The result is thrown away, never adopted.
 */
export function drift(what: string): MlsEngineError {
  return fail(
    MlsEngineErrorCode.LIBRARY_REJECTED,
    `The library's result does not match what was validated: ${what}.`,
  );
}
