import { describe, expect, it, vi } from 'vitest';
import { DeviceRole } from '@masia/contracts/wire';
import type { PlaygroundRuntime } from '../client/runtime.js';
import type { RoomSnapshot } from '../client/room.js';
import { createSecuritySource, securityStateOf } from './security-source.js';

const room = (over: Partial<RoomSnapshot> = {}): RoomSnapshot => ({
  conversationId: 'dm_a_b',
  peerUserId: 'u-bo',
  phase: 'ready',
  note: undefined,
  history: [],
  queued: [],
  epoch: 2n,
  epochAuthenticator: new Uint8Array(32).map((_, i) => i),
  members: [
    { leafIndex: 0, userId: 'u-ada', deviceId: 'd-ada', role: DeviceRole.USER },
    { leafIndex: 1, userId: 'u-bo', deviceId: 'd-bo', role: DeviceRole.USER },
  ],
  needsSelfUpdate: false,
  stalled: false,
  sending: false,
  ...over,
});

function runtimeWith(snapshots: Map<string, RoomSnapshot>): PlaygroundRuntime {
  const names = new Map([['u-ada', 'Ada'], ['u-bo', 'Bo']]);
  return {
    self: { deviceId: 'd-ada' },
    nameOf: (userId: string) => names.get(userId),
    roomSnapshot: (conversationId: string) => snapshots.get(conversationId),
    subscribe: vi.fn(() => () => undefined),
  } as unknown as PlaygroundRuntime;
}

describe('securityStateOf', () => {
  it('says the room is on, names each device by its owner, and marks this tab\'s own', () => {
    const state = securityStateOf(room(), runtimeWith(new Map()));
    expect(state.e2ee).toBe('on');
    expect(state.masia).toBe('absent');
    expect(state.guardians).toEqual([]);
    expect(state.epoch).toBe(2n);
    expect(state.devices.map((d) => [d.deviceId, d.label, d.isThis])).toEqual([
      ['d-ada', 'Ada: this browser tab', true],
      ['d-bo', 'Bo: this browser tab', false],
    ]);
    expect(state.devices.every((d) => d.verified)).toBe(true);
    expect(state.recovery).toBe('none');
    expect(state.thisDevice).toEqual({ engineIsolated: false, keyStore: 'browser' });
  });

  it('gives the security code in groups, the same from the same bytes', () => {
    const state = securityStateOf(room(), runtimeWith(new Map()));
    expect(state.epochAuthenticator).toBe('0001 0203 0405 0607 0809 0A0B 0C0D 0E0F');
  });

  it('does not call a room that is not set up secure, and says nothing about an epoch it has not got', () => {
    const state = securityStateOf(room({ epoch: undefined, epochAuthenticator: undefined, members: [] }), runtimeWith(new Map()));
    expect(state.e2ee).toBe('pending');
    expect(state.epoch).toBeUndefined();
    expect(state.epochAuthenticator).toBeUndefined();
    expect(state.devices).toEqual([]);
  });

  it('flags only this tab\'s device for a key refresh, and reports a stall and a send in progress', () => {
    const state = securityStateOf(room({ needsSelfUpdate: true, stalled: true, sending: true }), runtimeWith(new Map()));
    expect(state.devices.find((d) => d.deviceId === 'd-ada')?.needsSelfUpdate).toBe(true);
    expect(state.devices.find((d) => d.deviceId === 'd-bo')?.needsSelfUpdate).toBeUndefined();
    expect(state.recovery).toBe('stalled');
    expect(state.sending).toBe(true);
  });

  it('calls a member it has no name for "Someone"', () => {
    const stranger = room({ members: [{ leafIndex: 0, userId: 'u-x', deviceId: 'd-x', role: DeviceRole.USER }] });
    expect(securityStateOf(stranger, runtimeWith(new Map())).devices[0]?.label).toBe('Someone: this browser tab');
  });
});

describe('createSecuritySource', () => {
  it('knows nothing about a conversation the tab has not heard of', () => {
    expect(createSecuritySource(runtimeWith(new Map())).securityStateOf('dm_nobody')).toBeUndefined();
  });

  it('hands out the same state object until the room changes, so a reader that compares by identity is not woken', () => {
    const snapshots = new Map([['dm_a_b', room()]]);
    const source = createSecuritySource(runtimeWith(snapshots));
    const first = source.securityStateOf('dm_a_b');
    expect(source.securityStateOf('dm_a_b')).toBe(first);

    snapshots.set('dm_a_b', room({ epoch: 3n }));
    const next = source.securityStateOf('dm_a_b');
    expect(next).not.toBe(first);
    expect(next?.epoch).toBe(3n);
  });

  it('passes a subscription on to the runtime and gives back what it gives', () => {
    const unsubscribe = vi.fn();
    const subscribe = vi.fn(() => unsubscribe);
    const runtime = { ...runtimeWith(new Map()), subscribe } as unknown as PlaygroundRuntime;
    const onChange = vi.fn();
    const stop = createSecuritySource(runtime).subscribe('dm_a_b', onChange);
    expect(subscribe).toHaveBeenCalledWith(onChange);
    stop();
    expect(unsubscribe).toHaveBeenCalled();
  });
});
