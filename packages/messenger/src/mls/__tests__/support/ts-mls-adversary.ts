import {
  type CiphersuiteImpl,
  type ClientState,
  type Commit,
  type CreateCommitOptions,
  type KeyPackage,
  type KeyPackageEqualityConfig,
  type LeafNode,
  type PrivateMessage,
  type Proposal,
  type ProposalOrRef,
  type RatchetTree,
  type Sender,
  type SenderNonMember,
  createCommit,
  createGroupInfoWithExternalPubAndRatchetTree,
  createProposal,
  decodeMlsMessage,
  emptyPskIndex,
  encodeMlsMessage,
  getCiphersuiteFromName,
  getCiphersuiteImpl,
  joinGroupExternal,
} from 'ts-mls';
import { createContentCommitSignature } from 'ts-mls/framedContent.js';
import { signKeyPackage } from 'ts-mls/keyPackage.js';
import { protect, unprotectPrivateMessage } from 'ts-mls/messageProtection.js';
import {
  protectExternalProposalPublic,
  protectPublicMessage,
} from 'ts-mls/messageProtectionPublic.js';
import { encodeRatchetTree } from 'ts-mls/ratchetTree.js';
import {
  MAX_GROUP_LEAVES,
  MLS_CIPHER_SUITE_NAME,
  MLS_PROTOCOL_VERSION_NAME,
} from '../../constants.js';
import {
  decodeCredentialIdentity,
  encodeCredentialIdentity,
  identityOf,
} from '../../credential.js';
import { decodeKeyPackageSecrets } from '../../framing.js';
import type { GroupState, KeyPackageBundle, MemberDelta } from '../../mls-engine.js';
import { internalClientStateOf } from '../../ts-mls-engine.js';
import type {
  Adversary,
  ForgedAdd,
  ForgedRemove,
  KeyPackageForgery,
  LeafPatch,
  UnsupportedProposal,
  WelcomeTamper,
  WireForm,
} from './adversary.js';

/**
 * The adversary for the ts-mls engine: it reaches under the engine to the library's own state
 * (`internalClientStateOf`) and builds the messages an honest engine refuses to build.
 *
 * Two ways to forge, both with REAL keys so that nothing but the rule under test can refuse them:
 *  - ask the library for a perfectly valid commit from a doctored copy of the attacker's state
 *    (a leaf with another role, a proposal list the engine would have vetoed);
 *  - assemble the commit by hand (`seal`) when the library will not build the shape at all (a
 *    Remove without a path, a proposal by reference), signing and encrypting it with the group's keys.
 * The confirmation tag of a hand-built commit cannot be right (it belongs to an epoch that never
 * happens), which is fine: every attack here must be stopped BEFORE the library reaches it.
 */

const NO_DATA = new Uint8Array();
const WIRE_PRIVATE = 'mls_private_message';
const WIRE_PUBLIC = 'mls_public_message';
const EXTERNAL_INIT_KEM_BYTES = 32;
const REFERENCE_BYTES = 32;
const FLIP_MASK = 0x01;
const CUSTOM_PROPOSAL_TYPE = 0xf001;

/** The library refuses to Add a client that is already in the group; the attack needs it to look away. */
const NEVER_THE_SAME_CLIENT: KeyPackageEqualityConfig = {
  compareKeyPackages: () => false,
  compareKeyPackageToLeafNode: () => false,
};
const SIGNER_LEAF_NODE = 0; // the committer in the tests is always the first leaf
const SECOND_LEAF_NODE = 2;
const THIRD_LEAF_NODE = 4;

const byValue = (proposal: Proposal): ProposalOrRef => ({
  proposalOrRefType: 'proposal',
  proposal,
});

function leafNodeAt(c: ClientState, leafIndex: number): LeafNode {
  const node = c.ratchetTree[leafIndex * 2];
  if (node?.nodeType !== 'leaf') throw new Error(`leaf ${leafIndex} is not in the tree`);
  return node.leaf;
}

function ownLeafNode(c: ClientState): LeafNode {
  return leafNodeAt(c, c.privatePath.leafIndex);
}

