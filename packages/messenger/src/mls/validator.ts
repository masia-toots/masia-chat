import type {
  CiphersuiteImpl,
  Commit,
  Extension,
  GroupContext,
  KeyPackage,
  LeafNode,
  LeafNodeKeyPackage,
  Proposal,
  RatchetTree,
  Sender,
} from 'ts-mls';
import { verifyKeyPackage } from 'ts-mls/keyPackage.js';
import { verifyLeafNodeSignature, verifyLeafNodeSignatureKeyPackage } from 'ts-mls/leafNode.js';
import { calculateParentHash, verifyParentHashes } from 'ts-mls/parentHash.js';
import { treeHashRoot } from 'ts-mls/treeHash.js';
import { leafWidth, root, toNodeIndex } from 'ts-mls/treemath.js';
import {
  CONVERSATION_ID_EXTENSION_TYPE,
  DIRECTORY_TIMEOUT_MS,
  KEY_PACKAGE_CLOCK_SKEW_SECONDS,
  KEY_PACKAGE_MAX_HORIZON_SECONDS,
  KEY_PACKAGE_MIN_REMAINING_SECONDS,
  MAX_ADDS_PER_COMMIT,
  MAX_GROUP_LEAVES,
  MAX_REMOVES_PER_COMMIT,
  MLS_CIPHER_SUITE_NAME,
  MLS_PROTOCOL_VERSION_NAME,
} from './constants.js';
import { decodeId, type DeviceIdentity, DeviceRole, encodeId, identityOf } from './credential.js';
import type {
  DeviceDirectory,
  GuardianPolicy,
  ListedDevice,
  MemberDelta,
  VerifiedDeviceList,
} from './mls-engine.js';
import { drift, fail, MlsEngineError, MlsEngineErrorCode } from './mls-error.js';

/**
 * THE RECEIVE-SIDE VALIDATOR. It decides whether a commit, a KeyPackage or a Welcome is acceptable
 * on the engine's own rules, and it does so about messages the library has NOT yet applied (a
 * Welcome is the one exception: it can only be read by joining, so it is checked again afterwards
 * and the state is handed out only if it passes). Nothing in here trusts ts-mls to have checked
 * anything: the library's receive check was wrong once (GHSA-gwp3-968w-m7gv: a Remove-only commit
 * with no UpdatePath was accepted) and still accepts a GroupContextExtensions commit with no path
 * (probe F8b, security review 2026-10-10 §1).
 *
 * Every rule below says WHY it exists (RFC 9420 section or review item) next to the check.
 * Errors are always `MlsEngineError` with a code from the closed list.
 */

export interface ValidatorContext {
  readonly directory: DeviceDirectory;
  readonly policy: GuardianPolicy;
  /** Seconds since the epoch. */
  readonly nowSeconds: () => number;
  /** The pinned suite's primitives, used to re-verify signatures and hashes ourselves. */
  readonly cipherSuite: CiphersuiteImpl;
  /**
   * The time a KeyPackage's `notAfter` is judged against (seconds). Absent: `nowSeconds()`, the full
   * window (sending, Welcome). On receive the engine passes the forward-only floor, so a package that
   * was valid when the relay accepted its Add is not refused for having expired since (the engine
   * code review, docs/adr/0005).
   */
  readonly keyPackageFloorSeconds?: number;
  /**
   * True when WE are about to add the KeyPackages: each must then stay valid for at least
   * `KEY_PACKAGE_MIN_REMAINING_SECONDS` by our clock, so a sender whose clock is behind cannot
   * commit a package its receivers find already expired.
   */
  readonly sending?: boolean;
}

// --- Small helpers ---------------------------------------------------------------------------------

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

export function deviceKey(identity: Pick<DeviceIdentity, 'userId' | 'deviceId'>): string {
  // `:` is outside the id alphabet, so two different pairs can never join to the same key.
  return `${identity.userId}:${identity.deviceId}`;
}

/** Everything about a leaf that identifies its keys and owner; two leaves are "the same" iff these match. */
function leafFingerprint(leaf: LeafNode): string {
  const identity =
    leaf.credential.credentialType === 'basic' ? toHex(leaf.credential.identity) : 'x509';
  return `${toHex(leaf.signaturePublicKey)}|${toHex(leaf.hpkePublicKey)}|${identity}`;
}

export interface TreeLeaf {
  readonly leafIndex: number;
  readonly leaf: LeafNode;
}

/** Leaf `i` lives at node `2i` of the array-form tree (RFC 9420 Appendix C). */
export function treeLeaves(tree: RatchetTree): TreeLeaf[] {
  const leaves: TreeLeaf[] = [];
  for (let nodeIndex = 0; nodeIndex < tree.length; nodeIndex += 2) {
    const node = tree[nodeIndex];
    if (node?.nodeType === 'leaf') leaves.push({ leafIndex: nodeIndex / 2, leaf: node.leaf });
  }
  return leaves;
}

export function leafAt(tree: RatchetTree, leafIndex: number): LeafNode | undefined {
  const node = tree[leafIndex * 2];
  return node?.nodeType === 'leaf' ? node.leaf : undefined;
}

/**
 * A tree this wide cannot come from a real group: refuse it before looping over it. A tree of at
 * most `2 * MAX_GROUP_LEAVES` nodes holds at most `MAX_GROUP_LEAVES` leaves (leaves sit at the even
 * indexes), so this is the leaf-count limit, and it costs one comparison.
 *
 * It runs on trees the library has ALREADY decoded: the group's own tree before a commit, and the
 * tree of a group just joined. It is therefore not what protects a joiner from a huge Welcome tree:
 * that one is counted before the library reads it (`ts-mls-engine.ts`, `assertWelcomeTreeBounded`),
 * and this check stays as a second line.
 */
export function assertTreeBounded(tree: RatchetTree): void {
  if (tree.length > 2 * MAX_GROUP_LEAVES) {
    throw fail(
      MlsEngineErrorCode.DECODE_TOO_LARGE,
      `A ratchet tree of ${tree.length} nodes is over the cap.`,
    );
  }
}

/**
 * How a validation reads the signed device lists (the engine code review, docs/adr/0005).
 *
 *  - `live`: the device must be on the user's CURRENT verified list. A revoked device is refused.
 *  - `backlog`: the commit is being replayed from the relay's catch-up, so "current" is the wrong
 *    question. The device must have been listed in a verified version no older than the version
 *    pinned for its user at the previous epoch (`DeviceDirectory.listedSince`).
 */
export type ListMode = 'live' | 'backlog';

export interface ListScope {
  /** The group's conversation id: an ASSISTANT leaf is valid only when its list entry names this one. */
  readonly conversationId: string;
  readonly mode: ListMode;
  /** userId -> the list version pinned at the previous epoch. A user without a pin is pinned at 0. */
  readonly pins: ReadonlyMap<string, number>;
}

/** The pin of a user nobody has seen yet: any verified version counts (the KeyPackage window still bounds it). */
const UNPINNED_VERSION = 0;

