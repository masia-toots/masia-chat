/**
 * The plaintext messenger's OUTBOX: every message of mine from the moment it is sent until the server
 * confirms it, per account and conversation, in the `outbox-store` (browser storage where there is one).
 *
 * The rule it serves: what a person typed is never dropped in silence. A send that is refused, lost
 * on a link that went down, or dropped by the server without a word stays on screen marked "not sent"
 * with a retry and a delete, through a tab switch, a conversation switch, a remount and a reload, until
 * the person sends it again or discards it.
 *
 * An entry's life:
 *   - `sending`: posted; the host has not answered yet.
 *   - `unconfirmed`: the host took the command (it went onto the link), and the server's echo (`msg:sent`
 *     or my own `msg:new`) has not come yet. Taking a command is not delivering it: a link can drop
 *     right after, and a server can refuse a frame without answering.
 *   - `failed`: refused, or the link went down before the echo, or the page was reloaded meanwhile. The
 *     row says "not sent"; `retrySend` posts the same command again.
 * The echo removes the entry and the server's row takes its place. `handedOff` remembers that the host
 * took the command at least once, so the server MAY hold the message even though no echo came: such an
 * entry is compared with the next history page, and dropped when the page shows it.
 *
 * The rules themselves (settle with history, fail what waits, weave the rows) are `outbox-rules.ts`, shared
 * with the chat with Masia's outbox (2026-11-18); this file says only how a messenger row looks.
 */
import type { MsgClientEvent } from '../protocol/events.js';
import type { MessengerMessage } from '../protocol/messages.js';
import {
  OUTBOX_MAX_STORED_CHARS,
  OUTBOX_STATE,
  PENDING_MESSAGE_ID_PREFIX,
  settleOutboxEntries,
  weaveOutboxRows,
  type OutboxState,
} from './outbox-rules.js';
import {
  browserOutboxStorage,
  createOutboxStore,
  type OutboxStorage,
  type OutboxStore,
} from './outbox-store.js';

export {
  failWaitingEntries,
  OUTBOX_CLOCK_SKEW_MS,
  OUTBOX_MAX_STORED_CHARS,
  OUTBOX_STATE,
  PENDING_MESSAGE_ID_PREFIX,
  type OutboxState,
} from './outbox-rules.js';

/** Storage key prefix of the plaintext outbox (versioned: a new entry shape takes a new prefix). */
export const MESSENGER_OUTBOX_KEY_PREFIX = 'masia.messenger.outbox.v1:';

export interface MessengerOutboxEntry {
  /** The id of the row that shows it (`pending-…`). */
  readonly id: string;
  readonly state: OutboxState;
  /** The host took the command at least once: the server may hold the message without having echoed it. */
  readonly handedOff: boolean;
  /** The row as shown (`sendFailed` is derived from `state`, never stored). */
  readonly row: MessengerMessage;
  /** The command that sends it, posted again as it is by a retry. */
  readonly command: MsgClientEvent;
}

export type MessengerOutbox = OutboxStore<MessengerOutboxEntry>;

/**
 * A row the server has not confirmed: still on its way, or not sent. It has no server id, so nothing
 * can be replied to, edited, reacted to or deleted on the server through it.
 */
export function isUnconfirmedMessage(message: Pick<MessengerMessage, 'id' | 'sendFailed'>): boolean {
  return message.sendFailed === true || message.id.startsWith(PENDING_MESSAGE_ID_PREFIX);
}

/** Where one account's outbox for one conversation lives. No account: memory only (never written). */
export function messengerOutboxAddress(personId: string | undefined, conversationId: string): string {
  return `${personId ?? ''}/${conversationId}`;
}

const NO_ACCOUNT_PREFIX = '/';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A stored entry back into one: shape checked, and FAILED — after a reload nothing is in flight, so an
 * entry the page did not see confirmed is one the person must be able to send again.
 */