function basicIdentity(leaf: LeafNode): Uint8Array {
  if (leaf.credential.credentialType !== 'basic')
    throw new Error('the leaf has no basic credential');
  return leaf.credential.identity;
}

/** `bytes` with one bit flipped: a signature that cannot verify any more. */
function flipped(bytes: Uint8Array): Uint8Array {
  const out = Uint8Array.from(bytes);
  out[0] = (out[0] ?? 0) ^ FLIP_MASK;
  return out;
}

/** The tree a Welcome carries, altered. Parent hashes and leaf positions are what a joiner must re-check (RFC 9420 §12.4.3.1). */
function tamperTree(tree: RatchetTree, kind: WelcomeTamper): RatchetTree {
  const out = tree.slice();
  if (kind === 'oversized-tree') {
    // A copy of a member's leaf at leaf index MAX_GROUP_LEAVES, blanks in between: a tree one leaf
    // too wide. Filled explicitly (no array holes), so the encoder writes every blank.
    const lastNode = 2 * MAX_GROUP_LEAVES;
    const wide: RatchetTree = [
      ...out,
      ...new Array<undefined>(lastNode + 1 - out.length).fill(undefined),
    ];
    wide[lastNode] = out[SECOND_LEAF_NODE];
    return wide;
  }
  if (kind === 'flip-parent-hash') {
    const at = out.findIndex(
      (node) => node?.nodeType === 'parent' && node.parent.parentHash.length > 0,
    );
    const node = out[at];
    if (node?.nodeType !== 'parent')
      throw new Error(
        'the tree has no parent hash to flip: build the group with self-updates first',
      );
    const parentHash = Uint8Array.from(node.parent.parentHash);
    parentHash[0] = (parentHash[0] ?? 0) ^ FLIP_MASK;
    out[at] = { nodeType: 'parent', parent: { ...node.parent, parentHash } };
    return out;
  }
  // 'swap-leaves' moves two members that did not sign the GroupInfo; 'swap-signer-leaf' moves the signer's own leaf.
  const [from, to] =
    kind === 'swap-leaves'
      ? [SECOND_LEAF_NODE, THIRD_LEAF_NODE]
      : [SIGNER_LEAF_NODE, SECOND_LEAF_NODE];
  const moved = out[from];
  out[from] = out[to];
  out[to] = moved;
  return out;
}

class TsMlsAdversary implements Adversary {
  constructor(private readonly cs: CiphersuiteImpl) {}

  // --- Building blocks ----------------------------------------------------------------------------

  /** Signs `commit` as `c`'s member and wraps it for the group: PrivateMessage under the epoch's keys, or a PublicMessage. */
  private async seal(
    c: ClientState,
    commit: Commit,
    wire: WireForm = 'private',
    signKey = c.signaturePrivateKey,
  ): Promise<Uint8Array> {
    const wireformat = wire === 'private' ? WIRE_PRIVATE : WIRE_PUBLIC;
    const sender: Sender = { senderType: 'member', leafIndex: c.privatePath.leafIndex };
    const { signature, framedContent } = await createContentCommitSignature(
      c.groupContext,
      wireformat,
      commit,
      sender,
      NO_DATA,
      signKey,
      this.cs.signature,
    );
    const auth = {
      contentType: 'commit' as const,
      signature,
      confirmationTag: this.cs.rng.randomBytes(this.cs.kdf.size),
    };
    if (wire === 'public') {
      const publicMessage = await protectPublicMessage(
        c.keySchedule.membershipKey,
        c.groupContext,
        { wireformat, content: framedContent, auth },
        this.cs,
      );
      return encodeMlsMessage({
        version: MLS_PROTOCOL_VERSION_NAME,
        wireformat: WIRE_PUBLIC,
        publicMessage,
      });
    }
    const { privateMessage } = await protect(
      c.keySchedule.senderDataSecret,
      NO_DATA,
      c.groupContext,
      c.secretTree,
      { contentType: 'commit', commit, auth },
      c.privatePath.leafIndex,
      c.clientConfig.paddingConfig,
      this.cs,
    );
    return encodeMlsMessage({
      version: MLS_PROTOCOL_VERSION_NAME,
      wireformat: WIRE_PRIVATE,
      privateMessage,
    });
  }