/** Does a listed entry say exactly what a leaf says? (id, role, key and, for Masia, the conversation). */
export function sameListedDevice(entry: ListedDevice, wanted: ListedDevice): boolean {
  return (
    entry.deviceId === wanted.deviceId &&
    entry.role === wanted.role &&
    bytesEqual(entry.signatureKey, wanted.signatureKey) &&
    entry.conversationId === wanted.conversationId
  );
}

/**
 * Looks each user's verified list up once per validation, however many leaves they own, and
 * remembers which list version every accepted lookup relied on (`seen`): the engine pins those
 * versions once the commit is adopted. One instance is one validation: it also owns the single
 * "refresh and retry" a host may offer per user.
 *
 * Every call into the host's directory is bounded by `timeoutMs`. A call that fails or hangs is
 * `DIRECTORY_UNAVAILABLE` (transient), never a verdict on the device: "I could not ask" must not be
 * read as "not listed", or a receiver that was briefly offline would refuse a valid commit for good.
 */
export class ListLookup {
  private readonly cache = new Map<string, Promise<VerifiedDeviceList | undefined>>();
  private readonly refreshed = new Set<string>();
  /** userId -> why the one refresh of that user failed: a later miss is then not a verdict. */
  private readonly refreshFailures = new Map<string, unknown>();
  /** userId -> the highest list version a successful lookup of this validation relied on. */
  readonly seen = new Map<string, number>();

  constructor(
    private readonly directory: DeviceDirectory,
    private readonly scope: ListScope,
    private readonly timeoutMs: number = DIRECTORY_TIMEOUT_MS,
  ) {}

