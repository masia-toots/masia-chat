import { randomBytes } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { CONVERSATION_ID_EXTENSION_TYPE } from '../../constants.js';
import { encodeCredentialIdentity } from '../../credential.js';
import { frameAad } from '../../framing.js';
import {
  DeviceRole,
  MlsEngineErrorCode,
  type DeviceIdentity,
  type GroupState,
  type MemberDelta,
} from '../../mls-engine.js';
import type { TestDevice } from '../support/world.js';
import {
  aadFrame,
  CONVERSATION_EXTENSION_TYPE,
  conversationExtension,
  credentialBytes,
  deltaOf,
  idOf,
  isOurs,
  keyPackageArgs,
  MixedRoom,
  ours,
  Rig,
  theirs,
  utf8,
  type KeyPackageOptions,
  type OpenMlsDevice,
  type OpenMlsDeviceOptions,
  type Party,
} from './harness.js';
import { fromBase64, toBase64, type CommitResult } from './peer.js';
import { describeError, RunLog, Scenario } from './recorder.js';

/**
 * Interop of our `MlsEngine` against OpenMLS (a Rust implementation, run in a container).
 *
 * Gated: `MLS_INTEROP=1` and a built image (see `README.md`; `pnpm test:interop` does both). Without
 * the flag the whole file is skipped, so the regular suite never needs Docker.
 *
 * Every scenario opens its own container and its own `TestWorld`, so scenarios do not depend on
 * each other or on their order. A scenario is a list of CHECKS; the run writes every check, with the
 * library's own error text, to `MLS_INTEROP_OUT` (default: nothing).
 */

const ENABLED = process.env['MLS_INTEROP'] === '1';
const IMAGE = process.env['MLS_INTEROP_IMAGE'] ?? 'masia-openmls-interop:dev';
const OUT = process.env['MLS_INTEROP_OUT'];
const SCENARIO_TIMEOUT_MS = 240_000;

const log = new RunLog();

type Body = (s: Scenario, rig: Rig) => Promise<void>;

function scenario(id: string, title: string, body: Body): void {
  it(
    `${id} ${title}`,
    async () => {
      const s = new Scenario(id, title);
      const rig = await Rig.open(IMAGE);
      try {
        await body(s, rig);
      } catch (error) {
        s.crash(error);
        throw error;
      } finally {
        await rig.close();
        log.add(s.record());
      }
      expect(s.failures()).toEqual([]);
    },
    SCENARIO_TIMEOUT_MS,
  );
}

const USER = DeviceRole.USER;

/** Some messages that cover the framing: plain, non-ASCII, large; each with its own extra AAD. */
const SAMPLE_MESSAGES: readonly (readonly [text: string, extra: Uint8Array])[] = [
  ['hello', new Uint8Array()],
  ['Привіт, Мася! 🌍', Uint8Array.of(0, 0, 0, 1)],
  ['x'.repeat(20_000), Uint8Array.of(0, 0, 0, 2, 9, 9)],
];

/** Everyone in `ids` sends the sample messages; everyone else must read them. */
async function chat(room: MixedRoom, ids: readonly string[]): Promise<void> {
  for (const id of ids) {
    for (const [message, extra] of SAMPLE_MESSAGES) await room.send(id, message, extra);
  }
}

// --- Helpers for the scenarios above ----------------------------------------------------------------

const NO_DELTA: MemberDelta = { added: [], removed: [] };

/** `processCommit` at one of our states, judged strictly (a live commit). */
function processAt(
  rig: Rig,
  state: GroupState,
  commit: Uint8Array,
  servedMemberDelta: MemberDelta,
): Promise<unknown> {
  return rig.engine.processCommit({ state, commit, servedMemberDelta });
}

/** One of our devices and one OpenMLS device in a room we created; the OpenMLS device has updated. */
async function pairRoom(
  rig: Rig,
  tag: string,
): Promise<{ room: MixedRoom; a: TestDevice; o: OpenMlsDevice; conversationId: string }> {
  const a = await rig.ours('alice', `a-${tag}`);
  const o = await rig.openmls({ userId: 'bob', deviceId: `o-${tag}`, role: USER });
  const conversationId = `conv-${tag}`;
  const room = await MixedRoom.createOurs(rig, a, conversationId);
  await room.add(a.deviceId, [theirs(o)]);
  return { room, a, o, conversationId };
}

interface GroupOptions {
  readonly gcExtensions?: 'with-unknown' | 'bad-id' | readonly { type: number; data: string }[];
  readonly capabilityExtensions?: readonly number[];
  readonly ratchetTreeExtension?: boolean;
}

interface Welcome {
  readonly welcome: Uint8Array;
  readonly secret: Uint8Array;
  readonly groupId: Uint8Array;
  readonly epoch: bigint;
}

/**
 * An OpenMLS device creates a group (as `options` says) and adds one of our devices; returns the
 * Welcome, or the step at which OpenMLS itself refused.
 */
async function openMlsWelcome(
  rig: Rig,
  tag: string,
  newcomer: TestDevice,
  conversationId: string,
  options: GroupOptions,
  creatorOptions: OpenMlsDeviceOptions,
): Promise<Welcome | { refusedAt: string; error: string }> {
  const creator = await rig.openmls(
    { userId: 'alice', deviceId: `o-${tag}`, role: USER },
    creatorOptions,
  );
  const groupId = Uint8Array.from(randomBytes(32));
  const extensions =
    options.gcExtensions === 'with-unknown'
      ? [conversationExtension(conversationId), { type: 0xf0c2, data: toBase64(Uint8Array.of(1)) }]
      : options.gcExtensions === 'bad-id'
        ? [conversationExtension('bad id!')]
        : (options.gcExtensions ?? [conversationExtension(conversationId)]);
  const created = await rig.peer.attempt('create_group', {
    client: creator.client,
    group_id: toBase64(groupId),
    gc_extensions: extensions,
    ratchet_tree_extension: options.ratchetTreeExtension ?? true,
    capability_extensions: options.capabilityExtensions,
  });
  if (!created.ok) return { refusedAt: 'create_group', error: created.error };
  const bundle = await rig.engine.createKeyPackage(newcomer.keys);
  const added = await rig.peer.attempt<CommitResult>('add', {
    client: creator.client,
    group: toBase64(groupId),
    key_packages: [toBase64(bundle.keyPackage)],
  });
  if (!added.ok) return { refusedAt: 'add', error: added.error };
  if (added.result.welcome === null) return { refusedAt: 'add', error: 'no Welcome in the answer' };
  return {
    welcome: fromBase64(added.result.welcome),
    secret: bundle.keyPackagePrivate,
    groupId,
    epoch: BigInt(added.result.epoch),
  };
}

