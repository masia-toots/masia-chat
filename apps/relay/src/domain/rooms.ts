import type { HandshakeKind } from '@masia/relay';
import { RelayError, RelayErrorCode } from '@masia/relay';
import type { Queryable } from '../db.js';
import type { DeclaredMemberDelta } from './member-delta.js';

/**
 * The read side of a room. The WRITE side (epochs, handshakes, envelopes, membership changes) is
 * owned by the epoch serializer, so that one module decides what order things happen in.
 */

export interface HandshakeRow {
  readonly seq: number;
  readonly epoch: number;
  readonly kind: HandshakeKind;
  readonly senderDeviceId: string;
  readonly bytes: Buffer;
  /** What the sender declared beside a COMMIT; `null` on a WELCOME row. */
  readonly memberDelta: DeclaredMemberDelta | null;
  readonly createdAt: Date;
}

export interface EnvelopeRow {
  readonly seq: number;
  readonly epoch: number;
  readonly senderDeviceId: string;
  readonly ciphertext: Buffer;
  readonly createdAt: Date;
}

export function notAMember(): RelayError {
  // The same answer for "no such room" and "you are not in it": a room id is not a directory to probe.
  return new RelayError(RelayErrorCode.NOT_A_MEMBER, 'This device is not a member of that room.');
}

/** The device was in the room and a commit took it out; `removedAtEpoch` is that commit's result. */
export function removedFromRoom(removedAtEpoch: number): RelayError {
  return new RelayError(
    RelayErrorCode.REMOVED,
    'This device has been removed from that room; it may read only what came before its removal.',
    { removedAtEpoch },
  );
}

/** A device's place in a room, as the relay recorded it from the declared member deltas. */
export interface Membership {
  /** The epoch the device joined in (the epoch AFTER the commit that added it). */
  readonly addedAtEpoch: number;
  /** The epoch AFTER the commit that removed it, or `null` while it is a member. */
  readonly removedAtEpoch: number | null;
}

/**
 * THE membership query: every "is this device in the room" in the relay reads this one row. `null`
 * when the device was never in the room (or the room does not exist).
 */
export async function findMembership(
  q: Queryable,
  conversationId: string,
  deviceId: string,
): Promise<Membership | null> {
  const { rows } = await q.query<Membership>(
    `SELECT added_at_epoch AS "addedAtEpoch", removed_at_epoch AS "removedAtEpoch"
     FROM room_members WHERE conversation_id = $1 AND device_id = $2`,
    [conversationId, deviceId],
  );
  return rows[0] ?? null;
}

/** A device that may write to the room: a current member. 403 NOT_A_MEMBER or REMOVED otherwise. */
export function assertCurrentMember(membership: Membership | null): Membership {
  if (membership === null) throw notAMember();
  if (membership.removedAtEpoch !== null) throw removedFromRoom(membership.removedAtEpoch);
  return membership;
}

/**
 * What a device may read of a room, in epochs: from `fromEpoch` (inclusive) to `beforeEpoch`
 * (exclusive, `null` = no end). A removed device keeps a window that ends at its removal, so it can
 * read the commit that removed it (built on `removedAtEpoch - 1`) and every message sent while it
 * was a member, and nothing after (review round 1, 2026-10-10).
 */
export interface ReadWindow {
  readonly fromEpoch: number;
  readonly beforeEpoch: number | null;
  readonly removedAtEpoch: number | null;
}

/**
 * The window of the handshake log. It starts one epoch BEFORE the add: the Welcome addressed to the
 * device is filed under the epoch its commit was built on.
 */
export function handshakeWindow(membership: Membership): ReadWindow {
  return {
    fromEpoch: Math.max(0, membership.addedAtEpoch - 1),
    beforeEpoch: membership.removedAtEpoch,
    removedAtEpoch: membership.removedAtEpoch,
  };
}

/**
 * The window of the envelopes. It starts AT the epoch the device joined in: earlier envelopes were
 * encrypted before it was a member and are not for it (forward secrecy covers the keys; this
 * covers the metadata and the bytes).
 */
export function envelopeWindow(membership: Membership): ReadWindow {
  return {
    fromEpoch: membership.addedAtEpoch,
    beforeEpoch: membership.removedAtEpoch,
    removedAtEpoch: membership.removedAtEpoch,
  };
}

