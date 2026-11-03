import {
  createTsMlsEngine,
  DeviceRole,
  MlsEngineErrorCode,
  type GroupState,
  type MemberDelta,
} from '@masia/messenger/mls';
import type { Adversary } from '../../src/mls/__tests__/support/adversary.js';
import { expectAnyEngineError, expectCode, refusedCleanly } from '../../src/mls/__tests__/support/expect-code.js';
import { buildRoom, EMPTY_DELTA, guardianDevice, must, pair, trio } from '../../src/mls/__tests__/support/fixtures.js';
import { expectRefusedEverywhere } from '../../src/mls/__tests__/support/refused.js';
import { Room } from '../../src/mls/__tests__/support/room.js';
import { createTsMlsAdversary } from '../../src/mls/__tests__/support/ts-mls-adversary.js';
import { TestWorld } from '../../src/mls/__tests__/support/world.js';
import { expect } from 'vitest';
import { encode, scenario, type ScenarioResult } from './util.js';

/**
 * A handful of the contract suite's attack checks, picked because they do not depend on timing or
 * on the machine: each forges a message an honest engine cannot make (with the same adversary the
 * contract suite uses) and demands the rule's own error code from every victim, no state moved, and
 * a working group afterwards. They exercise exactly the paths where an engine difference would
 * bite: Ed25519 verification that must answer `false` rather than throw, AEAD failures, malformed
 * bytes, and "only `MlsEngineError` ever escapes".
 *
 * Plus a short seeded fuzz in the shape of the robustness contract (fewer cases).
 */

const newWorld = () => TestWorld.create(createTsMlsEngine);
const adversaryOf = (): Promise<Adversary> => createTsMlsAdversary();

type Check = () => Promise<void>;

const FUZZ_SEED = 0x6d6c7331;
const FUZZ_CASES = 30;
const FUZZ_MUTATIONS = 15;
const FUZZ_MAX_RANDOM_LENGTH = 600;
const BYTE_RANGE = 256;
const BITS_PER_BYTE = 8;
const FUZZ_SPLICE_HEADER_MAX = 64;
const WIRE_PREFIXES: readonly (readonly number[])[] = [
  [0, 1, 0, 1],
  [0, 1, 0, 2],
  [0, 1, 0, 3],
  [0, 1, 0, 4],
  [0, 1, 0, 5],
];
const JOIN_SECRETS_ENTRY = 'joinFromWelcome(keyPackagePrivate)';

