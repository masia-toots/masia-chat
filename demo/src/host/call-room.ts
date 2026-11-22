import { DeviceRole } from '@masia/contracts/wire';
import type { CallBindingPort } from '@masia/messenger/call';
import { callTag, callVerify, type CallKeyring } from '@masia/messenger/call/call-binding';
import type { PlaygroundRuntime } from '../client/runtime.js';
import type { RoomSnapshot } from '../client/room.js';

// What a call needs of the playground's rooms: the fingerprint binding over a room's MLS group, who to
// ring, and whether a room is one a call can be placed in at all.
//
// The binding runs in the page. A host with an MLS worker keeps it there, so the call key never reaches
// the page; the playground has no worker (its whole MLS state lives in the page already), so there is no
// boundary to keep. The package's binding still wipes the key after each question.

/** The binding port over the runtime's rooms: one keyring per question, for the room the question names. */
export function createCallBinding(runtime: Pick<PlaygroundRuntime, 'self' | 'callKey'>): CallBindingPort {
  const keyringOf = (conversationId: string): CallKeyring => ({
    selfUserId: runtime.self.userId,
    selfDeviceId: runtime.self.deviceId,
    key: (callId, fresh) => runtime.callKey(conversationId, callId, fresh),
  });
  return {
    callTag: (request) => callTag(keyringOf(request.conversationId), request),
    callVerify: (request) => callVerify(keyringOf(request.conversationId), request),
  };
}

/** The people (by user id) whose own devices are in the room. Assistant and guardian devices are not people here. */
function peopleIn(room: RoomSnapshot): Set<string> {
  return new Set(room.members.filter((member) => member.role === DeviceRole.USER).map((member) => member.userId));
}

/**
 * A room a call can be placed in: the group is open on this tab and it holds exactly two people, this one and
 * one other. The relay rings only such a room, and the binding verifies only such a peer.
 */
export function isTwoPersonRoom(room: RoomSnapshot | undefined, selfUserId: string): boolean {
  if (room === undefined || room.phase !== 'ready' || room.epoch === undefined) return false;
  const people = peopleIn(room);
  return people.size === 2 && people.has(selfUserId);
}

/** The devices to ring: the other person's own devices in the room, as this tab's group holds them now. */
export function ringTargetsOf(room: RoomSnapshot | undefined, selfUserId: string): string[] {
  if (room === undefined || !isTwoPersonRoom(room, selfUserId)) return [];
  return room.members
    .filter((member) => member.role === DeviceRole.USER && member.userId !== selfUserId)
    .map((member) => member.deviceId);
}
