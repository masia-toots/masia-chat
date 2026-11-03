import { expect } from 'vitest';
import type { GroupState, MemberDelta } from '../../mls-engine.js';
import type { TestDevice, TestWorld } from './world.js';

/**
 * One conversation as the tests drive it: every device's `GroupState` side by side, with the
 * delivery that a relay would do (every other member gets every commit, in order) written once.
 * Uses the `MlsEngine` interface only.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface AddOutcome {
  readonly commit: Uint8Array;
  readonly welcome: Uint8Array;
  readonly memberDelta: MemberDelta;
}

/** How the host hands a commit to a receiver (see `ProcessCommitInput`). */
export interface Delivery {
  readonly backlog?: boolean;
  readonly acceptedAtMs?: number;
}

/** Devices that are offline: they receive nothing until the test replays their backlog by hand. */
export interface OfflineOptions {
  readonly offline?: readonly TestDevice[];
}

export class Room {
  /** Current state of every device that ever joined, keyed by deviceId. */
  readonly states = new Map<string, GroupState>();
  private readonly devices = new Map<string, TestDevice>();
  /** Devices that were removed: they stop receiving commits. */
  private readonly removed = new Set<string>();

  private constructor(
    readonly world: TestWorld,
    readonly conversationId: string,
    readonly groupId: Uint8Array,
  ) {}

  static async create(
    world: TestWorld,
    creator: TestDevice,
    conversationId = 'conv-1',
  ): Promise<Room> {
    const { state, groupId } = await world.engine.createGroup({
      conversationId,
      selfLeaf: creator.keys,
    });
    const room = new Room(world, conversationId, groupId);
    room.devices.set(creator.deviceId, creator);
    room.states.set(creator.deviceId, state);
    return room;
  }

  /**
   * What the host knows when it hands a newcomer the Welcome of an Add that `committer` has NOT yet
   * adopted: the room's group id and the epoch the Add makes (the committer's epoch plus one).
   */
  joinTarget(committer: TestDevice): { expectedGroupId: Uint8Array; expectedEpoch: bigint } {
    return {
      expectedGroupId: this.groupId,
      expectedEpoch: this.world.engine.epoch(this.state(committer)) + 1n,
    };
  }

  state(device: TestDevice): GroupState {
    const state = this.states.get(device.deviceId);
    if (state === undefined) throw new Error(`${device.deviceId} is not in this room`);
    return state;
  }

  leafIndexOf(viewer: TestDevice, target: TestDevice): number {
    const member = this.world.engine
      .members(this.state(viewer))
      .find((m) => m.userId === target.userId && m.deviceId === target.deviceId);
    if (member === undefined) throw new Error(`${target.deviceId} is not in the tree`);
    return member.leafIndex;
  }

  /** Every device that still receives commits. */
  activeDevices(): TestDevice[] {
    return [...this.devices.values()].filter((d) => !this.removed.has(d.deviceId));
  }

  /**
   * Hands a commit to every active member except the ones in `skip`, as a relay would. `delivery`
   * is how the host hands it over: a live commit (the default) or one replayed from the backlog.
   */
  async deliver(
    commit: Uint8Array,
    memberDelta: MemberDelta,
    skip: readonly TestDevice[],
    delivery: Delivery = {},
  ): Promise<void> {
    const skipped = new Set(skip.map((d) => d.deviceId));
    for (const device of this.activeDevices()) {
      if (skipped.has(device.deviceId)) continue;
      const result = await this.world.engine.processCommit({
        state: this.state(device),
        commit,
        servedMemberDelta: memberDelta,
        ...delivery,
      });
      this.states.set(device.deviceId, result.state);
      if (result.removedFromGroup) this.removed.add(device.deviceId);
    }
  }

