import {
  type Capabilities,
  type ClientConfig,
  type ClientState,
  type CiphersuiteImpl,
  type IncomingMessageCallback,
  type KeyPackage,
  type MLSMessage,
  type Proposal,
  createApplicationMessage,
  createCommit,
  createGroup as createTsMlsGroup,
  decodeGroupState,
  decodeMlsMessage,
  defaultKeyPackageEqualityConfig,
  defaultKeyRetentionConfig,
  defaultPaddingConfig,
  emptyPskIndex,
  encodeGroupState,
  encodeMlsMessage,
  generateKeyPackageWithKey,
  getCiphersuiteFromName,
  getCiphersuiteImpl,
  joinGroupWithExtensions,
  mlsExporter,
  processPrivateMessage,
} from 'ts-mls';
import { ratchetTreeFromExtension } from 'ts-mls/groupInfo.js';
import { makeKeyPackageRef, verifyKeyPackage } from 'ts-mls/keyPackage.js';
import { unprotectPrivateMessage } from 'ts-mls/messageProtection.js';
import { accumulatePskSecret } from 'ts-mls/pskIndex.js';
import { decryptGroupInfo, decryptGroupSecrets, type Welcome } from 'ts-mls/welcome.js';
import {
  CONVERSATION_ID_EXTENSION_TYPE,
  GROUP_ID_BYTES,
  KEY_PACKAGE_CLOCK_SKEW_SECONDS,
  KEY_PACKAGE_LIFETIME_SECONDS,
  KEY_PACKAGE_MAX_HORIZON_SECONDS,
  MAX_CIPHERTEXT_BYTES,
  MAX_EXPORTER_LABEL_BYTES,
  MAX_EXPORTER_LENGTH,
  MAX_GROUP_ID_BYTES,
  MAX_HANDSHAKE_BYTES,
  MAX_KEY_PACKAGE_BYTES,
  MAX_KEY_PACKAGE_PRIVATE_BYTES,
  MAX_PLAINTEXT_BYTES,
  MLS_CIPHER_SUITE_ID,
  MLS_CIPHER_SUITE_NAME,
  MLS_PROTOCOL_VERSION_NAME,
  MS_PER_SECOND,
  RELAY_BACKLOG_RETENTION_SECONDS,
} from './constants.js';
import { encodeCredentialIdentity, identityOf, isValidId } from './credential.js';
import {
  type KeyPackageSecrets,
  assertExtraAadSize,
  decodeKeyPackageSecrets,
  decodePendingCommitEnvelope,
  decodeStateEnvelope,
  encodeKeyPackageSecrets,
  encodePendingCommitEnvelope,
  encodeStateEnvelope,
  frameAad,
  unframeAad,
} from './framing.js';
import {
  type MlsHeader,
  MlsContentType,
  MlsSenderType,
  MlsWireFormat,
  parseMlsHeader,
} from './message-header.js';
import type {
  AddInput,
  AdoptPendingCommitResult,
  AddResult,
  CreateGroupInput,
  CreateGroupResult,
  DecryptResult,
  DeviceKeys,
  EncryptResult,
  GroupState,
  JoinFromWelcomeInput,
  JoinFromWelcomeResult,
  KeyPackageBundle,
  MemberDelta,
  MemberView,
  MlsEngine,
  MlsEngineContext,
  PendingCommit,
  ProcessCommitInput,
  ProcessCommitResult,
  RemoveInput,
  RemoveResult,
  SelfUpdateResult,
  SigningKeyPair,
} from './mls-engine.js';
import { drift, fail, MlsEngineError, MlsEngineErrorCode } from './mls-error.js';
import {
  assertCommitOutcome,
  assertInSignedList,
  assertPinnedGroupContext,
  assertProposalCounts,
  assertTreeBounded,
  bytesEqual,
  commitNeedsPath,
  conversationIdExtension,
  leafAt,
  ListLookup,
  readConversationId,
  treeLeaves,
  validateCommit,
  validateJoinedGroup,
  validatePathLeaf,
  validateProposals,
  validateStandaloneLeaf,
  type ListMode,
  type ValidatedCommit,
  type ValidatorContext,
} from './validator.js';

/**
 * `MlsEngine` over `ts-mls@1.6.4`: the one implementation phase 1 ships.
 *
 * How it keeps the promise of the interface (see `mls-engine.ts`):
 *
 *  - Every message is checked by `validator.ts` BEFORE the library applies it. A commit is a
 *    PrivateMessage (a PublicMessage commit is refused: we never send one), so the engine first
 *    decrypts it with the library's pure `unprotectPrivateMessage` (nothing is mutated, the sender's
 *    signature is checked), validates the proposals and the path it carries, and only then calls
 *    the library's `processPrivateMessage` on the ORIGINAL state. The state the library returns is
 *    checked against what was validated and thrown away if it differs.
 *  - Every outgoing commit goes through the same rules before it is sent, so a bug on our side
 *    cannot produce a commit we would refuse to receive.
 *  - There is no external join anywhere: `joinGroupExternal`, GroupInfo export, external PSKs and
 *    external senders are not wired, and the validator rejects the first and last on receipt.
 *  - Nothing but `MlsEngineError` leaves a public method (`guarded`).
 *
 * The deep imports (`ts-mls/messageProtection.js` and friends) are ts-mls INTERNALS reached through
 * its `./*.js` exports pattern. They are used because the public API offers no way to read a commit
 * before applying it; they are the reason `ts-mls` is pinned to an exact version.
 */

// --- Library configuration --------------------------------------------------------------------------

/**
 * What every leaf of ours says it can do (RFC 9420 §7.2): MLS 1.0, suite 1, basic credentials, the
 * conversation-id extension. No grease (the library default adds random values), no proposals
 * beyond the always-supported ones.
 */
const LEAF_CAPABILITIES: Capabilities = {
  versions: [MLS_PROTOCOL_VERSION_NAME],
  ciphersuites: [MLS_CIPHER_SUITE_NAME],
  extensions: [CONVERSATION_ID_EXTENSION_TYPE],
  proposals: [],
  credentials: ['basic'],
};

/** Bytes of throwaway data for the key-pair self-check of a KeyPackage's secrets. */
const SECRETS_PROBE_BYTES = 16;

/** Library error texts that mean "the tree a Welcome carried is not valid" (RFC 9420 §12.4.3.1). */
const WELCOME_TREE_ERROR_TEXTS = [
  'Unable to verify parent hash',
  'Unable to verify tree hash',
  'Could not verify leaf node signature',
  'Received Ratchet Tree is not structurally sound',
  'hpke keys not unique',
  'signature keys not unique',
] as const;

function buildClientConfig(): ClientConfig {
  return {
    keyRetentionConfig: defaultKeyRetentionConfig,
    // The library only reads `maximumTotalLifetime` for lifetimes of KeyPackages it validates on
    // its own; ours are checked by the validator against `[now - skew, now + 90 days]`, so the
    // library's limit is set to the same horizon rather than to its one-month default.
    lifetimeConfig: {
      maximumTotalLifetime: BigInt(KEY_PACKAGE_MAX_HORIZON_SECONDS),
      validateLifetimeOnReceive: false,
    },
    keyPackageEqualityConfig: defaultKeyPackageEqualityConfig,
    paddingConfig: defaultPaddingConfig,
    // Second line of defence: the library itself refuses any credential that is not a canonical
    // `{userId, deviceId, role}`. Whether that device is genuine is the validator's job.
    authService: {
      validateCredential(credential) {
        try {
          identityOf({ credential });
          return Promise.resolve(true);
        } catch {
          return Promise.resolve(false);
        }
      },
    },
  };
}