  /** A library commit from `c`, with the given proposals and no engine rules in the way. */
  private libraryCommit(c: ClientState, proposals: Proposal[], options: CreateCommitOptions = {}) {
    return createCommit(
      { state: c, cipherSuite: this.cs, pskIndex: emptyPskIndex },
      { extraProposals: proposals, ...options },
    );
  }

  /** Reads back the Commit the library put into a PrivateMessage it built from `c`. */
  private async bodyOf(c: ClientState, message: PrivateMessage): Promise<Commit> {
    const { content } = await unprotectPrivateMessage(
      c.keySchedule.senderDataSecret,
      message,
      c.secretTree,
      c.ratchetTree,
      c.groupContext,
      c.clientConfig.keyRetentionConfig,
      this.cs,
    );
    if (content.content.contentType !== 'commit')
      throw new Error('the library built something other than a commit');
    return content.content.commit;
  }

  /** `c` with its own leaf replaced; `signaturePrivateKey` replaces the signing key too (it must belong to the new leaf). */
  private withOwnLeaf(
    c: ClientState,
    leaf: LeafNode,
    signaturePrivateKey = c.signaturePrivateKey,
  ): ClientState {
    const tree = c.ratchetTree.slice();
    tree[c.privatePath.leafIndex * 2] = { nodeType: 'leaf', leaf };
    return { ...c, ratchetTree: tree, signaturePrivateKey };
  }

  private decodeKeyPackages(keyPackages: readonly Uint8Array[]): KeyPackage[] {
    return keyPackages.map((bytes) => {
      const decoded = decodeMlsMessage(bytes, 0);
      if (decoded === undefined || decoded[0].wireformat !== 'mls_key_package')
        throw new Error('not a KeyPackage');
      return decoded[0].keyPackage;
    });
  }

  private addProposals(keyPackages: readonly Uint8Array[]): Proposal[] {
    return this.decodeKeyPackages(keyPackages).map((keyPackage) => ({
      proposalType: 'add',
      add: { keyPackage },
    }));
  }

  private addedDelta(keyPackages: readonly Uint8Array[]): MemberDelta {
    return {
      added: this.decodeKeyPackages(keyPackages).map(({ leafNode }) => identityOf(leafNode)),
      removed: [],
    };
  }

  private welcomeBytes(
    welcome: NonNullable<Awaited<ReturnType<typeof createCommit>>['welcome']>,
  ): Uint8Array {
    return encodeMlsMessage({
      version: MLS_PROTOCOL_VERSION_NAME,
      wireformat: 'mls_welcome',
      welcome,
    });
  }

  // --- Commits that skip the UpdatePath --------------------------------------------------------------------

  removeWithoutPath(
    attacker: GroupState,
    leafIndex: number,
    wire: WireForm = 'private',
  ): Promise<Uint8Array> {
    const c = internalClientStateOf(attacker);
    const remove = byValue({ proposalType: 'remove', remove: { removed: leafIndex } });
    return this.seal(c, { proposals: [remove], path: undefined }, wire);
  }

  async groupContextExtensionsWithoutPath(attacker: GroupState): Promise<Uint8Array> {
    const c = internalClientStateOf(attacker);
    const created = await this.libraryCommit(c, [
      {
        proposalType: 'group_context_extensions',
        groupContextExtensions: { extensions: c.groupContext.extensions },
      },
    ]);
    return encodeMlsMessage(created.commit);
  }

  async groupContextExtensionsWithPath(
    attacker: GroupState,
    removeLeafIndex: number,
  ): Promise<Uint8Array> {
    const c = internalClientStateOf(attacker);
    const renamed = [
      { extensionType: 0xf0c1, extensionData: new TextEncoder().encode('another-conversation') },
    ];
    const created = await this.libraryCommit(c, [
      { proposalType: 'group_context_extensions', groupContextExtensions: { extensions: renamed } },
      { proposalType: 'remove', remove: { removed: removeLeafIndex } },
    ]);
    return encodeMlsMessage(created.commit);
  }