  /** Add -> deliver the commit -> Welcome -> (by protocol) every newcomer posts its self-update. */
  async add(
    committer: TestDevice,
    newcomers: readonly TestDevice[],
    options: { selfUpdate?: boolean } & OfflineOptions = {},
  ): Promise<AddOutcome> {
    const offline = options.offline ?? [];
    const { engine } = this.world;
    const bundles = await Promise.all(newcomers.map((n) => engine.createKeyPackage(n.keys)));
    const result = await engine.add({
      state: this.state(committer),
      keyPackages: bundles.map((b) => b.keyPackage),
    });
    await this.deliver(result.commit, result.memberDelta, [committer, ...offline]);
    this.states.set(committer.deviceId, result.state);

    for (const [i, newcomer] of newcomers.entries()) {
      const bundle = bundles[i];
      if (bundle === undefined) throw new Error('missing bundle');
      const joined = await engine.joinFromWelcome({
        welcome: result.welcome,
        keyPackagePrivate: bundle.keyPackagePrivate,
        expectedConversationId: this.conversationId,
        expectedGroupId: this.groupId,
        expectedEpoch: engine.epoch(result.state),
      });
      this.devices.set(newcomer.deviceId, newcomer);
      this.states.set(newcomer.deviceId, joined.state);
    }
    if (options.selfUpdate !== false) {
      for (const newcomer of newcomers) await this.selfUpdate(newcomer, { offline });
    }
    return { commit: result.commit, welcome: result.welcome, memberDelta: result.memberDelta };
  }

  async remove(
    committer: TestDevice,
    targets: readonly TestDevice[],
    options: OfflineOptions = {},
  ): Promise<{ commit: Uint8Array; memberDelta: MemberDelta }> {
    const { engine } = this.world;
    const leafIndexes = targets.map((t) => this.leafIndexOf(committer, t));
    const result = await engine.remove({ state: this.state(committer), leafIndexes });
    await this.deliver(result.commit, result.memberDelta, [committer, ...(options.offline ?? [])]);
    this.states.set(committer.deviceId, result.state);
    return { commit: result.commit, memberDelta: result.memberDelta };
  }

  async selfUpdate(device: TestDevice, options: OfflineOptions = {}): Promise<Uint8Array> {
    const result = await this.world.engine.selfUpdate(this.state(device));
    const noDelta: MemberDelta = { added: [], removed: [] };
    await this.deliver(result.commit, noDelta, [device, ...(options.offline ?? [])]);
    this.states.set(device.deviceId, result.state);
    return result.commit;
  }

  /** `sender` encrypts `text`; every other active member must read exactly it, from `sender`. */
  async send(sender: TestDevice, text: string): Promise<Uint8Array> {
    const { engine } = this.world;
    const sealed = await engine.encrypt(this.state(sender), encoder.encode(text));
    this.states.set(sender.deviceId, sealed.state);
    for (const device of this.activeDevices()) {
      if (device.deviceId === sender.deviceId) continue;
      const opened = await engine.decrypt(this.state(device), sealed.ciphertext);
      this.states.set(device.deviceId, opened.state);
      expect(decoder.decode(opened.plaintext)).toBe(text);
      expect(opened.sender.deviceId).toBe(sender.deviceId);
      expect(opened.sender.userId).toBe(sender.userId);
    }
    return sealed.ciphertext;
  }

  /** Every active member is in the same epoch, sees the same tree and derives the same epoch_authenticator. */
  expectConverged(): void {
    const { engine } = this.world;
    const active = this.activeDevices();
    const first = active[0];
    if (first === undefined) throw new Error('empty room');
    const reference = this.state(first);
    const refMembers = engine
      .members(reference)
      .map((m) => `${m.leafIndex}:${m.userId}:${m.deviceId}:${m.role}`)
      .sort();
    for (const device of active) {
      const state = this.state(device);
      expect(engine.epoch(state)).toBe(engine.epoch(reference));
      expect(engine.epochAuthenticator(state)).toEqual(engine.epochAuthenticator(reference));
      expect(
        engine
          .members(state)
          .map((m) => `${m.leafIndex}:${m.userId}:${m.deviceId}:${m.role}`)
          .sort(),
      ).toEqual(refMembers);
      expect(engine.conversationId(state)).toBe(this.conversationId);
    }
  }
}