// --- Opaque state -----------------------------------------------------------------------------------

/**
 * The receive floor of a state that has not yet adopted a commit from the relay. Zero means "no
 * relay time seen yet": the floor a KeyPackage is judged against is then the retention horizon
 * (`TsMlsEngine.keyPackageFloor`).
 */
const NO_RELAY_TIME_SEEN = 0;

class TsMlsGroupState implements GroupState {
  readonly kind = 'mls-group-state' as const;

  constructor(
    readonly client: ClientState,
    readonly conversationId: string,
    readonly selfUpdatePending: boolean,
    /**
     * Seconds: the highest relay acceptance time of a commit this state adopted (never above our
     * clock at that moment), or `NO_RELAY_TIME_SEEN`. Moves forward only; see `keyPackageFloor`.
     */
    readonly receiveFloorSeconds: number,
    /**
     * userId -> the device-list version pinned at this epoch (the engine code review,
     * docs/adr/0005). Users in the tree only.
     */
    readonly listPins: ReadonlyMap<string, number>,
  ) {}

  /** The state of a group this device just created or joined: no relay time seen, pins from that one validation. */
  static initial(
    client: ClientState,
    conversationId: string,
    selfUpdatePending: boolean,
    seen: ReadonlyMap<string, number>,
  ): TsMlsGroupState {
    return new TsMlsGroupState(
      client,
      conversationId,
      selfUpdatePending,
      NO_RELAY_TIME_SEEN,
      pinsAfter(new Map(), seen, client.ratchetTree),
    );
  }

  /** The same state with some parts replaced: states are immutable. */
  next(
    changes: Partial<
      Pick<TsMlsGroupState, 'client' | 'selfUpdatePending' | 'receiveFloorSeconds' | 'listPins'>
    >,
  ): TsMlsGroupState {
    return new TsMlsGroupState(
      changes.client ?? this.client,
      this.conversationId,
      changes.selfUpdatePending ?? this.selfUpdatePending,
      changes.receiveFloorSeconds ?? this.receiveFloorSeconds,
      changes.listPins ?? this.listPins,
    );
  }
}

/**
 * The pins after a commit is adopted: for every user still in the tree, the higher of the old pin
 * and the list version this validation relied on. A user who left the room loses the pin with it.
 * Pins only ever move forward, so a replayed or reordered answer cannot roll one back.
 */
function pinsAfter(
  previous: ReadonlyMap<string, number>,
  seen: ReadonlyMap<string, number>,
  tree: ClientState['ratchetTree'],
): ReadonlyMap<string, number> {
  const pins = new Map<string, number>();
  for (const { leaf } of treeLeaves(tree)) {
    const { userId } = identityOf(leaf);
    const version = Math.max(previous.get(userId) ?? 0, seen.get(userId) ?? 0);
    if (version > 0) pins.set(userId, version);
  }
  return pins;
}

function ownState(state: GroupState): TsMlsGroupState {
  if (!(state instanceof TsMlsGroupState)) {
    throw fail(MlsEngineErrorCode.INVALID_STATE, 'This is not a state made by the ts-mls engine.');
  }
  return state;
}

/**
 * The raw ts-mls state behind an engine state. FOR TESTS ONLY (the adversary helpers craft
 * messages with the library directly); it is not exported from the package index.
 */
export function internalClientStateOf(state: GroupState): ClientState {
  return ownState(state).client;
}

/** A commit of ours, posted but not yet acknowledged: the hash of its bytes and the state it leads to. */
class TsMlsPendingCommit implements PendingCommit {
  readonly kind = 'mls-pending-commit' as const;

  constructor(
    readonly commitHash: Uint8Array,
    readonly next: TsMlsGroupState,
  ) {}
}

function ownPending(pending: PendingCommit): TsMlsPendingCommit {
  if (!(pending instanceof TsMlsPendingCommit)) {
    throw fail(
      MlsEngineErrorCode.INVALID_STATE,
      'This is not a pending commit made by the ts-mls engine.',
    );
  }
  return pending;
}

/** Codes a decode of stored bytes lets through as they are; anything else becomes `STATE_CORRUPT`. */
const STORED_BYTES_CODES: ReadonlySet<string> = new Set([
  MlsEngineErrorCode.DECODE_TOO_LARGE,
  MlsEngineErrorCode.STATE_CORRUPT,
  MlsEngineErrorCode.STATE_VERSION_UNSUPPORTED,
  MlsEngineErrorCode.INVALID_ARGUMENT,
]);

// --- Error discipline --------------------------------------------------------------------------------

function toEngineError(error: unknown, joining: boolean): MlsEngineError {
  if (error instanceof MlsEngineError) return error;
  const text = error instanceof Error ? error.message : 'non-error thrown';
  if (joining && WELCOME_TREE_ERROR_TEXTS.some((known) => text.includes(known))) {
    return fail(MlsEngineErrorCode.WELCOME_TREE_MISMATCH, `Welcome tree: ${text}.`, error);
  }
  return fail(
    MlsEngineErrorCode.LIBRARY_REJECTED,
    `The MLS library refused the input: ${text}.`,
    error,
  );
}

async function guarded<T>(operation: () => Promise<T>, joining = false): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw toEngineError(error, joining);
  }
}

function guardedSync<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    throw toEngineError(error, false);
  }
}

/** A caller's argument that must be bytes: anything else is the caller's bug (`INVALID_ARGUMENT`). */
function assertBytes(value: unknown, what: string): asserts value is Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw fail(MlsEngineErrorCode.INVALID_ARGUMENT, `${what} must be a byte array.`);
  }
}

// --- Wire helpers --------------------------------------------------------------------------------------

/** Decodes an MLSMessage the library's way, but demands every byte be used (no smuggled tail). */
function decodeMessage(bytes: Uint8Array): MLSMessage {
  let decoded: ReturnType<typeof decodeMlsMessage>;
  try {
    decoded = decodeMlsMessage(bytes, 0);
  } catch (error) {
    throw fail(MlsEngineErrorCode.MALFORMED_MESSAGE, 'The MLSMessage does not decode.', error);
  }
  if (decoded === undefined || decoded[1] !== bytes.length) {
    throw fail(
      MlsEngineErrorCode.MALFORMED_MESSAGE,
      'The MLSMessage does not decode, or has bytes left over.',
    );
  }
  return decoded[0];
}

function memberViewOf(tree: ClientState['ratchetTree'], leafIndex: number): MemberView {
  const leaf = leafAt(tree, leafIndex);
  if (leaf === undefined) {
    throw fail(MlsEngineErrorCode.INVALID_STATE, `Leaf ${leafIndex} is blank.`);
  }
  return { leafIndex, ...identityOf(leaf) };
}

function ownLeafIndex(client: ClientState): number {
  return client.privatePath.leafIndex;
}

function requireActive(state: TsMlsGroupState): void {
  if (state.client.groupActiveState.kind !== 'active') {
    throw fail(
      MlsEngineErrorCode.NOT_ACTIVE,
      'This device is no longer an active member of the group.',
    );
  }
}

function copy(bytes: Uint8Array): Uint8Array {
  return Uint8Array.from(bytes);
}

