import type { E2eePayload } from '@masia/messenger/protocol';

// What this tab remembers of a room, as plaintext. MLS deletes a message key once it has been used, so
// a message read today cannot be decrypted again, and a device can never decrypt its own messages:
// what the person has read (and sent) has to be kept. The playground keeps it in memory only, which is
// why a reload is a new person (see the README).

/** One line of a room's history: a payload that decoded, or the fact that one did not. */
export interface HistoryItem {
  /** The relay's envelope seq. */
  readonly seq: number;
  /** The sender's user id, from the MLS tree (never from the payload). */
  readonly senderUserId: string;
  readonly senderDeviceId: string;
  /** The relay's time for the envelope (ISO). */
  readonly createdAt: string;
  readonly payload?: E2eePayload;
  /** Why the message could not be read: an engine or payload error code. */
  readonly unreadable?: string;
}

/**
 * The identity of an item: the MLS sender AND the payload id (a message seen twice replaces itself),
 * or the seq for a line that did not decode. Never the payload id alone: the sender chooses it, and
 * another member reusing it would replace this member's message.
 */
function keyOf(item: HistoryItem): string {
  return item.payload ? `p:${item.senderUserId}\u0000${item.payload.id}` : `s:${item.seq}`;
}

/** `existing` plus `incoming`, merged by identity and ordered by seq. */
export function mergeHistory(
  existing: readonly HistoryItem[],
  incoming: readonly HistoryItem[],
): HistoryItem[] {
  const byKey = new Map<string, HistoryItem>();
  for (const item of existing) byKey.set(keyOf(item), item);
  for (const item of incoming) byKey.set(keyOf(item), item);
  return [...byKey.values()].sort((a, b) => a.seq - b.seq);
}
