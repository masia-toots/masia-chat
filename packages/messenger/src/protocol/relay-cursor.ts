/**
 * The ONE rule every member uses to read the relay's retention marker (canon section 5, К8 R2-H):
 * a device whose cursor is `cursor` (the last seq it processed in a stream, 0 = none) and a relay
 * that still holds rows from `oldestAvailableSeq` on has lost rows it never processed exactly when
 * `cursor + 1 < oldestAvailableSeq`. Rows `cursor + 1 … oldestAvailableSeq - 1` existed and are gone.
 *
 * The cursor of a device that joined by a Welcome starts at the seq it joined at, never at 0
 * (`relayCursorAtJoin`): a joiner that never saw a commit must still notice that retention cut one.
 *
 * Shared by the hub's room host and the assistant worker, so the two cannot drift (round 2, rel-M2).
 */
export function isBehindRetention(cursor: number, oldestAvailableSeq: number): boolean {
  return cursor + 1 < oldestAvailableSeq;
}

/** Where a device's cursors start when it enters a room: after the rows that existed before it. */
export interface RelayCursorAtJoin {
  /** The seq of the commit whose epoch the device joined at (0 for the room's creator). */
  readonly handshakeSeq: number;
  /** The last envelope seq that existed when it joined (0 when none did). */
  readonly envelopeSeq: number;
}

/** The creator's cursors: nothing came before the group. */
export const CREATOR_CURSOR: RelayCursorAtJoin = { handshakeSeq: 0, envelopeSeq: 0 };