// --- Receive helpers ---------------------------------------------------------------------------------------

/**
 * Every rule the cleartext header of an incoming commit can be refused on, applied before a byte
 * is decrypted: wire format, group, sender type, content type, PrivateMessage only, epoch.
 */
function assertCommitHeader(header: MlsHeader, groupContext: ClientState['groupContext']): void {
  if (
    header.wireFormat !== MlsWireFormat.PRIVATE_MESSAGE &&
    header.wireFormat !== MlsWireFormat.PUBLIC_MESSAGE
  ) {
    throw fail(
      MlsEngineErrorCode.UNEXPECTED_MESSAGE_KIND,
      'Expected a commit, got another kind of message.',
    );
  }
  if (!bytesEqual(header.groupId, groupContext.groupId)) {
    throw fail(MlsEngineErrorCode.GROUP_MISMATCH, 'The commit is for another group.');
  }
  // Security review §2: external senders and new-member (external-commit / external-proposal) senders have
  // no place in phase 1. They are only visible in a PublicMessage; a PrivateMessage cannot carry them.
  if (header.sender !== undefined && header.sender.type !== MlsSenderType.MEMBER) {
    throw fail(
      MlsEngineErrorCode.EXTERNAL_SENDER_FORBIDDEN,
      'Only a current member may send a commit.',
    );
  }
  if (header.contentType === MlsContentType.PROPOSAL) {
    throw fail(
      MlsEngineErrorCode.STANDALONE_PROPOSAL_FORBIDDEN,
      'A proposal outside a commit is not accepted.',
    );
  }
  if (header.contentType !== MlsContentType.COMMIT) {
    throw fail(
      MlsEngineErrorCode.UNEXPECTED_MESSAGE_KIND,
      'Expected a commit, got an application message.',
    );
  }
  // We only ever SEND commits as PrivateMessages, so a PublicMessage commit is
  // an extra code path (sender types, membership tag) that nothing honest uses. Refused here,
  // after the external-sender and proposal checks above so those keep their precise codes.
  if (header.wireFormat === MlsWireFormat.PUBLIC_MESSAGE) {
    throw fail(
      MlsEngineErrorCode.UNEXPECTED_MESSAGE_KIND,
      'Commits are PrivateMessages: a PublicMessage commit is not accepted.',
    );
  }
  if (header.epoch !== groupContext.epoch) {
    throw fail(
      MlsEngineErrorCode.EPOCH_MISMATCH,
      'The commit is not for the current epoch (RFC 9420 §12.4.2).',
    );
  }
}

/**
 * The caller's arguments to `joinFromWelcome`, checked before any byte is read: types, the size
 * cap of the stored secrets, and the ids the host expects (a bad one is the host's bug).
 */
function assertWelcomeInputs(input: JoinFromWelcomeInput): void {
  assertBytes(input.welcome, 'The Welcome');
  assertBytes(input.keyPackagePrivate, 'The KeyPackage secrets');
  // Every cap before any byte is read, whichever argument is the big one (security review §1: size-capped).
  if (input.keyPackagePrivate.length > MAX_KEY_PACKAGE_PRIVATE_BYTES) {
    throw fail(
      MlsEngineErrorCode.DECODE_TOO_LARGE,
      'The key package secrets are over the size cap.',
    );
  }
  if (!isValidId(input.expectedConversationId)) {
    throw fail(
      MlsEngineErrorCode.INVALID_ARGUMENT,
      'The expected conversation id is not a valid id.',
    );
  }
  assertBytes(input.expectedGroupId, 'The expected group id');
  if (input.expectedGroupId.length === 0 || input.expectedGroupId.length > MAX_GROUP_ID_BYTES) {
    throw fail(
      MlsEngineErrorCode.INVALID_ARGUMENT,
      'The expected group id is empty or over the size cap.',
    );
  }
  if (typeof input.expectedEpoch !== 'bigint' || input.expectedEpoch < 0n) {
    throw fail(
      MlsEngineErrorCode.INVALID_ARGUMENT,
      'The expected epoch must be a non-negative bigint.',
    );
  }
}

/** A stored-bytes decode failure as the caller sees it: the codes that say why pass, the rest is corruption. */
function storedBytesError(error: unknown, message: string): MlsEngineError {
  if (error instanceof MlsEngineError && STORED_BYTES_CODES.has(error.code)) return error;
  return fail(MlsEngineErrorCode.STATE_CORRUPT, message, error);
}

// --- The engine ----------------------------------------------------------------------------------------

class TsMlsEngine implements MlsEngine {
  private readonly clientConfig = buildClientConfig();

  constructor(
    private readonly context: MlsEngineContext,
    private readonly cs: CiphersuiteImpl,
  ) {}

  private nowSeconds(): number {
    return Math.floor((this.context.now?.() ?? Date.now()) / MS_PER_SECOND);
  }

  /**
   * `keyPackageFloorSeconds`: on receive, the floor from `keyPackageFloor`. `sending`: WE are about
   * to add the KeyPackages, so each must stay valid for `KEY_PACKAGE_MIN_REMAINING_SECONDS`.
   */
  private validatorContext(
    options: { readonly keyPackageFloorSeconds?: number; readonly sending?: boolean } = {},
  ): ValidatorContext {
    return {
      directory: this.context.directory,
      policy: this.context.policy,
      nowSeconds: () => this.nowSeconds(),
      cipherSuite: this.cs,
      ...options,
    };
  }

  /** One validation's view of the signed lists: live (today's list) or backlog (versions pinned per user). */
  private listLookup(
    conversationId: string,
    mode: ListMode,
    pins: ReadonlyMap<string, number> = new Map(),
  ): ListLookup {
    return new ListLookup(
      this.context.directory,
      { conversationId, mode, pins },
      this.context.directoryTimeoutMs,
    );
  }

  /**
   * The relay acceptance time of a commit, in whole seconds and never above our clock, or
   * `undefined` when the host passed none. The only relay time the engine ever stores.
   */
  private relayTimeSeconds(acceptedAtMs: number | undefined): number | undefined {
    if (acceptedAtMs === undefined) return undefined;
    return Math.min(Math.floor(acceptedAtMs / MS_PER_SECOND), this.nowSeconds());
  }

  /**
   * The floor a received KeyPackage's `notAfter` is judged against: the relay's acceptance time
   * of this commit, clamped into [now - retention, now], and never below the highest relay time
   * this state has seen, so it only moves forward. Without a timestamp the commit counts as old as
   * a handshake the relay still serves can be (`RELAY_BACKLOG_RETENTION_SECONDS`, a host contract).
   */
  private keyPackageFloor(state: TsMlsGroupState, relayTime: number | undefined): number {
    const now = this.nowSeconds();
    const horizon = now - RELAY_BACKLOG_RETENTION_SECONDS;
    const thisCommit = Math.min(Math.max(relayTime ?? horizon, horizon), now);
    return Math.max(state.receiveFloorSeconds, thisCommit);
  }

  /**
   * The receive floor STORED after a commit is adopted: the highest relay acceptance time seen,
   * nothing derived from our own clock. A receiver whose clock runs ahead, or a host that passed no
   * time, therefore never pushes the stored floor past what the relay said (the reliability review).
   */
  private storedFloorAfter(state: TsMlsGroupState, relayTime: number | undefined): number {
    return relayTime === undefined
      ? state.receiveFloorSeconds
      : Math.max(state.receiveFloorSeconds, relayTime);
  }