/**
 * The smallest tree shape that RFC 9420 allows and that UNPATCHED ts-mls 1.6.4 refuses to join (finding
 * F1). The repo pins `patches/ts-mls@1.6.4.patch` (canon section 9.7), so K1 and S1 seed 11 are green;
 * they stay as the regression witnesses that would turn red if the patch were dropped too early.
 * Shape:
 * the 4th member joins WITHOUT a self-update, so it stays in the `unmerged_leaves` of the node above
 * it; the 5th member (the other half of an 8-leaf tree) then refreshes the root through its own
 * UpdatePath, which clears the root's list but not the lower node's. The next Welcome carries that tree.
 */
async function buildUnmergedShape(
  room: MixedRoom,
  creatorId: string,
  members: readonly [Party, Party, Party, Party],
): Promise<void> {
  const [b, c, d, e] = members;
  await room.add(creatorId, [b]);
  await room.add(creatorId, [c]);
  await room.add(creatorId, [d], { selfUpdate: false });
  await room.add(creatorId, [e]);
}

const SEQUENCE_POOL = 5;
const SEQUENCE_STEPS = 18;
const SEQUENCE_SEEDS: readonly number[] = [11, 23, 47];
const SEQUENCE_MAX_MEMBERS = 8;

/** A small deterministic generator (an LCG): a failing seed replays exactly. */
function lcg(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 2 ** 32;
  };
}

/**
 * Starts a room with one engine device, adds two more devices (one of each kind), then makes
 * `SEQUENCE_STEPS` random moves. After every move everybody must agree and a random member's
 * message must be readable by all. `trail` records the moves so a failure names them.
 */
async function runSequence(
  rig: Rig,
  pool: readonly Party[],
  seed: number,
  trail: string[],
): Promise<void> {
  const rnd = lcg(seed);
  const pick = <T>(items: readonly T[]): T => {
    const item = items[Math.floor(rnd() * items.length)];
    if (item === undefined) throw new Error('nothing to pick from');
    return item;
  };
  const creator = pool.find(isOurs);
  if (creator === undefined) throw new Error('no engine device in the pool');
  const room = await MixedRoom.createOurs(rig, creator.device, `conv-seq-${String(seed)}`);
  const first = pool.find((p) => p.kind === 'openmls');
  if (first === undefined) throw new Error('no OpenMLS device in the pool');
  await room.add(idOf(creator), [first]);
  trail.push(`start ${idOf(creator)}+${idOf(first)}`);

  for (let step = 0; step < SEQUENCE_STEPS; step += 1) {
    const active = room.activeIds();
    const outside = pool.filter((p) => !active.includes(idOf(p)));
    const roll = rnd();
    if (roll < 0.35 && outside.length > 0 && active.length < SEQUENCE_MAX_MEMBERS) {
      const committer = pick(active);
      const newcomer = pick(outside);
      const update = rnd() < 0.7;
      trail.push(`${committer} adds ${idOf(newcomer)}${update ? '' : ' (no update)'}`);
      await room.add(committer, [newcomer], { selfUpdate: update });
    } else if (roll < 0.55 && active.length > 2) {
      const target = pick(active);
      const committer = pick(active.filter((id) => id !== target));
      trail.push(`${committer} removes ${target}`);
      await room.remove(committer, [target]);
    } else if (roll < 0.8) {
      const id = pick(active);
      trail.push(`${id} updates`);
      await room.selfUpdate(id);
    } else {
      trail.push('idle');
    }
    const sender = pick(room.activeIds());
    await room.send(sender, `step ${String(step)} from ${sender}`, Uint8Array.of(step));
    await room.expectConverged();
  }
}

const SKIP_REASON =
  'skipped: needs Docker; run `pnpm test:interop` or set MLS_INTEROP=1 (interop/README.md)';