function reviveEntry(value: unknown): MessengerOutboxEntry | null {
  if (!isRecord(value)) return null;
  const { id, handedOff, row, command } = value;
  if (typeof id !== 'string' || !id.startsWith(PENDING_MESSAGE_ID_PREFIX)) return null;
  if (
    !isRecord(row) ||
    row['id'] !== id ||
    typeof row['conversationId'] !== 'string' ||
    typeof row['text'] !== 'string' ||
    typeof row['messageType'] !== 'string' ||
    typeof row['createdAt'] !== 'string'
  ) {
    return null;
  }
  if (!isRecord(command) || command['type'] !== 'msg:send' || !isRecord(command['payload'])) return null;
  return {
    id,
    state: OUTBOX_STATE.FAILED,
    handedOff: handedOff === true,
    row: row as unknown as MessengerMessage,
    command: command as unknown as MsgClientEvent,
  };
}

function isStorable(entry: MessengerOutboxEntry, address: string): boolean {
  if (address.startsWith(NO_ACCOUNT_PREFIX)) return false;
  return JSON.stringify(entry).length <= OUTBOX_MAX_STORED_CHARS;
}

/** A plaintext outbox over `storage` (`null` = memory only). Tests make their own; the page shares one. */
export function createMessengerOutbox(storage: OutboxStorage | null): MessengerOutbox {
  return createOutboxStore<MessengerOutboxEntry>({
    storage,
    keyPrefix: MESSENGER_OUTBOX_KEY_PREFIX,
    revive: reviveEntry,
    persistable: isStorable,
  });
}

let shared: MessengerOutbox | null = null;

/** The page's one plaintext outbox, over the browser's storage (made on first use). */
export function sharedMessengerOutbox(): MessengerOutbox {
  shared ??= createMessengerOutbox(browserOutboxStorage());
  return shared;
}

const sameText = (a: string, b: string): boolean => a.trim() === b.trim();

/**
 * Whether my own `msg:new` is this entry's message: the same kind and, for words, the same words (the
 * server trims them). A sticker's or a picture's text is the server's own, so the kind alone decides;
 * the oldest such entry is the one the echo confirms, as the server answers in the order it was sent.
 */
export function echoConfirms(
  entry: MessengerOutboxEntry,
  echo: { readonly messageType: string; readonly text: string },
): boolean {
  if (entry.row.messageType !== echo.messageType) return false;
  return entry.row.messageType !== 'TEXT' || sameText(entry.row.text, echo.text);
}

/**
 * After the newest history page came in (asked for at `askedAt`, device time), settles what it can:
 *   - an entry the host took (`handedOff`) that the page shows as mine (same kind, same words, same
 *     reply, no earlier than the entry allowing for `OUTBOX_CLOCK_SKEW_MS`) was delivered: dropped, one
 *     row for one entry;
 *   - an entry still `unconfirmed` from before the page was asked for, that the page does not show, was
 *     lost on the way: `failed` (its echo would have come long ago).
 * A refused entry (never handed off) is never matched: it cannot have arrived.
 */
export function settleOutboxWithHistory(
  outbox: MessengerOutbox,
  address: string,
  history: readonly MessengerMessage[],
  personId: string | undefined,
  askedAt: number,
): void {
  settleOutboxEntries(
    outbox,
    address,
    history,
    {
      sentAt: (entry) => Date.parse(entry.row.createdAt),
      shows: (entry, row) =>
        row.senderId === personId &&
        !row.deletedAt &&
        echoConfirms(entry, row) &&
        (row.replyToId ?? null) === (entry.row.replyToId ?? null),
      rowId: (row) => row.id,
      rowAt: (row) => Date.parse(row.createdAt),
    },
    askedAt,
  );
}

/**
 * The thread as shown: the server's rows with mine from the outbox added (`weaveOutboxRows`: a failed
 * row by time, a row on its way at the end).
 */
export function withOutboxRows<M extends MessengerMessage>(
  rows: readonly M[],
  entries: readonly MessengerOutboxEntry[],
): M[] {
  return weaveOutboxRows<M, MessengerOutboxEntry>(
    rows,
    entries,
    (entry) => ({ ...entry.row, sendFailed: entry.state === OUTBOX_STATE.FAILED }) as M,
    (row) => row.createdAt,
  );
}