const CHECKS: readonly (readonly [name: string, check: Check])[] = [
  [
    'GHSA-gwp3: a Remove-only commit without an UpdatePath is refused (PATH_REQUIRED)',
    async () => {
      const world = await newWorld();
      const adversary = await adversaryOf();
      const { room, devices } = await buildRoom(world, 3);
      const [alice, bob, carol] = trio(devices);
      const commit = await adversary.removeWithoutPath(
        room.state(bob),
        room.leafIndexOf(bob, carol),
        'private',
      );
      await expectRefusedEverywhere(room, [alice, carol], commit, MlsEngineErrorCode.PATH_REQUIRED);
    },
  ],
  [
    'F8b: a GroupContextExtensions-only commit without a path is refused (PATH_REQUIRED)',
    async () => {
      const world = await newWorld();
      const adversary = await adversaryOf();
      const { room, devices } = await buildRoom(world, 3);
      const [alice, bob, carol] = trio(devices);
      const commit = await adversary.groupContextExtensionsWithoutPath(room.state(bob));
      await expectRefusedEverywhere(room, [alice, carol], commit, MlsEngineErrorCode.PATH_REQUIRED);
    },
  ],
  [
    'a PublicMessage commit is refused (UNEXPECTED_MESSAGE_KIND)',
    async () => {
      const world = await newWorld();
      const adversary = await adversaryOf();
      const { room, devices } = await buildRoom(world, 3);
      const [alice, bob, carol] = trio(devices);
      const commit = await adversary.publicSelfUpdate(room.state(alice));
      await expectRefusedEverywhere(
        room,
        [bob, carol],
        commit,
        MlsEngineErrorCode.UNEXPECTED_MESSAGE_KIND,
      );
    },
  ],
  [
    'a real external commit is refused (EXTERNAL_SENDER_FORBIDDEN)',
    async () => {
      const world = await newWorld();
      const adversary = await adversaryOf();
      const { room, devices } = await buildRoom(world, 3);
      const [alice, bob, carol] = trio(devices);
      const eve = await world.device('eve', 'e9');
      const bundle = await world.engine.createKeyPackage(eve.keys);
      const commit = await adversary.externalCommit(room.state(bob), bundle);
      await expectRefusedEverywhere(
        room,
        [alice, carol],
        commit,
        MlsEngineErrorCode.EXTERNAL_SENDER_FORBIDDEN,
      );
    },
  ],
  [
    'a guardian cannot drop its badge in an Update (ROLE_CHANGED)',
    async () => {
      const world = await newWorld();
      const adversary = await adversaryOf();
      const alice = await world.device('alice', 'a1');
      const guard = await guardianDevice(world, 'kid');
      const bob = await world.device('bob', 'b1');
      const room = await Room.create(world, alice);
      await room.add(alice, [guard]);
      await room.add(alice, [bob]);
      const dropped = await adversary.selfUpdateAs(room.state(guard), { role: DeviceRole.USER });
      await expectRefusedEverywhere(room, [alice, bob], dropped, MlsEngineErrorCode.ROLE_CHANGED);
    },
  ],
  [
    'an Update leaf signed by a key the owner never listed is refused (LEAF_NOT_IN_SIGNED_LIST)',
    async () => {
      const world = await newWorld();
      const adversary = await adversaryOf();
      const { room, devices } = await buildRoom(world, 3);
      const [alice, bob, carol] = trio(devices);
      const commit = await adversary.selfUpdateWithUnlistedKey(room.state(bob));
      await expectRefusedEverywhere(
        room,
        [alice, carol],
        commit,
        MlsEngineErrorCode.LEAF_NOT_IN_SIGNED_LIST,
      );
    },
  ],
  [
    'an UpdatePath leaf with a bad Ed25519 signature is refused (SIGNATURE_INVALID)',
    async () => {
      const world = await newWorld();
      const adversary = await adversaryOf();
      const { room, devices } = await buildRoom(world, 3);
      const [alice, bob, carol] = trio(devices);
      const commit = await adversary.selfUpdateWithBadPathSignature(room.state(bob));
      await expectRefusedEverywhere(
        room,
        [alice, carol],
        commit,
        MlsEngineErrorCode.SIGNATURE_INVALID,
      );
    },
  ],
  [
    'a KeyPackage with a bad signature is refused on send and on receive (SIGNATURE_INVALID)',
    async () => {
      const world = await newWorld();
      const { engine } = world;
      const adversary = await adversaryOf();
      const { room, devices } = await buildRoom(world, 3);
      const [alice, bob, carol] = trio(devices);
      const dave = await world.device('dave', 'd1');
      const bundle = await engine.createKeyPackage(dave.keys);
      const damaged = await adversary.forgeKeyPackage(bundle, 'key-package-signature');
      await expectCode(
        () => engine.add({ state: room.state(bob), keyPackages: [damaged] }),
        MlsEngineErrorCode.SIGNATURE_INVALID,
      );
      const forged = await adversary.sealedAdd(room.state(bob), [damaged]);
      await expectRefusedEverywhere(
        room,
        [alice, carol],
        forged.commit,
        MlsEngineErrorCode.SIGNATURE_INVALID,
        forged.memberDelta,
      );
    },
  ],
  [
    'a Welcome with a flipped parent hash or swapped leaves is refused (WELCOME_TREE_MISMATCH)',
    async () => {
      const world = await newWorld();
      const { engine } = world;
      const adversary = await adversaryOf();
      const { room, devices } = await buildRoom(world, 4);
      const alice = must(devices[0], 'alice');
      const dave = await world.device('dave', 'd1');
      const bundle = await engine.createKeyPackage(dave.keys);
      const honest = await adversary.forceAdd(room.state(alice), [bundle.keyPackage]);
      const joined = await engine.joinFromWelcome({
        welcome: honest.welcome,
        keyPackagePrivate: bundle.keyPackagePrivate,
        expectedConversationId: 'conv-1',
        ...room.joinTarget(alice),
      });
      expect(engine.members(joined.state).length).toBe(5);
      for (const tamper of ['flip-parent-hash', 'swap-leaves'] as const) {
        const forged = await adversary.addWithTamperedWelcome(
          room.state(alice),
          [bundle.keyPackage],
          tamper,
        );
        await expectCode(
          () =>
            engine.joinFromWelcome({
              welcome: forged.welcome,
              keyPackagePrivate: bundle.keyPackagePrivate,
              expectedConversationId: 'conv-1',
              ...room.joinTarget(alice),
            }),
          MlsEngineErrorCode.WELCOME_TREE_MISMATCH,
        );
      }
    },
  ],
  [
    "the relay's member delta is compared with the commit (MEMBER_DELTA_MISMATCH)",
    async () => {
      const world = await newWorld();
      const { engine } = world;
      const { room, devices } = await buildRoom(world, 3);
      const [alice, bob] = pair(devices);
      const dave = await world.device('dave', 'd1');
      const bundle = await engine.createKeyPackage(dave.keys);
      const added = await engine.add({ state: room.state(bob), keyPackages: [bundle.keyPackage] });
      const daveEntry = { deviceId: 'd1', userId: 'dave', role: DeviceRole.USER };
      const lies: MemberDelta[] = [
        EMPTY_DELTA,
        { added: [{ ...daveEntry, role: DeviceRole.GUARDIAN }], removed: [] },
        { added: [daveEntry], removed: ['c1'] },
      ];
      for (const lie of lies) {
        await expectCode(
          () =>
            engine.processCommit({
              state: room.state(alice),
              commit: added.commit,
              servedMemberDelta: lie,
            }),
          MlsEngineErrorCode.MEMBER_DELTA_MISMATCH,
        );
      }
      const accepted = await engine.processCommit({
        state: room.state(alice),
        commit: added.commit,
        servedMemberDelta: added.memberDelta,
      });
      expect(accepted.memberDelta).toEqual(added.memberDelta);
    },
  ],
  [
    'a commit that was already applied is not applied again (EPOCH_MISMATCH)',
    async () => {
      const world = await newWorld();
      const { engine } = world;
      const { room, devices } = await buildRoom(world, 3);
      const [alice, bob] = pair(devices);
      const update = await engine.selfUpdate(room.state(bob));
      room.states.set(bob.deviceId, update.state);
      await room.deliver(update.commit, EMPTY_DELTA, [bob]);
      await expectCode(
        () =>
          engine.processCommit({
            state: room.state(alice),
            commit: update.commit,
            servedMemberDelta: EMPTY_DELTA,
          }),
        MlsEngineErrorCode.EPOCH_MISMATCH,
      );
    },
  ],
  [
    'application data: a wrong aad (AAD_MISMATCH), a spent key and a flipped ciphertext bit are refused',
    async () => {
      const world = await newWorld();
      const { engine } = world;
      const { room, devices } = await buildRoom(world, 2);
      const [a, b] = pair(devices);
      const sealed = await engine.encrypt(room.state(a), encode('hello'), encode('counter-1'));
      await expectCode(
        () => engine.decrypt(room.state(b), sealed.ciphertext, encode('counter-2')),
        MlsEngineErrorCode.AAD_MISMATCH,
      );
      const opened = await engine.decrypt(room.state(b), sealed.ciphertext, encode('counter-1'));
      await expectAnyEngineError(() => engine.decrypt(opened.state, sealed.ciphertext));
      for (const at of [sealed.ciphertext.length - 1, Math.floor(sealed.ciphertext.length / 2)]) {
        const flipped = Uint8Array.from(sealed.ciphertext);
        flipped[at] = (flipped[at] ?? 0) ^ 1;
        await expectAnyEngineError(() => engine.decrypt(room.state(b), flipped));
      }
    },
  ],
  [
    'a member who does not administer the child cannot remove the guardian leaf (GUARDIAN_REMOVE_FORBIDDEN)',
    async () => {
      const world = await newWorld();
      const mom = await world.device('mom', 'm1');
      const alice = await world.device('alice', 'a1');
      const bob = await world.device('bob', 'b1');
      const kid = await world.device('kid', 'kid1');
      const guard = await guardianDevice(world, 'kid');
      world.makeAdmin('mom', 'kid');
      const room = await Room.create(world, mom);
      for (const newcomer of [alice, bob, kid, guard]) await room.add(mom, [newcomer]);
      await expectCode(
        () =>
          world.engine.remove({
            state: room.state(bob),
            leafIndexes: [room.leafIndexOf(bob, guard)],
          }),
        MlsEngineErrorCode.GUARDIAN_REMOVE_FORBIDDEN,
      );
      const forged = await (await adversaryOf()).forceRemove(room.state(bob), [
        room.leafIndexOf(bob, guard),
      ]);
      await expectRefusedEverywhere(
        room,
        [mom, alice, guard],
        forged.commit,
        MlsEngineErrorCode.GUARDIAN_REMOVE_FORBIDDEN,
        forged.memberDelta,
      );
    },
  ],
];

