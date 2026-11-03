import { parseMlsHeader, RelayErrorCode } from '@masia/contracts/wire';
import {
  MlsEngineError,
  type GroupState,
  type MemberView,
  type MlsEngine,
  type PendingCommit,
} from '@masia/messenger/mls';
import {
  decodeE2eePayload,
  E2EE_PAYLOAD_VERSION,
  encodeE2eePayload,
  type E2eePayload,
  type E2eePayloadInput,
} from '@masia/messenger/protocol';
import { sameBytes, sha256 } from './bytes.js';
import type { Enrolment } from './enrol.js';
import { mergeHistory, type HistoryItem } from './history.js';
import {
  RelayHttpError,
  type EnvelopeRow,
  type HandshakeRow,
  type RelayApi,
  type WireMemberDelta,
} from './relay-api.js';

// One end-to-end encrypted room, as one browser tab runs it. This is the host half of the MLS engine's
// contract, written out (the engine never talks to the relay; the host does):
//
//   - a commit is stored as a PendingCommit BEFORE it is posted; on 2xx its state is adopted; after a
//     409, a timeout or a lost answer the host asks the relay what it holds for that epoch and calls
//     `adoptPendingCommit`; never a second commit while one is pending;
//   - commits are applied strictly in seq order, and the envelopes of an epoch are read BEFORE the
//     commit that ends it;
//   - an own envelope is never decrypted (MLS deletes the key); what this tab sent is remembered;
//   - a device that joined by a Welcome posts a self-update at once;
//   - a message is sealed once per epoch and re-sent with the same `clientMsgId`; only an epoch
//     conflict re-seals.
//
// All state is in memory and every operation runs under one lock, so a poll, a send and a user action
// never interleave. There is no storage: a reload is a new person.

export type RoomPhase =
  /** Nothing yet: the peer may not have opened the room. */
  | 'probing'
  /** Opening the group and adding the peer. */
  | 'creating'
  /** The group exists on this tab. */
  | 'ready'
  | 'failed';

export interface RoomSnapshot {
  readonly conversationId: string;
  readonly peerUserId: string;
  readonly phase: RoomPhase;
  /** A short, plain line for the person about what the room is waiting for or why it stopped. */
  readonly note: string | undefined;
  readonly history: readonly HistoryItem[];
  /** Typed here and not yet on the relay. */
  readonly queued: readonly E2eePayloadInput[];
  readonly epoch: bigint | undefined;
  readonly epochAuthenticator: Uint8Array | undefined;
  readonly members: readonly MemberView[];
  readonly needsSelfUpdate: boolean;
  /** A commit could not be applied: the room waits for a key refresh. */
  readonly stalled: boolean;
  readonly sending: boolean;
}

export interface RoomDeps {
  readonly engine: MlsEngine;
  readonly api: RelayApi;
  readonly self: Enrolment;
  readonly peerUserId: string;
  readonly conversationId: string;
  readonly onChange: () => void;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Where two people meet: the same id on both sides, whoever opens it first. */
export function conversationIdOf(userA: string, userB: string): string {
  const [low, high] = userA < userB ? [userA, userB] : [userB, userA];
  return `dm_${low}_${high}`;
}

/** How often a half-opened room retries to add its peer (a claim is rate limited by the relay). */
export const ADD_RETRY_MS = 15_000;
/** How often a chat the person opened retries to open its room after a failure. */
const CREATE_RETRY_MS = 5_000;
const POST_ATTEMPTS = 3;
const SEAL_ATTEMPTS = 5;
const NO_DELTA: WireMemberDelta = { added: [], removed: [] };

interface PendingPost {
  readonly pending: PendingCommit;
  readonly nextState: GroupState;
  readonly commit: Uint8Array;
  readonly builtOnEpoch: bigint;
  readonly memberDelta: WireMemberDelta;
  readonly newTreeHash: Uint8Array;
  readonly welcome?: Uint8Array;
}

interface Queued {
  readonly input: E2eePayloadInput;
  sealed?: { readonly epoch: number; readonly ciphertext: Uint8Array };
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function describe(error: unknown): string {
  if (error instanceof RelayHttpError) return `${error.code} (${error.status})`;
  if (error instanceof MlsEngineError) return error.code;
  return error instanceof Error ? error.message : String(error);
}

export class Room {
  private readonly engine: MlsEngine;
  private readonly api: RelayApi;
  private readonly self: Enrolment;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  private group: GroupState | undefined;
  private pending: PendingPost | undefined;
  private phase: RoomPhase = 'probing';
  private note: string | undefined;
  private history: readonly HistoryItem[] = [];
  private outbox: Queued[] = [];
  private handshakeCursor = 0;
  private envelopeCursor = 0;
  private stalled = false;
  private sending = false;
  /** This tab opened the group and still owes the peer the Add. */
  private owesAdd = false;
  private nextAddAt = 0;
  /** The person opened this chat and nobody has opened the room yet: this tab may open it. */
  private wanted = false;
  private nextCreateAt = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private syncing = false;
  private current: RoomSnapshot;

