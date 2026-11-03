import {
  type AdminScope,
  createTtlCounter,
  EpochConflictError,
  HandshakeKind,
  MAX_REBASES,
  NO_ADMIN_SCOPE,
  REBASE_WINDOW_MS,
  RelayError,
  RelayErrorCode,
} from '@masia/relay';
import type { Database, Queryable } from './db.js';
import { findDevice } from './domain/devices.js';
import {
  applyMemberDelta,
  assertAddsClaimedBy,
  assertMemberDeltaAllowed,
  type DeclaredMemberDelta,
  type MemberDelta,
} from './domain/member-delta.js';
import {
  assertEnvelopeHeader,
  assertHandshakeHeader,
  assertWelcomeHeader,
  type RoomHeaderFacts,
} from './domain/mls-header-check.js';
import { assertCurrentMember, findMembership, notAMember, SEQ_COUNTER } from './domain/rooms.js';

/**
 * THE EPOCH SERIALIZER (ADR-117 §2). The relay is the one place that decides the order in which a
 * group's handshake messages happen, because MLS needs every member to apply the same commits in
 * the same order, and two commits built on the same epoch cannot both win.
 *
 * Every write to a conversation's group state goes through here, and each is ONE transaction that
 * first takes `SELECT … FOR UPDATE` on the conversation's row. That lock is the whole mechanism:
 * it turns concurrent requests into a queue, so "is the epoch still the one you built on?" and
 * "advance it" cannot be separated by another request. The loser finds the epoch already moved and
 * gets a 409 carrying the current epoch; its client rebases on the winner's commit and resends.
 * The same row hands out the seq numbers (`handshake_seq`, `envelope_seq`): a counter that only
 * moves forward, so a seq is never handed out twice even after retention deleted the rows behind it.
 *
 * What the relay can and cannot be trusted with: it orders and stores opaque bytes and enforces the
 * rules below; it cannot read a commit. A relay that withholds or reorders commits is caught by the
 * clients (epoch + tree hash in every application message's AAD, ADR-117 H5), and by the rebase
 * limit, which makes a client that keeps losing show a security state instead of retrying for ever.
 *
 * The order of refusals in every write is the same on purpose: the room exists -> a RETRY of
 * something this very device already stored gets the original answer (a lost response must not
 * turn into a 409 or a duplicate) -> the sender is a current member (else 403 NOT_A_MEMBER or
 * REMOVED, nothing leaked) -> the sender built on the current epoch (else 409, an honest stale
 * message is told to rebase, not that it is malformed) -> the MLSMessage header matches the room
 * and the kind of message (422) -> the declared member changes are allowed (422/403).
 */

export interface HandshakeReceipt {
  /** The epoch the group is in after this message (the next one, for a commit). */
  readonly epoch: number;
  /** Position of the message in the conversation's total handshake order. */
  readonly seq: number;
  /** `true` when this answers a retry of a commit already stored: nothing was written. */
  readonly replayed: boolean;
}

export interface CommitInput {
  readonly conversationId: string;
  /** The authenticated device: the route has already checked it against the token. */
  readonly senderDeviceId: string;
  /** From the token (`actor` + `adminOf` + `guardianOf`). A body can never carry it. */
  readonly admin: AdminScope;
  /** The epoch the sender built this commit on. */
  readonly expectedEpoch: number;
  readonly bytes: Buffer;
  /**
   * What the sender declares the commit adds and removes. Stored beside it as sent, and every Add
   * must name a key package the sender's own device claimed.
   */
  readonly memberDelta: DeclaredMemberDelta;
  readonly newTreeHash: Buffer;
  /**
   * Welcome for the devices this commit adds; stored with the commit, in the same transaction.
   * There is no GroupInfo companion: external joins are out of scope in phase 1 (review section 2).
   */
  readonly welcome?: Buffer;
}

export interface CreateGroupInput {
  readonly conversationId: string;
  readonly groupId: Buffer;
  readonly treeHash: Buffer;
  /** The device creating the group; it becomes the first member, at epoch 0. */
  readonly creatorDeviceId: string;
}

export interface CreateGroupReceipt {
  readonly epoch: number;
  /** `true` when this answers a retry by the same creator of the same group: nothing was written. */
  readonly replayed: boolean;
}