  // --- Leaf rewrites ---------------------------------------------------------------------------------------------

  async selfUpdateAs(attacker: GroupState, patch: LeafPatch): Promise<Uint8Array> {
    const c = internalClientStateOf(attacker);
    const leaf = ownLeafNode(c);
    const identity = decodeCredentialIdentity(basicIdentity(leaf));
    const rewritten = encodeCredentialIdentity({ ...identity, ...patch });
    const doctored = this.withOwnLeaf(c, {
      ...leaf,
      credential: { credentialType: 'basic', identity: rewritten },
    });
    // The library signs the new path leaf with the (unchanged) real key: the only thing wrong with it is the credential.
    const created = await this.libraryCommit(doctored, []);
    return encodeMlsMessage(created.commit);
  }

  async selfUpdateWithUnlistedKey(attacker: GroupState): Promise<Uint8Array> {
    const c = internalClientStateOf(attacker);
    const fresh = await this.cs.signature.keygen();
    const doctored = this.withOwnLeaf(
      c,
      { ...ownLeafNode(c), signaturePublicKey: fresh.publicKey },
      fresh.signKey,
    );
    const created = await this.libraryCommit(doctored, []);
    if (created.commit.wireformat !== WIRE_PRIVATE) throw new Error('expected a PrivateMessage');
    // The path leaf is signed by the unlisted key; the commit itself must still be signed by the
    // key the group knows, or it would be refused for the wrong reason.
    const body = await this.bodyOf(doctored, created.commit.privateMessage);
    return this.seal(c, body);
  }

  async selfUpdateWithBadPathSignature(attacker: GroupState): Promise<Uint8Array> {
    const c = internalClientStateOf(attacker);
    const created = await this.libraryCommit(c, []);
    if (created.commit.wireformat !== WIRE_PRIVATE) throw new Error('expected a PrivateMessage');
    const body = await this.bodyOf(c, created.commit.privateMessage);
    const { path } = body;
    if (path === undefined) throw new Error('a self-update carries an UpdatePath');
    const damaged: Commit = {
      ...body,
      path: {
        ...path,
        leafNode: { ...path.leafNode, signature: flipped(path.leafNode.signature) },
      },
    };
    // The commit itself is signed and sealed by the real member: only the path leaf is wrong.
    return this.seal(c, damaged);
  }

  async forgeKeyPackage(bundle: KeyPackageBundle, forgery: KeyPackageForgery): Promise<Uint8Array> {
    const secrets = decodeKeyPackageSecrets(bundle.keyPackagePrivate);
    const [keyPackage] = this.decodeKeyPackages([bundle.keyPackage]);
    if (keyPackage === undefined) throw new Error('no KeyPackage');
    const unsigned = {
      version: keyPackage.version,
      cipherSuite: keyPackage.cipherSuite,
      initKey: keyPackage.initKey,
      leafNode: keyPackage.leafNode,
      extensions: keyPackage.extensions,
    };
    const resign = (tbs: typeof unsigned) =>
      signKeyPackage(tbs, secrets.signaturePrivateKey, this.cs.signature);
    let forged: KeyPackage;
    if (forgery === 'key-package-signature') {
      forged = { ...keyPackage, signature: flipped(keyPackage.signature) };
    } else if (forgery === 'leaf-signature') {
      forged = await resign({
        ...unsigned,
        leafNode: { ...keyPackage.leafNode, signature: flipped(keyPackage.leafNode.signature) },
      });
    } else {
      forged = await resign({ ...unsigned, initKey: keyPackage.leafNode.hpkePublicKey });
    }
    return encodeMlsMessage({
      version: MLS_PROTOCOL_VERSION_NAME,
      wireformat: 'mls_key_package',
      keyPackage: forged,
    });
  }

  async publicSelfUpdate(attacker: GroupState): Promise<Uint8Array> {
    const c = internalClientStateOf(attacker);
    const created = await this.libraryCommit(c, [], { wireAsPublicMessage: true });
    return encodeMlsMessage(created.commit);
  }