  constructor(private readonly deps: RoomDeps) {
    this.engine = deps.engine;
    this.api = deps.api;
    this.self = deps.self;
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? defaultSleep;
    this.current = this.build();
  }

  get conversationId(): string {
    return this.deps.conversationId;
  }
  get peerUserId(): string {
    return this.deps.peerUserId;
  }

  snapshot(): RoomSnapshot {
    return this.current;
  }

  // --- Public operations ---------------------------------------------------------------------------

  /** The person opened this chat: join it if the peer opened it first, else open it. */
  open(): Promise<void> {
    return this.exclusive(async () => {
      this.wanted = true;
      if (this.group === undefined) await this.tryJoin();
      if (this.group === undefined && this.phase !== 'failed') await this.create();
      await this.settle();
    });
  }

  /** The periodic step: look for a Welcome, read what arrived, post what waits. Skipped when one is running. */
  sync(): Promise<void> {
    if (this.syncing) return Promise.resolve();
    this.syncing = true;
    return this.exclusive(async () => {
      try {
        if (this.group === undefined && this.phase !== 'failed') await this.tryJoin();
        // A chat the person opened whose room could not be opened yet: try again, not too often.
        if (this.group === undefined && this.wanted && this.phase === 'probing' && this.now() >= this.nextCreateAt) {
          this.nextCreateAt = this.now() + CREATE_RETRY_MS;
          await this.create();
        }
        await this.settle();
      } finally {
        this.syncing = false;
      }
    });
  }

  /** Queues a message and sends it as soon as the room can. Throws only for a payload that can never be sent. */
  send(input: E2eePayloadInput): Promise<void> {
    const encoded = encodeE2eePayload(input);
    if (!encoded.ok) return Promise.reject(new Error(encoded.error.code));
    this.outbox = [...this.outbox, { input }];
    this.changed();
    return this.exclusive(() => this.settle());
  }

  // --- The lock and the snapshot -------------------------------------------------------------------

  private exclusive<T>(job: () => Promise<T>): Promise<T> {
    const run = this.tail.then(job, job);
    this.tail = run.catch(() => undefined);
    return run;
  }

  private build(): RoomSnapshot {
    const group = this.group;
    return {
      conversationId: this.deps.conversationId,
      peerUserId: this.deps.peerUserId,
      phase: this.phase,
      note: this.note,
      history: this.history,
      queued: this.outbox.map((entry) => entry.input),
      epoch: group === undefined ? undefined : this.engine.epoch(group),
      epochAuthenticator: group === undefined ? undefined : this.engine.epochAuthenticator(group),
      members: group === undefined ? [] : this.engine.members(group),
      needsSelfUpdate: group !== undefined && this.engine.needsSelfUpdate(group),
      stalled: this.stalled,
      sending: this.sending,
    };
  }

