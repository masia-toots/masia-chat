import { expect } from 'vitest';
import type { MemberDelta, MlsEngineErrorCode } from '../../mls-engine.js';
import { expectCode } from './expect-code.js';
import { EMPTY_DELTA, must } from './fixtures.js';
import type { Delivery, Room } from './room.js';
import type { TestDevice } from './world.js';

/**
 * Hands `commit` to every victim, expecting `code` from each, and proves the group still works: no
 * victim's state moved, and an honest commit afterwards goes through for all. `delivery` is how the
 * host hands the commit over (live, or replayed from the relay's backlog).
 */
export async function expectRefusedEverywhere(
  room: Room,
  victims: readonly TestDevice[],
  commit: Uint8Array,
  code: MlsEngineErrorCode,
  servedMemberDelta: MemberDelta = EMPTY_DELTA,
  delivery: Delivery = {},
): Promise<void> {
  const { engine } = room.world;
  for (const victim of victims) {
    const before = room.state(victim);
    await expectCode(
      () => engine.processCommit({ state: before, commit, servedMemberDelta, ...delivery }),
      code,
    );
    expect(engine.epoch(room.state(victim))).toBe(engine.epoch(before));
  }
  const survivor = must(victims[0], 'victim');
  await room.selfUpdate(survivor);
  room.expectConverged();
}