  // --- Keys ---------------------------------------------------------------------------------------------

  generateSigningKeyPair(): Promise<SigningKeyPair> {
    return guarded(async () => {
      const pair = await this.cs.signature.keygen();
      return { publicKey: pair.publicKey, privateKey: pair.signKey };
    });
  }

  private async generateKeyPackage(device: DeviceKeys) {
    const identityBytes = encodeCredentialIdentity(device.identity); // validates ids and role
    assertBytes(device.signingKey?.publicKey, 'The signing public key');
    assertBytes(device.signingKey.privateKey, 'The signing private key');
    const now = this.nowSeconds();
    const generated = await generateKeyPackageWithKey(
      { credentialType: 'basic', identity: identityBytes },
      LEAF_CAPABILITIES,
      // `notBefore` is backdated by the skew we tolerate on receive, so a peer whose clock runs a
      // little behind still accepts the package (the library checks `notBefore <= now` strictly).
      {
        notBefore: BigInt(now - KEY_PACKAGE_CLOCK_SKEW_SECONDS),
        notAfter: BigInt(now + KEY_PACKAGE_LIFETIME_SECONDS),
      },
      [],
      { signKey: device.signingKey.privateKey, publicKey: device.signingKey.publicKey },
      this.cs,
    );
    // A private key that is not the public one's partner makes the package unverifiable: catch
    // that here, on the device that owns the key, not at the first Add.
    if (!(await verifyKeyPackage(generated.publicPackage, this.cs.signature))) {
      throw fail(
        MlsEngineErrorCode.SIGNATURE_INVALID,
        'The signing key pair does not match: the KeyPackage does not verify.',
      );
    }
    return generated;
  }

  createKeyPackage(device: DeviceKeys): Promise<KeyPackageBundle> {
    return guarded(async () => {
      const { publicPackage, privatePackage } = await this.generateKeyPackage(device);
      const keyPackage = encodeMlsMessage({
        version: MLS_PROTOCOL_VERSION_NAME,
        wireformat: 'mls_key_package',
        keyPackage: publicPackage,
      });
      return {
        keyPackage,
        keyPackagePrivate: encodeKeyPackageSecrets({
          keyPackage,
          initPrivateKey: privatePackage.initPrivateKey,
          hpkePrivateKey: privatePackage.hpkePrivateKey,
          signaturePrivateKey: privatePackage.signaturePrivateKey,
        }),
      };
    });
  }

  // --- Group lifecycle ------------------------------------------------------------------------------------

  createGroup(input: CreateGroupInput): Promise<CreateGroupResult> {
    return guarded(async () => {
      if (!isValidId(input.conversationId)) {
        throw fail(MlsEngineErrorCode.INVALID_ARGUMENT, 'The conversation id is not a valid id.');
      }
      const { publicPackage, privatePackage } = await this.generateKeyPackage(input.selfLeaf);
      // The creator is a device like any other: it too must be on its own verified signed list.
      const lists = this.listLookup(input.conversationId, 'live');
      await validateStandaloneLeaf(lists, publicPackage.leafNode);
      const groupId = this.cs.rng.randomBytes(GROUP_ID_BYTES);
      const client = await createTsMlsGroup(
        groupId,
        publicPackage,
        privatePackage,
        [conversationIdExtension(input.conversationId)],
        this.cs,
        this.clientConfig,
      );
      return {
        state: TsMlsGroupState.initial(client, input.conversationId, false, lists.seen),
        groupId: copy(groupId),
      };
    });
  }

  /**
   * Builds a commit of our own, validated on both sides of the library call: the proposals before
   * (the receive rules, applied to ourselves, plus the sender's KeyPackage margin), the resulting
   * leaf and tree after.
   */
  private async buildCommit(state: TsMlsGroupState, proposals: Proposal[], withWelcome: boolean) {
    const client = state.client;
    const index = ownLeafIndex(client);
    const ownLeaf = leafAt(client.ratchetTree, index);
    if (ownLeaf === undefined)
      throw fail(MlsEngineErrorCode.INVALID_STATE, 'This device has no leaf in its own tree.');
    const committer = identityOf(ownLeaf);
    const vctx = this.validatorContext({ sending: true });
    const lists = this.listLookup(state.conversationId, 'live', state.listPins);

    // The receive rule applied to ourselves: a device taken off its owner's list cannot commit.
    await assertInSignedList(lists, committer, ownLeaf.signaturePublicKey);
    const summary = await validateProposals(
      vctx,
      lists,
      client.ratchetTree,
      index,
      committer,
      proposals,
    );

    const created = await createCommit(
      { state: client, cipherSuite: this.cs, pskIndex: emptyPskIndex },
      { extraProposals: proposals, ratchetTreeExtension: withWelcome },
    );
    if (created.commit.wireformat !== 'mls_private_message') {
      throw drift('the commit is not a PrivateMessage');
    }

    // The receive side's UpdatePath rule decides whether our commit carries a path: one rule, one home.
    let pathLeafFingerprint: string | undefined;
    if (commitNeedsPath(proposals)) {
      const newLeaf = leafAt(created.newState.ratchetTree, index);
      if (newLeaf === undefined) throw drift('our leaf vanished');
      pathLeafFingerprint = await validatePathLeaf(
        vctx,
        lists,
        newLeaf,
        client.groupContext.groupId,
        index,
        committer,
      );
    }
    const validated: ValidatedCommit = {
      committerLeafIndex: index,
      committer,
      adds: summary.adds,
      removes: summary.removes,
      pathLeafFingerprint,
      delta: summary.delta,
    };
    await assertCommitOutcome(
      vctx,
      { tree: client.ratchetTree, groupContext: client.groupContext },
      { tree: created.newState.ratchetTree, groupContext: created.newState.groupContext },
      validated,
    );
    return { created, summary, lists };
  }

  /**
   * What one of OUR commits hands the host: the commit bytes, the state after it (the library's new
   * state, with the list versions this validation relied on pinned), and that same state as a
   * `PendingCommit` bound to the hash of exactly these bytes, for a host that may lose the relay's
   * answer (`adoptPendingCommit`, canon §9.7).
   */
  private async ownCommit(
    state: TsMlsGroupState,
    created: { readonly newState: ClientState; readonly commit: MLSMessage },
    lists: ListLookup,
    changes: { readonly selfUpdatePending?: boolean } = {},
  ): Promise<{ state: TsMlsGroupState; commit: Uint8Array; pendingCommit: TsMlsPendingCommit }> {
    const next = state.next({
      client: created.newState,
      listPins: pinsAfter(state.listPins, lists.seen, created.newState.ratchetTree),
      ...changes,
    });
    const commit = encodeMlsMessage(created.commit);
    const pendingCommit = new TsMlsPendingCommit(await this.cs.hash.digest(commit), next);
    return { state: next, commit, pendingCommit };
  }

  add(input: AddInput): Promise<AddResult> {
    return guarded(async () => {
      const state = ownState(input.state);
      requireActive(state);
      const { keyPackages } = input;
      if (!Array.isArray(keyPackages) || keyPackages.length === 0) {
        throw fail(
          MlsEngineErrorCode.INVALID_ARGUMENT,
          'An Add commit carries at least one KeyPackage.',
        );
      }
      assertProposalCounts(keyPackages.length, 0);
      const proposals: Proposal[] = keyPackages.map((bytes) => ({
        proposalType: 'add',
        add: { keyPackage: this.decodeKeyPackage(bytes) },
      }));

      const { created, summary, lists } = await this.buildCommit(state, proposals, true);
      if (created.welcome === undefined) throw drift('an Add produced no Welcome');
      return {
        ...(await this.ownCommit(state, created, lists)),
        welcome: encodeMlsMessage({
          version: MLS_PROTOCOL_VERSION_NAME,
          wireformat: 'mls_welcome',
          welcome: created.welcome,
        }),
        memberDelta: summary.delta,
        requiresNewcomerUpdate: true,
      };
    });
  }

