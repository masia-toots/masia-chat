import type { ConversationSecurityState, SecurityDevice } from '@masia/messenger/protocol';
import { formatEpochAuthenticator } from '@masia/messenger/protocol';
import type { SecurityStateSource } from '@masia/messenger/ui';
import type { PlaygroundRuntime } from '../client/runtime.js';
import type { RoomSnapshot } from '../client/room.js';

// What the zone badge, the security sheet and the stall banner read: a room's security state, built
// from what this tab knows about the room and nothing it would have to guess.
//
//  - `e2ee` is `on` once the group exists on this tab, `pending` until then (and when the room failed to
//    open: a room that is not set up must not look secure, and it must not claim to be plain either);
//  - `masia` is always `absent`: the playground has no assistant;
//  - `thisDevice` says what is true: the engine runs in this page and the keys live in this browser.

export function securityStateOf(room: RoomSnapshot, runtime: PlaygroundRuntime): ConversationSecurityState {
  const thisDeviceId = runtime.self.deviceId;
  const devices: SecurityDevice[] = room.members.map((member) => {
    const isThis = member.deviceId === thisDeviceId;
    const owner = runtime.nameOf(member.userId) ?? 'Someone';
    return {
      deviceId: member.deviceId,
      label: `${owner}: this browser tab`,
      role: member.role,
      // Every leaf in the tree passed the engine's check against its owner's signed device list.
      verified: true,
      ...(isThis && room.needsSelfUpdate ? { needsSelfUpdate: true } : {}),
      isThis,
    };
  });
  return {
    e2ee: room.epoch === undefined ? 'pending' : 'on',
    masia: 'absent',
    guardians: [],
    ...(room.epoch === undefined ? {} : { epoch: room.epoch }),
    ...(room.epochAuthenticator === undefined
      ? {}
      : { epochAuthenticator: formatEpochAuthenticator(room.epochAuthenticator) }),
    devices,
    recovery: room.stalled ? 'stalled' : 'none',
    thisDevice: { engineIsolated: false, keyStore: 'browser' },
    ...(room.sending ? { sending: true } : {}),
  };
}

export function createSecuritySource(runtime: PlaygroundRuntime): SecurityStateSource {
  // The runtime hands out the same room view until the room changes, so one entry per view is exact.
  const built = new WeakMap<RoomSnapshot, ConversationSecurityState>();
  return {
    securityStateOf(conversationId) {
      const room = runtime.roomSnapshot(conversationId);
      if (room === undefined) return undefined;
      let state = built.get(room);
      if (state === undefined) {
        state = securityStateOf(room, runtime);
        built.set(room, state);
      }
      return state;
    },
    subscribe: (_conversationId, onChange) => runtime.subscribe(onChange),
  };
}