/** The window of a device that may read the room at all; 403 NOT_A_MEMBER for any other. */
export async function requireReader(
  q: Queryable,
  conversationId: string,
  deviceId: string,
): Promise<Membership> {
  const membership = await findMembership(q, conversationId, deviceId);
  if (membership === null) throw notAMember();
  return membership;
}

export interface Page<T> {
  readonly rows: T[];
  /** `true` when more rows follow the last one returned. */
  readonly hasMore: boolean;
  /**
   * The lowest seq the relay still holds for this conversation (the retention job deletes older
   * rows), or the next seq it will hand out when it holds none. A reader whose cursor is below
   * `oldestAvailableSeq - 1` has missed rows it can never fetch and must recover another way.
   */
  readonly oldestAvailableSeq: number;
}

/** Fetches `limit + 1` rows to learn whether another page exists without a second count query. */
function toPage<T>(rows: T[], limit: number, oldestAvailableSeq: number): Page<T> {
  return rows.length > limit
    ? { rows: rows.slice(0, limit), hasMore: true, oldestAvailableSeq }
    : { rows, hasMore: false, oldestAvailableSeq };
}

type SequencedTable = 'mls_handshakes' | 'envelopes';

/** The counter column on `conversation_e2ee` that hands out each table's seq numbers. */
export const SEQ_COUNTER: Readonly<Record<SequencedTable, 'handshake_seq' | 'envelope_seq'>> = {
  mls_handshakes: 'handshake_seq',
  envelopes: 'envelope_seq',
};

async function oldestAvailableSeq(
  q: Queryable,
  table: SequencedTable,
  conversationId: string,
): Promise<number> {
  const { rows } = await q.query<{ oldest: number }>(
    `SELECT COALESCE(
       (SELECT MIN(seq) FROM ${table} WHERE conversation_id = $1),
       (SELECT ${SEQ_COUNTER[table]} + 1 FROM conversation_e2ee WHERE conversation_id = $1),
       1
     ) AS oldest`,
    [conversationId],
  );
  return rows[0]?.oldest ?? 1;
}

export interface ListQuery {
  readonly conversationId: string;
  readonly window: ReadWindow;
  /** Paging cursor: only rows after this seq. */
  readonly afterSeq: number;
  readonly limit: number;
}

export async function listHandshakes(q: Queryable, query: ListQuery): Promise<Page<HandshakeRow>> {
  const { rows } = await q.query<HandshakeRow>(
    `SELECT seq, epoch, kind, sender_device_id AS "senderDeviceId", bytes,
            member_delta_json AS "memberDelta", created_at AS "createdAt"
     FROM mls_handshakes
     WHERE conversation_id = $1 AND epoch >= $2 AND ($3::integer IS NULL OR epoch < $3) AND seq > $4
     ORDER BY seq LIMIT $5`,
    [
      query.conversationId,
      query.window.fromEpoch,
      query.window.beforeEpoch,
      query.afterSeq,
      query.limit + 1,
    ],
  );
  return toPage(
    rows,
    query.limit,
    await oldestAvailableSeq(q, 'mls_handshakes', query.conversationId),
  );
}

export async function listEnvelopes(q: Queryable, query: ListQuery): Promise<Page<EnvelopeRow>> {
  const { rows } = await q.query<EnvelopeRow>(
    `SELECT seq, epoch, sender_device_id AS "senderDeviceId", ciphertext, created_at AS "createdAt"
     FROM envelopes
     WHERE conversation_id = $1 AND epoch >= $2 AND ($3::integer IS NULL OR epoch < $3) AND seq > $4
     ORDER BY seq LIMIT $5`,
    [
      query.conversationId,
      query.window.fromEpoch,
      query.window.beforeEpoch,
      query.afterSeq,
      query.limit + 1,
    ],
  );
  return toPage(rows, query.limit, await oldestAvailableSeq(q, 'envelopes', query.conversationId));
}

/**
 * A removed device that has read everything its window holds is told so with 403 REMOVED (and
 * `removedAtEpoch`), rather than an empty page for ever: that is how it learns to stop polling.
 * While rows remain it gets them, with `removedAtEpoch` in the response.
 */
export function assertWindowNotExhausted<T>(page: Page<T>, window: ReadWindow): void {
  if (window.removedAtEpoch !== null && page.rows.length === 0) {
    throw removedFromRoom(window.removedAtEpoch);
  }
}