  private changed(): void {
    const next = this.build();
    // A poll that found nothing builds an equal view: keep the old object, so a screen is not redrawn
    // every few seconds and a reader that compares by identity sees no change.
    if (sameView(this.current, next)) return;
    this.current = next;
    this.deps.onChange();
  }

  private fail(note: string): void {
    this.phase = 'failed';
    this.note = note;
    this.changed();
  }

  // --- One pass: everything this room owes, in order -----------------------------------------------

  private async settle(): Promise<void> {
    if (this.phase === 'failed' || this.group === undefined) {
      this.changed();
      return;
    }
    try {
      if (this.owesAdd) await this.addPeer();
      await this.pull();
      await this.selfUpdateIfOwed();
      await this.flush();
      if (this.phase === 'ready' && !this.owesAdd && !this.stalled) this.note = undefined;
    } catch (error) {
      // A relay hiccup or a refusal: the room stays as it was and the next pass tries again.
      this.note = `Waiting to reach the relay: ${describe(error)}`;
    }
    this.changed();
  }

  // --- Joining --------------------------------------------------------------------------------------

  /** If the peer opened this room and added us, this tab's Welcome is in the handshake log. */
  private async tryJoin(): Promise<void> {
    let rows: readonly HandshakeRow[];
    try {
      rows = (await this.api.listHandshakes(this.conversationId, { fromEpoch: 0, afterSeq: 0 })).rows;
    } catch (error) {
      // Not a member (or no such room): the same answer. Nothing to join yet.
      if (error instanceof RelayHttpError && error.code === RelayErrorCode.NOT_A_MEMBER) return;
      throw error;
    }
    const welcome = rows.find((row) => row.kind === 'WELCOME');
    if (welcome === undefined) return;
    const commit =
      rows.find((row) => row.kind === 'COMMIT' && row.seq === welcome.seq - 1) ??
      rows.find((row) => row.kind === 'COMMIT' && row.epoch === welcome.epoch);
    if (commit === undefined) return this.fail('The room has a Welcome but not the commit that made it.');

    // The Welcome names no group in the clear; the commit beside it does, in its MLS header.
    let groupId: Uint8Array;
    try {
      const header = parseMlsHeader(commit.bytes);
      if (!('groupId' in header)) throw new Error('not a group message');
      groupId = header.groupId;
    } catch {
      return this.fail('The room opened with a commit this tab cannot read.');
    }

    let lastError: unknown;
    for (const keyPackagePrivate of [...this.self.keyPackagePrivates].reverse()) {
      try {
        const joined = await this.engine.joinFromWelcome({
          welcome: welcome.bytes,
          keyPackagePrivate,
          expectedConversationId: this.conversationId,
          expectedGroupId: groupId,
          expectedEpoch: BigInt(welcome.epoch) + 1n,
        });
        this.group = joined.state;
        this.handshakeCursor = welcome.seq;
        this.phase = 'ready';
        this.note = undefined;
        this.changed();
        return;
      } catch (error) {
        if (!(error instanceof MlsEngineError)) throw error;
        lastError = error;
      }
    }
    this.fail(`This tab could not open the Welcome (${describe(lastError)}).`);
  }

  // --- Creating -------------------------------------------------------------------------------------

  private async create(): Promise<void> {
    this.phase = 'creating';
    this.note = 'Opening the room…';
    this.changed();
    const { state, groupId } = await this.engine.createGroup({
      conversationId: this.conversationId,
      selfLeaf: this.self.keys,
    });
    try {
      await this.api.openRoom(this.conversationId, {
        groupId,
        // The relay keeps this value without reading it; the engine has no tree-hash accessor, so
        // the playground sends a hash of the epoch authenticator (same size, same stability).
        treeHash: await sha256(this.engine.epochAuthenticator(state)),
      });
    } catch (error) {
      if (error instanceof RelayHttpError && error.code === RelayErrorCode.CONVERSATION_EXISTS) {
        // The peer got there first. Their Welcome for this tab is on its way: this tab only joins.
        this.wanted = false;
        this.phase = 'probing';
        this.note = 'The other person is setting this chat up. It opens by itself.';
        this.changed();
        return;
      }
      this.phase = 'probing';
      this.note = `Could not open the room: ${describe(error)}`;
      this.changed();
      return;
    }
    this.group = state;
    this.phase = 'ready';
    this.owesAdd = true;
    this.note = 'Adding the other person…';
    this.changed();
  }

