import { expect } from 'vitest';
import {
  DeviceRole,
  type DeviceIdentity,
  type GroupState,
  type MemberDelta,
  type MlsEngine,
} from '../../mls-engine.js';
import { createTsMlsEngine } from '../../ts-mls-engine.js';
import { TestWorld, type TestDevice } from '../support/world.js';
import {
  type CommitResult,
  fromBase64,
  type GroupSummary,
  OpenMlsPeer,
  type PeerArgs,
  type ProcessedApplication,
  type ProcessedCommit,
  toBase64,
} from './peer.js';

/**
 * The two sides of the interop test, side by side.
 *
 *  - OUR side is `MlsEngine` and nothing else (`createTsMlsEngine`, the public export), run against
 *    the same `TestWorld` host (signed device lists, guardian policy) the contract suite uses.
 *  - THE OTHER side is OpenMLS, in a container (`peer.ts`).
 *
 * The wire facts the canon pins (group-context extension type, the credential layout, the AAD frame)
 * are SPELLED OUT HERE, independently of `constants.ts` / `framing.ts`: if the engine and the canon
 * drifted apart, this file would not drift with it.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** RFC 9420 §17.3 private-use extension that carries the conversation id (canon §9.6). */
export const CONVERSATION_EXTENSION_TYPE = 0xf0c1;

const ROLE_CODES: Readonly<Record<DeviceRole, number>> = {
  [DeviceRole.USER]: 1,
  [DeviceRole.GUARDIAN]: 2,
  [DeviceRole.ASSISTANT]: 3,
};

/** `u8 1 | u8 role | u8 len | userId | u8 len | deviceId`: the basic-credential identity of a leaf. */
export function credentialBytes(identity: DeviceIdentity): Uint8Array {
  const user = encoder.encode(identity.userId);
  const device = encoder.encode(identity.deviceId);
  return Uint8Array.of(
    1,
    ROLE_CODES[identity.role],
    user.length,
    ...user,
    device.length,
    ...device,
  );
}

/** `u8 len(conversationId) | conversationId | extra`: the authenticated data of an application message. */
export function aadFrame(conversationId: string, extra: Uint8Array = new Uint8Array()): Uint8Array {
  const id = encoder.encode(conversationId);
  return Uint8Array.of(id.length, ...id, ...extra);
}

export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

