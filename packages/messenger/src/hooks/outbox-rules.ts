/**
 * THE OUTBOX RULES: what happens to a message of mine between the send and the server's confirmation,
 * ONE set for every outbox in the app. The messenger's (`messenger-outbox.ts`) and the chat with Masia's
 * (`@masia/shared` `chat-outbox.ts`, 2026-11-18, TODO-1398) both live in an `outbox-store` and both follow
 * these rules; each outbox only says how ITS rows look (a time, an id, «is this history row my message»).
 *
 * Why one set: the chat with Masia kept its optimistic row in the screen's own state with no failed state,
 * so a frame the socket could not take, or a row a history load replaced, vanished without a word, the
 * very failure the messenger's outbox had already been built against. A second copy of the rules would
 * drift from the first; these are written once.
 *
 * An entry's life:
 *   - `sending`: posted; the host has not answered yet.
 *   - `unconfirmed`: the host took the command (it went onto the link), and the server's echo has not come
 *     yet. Taking a command is not delivering it: a link can drop right after, and a server can refuse a
 *     frame without answering.
 *   - `failed`: refused, or the link went down before the echo, or the page was reloaded meanwhile. The
 *     row says "not sent", with a retry and a delete.
 * `handedOff` remembers that the host took the command at least once, so the server MAY hold the message
 * even though no echo came: such an entry is compared with the next history page, and dropped when the
 * page shows it.
 */
import type { OutboxEntryBase, OutboxStore } from './outbox-store.js';

/** Ids of messages shown before the server confirmed them start with this; the server id replaces it. */
export const PENDING_MESSAGE_ID_PREFIX = 'pending-';

/**
 * The longest entry written to storage, in UTF-16 code units. A text is far below it; an image sent
 * inline can be megabytes and would crowd out everything else the page keeps, so such an entry lives
 * in memory only (it survives a tab switch, not a reload).
 */
export const OUTBOX_MAX_STORED_CHARS = 256 * 1024;

/**
 * How far apart the device's clock and the server's may be when a history row is matched to an entry
 * (the entry's time is the device's, the row's is the server's). Kept short on purpose: two identical
 * texts sent within it, the second lost, would read as one delivered.
 */
export const OUTBOX_CLOCK_SKEW_MS = 30_000;

export const OUTBOX_STATE = {
  SENDING: 'sending',
  UNCONFIRMED: 'unconfirmed',
  FAILED: 'failed',
} as const;
export type OutboxState = (typeof OUTBOX_STATE)[keyof typeof OUTBOX_STATE];

/** What the rules need of an entry: where it is in its life. */
export interface OutboxRowEntry extends OutboxEntryBase {
  readonly state: OutboxState;
  /** The host took the command at least once: the server may hold the message without having echoed it. */
  readonly handedOff: boolean;
}

/** How one outbox's entries meet the server's history rows (`settleOutboxEntries`). */
export interface OutboxHistoryRules<E extends OutboxRowEntry, R> {
  /** When the entry was sent, in ms (the device's clock). */
  sentAt(entry: E): number;
  /** Whether the server's `row` is this entry's message, the time window aside. */
  shows(entry: E, row: R): boolean;
  /** The row's id: one row confirms one entry. */
  rowId(row: R): string;
  /** When the server wrote `row`, in ms (the server's clock). */
  rowAt(row: R): number;
}

/**
 * After the newest history page came in (asked for at `askedAt`, device time), settles what it can:
 *   - an entry the host took (`handedOff`) that the page shows (`rules.shows`, no earlier than the entry
 *     allowing for `OUTBOX_CLOCK_SKEW_MS`) was delivered: dropped, one row for one entry;
 *   - an entry still `unconfirmed` from before the page was asked for, that the page does not show, was
 *     lost on the way: `failed` (its echo would have come long ago).
 * A refused entry (never handed off) is never matched: it cannot have arrived.
 */
export function settleOutboxEntries<E extends OutboxRowEntry, R>(
  outbox: OutboxStore<E>,
  address: string,
  history: readonly R[],
  rules: OutboxHistoryRules<E, R>,
  askedAt: number,
): void {
  outbox.rewrite(address, (entries) => {
    if (entries.length === 0) return entries;
    const used = new Set<string>();
    let changed = false;
    const kept: E[] = [];
    for (const entry of entries) {
      const sentAt = rules.sentAt(entry);
      if (entry.handedOff) {
        const match = history.find(
          (row) =>
            !used.has(rules.rowId(row)) &&
            rules.shows(entry, row) &&
            rules.rowAt(row) >= sentAt - OUTBOX_CLOCK_SKEW_MS,
        );
        if (match) {
          used.add(rules.rowId(match));
          changed = true;
          continue;
        }
      }
      if (entry.state === OUTBOX_STATE.UNCONFIRMED && sentAt < askedAt) {
        kept.push({ ...entry, state: OUTBOX_STATE.FAILED });
        changed = true;
        continue;
      }
      kept.push(entry);
    }
    return changed ? kept : entries;
  });
}

/** Every entry at `address` still waiting (sending or unconfirmed) is marked `failed`: the link went down. */
export function failWaitingEntries<E extends OutboxRowEntry>(outbox: OutboxStore<E>, address: string): void {
  outbox.rewrite(address, (entries) =>
    entries.some((entry) => entry.state !== OUTBOX_STATE.FAILED)
      ? entries.map((entry) =>
          entry.state === OUTBOX_STATE.FAILED ? entry : { ...entry, state: OUTBOX_STATE.FAILED },
        )
      : entries,
  );
}

/**
 * The thread as shown: the server's rows (in their own order) with the outbox's added.
 *   - A FAILED row is woven in by time (before the first server row that is newer), so a message that
 *     never left keeps its place in the conversation, on this screen and on the next one.
 *   - A row still on its way stays at the END, in the order it was sent: its time is the device's and
 *     the server's rows carry the server's, so weaving it by time would let two quick messages swap
 *     places for a moment while the first one is confirmed.
 * `shown` turns an entry into its row (marked not sent when failed); `at` is a row's time as an ISO string.
 */
export function weaveOutboxRows<R, E extends OutboxRowEntry>(
  rows: readonly R[],
  entries: readonly E[],
  shown: (entry: E) => R,
  at: (row: R) => string,
): R[] {
  if (entries.length === 0) return rows as R[];
  const failed = entries.filter((entry) => entry.state === OUTBOX_STATE.FAILED).map(shown);
  const waiting = entries.filter((entry) => entry.state !== OUTBOX_STATE.FAILED).map(shown);
  const out: R[] = [];
  let next = 0;
  for (const row of rows) {
    while (next < failed.length && at(failed[next]!) < at(row)) out.push(failed[next++]!);
    out.push(row);
  }
  while (next < failed.length) out.push(failed[next++]!);
  return waiting.length > 0 ? [...out, ...waiting] : out;
}