  /** Claims the peer's key package, adds it, posts the commit with its Welcome. */
  private async addPeer(): Promise<void> {
    if (this.now() < this.nextAddAt || this.group === undefined) return;
    this.nextAddAt = this.now() + ADD_RETRY_MS;
    const claimed = await this.api.claimKeyPackages(this.peerUserId);
    if (claimed.length === 0) {
      this.note = 'The other person has no key package yet. Trying again…';
      return;
    }
    const added = await this.engine.add({
      state: this.group,
      keyPackages: claimed.map((row) => row.bytes),
    });
    const byDevice = new Map(claimed.map((row) => [row.deviceId, row]));
    this.pending = {
      pending: added.pendingCommit,
      nextState: added.state,
      commit: added.commit,
      builtOnEpoch: this.engine.epoch(this.group),
      memberDelta: {
        removed: [],
        added: added.memberDelta.added.map((member) => ({
          deviceId: member.deviceId,
          userId: member.userId,
          role: member.role,
          keyPackageId: byDevice.get(member.deviceId)?.keyPackageId ?? '',
        })),
      },
      newTreeHash: await sha256(this.engine.epochAuthenticator(added.state)),
      welcome: added.welcome,
    };
    if (await this.postPending()) {
      this.owesAdd = false;
      this.note = undefined;
    }
  }

  // --- Commits of our own ---------------------------------------------------------------------------

  /** A device that joined by a Welcome owes one self-update (post-compromise security). */
  private async selfUpdateIfOwed(): Promise<void> {
    const group = this.group;
    if (group === undefined || this.pending !== undefined || this.stalled || this.owesAdd) return;
    if (!this.engine.isActive(group) || !this.engine.needsSelfUpdate(group)) return;
    const updated = await this.engine.selfUpdate(group);
    this.pending = {
      pending: updated.pendingCommit,
      nextState: updated.state,
      commit: updated.commit,
      builtOnEpoch: this.engine.epoch(group),
      memberDelta: NO_DELTA,
      newTreeHash: await sha256(this.engine.epochAuthenticator(updated.state)),
    };
    await this.postPending();
  }

  /** Posts the stored commit. True when this tab's commit is the relay's and its state is adopted. */
  private async postPending(): Promise<boolean> {
    const post = this.pending;
    if (post === undefined || this.group === undefined) return false;
    for (let attempt = 0; attempt < POST_ATTEMPTS; attempt += 1) {
      try {
        const receipt = await this.api.postHandshake(this.conversationId, {
          expectedEpoch: Number(post.builtOnEpoch),
          senderDeviceId: this.self.deviceId,
          bytes: post.commit,
          memberDelta: post.memberDelta,
          newTreeHash: post.newTreeHash,
          ...(post.welcome === undefined ? {} : { welcome: post.welcome }),
        });
        this.group = post.nextState;
        this.pending = undefined;
        this.handshakeCursor = Math.max(this.handshakeCursor, receipt.seq);
        this.changed();
        return true;
      } catch (error) {
        if (!(error instanceof RelayHttpError)) throw error;
        const lostAnswer = error.status === 0 || error.status >= 500;
        if (!lostAnswer && error.code !== RelayErrorCode.EPOCH_CONFLICT) throw error;
        // The commit may or may not be on the relay: ask what it holds for that epoch.
        const outcome = await this.resolvePending(post);
        if (outcome === 'adopted') return true;
        if (outcome === 'lost') return false;
        if (!lostAnswer) return false;
        await this.sleep(500 * 2 ** attempt);
      }
    }
    return false;
  }

