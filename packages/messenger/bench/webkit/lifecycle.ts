import { createTsMlsEngine, MlsEngineErrorCode } from '@masia/messenger/mls';
import { expectCode } from '../../src/mls/__tests__/support/expect-code.js';
import { must } from '../../src/mls/__tests__/support/fixtures.js';
import { Room } from '../../src/mls/__tests__/support/room.js';
import { TestWorld, type TestDevice } from '../../src/mls/__tests__/support/world.js';
import { expect } from 'vitest';
import { decode, encode, scenario, type ScenarioResult } from './util.js';

/**
 * The honest lifecycle in a group of N devices, the way the contract suite's lifecycle part runs it,
 * with the product's order of events: create -> adds -> newcomers post their first self-update ->
 * 20 messages each way -> remove -> the removed device cannot read what comes next.
 *
 * Same `TestWorld` and `Room` as the contract suite (bundled as they are); only the sizes and the
 * volumes are the bench's own.
 */

export const LIFECYCLE_SIZES = [2, 5, 50] as const;
export type LifecycleSize = (typeof LIFECYCLE_SIZES)[number];

const MESSAGES_EACH_WAY = 20;
/** Newcomers that post their self-update (each one is a commit every other member processes). */
const SELF_UPDATERS: Record<LifecycleSize, number> = { 2: 1, 5: 4, 50: 2 };
/** Devices the creator removes, counted from the end of the roster. */
const REMOVED: Record<LifecycleSize, number> = { 2: 1, 5: 2, 50: 2 };
/** Up to 5 devices join one by one (as in a family); a bigger room joins in one Add commit. */
const ONE_BY_ONE_UP_TO = 5;
const USERS_PER_DEVICE = 0.8;
const EXPORTER_BYTES = 32;

/** About one user in five has two devices (size 2: two users; size 5: four users; size 50: forty users). */
const userOf = (index: number, size: number): string =>
  `user${index % Math.max(2, Math.ceil(size * USERS_PER_DEVICE))}`;

export function runLifecycle(size: LifecycleSize): Promise<ScenarioResult> {
  return scenario(`lifecycle: group of ${size}`, async ({ step, note }) => {
    const world = await TestWorld.create(createTsMlsEngine);
    const { engine } = world;

    const devices: TestDevice[] = await step('make devices (Ed25519 keys)', async () => {
      const made: TestDevice[] = [];
      for (let i = 0; i < size; i += 1) made.push(await world.device(userOf(i, size), `dev${i}`));
      return made;
    });
    const creator = must(devices[0], 'creator');
    const peer = must(devices[1], 'peer');
    const newcomers = devices.slice(1);

    const room = await step('create group', () => Room.create(world, creator, `conv-${size}`));
    expect(engine.members(room.state(creator)).length).toBe(1);

    await step('adds', async () => {
      if (size <= ONE_BY_ONE_UP_TO) {
        for (const newcomer of newcomers) await room.add(creator, [newcomer], { selfUpdate: false });
      } else {
        await room.add(creator, newcomers, { selfUpdate: false });
      }
    });
    expect(engine.members(room.state(creator)).length).toBe(size);
    room.expectConverged();

    await step('newcomer self-updates', async () => {
      for (const newcomer of newcomers.slice(0, SELF_UPDATERS[size])) {
        expect(engine.needsSelfUpdate(room.state(newcomer))).toBe(true);
        await room.selfUpdate(newcomer);
        expect(engine.needsSelfUpdate(room.state(newcomer))).toBe(false);
      }
    });
    room.expectConverged();

    await step(`${MESSAGES_EACH_WAY} messages each way`, async () => {
      for (let i = 0; i < MESSAGES_EACH_WAY; i += 1) {
        await room.send(creator, `message ${i} from ${creator.deviceId}`);
        await room.send(peer, `message ${i} from ${peer.deviceId}`);
      }
    });

    await step('exporter agrees', async () => {
      const mine = await engine.exporter(room.state(creator), 'bench', EXPORTER_BYTES);
      const theirs = await engine.exporter(room.state(peer), 'bench', EXPORTER_BYTES);
      expect(mine).toEqual(theirs);
    });

    const bytes = await step('encode state', () =>
      Promise.resolve(engine.encodeState(room.state(creator))),
    );
    await step('decode state', async () => {
      const restored = engine.decodeState(bytes);
      expect(engine.epoch(restored)).toBe(engine.epoch(room.state(creator)));
      expect(engine.encodeState(restored)).toEqual(bytes);
    });
    note('creatorStateBytes', bytes.length);

    const targets = devices.slice(size - REMOVED[size]);
    const removedDevice = must(targets[0], 'removed device');
    await step(`remove ${targets.length}`, async () => {
      await room.remove(creator, targets);
    });
    room.expectConverged();
    expect(engine.members(room.state(creator)).length).toBe(size - targets.length);

    await step('post-remove: the removed device cannot read or write', async () => {
      const sealed = await engine.encrypt(room.state(creator), encode('written after the removal'));
      room.states.set(creator.deviceId, sealed.state);
      await expectCode(
        () => engine.decrypt(room.state(removedDevice), sealed.ciphertext),
        MlsEngineErrorCode.EPOCH_MISMATCH,
      );
      await expectCode(
        () => engine.encrypt(room.state(removedDevice), encode('x')),
        MlsEngineErrorCode.NOT_ACTIVE,
      );
      expect(engine.isActive(room.state(removedDevice))).toBe(false);
      const remaining = devices.find((d) => !targets.includes(d) && d !== creator);
      if (remaining !== undefined) {
        const opened = await engine.decrypt(room.state(remaining), sealed.ciphertext);
        expect(decode(opened.plaintext)).toBe('written after the removal');
      }
    });

    note('finalEpoch', String(engine.epoch(room.state(creator))));
    note('finalMembers', engine.members(room.state(creator)).length);
  });
}