  // --- Commits the engine would never build ------------------------------------------------------------------

  async forceRemove(attacker: GroupState, leafIndexes: readonly number[]): Promise<ForgedRemove> {
    const c = internalClientStateOf(attacker);
    const removed = leafIndexes.map((leafIndex) => identityOf(leafNodeAt(c, leafIndex)).deviceId);
    const created = await this.libraryCommit(
      c,
      leafIndexes.map((index) => ({ proposalType: 'remove', remove: { removed: index } })),
    );
    return { commit: encodeMlsMessage(created.commit), memberDelta: { added: [], removed } };
  }

  async forceAdd(attacker: GroupState, keyPackages: readonly Uint8Array[]): Promise<ForgedAdd> {
    const real = internalClientStateOf(attacker);
    const c: ClientState = {
      ...real,
      clientConfig: { ...real.clientConfig, keyPackageEqualityConfig: NEVER_THE_SAME_CLIENT },
    };
    const created = await this.libraryCommit(c, this.addProposals(keyPackages), {
      ratchetTreeExtension: true,
    });
    if (created.welcome === undefined) throw new Error('an Add produced no Welcome');
    return {
      commit: encodeMlsMessage(created.commit),
      welcome: this.welcomeBytes(created.welcome),
      memberDelta: this.addedDelta(keyPackages),
    };
  }

  async sealedAdd(attacker: GroupState, keyPackages: readonly Uint8Array[]): Promise<ForgedAdd> {
    const c = internalClientStateOf(attacker);
    const proposals = this.addProposals(keyPackages).map(byValue);
    return {
      commit: await this.seal(c, { proposals, path: undefined }),
      welcome: new Uint8Array(),
      memberDelta: this.addedDelta(keyPackages),
    };
  }

  async addWithTamperedWelcome(
    attacker: GroupState,
    keyPackages: readonly Uint8Array[],
    tamper: WelcomeTamper,
  ): Promise<ForgedAdd> {
    const c = internalClientStateOf(attacker);
    const adds = this.addProposals(keyPackages);
    // An Add-only commit carries no UpdatePath, so the tree it produces does not depend on any
    // randomness: building it twice gives the same tree, and the second time it can be replaced.
    const probe = await this.libraryCommit(c, adds, { ratchetTreeExtension: true });
    const tampered = tamperTree(probe.newState.ratchetTree, tamper);
    const forged = await this.libraryCommit(c, adds, {
      ratchetTreeExtension: false,
      groupInfoExtensions: [
        { extensionType: 'ratchet_tree', extensionData: encodeRatchetTree(tampered) },
      ],
    });
    if (forged.welcome === undefined) throw new Error('an Add produced no Welcome');
    return {
      commit: encodeMlsMessage(forged.commit),
      welcome: this.welcomeBytes(forged.welcome),
      memberDelta: this.addedDelta(keyPackages),
    };
  }

  async addWithExternalPubInWelcome(
    attacker: GroupState,
    keyPackages: readonly Uint8Array[],
  ): Promise<ForgedAdd> {
    const c = internalClientStateOf(attacker);
    const created = await this.libraryCommit(c, this.addProposals(keyPackages), {
      ratchetTreeExtension: true,
      groupInfoExtensions: [
        {
          extensionType: 'external_pub',
          extensionData: this.cs.rng.randomBytes(EXTERNAL_INIT_KEM_BYTES),
        },
      ],
    });
    if (created.welcome === undefined) throw new Error('an Add produced no Welcome');
    return {
      commit: encodeMlsMessage(created.commit),
      welcome: this.welcomeBytes(created.welcome),
      memberDelta: this.addedDelta(keyPackages),
    };
  }

  // --- External paths ---------------------------------------------------------------------------------------------

  externalInitInMemberCommit(attacker: GroupState): Promise<Uint8Array> {
    const c = internalClientStateOf(attacker);
    const externalInit = byValue({
      proposalType: 'external_init',
      externalInit: { kemOutput: this.cs.rng.randomBytes(EXTERNAL_INIT_KEM_BYTES) },
    });
    return this.seal(c, { proposals: [externalInit], path: undefined });
  }

