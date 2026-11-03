import type { RoomSnapshot } from './room.js';

// The one line above a chat that tells the person what it is waiting for. Pure: the same snapshot
// always gives the same line, so a test can state every case.

export const STATUS_TEXT = {
  settingUp: 'Setting up encryption with this person…',
  waiting: 'Waiting for the other tab to join this chat…',
} as const;

/** A line for the room's state, or `null` when there is nothing to say (the chat is simply ready). */
export function statusLineOf(room: RoomSnapshot | undefined): string | null {
  if (room === undefined) return STATUS_TEXT.settingUp;
  // A reason the room gave beats a generic line: it names what is wrong (relay down, refused).
  if (room.note !== undefined) return room.note;
  if (room.phase === 'creating') return STATUS_TEXT.settingUp;
  if (room.phase === 'probing') return STATUS_TEXT.waiting;
  return null;
}