  /** `adoptPendingCommit` against what the relay holds: our commit won, or another one did. */
  private async resolvePending(post: PendingPost): Promise<'adopted' | 'lost' | 'absent'> {
    if (this.group === undefined) return 'absent';
    const page = await this.api.listHandshakes(this.conversationId, {
      fromEpoch: Number(post.builtOnEpoch),
      afterSeq: this.handshakeCursor,
    });
    const held = page.rows.find(
      (row) => row.kind === 'COMMIT' && row.epoch === Number(post.builtOnEpoch),
    );
    if (held === undefined) return 'absent';
    const result = await this.engine.adoptPendingCommit(this.group, post.pending, held.bytes);
    this.pending = undefined;
    if (result.adopted) {
      this.group = result.state;
      this.handshakeCursor = Math.max(this.handshakeCursor, held.seq);
      return 'adopted';
    }
    return 'lost';
  }

  // --- Reading --------------------------------------------------------------------------------------

  /** Applies the commits the relay holds past our cursor, reading each epoch's envelopes before it ends. */
  private async pull(): Promise<void> {
    if (this.group === undefined || this.pending !== undefined) return;
    const epoch = Number(this.engine.epoch(this.group));
    const handshakes = await this.api.listHandshakes(this.conversationId, {
      fromEpoch: epoch,
      afterSeq: this.handshakeCursor,
    });
    const envelopes = await this.api.listEnvelopes(this.conversationId, { afterSeq: this.envelopeCursor });
    const commits = handshakes.rows.filter((row) => row.kind === 'COMMIT');
    this.stalled = false;

    let next = 0;
    const readUpTo = async (upToEpoch: number): Promise<void> => {
      while (next < envelopes.rows.length) {
        const row = envelopes.rows[next];
        if (row === undefined || row.epoch > upToEpoch) return;
        next += 1;
        await this.readEnvelope(row);
      }
    };

    for (const [index, row] of commits.entries()) {
      if (this.group === undefined) return;
      const here = Number(this.engine.epoch(this.group));
      if (row.epoch < here) {
        this.handshakeCursor = Math.max(this.handshakeCursor, row.seq);
        continue;
      }
      if (row.epoch > here) {
        this.stalled = true; // a commit between is missing (the relay's retention cut it)
        break;
      }
      if (row.senderDeviceId === this.self.deviceId) {
        this.fail('A commit of this tab is on the relay but its state is gone. Reload to start over.');
        return;
      }
      await readUpTo(row.epoch);
      try {
        const applied = await this.engine.processCommit({
          state: this.group,
          commit: row.bytes,
          servedMemberDelta: row.memberDelta ?? NO_DELTA,
          backlog: index < commits.length - 1,
          acceptedAtMs: Date.parse(row.createdAt),
        });
        this.group = applied.state;
        this.handshakeCursor = Math.max(this.handshakeCursor, row.seq);
        if (applied.removedFromGroup) {
          this.fail('This device was removed from the room.');
          return;
        }
      } catch (error) {
        if (!(error instanceof MlsEngineError)) throw error;
        this.stalled = true;
        this.note = `A key update could not be applied yet (${error.code}). Retrying…`;
        break;
      }
    }
    if (this.group !== undefined) await readUpTo(Number(this.engine.epoch(this.group)));
    this.changed();
  }

  private async readEnvelope(row: EnvelopeRow): Promise<void> {
    this.envelopeCursor = Math.max(this.envelopeCursor, row.seq);
    // This tab's own messages are already in the history from the moment they were sent.
    if (row.senderDeviceId === this.self.deviceId || this.group === undefined) return;
    let item: HistoryItem;
    try {
      const opened = await this.engine.decrypt(this.group, row.ciphertext);
      this.group = opened.state;
      const payload = decodeE2eePayload(opened.plaintext);
      const base = {
        seq: row.seq,
        senderUserId: opened.sender.userId,
        senderDeviceId: opened.sender.deviceId,
        createdAt: row.createdAt,
      };
      item = payload.ok ? { ...base, payload: payload.value } : { ...base, unreadable: payload.error.code };
    } catch (error) {
      if (!(error instanceof MlsEngineError)) throw error;
      item = {
        seq: row.seq,
        senderUserId: this.peerUserId,
        senderDeviceId: row.senderDeviceId,
        createdAt: row.createdAt,
        unreadable: error.code,
      };
    }
    this.history = mergeHistory(this.history, [item]);
  }