export interface AppendEnvelopeInput {
  readonly conversationId: string;
  readonly senderDeviceId: string;
  /** The epoch the ciphertext was encrypted in; it must be the group's current epoch. */
  readonly epoch: number;
  readonly ciphertext: Buffer;
  /**
   * The sender's own id for this message. When given, a second post with the same id from the same
   * device is answered with the original seq instead of being stored again.
   */
  readonly clientMsgId?: string;
}

export interface EnvelopeReceipt {
  readonly seq: number;
  /** `true` when this answers a retry (same `clientMsgId`, same ciphertext): nothing was written. */
  readonly replayed: boolean;
}

export interface EpochSerializer {
  createGroup(input: CreateGroupInput): Promise<CreateGroupReceipt>;
  /** Appends a commit and advances the epoch by one. 409 if `expectedEpoch` is not current. */
  commitHandshake(input: CommitInput): Promise<HandshakeReceipt>;
  appendEnvelope(input: AppendEnvelopeInput): Promise<EnvelopeReceipt>;
}

export interface EpochSerializerOptions {
  readonly now?: () => number;
}

const FIRST_EPOCH = 0;

/** The row every write locks: the room's group, its epoch and its seq counters. */
interface LockedRoom extends RoomHeaderFacts {
  readonly creatorDeviceId: string | null;
}

/** Takes the conversation lock. 403 NOT_A_MEMBER for a room that does not exist. */
async function lockRoom(tx: Queryable, conversationId: string): Promise<LockedRoom> {
  const { rows } = await tx.query<LockedRoom>(
    `SELECT epoch, group_id AS "groupId", creator_device_id AS "creatorDeviceId"
     FROM conversation_e2ee WHERE conversation_id = $1 FOR UPDATE`,
    [conversationId],
  );
  const room = rows[0];
  if (room === undefined) throw notAMember();
  return room;
}

/** The sender is a current member. Checked BEFORE the epoch: a stranger learns nothing, not even the epoch. */
async function requireSender(
  tx: Queryable,
  conversationId: string,
  senderDeviceId: string,
): Promise<void> {
  assertCurrentMember(await findMembership(tx, conversationId, senderDeviceId));
}

function assertEpoch(room: LockedRoom, epoch: number): void {
  if (epoch !== room.epoch) throw new EpochConflictError(room.epoch);
}

/**
 * Hands out `count` consecutive seq numbers of `table` for the conversation and returns the first.
 * Under the room lock, so two writers can never be handed the same number.
 */
async function allocateSeq(
  tx: Queryable,
  table: keyof typeof SEQ_COUNTER,
  conversationId: string,
  count: number,
): Promise<number> {
  const counter = SEQ_COUNTER[table];
  const { rows } = await tx.query<{ last: number }>(
    `UPDATE conversation_e2ee SET ${counter} = ${counter} + $2
     WHERE conversation_id = $1 RETURNING ${counter} AS last`,
    [conversationId, count],
  );
  const last = rows[0]?.last;
  if (last === undefined) throw notAMember(); // unreachable under the lock: the row was just read
  return last - count + 1;
}

/**
 * A commit this device already stored at `expectedEpoch` with exactly these bytes: the client's
 * retry of a request whose answer it lost. Matching on sender AND bytes means a device can only
 * ever be answered from its own commit; anyone else's retry, or a different commit, is a real 409.
 */
async function findStoredCommit(
  tx: Queryable,
  input: Pick<CommitInput, 'conversationId' | 'senderDeviceId' | 'expectedEpoch' | 'bytes'>,
): Promise<number | null> {
  const { rows } = await tx.query<{ seq: number }>(
    `SELECT seq FROM mls_handshakes
     WHERE conversation_id = $1 AND epoch = $2 AND kind = $3 AND sender_device_id = $4 AND bytes = $5`,
    [
      input.conversationId,
      input.expectedEpoch,
      HandshakeKind.COMMIT,
      input.senderDeviceId,
      input.bytes,
    ],
  );
  return rows[0]?.seq ?? null;
}

