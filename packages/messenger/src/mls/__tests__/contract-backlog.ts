import { describe, expect, it } from 'vitest';
import { RELAY_BACKLOG_RETENTION_SECONDS } from '../constants.js';
import { MlsEngineErrorCode } from '../mls-engine.js';
import type { MemberDelta } from '../mls-engine.js';
import type { Adversary } from './support/adversary.js';
import { expectCode } from './support/expect-code.js';
import { buildRoom, EMPTY_DELTA, must, pair, trio } from './support/fixtures.js';
import { expectRefusedEverywhere } from './support/refused.js';
import type { Room } from './support/room.js';
import type { ContractSubject } from './support/subject.js';
import { TestWorld } from './support/world.js';
import type { TestDevice } from './support/world.js';

/**
 * BACKLOG CONTRACT (the engine code review and the KeyPackage window): a device that was offline replays
 * the commits it missed, in order, with `backlog: true`. Two things must hold at once:
 *  - the replay is NOT stalled by the present. A device that was added, used and removed, and has
 *    been revoked since, must not make the replay fail on the commit that added it; a KeyPackage
 *    that expired while the receiver slept must not either;
 *  - the replay is NOT a door. A device that was never on any verified list, a listing older than
 *    what the receiver already relied on, and a package dead for years are refused all the same.
 *
 * Needs an `Adversary` for the engine's library (it forges the Adds the engine would not send).
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_MS = RELAY_BACKLOG_RETENTION_SECONDS * 1000;
const STALE_DAYS = 45; // past the package's own 30 days AND past nothing the relay still holds
const YEARS_OLD_DAYS = 730;
const CLOCK_BACK_DAYS = 20;
const PACKAGE_LIFETIME_DAYS = 30;
const FAR_FUTURE_DAYS = 10;
const PACKAGE_DAYS_LEFT = 5;
const REPLAY_AFTER_DAYS = 15; // past the package's end, inside the relay's retention
const CLOCK_AHEAD_DAYS = 365;

interface Replayed {
  readonly commit: Uint8Array;
  readonly memberDelta: MemberDelta;
}

export function defineBacklogContract(subject: ContractSubject): void {
  const newWorld = () => TestWorld.create(subject.factory);
  const adversaryOf = (): Promise<Adversary> => must(subject.adversary, 'adversary')();

  /** Hands `backlog` to `receiver` in order, the way the host does after a long offline stretch. */
  async function replay(
    room: Room,
    receiver: TestDevice,
    backlog: readonly Replayed[],
    acceptedAtMs?: number,
  ): Promise<void> {
    let state = room.state(receiver);
    for (const entry of backlog) {
      const result = await room.world.engine.processCommit({
        state,
        commit: entry.commit,
        servedMemberDelta: entry.memberDelta,
        backlog: true,
        ...(acceptedAtMs === undefined ? {} : { acceptedAtMs }),
      });
      state = result.state;
    }
    room.states.set(receiver.deviceId, state);
  }

  describe.skipIf(subject.adversary === undefined)(`${subject.name}: backlog`, () => {
    // --- A device that came and went while the receiver slept -------------------------------------------------------------
    describe('a device added, used and removed while the receiver was offline (the engine code review)', () => {
      /** carol is offline while alice adds dave, dave updates, bob removes dave, and dave's phone is revoked. */
      async function offlineStretch() {
        const world = await newWorld();
        const { room, devices } = await buildRoom(world, 3);
        const [alice, bob, carol] = trio(devices);
        const dave = await world.device('dave', 'd1');
        const offline = [carol];
        const added = await room.add(alice, [dave], { selfUpdate: false, offline });
        const updated = await room.selfUpdate(dave, { offline });
        const removed = await room.remove(bob, [dave], { offline });
        world.unlist('dave', 'd1'); // the host learns the phone was revoked
        const backlog: Replayed[] = [
          { commit: added.commit, memberDelta: added.memberDelta },
          { commit: updated, memberDelta: EMPTY_DELTA },
          removed,
        ];
        return { world, room, alice, bob, carol, dave, backlog };
      }

      it('read live, the Add of a device that is revoked now stalls the receiver for good', async () => {
        const { world, room, carol, backlog } = await offlineStretch();
        const first = must(backlog[0], 'the Add');
        await expectCode(
          () =>
            world.engine.processCommit({
              state: room.state(carol),
              commit: first.commit,
              servedMemberDelta: first.memberDelta,
            }),
          MlsEngineErrorCode.LEAF_NOT_IN_SIGNED_LIST,
        );
      });

      it('read as backlog, the whole stretch is accepted and the receiver converges with everyone', async () => {
        const { world, room, alice, carol, backlog } = await offlineStretch();
        await replay(room, carol, backlog);
        expect(world.engine.epoch(room.state(carol))).toBe(world.engine.epoch(room.state(alice)));
        expect(world.engine.members(room.state(carol)).some((m) => m.userId === 'dave')).toBe(
          false,
        );
        room.expectConverged();
        // The group carries on: live commits, live messages, in both directions.
        await room.selfUpdate(carol);
        await room.send(alice, 'welcome back');
        await room.send(carol, 'caught up');
        room.expectConverged();
      });

      it('the backlog flag changes nothing for a commit that needs no history', async () => {
        const world = await newWorld();
        const { room, devices } = await buildRoom(world, 3);
        const [alice, bob, carol] = trio(devices);
        const update = await world.engine.selfUpdate(room.state(bob));
        room.states.set(bob.deviceId, update.state);
        await room.deliver(update.commit, EMPTY_DELTA, [bob, carol]);
        await replay(room, carol, [{ commit: update.commit, memberDelta: EMPTY_DELTA }]);
        room.expectConverged();
        expect(world.engine.epoch(room.state(alice))).toBe(world.engine.epoch(room.state(carol)));
      });
    });

    // --- Still not a door ------------------------------------------------------------------------------------------------------
    describe('the backlog is not a door (the engine code review)', () => {
      it('a device that was NEVER on any verified list is refused as backlog, after exactly one refresh', async () => {
        const world = await newWorld();
        const { engine } = world;
        const adversary = await adversaryOf();
        const { room, devices } = await buildRoom(world, 3);
        const [alice, bob, carol] = trio(devices);
        const ghost = await world.device('ghost', 'g1', undefined, { listed: false });
        const bundle = await engine.createKeyPackage(ghost.keys);
        const forged = await adversary.forceAdd(room.state(bob), [bundle.keyPackage]);
        world.refreshCalls.length = 0;
        await expectCode(
          () =>
            engine.processCommit({
              state: room.state(carol),
              commit: forged.commit,
              servedMemberDelta: forged.memberDelta,
              backlog: true,
            }),
          MlsEngineErrorCode.LEAF_NOT_IN_SIGNED_LIST,
        );
        expect(world.refreshCalls.filter((user) => user === 'ghost')).toHaveLength(1);
        await expectRefusedEverywhere(
          room,
          [alice, carol],
          forged.commit,
          MlsEngineErrorCode.LEAF_NOT_IN_SIGNED_LIST,
          forged.memberDelta,
          { backlog: true },
        );
      });

      it('a listing older than the version the receiver already relied on does not count, and the pin survives a saved state', async () => {
        const world = await newWorld();
        const { engine } = world;
        const adversary = await adversaryOf();
        const { room, devices } = await buildRoom(world, 3);
        const [alice, bob, carol] = trio(devices);
        // dave's first phone is listed (version 1), then replaced by a second one, and revoked.
        const oldPhone = await world.device('dave', 'd1');
        const oldBundle = await engine.createKeyPackage(oldPhone.keys);
        const newPhone = await world.device('dave', 'd2');
        world.unlist('dave', 'd1');
        // A receiver that has never relied on any list of dave's still finds d1 in version 1 ...
        const early = await adversary.forceAdd(room.state(bob), [oldBundle.keyPackage]);
        const accepted = await engine.processCommit({
          state: room.state(carol),
          commit: early.commit,
          servedMemberDelta: early.memberDelta,
          backlog: true,
        });
        expect(engine.epoch(accepted.state)).toBe(engine.epoch(room.state(carol)) + 1n);
        // ... until the group adds the second phone: from then on version 3 is the lowest it may rely on.
        await room.add(alice, [newPhone]);
        const late = await adversary.forceAdd(room.state(bob), [oldBundle.keyPackage]);
        await expectRefusedEverywhere(
          room,
          [alice, carol],
          late.commit,
          MlsEngineErrorCode.LEAF_NOT_IN_SIGNED_LIST,
          late.memberDelta,
          { backlog: true },
        );
        // The pin is part of the saved state: a device that restarts forgets nothing.
        const restored = engine.decodeState(engine.encodeState(room.state(carol)));
        room.states.set(carol.deviceId, restored);
        const again = await adversary.forceAdd(room.state(bob), [oldBundle.keyPackage]);
        await expectRefusedEverywhere(
          room,
          [carol],
          again.commit,
          MlsEngineErrorCode.LEAF_NOT_IN_SIGNED_LIST,
          again.memberDelta,
          { backlog: true },
        );
      });

      it('malformed hints from the host are refused, not guessed at', async () => {
        const world = await newWorld();
        const { room, devices } = await buildRoom(world, 3);
        const [, bob, carol] = trio(devices);
        const update = await world.engine.selfUpdate(room.state(bob));
        const attempt = (hint: object) =>
          world.engine.processCommit({
            state: room.state(carol),
            commit: update.commit,
            servedMemberDelta: EMPTY_DELTA,
            ...hint,
          });
        await expectCode(() => attempt({ backlog: 'yes' }), MlsEngineErrorCode.INVALID_ARGUMENT);
        await expectCode(
          () => attempt({ acceptedAtMs: Number.NaN }),
          MlsEngineErrorCode.INVALID_ARGUMENT,
        );
        await expectCode(
          () => attempt({ acceptedAtMs: '2026-01-01' }),
          MlsEngineErrorCode.INVALID_ARGUMENT,
        );
      });
    });

    // --- The host may refresh and retry once ----------------------------------------------------------------------------
    describe('a directory that is behind is refreshed once and asked again (the engine code review)', () => {
      it('the sender and the receiver each refresh once for a device whose list they have not verified yet', async () => {
        const world = await newWorld();
        const { engine } = world;
        const { room, devices } = await buildRoom(world, 3);
        const [alice, bob] = pair(devices);
        await world.device('erin', 'e1'); // version 1 of erin's list
        world.holdBack('erin');
        const second = await world.device('erin', 'e2'); // version 2 exists, the directory has not verified it
        const bundle = await engine.createKeyPackage(second.keys);

        world.refreshCalls.length = 0;
        const added = await engine.add({
          state: room.state(alice),
          keyPackages: [bundle.keyPackage],
        });
        expect(world.refreshCalls).toEqual(['erin']);

        // A receiver whose directory is still at version 1 does the same.
        world.lagBehind('erin', 1);
        world.refreshCalls.length = 0;
        const received = await engine.processCommit({
          state: room.state(bob),
          commit: added.commit,
          servedMemberDelta: added.memberDelta,
        });
        expect(world.refreshCalls).toEqual(['erin']);
        expect(engine.epoch(received.state)).toBe(engine.epoch(room.state(bob)) + 1n);
      });
    });

    // --- The KeyPackage window on receive ---------------------------------------------------------------------------------
    describe('the KeyPackage window on receive (the engine code review)', () => {
      async function staleAdd() {
        const world = await newWorld();
        const { engine } = world;
        const { room, devices } = await buildRoom(world, 3);
        const [alice, bob, carol] = trio(devices);
        const dave = await world.device('dave', 'd1');
        const bundle = await engine.createKeyPackage(dave.keys);
        const createdAtMs = world.nowMs;
        const added = await engine.add({
          state: room.state(alice),
          keyPackages: [bundle.keyPackage],
        });
        world.nowMs = createdAtMs + STALE_DAYS * DAY_MS; // carol wakes up 45 days later
        return { world, room, alice, bob, carol, bundle, added, createdAtMs };
      }

      it('a stale-but-listed KeyPackage inside a backlog Add is accepted; the sender keeps the full window', async () => {
        const { world, room, bob, carol, bundle, added } = await staleAdd();
        const { engine } = world;
        // Sending: a package that has expired is not offered to anybody.
        await expectCode(
          () => engine.add({ state: room.state(bob), keyPackages: [bundle.keyPackage] }),
          MlsEngineErrorCode.LIFETIME_OUT_OF_RANGE,
        );
        // Receiving: the relay accepted that Add within its retention, so it is read as it was then.
        const received = await engine.processCommit({
          state: room.state(carol),
          commit: added.commit,
          servedMemberDelta: added.memberDelta,
          backlog: true,
        });
        expect(engine.epoch(received.state)).toBe(engine.epoch(room.state(carol)) + 1n);
      });

      it('a claimed acceptance time is clamped: a long-past one cannot widen the window, a future one only narrows it', async () => {
        const { world, room, carol, added, createdAtMs } = await staleAdd();
        const { engine } = world;
        const receive = (acceptedAtMs: number) =>
          engine.processCommit({
            state: room.state(carol),
            commit: added.commit,
            servedMemberDelta: added.memberDelta,
            backlog: true,
            acceptedAtMs,
          });
        // The true acceptance time (when the Add was posted) is far older than the retention: raised to it.
        await receive(createdAtMs);
        expect(world.nowMs - createdAtMs).toBeGreaterThan(RETENTION_MS);
        // A time in the future is cut to now: the package is judged as if the Add arrived today, and is stale.
        await expectCode(
          () => receive(world.nowMs + FAR_FUTURE_DAYS * DAY_MS),
          MlsEngineErrorCode.LIFETIME_OUT_OF_RANGE,
        );
      });

      it('a package dead for years before the retention is refused, whatever the host says', async () => {
        const world = await newWorld();
        const { engine } = world;
        const adversary = await adversaryOf();
        const { room, devices } = await buildRoom(world, 3);
        const [alice, bob, carol] = trio(devices);
        const dave = await world.device('dave', 'd1');
        const now = world.nowMs;
        world.nowMs = now - YEARS_OLD_DAYS * DAY_MS;
        const ancient = await engine.createKeyPackage(dave.keys);
        world.nowMs = now;
        for (const acceptedAtMs of [undefined, now - YEARS_OLD_DAYS * DAY_MS, now]) {
          // The library will not even propose a package this old, so the Add is assembled by hand
          // (once per round: a refusal ends with an honest commit, which moves the epoch on).
          const forged = await adversary.sealedAdd(room.state(bob), [ancient.keyPackage]);
          await expectRefusedEverywhere(
            room,
            [alice, carol],
            forged.commit,
            MlsEngineErrorCode.LIFETIME_OUT_OF_RANGE,
            forged.memberDelta,
            acceptedAtMs === undefined ? { backlog: true } : { backlog: true, acceptedAtMs },
          );
        }
      });

      it('the floor only moves forward: a clock set back does not let an older package back in', async () => {
        const world = await newWorld();
        const { engine } = world;
        const adversary = await adversaryOf();
        const { room, devices } = await buildRoom(world, 3);
        const [alice, bob, carol] = trio(devices);
        const dave = await world.device('dave', 'd1');
        const start = world.nowMs;
        // A package that died 20 days before `start`: inside the retention window of a clock at `start`,
        // outside the one bob and carol reach after 20 days of commits.
        world.nowMs = start - (PACKAGE_LIFETIME_DAYS + CLOCK_BACK_DAYS) * DAY_MS;
        const old = await engine.createKeyPackage(dave.keys);
        world.nowMs = start + CLOCK_BACK_DAYS * DAY_MS;
        // bob and carol accept a commit the relay stamps now: their floor moves up to that stamp.
        const update = await engine.selfUpdate(room.state(alice));
        await room.deliver(update.commit, EMPTY_DELTA, [alice], { acceptedAtMs: world.nowMs });
        room.states.set(alice.deviceId, update.state);
        world.nowMs = start; // the clock is set back
        const forged = await adversary.sealedAdd(room.state(alice), [old.keyPackage]);
        await expectRefusedEverywhere(
          room,
          [bob, carol],
          forged.commit,
          MlsEngineErrorCode.LIFETIME_OUT_OF_RANGE,
          forged.memberDelta,
          { backlog: true },
        );
      });

      it('the floor stores only relay times: a clock that ran ahead for a while does not lock a backlog Add out', async () => {
        const world = await newWorld();
        const { engine } = world;
        const { room, devices } = await buildRoom(world, 3);
        const [alice, bob, carol] = trio(devices);
        const dave = await world.device('dave', 'd1');
        // `addedAt` stays the real "now": the library checks a package it is about to add against
        // the wall clock. dave's package has PACKAGE_DAYS_LEFT days left at that moment.
        const addedAt = world.nowMs;
        world.nowMs = addedAt - (PACKAGE_LIFETIME_DAYS - PACKAGE_DAYS_LEFT) * DAY_MS;
        const bundle = await engine.createKeyPackage(dave.keys);

        // 1. A commit the relay accepts the day before. carol reads it while her clock runs a year
        //    ahead; the relay's stamp, not her clock, is what her state keeps.
        const firstAcceptedAt = addedAt - DAY_MS;
        world.nowMs = firstAcceptedAt;
        const update = await engine.selfUpdate(room.state(alice));
        await room.deliver(update.commit, EMPTY_DELTA, [alice, carol], {
          acceptedAtMs: firstAcceptedAt,
        });
        world.nowMs = addedAt + CLOCK_AHEAD_DAYS * DAY_MS;
        await room.deliver(update.commit, EMPTY_DELTA, [alice, bob], {
          acceptedAtMs: firstAcceptedAt,
        });
        room.states.set(alice.deviceId, update.state);

        // 2. alice adds dave while his package is valid; carol is offline.
        world.nowMs = addedAt;
        const added = await engine.add({
          state: room.state(alice),
          keyPackages: [bundle.keyPackage],
        });
        await room.deliver(added.commit, added.memberDelta, [alice, carol], {
          acceptedAtMs: addedAt,
        });

        // 3. carol's clock is right again, REPLAY_AFTER_DAYS later: the package has expired since,
        //    the relay still holds the Add. Had her floor followed her clock (a year ahead), the
        //    package would be judged against today and the Add refused for good.
        world.nowMs = addedAt + REPLAY_AFTER_DAYS * DAY_MS;
        const replayed = await engine.processCommit({
          state: room.state(carol),
          commit: added.commit,
          servedMemberDelta: added.memberDelta,
          backlog: true,
          acceptedAtMs: addedAt,
        });
        expect(engine.epoch(replayed.state)).toBe(engine.epoch(room.state(carol)) + 1n);
        expect(engine.epochAuthenticator(replayed.state)).toEqual(
          engine.epochAuthenticator(room.state(bob)),
        );
      });
    });
  });
}
