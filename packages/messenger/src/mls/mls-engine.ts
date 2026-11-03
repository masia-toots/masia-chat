import type { DeviceIdentity, DeviceRole } from './credential.js';

export { DeviceRole, type DeviceIdentity } from './credential.js';
export { MlsEngineError, MlsEngineErrorCode } from './mls-error.js';

/**
 * `MlsEngine`: the messenger's OWN interface over an MLS (RFC 9420) implementation.
 *
 * Why an interface at all (library benchmark, docs/adr/0003; internal ADR-117, summarised in
 * docs/adr/0001): `ts-mls` is young, has one maintainer and no audit, so it is the first
 * IMPLEMENTATION (`ts-mls-engine.ts`), never a dependency of the rest of the messenger. A second one (`mls-rs` -> WASM) can replace it behind this file, and the contract
 * suite in `__tests__/engine-contract.ts` is written against THIS interface so it can run on both.
 *
 * What the interface promises that a library does not (security review 2026-10-10 §1, §2):
 *
 *  - RECEIVE-SIDE VALIDATION. `processCommit` and `joinFromWelcome` check every incoming message
 *    with the engine's own rules (path rules, leaf and role checks against the verified signed
 *    device lists, guardian-removal policy, pinned suite, conversation binding, relay-delta
 *    comparison) and never rely on the library having done it. The library's receive check was
 *    wrong once (GHSA-gwp3-968w-m7gv) and still accepts a GroupContextExtensions commit with no path.
 *  - NO EXTERNAL JOIN. There is no `joinGroupExternal`, no GroupInfo export, no external PSK and no
 *    external sender anywhere in this interface, and the validator rejects all of them on receipt.
 *    A member joins by KeyPackage + Welcome; re-joining is an ordinary Add.
 *  - ONE ERROR TYPE. Every method throws `MlsEngineError` with a code from a closed list, whatever
 *    the input. No `TypeError`, no library error, ever reaches the caller.
 *  - VALIDATE, THEN ADOPT. States are immutable. A method that fails returns nothing and leaves
 *    the state it was given exactly as it was, so a rejected commit costs only that commit.
 *  - OUR OWN COMMITS SURVIVE A LOST ACKNOWLEDGEMENT. Every commit we build comes with a
 *    `PendingCommit` the host stores before posting; after a restart or a conflict
 *    `adoptPendingCommit` tells whether the relay took exactly that commit (canon §9.7).
 */

// --- Who is in the group --------------------------------------------------------------------------

/** A device's long-lived signing key pair (Ed25519). The signed device list pins the public half. */
export interface SigningKeyPair {
  readonly publicKey: Uint8Array;
  readonly privateKey: Uint8Array;
}

/** What a device needs to appear in a group: who it is and the key that proves it. */
export interface DeviceKeys {
  readonly identity: DeviceIdentity;
  readonly signingKey: SigningKeyPair;
}

/** One entry of a user's SIGNED device list as the host verified it (internal ADR-117 §2a, summarised in docs/adr/0001). */
export interface ListedDevice {
  readonly deviceId: string;
  readonly role: DeviceRole;
  /** The device's MLS signature public key (raw Ed25519 bytes). */
  readonly signatureKey: Uint8Array;
  /**
   * ASSISTANT entries only: the ONE conversation this device was issued for (internal ADR-117 §3: the Masia
   * leaf is per conversation). The operator signs it into the Masia device list. The engine accepts
   * an ASSISTANT leaf only when this equals the group's conversation id; a USER or GUARDIAN entry has none.
   */
  readonly conversationId?: string;
}

/** A user's device list whose signature the HOST has already checked. The engine trusts nothing else. */
export interface VerifiedDeviceList {
  readonly userId: string;
  readonly version: number;
  readonly devices: readonly ListedDevice[];
}

/**
 * Where the engine reads verified device lists from. Supplied by the caller, because verifying a
 * list (who signed it, rollback, pinned versions) is the host's job, not MLS's.
 */