describe.skipIf(!ENABLED)(ENABLED ? 'OpenMLS interop' : `OpenMLS interop (${SKIP_REASON})`, () => {
  afterAll(() => {
    if (OUT !== undefined) log.write(OUT, { image: IMAGE });
  });

  scenario('L0', 'the wire layout the canon pins', async (s) => {
    const identity = { userId: 'alice', deviceId: 'a1', role: DeviceRole.GUARDIAN };
    expect(credentialBytes(identity)).toEqual(encodeCredentialIdentity(identity));
    s.pass('credential identity bytes', 'u8 1 | u8 role | u8 len | userId | u8 len | deviceId');
    expect(CONVERSATION_EXTENSION_TYPE).toBe(CONVERSATION_ID_EXTENSION_TYPE);
    s.pass('conversation-id group-context extension type', '0xf0c1');
    const extra = Uint8Array.of(1, 2, 3);
    expect(aadFrame('conv-1', extra)).toEqual(frameAad('conv-1', extra));
    s.pass('application AAD frame', 'u8 len | conversationId | extra');
    await Promise.resolve();
  });

  scenario(
    'A1',
    'our group; an OpenMLS device joins by Welcome; Add, self-update, messages, Remove',
    async (s, rig) => {
      const alice = await rig.ours('alice', 'a1');
      const bob = await rig.openmls({ userId: 'bob', deviceId: 'o1', role: USER });
      const room = await MixedRoom.createOurs(rig, alice, 'conv-a1');

      await room.add('a1', [theirs(bob)], { selfUpdate: false });
      s.pass('OpenMLS joins from our Welcome', 'ratchet tree read from the GroupInfo extension');
      await room.expectConverged();
      s.pass('after the Add: epoch, tree, epoch_authenticator and exporter secret agree');
      await chat(room, ['a1', 'o1']);
      s.pass('messages both ways with the conversation-bound AAD (plain, unicode, 20 KB)');

      const theirUpdate = await room.selfUpdate('o1');
      await room.expectConverged();
      s.pass(
        'OpenMLS self-update is accepted by our validator',
        `received by ours: ${theirUpdate.received.size}`,
      );
      await chat(room, ['o1', 'a1']);

      const ourUpdate = await room.selfUpdate('a1');
      expect(ourUpdate.hasUpdatePath).toBe(true);
      await room.expectConverged();
      s.pass('our self-update carries an UpdatePath and OpenMLS applies it', 'hasUpdatePath=true');
      await chat(room, ['a1', 'o1']);

      const removal = await room.remove('a1', ['o1']);
      expect(removal.received.get('o1')?.removed).toBe(true);
      expect(room.isActive('o1')).toBe(false);
      s.pass('we remove the OpenMLS member; it sees itself removed', 'selfRemoved=true');
      const afterRemoval = await rig.peer.attempt('encrypt', {
        client: bob.client,
        group: room.key,
        plaintext: 'AA==',
      });
      if (afterRemoval.ok) s.fail('removed OpenMLS device cannot send', 'a refusal', 'it sent');
      else s.pass('removed OpenMLS device cannot send', afterRemoval.error);
      await room.send('a1', 'alone again');
    },
  );

  scenario(
    'A2',
    'OpenMLS commits in our group (with and without UpdatePath); our device joins from an OpenMLS Welcome',
    async (s, rig) => {
      const a1 = await rig.ours('alice', 'a1');
      const a2 = await rig.ours('alice', 'a2');
      const o1 = await rig.openmls({ userId: 'bob', deviceId: 'o1', role: USER });
      const o2 = await rig.openmls({ userId: 'carol', deviceId: 'o2', role: USER });
      const o3 = await rig.openmls({ userId: 'dave', deviceId: 'o3', role: USER });
      const room = await MixedRoom.createOurs(rig, a1, 'conv-a2');
      await room.add('a1', [theirs(o1)]);

      const ourAdd = await room.add('a1', [theirs(o2)]);
      expect(ourAdd.hasUpdatePath).toBe(false);
      s.pass('our Add commit has no UpdatePath and OpenMLS accepts it', 'hasUpdatePath=false');

      const withPath = await room.add('o1', [theirs(o3)], { forcePath: true });
      expect(withPath.hasUpdatePath).toBe(true);
      await room.expectConverged();
      s.pass(
        'OpenMLS Add commit with an UpdatePath is accepted by our validator',
        'hasUpdatePath=true',
      );

      const withoutPath = await room.add('o2', [ours(a2)], { forcePath: false });
      expect(withoutPath.hasUpdatePath).toBe(false);
      await room.expectConverged();
      s.pass(
        'OpenMLS Add commit without an UpdatePath is accepted; our device joins from its Welcome',
        'joinFromWelcome with expectedGroupId and expectedEpoch',
      );
      await chat(room, ['a1', 'a2', 'o1', 'o2', 'o3']);
      s.pass('five-member room: messages from every member are read by every member');

      const removal = await room.remove('o1', ['o3']);
      expect(removal.hasUpdatePath).toBe(true);
      await room.expectConverged();
      s.pass('OpenMLS Remove (with UpdatePath) is accepted', 'member delta matches');

      const eviction = await room.remove('o2', ['a2']);
      const evicted = eviction.received.get('a2');
      expect(evicted?.removed).toBe(true);
      expect(evicted?.epochAuthenticator).toBeNull();
      expect(rig.engine.isActive(room.stateOf('a2'))).toBe(false);
      s.pass('OpenMLS removes OUR device: removedFromGroup=true, epoch_authenticator=null');
      await s.refusal('the evicted device cannot send', MlsEngineErrorCode.NOT_ACTIVE, () =>
        rig.engine.encrypt(room.stateOf('a2'), utf8('still here?')),
      );
      await room.expectConverged();
      await chat(room, ['a1', 'o1', 'o2']);
    },
  );

  scenario(
    'A3',
    'both kinds in one Add; unmerged leaves; OpenMLS removes and re-adds one of ours',
    async (s, rig) => {
      const a1 = await rig.ours('alice', 'a1');
      const b1 = await rig.ours('bob', 'b1');
      const o1 = await rig.openmls({ userId: 'carol', deviceId: 'o1', role: USER });
      const o2 = await rig.openmls({ userId: 'dave', deviceId: 'o2', role: USER });
      const room = await MixedRoom.createOurs(rig, a1, 'conv-a3');

      await room.add('a1', [ours(b1), theirs(o1)], { selfUpdate: false });
      await room.expectConverged();
      s.pass('one Add of an engine device and an OpenMLS device; both join from the one Welcome');

      await room.add('o1', [theirs(o2)], { forcePath: false, selfUpdate: false });
      await room.expectConverged();
      await chat(room, ['a1', 'b1', 'o1', 'o2']);
      s.pass(
        'newcomers that have not updated (unmerged leaves in the tree) exchange messages',
        'tree encoding with unmerged leaves is read by both sides',
      );

      await room.selfUpdate('b1');
      await room.selfUpdate('o2');
      await room.expectConverged();
      s.pass('updates over unmerged leaves are accepted by both sides');

      await room.remove('o1', ['b1']);
      expect(room.isActive('b1')).toBe(false);
      await room.expectConverged();
      s.pass('OpenMLS removes one of ours');

      await room.add('o2', [ours(b1)]);
      await room.expectConverged();
      await chat(room, ['b1', 'o2', 'a1']);
      s.pass('the removed device is added again with a fresh KeyPackage (an ordinary Add)');

      const removal = await room.remove('a1', ['o2']);
      expect(removal.received.get('o2')?.removed).toBe(true);
      await room.expectConverged();
      s.pass('we remove an OpenMLS member that has just updated');
    },
  );

  scenario(
    'B1',
    'an OpenMLS group; our device joins by Welcome (expectedGroupId, expectedEpoch); messages both ways',
    async (s, rig) => {
      const o1 = await rig.openmls({ userId: 'alice', deviceId: 'o1', role: USER });
      const o2 = await rig.openmls({ userId: 'dave', deviceId: 'o2', role: USER });
      const b1 = await rig.ours('bob', 'b1');
      const c1 = await rig.ours('carol', 'c1');
      const room = await MixedRoom.createOpenMls(rig, o1, 'conv-b1');

      await room.add('o1', [ours(b1)], { selfUpdate: false });
      expect(rig.engine.needsSelfUpdate(room.stateOf('b1'))).toBe(true);
      s.pass(
        'joinFromWelcome accepts an OpenMLS Welcome',
        'GroupContext extension 0xf0c1 only, ratchet tree in the GroupInfo, credential and key on the signed list',
      );
      await room.expectConverged();
      await chat(room, ['o1', 'b1']);
      s.pass('messages both ways before our first self-update');

      const update = await room.selfUpdate('b1');
      expect(update.hasUpdatePath).toBe(true);
      expect(rig.engine.needsSelfUpdate(room.stateOf('b1'))).toBe(false);
      await room.expectConverged();
      s.pass('our newcomer self-update is accepted by OpenMLS', 'hasUpdatePath=true');

      await room.add('o1', [ours(c1), theirs(o2)]);
      await room.expectConverged();
      await chat(room, ['b1', 'c1', 'o1', 'o2']);
      s.pass('OpenMLS adds one more of ours and one of its own in one commit');

      const ourRemoval = await room.remove('b1', ['o2']);
      expect(ourRemoval.received.get('o2')?.removed).toBe(true);
      await room.expectConverged();
      s.pass('our engine removes an OpenMLS member from an OpenMLS-created group');

      const theirRemoval = await room.remove('o1', ['b1']);
      expect(theirRemoval.received.get('b1')?.removed).toBe(true);
      await room.expectConverged();
      await chat(room, ['o1', 'c1']);
      s.pass('OpenMLS removes one of ours from its own group');
    },
  );

  scenario('B2', 'an OpenMLS group with padding and a mixed wire-format policy', async (s, rig) => {
    const o1 = await rig.openmls({ userId: 'alice', deviceId: 'o1', role: USER });
    const b1 = await rig.ours('bob', 'b1');
    const room = await MixedRoom.createOpenMls(rig, o1, 'conv-b2', {
      padding: 128,
      wireFormat: 'mixed-ciphertext',
    });
    await room.add('o1', [ours(b1)]);
    await room.expectConverged();
    await chat(room, ['o1', 'b1']);
    s.pass('padded OpenMLS commits and application messages are read by our engine');
    await room.selfUpdate('o1');
    await room.expectConverged();
  });

  scenario(
    'N0',
    'negative control: the comparisons fail when a commit is missed',
    async (s, rig) => {
      const { room, o } = await pairRoom(rig, 'n0');
      await room.expectConverged();
      // OpenMLS commits; the commit is never delivered to us.
      await rig.peer.call('self_update', { client: o.client, group: room.key });
      await expect(room.expectConverged()).rejects.toThrow();
      s.pass('a commit one side never saw is caught by the epoch_authenticator comparison');
      await expect(room.send(o.identity.deviceId, 'unreadable')).rejects.toThrow();
      s.pass('a message from the epoch we never reached is not readable');
    },
  );

  // --- What our validator must refuse that OpenMLS does as a matter of course -------------------

  scenario(
    'C1',
    'a proposal by reference and a standalone proposal are refused',
    async (s, rig) => {
      const { room, a, o } = await pairRoom(rig, 'c1');
      const o2 = await rig.openmls({ userId: 'carol', deviceId: 'o-c1b', role: USER });
      const before = room.stateOf(a.deviceId);
      const proposal = await rig.peer.call<{ proposal: string }>('propose_add', {
        client: o.client,
        group: room.key,
        key_package: toBase64(await rig.keyPackage(o2)),
      });
      await s.refusal(
        'standalone Add proposal (PrivateMessage), as OpenMLS sends it',
        MlsEngineErrorCode.STANDALONE_PROPOSAL_FORBIDDEN,
        () => processAt(rig, before, fromBase64(proposal.proposal), NO_DELTA),
      );
      const committed = await rig.peer.call<CommitResult>('commit_pending', {
        client: o.client,
        group: room.key,
      });
      await s.refusal(
        'commit that Adds the stored proposal BY REFERENCE',
        MlsEngineErrorCode.PROPOSAL_BY_REFERENCE_FORBIDDEN,
        () => processAt(rig, before, fromBase64(committed.commit), deltaOf([theirs(o2)], [])),
      );
      expect(rig.engine.epoch(before)).toBe(rig.engine.epoch(room.stateOf(a.deviceId)));
      await rig.engine.encrypt(before, utf8('still usable'));
      s.pass(
        'the refused commits cost nothing: our state is the one we had',
        'epoch unchanged, can still send',
      );
    },
  );

  scenario(
    'C2',
    'an external join (external commit from a GroupInfo) is refused',
    async (s, rig) => {
      const { room, a, o } = await pairRoom(rig, 'c2');
      const joiner = await rig.openmls({ userId: 'dave', deviceId: 'o-c2b', role: USER });
      const info = await rig.peer.call<{ groupInfo: string }>('export_group_info', {
        client: o.client,
        group: room.key,
        with_ratchet_tree: true,
      });
      const joined = await rig.peer.attempt<CommitResult>('external_join', {
        client: joiner.client,
        group_info: info.groupInfo,
      });
      if (!joined.ok) {
        s.notTriggerable('external commit', `OpenMLS refused to build it: ${joined.error}`);
        return;
      }
      const commit = fromBase64(joined.result.commit);
      // MLSMessage = u16 version | u16 wire_format (1 PublicMessage, 2 PrivateMessage) | ...
      expect([commit[2], commit[3]]).toEqual([0, 1]);
      s.pass(
        'OpenMLS can export a GroupInfo and join from it',
        'external commit is a PublicMessage',
      );
      await s.refusal(
        'external commit (sender: new member)',
        MlsEngineErrorCode.EXTERNAL_SENDER_FORBIDDEN,
        () => processAt(rig, room.stateOf(a.deviceId), commit, deltaOf([theirs(joiner)], [])),
      );
    },
  );

  scenario('C3', 'a commit without an UpdatePath where RFC 9420 requires one', async (s, rig) => {
    // `o` commits; `observer` is a second OpenMLS member that reports whether a commit had a path.
    const { room, o } = await pairRoom(rig, 'c3');
    const observer = await rig.openmls({ userId: 'carol', deviceId: 'o-c3b', role: USER });
    const victim = await rig.openmls({ userId: 'dave', deviceId: 'o-c3c', role: USER });
    const committer = o.identity.deviceId;
    await room.add(committer, [theirs(observer)]);

    const add = await room.add(committer, [theirs(victim)], { forcePath: false });
    expect(add.hasUpdatePath).toBe(false);
    s.pass(
      'an Add-only commit WITHOUT an UpdatePath is legal: OpenMLS sends one, our engine accepts it',
      'hasUpdatePath=false',
    );

    const remove = await room.remove(committer, [victim.identity.deviceId]);
    const empty = await rig.peer.attempt<CommitResult>('commit_pending', {
      client: o.client,
      group: room.key,
    });
    let emptyPath: boolean | undefined;
    if (empty.ok) {
      const report = await room.deliver(fromBase64(empty.result.commit), NO_DELTA, committer);
      emptyPath = report.hasUpdatePath;
      s.pass(
        'an OpenMLS commit with no proposals (UpdatePath only) is accepted',
        `hasUpdatePath=${String(emptyPath)}`,
      );
    } else {
      s.notTriggerable('OpenMLS commit with no proposals', empty.error);
    }
    const update = await room.selfUpdate(committer);
    const observed = `Remove: hasUpdatePath=${String(remove.hasUpdatePath)}; empty commit: ${String(emptyPath)}; self-update: ${String(update.hasUpdatePath)}`;
    if (remove.hasUpdatePath === true && emptyPath !== false && update.hasUpdatePath === true) {
      s.notTriggerable(
        'Remove or empty commit WITHOUT an UpdatePath',
        `stock OpenMLS 0.9.1 attaches the path whenever RFC 9420 §12.4 requires it, and its CommitBuilder has no switch to omit one. ${observed}`,
      );
    } else {
      s.fail('OpenMLS attaches the path wherever one is required', 'hasUpdatePath=true', observed);
    }
    await room.expectConverged();
  });

  const GCE_VARIANTS: readonly {
    readonly name: string;
    readonly extensions: (conversationId: string) => { type: number; data: string }[];
  }[] = [
    {
      name: 'changes the conversation id',
      extensions: () => [conversationExtension('conv-other')],
    },
    {
      name: 'restates the same conversation id',
      extensions: (conversationId) => [conversationExtension(conversationId)],
    },
    {
      name: 'adds an unknown extension (0xf0c2)',
      extensions: (conversationId) => [
        conversationExtension(conversationId),
        { type: 0xf0c2, data: toBase64(Uint8Array.of(1)) },
      ],
    },
    { name: 'drops every extension', extensions: () => [] },
  ];

  scenario('C4', 'GroupContextExtensions proposals are refused', async (s, rig) => {
    for (const [i, variant] of GCE_VARIANTS.entries()) {
      const { room, a, o, conversationId } = await pairRoom(rig, `c4-${String(i)}`);
      const made = await rig.peer.attempt<CommitResult>('propose_gce', {
        client: o.client,
        group: room.key,
        gc_extensions: variant.extensions(conversationId),
      });
      const name = `GCE commit that ${variant.name}`;
      if (!made.ok) {
        s.notTriggerable(name, `OpenMLS refused to build it: ${made.error}`);
        continue;
      }
      await s.refusal(name, MlsEngineErrorCode.PROPOSAL_NOT_ALLOWED, () =>
        processAt(rig, room.stateOf(a.deviceId), fromBase64(made.result.commit), NO_DELTA),
      );
    }
  });

  scenario(
    'C5',
    'a PublicMessage commit and a PublicMessage proposal are refused',
    async (s, rig) => {
      const o = await rig.openmls({ userId: 'alice', deviceId: 'o-c5', role: USER });
      const b = await rig.ours('bob', 'b-c5');
      const room = await MixedRoom.createOpenMls(rig, o, 'conv-c5', { wireFormat: 'plaintext' });
      // Our commits are PrivateMessages, which this group's policy would refuse: no newcomer update.
      await room.add('o-c5', [ours(b)], { selfUpdate: false });
      const before = room.stateOf('b-c5');
      s.pass('our engine joins a group whose OpenMLS policy is plaintext handshakes');

      const o2 = await rig.openmls({ userId: 'carol', deviceId: 'o-c5b', role: USER });
      const proposal = await rig.peer.call<{ proposal: string }>('propose_add', {
        client: o.client,
        group: room.key,
        key_package: toBase64(await rig.keyPackage(o2)),
      });
      const proposalBytes = fromBase64(proposal.proposal);
      expect([proposalBytes[2], proposalBytes[3]]).toEqual([0, 1]);
      await s.refusal(
        'PublicMessage Add proposal',
        MlsEngineErrorCode.STANDALONE_PROPOSAL_FORBIDDEN,
        () => processAt(rig, before, proposalBytes, NO_DELTA),
      );

      const update = await rig.peer.call<CommitResult>('self_update', {
        client: o.client,
        group: room.key,
      });
      const commit = fromBase64(update.commit);
      expect([commit[2], commit[3]]).toEqual([0, 1]);
      await s.refusal('PublicMessage commit', MlsEngineErrorCode.UNEXPECTED_MESSAGE_KIND, () =>
        processAt(rig, before, commit, NO_DELTA),
      );
    },
  );

  scenario(
    'C6',
    'application messages not bound to the conversation are refused',
    async (s, rig) => {
      const { room, a, o, conversationId } = await pairRoom(rig, 'c6');
      const state = room.stateOf(a.deviceId);
      const sealAs = async (aad: Uint8Array): Promise<Uint8Array> => {
        const sealed = await rig.peer.call<{ ciphertext: string }>('encrypt', {
          client: o.client,
          group: room.key,
          plaintext: toBase64(utf8('probe')),
          aad: toBase64(aad),
        });
        return fromBase64(sealed.ciphertext);
      };
      const id = utf8(conversationId);
      const extra = utf8('abc');

      await s.refusal('no AAD at all', MlsEngineErrorCode.AAD_MISMATCH, async () =>
        rig.engine.decrypt(state, await sealAs(new Uint8Array())),
      );
      await s.refusal(
        'AAD framed for another conversation',
        MlsEngineErrorCode.AAD_MISMATCH,
        async () => rig.engine.decrypt(state, await sealAs(aadFrame('conv-other', extra))),
      );
      await s.refusal(
        'the right id without the length byte',
        MlsEngineErrorCode.AAD_MISMATCH,
        async () => rig.engine.decrypt(state, await sealAs(id)),
      );
      await s.refusal(
        'an id that merely starts with ours',
        MlsEngineErrorCode.AAD_MISMATCH,
        async () => rig.engine.decrypt(state, await sealAs(aadFrame(`${conversationId}x`, extra))),
      );
      await s.refusal(
        'the right frame, a different extra than the receiver expects',
        MlsEngineErrorCode.AAD_MISMATCH,
        async () =>
          rig.engine.decrypt(state, await sealAs(aadFrame(conversationId, extra)), utf8('abd')),
      );
      await s.accepted('the right frame with the expected extra', async () => {
        const opened = await rig.engine.decrypt(
          state,
          await sealAs(aadFrame(conversationId, extra)),
          extra,
        );
        expect(opened.aad).toEqual(extra);
      });
      await s.accepted(
        'the right frame, no extra expected: the receiver gets it back',
        async () => {
          const opened = await rig.engine.decrypt(
            state,
            await sealAs(aadFrame(conversationId, extra)),
          );
          expect(opened.aad).toEqual(extra);
        },
      );
    },
  );

  interface KeyPackageVariant {
    readonly name: string;
    /** The code our engine must answer with, on `add` (send side) and on `processCommit` (receive side). */
    readonly code: MlsEngineErrorCode;
    readonly role?: DeviceRole;
    readonly device?: (identity: DeviceIdentity) => OpenMlsDeviceOptions;
    readonly keyPackage?: KeyPackageOptions;
    /** The credential decodes, so a served member delta can name the device. */
    readonly decodable?: boolean;
  }

  const OTHER_KEY = Uint8Array.from({ length: 32 }, (_, i) => i + 1);

  const KEY_PACKAGE_VARIANTS: readonly KeyPackageVariant[] = [
    {
      name: 'leaf capabilities do not list the conversation extension 0xf0c1',
      code: MlsEngineErrorCode.UNSUPPORTED_EXTENSION,
      keyPackage: { capabilityExtensions: [] },
      decodable: true,
    },
    {
      name: 'leaf carries an extension (0xf0c2, listed in its capabilities)',
      code: MlsEngineErrorCode.UNSUPPORTED_EXTENSION,
      keyPackage: {
        capabilityExtensions: [CONVERSATION_EXTENSION_TYPE, 0xf0c2],
        leafExtensions: [{ type: 0xf0c2, data: Uint8Array.of(1, 2, 3) }],
      },
      decodable: true,
    },
    {
      name: 'cipher suite 2 (P-256), not the pinned suite 1',
      code: MlsEngineErrorCode.SUITE_NOT_PINNED,
      device: () => ({ ciphersuite: 2 }),
      decodable: true,
    },
    {
      name: 'KeyPackage valid for 100 days (the horizon is 90)',
      code: MlsEngineErrorCode.LIFETIME_OUT_OF_RANGE,
      keyPackage: { lifetimeSeconds: 100 * 24 * 60 * 60 },
      decodable: true,
    },
    {
      name: 'credential: three arbitrary bytes',
      code: MlsEngineErrorCode.CREDENTIAL_INVALID,
      device: () => ({ credential: Uint8Array.of(1, 2, 3) }),
    },
    {
      name: 'credential: canonical bytes plus one trailing byte',
      code: MlsEngineErrorCode.CREDENTIAL_INVALID,
      device: (identity) => ({ credential: Uint8Array.of(...credentialBytes(identity), 0) }),
    },
    {
      name: 'credential: unknown role code 9',
      code: MlsEngineErrorCode.CREDENTIAL_INVALID,
      device: (identity) => {
        const bytes = Uint8Array.from(credentialBytes(identity));
        bytes[1] = 9;
        return { credential: bytes };
      },
    },
    {
      name: 'credential: layout version 2',
      code: MlsEngineErrorCode.CREDENTIAL_INVALID,
      device: (identity) => {
        const bytes = Uint8Array.from(credentialBytes(identity));
        bytes[0] = 2;
        return { credential: bytes };
      },
    },
    {
      name: 'credential: a device id outside the id alphabet',
      code: MlsEngineErrorCode.CREDENTIAL_INVALID,
      device: (identity) => ({
        credential: credentialBytes({ ...identity, deviceId: 'bad id!' }),
      }),
    },
    {
      name: 'the device is not on its owner signed list',
      code: MlsEngineErrorCode.LEAF_NOT_IN_SIGNED_LIST,
      device: () => ({ listed: false }),
      decodable: true,
    },
    {
      name: 'the list pins another signature key for that device',
      code: MlsEngineErrorCode.LEAF_NOT_IN_SIGNED_LIST,
      device: () => ({ listedKey: OTHER_KEY }),
      decodable: true,
    },
    {
      name: 'the list says GUARDIAN, the credential says USER',
      code: MlsEngineErrorCode.LEAF_NOT_IN_SIGNED_LIST,
      device: () => ({ listedRole: DeviceRole.GUARDIAN }),
      decodable: true,
    },
    {
      name: 'an ASSISTANT credential whose list entry names no conversation',
      code: MlsEngineErrorCode.LEAF_NOT_IN_SIGNED_LIST,
      role: DeviceRole.ASSISTANT,
      decodable: true,
    },
  ];

  scenario(
    'C7',
    'KeyPackages and leaves our rules refuse: send side and receive side',
    async (s, rig) => {
      for (const [i, variant] of KEY_PACKAGE_VARIANTS.entries()) {
        const tag = `c7-${String(i)}`;
        const { room, a, o } = await pairRoom(rig, tag);
        const identity: DeviceIdentity = {
          userId: 'mallory',
          deviceId: `m-${tag}`,
          role: variant.role ?? USER,
        };
        const bad = await rig.openmls(identity, variant.device?.(identity) ?? {});
        const made = await rig.peer.attempt<{ keyPackage: string }>(
          'key_package',
          keyPackageArgs(bad, variant.keyPackage ?? {}),
        );
        if (!made.ok) {
          s.notTriggerable(
            `${variant.name}`,
            `OpenMLS refused to build the KeyPackage: ${made.error}`,
          );
          continue;
        }
        const keyPackage = fromBase64(made.result.keyPackage);
        const state = room.stateOf(a.deviceId);
        await s.refusal(`send side, ${variant.name}`, variant.code, () =>
          rig.engine.add({ state, keyPackages: [keyPackage] }),
        );

        // Receive side: an OpenMLS member of our room commits the Add; its own checks come first.
        const committed = await rig.peer.attempt<CommitResult>('add', {
          client: o.client,
          group: room.key,
          key_packages: [made.result.keyPackage],
        });
        if (!committed.ok) {
          s.notTriggerable(
            `receive side, ${variant.name}`,
            `OpenMLS refused to commit it: ${committed.error}`,
          );
          continue;
        }
        const delta = variant.decodable === true ? deltaOf([theirs(bad)], []) : NO_DELTA;
        await s.refusal(`receive side, ${variant.name}`, variant.code, () =>
          processAt(rig, state, fromBase64(committed.result.commit), delta),
        );
      }
    },
  );

  scenario('C8', 'Welcomes our engine refuses (OpenMLS-created groups)', async (s, rig) => {
    const WELCOME_VARIANTS: readonly {
      readonly name: string;
      readonly code: MlsEngineErrorCode | readonly MlsEngineErrorCode[];
      readonly group?: GroupOptions;
      readonly creator?: OpenMlsDeviceOptions;
      readonly join?: (welcome: Welcome) => {
        expectedConversationId?: string;
        expectedGroupId?: Uint8Array;
        expectedEpoch?: bigint;
      };
      /** Worth writing down: recorded when our engine answers with `when` (any refusal if omitted). */
      readonly finding?: { readonly text: string; readonly when?: MlsEngineErrorCode };
    }[] = [
      {
        name: 'the host expects another conversation',
        code: MlsEngineErrorCode.CONVERSATION_MISMATCH,
        join: () => ({ expectedConversationId: 'conv-other' }),
      },
      {
        name: 'the host expects another group id',
        code: MlsEngineErrorCode.GROUP_MISMATCH,
        join: () => ({ expectedGroupId: Uint8Array.of(1, 2, 3) }),
      },
      {
        name: 'the host expects another epoch',
        code: MlsEngineErrorCode.EPOCH_MISMATCH,
        join: (welcome) => ({ expectedEpoch: welcome.epoch + 1n }),
      },
      {
        name: 'the GroupContext carries no conversation extension',
        code: MlsEngineErrorCode.UNSUPPORTED_EXTENSION,
        group: { gcExtensions: [] },
      },
      {
        name: 'the GroupContext carries a second extension (0xf0c2)',
        code: MlsEngineErrorCode.UNSUPPORTED_EXTENSION,
        group: {
          gcExtensions: 'with-unknown',
          capabilityExtensions: [CONVERSATION_EXTENSION_TYPE, 0xf0c2],
        },
      },
      {
        name: 'the conversation id in the GroupContext is not a valid id',
        code: MlsEngineErrorCode.CONVERSATION_MISMATCH,
        group: { gcExtensions: 'bad-id' },
      },
      {
        name: 'the creator credential is not canonical',
        code: [MlsEngineErrorCode.CREDENTIAL_INVALID, MlsEngineErrorCode.LIBRARY_REJECTED],
        creator: { credential: Uint8Array.of(9, 9) },
        finding: {
          when: MlsEngineErrorCode.LIBRARY_REJECTED,
          text: 'Welcome path: a creator leaf with a non-canonical credential is refused, but by the ts-mls credential hook (LIBRARY_REJECTED, "Could not validate credential") before our validator can name it CREDENTIAL_INVALID. Commits get the precise code (C7). Cosmetic: the host cannot branch on CREDENTIAL_INVALID at join time.',
        },
      },
      {
        name: 'the creator is not on its owner signed list',
        code: MlsEngineErrorCode.LEAF_NOT_IN_SIGNED_LIST,
        creator: { listed: false },
      },
      {
        name: 'no ratchet_tree extension in the GroupInfo (the OpenMLS default)',
        code: [
          MlsEngineErrorCode.MALFORMED_MESSAGE,
          MlsEngineErrorCode.LIBRARY_REJECTED,
          MlsEngineErrorCode.WELCOME_TREE_MISMATCH,
        ],
        group: { ratchetTreeExtension: false },
        finding: {
          text: 'OpenMLS creates groups WITHOUT the ratchet_tree extension unless told otherwise (MlsGroupCreateConfig default); our engine has no way to take a tree out of band, so an OpenMLS peer must enable use_ratchet_tree_extension.',
        },
      },
    ];

    for (const [i, variant] of WELCOME_VARIANTS.entries()) {
      const tag = `c8-${String(i)}`;
      const bob = await rig.ours('bob', `b-${tag}`);
      const conversationId = `conv-${tag}`;
      const made = await openMlsWelcome(
        rig,
        tag,
        bob,
        conversationId,
        variant.group ?? {},
        variant.creator ?? {},
      );
      if ('refusedAt' in made) {
        s.notTriggerable(`${variant.name}`, `OpenMLS refused at ${made.refusedAt}: ${made.error}`);
        continue;
      }
      const override = variant.join?.(made) ?? {};
      const code = await s.refusal(variant.name, variant.code, () =>
        rig.engine.joinFromWelcome({
          welcome: made.welcome,
          keyPackagePrivate: made.secret,
          expectedConversationId: override.expectedConversationId ?? conversationId,
          expectedGroupId: override.expectedGroupId ?? made.groupId,
          expectedEpoch: override.expectedEpoch ?? made.epoch,
        }),
      );
      if (
        variant.finding !== undefined &&
        code !== undefined &&
        (variant.finding.when === undefined || variant.finding.when === code)
      ) {
        log.finding(variant.finding.text);
      }
    }
    // The control: the same helper with nothing wrong is accepted.
    const bob = await rig.ours('bob', 'b-c8-ok');
    const ok = await openMlsWelcome(rig, 'c8-ok', bob, 'conv-c8-ok', {}, {});
    if ('refusedAt' in ok)
      throw new Error(`the control Welcome failed at ${ok.refusedAt}: ${ok.error}`);
    await s.accepted('control: an unmodified OpenMLS Welcome', () =>
      rig.engine.joinFromWelcome({
        welcome: ok.welcome,
        keyPackagePrivate: ok.secret,
        expectedConversationId: 'conv-c8-ok',
        expectedGroupId: ok.groupId,
        expectedEpoch: ok.epoch,
      }),
    );
  });

  scenario('C9', 'GREASE values in OpenMLS capabilities', async (s, rig) => {
    const { room, a } = await pairRoom(rig, 'c9');
    const greasy = await rig.openmls({ userId: 'carol', deviceId: 'o-c9g', role: USER });
    const keyPackage = await rig.keyPackage(greasy, { grease: true });
    s.note(
      'OpenMLS only adds GREASE when asked (Capabilities::with_grease); the default builder does not.',
    );
    const added = await rig.engine
      .add({ state: room.stateOf(a.deviceId), keyPackages: [keyPackage] })
      .then(
        (result) => {
          s.pass('our Add of a KeyPackage whose capabilities carry GREASE', 'accepted');
          return result;
        },
        (error: unknown) => {
          s.fail(
            'our Add of a KeyPackage whose capabilities carry GREASE',
            'accepted',
            describeError(error),
          );
          return undefined;
        },
      );
    if (added !== undefined) {
      await s.accepted('OpenMLS joins from that Welcome', async () => {
        await rig.peer.call('join', { client: greasy.client, welcome: toBase64(added.welcome) });
      });
    }

    const bob = await rig.ours('bob', 'b-c9');
    const o = await rig.openmls({ userId: 'dave', deviceId: 'o-c9c', role: USER });
    const group = await MixedRoom.createOpenMls(rig, o, 'conv-c9b', { grease: true });
    await s.accepted(
      'our join into a group whose creator leaf carries GREASE capabilities',
      async () => {
        await group.add('o-c9c', [ours(bob)]);
        await group.expectConverged();
        await chat(group, ['o-c9c', 'b-c9']);
      },
    );
  });

  scenario(
    'C10',
    'family policy: commits OpenMLS makes freely that the guardian and Masia rules forbid',
    async (s, rig) => {
      // A GUARDIAN leaf is removable only by an admin of that child.
      for (const admin of [false, true]) {
        const tag = admin ? 'c10-ga' : 'c10-gp';
        const child = admin ? 'kid-a' : 'kid-p';
        if (admin) rig.world.makeAdmin('bob', child);
        const { room, a, o } = await pairRoom(rig, tag);
        const guardian = await rig.openmls({
          userId: child,
          deviceId: `g-${tag}`,
          role: DeviceRole.GUARDIAN,
        });
        await room.add(a.deviceId, [theirs(guardian)]);
        const leaf = await room.leafIndexOf(guardian.identity.deviceId);
        const commit = await rig.peer.call<CommitResult>('remove', {
          client: o.client,
          group: room.key,
          leaf_indexes: [leaf],
        });
        const state = room.stateOf(a.deviceId);
        const delta: MemberDelta = { added: [], removed: [guardian.identity.deviceId] };
        if (admin) {
          await s.accepted('an admin of the child removes its GUARDIAN leaf', () =>
            processAt(rig, state, fromBase64(commit.commit), delta),
          );
        } else {
          await s.refusal(
            'a member who is not an admin of the child removes its GUARDIAN leaf',
            MlsEngineErrorCode.GUARDIAN_REMOVE_FORBIDDEN,
            () => processAt(rig, state, fromBase64(commit.commit), delta),
          );
        }
      }

      // An ASSISTANT leaf joins a room with a minor only by an admin's hand.
      for (const admin of [false, true]) {
        const tag = admin ? 'c10-ma' : 'c10-mp';
        const child = admin ? 'kid-q' : 'kid-r';
        rig.world.makeMinor(child);
        if (admin) rig.world.makeAdmin('bob', child);
        const { room, a, o, conversationId } = await pairRoom(rig, tag);
        const kid = await rig.openmls({ userId: child, deviceId: `k-${tag}`, role: USER });
        await room.add(a.deviceId, [theirs(kid)]);
        const masia = await rig.openmls(
          { userId: 'masia', deviceId: `ms-${tag}`, role: DeviceRole.ASSISTANT },
          { listedConversationId: conversationId },
        );
        const commit = await rig.peer.call<CommitResult>('add', {
          client: o.client,
          group: room.key,
          key_packages: [toBase64(await rig.keyPackage(masia))],
        });
        const state = room.stateOf(a.deviceId);
        const delta = deltaOf([theirs(masia)], []);
        if (admin) {
          await s.accepted('an admin of the child adds the Masia leaf', () =>
            processAt(rig, state, fromBase64(commit.commit), delta),
          );
        } else {
          await s.refusal(
            'a member who is not an admin of the child adds an ASSISTANT leaf to its room',
            MlsEngineErrorCode.ASSISTANT_ADD_FORBIDDEN,
            () => processAt(rig, state, fromBase64(commit.commit), delta),
          );
        }
      }
    },
  );

  // --- A tree shape found by the sequences below -------------------------------------------------

  scenario(
    'K1',
    'unmerged leaf under a node whose ancestor was refreshed from the other half of the tree',
    async (s, rig) => {
      const who = async (
        kind: 'ours' | 'openmls',
        prefix: string,
        count: number,
      ): Promise<Party[]> => {
        const parties: Party[] = [];
        for (let i = 0; i < count; i += 1) {
          const userId = `${prefix}${String(i)}`;
          parties.push(
            kind === 'ours'
              ? ours(await rig.ours(userId, `${prefix}${String(i)}`))
              : theirs(
                  await rig.openmls({ userId, deviceId: `${prefix}${String(i)}`, role: USER }),
                ),
          );
        }
        return parties;
      };
      const four = (parties: readonly Party[]): [Party, Party, Party, Party] => {
        const [b, c, d, e] = parties;
        if (b === undefined || c === undefined || d === undefined || e === undefined) {
          throw new Error('need four members');
        }
        return [b, c, d, e];
      };
      const first = async (kind: 'ours' | 'openmls', prefix: string): Promise<Party> => {
        const [party] = await who(kind, prefix, 1);
        if (party === undefined) throw new Error('no party');
        return party;
      };
      const room = async (creator: Party, id: string): Promise<MixedRoom> =>
        isOurs(creator)
          ? MixedRoom.createOurs(rig, creator.device, id)
          : MixedRoom.createOpenMls(rig, creator.device, id);

      // Everything is ours: the engine cannot take the next member into a tree it made itself.
      const a = await first('ours', 'a');
      const roomA = await room(a, 'conv-k1a');
      await buildUnmergedShape(roomA, idOf(a), four(await who('ours', 'b', 4)));
      const f1 = (await who('ours', 'f', 1))[0];
      if (f1 === undefined) throw new Error('no party');
      await s.accepted('engine group (tree made by the engine), engine joiner', () =>
        roomA.add(idOf(a), [f1]),
      );

      // The tree is made by OpenMLS; our device is the one that joins.
      const o = await first('openmls', 'o');
      const roomB = await room(o, 'conv-k1b');
      await buildUnmergedShape(roomB, idOf(o), four(await who('openmls', 'q', 4)));
      const f2 = (await who('ours', 'g', 1))[0];
      if (f2 === undefined) throw new Error('no party');
      await s.accepted('OpenMLS group (tree made by OpenMLS), engine joiner', () =>
        roomB.add(idOf(o), [f2]),
      );

      // The same shape, made by the engine, joined by OpenMLS: OpenMLS accepts the tree.
      const c = await first('ours', 'c');
      const roomC = await room(c, 'conv-k1c');
      await buildUnmergedShape(roomC, idOf(c), four(await who('ours', 'd', 4)));
      const f3 = (await who('openmls', 'h', 1))[0];
      if (f3 === undefined) throw new Error('no party');
      await s.accepted('engine group (tree made by the engine), OpenMLS joiner', () =>
        roomC.add(idOf(c), [f3]),
      );
      if (s.failures().length > 0) {
        log.finding(
          'F1 ts-mls 1.6.4 refuses to join a valid tree: validateRatchetTree requires every non-blank node on the whole direct path of an unmerged leaf to carry the SAME unmerged_leaves list as the node that names the leaf. RFC 9420 section 12.4.3.1 only asks that the non-blank nodes BETWEEN the leaf and that node list it. A root refreshed by an UpdatePath from the other half of the tree clears the root list and is legal. The failure is not specific to OpenMLS: a group made and joined only by our engine hits it (K1 first check); OpenMLS accepts the same tree (K1 third check). Effect: in a room with more than 4 devices an Add can leave the newcomer unable to join.',
        );
      }
    },
  );

  // --- Long, seeded, mixed sequences ------------------------------------------------------------

  scenario(
    'S1',
    'seeded random sequences over a pool of 5 engine and 5 OpenMLS devices',
    async (s, rig) => {
      const pool: Party[] = [];
      for (let i = 0; i < SEQUENCE_POOL; i += 1) {
        pool.push(ours(await rig.ours(`user${String(i)}`, `p${String(i)}`)));
        pool.push(
          theirs(
            await rig.openmls({
              userId: `user${String(i)}`,
              deviceId: `q${String(i)}`,
              role: USER,
            }),
          ),
        );
      }
      for (const seed of SEQUENCE_SEEDS) {
        const trail: string[] = [];
        try {
          await runSequence(rig, pool, seed, trail);
          s.pass(`seed ${String(seed)}`, `${String(SEQUENCE_STEPS)} steps: ${trail.join('; ')}`);
        } catch (error) {
          const message = describeError(error);
          // Seed 11 is the witness for finding F1 (K1 is its minimal form). Green since the pinned
          // ts-mls patch (until 2026-10-10 this comment said it stays red); the label below explains
          // a failure if the patch is ever lost.
          const known = message.includes('unmerged_leaves')
            ? ' [finding F1, minimal case: K1]'
            : '';
          s.fail(
            `seed ${String(seed)}`,
            'all steps agree',
            `${message}${known} after: ${trail.join('; ')}`,
          );
        }
      }
    },
  );
});