export function text(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/** The group-context extension a conversation carries, in the peer's wire form. */
export function conversationExtension(conversationId: string): {
  type: number;
  data: string;
} {
  return { type: CONVERSATION_EXTENSION_TYPE, data: toBase64(utf8(conversationId)) };
}

// --- Devices -----------------------------------------------------------------------------------

/** A device whose MLS is OpenMLS. Its identity and key are on the signed list like any other. */
export interface OpenMlsDevice {
  readonly client: string;
  readonly identity: DeviceIdentity;
  readonly signatureKey: Uint8Array;
}

export interface OpenMlsDeviceOptions {
  /** Default true: the device is on its owner's signed list. */
  readonly listed?: boolean;
  /** Put this key on the list instead of the device's real one. */
  readonly listedKey?: Uint8Array;
  /** Use these credential bytes instead of the canonical layout. */
  readonly credential?: Uint8Array;
  /** MLS cipher suite id; default 1. */
  readonly ciphersuite?: number;
  /** List the device under this role instead of its real one. */
  readonly listedRole?: DeviceRole;
  /** List the device for this conversation (an ASSISTANT device is issued for exactly one). */
  readonly listedConversationId?: string;
}

export interface KeyPackageOptions {
  readonly capabilityExtensions?: readonly number[];
  readonly capabilityCiphersuites?: readonly number[];
  readonly grease?: boolean;
  readonly leafExtensions?: readonly { readonly type: number; readonly data: Uint8Array }[];
  readonly lifetimeSeconds?: number;
}

export function keyPackageArgs(device: OpenMlsDevice, options: KeyPackageOptions): PeerArgs {
  return {
    client: device.client,
    capability_extensions: options.capabilityExtensions,
    capability_ciphersuites: options.capabilityCiphersuites,
    grease: options.grease,
    leaf_extensions: options.leafExtensions?.map((ext) => ({
      type: ext.type,
      data: toBase64(ext.data),
    })),
    lifetime_seconds: options.lifetimeSeconds,
  };
}

/** One test host: our engine, its signed device lists and one OpenMLS container. */
export class Rig {
  private constructor(
    readonly peer: OpenMlsPeer,
    readonly world: TestWorld,
  ) {}

  get engine(): MlsEngine {
    return this.world.engine;
  }

  static async open(image: string): Promise<Rig> {
    const world = await TestWorld.create(createTsMlsEngine);
    const peer = await OpenMlsPeer.start(image);
    return new Rig(peer, world);
  }

  close(): Promise<void> {
    return this.peer.close();
  }

  /** Our device, on its owner's signed list. */
  ours(userId: string, deviceId: string, role: DeviceRole = DeviceRole.USER): Promise<TestDevice> {
    return this.world.device(userId, deviceId, role);
  }

  /** An OpenMLS device: a fresh signing key inside the container, listed unless told otherwise. */
  async openmls(
    identity: DeviceIdentity,
    options: OpenMlsDeviceOptions = {},
  ): Promise<OpenMlsDevice> {
    const client = `${identity.userId}-${identity.deviceId}`;
    const made = await this.peer.call<{ signaturePublicKey: string }>('new_client', {
      client,
      identity: toBase64(options.credential ?? credentialBytes(identity)),
      ciphersuite: options.ciphersuite,
    });
    const signatureKey = fromBase64(made.signaturePublicKey);
    if (options.listed !== false) {
      this.world.list(identity.userId, {
        deviceId: identity.deviceId,
        role: options.listedRole ?? identity.role,
        signatureKey: options.listedKey ?? signatureKey,
        ...(options.listedConversationId === undefined
          ? {}
          : { conversationId: options.listedConversationId }),
      });
    }
    return { client, identity, signatureKey };
  }

  async keyPackage(device: OpenMlsDevice, options: KeyPackageOptions = {}): Promise<Uint8Array> {
    const made = await this.peer.call<{ keyPackage: string }>(
      'key_package',
      keyPackageArgs(device, options),
    );
    return fromBase64(made.keyPackage);
  }
}

// --- A room with both kinds of member ------------------------------------------------------------

export type Party =
  | { readonly kind: 'ours'; readonly device: TestDevice }
  | { readonly kind: 'openmls'; readonly device: OpenMlsDevice };

export function ours(device: TestDevice): Party {
  return { kind: 'ours', device };
}

export function isOurs(party: Party): party is Extract<Party, { kind: 'ours' }> {
  return party.kind === 'ours';
}

export function theirs(device: OpenMlsDevice): Party {
  return { kind: 'openmls', device };
}

export function idOf(party: Party): string {
  return party.kind === 'ours' ? party.device.deviceId : party.device.identity.deviceId;
}

function identityOf(party: Party): DeviceIdentity {
  return party.kind === 'ours'
    ? { userId: party.device.userId, deviceId: party.device.deviceId, role: party.device.role }
    : party.device.identity;
}

interface OursMember {
  readonly kind: 'ours';
  readonly device: TestDevice;
  state: GroupState;
  active: boolean;
}

interface TheirsMember {
  readonly kind: 'openmls';
  readonly device: OpenMlsDevice;
  active: boolean;
}

type Member = OursMember | TheirsMember;

/** What a member reported after being handed one commit. */
export interface Received {
  readonly kind: 'ours' | 'openmls';
  /** The commit removed this member. */
  readonly removed: boolean;
  /** OpenMLS only: did the commit carry an UpdatePath? */
  readonly hasUpdatePath?: boolean;
  readonly adds?: number;
  readonly removes?: number;
  readonly proposals?: number;
  /** Ours only: the new epoch_authenticator (null once removed). */
  readonly epochAuthenticator?: Uint8Array | null;
}

export interface CommitReport {
  readonly commit: Uint8Array;
  readonly delta: MemberDelta;
  readonly received: ReadonlyMap<string, Received>;
  /** UpdatePath of the commit as an OpenMLS receiver saw it; undefined when no OpenMLS member received it. */
  readonly hasUpdatePath: boolean | undefined;
}

export interface JoinSetup {
  readonly welcome: Uint8Array;
  readonly epoch: bigint;
}

const EXPORTER_LABEL = 'masia-interop-exporter';
const EXPORTER_CONTEXT = Uint8Array.of(7, 7, 7);
const EXPORTER_LENGTH = 32;

export function deltaOf(added: readonly Party[], removed: readonly string[]): MemberDelta {
  return {
    added: added.map((party) => {
      const identity = identityOf(party);
      return { deviceId: identity.deviceId, userId: identity.userId, role: identity.role };
    }),
    removed,
  };
}

export class MixedRoom {
  private readonly members = new Map<string, Member>();

  private constructor(
    readonly rig: Rig,
    readonly conversationId: string,
    readonly groupId: Uint8Array,
  ) {}

  private get engine(): MlsEngine {
    return this.rig.engine;
  }

  private get peer(): OpenMlsPeer {
    return this.rig.peer;
  }

  /** The key the peer files this group under. */
  get key(): string {
    return toBase64(this.groupId);
  }

  static async createOurs(
    rig: Rig,
    creator: TestDevice,
    conversationId: string,
  ): Promise<MixedRoom> {
    const { state, groupId } = await rig.engine.createGroup({
      conversationId,
      selfLeaf: creator.keys,
    });
    const room = new MixedRoom(rig, conversationId, groupId);
    room.members.set(creator.deviceId, { kind: 'ours', device: creator, state, active: true });
    return room;
  }

  static async createOpenMls(
    rig: Rig,
    creator: OpenMlsDevice,
    conversationId: string,
    options: {
      readonly wireFormat?: string;
      readonly ratchetTreeExtension?: boolean;
      readonly padding?: number;
      readonly gcExtensions?: readonly { type: number; data: string }[];
      readonly capabilityExtensions?: readonly number[];
      readonly grease?: boolean;
    } = {},
  ): Promise<MixedRoom> {
    const groupId = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff);
    await rig.peer.call('create_group', {
      client: creator.client,
      group_id: toBase64(groupId),
      gc_extensions: options.gcExtensions ?? [conversationExtension(conversationId)],
      wire_format: options.wireFormat,
      ratchet_tree_extension: options.ratchetTreeExtension,
      padding: options.padding,
      capability_extensions: options.capabilityExtensions,
      grease: options.grease,
    });
    const room = new MixedRoom(rig, conversationId, groupId);
    room.members.set(creator.identity.deviceId, { kind: 'openmls', device: creator, active: true });
    return room;
  }

  // --- Reading the room ----------------------------------------------------------------------------

  private member(id: string): Member {
    const found = this.members.get(id);
    if (found === undefined) throw new Error(`${id} is not in this room`);
    return found;
  }

  private oursMember(id: string): OursMember {
    const found = this.member(id);
    if (found.kind !== 'ours') throw new Error(`${id} is not one of ours`);
    return found;
  }

  /** The state of one of our devices (for assertions through `MlsEngine`). */
  stateOf(id: string): GroupState {
    return this.oursMember(id).state;
  }

  isActive(id: string): boolean {
    return this.member(id).active;
  }

  activeIds(): string[] {
    return [...this.members.values()].filter((m) => m.active).map((m) => idOf(m));
  }

  async summaryOf(id: string): Promise<GroupSummary> {
    const member = this.member(id);
    if (member.kind !== 'openmls') throw new Error(`${id} is not an OpenMLS device`);
    return this.peer.call<GroupSummary>('state', { client: member.device.client, group: this.key });
  }

  /** The leaf index of `targetId`, read from the first active member's tree. */
  async leafIndexOf(targetId: string): Promise<number> {
    const target = this.member(targetId);
    const viewer = [...this.members.values()].find((m) => m.active);
    if (viewer === undefined) throw new Error('no active member');
    if (viewer.kind === 'ours') {
      const found = this.engine.members(viewer.state).find((m) => m.deviceId === idOf(target));
      if (found === undefined) throw new Error(`${targetId} is not in the tree`);
      return found.leafIndex;
    }
    const summary = await this.summaryOf(idOf(viewer));
    const wanted = toBase64(credentialBytes(identityOf(target)));
    const found = summary.members.find((m) => m.identity === wanted);
    if (found === undefined) throw new Error(`${targetId} is not in the tree`);
    return found.leafIndex;
  }

  // --- Handshake delivery ----------------------------------------------------------------------------

  private async receive(member: Member, commit: Uint8Array, delta: MemberDelta): Promise<Received> {
    if (member.kind === 'ours') {
      const result = await this.engine.processCommit({
        state: member.state,
        commit,
        servedMemberDelta: delta,
      });
      member.state = result.state;
      if (result.removedFromGroup) member.active = false;
      return {
        kind: 'ours',
        removed: result.removedFromGroup,
        epochAuthenticator: result.epochAuthenticator,
      };
    }
    const processed = await this.peer.call<ProcessedCommit>('process', {
      client: member.device.client,
      group: this.key,
      message: toBase64(commit),
    });
    expect(processed.kind).toBe('commit');
    if (processed.selfRemoved) member.active = false;
    return {
      kind: 'openmls',
      removed: processed.selfRemoved,
      hasUpdatePath: processed.hasUpdatePath,
      adds: processed.adds,
      removes: processed.removes,
      proposals: processed.proposals,
    };
  }

  /** Hands `commit` to every active member except `fromId` and `skip`, as a relay would. */
  async deliver(
    commit: Uint8Array,
    delta: MemberDelta,
    fromId: string,
    skip: readonly string[] = [],
  ): Promise<CommitReport> {
    const received = new Map<string, Received>();
    for (const member of [...this.members.values()]) {
      const id = idOf(member);
      if (!member.active || id === fromId || skip.includes(id)) continue;
      received.set(id, await this.receive(member, commit, delta));
    }
    const hasUpdatePath = [...received.values()].find(
      (r) => r.hasUpdatePath !== undefined,
    )?.hasUpdatePath;
    return { commit, delta, received, hasUpdatePath };
  }

  private async keyPackageOf(party: Party): Promise<{ bytes: Uint8Array; secret?: Uint8Array }> {
    if (party.kind === 'ours') {
      const bundle = await this.engine.createKeyPackage(party.device.keys);
      return { bytes: bundle.keyPackage, secret: bundle.keyPackagePrivate };
    }
    return { bytes: await this.rig.keyPackage(party.device) };
  }

  /** Joins one newcomer from a Welcome, the way the host would (group id and epoch are expected). */
  private async join(
    newcomer: Party,
    welcome: Uint8Array,
    secret: Uint8Array | undefined,
    epoch: bigint,
    expectedAuthenticator: Uint8Array | undefined,
  ): Promise<void> {
    if (newcomer.kind === 'ours') {
      if (secret === undefined) throw new Error('no key package secret');
      const joined = await this.engine.joinFromWelcome({
        welcome,
        keyPackagePrivate: secret,
        expectedConversationId: this.conversationId,
        expectedGroupId: this.groupId,
        expectedEpoch: epoch,
      });
      if (expectedAuthenticator !== undefined) {
        expect(joined.epochAuthenticator).toEqual(expectedAuthenticator);
      }
      this.members.set(newcomer.device.deviceId, {
        kind: 'ours',
        device: newcomer.device,
        state: joined.state,
        active: true,
      });
      return;
    }
    // A device that was removed and is added again has to drop the state of its old membership.
    if (this.members.has(newcomer.device.identity.deviceId)) {
      await this.peer.call('forget', { client: newcomer.device.client, group: this.key });
    }
    const summary = await this.peer.call<GroupSummary>('join', {
      client: newcomer.device.client,
      welcome: toBase64(welcome),
    });
    expect(BigInt(summary.epoch)).toBe(epoch);
    expect(summary.groupId).toBe(this.key);
    if (expectedAuthenticator !== undefined) {
      expect(summary.epochAuthenticator).toBe(toBase64(expectedAuthenticator));
    }
    this.members.set(newcomer.device.identity.deviceId, {
      kind: 'openmls',
      device: newcomer.device,
      active: true,
    });
  }

  /** The epoch_authenticator of one active member, as bytes. */
  async authenticatorOf(id: string): Promise<Uint8Array> {
    const member = this.member(id);
    if (member.kind === 'ours') return this.engine.epochAuthenticator(member.state);
    return fromBase64((await this.summaryOf(id)).epochAuthenticator);
  }

  /**
   * An Add by `committerId`. Every other member gets the commit, every newcomer joins from the
   * Welcome and (unless `selfUpdate: false`) posts its self-update, as the protocol requires.
   */
  async add(
    committerId: string,
    newcomers: readonly Party[],
    options: { forcePath?: boolean; selfUpdate?: boolean } = {},
  ): Promise<CommitReport & { welcome: Uint8Array }> {
    const committer = this.member(committerId);
    const packages = await Promise.all(newcomers.map((n) => this.keyPackageOf(n)));
    const delta = deltaOf(newcomers, []);
    let commit: Uint8Array;
    let welcome: Uint8Array;
    let epoch: bigint;
    if (committer.kind === 'ours') {
      const result = await this.engine.add({
        state: committer.state,
        keyPackages: packages.map((p) => p.bytes),
      });
      expect(result.memberDelta).toEqual(delta);
      committer.state = result.state;
      commit = result.commit;
      welcome = result.welcome;
      epoch = this.engine.epoch(result.state);
    } else {
      const result = await this.peer.call<CommitResult>('add', {
        client: committer.device.client,
        group: this.key,
        key_packages: packages.map((p) => toBase64(p.bytes)),
        force_path: options.forcePath,
      });
      if (result.welcome === null) throw new Error('OpenMLS made no Welcome');
      commit = fromBase64(result.commit);
      welcome = fromBase64(result.welcome);
      epoch = BigInt(result.epoch);
    }
    const report = await this.deliver(commit, delta, committerId);
    const authenticator = await this.authenticatorOf(committerId);
    for (const [i, newcomer] of newcomers.entries()) {
      await this.join(newcomer, welcome, packages[i]?.secret, epoch, authenticator);
    }
    if (options.selfUpdate !== false) {
      for (const newcomer of newcomers) await this.selfUpdate(idOf(newcomer));
    }
    return { ...report, welcome };
  }

  async remove(committerId: string, targetIds: readonly string[]): Promise<CommitReport> {
    const committer = this.member(committerId);
    const leafIndexes = await Promise.all(targetIds.map((id) => this.leafIndexOf(id)));
    const delta: MemberDelta = { added: [], removed: targetIds };
    let commit: Uint8Array;
    if (committer.kind === 'ours') {
      const result = await this.engine.remove({ state: committer.state, leafIndexes });
      expect(result.memberDelta).toEqual(delta);
      committer.state = result.state;
      commit = result.commit;
    } else {
      const result = await this.peer.call<CommitResult>('remove', {
        client: committer.device.client,
        group: this.key,
        leaf_indexes: leafIndexes,
      });
      commit = fromBase64(result.commit);
    }
    return this.deliver(commit, delta, committerId);
  }

  async selfUpdate(id: string): Promise<CommitReport> {
    const member = this.member(id);
    let commit: Uint8Array;
    if (member.kind === 'ours') {
      const result = await this.engine.selfUpdate(member.state);
      member.state = result.state;
      commit = result.commit;
    } else {
      const result = await this.peer.call<CommitResult>('self_update', {
        client: member.device.client,
        group: this.key,
      });
      commit = fromBase64(result.commit);
    }
    return this.deliver(commit, { added: [], removed: [] }, id);
  }

  // --- Application messages ---------------------------------------------------------------------------

  /** Seals `plaintext` at `fromId` with `extra` as the caller's part of the AAD. */
  async seal(fromId: string, plaintext: Uint8Array, extra: Uint8Array): Promise<Uint8Array> {
    const member = this.member(fromId);
    if (member.kind === 'ours') {
      const sealed = await this.engine.encrypt(member.state, plaintext, extra);
      member.state = sealed.state;
      return sealed.ciphertext;
    }
    const sealed = await this.peer.call<{ ciphertext: string }>('encrypt', {
      client: member.device.client,
      group: this.key,
      plaintext: toBase64(plaintext),
      aad: toBase64(aadFrame(this.conversationId, extra)),
    });
    return fromBase64(sealed.ciphertext);
  }

  /** Opens `ciphertext` at `toId`; returns the plaintext and the AAD as that side saw it. */
  async open(
    toId: string,
    ciphertext: Uint8Array,
    extra: Uint8Array,
  ): Promise<{ plaintext: Uint8Array; aad: Uint8Array; senderDeviceId?: string }> {
    const member = this.member(toId);
    if (member.kind === 'ours') {
      const opened = await this.engine.decrypt(member.state, ciphertext, extra);
      member.state = opened.state;
      return {
        plaintext: opened.plaintext,
        aad: opened.aad,
        senderDeviceId: opened.sender.deviceId,
      };
    }
    const opened = await this.peer.call<ProcessedApplication>('process', {
      client: member.device.client,
      group: this.key,
      message: toBase64(ciphertext),
    });
    expect(opened.kind).toBe('application');
    return { plaintext: fromBase64(opened.plaintext), aad: fromBase64(opened.aad) };
  }

  /** `fromId` sends; every other active member must read exactly that, bound to this conversation. */
  async send(fromId: string, message: string, extra: Uint8Array = new Uint8Array()): Promise<void> {
    const ciphertext = await this.seal(fromId, utf8(message), extra);
    for (const id of this.activeIds()) {
      if (id === fromId) continue;
      const opened = await this.open(id, ciphertext, extra);
      expect(text(opened.plaintext), `${fromId} -> ${id}`).toBe(message);
      if (this.member(id).kind === 'openmls') {
        // OpenMLS hands back the WHOLE authenticated data: our frame, byte for byte.
        expect(opened.aad, `AAD ${fromId} -> ${id}`).toEqual(aadFrame(this.conversationId, extra));
      } else {
        expect(opened.aad, `AAD ${fromId} -> ${id}`).toEqual(extra);
        expect(opened.senderDeviceId).toBe(fromId);
      }
    }
  }

  /** Every active member: same epoch, same tree, same epoch_authenticator, same exporter secret. */
  async expectConverged(): Promise<void> {
    const ids = this.activeIds();
    const expectedMembers = ids
      .map((id) => {
        const party = this.member(id);
        return `${toBase64(credentialBytes(identityOf(party)))}`;
      })
      .sort();
    let reference: { epoch: bigint; authenticator: string; exporter: string } | undefined;
    for (const id of ids) {
      const member = this.member(id);
      let seen: { epoch: bigint; authenticator: string; exporter: string; tree: string[] };
      if (member.kind === 'ours') {
        const members = this.engine.members(member.state);
        seen = {
          epoch: this.engine.epoch(member.state),
          authenticator: toBase64(this.engine.epochAuthenticator(member.state)),
          exporter: toBase64(
            await this.engine.exporter(
              member.state,
              EXPORTER_LABEL,
              EXPORTER_LENGTH,
              EXPORTER_CONTEXT,
            ),
          ),
          tree: members
            .map((m) =>
              toBase64(credentialBytes({ userId: m.userId, deviceId: m.deviceId, role: m.role })),
            )
            .sort(),
        };
        expect(this.engine.conversationId(member.state)).toBe(this.conversationId);
        expect(this.engine.groupId(member.state)).toEqual(this.groupId);
      } else {
        const summary = await this.summaryOf(id);
        const exported = await this.peer.call<{ secret: string }>('export_secret', {
          client: member.device.client,
          group: this.key,
          label: EXPORTER_LABEL,
          context: toBase64(EXPORTER_CONTEXT),
          length: EXPORTER_LENGTH,
        });
        seen = {
          epoch: BigInt(summary.epoch),
          authenticator: summary.epochAuthenticator,
          exporter: exported.secret,
          tree: summary.members.map((m) => m.identity).sort(),
        };
        expect(summary.groupContextExtensions.map((e) => e.type)).toEqual([
          CONVERSATION_EXTENSION_TYPE,
        ]);
        expect(summary.groupId).toBe(this.key);
      }
      expect(seen.tree, `tree at ${id}`).toEqual(expectedMembers);
      if (reference === undefined) reference = seen;
      else {
        expect(seen.epoch, `epoch at ${id}`).toBe(reference.epoch);
        expect(seen.authenticator, `epoch_authenticator at ${id}`).toBe(reference.authenticator);
        expect(seen.exporter, `exporter secret at ${id}`).toBe(reference.exporter);
      }
    }
  }

  /** The epoch of the first active member (for tests that need the number). */
  async epoch(): Promise<bigint> {
    const id = this.activeIds()[0];
    if (id === undefined) throw new Error('no active member');
    const member = this.member(id);
    return member.kind === 'ours'
      ? this.engine.epoch(member.state)
      : BigInt((await this.summaryOf(id)).epoch);
  }
}
