import { describe, expect, it } from 'vitest';
import {
  MAX_HANDSHAKE_BYTES,
  PENDING_COMMIT_FORMAT_VERSION,
  STATE_FORMAT_VERSION,
} from '../constants.js';
import type { GroupState, MlsEngine, PendingCommit } from '../mls-engine.js';
import { MlsEngineErrorCode } from '../mls-error.js';
import { expectCode } from './support/expect-code.js';
import { buildRoom, EMPTY_DELTA, must, pair, trio } from './support/fixtures.js';
import type { ContractSubject } from './support/subject.js';
import { TestWorld } from './support/world.js';

/**
 * OWN-COMMIT CONTRACT: a commit this device built survives a lost acknowledgement (canon §9.7).
 *
 * The host's side, which these tests act out: store the current state and the `pendingCommit`
 * together BEFORE posting the commit; on an acknowledgement adopt `result.state`; after a restart,
 * a timeout or a 409, fetch the commit the relay holds for that epoch and ask
 * `adoptPendingCommit`. "Adopted" means the relay holds exactly our bytes and the state moves to
 * the result we built; "not adopted" means another commit won, so the host drops the pending
 * commit and processes the winner like any other member's commit.
 *
 * The engine's stored formats are versioned: bytes another build wrote are
 * `STATE_VERSION_UNSUPPORTED` (keep them; a matching build reads them), never `STATE_CORRUPT`.
 */

/** What the host keeps in its store across a restart: bytes only. */
interface StoredBeforePosting {
  readonly state: Uint8Array;
  readonly pending: Uint8Array;
}

function store(engine: MlsEngine, state: GroupState, pending: PendingCommit): StoredBeforePosting {
  return { state: engine.encodeState(state), pending: engine.encodePendingCommit(pending) };
}

/** `bytes` with the leading format-version byte replaced. */
function withVersion(bytes: Uint8Array, version: number): Uint8Array {
  const out = Uint8Array.from(bytes);
  out[0] = version;
  return out;
}