  // --- Sending --------------------------------------------------------------------------------------

  /** Seals and posts the queue, oldest first. A relay that cannot be reached leaves the rest queued. */
  private async flush(): Promise<void> {
    let conflicts = 0;
    while (this.outbox.length > 0 && this.group !== undefined && this.engine.isActive(this.group)) {
      if (this.pending !== undefined || this.owesAdd || this.engine.needsSelfUpdate(this.group)) break;
      const entry = this.outbox[0];
      if (entry === undefined) break;
      const epoch = Number(this.engine.epoch(this.group));
      if (entry.sealed === undefined || entry.sealed.epoch !== epoch) {
        const bytes = encodeE2eePayload(entry.input);
        if (!bytes.ok) {
          this.outbox = this.outbox.slice(1);
          continue;
        }
        const sealed = await this.engine.encrypt(this.group, bytes.value);
        this.group = sealed.state; // always adopt: the ratchet moved
        entry.sealed = { epoch, ciphertext: sealed.ciphertext };
      }
      this.sending = true;
      this.changed();
      try {
        const receipt = await this.api.postEnvelope(this.conversationId, {
          epoch: entry.sealed.epoch,
          senderDeviceId: this.self.deviceId,
          ciphertext: entry.sealed.ciphertext,
          clientMsgId: entry.input.id,
        });
        const payload = { ...entry.input, v: E2EE_PAYLOAD_VERSION } as E2eePayload;
        this.history = mergeHistory(this.history, [
          {
            seq: receipt.seq,
            senderUserId: this.self.userId,
            senderDeviceId: this.self.deviceId,
            createdAt: new Date(this.now()).toISOString(),
            payload,
          },
        ]);
        this.outbox = this.outbox.slice(1);
      } catch (error) {
        if (!(error instanceof RelayHttpError)) throw error;
        if (error.code === RelayErrorCode.EPOCH_CONFLICT && conflicts < SEAL_ATTEMPTS) {
          // The room moved on while this was in flight: apply what won, then seal again.
          conflicts += 1;
          entry.sealed = undefined;
          await this.pull();
          continue;
        }
        if (error.status === 0 || error.status >= 500 || error.code === RelayErrorCode.EPOCH_CONFLICT) break;
        // A refusal the next try would repeat (too large, not a member): it leaves the queue.
        this.outbox = this.outbox.slice(1);
        this.note = `A message was refused: ${describe(error)}`;
      } finally {
        this.sending = false;
      }
    }
  }
}

/** Whether two views would draw the same screen (the engine's byte views are compared by content). */
function sameView(a: RoomSnapshot, b: RoomSnapshot): boolean {
  return (
    a.phase === b.phase &&
    a.note === b.note &&
    a.history === b.history &&
    a.queued.length === b.queued.length &&
    a.queued.every((entry, index) => entry === b.queued[index]) &&
    a.epoch === b.epoch &&
    a.needsSelfUpdate === b.needsSelfUpdate &&
    a.stalled === b.stalled &&
    a.sending === b.sending &&
    (a.epochAuthenticator === undefined || b.epochAuthenticator === undefined
      ? a.epochAuthenticator === b.epochAuthenticator
      : sameBytes(a.epochAuthenticator, b.epochAuthenticator)) &&
    a.members.length === b.members.length &&
    a.members.every((member, index) => member.deviceId === b.members[index]?.deviceId)
  );
}