  private decodeKeyPackage(bytes: Uint8Array): KeyPackage {
    assertBytes(bytes, 'A KeyPackage');
    const header = parseMlsHeader(bytes, MAX_KEY_PACKAGE_BYTES);
    if (header.wireFormat !== MlsWireFormat.KEY_PACKAGE) {
      throw fail(MlsEngineErrorCode.UNEXPECTED_MESSAGE_KIND, 'Expected a KeyPackage.');
    }
    if (header.cipherSuite !== MLS_CIPHER_SUITE_ID) {
      throw fail(MlsEngineErrorCode.SUITE_NOT_PINNED, 'The KeyPackage is not on cipher suite 1.');
    }
    const message = decodeMessage(bytes);
    if (message.wireformat !== 'mls_key_package') {
      throw fail(MlsEngineErrorCode.UNEXPECTED_MESSAGE_KIND, 'Expected a KeyPackage.');
    }
    return message.keyPackage;
  }

  /**
   * The secrets a device kept for a KeyPackage must be the ones that belong to it. The library does
   * not check: a bit flipped in a stored private key still "joins", and leaves a member that can
   * never read a commit or sign one a peer accepts. So: seal to each public key and open with the
   * stored private key; sign with the stored signing key and verify with the leaf's.
   */
  private async assertSecretsBelongToKeyPackage(
    secrets: KeyPackageSecrets,
    keyPackage: KeyPackage,
  ): Promise<void> {
    const corrupt = () =>
      fail(
        MlsEngineErrorCode.STATE_CORRUPT,
        'Key package secrets: a private key does not belong to the KeyPackage.',
      );
    const probe = this.cs.rng.randomBytes(SECRETS_PROBE_BYTES);
    const noInfo = new Uint8Array();
    const pairs: readonly (readonly [privateKey: Uint8Array, publicKey: Uint8Array])[] = [
      [secrets.initPrivateKey, keyPackage.initKey],
      [secrets.hpkePrivateKey, keyPackage.leafNode.hpkePublicKey],
    ];
    try {
      for (const [privateKey, publicKey] of pairs) {
        const sealed = await this.cs.hpke.seal(
          await this.cs.hpke.importPublicKey(publicKey),
          probe,
          noInfo,
        );
        const opened = await this.cs.hpke.open(
          await this.cs.hpke.importPrivateKey(privateKey),
          sealed.enc,
          sealed.ct,
          noInfo,
        );
        if (!bytesEqual(opened, probe)) throw corrupt();
      }
      const signature = await this.cs.signature.sign(secrets.signaturePrivateKey, probe);
      if (
        !(await this.cs.signature.verify(keyPackage.leafNode.signaturePublicKey, probe, signature))
      )
        throw corrupt();
    } catch (error) {
      throw error instanceof MlsEngineError ? error : corrupt();
    }
  }

  remove(input: RemoveInput): Promise<RemoveResult> {
    return guarded(async () => {
      const state = ownState(input.state);
      requireActive(state);
      const { leafIndexes } = input;
      if (!Array.isArray(leafIndexes) || leafIndexes.length === 0) {
        throw fail(MlsEngineErrorCode.INVALID_ARGUMENT, 'A Remove commit names at least one leaf.');
      }
      assertProposalCounts(0, leafIndexes.length);
      const proposals: Proposal[] = leafIndexes.map((removed) => ({
        proposalType: 'remove',
        remove: { removed },
      }));
      const { created, summary, lists } = await this.buildCommit(state, proposals, false);
      return { ...(await this.ownCommit(state, created, lists)), memberDelta: summary.delta };
    });
  }

  selfUpdate(groupState: GroupState): Promise<SelfUpdateResult> {
    return guarded(async () => {
      const state = ownState(groupState);
      requireActive(state);
      // Never a GroupContextExtensions-only commit: F8b (the library lets one through without a
      // path). An empty proposal list always forces an UpdatePath (RFC 9420 §12.4).
      const { created, lists } = await this.buildCommit(state, [], false);
      return this.ownCommit(state, created, lists, { selfUpdatePending: false });
    });
  }

  // --- Receive: commits ---------------------------------------------------------------------------------------

  processCommit(input: ProcessCommitInput): Promise<ProcessCommitResult> {
    return guarded(async () => {
      const state = ownState(input.state);
      assertBytes(input.commit, 'The commit');
      if (input.backlog !== undefined && typeof input.backlog !== 'boolean') {
        throw fail(MlsEngineErrorCode.INVALID_ARGUMENT, 'The backlog flag must be a boolean.');
      }
      if (
        input.acceptedAtMs !== undefined &&
        (typeof input.acceptedAtMs !== 'number' || !Number.isFinite(input.acceptedAtMs))
      ) {
        throw fail(
          MlsEngineErrorCode.INVALID_ARGUMENT,
          'The relay acceptance time must be a finite number of milliseconds.',
        );
      }
      return this.receiveCommit(state, input.commit, input.servedMemberDelta, {
        mode: input.backlog === true ? 'backlog' : 'live',
        acceptedAtMs: input.acceptedAtMs,
      });
    });
  }