  async externalCommit(member: GroupState, joiner: KeyPackageBundle): Promise<Uint8Array> {
    const c = internalClientStateOf(member);
    const groupInfo = await createGroupInfoWithExternalPubAndRatchetTree(c, [], this.cs);
    const secrets = decodeKeyPackageSecrets(joiner.keyPackagePrivate);
    const [keyPackage] = this.decodeKeyPackages([secrets.keyPackage]);
    if (keyPackage === undefined) throw new Error('no KeyPackage');
    const { publicMessage } = await joinGroupExternal(
      groupInfo,
      keyPackage,
      {
        initPrivateKey: secrets.initPrivateKey,
        hpkePrivateKey: secrets.hpkePrivateKey,
        signaturePrivateKey: secrets.signaturePrivateKey,
      },
      false,
      this.cs,
      undefined,
      c.clientConfig,
    );
    return encodeMlsMessage({
      version: MLS_PROTOCOL_VERSION_NAME,
      wireformat: WIRE_PUBLIC,
      publicMessage,
    });
  }

  async externalProposal(
    member: GroupState,
    sender: 'external' | 'new_member_proposal',
  ): Promise<Uint8Array> {
    const c = internalClientStateOf(member);
    const from: SenderNonMember =
      sender === 'external'
        ? { senderType: 'external', senderIndex: 0 }
        : { senderType: 'new_member_proposal' };
    const { publicMessage } = await protectExternalProposalPublic(
      c.signaturePrivateKey,
      c.groupContext,
      NO_DATA,
      { proposalType: 'remove', remove: { removed: 0 } },
      from,
      this.cs,
    );
    return encodeMlsMessage({
      version: MLS_PROTOCOL_VERSION_NAME,
      wireformat: WIRE_PUBLIC,
      publicMessage,
    });
  }

  // --- Proposal shapes ----------------------------------------------------------------------------------------------

  commitWithReference(attacker: GroupState): Promise<Uint8Array> {
    const c = internalClientStateOf(attacker);
    const reference: ProposalOrRef = {
      proposalOrRefType: 'reference',
      reference: this.cs.rng.randomBytes(REFERENCE_BYTES),
    };
    return this.seal(c, { proposals: [reference], path: undefined });
  }

  unsupportedProposal(attacker: GroupState, kind: UnsupportedProposal): Promise<Uint8Array> {
    const c = internalClientStateOf(attacker);
    const proposals: Record<UnsupportedProposal, Proposal> = {
      psk: {
        proposalType: 'psk',
        psk: {
          preSharedKeyId: {
            psktype: 'external',
            pskId: new Uint8Array([1, 2, 3]),
            pskNonce: this.cs.rng.randomBytes(this.cs.kdf.size),
          },
        },
      },
      reinit: {
        proposalType: 'reinit',
        reinit: {
          groupId: this.cs.rng.randomBytes(REFERENCE_BYTES),
          version: MLS_PROTOCOL_VERSION_NAME,
          cipherSuite: MLS_CIPHER_SUITE_NAME,
          extensions: [],
        },
      },
      custom: { proposalType: CUSTOM_PROPOSAL_TYPE, proposalData: new Uint8Array([1, 2, 3]) },
    };
    return this.seal(c, { proposals: [byValue(proposals[kind])], path: undefined });
  }

  async standaloneProposal(
    attacker: GroupState,
    leafIndex: number,
    wire: WireForm,
  ): Promise<Uint8Array> {
    const c = internalClientStateOf(attacker);
    const { message } = await createProposal(
      c,
      wire === 'public',
      { proposalType: 'remove', remove: { removed: leafIndex } },
      this.cs,
    );
    return encodeMlsMessage(message);
  }
}

/** The adversary for `createTsMlsEngine`: attacks the pinned suite with the library's own primitives. */
export async function createTsMlsAdversary(): Promise<Adversary> {
  return new TsMlsAdversary(
    await getCiphersuiteImpl(getCiphersuiteFromName(MLS_CIPHER_SUITE_NAME)),
  );
}