// --- A short seeded fuzz: only MlsEngineError may escape -------------------------------------------

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Fuzzer {
  private readonly next: () => number;
  constructor(seed: number) {
    this.next = seededRandom(seed);
  }
  int(below: number): number {
    return Math.floor(this.next() * below);
  }
  bytes(length: number): Uint8Array {
    return Uint8Array.from({ length }, () => this.int(BYTE_RANGE));
  }
  noise(): Uint8Array {
    return this.bytes(this.int(FUZZ_MAX_RANDOM_LENGTH));
  }
  withPrefix(): Uint8Array {
    const prefix = WIRE_PREFIXES[this.int(WIRE_PREFIXES.length)] ?? [];
    return Uint8Array.from([...prefix, ...this.noise()]);
  }
  splice(valid: Uint8Array): Uint8Array {
    const keep = this.int(Math.min(valid.length, FUZZ_SPLICE_HEADER_MAX));
    return Uint8Array.from([...valid.subarray(0, keep), ...this.noise()]);
  }
  flip(valid: Uint8Array): Uint8Array {
    const out = Uint8Array.from(valid);
    const at = this.int(out.length);
    out[at] = (out[at] ?? 0) ^ (1 << this.int(BITS_PER_BYTE));
    return out;
  }
  truncate(valid: Uint8Array): Uint8Array {
    return valid.slice(0, this.int(valid.length));
  }
  extend(valid: Uint8Array): Uint8Array {
    return Uint8Array.from([...valid, ...this.bytes(1 + this.int(BITS_PER_BYTE))]);
  }
}