export function definePendingCommitContract(subject: ContractSubject): void {
  const newWorld = () => TestWorld.create(subject.factory);
  /** The same world after a restart: a fresh engine instance, nothing in memory but the store. */
  const restarted = (world: TestWorld) => subject.factory(world.context);

  describe(`${subject.name}: own commits across a lost acknowledgement`, () => {
    it('a lost acknowledgement, then a restart: the relay holds our commit, so it is adopted', async () => {
      const world = await newWorld();
      const { room, devices } = await buildRoom(world, 3);
      const [alice, bob] = pair(devices);
      const built = await world.engine.selfUpdate(room.state(alice));
      const stored = store(world.engine, room.state(alice), built.pendingCommit);

      // The relay accepts and fans the commit out; alice's acknowledgement never arrives.
      await room.deliver(built.commit, EMPTY_DELTA, [alice]);

      const engine = await restarted(world);
      const state = engine.decodeState(stored.state);
      const pending = engine.decodePendingCommit(stored.pending);
      const resolved = await engine.adoptPendingCommit(state, pending, built.commit);
      if (!resolved.adopted) throw new Error('our own commit was not adopted');
      room.states.set(alice.deviceId, resolved.state);
      room.expectConverged();

      // The group goes on: alice can talk and follow the next commit.
      await room.send(alice, 'after the restart');
      await room.selfUpdate(bob);
      room.expectConverged();
    });

    it('an Add whose acknowledgement was lost is adopted, and the newcomer joins the same epoch', async () => {
      const world = await newWorld();
      const { engine } = world;
      const { room, devices } = await buildRoom(world, 2);
      const [alice] = pair(devices);
      const dave = await world.device('dave', 'd1');
      const bundle = await engine.createKeyPackage(dave.keys);
      const before = room.state(alice);
      const added = await engine.add({ state: before, keyPackages: [bundle.keyPackage] });
      await room.deliver(added.commit, added.memberDelta, [alice]);

      const resolved = await engine.adoptPendingCommit(before, added.pendingCommit, added.commit);
      if (!resolved.adopted) throw new Error('our own Add was not adopted');
      const joined = await engine.joinFromWelcome({
        welcome: added.welcome,
        keyPackagePrivate: bundle.keyPackagePrivate,
        expectedConversationId: 'conv-1',
        expectedGroupId: engine.groupId(before),
        expectedEpoch: engine.epoch(resolved.state),
      });
      expect(engine.epochAuthenticator(joined.state)).toEqual(
        engine.epochAuthenticator(resolved.state),
      );
    });

    it('a 409: another commit won the epoch, so ours is not adopted and the winner is processed', async () => {
      const world = await newWorld();
      const { engine } = world;
      const { room, devices } = await buildRoom(world, 3);
      const [alice, bob] = pair(devices);
      const ours = await engine.selfUpdate(room.state(alice));
      const theirs = await engine.selfUpdate(room.state(bob));
      // The relay took bob's commit for this epoch and answered alice with a conflict.
      await room.deliver(theirs.commit, EMPTY_DELTA, [alice, bob]);
      room.states.set(bob.deviceId, theirs.state);

      const resolved = await engine.adoptPendingCommit(
        room.state(alice),
        ours.pendingCommit,
        theirs.commit,
      );
      expect(resolved).toEqual({ adopted: false });
      const processed = await engine.processCommit({
        state: room.state(alice),
        commit: theirs.commit,
        servedMemberDelta: EMPTY_DELTA,
      });
      room.states.set(alice.deviceId, processed.state);
      room.expectConverged();
    });

    it('is idempotent and never moves a state sideways', async () => {
      const world = await newWorld();
      const { engine } = world;
      const { room, devices } = await buildRoom(world, 3);
      const [alice, bob, carol] = trio(devices);
      const before = room.state(alice);
      const built = await engine.selfUpdate(before);

      // Already adopted (the host saved the new state but not the deletion of the pending commit).
      const again = await engine.adoptPendingCommit(built.state, built.pendingCommit, built.commit);
      if (!again.adopted) throw new Error('an adopted commit was not recognised');
      expect(engine.epochAuthenticator(again.state)).toEqual(
        engine.epochAuthenticator(built.state),
      );

      // A pending commit from an older epoch can never move the current state.
      const stale = await engine.selfUpdate(room.state(carol));
      await room.selfUpdate(bob);
      expect(
        await engine.adoptPendingCommit(room.state(carol), stale.pendingCommit, stale.commit),
      ).toEqual({ adopted: false });

      // Bytes that are not the commit we built are not ours, whatever they are.
      expect(
        await engine.adoptPendingCommit(before, built.pendingCommit, new Uint8Array([1, 2, 3])),
      ).toEqual({ adopted: false });
    });

    it('refuses what cannot be a question about this state', async () => {
      const world = await newWorld();
      const other = await newWorld();
      const { engine } = world;
      const { room, devices } = await buildRoom(world, 2);
      const { room: otherRoom, devices: otherDevices } = await buildRoom(other, 2);
      const alice = must(devices[0], 'alice');
      const elsewhere = await other.engine.selfUpdate(
        otherRoom.state(must(otherDevices[0], 'other device')),
      );
      const built = await engine.selfUpdate(room.state(alice));
      // A pending commit of another group: the host mixed its records up.
      await expectCode(
        () => engine.adoptPendingCommit(room.state(alice), elsewhere.pendingCommit, built.commit),
        MlsEngineErrorCode.INVALID_ARGUMENT,
      );
      await expectCode(
        () =>
          engine.adoptPendingCommit(
            room.state(alice),
            built.pendingCommit,
            new Uint8Array(MAX_HANDSHAKE_BYTES + 1),
          ),
        MlsEngineErrorCode.DECODE_TOO_LARGE,
      );
      await expectCode(
        () =>
          engine.adoptPendingCommit(
            room.state(alice),
            { kind: 'mls-pending-commit' },
            built.commit,
          ),
        MlsEngineErrorCode.INVALID_STATE,
      );
    });

    it('STATE_VERSION_UNSUPPORTED: a state or a pending commit from another build is kept, not called corrupt', async () => {
      const world = await newWorld();
      const { engine } = world;
      const { room, devices } = await buildRoom(world, 2);
      const alice = must(devices[0], 'alice');
      const built = await engine.selfUpdate(room.state(alice));
      const stored = store(engine, room.state(alice), built.pendingCommit);

      await expectCode(
        () => engine.decodeState(withVersion(stored.state, STATE_FORMAT_VERSION + 1)),
        MlsEngineErrorCode.STATE_VERSION_UNSUPPORTED,
      );
      await expectCode(
        () =>
          engine.decodePendingCommit(
            withVersion(stored.pending, PENDING_COMMIT_FORMAT_VERSION + 1),
          ),
        MlsEngineErrorCode.STATE_VERSION_UNSUPPORTED,
      );
      // Damage is still damage.
      await expectCode(
        () => engine.decodeState(stored.state.subarray(0, stored.state.length - 1)),
        MlsEngineErrorCode.STATE_CORRUPT,
      );
      await expectCode(
        () => engine.decodePendingCommit(stored.pending.subarray(0, stored.pending.length - 1)),
        MlsEngineErrorCode.STATE_CORRUPT,
      );
      // And the bytes this build wrote read back to the same thing.
      const pending = engine.decodePendingCommit(stored.pending);
      expect(engine.encodePendingCommit(pending)).toEqual(stored.pending);
    });
  });
}