  private async receiveCommit(
    state: TsMlsGroupState,
    commitBytes: Uint8Array,
    servedDelta: MemberDelta,
    reading: { readonly mode: ListMode; readonly acceptedAtMs: number | undefined },
  ): Promise<ProcessCommitResult> {
    const client = state.client;
    requireActive(state);

    // 1. Everything the cleartext header can refuse, refused before a byte is decrypted.
    assertCommitHeader(parseMlsHeader(commitBytes, MAX_HANDSHAKE_BYTES), client.groupContext);

    // 2. Read the commit without applying it: pure, signature-checked by the library.
    const message = decodeMessage(commitBytes);
    if (message.wireformat !== 'mls_private_message') {
      throw fail(
        MlsEngineErrorCode.UNEXPECTED_MESSAGE_KIND,
        'Expected a commit, got another kind of message.',
      );
    }
    const { content } = await unprotectPrivateMessage(
      client.keySchedule.senderDataSecret,
      message.privateMessage,
      client.secretTree,
      client.ratchetTree,
      client.groupContext,
      client.clientConfig.keyRetentionConfig,
      this.cs,
    );
    const framed = content.content;
    if (framed.contentType !== 'commit') {
      throw fail(
        MlsEngineErrorCode.UNEXPECTED_MESSAGE_KIND,
        'The decrypted content is not a commit.',
      );
    }
    const index = ownLeafIndex(client);
    if (framed.sender.senderType === 'member' && framed.sender.leafIndex === index) {
      throw fail(
        MlsEngineErrorCode.UNEXPECTED_MESSAGE_KIND,
        'This is our own commit: adopt it with adoptPendingCommit, never process it.',
      );
    }

    // 3. THE VALIDATOR. A live commit is read against today's signed lists; a backlog one against
    // the versions pinned at the previous epoch. KeyPackages are judged against the forward-only floor.
    const relayTime = this.relayTimeSeconds(reading.acceptedAtMs);
    const vctx = this.validatorContext({
      keyPackageFloorSeconds: this.keyPackageFloor(state, relayTime),
    });
    const lists = this.listLookup(state.conversationId, reading.mode, state.listPins);
    const validated = await validateCommit(vctx, {
      tree: client.ratchetTree,
      groupId: client.groupContext.groupId,
      sender: framed.sender,
      commit: framed.commit,
      servedDelta,
      lists,
    });

    // 4. Let the library apply it, with a callback that refuses anything that is not what we read.
    const expectedProposals = validated.adds.length + validated.removes.length;
    const callback: IncomingMessageCallback = (incoming) =>
      incoming.kind === 'commit' && incoming.proposals.length === expectedProposals
        ? 'accept'
        : 'reject';
    const applied = await processPrivateMessage(
      client,
      message.privateMessage,
      emptyPskIndex,
      this.cs,
      callback,
    );
    if (applied.kind !== 'newState' || applied.actionTaken !== 'accept') {
      throw drift('the library read different proposals than the validator did');
    }
    const next: ClientState = applied.newState;

    // 5. Check what it built.
    const selfRemoved = validated.removes.some((removal) => removal.leafIndex === index);
    if (selfRemoved) {
      // A removed member cannot derive the next epoch (RFC 9420 §12.4.2): the library records the
      // removal and keeps the old epoch's secrets. Its state is inert for sending.
      if (next.groupActiveState.kind !== 'removedFromGroup')
        throw drift('we were removed but the state is still active');
      return {
        state: state.next({ client: next }),
        epochAuthenticator: null,
        memberDelta: validated.delta,
        removedFromGroup: true,
      };
    }
    if (next.groupActiveState.kind !== 'active')
      throw drift('the group state is not active after a commit');
    await assertCommitOutcome(
      vctx,
      { tree: client.ratchetTree, groupContext: client.groupContext },
      { tree: next.ratchetTree, groupContext: next.groupContext },
      validated,
    );
    // Adopted: the pins advance to the list versions this commit relied on, and the floor moves up.
    return {
      state: state.next({
        client: next,
        receiveFloorSeconds: this.storedFloorAfter(state, relayTime),
        listPins: pinsAfter(state.listPins, lists.seen, next.ratchetTree),
      }),
      epochAuthenticator: copy(next.keySchedule.epochAuthenticator),
      memberDelta: validated.delta,
      removedFromGroup: false,
    };
  }

  // --- Receive: Welcome ---------------------------------------------------------------------------------------

  joinFromWelcome(input: JoinFromWelcomeInput): Promise<JoinFromWelcomeResult> {
    return guarded(async () => {
      assertWelcomeInputs(input);

      const header = parseMlsHeader(input.welcome, MAX_HANDSHAKE_BYTES);
      if (header.wireFormat !== MlsWireFormat.WELCOME) {
        throw fail(MlsEngineErrorCode.UNEXPECTED_MESSAGE_KIND, 'Expected a Welcome.');
      }
      if (header.cipherSuite !== MLS_CIPHER_SUITE_ID) {
        throw fail(MlsEngineErrorCode.SUITE_NOT_PINNED, 'The Welcome is not on cipher suite 1.');
      }
      const message = decodeMessage(input.welcome);
      if (message.wireformat !== 'mls_welcome') {
        throw fail(MlsEngineErrorCode.UNEXPECTED_MESSAGE_KIND, 'Expected a Welcome.');
      }

      const secrets = decodeKeyPackageSecrets(input.keyPackagePrivate);
      const keyPackage = this.decodeKeyPackage(secrets.keyPackage);
      await this.assertSecretsBelongToKeyPackage(secrets, keyPackage);

      // The library joins first because the GroupInfo is encrypted: it also checks the GroupInfo
      // signature and the confirmation tag. What it hands back is then verified again by us. Only
      // the size of the tree is checked before: the library's own tree checks cost time quadratic
      // in the group size, so a Welcome over the leaf cap must not reach them.
      const [client, groupInfoExtensions] = await guarded(async () => {
        await this.assertWelcomeTreeBounded(message.welcome, keyPackage, secrets.initPrivateKey);
        return joinGroupWithExtensions(
          message.welcome,
          keyPackage,
          {
            initPrivateKey: secrets.initPrivateKey,
            hpkePrivateKey: secrets.hpkePrivateKey,
            signaturePrivateKey: secrets.signaturePrivateKey,
          },
          emptyPskIndex,
          this.cs,
          undefined,
          undefined,
          this.clientConfig,
        );
      }, true);

      // Security review §2: no external join, so no external_pub in a GroupInfo (it is what would let a
      // GroupInfo holder join without being added) and nothing but the ratchet tree besides.
      for (const extension of groupInfoExtensions) {
        if (extension.extensionType !== 'ratchet_tree') {
          throw fail(
            MlsEngineErrorCode.UNSUPPORTED_EXTENSION,
            'The GroupInfo carries an extension other than the ratchet tree.',
          );
        }
      }

      // A member could Welcome us into a PARALLEL group of the same conversation
      // (KeyPackage-source leaves are not signed per group). The host knows which group and epoch
      // the Add commit made; anything else is refused before the tree is examined.
      if (!bytesEqual(client.groupContext.groupId, input.expectedGroupId)) {
        throw fail(
          MlsEngineErrorCode.GROUP_MISMATCH,
          'The Welcome is for another group than the one expected.',
        );
      }
      if (client.groupContext.epoch !== input.expectedEpoch) {
        throw fail(
          MlsEngineErrorCode.EPOCH_MISMATCH,
          'The Welcome establishes another epoch than the one expected.',
        );
      }

      const lists = this.listLookup(input.expectedConversationId, 'live');
      const conversationId = await validateJoinedGroup(
        this.validatorContext(),
        { tree: client.ratchetTree, groupContext: client.groupContext },
        input.expectedConversationId,
        lists,
      );

      const own = leafAt(client.ratchetTree, ownLeafIndex(client));
      if (
        own === undefined ||
        !bytesEqual(own.signaturePublicKey, keyPackage.leafNode.signaturePublicKey)
      ) {
        throw fail(
          MlsEngineErrorCode.WELCOME_TREE_MISMATCH,
          'Welcome tree: our own leaf is not the one we offered.',
        );
      }
      if (client.groupActiveState.kind !== 'active') {
        throw drift('a joined group is not active');
      }

      return {
        state: TsMlsGroupState.initial(client, conversationId, true, lists.seen),
        epochAuthenticator: copy(client.keySchedule.epochAuthenticator),
        requiresSelfUpdate: true,
      };
    });
  }

