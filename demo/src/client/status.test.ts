import { describe, expect, it } from 'vitest';
import type { RoomSnapshot } from './room.js';
import { STATUS_TEXT, statusLineOf } from './status.js';

const room = (over: Partial<RoomSnapshot> = {}): RoomSnapshot => ({
  conversationId: 'dm_a_b',
  peerUserId: 'b',
  phase: 'ready',
  note: undefined,
  history: [],
  queued: [],
  epoch: 1n,
  epochAuthenticator: undefined,
  members: [],
  needsSelfUpdate: false,
  stalled: false,
  sending: false,
  ...over,
});

describe('statusLineOf', () => {
  it('says the chat is being set up before there is any room view', () => {
    expect(statusLineOf(undefined)).toBe(STATUS_TEXT.settingUp);
  });

  it('says what each phase is waiting for, and nothing once the chat is ready', () => {
    expect(statusLineOf(room({ phase: 'creating' }))).toBe(STATUS_TEXT.settingUp);
    expect(statusLineOf(room({ phase: 'probing' }))).toBe(STATUS_TEXT.waiting);
    expect(statusLineOf(room({ phase: 'ready' }))).toBeNull();
  });

  it('puts the room\'s own reason first: it names what is wrong', () => {
    expect(statusLineOf(room({ phase: 'failed', note: 'This device was removed from the room.' }))).toBe(
      'This device was removed from the room.',
    );
    expect(statusLineOf(room({ phase: 'probing', note: 'Waiting to reach the relay: NETWORK (0)' }))).toBe(
      'Waiting to reach the relay: NETWORK (0)',
    );
  });
});