export interface DeviceDirectory {
  /** The CURRENT verified list of `userId`, or `undefined` when the host has none. */
  deviceListOf(userId: string): Promise<VerifiedDeviceList | undefined>;

  /**
   * Versioned lookup (the engine code review, docs/adr/0005): the OLDEST verified version of `userId`'s list that is at
   * least `minVersion` and lists exactly `device` (same `deviceId`, `role`, `signatureKey` and, for
   * an ASSISTANT entry, `conversationId`), or `undefined` when no such version is known. It answers "was
   * this device in a verified list no older than the one this receiver had pinned?", so a device
   * that was added, removed and then revoked while the receiver was offline still validates in the
   * backlog it replays (`ProcessCommitInput.backlog`). The OLDEST such version is returned on purpose:
   * the receiver pins it, and a pin that advances no further than the commit needs cannot strand a
   * later commit of the same replay whose device was listed earlier. It must never invent a version:
   * only lists the host verified count, and a device that was never listed returns `undefined`.
   */
  listedSince(
    userId: string,
    device: ListedDevice,
    minVersion: number,
  ): Promise<number | undefined>;

  /**
   * Optional "refresh and retry once": fetch and verify the newest list of `userId` now. The engine
   * calls it at most once per user per validation, only after a lookup missed, and then looks again;
   * a host without it simply gets the refusal. A refresh that fails or times out turns a miss into
   * `DIRECTORY_UNAVAILABLE` (transient: retry later), never into a refusal of the device.
   */
  refreshDeviceList?(userId: string): Promise<void>;
}

/**
 * The family policy the engine enforces on receive (internal ADR-117 §3 and §4, summarised in
 * docs/adr/0001; security review §7; the engine code review, docs/adr/0005).
 */
export interface GuardianPolicy {
  /** Does `adminUserId` administer `childUserId`? Only then may it remove a GUARDIAN leaf of that user, or add Masia to the child's room. */
  isAdminOf(adminUserId: string, childUserId: string): boolean;

  /** Is `userId` a minor (a child account)? A room holding one needs a parent to add an ASSISTANT leaf. */
  isMinor(userId: string): boolean;

  /**
   * Which admin owns the guardian device `guardianDeviceId` of `childUserId`, or `undefined` when
   * the directory does not know the device. It lets a registered guardian device of a child evict
   * another guardian device of the same child in a room with no admin leaf.
   */
  guardianOwnerOf(childUserId: string, guardianDeviceId: string): string | undefined;
}

/** Everything an engine needs from its host besides bytes. */
export interface MlsEngineContext {
  readonly directory: DeviceDirectory;
  readonly policy: GuardianPolicy;
  /** Milliseconds since the epoch. Injectable so tests control the KeyPackage lifetime window. */
  readonly now?: () => number;
  /**
   * How long one call into `directory` may take before the engine gives up with
   * `DIRECTORY_UNAVAILABLE`. Default `DIRECTORY_TIMEOUT_MS`.
   */
  readonly directoryTimeoutMs?: number;
}

/** A current member, as read from the MLS tree (never from relay metadata). */
export interface MemberView {
  readonly leafIndex: number;
  readonly userId: string;
  readonly deviceId: string;
  readonly role: DeviceRole;
}

// --- Member delta (the relay's `memberDelta`, computed by the clients too) -----------------------------

export interface AddedMember {
  readonly deviceId: string;
  readonly userId: string;
  readonly role: DeviceRole;
}

/**
 * Who a commit adds and removes. Same shape as the relay's `MemberDelta`: removals are DEVICE ids.
 * A relay-declared delta may carry more per entry (a `keyPackageId`); the comparison ignores it.
 */
export interface MemberDelta {
  readonly added: readonly AddedMember[];
  readonly removed: readonly string[];
}

// --- Opaque state -----------------------------------------------------------------------------------

/**
 * A device's view of one group at one epoch. Opaque: only the engine that made it can read it, and
 * the only way to keep it is `encodeState`. Immutable; every operation returns a new one.
 */
export interface GroupState {
  readonly kind: 'mls-group-state';
}