  /** One host call, bounded in time; a rejection or a timeout becomes `DIRECTORY_UNAVAILABLE`. */
  private async ask<T>(what: string, call: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(
          fail(
            MlsEngineErrorCode.DIRECTORY_UNAVAILABLE,
            `The device directory did not answer ${what} within ${this.timeoutMs} ms.`,
          ),
        );
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([Promise.resolve().then(call), deadline]);
    } catch (error) {
      if (error instanceof MlsEngineError) throw error;
      throw fail(
        MlsEngineErrorCode.DIRECTORY_UNAVAILABLE,
        `The device directory failed ${what}.`,
        error,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  get(userId: string): Promise<VerifiedDeviceList | undefined> {
    let pending = this.cache.get(userId);
    if (pending === undefined) {
      pending = this.ask('a list lookup', () => this.directory.deviceListOf(userId));
      this.cache.set(userId, pending);
    }
    return pending;
  }

  /** The entry a leaf with this identity and key must match: only ASSISTANT entries name a conversation. */
  private wanted(identity: DeviceIdentity, signatureKey: Uint8Array): ListedDevice {
    return {
      deviceId: identity.deviceId,
      role: identity.role,
      signatureKey,
      ...(identity.role === DeviceRole.ASSISTANT
        ? { conversationId: this.scope.conversationId }
        : {}),
    };
  }

  private async lookup(userId: string, wanted: ListedDevice): Promise<number | undefined> {
    const pin = this.scope.pins.get(userId) ?? UNPINNED_VERSION;
    if (this.scope.mode === 'backlog') {
      return this.ask('a versioned lookup', () => this.directory.listedSince(userId, wanted, pin));
    }
    const list = await this.get(userId);
    // An older list than the one pinned is a rollback (or a lagging directory): it proves nothing.
    if (list === undefined || list.version < pin) return undefined;
    return list.devices.some((entry) => sameListedDevice(entry, wanted)) ? list.version : undefined;
  }

  /**
   * Demands that `identity` with `signatureKey` is on its owner's verified list (rules by mode, see
   * `ListMode`), after at most ONE host refresh when the first lookup misses. Returns the version
   * the answer rests on and remembers it in `seen`. A miss after a refresh that FAILED is
   * `DIRECTORY_UNAVAILABLE`, not `LEAF_NOT_IN_SIGNED_LIST`: the newer list was never seen.
   */
  async require(identity: DeviceIdentity, signatureKey: Uint8Array): Promise<number> {
    const { userId } = identity;
    const wanted = this.wanted(identity, signatureKey);
    let version = await this.lookup(userId, wanted);
    const refresh = this.directory.refreshDeviceList?.bind(this.directory);
    if (version === undefined && refresh !== undefined && !this.refreshed.has(userId)) {
      this.refreshed.add(userId);
      try {
        await this.ask('a refresh', () => refresh(userId));
      } catch (error) {
        this.refreshFailures.set(userId, error);
      }
      this.cache.delete(userId);
      version = await this.lookup(userId, wanted);
    }
    if (version === undefined && this.refreshFailures.has(userId)) {
      throw fail(
        MlsEngineErrorCode.DIRECTORY_UNAVAILABLE,
        `Device ${identity.deviceId} is not on the list the directory holds, and refreshing that list failed.`,
        this.refreshFailures.get(userId),
      );
    }
    if (version === undefined) {
      throw fail(
        MlsEngineErrorCode.LEAF_NOT_IN_SIGNED_LIST,
        `Device ${identity.deviceId} (${identity.role}) is not on the verified signed list of its user with this key${
          this.scope.mode === 'backlog' ? ' in any version at or above the pinned one' : ''
        }.`,
      );
    }
    this.seen.set(userId, Math.max(this.seen.get(userId) ?? UNPINNED_VERSION, version));
    return version;
  }
}

// --- Group-level rules -------------------------------------------------------------------------------

/**
 * Pinned suite and version (review §1 "cipher suite pinned"; RFC 9420 §17.1). A group on another
 * suite would silently weaken every guarantee the rest of the engine assumes.
 */
export function assertPinnedGroupContext(groupContext: GroupContext): void {
  if (
    groupContext.cipherSuite !== MLS_CIPHER_SUITE_NAME ||
    groupContext.version !== MLS_PROTOCOL_VERSION_NAME
  ) {
    throw fail(MlsEngineErrorCode.SUITE_NOT_PINNED, 'The group is not MLS 1.0 on cipher suite 1.');
  }
}

/** The extension list a group of ours carries: the conversation id and nothing else. */
export function conversationIdExtension(conversationId: string): Extension {
  return {
    extensionType: CONVERSATION_ID_EXTENSION_TYPE,
    extensionData: encodeId(conversationId),
  };
}

/**
 * Reads the conversation id out of a GroupContext's extensions and checks that nothing else rides
 * along. Why (review §4 "AAD"): the relay chooses the conversation-to-group mapping, so the id must
 * live where the relay cannot edit it, and every key of the group derives from the GroupContext.
 * Any other extension is refused: phase 1 uses none, and an extension nobody reviewed is surface.
 */
export function readConversationId(extensions: readonly Extension[]): string {
  if (extensions.length !== 1) {
    throw fail(
      MlsEngineErrorCode.UNSUPPORTED_EXTENSION,
      'The GroupContext must carry exactly the conversation id extension.',
    );
  }
  const [only] = extensions;
  if (only === undefined || only.extensionType !== CONVERSATION_ID_EXTENSION_TYPE) {
    throw fail(
      MlsEngineErrorCode.UNSUPPORTED_EXTENSION,
      'The GroupContext carries an extension we do not speak.',
    );
  }
  const conversationId = decodeId(only.extensionData);
  if (conversationId === undefined) {
    throw fail(
      MlsEngineErrorCode.CONVERSATION_MISMATCH,
      'The conversation id in the GroupContext is not a valid id.',
    );
  }
  return conversationId;
}

/** `GroupContext.extensions` of one epoch equals the next epoch's: nothing, least of all the id, may change. */
export function extensionsIdentical(a: readonly Extension[], b: readonly Extension[]): boolean {
  return (
    a.length === b.length &&
    a.every((ext, i) => {
      const other = b[i];
      return (
        other !== undefined &&
        ext.extensionType === other.extensionType &&
        bytesEqual(ext.extensionData, other.extensionData)
      );
    })
  );
}

// --- Leaf rules --------------------------------------------------------------------------------------

/**
 * Capabilities and extensions of a leaf (RFC 9420 §7.2, §7.3). A device that cannot speak our
 * suite or the conversation extension must not be a member, and a leaf extension is refused
 * outright: the role used to be proposed as one, and one the owner can rewrite is not a badge.
 */
export function assertLeafStructure(leaf: LeafNode): void {
  if (!leaf.capabilities.ciphersuites.includes(MLS_CIPHER_SUITE_NAME)) {
    throw fail(
      MlsEngineErrorCode.SUITE_NOT_PINNED,
      'The leaf does not list cipher suite 1 in its capabilities.',
    );
  }
  if (!leaf.capabilities.credentials.includes('basic')) {
    throw fail(
      MlsEngineErrorCode.CREDENTIAL_INVALID,
      'The leaf does not support the basic credential.',
    );
  }
  if (!leaf.capabilities.extensions.includes(CONVERSATION_ID_EXTENSION_TYPE)) {
    throw fail(
      MlsEngineErrorCode.UNSUPPORTED_EXTENSION,
      'The leaf does not list the conversation id extension in its capabilities (RFC 9420 §7.2).',
    );
  }
  if (leaf.extensions.length > 0) {
    throw fail(
      MlsEngineErrorCode.UNSUPPORTED_EXTENSION,
      'Leaf extensions are not used in phase 1 and are refused.',
    );
  }
}

/**
 * Review §1: "every LeafNode (key package, Update, UpdatePath leaf): (userId, deviceId, role,
 * signatureKey) matches the owner's verified signed list". The list is what the host verified
 * (signature, version, rollback); MLS alone cannot tell a real device from a ghost the relay
 * invented, and this is the check that can. How strictly it reads "the list" depends on the
 * `ListLookup` it is given (live or backlog, see `ListMode`); an ASSISTANT leaf must also be listed
 * for THIS conversation (internal ADR-117 §3, summarised in docs/adr/0001).
 */
export async function assertInSignedList(
  lists: ListLookup,
  identity: DeviceIdentity,
  signatureKey: Uint8Array,
): Promise<void> {
  await lists.require(identity, signatureKey);
}

/**
 * A leaf that already exists changes (its owner's Update or UpdatePath leaf): who it is must stay
 * the same, and above all the ROLE must (review §1: "role cannot change"). Without this a guardian
 * could re-issue its own leaf as USER and walk out of the monitoring the room promised.
 * Checked BEFORE the list, so the precise code reaches the caller.
 */
export function assertSameOwner(previous: DeviceIdentity, next: DeviceIdentity): void {
  if (previous.userId !== next.userId || previous.deviceId !== next.deviceId) {
    throw fail(
      MlsEngineErrorCode.IDENTITY_CHANGED,
      'A leaf update changed whose device the leaf is.',
    );
  }
  if (previous.role !== next.role) {
    throw fail(
      MlsEngineErrorCode.ROLE_CHANGED,
      `A leaf update changed the role from ${previous.role} to ${next.role}.`,
    );
  }
}

/** Identity, structure and signed-list checks that every leaf entering or changing in a tree passes. */
async function validateLeaf(
  lists: ListLookup,
  leaf: LeafNode,
  previous?: DeviceIdentity,
): Promise<DeviceIdentity> {
  const identity = identityOf(leaf);
  if (previous !== undefined) assertSameOwner(previous, identity);
  assertLeafStructure(leaf);
  await assertInSignedList(lists, identity, leaf.signaturePublicKey);
  return identity;
}

/** A leaf outside any commit (the creator's own, at group creation): structure and signed list. */
export async function validateStandaloneLeaf(
  lists: ListLookup,
  leaf: LeafNode,
): Promise<DeviceIdentity> {
  return validateLeaf(lists, leaf);
}

// --- KeyPackage rules -------------------------------------------------------------------------------

/**
 * Security review §1 "key-package lifetime within limits". `notAfter` must lie in
 * `[floor - KEY_PACKAGE_CLOCK_SKEW_SECONDS, now + KEY_PACKAGE_MAX_HORIZON_SECONDS]` and `notBefore`
 * may not be in the future beyond the same skew. Why a horizon: a KeyPackage valid "for ever" is a
 * key that stays attackable for ever once its init key leaks; why a skew: devices' clocks differ by
 * minutes, and refusing a package for that would stall an Add. Only KeyPackages are checked: a leaf
 * already in a tree keeps the lifetime it was added with.
 *
 * `floor` is `now` for a package we are about to use (sending) and for a Welcome. On RECEIVE it is
 * the engine's forward-only floor (about when the relay accepted the Add, never above `now`): a
 * device that was offline for a month must still accept an Add whose package expired since, or it
 * stalls for good (the engine code review, docs/adr/0005). Skipping the lower bound would also be
 * safe, but a floor that moves only forward keeps a package that was already dead years ago out.
 *
 * `minRemainingSeconds` is the SENDER's extra margin (`KEY_PACKAGE_MIN_REMAINING_SECONDS`): we add a
 * package only if it stays valid that long by our clock, so our receivers, judging it against when
 * the relay accepted the commit, never find it expired even if our clock runs behind.
 */
export function assertKeyPackageLifetime(
  leaf: LeafNodeKeyPackage,
  nowSeconds: number,
  floorSeconds: number = nowSeconds,
  minRemainingSeconds?: number,
): void {
  const { notBefore, notAfter } = leaf.lifetime;
  const now = BigInt(nowSeconds);
  const floor = BigInt(Math.min(floorSeconds, nowSeconds));
  const skew = BigInt(KEY_PACKAGE_CLOCK_SKEW_SECONDS);
  const horizon = BigInt(KEY_PACKAGE_MAX_HORIZON_SECONDS);
  const lowest = floor - skew;
  if (
    notBefore > notAfter ||
    notBefore > now + skew ||
    notAfter < lowest ||
    notAfter > now + horizon
  ) {
    throw fail(
      MlsEngineErrorCode.LIFETIME_OUT_OF_RANGE,
      `The KeyPackage lifetime is outside the window: notAfter must lie in [${lowest}, ${now + horizon}] and notBefore at most ${now + skew} (seconds).`,
    );
  }
  if (minRemainingSeconds !== undefined && notAfter < now + BigInt(minRemainingSeconds)) {
    throw fail(
      MlsEngineErrorCode.LIFETIME_OUT_OF_RANGE,
      `The KeyPackage expires in less than ${minRemainingSeconds} seconds: too soon to add it.`,
    );
  }
}

/**
 * A KeyPackage proposed for Add (or about to be added by us), checked end to end without the
 * library: suite and version pinned (§1), RFC 9420 §10.1 key rules, both signatures, lifetime
 * window, canonical credential, leaf structure, and `(userId, deviceId, role, signatureKey)` on the
 * owner's verified signed list (by the mode of `lists`). Returns the identity it carries.
 */
export async function validateKeyPackage(
  ctx: ValidatorContext,
  keyPackage: KeyPackage,
  lists: ListLookup,
): Promise<DeviceIdentity> {
  if (
    keyPackage.cipherSuite !== MLS_CIPHER_SUITE_NAME ||
    keyPackage.version !== MLS_PROTOCOL_VERSION_NAME
  ) {
    throw fail(
      MlsEngineErrorCode.SUITE_NOT_PINNED,
      'The KeyPackage is not MLS 1.0 on cipher suite 1.',
    );
  }
  const { leafNode } = keyPackage;
  if (leafNode.leafNodeSource !== 'key_package') {
    throw fail(
      MlsEngineErrorCode.MALFORMED_MESSAGE,
      'The KeyPackage leaf is not a key_package leaf.',
    );
  }
  // RFC 9420 §10.1: the init key must differ from the leaf's encryption key, otherwise one leaked
  // key opens both the Welcome and the first epochs of the tree.
  if (bytesEqual(keyPackage.initKey, leafNode.hpkePublicKey)) {
    throw fail(
      MlsEngineErrorCode.SIGNATURE_INVALID,
      'The KeyPackage init key equals its leaf encryption key.',
    );
  }
  // RFC 9420 §10.1 / §7.3: both the KeyPackage and its leaf are signed by the leaf's signature key.
  // Checked here because an Add whose package does not verify is an Add of a key nobody holds.
  if (!(await verifyKeyPackage(keyPackage, ctx.cipherSuite.signature))) {
    throw fail(MlsEngineErrorCode.SIGNATURE_INVALID, 'The KeyPackage signature does not verify.');
  }
  if (!(await verifyLeafNodeSignatureKeyPackage(leafNode, ctx.cipherSuite.signature))) {
    throw fail(
      MlsEngineErrorCode.SIGNATURE_INVALID,
      'The KeyPackage leaf signature does not verify.',
    );
  }
  assertKeyPackageLifetime(
    leafNode,
    ctx.nowSeconds(),
    ctx.keyPackageFloorSeconds,
    ctx.sending === true ? KEY_PACKAGE_MIN_REMAINING_SECONDS : undefined,
  );
  return validateLeaf(lists, leafNode);
}

// --- Commit rules -------------------------------------------------------------------------------------

export interface ValidatedAdd {
  readonly identity: DeviceIdentity;
  readonly fingerprint: string;
}

export interface ValidatedRemove {
  readonly leafIndex: number;
  readonly identity: DeviceIdentity;
}

/** What a commit has been proven to do, on the engine's own reading of it. */
export interface ValidatedCommit {
  readonly committerLeafIndex: number;
  readonly committer: DeviceIdentity;
  readonly adds: readonly ValidatedAdd[];
  readonly removes: readonly ValidatedRemove[];
  /** The committer's new leaf from the UpdatePath, when there is one. */
  readonly pathLeafFingerprint: string | undefined;
  readonly delta: MemberDelta;
}

/**
 * The proposal-count caps of one commit, on both sides: `buildCommit` calls it before building one,
 * and `assertCommitShape` for every commit received. Bounds the work a single commit can demand
 * (each Add is two signature checks and a directory lookup).
 */
export function assertProposalCounts(adds: number, removes: number): void {
  if (adds > MAX_ADDS_PER_COMMIT || removes > MAX_REMOVES_PER_COMMIT) {
    throw fail(
      MlsEngineErrorCode.TOO_MANY_PROPOSALS,
      `A commit may carry at most ${MAX_ADDS_PER_COMMIT} Adds and ${MAX_REMOVES_PER_COMMIT} Removes (${adds} and ${removes}).`,
    );
  }
}

function proposalsByValue(commit: Commit): Proposal[] {
  // Checked before anything is read per proposal: the list as a whole is bounded by both caps.
  if (commit.proposals.length > MAX_ADDS_PER_COMMIT + MAX_REMOVES_PER_COMMIT) {
    throw fail(MlsEngineErrorCode.TOO_MANY_PROPOSALS, 'The commit carries too many proposals.');
  }
  const proposals: Proposal[] = [];
  for (const entry of commit.proposals) {
    // RFC 9420 §12.4: a commit may name proposals sent earlier by reference. We never send one on
    // its own (below), so a reference can only point at something the relay or an attacker slipped in.
    if (entry.proposalOrRefType !== 'proposal') {
      throw fail(
        MlsEngineErrorCode.PROPOSAL_BY_REFERENCE_FORBIDDEN,
        'A commit may carry its proposals by value only.',
      );
    }
    proposals.push(entry.proposal);
  }
  return proposals;
}

/** The proposal types after which RFC 9420 §12.4 requires an UpdatePath. */
const PATH_REQUIRING_PROPOSAL_TYPES: ReadonlySet<string> = new Set([
  'update',
  'remove',
  'external_init',
  'group_context_extensions',
]);

/**
 * The UpdatePath rule (RFC 9420 §12.4): a commit needs a path when its proposal list is empty or
 * contains Update, Remove, ExternalInit or GroupContextExtensions. This is the rule whose library
 * copy was wrong twice (GHSA-gwp3-968w-m7gv: Remove; probe F8b: GroupContextExtensions), so the
 * engine owns it: `assertCommitShape` applies it to every commit received, and `buildCommit` asks it
 * whether the commit it is about to send must carry a path.
 */
export function commitNeedsPath(proposals: readonly Proposal[]): boolean {
  return (
    proposals.length === 0 ||
    proposals.some(
      ({ proposalType }) =>
        typeof proposalType === 'string' && PATH_REQUIRING_PROPOSAL_TYPES.has(proposalType),
    )
  );
}

/**
 * The commit-shape rules, in the order a reviewer should read them:
 *
 *  1. at most `MAX_ADDS_PER_COMMIT` Adds and `MAX_REMOVES_PER_COMMIT` Removes; no proposal by
 *     reference, and no standalone proposal (the latter is refused at the message level by the
 *     engine: only commits are accepted);
 *  2. ExternalInit is refused outright (security review §2: no external join exists in phase 1);
 *  3. the UpdatePath rule (`commitNeedsPath`);
 *  4. only Add and Remove are used by phase 1; anything else (PSK, ReInit, Update, GCE, custom) is refused.
 */
export function assertCommitShape(commit: Commit): Proposal[] {
  const proposals = proposalsByValue(commit);
  assertProposalCounts(
    proposals.filter(({ proposalType }) => proposalType === 'add').length,
    proposals.filter(({ proposalType }) => proposalType === 'remove').length,
  );

  if (proposals.some(({ proposalType }) => proposalType === 'external_init')) {
    throw fail(
      MlsEngineErrorCode.EXTERNAL_SENDER_FORBIDDEN,
      'ExternalInit is not accepted: there is no external join.',
    );
  }
  if (commitNeedsPath(proposals) && commit.path === undefined) {
    throw fail(
      MlsEngineErrorCode.PATH_REQUIRED,
      'The commit needs an UpdatePath (RFC 9420 §12.4) and carries none.',
    );
  }

  for (const proposal of proposals) {
    if (proposal.proposalType !== 'add' && proposal.proposalType !== 'remove') {
      throw fail(
        MlsEngineErrorCode.PROPOSAL_NOT_ALLOWED,
        'Only Add and Remove proposals are used in phase 1.',
      );
    }
  }
  return proposals;
}

/** Order-insensitive comparison of what the relay served with what the commit does (review §4). */
export function sameMemberDelta(a: MemberDelta, b: MemberDelta): boolean {
  // The served delta comes from the relay: whatever shape it has, a wrong one is a mismatch, never a TypeError.
  const addedKeys = (delta: MemberDelta): string[] | undefined => {
    if (typeof delta !== 'object' || delta === null) return undefined;
    if (!Array.isArray(delta.added)) return undefined;
    const keys: string[] = [];
    for (const entry of delta.added) {
      if (
        typeof entry?.deviceId !== 'string' ||
        typeof entry.userId !== 'string' ||
        typeof entry.role !== 'string'
      ) {
        return undefined;
      }
      keys.push(`${entry.userId}:${entry.deviceId}:${entry.role}`);
    }
    return keys.sort();
  };
  const removedKeys = (delta: MemberDelta): string[] | undefined => {
    if (typeof delta !== 'object' || delta === null) return undefined;
    if (!Array.isArray(delta.removed) || delta.removed.some((id) => typeof id !== 'string'))
      return undefined;
    return [...delta.removed].sort();
  };
  const sameList = (x: string[] | undefined, y: string[] | undefined): boolean =>
    x !== undefined &&
    y !== undefined &&
    x.length === y.length &&
    x.every((value, i) => value === y[i]);
  return sameList(addedKeys(a), addedKeys(b)) && sameList(removedKeys(a), removedKeys(b));
}

/**
 * A character outside the id alphabet and the `userId:deviceId` key format: a served removal that
 * names nobody (or an ambiguous device id) is rewritten to start with it, so it can never be equal
 * to a key the commit really produced, whatever string a lying relay sends.
 */
const UNRESOLVED_REMOVAL_PREFIX = '\u0000';

/**
 * The relay's `removed` list holds DEVICE ids (its wire shape). The commit's own removals are keyed
 * `userId:deviceId` (a device id is unique per user, not necessarily per room).
 * This resolves each served id to the ONE member of the tree that has it; an id that names nobody,
 * or more than one member, stays unresolved and therefore never matches (`MEMBER_DELTA_MISMATCH`).
 * Garbage in the served delta is left as it is for `sameMemberDelta` to reject.
 */
export function keyServedRemovals(
  served: MemberDelta,
  members: readonly Pick<DeviceIdentity, 'userId' | 'deviceId'>[],
): MemberDelta {
  if (typeof served !== 'object' || served === null || !Array.isArray(served.removed)) {
    return served;
  }
  const keysByDeviceId = new Map<string, string[]>();
  for (const member of members) {
    const keys = keysByDeviceId.get(member.deviceId) ?? [];
    keys.push(deviceKey(member));
    keysByDeviceId.set(member.deviceId, keys);
  }
  const removed = (served.removed as readonly unknown[]).map((id) => {
    if (typeof id !== 'string') return id;
    const keys = keysByDeviceId.get(id);
    const only = keys?.length === 1 ? keys[0] : undefined;
    return only ?? `${UNRESOLVED_REMOVAL_PREFIX}${id}`;
  });
  return { ...served, removed: removed as string[] };
}

export interface ProposalSummary {
  readonly adds: readonly ValidatedAdd[];
  readonly removes: readonly ValidatedRemove[];
  readonly delta: MemberDelta;
}

/**
 * Who may remove a GUARDIAN leaf of child X (internal ADR-117 §4, summarised in docs/adr/0001):
 *
 *  - an admin of X, always;
 *  - a GUARDIAN device of X that the policy says belongs to an admin of X. A guardian leaf carries
 *    the CHILD's `userId`, so in a room with no admin leaf (child, friend, guardian) nobody else
 *    could ever evict a compromised guardian device. The owner's authority is the admin's: a
 *    guardian device that is not registered, or whose owner does not administer X, is no one's agent.
 *
 * A friend, the child itself and a guardian of another child may not.
 */
export function mayRemoveGuardian(
  policy: GuardianPolicy,
  committer: DeviceIdentity,
  target: DeviceIdentity,
): boolean {
  if (policy.isAdminOf(committer.userId, target.userId)) return true;
  if (committer.role !== DeviceRole.GUARDIAN || committer.userId !== target.userId) return false;
  const owner = policy.guardianOwnerOf(target.userId, committer.deviceId);
  return owner !== undefined && policy.isAdminOf(owner, target.userId);
}

/**
 * `mayAdd(committer, added, members)`, enforced on receive (internal ADR-117 §3). Turning
 * Masia on in a room with a child is a PARENT action: when a commit adds an ASSISTANT leaf, every minor in
 * the room it leaves (a user the policy calls a minor, or any user with a GUARDIAN leaf, which only a
 * child's room has) must be administered by the committer. Without this one member alone, a child
 * or another family's adult, could hand the operator a room key, and the ghost-device check cannot
 * help because the operator signs Masia's list itself. That the ASSISTANT leaf belongs to THIS
 * conversation is checked with the signed list (`ListLookup`, `ListedDevice.conversationId`).
 */
export function assertMayAdd(
  policy: GuardianPolicy,
  committer: DeviceIdentity,
  added: readonly DeviceIdentity[],
  roomAfter: readonly DeviceIdentity[],
): void {
  if (!added.some((device) => device.role === DeviceRole.ASSISTANT)) return;
  const minors = new Set<string>();
  for (const member of roomAfter) {
    if (member.role === DeviceRole.ASSISTANT) continue;
    if (member.role === DeviceRole.GUARDIAN || policy.isMinor(member.userId)) {
      minors.add(member.userId);
    }
  }
  for (const minor of minors) {
    if (!policy.isAdminOf(committer.userId, minor)) {
      throw fail(
        MlsEngineErrorCode.ASSISTANT_ADD_FORBIDDEN,
        'Adding Masia to a room with a minor is a parent action: the committer does not administer every minor in it.',
      );
    }
  }
}

/**
 * The proposals of one commit, checked against the tree as it was BEFORE the commit. Used for an
 * incoming commit (from the decrypted bytes) and for one we are about to send (from what we built),
 * so a bug in our own sending code is stopped by the same rules that stop an attacker.
 */
export async function validateProposals(
  ctx: ValidatorContext,
  lists: ListLookup,
  tree: RatchetTree,
  committerLeafIndex: number,
  committer: DeviceIdentity,
  proposals: readonly Proposal[],
): Promise<ProposalSummary> {
  // The room as it will be after the commit (for `assertMayAdd`); `members` also keeps the devices
  // this commit removes, so a device cannot be removed and re-added in one commit.
  const roomAfter = new Map<string, DeviceIdentity>();
  for (const { leaf } of treeLeaves(tree)) {
    const identity = identityOf(leaf);
    roomAfter.set(deviceKey(identity), identity);
  }
  const members = new Set(roomAfter.keys());
  const adds: ValidatedAdd[] = [];
  const removes: ValidatedRemove[] = [];
  const removedLeaves = new Set<number>();

  for (const proposal of proposals) {
    if (proposal.proposalType === 'add') {
      const identity = await validateKeyPackage(ctx, proposal.add.keyPackage, lists);
      // A device is in a group once. The relay rejects the same case (`member-delta.ts`); the tree
      // must too, or a second leaf for one device would outlive its removal.
      const key = deviceKey(identity);
      if (members.has(key)) {
        throw fail(
          MlsEngineErrorCode.DUPLICATE_DEVICE,
          `Device ${identity.deviceId} is already in the group.`,
        );
      }
      members.add(key);
      roomAfter.set(key, identity);
      adds.push({ identity, fingerprint: leafFingerprint(proposal.add.keyPackage.leafNode) });
    } else if (proposal.proposalType === 'remove') {
      const index = proposal.remove.removed;
      if (
        !Number.isSafeInteger(index) ||
        index < 0 ||
        removedLeaves.has(index) ||
        index === committerLeafIndex
      ) {
        throw fail(
          MlsEngineErrorCode.INVALID_REMOVE,
          'A Remove names nobody, the committer itself, or a leaf twice.',
        );
      }
      const target = leafAt(tree, index);
      if (target === undefined) {
        throw fail(MlsEngineErrorCode.INVALID_REMOVE, 'A Remove names a blank leaf.');
      }
      const identity = identityOf(target);
      // Internal ADR-117 §4 / security review §7: removal protection is POLICY, not crypto (any MLS member can commit
      // a Remove), so the engine enforces it on receive. The guardian device lives under the
      // child's account: see `mayRemoveGuardian` for who may take it out of a room.
      if (
        identity.role === DeviceRole.GUARDIAN &&
        !mayRemoveGuardian(ctx.policy, committer, identity)
      ) {
        throw fail(
          MlsEngineErrorCode.GUARDIAN_REMOVE_FORBIDDEN,
          'The committer may not remove a GUARDIAN leaf of that user.',
        );
      }
      roomAfter.delete(deviceKey(identity));
      removedLeaves.add(index);
      removes.push({ leafIndex: index, identity });
    } else {
      throw fail(
        MlsEngineErrorCode.PROPOSAL_NOT_ALLOWED,
        'Only Add and Remove proposals are used in phase 1.',
      );
    }
  }

  if (roomAfter.size > MAX_GROUP_LEAVES) {
    throw fail(
      MlsEngineErrorCode.GROUP_FULL,
      `The group would have more than ${MAX_GROUP_LEAVES} devices.`,
    );
  }
  assertMayAdd(
    ctx.policy,
    committer,
    adds.map(({ identity }) => identity),
    [...roomAfter.values()],
  );

  return {
    adds,
    removes,
    delta: {
      added: adds.map(({ identity }) => ({
        deviceId: identity.deviceId,
        userId: identity.userId,
        role: identity.role,
      })),
      removed: removes.map(({ identity }) => identity.deviceId),
    },
  };
}

/**
 * The committer's new leaf from an UpdatePath (or from our own commit): signed for this group and
 * position (RFC 9420 §7.3), the same owner and ROLE as before (review §1), valid structure, and
 * still on the signed list. Returns the fingerprint the outcome check compares the new tree with.
 * The role is compared BEFORE the list so the caller sees `ROLE_CHANGED`, not a generic miss.
 */
export async function validatePathLeaf(
  ctx: ValidatorContext,
  lists: ListLookup,
  pathLeaf: LeafNode,
  groupId: Uint8Array,
  committerLeafIndex: number,
  committer: DeviceIdentity,
): Promise<string> {
  if (pathLeaf.leafNodeSource !== 'commit') {
    throw fail(MlsEngineErrorCode.MALFORMED_MESSAGE, 'The UpdatePath leaf is not a commit leaf.');
  }
  await validateLeaf(lists, pathLeaf, committer);
  if (
    !(await verifyLeafNodeSignature(
      pathLeaf,
      groupId,
      committerLeafIndex,
      ctx.cipherSuite.signature,
    ))
  ) {
    throw fail(
      MlsEngineErrorCode.SIGNATURE_INVALID,
      'The UpdatePath leaf signature does not verify.',
    );
  }
  return leafFingerprint(pathLeaf);
}

export interface CommitToValidate {
  readonly tree: RatchetTree;
  readonly groupId: Uint8Array;
  readonly sender: Sender;
  readonly commit: Commit;
  /** The delta the relay stored for this commit (review §4). */
  readonly servedDelta: MemberDelta;
  /** The device lists as this validation reads them (live or backlog) and records the versions it relied on. */
  readonly lists: ListLookup;
}

/**
 * Validates an INCOMING commit before the library applies it. Throws on the first rule broken; on
 * success returns what the commit does, in the engine's terms, for the outcome check.
 */
export async function validateCommit(
  ctx: ValidatorContext,
  input: CommitToValidate,
): Promise<ValidatedCommit> {
  const { tree, sender, commit } = input;
  assertTreeBounded(tree);

  // Review §2: a member is the only sender a phase-1 commit can have. External and new-member
  // senders belong to external join / external proposals, which do not exist here.
  if (sender.senderType !== 'member') {
    throw fail(
      MlsEngineErrorCode.EXTERNAL_SENDER_FORBIDDEN,
      'Only a current member may send a commit.',
    );
  }
  const committerLeaf = leafAt(tree, sender.leafIndex);
  if (committerLeaf === undefined) {
    throw fail(MlsEngineErrorCode.MALFORMED_MESSAGE, 'The committer is not a member of the group.');
  }
  const committer = identityOf(committerLeaf);

  const proposals = assertCommitShape(commit);
  const { lists } = input;
  // The engine code review (docs/adr/0005): the committer is on its owner's signed list for EVERY commit. An Add-only
  // commit has no UpdatePath leaf to check, so without this a device revoked but not yet removed
  // could still add devices (Masia among them).
  await assertInSignedList(lists, committer, committerLeaf.signaturePublicKey);
  const summary = await validateProposals(ctx, lists, tree, sender.leafIndex, committer, proposals);

  let pathLeafFingerprint: string | undefined;
  if (commit.path !== undefined) {
    pathLeafFingerprint = await validatePathLeaf(
      ctx,
      lists,
      commit.path.leafNode,
      input.groupId,
      sender.leafIndex,
      committer,
    );
  }

  // Review §4 "lying memberDelta": the relay stores a delta the committer DECLARED. The delta this
  // commit really has is the one computed above from the decrypted proposals; any difference means
  // the relay (or the committer) is lying about who reads.
  // Removals are compared as `userId:deviceId` (the relay names devices only; see `keyServedRemovals`).
  const computedDelta: MemberDelta = {
    added: summary.delta.added,
    removed: summary.removes.map(({ identity }) => deviceKey(identity)),
  };
  const servedDelta = keyServedRemovals(
    input.servedDelta,
    treeLeaves(tree).map(({ leaf }) => identityOf(leaf)),
  );
  if (!sameMemberDelta(computedDelta, servedDelta)) {
    throw fail(
      MlsEngineErrorCode.MEMBER_DELTA_MISMATCH,
      'The member delta the relay served is not the delta of the commit.',
    );
  }

  return {
    committerLeafIndex: sender.leafIndex,
    committer,
    adds: summary.adds,
    removes: summary.removes,
    pathLeafFingerprint,
    delta: summary.delta,
  };
}

/**
 * The outcome check. After the library applied a validated commit, the new tree must be exactly the
 * old one plus the validated Adds, minus the validated Removes, with the committer's leaf replaced
 * by the validated path leaf and every other leaf untouched; the epoch must be the next one, the
 * GroupContext (suite, group id, conversation extension) must not have moved, the tree hash in the
 * new GroupContext must be the hash of the new tree, and the new tree must be parent-hash valid
 * (`assertParentHashesAfterCommit`).
 *
 * Why again after the library: the GHSA bug was the library applying less than the commit said, and
 * the library never checks the parent-hash chain of a tree it built from an incoming UpdatePath
 * (RFC 9420 §7.9.2, §12.4.2). A state that does not match what we validated is thrown away, never
 * adopted.
 */
export async function assertCommitOutcome(
  ctx: ValidatorContext,
  before: { readonly tree: RatchetTree; readonly groupContext: GroupContext },
  after: { readonly tree: RatchetTree; readonly groupContext: GroupContext },
  validated: ValidatedCommit,
): Promise<void> {
  if (
    after.groupContext.epoch !== before.groupContext.epoch + 1n ||
    !bytesEqual(after.groupContext.groupId, before.groupContext.groupId) ||
    after.groupContext.cipherSuite !== before.groupContext.cipherSuite ||
    after.groupContext.version !== before.groupContext.version
  ) {
    throw drift('epoch, group id or suite');
  }
  if (!extensionsIdentical(after.groupContext.extensions, before.groupContext.extensions)) {
    throw drift('the GroupContext extensions changed');
  }
  assertTreeBounded(after.tree);

  const oldLeaves = new Map(
    treeLeaves(before.tree).map(({ leafIndex, leaf }) => [leafIndex, leaf]),
  );
  const newLeaves = new Map(treeLeaves(after.tree).map(({ leafIndex, leaf }) => [leafIndex, leaf]));
  const removedIndexes = new Set(validated.removes.map((r) => r.leafIndex));
  // The same fingerprint cannot come from two Adds (distinct devices have distinct keys), so a set is exact.
  const pendingAdds = new Set(validated.adds.map((a) => a.fingerprint));
  const addedIndexes = new Set<number>();
  const pathLeafIndex =
    validated.pathLeafFingerprint === undefined ? undefined : validated.committerLeafIndex;

  for (const [leafIndex, oldLeaf] of oldLeaves) {
    const newLeaf = newLeaves.get(leafIndex);
    if (removedIndexes.has(leafIndex)) {
      // RFC 9420 §12.3: a freed slot is reused by an Add of the same commit, so it may be occupied
      // again, but only by one of the validated Adds.
      if (newLeaf !== undefined) {
        if (!pendingAdds.delete(leafFingerprint(newLeaf))) {
          throw drift('a removed leaf is still in the tree');
        }
        addedIndexes.add(leafIndex);
      }
    } else if (leafIndex === pathLeafIndex) {
      if (newLeaf === undefined || leafFingerprint(newLeaf) !== validated.pathLeafFingerprint) {
        throw drift("the committer's leaf is not the UpdatePath leaf");
      }
    } else if (newLeaf === undefined || !sameUntouchedLeaf(oldLeaf, newLeaf)) {
      throw drift(`leaf ${leafIndex} changed without being part of the commit`);
    }
  }
  for (const [leafIndex, newLeaf] of newLeaves) {
    if (oldLeaves.has(leafIndex)) continue;
    if (!pendingAdds.delete(leafFingerprint(newLeaf)))
      throw drift(`leaf ${leafIndex} appeared without an Add`);
    addedIndexes.add(leafIndex);
  }
  if (pendingAdds.size > 0) throw drift('an Add did not land in the tree');

  if (
    !bytesEqual(await treeHashRoot(after.tree, ctx.cipherSuite.hash), after.groupContext.treeHash)
  ) {
    throw drift('the tree hash of the new tree is not the one in the new GroupContext');
  }
  await assertParentHashesAfterCommit(ctx.cipherSuite, before.tree, after.tree, {
    pathLeafIndex,
    removedIndexes,
    addedIndexes,
  });
}

/**
 * A leaf the commit did not touch is the same leaf: same keys and identity (the fingerprint), and
 * the same parent hash, which an unchanged parent node above it may rely on (see below).
 */
function sameUntouchedLeaf(before: LeafNode, after: LeafNode): boolean {
  if (leafFingerprint(before) !== leafFingerprint(after)) return false;
  if (before.leafNodeSource === 'commit') {
    return after.leafNodeSource === 'commit' && bytesEqual(before.parentHash, after.parentHash);
  }
  return before.leafNodeSource === after.leafNodeSource;
}

/**
 * RFC 9420 Appendix C: node `x` sits at level `k`, the number of trailing 1 bits of `x`, and its
 * subtree spans the node indexes `x - (2^k - 1) .. x + (2^k - 1)`. This does not depend on the
 * tree's width, so it holds across the extension and truncation a commit may cause.
 */
function subtreeContains(ancestor: number, nodeIndex: number): boolean {
  let level = 0;
  while (((ancestor >> level) & 1) === 1) level += 1;
  const span = (1 << level) - 1;
  return nodeIndex >= ancestor - span && nodeIndex <= ancestor + span;
}

/** The parent hash a node stores: a parent node's own, or a commit-source leaf's (RFC 9420 §7.9). */
function storedParentHash(node: RatchetTree[number]): Uint8Array | undefined {
  if (node?.nodeType === 'parent') return node.parent.parentHash;
  if (node?.nodeType === 'leaf' && node.leaf.leafNodeSource === 'commit') {
    return node.leaf.parentHash;
  }
  return undefined;
}

/** `after` is `before` plus some of the leaves this commit added, with no duplicates. */
function sameUnmergedLeaves(
  before: readonly number[],
  after: readonly number[],
  added: ReadonlySet<number>,
): boolean {
  if (new Set(after).size !== after.length) return false;
  const kept = after.filter((leafIndex) => !added.has(leafIndex));
  const expected = new Set(before);
  return kept.length === expected.size && kept.every((leafIndex) => expected.has(leafIndex));
}

/**
 * RFC 9420 §7.9.2 (every non-blank parent node is parent-hash valid), checked for what ONE commit
 * can change instead of for the whole tree.
 *
 * Re-verifying every chain of the tree (the library's `verifyParentHashes`) hashes each sibling
 * subtree once per leaf below it: quadratic in the group size, on every commit. It is not needed.
 * The tree before the commit is parent-hash valid: a joiner verified the whole tree in
 * `validateJoinedGroup`, and every commit since, sent or received, passed this check. A commit can
 * only change:
 *
 *  - the committer's direct path, rewritten by its UpdatePath. Those nodes are verified by walking
 *    the committer's chain from its leaf to the root: at each non-blank ancestor, the hash the node
 *    below stores must equal the parent hash computed from the new tree. The sibling subtrees halve
 *    on the way up, so the whole walk hashes O(group size) nodes;
 *  - the direct paths of removed leaves, which are blanked;
 *  - the unmerged-leaves lists of the ancestors of added leaves. A parent hash is computed with the
 *    node's unmerged leaves taken out (the "original sibling tree hash"), so an added leaf does not
 *    disturb an existing chain.
 *
 * So every parent node off the committer's direct path must be either blank because a removed leaf
 * sits below it, or the node it was (same key, same parent hash, same unmerged leaves up to the
 * added ones), and every untouched leaf keeps its parent hash (`sameUntouchedLeaf`). Then every
 * chain that witnessed an unchanged node still does, and the committer's chain witnesses the rest.
 * A result that differs in any other way is refused even if it happens to be valid: it is not what
 * the commit said.
 */
async function assertParentHashesAfterCommit(
  cs: CiphersuiteImpl,
  before: RatchetTree,
  after: RatchetTree,
  change: {
    /** The leaf whose UpdatePath was applied; absent for a commit without a path. */
    readonly pathLeafIndex: number | undefined;
    readonly removedIndexes: ReadonlySet<number>;
    readonly addedIndexes: ReadonlySet<number>;
  },
): Promise<void> {
  const pathLeafNode = change.pathLeafIndex === undefined ? undefined : change.pathLeafIndex * 2;
  const removedNodes = [...change.removedIndexes].map((leafIndex) => leafIndex * 2);
  const width = Math.max(before.length, after.length);

  for (let nodeIndex = 1; nodeIndex < width; nodeIndex += 2) {
    const now = nodeIndex < after.length ? after[nodeIndex] : undefined;
    const onPath =
      nodeIndex < after.length &&
      pathLeafNode !== undefined &&
      subtreeContains(nodeIndex, pathLeafNode);
    if (onPath) continue; // verified by the chain walk below
    const was = nodeIndex < before.length ? before[nodeIndex] : undefined;
    if (now === undefined) {
      if (was !== undefined && !removedNodes.some((leaf) => subtreeContains(nodeIndex, leaf))) {
        throw drift(`parent node ${nodeIndex} was blanked, but no removed leaf is below it`);
      }
      continue;
    }
    if (
      now.nodeType !== 'parent' ||
      was?.nodeType !== 'parent' ||
      !bytesEqual(now.parent.hpkePublicKey, was.parent.hpkePublicKey) ||
      !bytesEqual(now.parent.parentHash, was.parent.parentHash) ||
      !sameUnmergedLeaves(was.parent.unmergedLeaves, now.parent.unmergedLeaves, change.addedIndexes)
    ) {
      throw drift(`parent node ${nodeIndex}, outside the committer's path, changed`);
    }
  }

  if (pathLeafNode === undefined) return;
  const rootIndex = root(leafWidth(after.length));
  let current = pathLeafNode;
  while (current !== rootIndex) {
    const stored = storedParentHash(after[current]);
    const [expected, next] = await calculateParentHash(after, toNodeIndex(current), cs.hash);
    if (stored === undefined || next === undefined || !bytesEqual(expected, stored)) {
      throw drift(`a parent hash on the committer's path does not verify at node ${current}`);
    }
    current = next;
  }
}

// --- Welcome rules ------------------------------------------------------------------------------------

export interface JoinedGroup {
  readonly tree: RatchetTree;
  readonly groupContext: GroupContext;
}

/**
 * RFC 9420 §12.4.3.1 and security review §1: a joiner must not take the Welcome's word for the tree. The
 * library verifies these on join; we verify them again, independently, on the state it produced:
 *
 *  - suite and version are the pinned ones;
 *  - the GroupContext names the conversation the caller expected, and nothing else;
 *  - the tree has at most `MAX_GROUP_LEAVES` leaves;
 *  - every leaf's own signature verifies for its position;
 *  - every leaf passes the engine's leaf rules and is on its owner's verified signed list (an ASSISTANT
 *    leaf for THIS conversation);
 *  - no two leaves are the same device;
 *  - the tree hash of the tree equals the one in the signed GroupInfo's GroupContext;
 *  - every parent hash chain verifies.
 *
 * The first six are cheap and run BEFORE the two hash passes, so a malicious member cannot make a
 * phone pay for hashing a tree full of ghosts. (The leaf limit itself was already applied to the
 * Welcome's tree before the library read it; here it is a second line.) The tree hash is one pass
 * over the tree; the full parent-hash verification is the library's, and costs time quadratic in
 * the group size, paid once per join (canon §9.3). A Welcome is read against TODAY's lists (live):
 * a joiner has no earlier epoch to pin, see canon §9.7.
 *
 * Returns the conversation id on success.
 */
export async function validateJoinedGroup(
  ctx: ValidatorContext,
  joined: JoinedGroup,
  expectedConversationId: string,
  lists: ListLookup,
): Promise<string> {
  const { tree, groupContext } = joined;
  const cs = ctx.cipherSuite;
  assertPinnedGroupContext(groupContext);
  assertTreeBounded(tree);

  const conversationId = readConversationId(groupContext.extensions);
  if (conversationId !== expectedConversationId) {
    throw fail(
      MlsEngineErrorCode.CONVERSATION_MISMATCH,
      'The Welcome is for another conversation than the one expected.',
    );
  }

  const treeMismatch = (what: string) =>
    fail(MlsEngineErrorCode.WELCOME_TREE_MISMATCH, `Welcome tree: ${what}.`);

  // The cheap rules first: the leaf limit (`assertTreeBounded` above), then every leaf's signature,
  // structure, duplicate and signed-list check. Only a tree that passes all of them is worth the
  // hash passes below.
  const devices = new Set<string>();
  for (const { leafIndex, leaf } of treeLeaves(tree)) {
    const signatureOk =
      leaf.leafNodeSource === 'key_package'
        ? await verifyLeafNodeSignatureKeyPackage(leaf, cs.signature)
        : await verifyLeafNodeSignature(leaf, groupContext.groupId, leafIndex, cs.signature);
    if (!signatureOk) throw treeMismatch(`the signature of leaf ${leafIndex} does not verify`);

    const identity = await validateLeaf(lists, leaf);
    const key = deviceKey(identity);
    if (devices.has(key)) {
      throw fail(
        MlsEngineErrorCode.DUPLICATE_DEVICE,
        `Device ${identity.deviceId} has two leaves in the tree.`,
      );
    }
    devices.add(key);
  }

  if (!bytesEqual(await treeHashRoot(tree, cs.hash), groupContext.treeHash)) {
    throw treeMismatch('the tree hash does not match the GroupInfo');
  }
  if (!(await verifyParentHashes(tree, cs.hash))) {
    throw treeMismatch('a parent hash does not verify');
  }
  return conversationId;
}