interface EntryPoint {
  readonly name: string;
  readonly feed: (bytes: Uint8Array) => Promise<unknown>;
}

async function fuzz(): Promise<{ refused: number; mutated: number }> {
  const world = await newWorld();
  const { engine } = world;
  const { room, devices } = await buildRoom(world, 3);
  const [alice, bob] = pair(devices);
  const dave = await world.device('dave', 'd1');
  const bundle = await engine.createKeyPackage(dave.keys);
  const added = await engine.add({ state: room.state(alice), keyPackages: [bundle.keyPackage] });
  const update = await engine.selfUpdate(room.state(bob));
  const sealed = await engine.encrypt(room.state(alice), encode('fuzz'));
  const state: GroupState = room.state(alice);
  const target = room.joinTarget(alice);

  const processCommit: EntryPoint = {
    name: 'processCommit',
    feed: (commit) => engine.processCommit({ state, commit, servedMemberDelta: EMPTY_DELTA }),
  };
  const joinWelcome: EntryPoint = {
    name: 'joinFromWelcome(welcome)',
    feed: (welcome) =>
      engine.joinFromWelcome({
        welcome,
        keyPackagePrivate: bundle.keyPackagePrivate,
        expectedConversationId: 'conv-1',
        ...target,
      }),
  };
  const joinSecrets: EntryPoint = {
    name: JOIN_SECRETS_ENTRY,
    feed: (keyPackagePrivate) =>
      engine.joinFromWelcome({
        welcome: added.welcome,
        keyPackagePrivate,
        expectedConversationId: 'conv-1',
        ...target,
      }),
  };
  const decrypt: EntryPoint = { name: 'decrypt', feed: (c) => engine.decrypt(state, c) };
  const decodeState: EntryPoint = {
    name: 'decodeState',
    feed: (bytes) => Promise.resolve(engine.decodeState(bytes)),
  };
  const add: EntryPoint = {
    name: 'add(keyPackage)',
    feed: (keyPackage) => engine.add({ state, keyPackages: [keyPackage] }),
  };
  const entryPoints = [processCommit, joinWelcome, joinSecrets, decrypt, decodeState, add];
  const mutable = [
    [processCommit, update.commit],
    [joinWelcome, added.welcome],
    [joinSecrets, bundle.keyPackagePrivate],
    [decrypt, sealed.ciphertext],
    [add, bundle.keyPackage],
  ] as const;
  const realHeaders = [update.commit, added.welcome, sealed.ciphertext, bundle.keyPackage];

  let refused = 0;
  const random = new Fuzzer(FUZZ_SEED);
  for (let i = 0; i < FUZZ_CASES; i += 1) {
    const header = must(realHeaders[i % realHeaders.length], 'header');
    for (const bytes of [random.noise(), random.withPrefix(), random.splice(header)]) {
      for (const entry of entryPoints) {
        const wasRefused = await refusedCleanly(() => entry.feed(bytes));
        expect(wasRefused, `${entry.name} accepted ${bytes.length} random bytes`).toBe(true);
        refused += 1;
      }
    }
  }
  let mutated = 0;
  const mutator = new Fuzzer(FUZZ_SEED + 1);
  for (const [entry, valid] of mutable) {
    for (let i = 0; i < FUZZ_MUTATIONS; i += 1) {
      for (const bytes of [mutator.flip(valid), mutator.truncate(valid), mutator.extend(valid)]) {
        const wasRefused = await refusedCleanly(() => entry.feed(bytes));
        mutated += 1;
        // The one honest way to accept a changed byte: a private key bit X25519 clamps away.
        if (!wasRefused) expect(entry.name, `${entry.name} accepted a mutated message`).toBe(JOIN_SECRETS_ENTRY);
      }
    }
  }
  // None of that touched the state it was thrown at.
  await room.selfUpdate(bob);
  room.expectConverged();
  return { refused, mutated };
}

export async function runAttacks(): Promise<ScenarioResult[]> {
  const results: ScenarioResult[] = [];
  for (const [name, check] of CHECKS) {
    results.push(await scenario(`attack: ${name}`, async ({ step }) => step('check', check)));
  }
  results.push(
    await scenario(
      `attack: seeded fuzz, only MlsEngineError escapes (${FUZZ_CASES * 3 * 6} garbage + ${FUZZ_MUTATIONS * 3 * 5} mutated inputs)`,
      async ({ step, note }) => {
        const counts = await step('fuzz', fuzz);
        note('refusedGarbage', counts.refused);
        note('mutatedInputs', counts.mutated);
      },
    ),
  );
  return results;
}