/**
 * A commit this device built and is about to post (or posted without seeing the answer): the hash
 * of its exact bytes and the state it leads to. Opaque like `GroupState`; kept with
 * `encodePendingCommit`. Host contract (canon §9.7): store it ATOMICALLY beside the current state
 * BEFORE posting the commit; on an acknowledgement adopt the result's `state` and delete it; after a
 * restart, a timeout or a 409, fetch the commit the relay holds for that epoch and call
 * `adoptPendingCommit`. Never build another commit while one is pending.
 */
export interface PendingCommit {
  readonly kind: 'mls-pending-commit';
}

/** `adoptPendingCommit`: the relay took our commit (here is the state it leads to), or it did not. */
export type AdoptPendingCommitResult =
  | { readonly adopted: true; readonly state: GroupState }
  | { readonly adopted: false };

// --- Inputs and results -----------------------------------------------------------------------------

export interface KeyPackageBundle {
  /** The public KeyPackage (an MLSMessage). Upload it to the relay's key-package pool. */
  readonly keyPackage: Uint8Array;
  /** The matching secrets. Keep it in secure storage until the Welcome arrives, then pass it to `joinFromWelcome`. */
  readonly keyPackagePrivate: Uint8Array;
}

export interface CreateGroupInput {
  readonly conversationId: string;
  readonly selfLeaf: DeviceKeys;
}

export interface CreateGroupResult {
  readonly state: GroupState;
  /** The MLS group id the engine minted; the relay's room is opened with it. */
  readonly groupId: Uint8Array;
}

export interface AddInput {
  readonly state: GroupState;
  /** Public KeyPackages (MLSMessage bytes), as claimed from the relay. */
  readonly keyPackages: readonly Uint8Array[];
}

/** What every commit we build returns besides its own fields. */
export interface OwnCommitResult {
  /**
   * The committer's state AFTER the commit. Adopt it only once the relay has acknowledged the
   * commit; until then keep the current state and the `pendingCommit`.
   */
  readonly state: GroupState;
  readonly commit: Uint8Array;
  /** Store it before posting `commit` (see `PendingCommit`); it is what makes a lost answer recoverable. */
  readonly pendingCommit: PendingCommit;
}

export interface AddResult extends OwnCommitResult {
  readonly welcome: Uint8Array;
  readonly memberDelta: MemberDelta;
  /**
   * Always true. An Add commit carries no UpdatePath (RFC 9420 §12.4 allows that, and ts-mls cannot
   * be told to add one), so the tree is "cold" and the newcomer's leaf is the only new key
   * material. The newcomer therefore does a `selfUpdate` right after joining (post-compromise
   * security, and a 6x smaller commit later: library benchmark, docs/adr/0003).
   */
  readonly requiresNewcomerUpdate: true;
}

export interface RemoveInput {
  readonly state: GroupState;
  readonly leafIndexes: readonly number[];
}

export interface RemoveResult extends OwnCommitResult {
  readonly memberDelta: MemberDelta;
}

export type SelfUpdateResult = OwnCommitResult;

export interface ProcessCommitInput {
  readonly state: GroupState;
  /** The commit as the relay served it (an MLSMessage). */
  readonly commit: Uint8Array;
  /**
   * The member delta the relay STORED for this commit (security review §4, "lying memberDelta").
   * The engine computes the delta from the decrypted commit and rejects any difference.
   */
  readonly servedMemberDelta: MemberDelta;
  /**
   * True when the commit comes from the relay's catch-up (this device was offline), false (the
   * default) for a live one. A live commit is judged against today's verified device list, strictly.
   * A backlog commit is judged against the versions this receiver pinned: a device must have been
   * listed in a verified version no older than the pin of its user, so "Add D ... Remove D ... revoke
   * D" replays without a stall. The pin advances with each accepted commit (canon §9.7).
   */
  readonly backlog?: boolean;
  /**
   * When the relay accepted this commit, in milliseconds (the relay's own timestamp, served with
   * the commit). The KeyPackage window of an incoming Add is judged against a floor that only moves
   * forward: the higher of this time (clamped into [now - RELAY_BACKLOG_RETENTION_SECONDS, now])
   * and the highest relay time the state already adopted. Omitted: the commit counts as old as the
   * retention allows, and the state's stored floor does not move. The state only ever stores relay
   * times, never a value derived from this device's clock.
   */
  readonly acceptedAtMs?: number;
}