async function insertHandshake(
  tx: Queryable,
  row: {
    conversationId: string;
    epoch: number;
    seq: number;
    kind: HandshakeKind;
    senderDeviceId: string;
    bytes: Buffer;
    /** What the sender declared; `null` for a WELCOME, which is not a statement about members. */
    memberDelta: DeclaredMemberDelta | null;
  },
): Promise<void> {
  await tx.query(
    `INSERT INTO mls_handshakes (conversation_id, epoch, seq, kind, sender_device_id, bytes, member_delta_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      row.conversationId,
      row.epoch,
      row.seq,
      row.kind,
      row.senderDeviceId,
      row.bytes,
      row.memberDelta === null ? null : JSON.stringify(row.memberDelta),
    ],
  );
}

/** A commit that passed admission, or the receipt of the identical commit already stored. */
type Admission =
  | { readonly replay: HandshakeReceipt }
  | { readonly replay: null; readonly room: LockedRoom };

/**
 * Everything a commit must pass before anything is written, in the order the module comment gives.
 * Runs inside the transaction, with the room locked for the rest of it.
 */
async function admitHandshake(tx: Queryable, input: CommitInput): Promise<Admission> {
  const room = await lockRoom(tx, input.conversationId);
  if (input.expectedEpoch < room.epoch) {
    const seq = await findStoredCommit(tx, input);
    if (seq !== null) return { replay: { epoch: input.expectedEpoch + 1, seq, replayed: true } };
  }
  await requireSender(tx, input.conversationId, input.senderDeviceId);
  assertEpoch(room, input.expectedEpoch);
  assertHandshakeHeader(input.bytes, room);
  if (input.welcome !== undefined) assertWelcomeHeader(input.welcome);
  const committer = await findDevice(tx, input.senderDeviceId);
  await assertMemberDeltaAllowed(tx, {
    conversationId: input.conversationId,
    delta: input.memberDelta,
    remover: { scope: input.admin, device: committer },
  });
  await assertAddsClaimedBy(tx, {
    committerDeviceId: input.senderDeviceId,
    added: input.memberDelta.added,
  });
  return { replay: null, room };
}

export function createEpochSerializer(
  db: Database,
  options: EpochSerializerOptions = {},
): EpochSerializer {
  // Consecutive lost races per (conversation, device). The key is injective because ids never
  // contain ':' (ID_PATTERN).
  const lostRaces = createTtlCounter({
    ttlMs: REBASE_WINDOW_MS,
    window: 'sliding',
    now: options.now,
  });

  /**
   * Counts a lost race against the sender, and turns the (MAX_REBASES + 1)-th in a row into 429.
   * A success wipes the count. Only epoch conflicts count: a refusal for any other reason says
   * nothing about the sender racing the group.
   */
  async function withRebaseLimit<T>(key: string, attempt: () => Promise<T>): Promise<T> {
    try {
      const result = await attempt();
      lostRaces.reset(key);
      return result;
    } catch (error) {
      if (error instanceof EpochConflictError && lostRaces.hit(key).count > MAX_REBASES) {
        throw new RelayError(
          RelayErrorCode.REBASE_LIMIT,
          'Too many consecutive epoch conflicts; the group state needs a security check.',
          { currentEpoch: error.currentEpoch, maxRebases: MAX_REBASES },
        );
      }
      throw error;
    }
  }

  return {
    async createGroup(input) {
      return db.transaction(async (tx) => {
        const inserted = await tx.query(
          `INSERT INTO conversation_e2ee (conversation_id, group_id, epoch, tree_hash, creator_device_id)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT DO NOTHING`,
          [input.conversationId, input.groupId, FIRST_EPOCH, input.treeHash, input.creatorDeviceId],
        );
        // No conflict target on purpose: the conversation id AND the group id are both unique.
        if ((inserted.rowCount ?? 0) === 0) {
          // The same creator opening the same group of the same conversation again is a retry of
          // a request whose answer it lost: it gets the original answer. Anything else is taken.
          const existing = await tx.query<{ groupId: Buffer; creatorDeviceId: string | null }>(
            `SELECT group_id AS "groupId", creator_device_id AS "creatorDeviceId"
             FROM conversation_e2ee WHERE conversation_id = $1`,
            [input.conversationId],
          );
          const room = existing.rows[0];
          if (
            room !== undefined &&
            room.creatorDeviceId === input.creatorDeviceId &&
            room.groupId.equals(input.groupId)
          ) {
            return { epoch: FIRST_EPOCH, replayed: true };
          }
          throw new RelayError(
            RelayErrorCode.CONVERSATION_EXISTS,
            'That conversation or MLS group already exists on this relay.',
          );
        }

        // The creator becomes the first member, and is held to the same rule as anyone added later:
        // its device must be on its owner's signed list.
        const creator = await findDevice(tx, input.creatorDeviceId);
        if (creator === null) throw notAMember();
        const delta: MemberDelta = {
          added: [{ deviceId: creator.id, userId: creator.userId, role: creator.role }],
          removed: [],
        };
        await assertMemberDeltaAllowed(tx, {
          conversationId: input.conversationId,
          delta,
          remover: { scope: NO_ADMIN_SCOPE, device: null },
        });
        await applyMemberDelta(tx, {
          conversationId: input.conversationId,
          delta,
          newEpoch: FIRST_EPOCH,
        });
        return { epoch: FIRST_EPOCH, replayed: false };
      });
    },

    commitHandshake(input) {
      return withRebaseLimit(`${input.conversationId}:${input.senderDeviceId}`, () =>
        db.transaction(async (tx) => {
          const admission = await admitHandshake(tx, input);
          if (admission.replay !== null) return admission.replay;
          const { epoch } = admission.room;

          // The commit and its Welcome share one epoch label (the epoch they were built on) and
          // take consecutive positions, so a reader replaying by seq sees them together. The
          // declared delta is stored on the commit row only: it is a statement about the commit.
          const messages: Array<{
            kind: HandshakeKind;
            bytes: Buffer;
            memberDelta: DeclaredMemberDelta | null;
          }> = [{ kind: HandshakeKind.COMMIT, bytes: input.bytes, memberDelta: input.memberDelta }];
          if (input.welcome !== undefined) {
            messages.push({ kind: HandshakeKind.WELCOME, bytes: input.welcome, memberDelta: null });
          }
          const commitSeq = await allocateSeq(
            tx,
            'mls_handshakes',
            input.conversationId,
            messages.length,
          );
          for (const [offset, message] of messages.entries()) {
            await insertHandshake(tx, {
              conversationId: input.conversationId,
              epoch,
              seq: commitSeq + offset,
              kind: message.kind,
              senderDeviceId: input.senderDeviceId,
              bytes: message.bytes,
              memberDelta: message.memberDelta,
            });
          }

          const newEpoch = epoch + 1;
          await tx.query(
            `UPDATE conversation_e2ee SET epoch = $2, tree_hash = $3, updated_at = now()
             WHERE conversation_id = $1`,
            [input.conversationId, newEpoch, input.newTreeHash],
          );
          await applyMemberDelta(tx, {
            conversationId: input.conversationId,
            delta: input.memberDelta,
            newEpoch,
          });
          return { epoch: newEpoch, seq: commitSeq, replayed: false };
        }),
      );
    },

    appendEnvelope(input) {
      return db.transaction(async (tx) => {
        // Same lock as a commit: an envelope for epoch N can never slip in after the commit that
        // left N, so no ciphertext is ever filed under an epoch the group has already moved past.
        const room = await lockRoom(tx, input.conversationId);
        if (input.clientMsgId !== undefined) {
          const stored = await tx.query<{ seq: number; ciphertext: Buffer }>(
            `SELECT seq, ciphertext FROM envelopes
             WHERE conversation_id = $1 AND sender_device_id = $2 AND client_msg_id = $3`,
            [input.conversationId, input.senderDeviceId, input.clientMsgId],
          );
          const previous = stored.rows[0];
          if (previous !== undefined) {
            if (!previous.ciphertext.equals(input.ciphertext)) {
              throw new RelayError(
                RelayErrorCode.CLIENT_MSG_ID_REUSED,
                'This device already sent a different message with that clientMsgId.',
                { seq: previous.seq },
              );
            }
            return { seq: previous.seq, replayed: true };
          }
        }
        await requireSender(tx, input.conversationId, input.senderDeviceId);
        assertEpoch(room, input.epoch);
        // Only an MLS PrivateMessage of this group and epoch is stored as an envelope: the relay
        // must never hold (or serve) something that is not ciphertext of this room.
        assertEnvelopeHeader(input.ciphertext, room);
        const seq = await allocateSeq(tx, 'envelopes', input.conversationId, 1);
        await tx.query(
          `INSERT INTO envelopes (conversation_id, epoch, seq, sender_device_id, client_msg_id, ciphertext)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            input.conversationId,
            input.epoch,
            seq,
            input.senderDeviceId,
            input.clientMsgId ?? null,
            input.ciphertext,
          ],
        );
        return { seq, replayed: false };
      });
    },
  };
}