  welcomeAddressedTo(welcome: Uint8Array, keyPackagePrivate: Uint8Array): Promise<boolean> {
    return guarded(async () => {
      assertBytes(welcome, 'The Welcome');
      assertBytes(keyPackagePrivate, 'The KeyPackage secrets');
      if (keyPackagePrivate.length > MAX_KEY_PACKAGE_PRIVATE_BYTES) {
        throw fail(
          MlsEngineErrorCode.DECODE_TOO_LARGE,
          'The key package secrets are over the size cap.',
        );
      }
      const header = parseMlsHeader(welcome, MAX_HANDSHAKE_BYTES);
      if (header.wireFormat !== MlsWireFormat.WELCOME) {
        throw fail(MlsEngineErrorCode.UNEXPECTED_MESSAGE_KIND, 'Expected a Welcome.');
      }
      const message = decodeMessage(welcome);
      if (message.wireformat !== 'mls_welcome') {
        throw fail(MlsEngineErrorCode.UNEXPECTED_MESSAGE_KIND, 'Expected a Welcome.');
      }
      const secrets = decodeKeyPackageSecrets(keyPackagePrivate);
      const ref = await makeKeyPackageRef(this.decodeKeyPackage(secrets.keyPackage), this.cs.hash);
      return message.welcome.secrets.some((entry) => bytesEqual(entry.newMember, ref));
    });
  }

  /**
   * Counts the leaves of the tree a Welcome carries BEFORE the library reads it (canon §9.3), and
   * refuses a tree over `MAX_GROUP_LEAVES` with `DECODE_TOO_LARGE`. The tree rides inside the
   * encrypted GroupInfo, so reaching it takes the library's own first steps (one HPKE open, one
   * AEAD open, one decode bounded by `MAX_HANDSHAKE_BYTES`, all linear); `joinGroupWithExtensions`
   * then repeats them. A Welcome that does not get that far is left for the library to refuse with
   * its own error.
   */
  private async assertWelcomeTreeBounded(
    welcome: Welcome,
    keyPackage: KeyPackage,
    initPrivateKey: Uint8Array,
  ): Promise<void> {
    const groupSecrets = await decryptGroupSecrets(
      await this.cs.hpke.importPrivateKey(initPrivateKey),
      await makeKeyPackageRef(keyPackage, this.cs.hash),
      welcome,
      this.cs.hpke,
    );
    if (groupSecrets === undefined) return;
    const [pskSecret] = await accumulatePskSecret(
      groupSecrets.psks,
      emptyPskIndex,
      this.cs,
      new Uint8Array(this.cs.kdf.size),
    );
    const groupInfo = await decryptGroupInfo(
      welcome,
      groupSecrets.joinerSecret,
      pskSecret,
      this.cs,
    );
    if (groupInfo === undefined) return;
    const tree = ratchetTreeFromExtension(groupInfo);
    if (tree !== undefined) assertTreeBounded(tree);
  }

  // --- Application messages ----------------------------------------------------------------------------------------

  encrypt(groupState: GroupState, plaintext: Uint8Array, aad?: Uint8Array): Promise<EncryptResult> {
    return guarded(async () => {
      const state = ownState(groupState);
      assertBytes(plaintext, 'The plaintext');
      if (aad !== undefined) assertBytes(aad, 'The additional authenticated data');
      requireActive(state);
      if (aad !== undefined) assertExtraAadSize(aad);
      if (plaintext.length > MAX_PLAINTEXT_BYTES) {
        throw fail(
          MlsEngineErrorCode.DECODE_TOO_LARGE,
          'The plaintext is over the envelope limit.',
        );
      }
      const result = await createApplicationMessage(
        state.client,
        plaintext,
        this.cs,
        frameAad(state.conversationId, aad),
      );
      const ciphertext = encodeMlsMessage({
        version: MLS_PROTOCOL_VERSION_NAME,
        wireformat: 'mls_private_message',
        privateMessage: result.privateMessage,
      });
      // `MAX_PLAINTEXT_BYTES` is derived so that this cannot happen (constants.ts); it is checked
      // anyway, because a message over the relay's envelope would be refused by every relay and by
      // every `decrypt`. The ciphertext is discarded and never leaves the engine, so the caller's
      // unchanged state using that ratchet step again for its next message exposes nothing.
      if (ciphertext.length > MAX_CIPHERTEXT_BYTES) {
        throw drift(
          `the ciphertext is ${ciphertext.length} bytes, over the ${MAX_CIPHERTEXT_BYTES}-byte envelope`,
        );
      }
      return { state: state.next({ client: result.newState }), ciphertext };
    });
  }

  decrypt(
    groupState: GroupState,
    ciphertext: Uint8Array,
    aad?: Uint8Array,
  ): Promise<DecryptResult> {
    return guarded(async () => {
      const state = ownState(groupState);
      assertBytes(ciphertext, 'The ciphertext');
      if (aad !== undefined) {
        assertBytes(aad, 'The additional authenticated data');
        assertExtraAadSize(aad);
      }
      const client = state.client;

      const header = parseMlsHeader(ciphertext, MAX_CIPHERTEXT_BYTES);
      if (header.wireFormat !== MlsWireFormat.PRIVATE_MESSAGE) {
        throw fail(
          MlsEngineErrorCode.UNEXPECTED_MESSAGE_KIND,
          'Application messages are PrivateMessages.',
        );
      }
      if (!bytesEqual(header.groupId, client.groupContext.groupId)) {
        throw fail(MlsEngineErrorCode.GROUP_MISMATCH, 'The message is for another group.');
      }
      if (header.contentType !== MlsContentType.APPLICATION) {
        throw fail(MlsEngineErrorCode.UNEXPECTED_MESSAGE_KIND, 'Expected an application message.');
      }
      if (header.epoch > client.groupContext.epoch) {
        throw fail(
          MlsEngineErrorCode.EPOCH_MISMATCH,
          'The message is from an epoch this device has not reached.',
        );
      }
      const message = decodeMessage(ciphertext);
      if (message.wireformat !== 'mls_private_message') {
        throw fail(
          MlsEngineErrorCode.UNEXPECTED_MESSAGE_KIND,
          'Application messages are PrivateMessages.',
        );
      }

      // Which epoch's secrets and tree open this message (the library keeps a few past epochs).
      const epochSecrets =
        header.epoch === client.groupContext.epoch
          ? {
              senderDataSecret: client.keySchedule.senderDataSecret,
              secretTree: client.secretTree,
              ratchetTree: client.ratchetTree,
              groupContext: client.groupContext,
            }
          : client.historicalReceiverData.get(header.epoch);
      if (epochSecrets === undefined) {
        throw fail(
          MlsEngineErrorCode.EPOCH_MISMATCH,
          'The message is from an epoch this device no longer keeps keys for.',
        );
      }
      const opened = (
        await unprotectPrivateMessage(
          epochSecrets.senderDataSecret,
          message.privateMessage,
          epochSecrets.secretTree,
          epochSecrets.ratchetTree,
          epochSecrets.groupContext,
          client.clientConfig.keyRetentionConfig,
          this.cs,
        )
      ).content.content;
      if (opened.contentType !== 'application' || opened.sender.senderType !== 'member') {
        throw fail(
          MlsEngineErrorCode.UNEXPECTED_MESSAGE_KIND,
          'The decrypted content is not an application message from a member.',
        );
      }
      const extra = unframeAad(state.conversationId, opened.authenticatedData);
      if (aad !== undefined && !bytesEqual(extra, aad)) {
        throw fail(
          MlsEngineErrorCode.AAD_MISMATCH,
          'The additional authenticated data is not the one expected.',
        );
      }
      const sender = memberViewOf(epochSecrets.ratchetTree, opened.sender.leafIndex);

      // The library advances the ratchet on its own copy of the state.
      const result = await processPrivateMessage(
        client,
        message.privateMessage,
        emptyPskIndex,
        this.cs,
      );
      if (result.kind !== 'applicationMessage')
        throw drift('an application message produced a commit');
      return {
        state: state.next({ client: result.newState }),
        plaintext: copy(result.message),
        sender,
        aad: extra,
      };
    });
  }