export interface ProcessCommitResult {
  readonly state: GroupState;
  /**
   * RFC 9420 §8.7 `epoch_authenticator` of the NEW epoch. Two members that see the same value
   * share a history; show it (or a digest) on the verification screen to detect a forked group.
   * `null` when this commit removed the device itself: it cannot derive the new epoch.
   */
  readonly epochAuthenticator: Uint8Array | null;
  readonly memberDelta: MemberDelta;
  /** True when the commit removed this very device; `state` is then inactive. */
  readonly removedFromGroup: boolean;
}

export interface JoinFromWelcomeInput {
  /** The Welcome as the relay served it (an MLSMessage). */
  readonly welcome: Uint8Array;
  /** The `keyPackagePrivate` of the KeyPackage the Welcome was addressed to. */
  readonly keyPackagePrivate: Uint8Array;
  /** The conversation the host believes this Welcome is for; the GroupContext must say the same. */
  readonly expectedConversationId: string;
  /**
   * The MLS group id the host expects (the relay's room is opened with it). A member could Welcome
   * a newcomer into a parallel group of the same conversation; this makes that a `GROUP_MISMATCH`
   * at join time instead of a silent split later.
   */
  readonly expectedGroupId: Uint8Array;
  /** The epoch the Welcome establishes: the epoch of the Add commit plus one. Else `EPOCH_MISMATCH`. */
  readonly expectedEpoch: bigint;
}

export interface JoinFromWelcomeResult {
  readonly state: GroupState;
  readonly epochAuthenticator: Uint8Array;
  /** Always true: see `AddResult.requiresNewcomerUpdate`. Call `selfUpdate` and post the commit. */
  readonly requiresSelfUpdate: true;
}

export interface DecryptResult {
  readonly state: GroupState;
  readonly plaintext: Uint8Array;
  /** The member that signed the message, read from the tree of the epoch it was sent in. */
  readonly sender: MemberView;
  /** The `aad` the sender passed to `encrypt` (empty when it passed none). Already authenticated. */
  readonly aad: Uint8Array;
}

export interface EncryptResult {
  readonly state: GroupState;
  readonly ciphertext: Uint8Array;
}

// --- The interface ---------------------------------------------------------------------------------

export interface MlsEngine {
  /** A fresh long-lived signing key pair for a device. Its public half goes on the device list. */
  generateSigningKeyPair(): Promise<SigningKeyPair>;

  /** A single-use KeyPackage for `device`. Valid for 30 days; the host rotates its pool. */
  createKeyPackage(device: DeviceKeys): Promise<KeyPackageBundle>;

  /** A new group of one. The conversation id is bound into the GroupContext and never changes. */
  createGroup(input: CreateGroupInput): Promise<CreateGroupResult>;

  /**
   * Adds devices. Each KeyPackage is validated like an incoming one (suite, lifetime, credential
   * and signature key against the signed list). Returns the commit to post, the Welcome to hand to
   * the newcomers, and the member delta to declare beside the commit.
   */
  add(input: AddInput): Promise<AddResult>;

  /** Removes the leaves at `leafIndexes`. A GUARDIAN leaf is removable only under `GuardianPolicy`. */
  remove(input: RemoveInput): Promise<RemoveResult>;

  /** Rotates this device's leaf and the path above it. Always carries an UpdatePath. */
  selfUpdate(state: GroupState): Promise<SelfUpdateResult>;

  /**
   * Resolves a commit of ours whose acknowledgement was lost. `state` is the current state (the one
   * the commit was built on); `relayCommit` is the commit the relay holds for that epoch. Adopted
   * when the relay holds exactly our bytes (or when `state` already is the pending commit's
   * result); otherwise `adopted: false`, and the host deletes the pending commit and hands
   * `relayCommit` to `processCommit` like any other member's commit. Never processes anything.
   */
  adoptPendingCommit(
    state: GroupState,
    pending: PendingCommit,
    relayCommit: Uint8Array,
  ): Promise<AdoptPendingCommitResult>;

