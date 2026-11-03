import { DeviceRole } from '../../mls-engine.js';
import type { MemberDelta } from '../../mls-engine.js';
import { Room } from './room.js';
import type { TestDevice, TestWorld } from './world.js';

/** The delta of a commit that adds and removes nobody (a self-update). */
export const EMPTY_DELTA: MemberDelta = { added: [], removed: [] };

/** Users and their devices, in the order a family room gets built. */
const ROSTER: readonly (readonly [userId: string, deviceId: string])[] = [
  ['alice', 'a1'],
  ['bob', 'b1'],
  ['carol', 'c1'],
  ['alice', 'a2'],
  ['bob', 'b2'],
  ['dave', 'd1'],
  ['erin', 'e1'],
  ['frank', 'f1'],
];

export interface BuiltRoom {
  readonly room: Room;
  readonly devices: readonly TestDevice[];
}

/**
 * A room of `size` devices (at most the roster's length), built the way the product builds one: the
 * first device creates the group and adds the others ONE BY ONE, each newcomer posting its
 * self-update right after joining. That leaves real parent nodes with real parent hashes in the
 * tree, which the Welcome-tampering tests need.
 */
export async function buildRoom(
  world: TestWorld,
  size: number,
  conversationId = 'conv-1',
): Promise<BuiltRoom> {
  if (size < 1 || size > ROSTER.length)
    throw new Error(`buildRoom supports 1..${ROSTER.length} devices`);
  const devices: TestDevice[] = [];
  for (const [userId, deviceId] of ROSTER.slice(0, size)) {
    devices.push(await world.device(userId, deviceId));
  }
  const [creator, ...others] = devices;
  if (creator === undefined) throw new Error('empty roster');
  const room = await Room.create(world, creator, conversationId);
  for (const newcomer of others) await room.add(creator, [newcomer]);
  return { room, devices };
}

/** A room of `size` devices built with ONE Add commit and no newcomer self-updates: the fast way to a big group. */
export async function buildBulkRoom(
  world: TestWorld,
  size: number,
  conversationId = 'conv-big',
): Promise<BuiltRoom> {
  const devices: TestDevice[] = [];
  for (let i = 0; i < size; i += 1) devices.push(await world.device(`user${i}`, `dev${i}`));
  const [creator, ...others] = devices;
  if (creator === undefined) throw new Error('empty room');
  const room = await Room.create(world, creator, conversationId);
  await room.add(creator, others, { selfUpdate: false });
  return { room, devices };
}

/** A GUARDIAN device of `childUserId`: the leaf that monitors a child's room (internal ADR-117 §4). */
export function guardianDevice(
  world: TestWorld,
  childUserId: string,
  deviceId = 'guard1',
): Promise<TestDevice> {
  return world.device(childUserId, deviceId, DeviceRole.GUARDIAN);
}

export function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`${what} is missing`);
  return value;
}

/** The first two / three / four / five devices of a built room, typed as present. */
export function pair(devices: readonly TestDevice[]): readonly [TestDevice, TestDevice] {
  return [must(devices[0], 'device 0'), must(devices[1], 'device 1')];
}

export function trio(
  devices: readonly TestDevice[],
): readonly [TestDevice, TestDevice, TestDevice] {
  return [must(devices[0], 'device 0'), must(devices[1], 'device 1'), must(devices[2], 'device 2')];
}

export function quint(
  devices: readonly TestDevice[],
): readonly [TestDevice, TestDevice, TestDevice, TestDevice, TestDevice] {
  return [
    must(devices[0], 'device 0'),
    must(devices[1], 'device 1'),
    must(devices[2], 'device 2'),
    must(devices[3], 'device 3'),
    must(devices[4], 'device 4'),
  ];
}