  exporter(
    groupState: GroupState,
    label: string,
    length: number,
    context?: Uint8Array,
  ): Promise<Uint8Array> {
    return guarded(async () => {
      const state = ownState(groupState);
      requireActive(state);
      if (
        typeof label !== 'string' ||
        new TextEncoder().encode(label).length > MAX_EXPORTER_LABEL_BYTES
      ) {
        throw fail(
          MlsEngineErrorCode.INVALID_ARGUMENT,
          `The exporter label must be a string of at most ${MAX_EXPORTER_LABEL_BYTES} bytes.`,
        );
      }
      if (!Number.isInteger(length) || length < 1 || length > MAX_EXPORTER_LENGTH) {
        throw fail(
          MlsEngineErrorCode.INVALID_ARGUMENT,
          `The exporter length must be 1 to ${MAX_EXPORTER_LENGTH}.`,
        );
      }
      if (context !== undefined) assertBytes(context, 'The exporter context');
      return mlsExporter(
        state.client.keySchedule.exporterSecret,
        label,
        context ?? new Uint8Array(),
        length,
        this.cs,
      );
    });
  }

  // --- Reading a state ---------------------------------------------------------------------------------------------

  members(groupState: GroupState): readonly MemberView[] {
    return guardedSync(() => {
      const { client } = ownState(groupState);
      return treeLeaves(client.ratchetTree).map(({ leafIndex, leaf }) => ({
        leafIndex,
        ...identityOf(leaf),
      }));
    });
  }

  self(groupState: GroupState): MemberView {
    return guardedSync(() => {
      const { client } = ownState(groupState);
      return memberViewOf(client.ratchetTree, ownLeafIndex(client));
    });
  }

  conversationId(groupState: GroupState): string {
    return guardedSync(() => ownState(groupState).conversationId);
  }

  groupId(groupState: GroupState): Uint8Array {
    return guardedSync(() => copy(ownState(groupState).client.groupContext.groupId));
  }

  treeHash(groupState: GroupState): Uint8Array {
    return guardedSync(() => copy(ownState(groupState).client.groupContext.treeHash));
  }

  epoch(groupState: GroupState): bigint {
    return guardedSync(() => ownState(groupState).client.groupContext.epoch);
  }

  epochAuthenticator(groupState: GroupState): Uint8Array {
    return guardedSync(() => copy(ownState(groupState).client.keySchedule.epochAuthenticator));
  }

  isActive(groupState: GroupState): boolean {
    return guardedSync(() => ownState(groupState).client.groupActiveState.kind === 'active');
  }

  needsSelfUpdate(groupState: GroupState): boolean {
    return guardedSync(() => ownState(groupState).selfUpdatePending);
  }

  // --- Persistence ----------------------------------------------------------------------------------------------------

  encodeState(groupState: GroupState): Uint8Array {
    return guardedSync(() => {
      const state = ownState(groupState);
      return encodeStateEnvelope({
        conversationId: state.conversationId,
        selfUpdatePending: state.selfUpdatePending,
        receiveFloorSeconds: state.receiveFloorSeconds,
        listPins: state.listPins,
        clientState: encodeGroupState(state.client),
      });
    });
  }

  decodeState(bytes: Uint8Array): GroupState {
    try {
      assertBytes(bytes, 'The serialized state');
      return this.decodeOwnState(bytes);
    } catch (error) {
      throw storedBytesError(error, 'Group state does not decode.');
    }
  }

  private decodeOwnState(bytes: Uint8Array): TsMlsGroupState {
    const envelope = decodeStateEnvelope(bytes);
    const decoded = decodeGroupState(envelope.clientState, 0);
    if (decoded === undefined || decoded[1] !== envelope.clientState.length) {
      throw fail(
        MlsEngineErrorCode.STATE_CORRUPT,
        'Group state: the ts-mls state does not decode.',
      );
    }
    // `clientConfig` is not part of the library's encoding: re-attach ours.
    const client: ClientState = { ...decoded[0], clientConfig: this.clientConfig };
    assertPinnedGroupContext(client.groupContext);
    if (readConversationId(client.groupContext.extensions) !== envelope.conversationId) {
      throw fail(
        MlsEngineErrorCode.STATE_CORRUPT,
        'Group state: the conversation id does not match the GroupContext.',
      );
    }
    memberViewOf(client.ratchetTree, ownLeafIndex(client));
    return new TsMlsGroupState(
      client,
      envelope.conversationId,
      envelope.selfUpdatePending,
      envelope.receiveFloorSeconds,
      envelope.listPins,
    );
  }

  // --- Our own commits, across a lost acknowledgement --------------------------------------------------------

  adoptPendingCommit(
    groupState: GroupState,
    pendingCommit: PendingCommit,
    relayCommit: Uint8Array,
  ): Promise<AdoptPendingCommitResult> {
    return guarded(async () => {
      const state = ownState(groupState);
      const pending = ownPending(pendingCommit);
      assertBytes(relayCommit, 'The relay commit');
      if (relayCommit.length > MAX_HANDSHAKE_BYTES) {
        throw fail(MlsEngineErrorCode.DECODE_TOO_LARGE, 'The relay commit is over the size cap.');
      }
      const current = state.client.groupContext;
      const target = pending.next.client.groupContext;
      if (!bytesEqual(current.groupId, target.groupId)) {
        throw fail(
          MlsEngineErrorCode.INVALID_ARGUMENT,
          'The pending commit belongs to another group than this state.',
        );
      }
      // Already adopted: the host saved the new state, then lost the pending commit's deletion.
      if (
        current.epoch === target.epoch &&
        bytesEqual(
          state.client.keySchedule.epochAuthenticator,
          pending.next.client.keySchedule.epochAuthenticator,
        )
      ) {
        return { adopted: true, state };
      }
      // Built on another epoch than this state's: it cannot be the commit that moves this state on.
      if (target.epoch !== current.epoch + 1n) return { adopted: false };
      // The relay took exactly our bytes (the acknowledgement was lost), or another commit won.
      const relayHash = await this.cs.hash.digest(relayCommit);
      return bytesEqual(relayHash, pending.commitHash)
        ? { adopted: true, state: pending.next }
        : { adopted: false };
    });
  }

  encodePendingCommit(pendingCommit: PendingCommit): Uint8Array {
    return guardedSync(() => {
      const pending = ownPending(pendingCommit);
      return encodePendingCommitEnvelope({
        commitHash: pending.commitHash,
        nextState: this.encodeState(pending.next),
      });
    });
  }

  decodePendingCommit(bytes: Uint8Array): PendingCommit {
    try {
      assertBytes(bytes, 'The serialized pending commit');
      const envelope = decodePendingCommitEnvelope(bytes);
      return new TsMlsPendingCommit(envelope.commitHash, this.decodeOwnState(envelope.nextState));
    } catch (error) {
      throw storedBytesError(error, 'Pending commit does not decode.');
    }
  }
}

/**
 * The messenger's MLS engine on `ts-mls`. Async only because the ciphersuite implementation is
 * assembled from WebCrypto on first use.
 */
export async function createTsMlsEngine(context: MlsEngineContext): Promise<MlsEngine> {
  const cs = await getCiphersuiteImpl(getCiphersuiteFromName(MLS_CIPHER_SUITE_NAME));
  return new TsMlsEngine(context, cs);
}