  /**
   * Applies a commit from another member. THE VALIDATOR RUNS HERE: the commit is checked against
   * the engine's rules (and the relay-served delta) before it is handed to the library, and the
   * resulting state is checked again before it is returned.
   */
  processCommit(input: ProcessCommitInput): Promise<ProcessCommitResult>;

  /** Joins a group from a Welcome. THE VALIDATOR RUNS HERE too: tree, leaves, conversation, suite. */
  joinFromWelcome(input: JoinFromWelcomeInput): Promise<JoinFromWelcomeResult>;

  /**
   * True when this Welcome carries a secrets entry for the KeyPackage `keyPackagePrivate` belongs to
   * (RFC 9420 section 12.4.3.1: the entry is addressed by the KeyPackageRef). A joiner uses it to pick,
   * among the KeyPackages it still holds, the one a Welcome was made for: the relay returns no id for
   * an upload, so the device cannot name it any other way. Nothing is decrypted and nothing is
   * validated beyond the header, so a `false` is not a verdict on the Welcome, only "not for this one".
   * Size-capped like `joinFromWelcome`; a malformed Welcome is an error, not a `false`.
   */
  welcomeAddressedTo(welcome: Uint8Array, keyPackagePrivate: Uint8Array): Promise<boolean>;

  /**
   * Seals an application message. Its authenticated data is always bound to the conversation id;
   * `aad` is appended after that binding (the hook for a per-sender counter, review §4).
   */
  encrypt(state: GroupState, plaintext: Uint8Array, aad?: Uint8Array): Promise<EncryptResult>;

  /**
   * Opens an application message. Fails with `AAD_MISMATCH` when the message is not bound to this
   * conversation or, if `aad` is given, when the appended part differs.
   */
  decrypt(state: GroupState, ciphertext: Uint8Array, aad?: Uint8Array): Promise<DecryptResult>;

  /** RFC 9420 §8.5 exporter: a secret both sides of one epoch derive (media keys, safety numbers). */
  exporter(
    state: GroupState,
    label: string,
    length: number,
    context?: Uint8Array,
  ): Promise<Uint8Array>;

  /** Every device in the group, from the tree. */
  members(state: GroupState): readonly MemberView[];

  /** This device's own leaf. */
  self(state: GroupState): MemberView;

  conversationId(state: GroupState): string;
  groupId(state: GroupState): Uint8Array;
  /**
   * The tree hash of the epoch this state is at (RFC 9420 section 8.1: part of the GroupContext). The
   * relay wants it with every commit it stores (`newTreeHash`: the hash of the tree the commit
   * leads to) and a creator writes it with the group; both read it from here, never recompute it.
   */
  treeHash(state: GroupState): Uint8Array;
  epoch(state: GroupState): bigint;
  epochAuthenticator(state: GroupState): Uint8Array;
  /** False once this device has been removed: such a state can still decrypt old epochs, never send. */
  isActive(state: GroupState): boolean;
  /** True from joining until this device has posted its first `selfUpdate`. */
  needsSelfUpdate(state: GroupState): boolean;

  /** Serializes a state (secrets inside: keep it in secure storage). */
  encodeState(state: GroupState): Uint8Array;
  /**
   * Reads a state back. Size-capped; `STATE_CORRUPT` / `DECODE_TOO_LARGE` on bad input, and
   * `STATE_VERSION_UNSUPPORTED` for a state another build wrote (keep those bytes: canon §9.7).
   */
  decodeState(bytes: Uint8Array): GroupState;

  /** Serializes a pending commit (it holds a whole state: keep it in secure storage). */
  encodePendingCommit(pending: PendingCommit): Uint8Array;
  /** Reads a pending commit back; the same codes as `decodeState`. */
  decodePendingCommit(bytes: Uint8Array): PendingCommit;
}
