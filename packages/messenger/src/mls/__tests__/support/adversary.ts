import type { DeviceRole, GroupState, KeyPackageBundle, MemberDelta } from '../../mls-engine.js';

/**
 * The attacker's toolbox, as the contract suite sees it. Each method returns bytes that an honest
 * `MlsEngine` can never produce (it validates its own output) but that a malicious MEMBER, a
 * malicious relay or a buggy peer library can: well-formed MLS messages, signed and encrypted with
 * real group keys, that break one rule of `validator.ts`.
 *
 * The contract suite takes an `Adversary` next to the engine factory: a second implementation
 * (`mls-rs` -> WASM) brings its own, built on that library, and the same attack tests run on both.
 */

export type WelcomeTamper =
  | 'flip-parent-hash'
  | 'swap-leaves'
  | 'swap-signer-leaf'
  /** One leaf more than `MAX_GROUP_LEAVES`: the tree a joiner must count before it verifies anything. */
  | 'oversized-tree';

export interface ForgedAdd {
  readonly commit: Uint8Array;
  readonly welcome: Uint8Array;
  readonly memberDelta: MemberDelta;
}

export interface ForgedRemove {
  readonly commit: Uint8Array;
  readonly memberDelta: MemberDelta;
}

/** What a leaf update may try to rewrite. */
export interface LeafPatch {
  readonly role?: DeviceRole;
  readonly deviceId?: string;
  readonly userId?: string;
}

export type WireForm = 'private' | 'public';

/** What is wrong with a KeyPackage the attacker offers for an Add. Everything else about it is valid. */
export type KeyPackageForgery =
  /** The KeyPackage signature does not verify. */
  | 'key-package-signature'
  /** The leaf's own signature does not verify (the KeyPackage is re-signed, so only the leaf is wrong). */
  | 'leaf-signature'
  /** The init key equals the leaf's encryption key (the KeyPackage is re-signed). */
  | 'init-key-is-leaf-key';

/** Proposal types phase 1 does not use at all. */
export type UnsupportedProposal = 'psk' | 'reinit' | 'custom';

export interface Adversary {
  /** GHSA-gwp3-968w-m7gv: a Remove-only commit with no UpdatePath, signed by `attacker`. */
  removeWithoutPath(attacker: GroupState, leafIndex: number, wire?: WireForm): Promise<Uint8Array>;

  /** Probe F8b: a GroupContextExtensions-only commit with no UpdatePath (the library builds and accepts it). */
  groupContextExtensionsWithoutPath(attacker: GroupState): Promise<Uint8Array>;

  /** A GroupContextExtensions proposal (a different conversation id) next to a Remove, so the commit does carry a path. */
  groupContextExtensionsWithPath(
    attacker: GroupState,
    removeLeafIndex: number,
  ): Promise<Uint8Array>;

  /** A valid self-update whose UpdatePath leaf carries another role / device id / user id than the leaf it replaces. */
  selfUpdateAs(attacker: GroupState, patch: LeafPatch): Promise<Uint8Array>;

  /** A valid self-update whose new leaf is signed by a key that is on no signed device list. */
  selfUpdateWithUnlistedKey(attacker: GroupState): Promise<Uint8Array>;

  /** A valid self-update whose UpdatePath leaf carries a signature that does not verify. */
  selfUpdateWithBadPathSignature(attacker: GroupState): Promise<Uint8Array>;

  /** A valid self-update by the attacker, sent as a PublicMessage (RFC 9420 allows it; we refuse it). */
  publicSelfUpdate(attacker: GroupState): Promise<Uint8Array>;

  /** `bundle`'s KeyPackage, damaged in one way; hand it to `forceAdd` (or `add`) as the KeyPackage to add. */
  forgeKeyPackage(bundle: KeyPackageBundle, forgery: KeyPackageForgery): Promise<Uint8Array>;

  /** A Remove that the library builds happily, bypassing every sender-side rule of the engine. */
  forceRemove(attacker: GroupState, leafIndexes: readonly number[]): Promise<ForgedRemove>;

  /** An Add that the library builds happily, bypassing every sender-side rule of the engine. */
  forceAdd(attacker: GroupState, keyPackages: readonly Uint8Array[]): Promise<ForgedAdd>;

  /**
   * An Add-only commit assembled by hand, for KeyPackages the library itself would refuse to
   * propose (a bad signature, equal keys). Its confirmation tag is unusable and its Welcome empty:
   * it must be refused by the receive-side validator before the library ever sees it.
   */
  sealedAdd(attacker: GroupState, keyPackages: readonly Uint8Array[]): Promise<ForgedAdd>;

  /** An Add whose Welcome carries a ratchet tree altered after the GroupInfo was built, but correctly signed and encrypted. */
  addWithTamperedWelcome(
    attacker: GroupState,
    keyPackages: readonly Uint8Array[],
    tamper: WelcomeTamper,
  ): Promise<ForgedAdd>;

  /** An Add whose signed GroupInfo carries an `external_pub` extension: the door to an external join. */
  addWithExternalPubInWelcome(
    attacker: GroupState,
    keyPackages: readonly Uint8Array[],
  ): Promise<ForgedAdd>;

  /** An ExternalInit proposal inside an ordinary member commit. */
  externalInitInMemberCommit(attacker: GroupState): Promise<Uint8Array>;

  /** A real external commit: a `new_member_commit` PublicMessage with ExternalInit, as a joiner with a GroupInfo builds it. */
  externalCommit(member: GroupState, joiner: KeyPackageBundle): Promise<Uint8Array>;

  /** A signed PublicMessage proposal from an `external` sender or a `new_member_proposal` sender. */
  externalProposal(
    member: GroupState,
    sender: 'external' | 'new_member_proposal',
  ): Promise<Uint8Array>;

  /** A commit that names a proposal by reference instead of carrying it. */
  commitWithReference(attacker: GroupState): Promise<Uint8Array>;

  /** A commit carrying a PSK, ReInit or custom proposal, which phase 1 never sends. */
  unsupportedProposal(attacker: GroupState, kind: UnsupportedProposal): Promise<Uint8Array>;

  /** A proposal sent on its own, outside a commit. */
  standaloneProposal(attacker: GroupState, leafIndex: number, wire: WireForm): Promise<Uint8Array>;
}
