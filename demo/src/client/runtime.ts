import {
  createTsMlsEngine,
  generateIdentityKeyPair,
  type GuardianPolicy,
} from '@masia/messenger/mls';
import type { E2eePayloadInput } from '@masia/messenger/protocol';
import { createRelayDirectory } from './directory.js';
import { enrol, type Enrolment } from './enrol.js';
import { createRelayApi, type RelayApi } from './relay-api.js';
import { conversationIdOf, Room, type RoomSnapshot } from './room.js';
import {
  createTokenSource,
  fetchPeople,
  RELAY_BASE,
  signIn,
  type PersonView,
} from './session.js';

// One tab's whole client: sign in, make keys, enrol, then keep every room it knows in step with the
// relay. It is a small external store (`subscribe` + `getSnapshot`) so React reads it with
// `useSyncExternalStore`; nothing in here touches the DOM, so the same code runs in a Node smoke test.
//
// The relay has no "list my rooms" call, so the playground uses a rule both sides can compute: a chat
// between two people lives in the room `dm_<smaller id>_<larger id>`. A tab asks about that room for
// everyone it can see, and a Welcome addressed to it is how a chat from someone else arrives.

/** How often a tab looks at the relay. */
export const POLL_MS = 2_500;
/** Most people a tab asks about each round (one request each); a playground has a handful. */
export const PROBE_MAX = 12;

/** Family rules do not exist here: nobody administers anybody, nobody is a child. */
const NO_FAMILY: GuardianPolicy = {
  isAdminOf: () => false,
  isMinor: () => false,
  guardianOwnerOf: () => undefined,
};

export interface ChatSummary {
  readonly conversationId: string;
  readonly peerUserId: string;
  readonly peerName: string;
  readonly unread: number;
  readonly room: RoomSnapshot;
}

export interface RuntimeSnapshot {
  readonly self: { readonly userId: string; readonly deviceId: string; readonly displayName: string };
  readonly people: readonly PersonView[];
  /** Chats this tab opened or was invited to, newest activity first. */
  readonly chats: readonly ChatSummary[];
  /** Why the people list could not be read, when it could not. */
  readonly problem: string | undefined;
}

export interface PlaygroundRuntime {
  readonly self: Enrolment;
  subscribe(listener: () => void): () => void;
  getSnapshot(): RuntimeSnapshot;
  /** A room's state, or undefined for a conversation this tab has never heard of. */
  roomSnapshot(conversationId: string): RoomSnapshot | undefined;
  /** The conversation id of the chat with `peerUserId` (the same on both sides). */
  conversationWith(peerUserId: string): string;
  /** The person opened the chat with `peerUserId`: join it, or open it. Returns its conversation id. */
  open(peerUserId: string): string;
  send(conversationId: string, input: E2eePayloadInput): Promise<void>;
  nameOf(userId: string): string | undefined;
  /** The person is looking at this chat: everything in it so far counts as read. */
  markSeen(conversationId: string): void;
  /** One round of polling now (tests, and the smoke driver). */
  pollOnce(): Promise<void>;
  stop(): void;
}

export interface StartInput {
  readonly name: string;
  /** The page's origin, for a runtime that is not in a browser. Empty in the page. */
  readonly origin?: string;
  readonly fetch?: typeof fetch;
  readonly pollMs?: number;
  /** False in tests: no timer, the caller drives `pollOnce`. */
  readonly autoPoll?: boolean;
  /** Tests: the relay's client for this person, in place of the HTTP one (a relay kept in memory). */
  readonly createApi?: (who: { readonly userId: string; readonly deviceId: string }) => RelayApi;
}

export async function startRuntime(input: StartInput): Promise<PlaygroundRuntime> {
  const origin = (input.origin ?? '').replace(/\/+$/, '');
  const baseFetch = input.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const doFetch: typeof fetch = (url, init) =>
    baseFetch(typeof url === 'string' && url.startsWith('/') ? `${origin}${url}` : url, init);

  const signedIn = await signIn(input.name, doFetch);
  const tokens = createTokenSource(signedIn.session, doFetch);
  const api =
    input.createApi?.(signedIn) ??
    createRelayApi({ baseUrl: `${origin}${RELAY_BASE}`, token: (force) => tokens.token(force), fetch: baseFetch });

  // The person's identity key comes first: the directory pins it as this tab's own, and the engine
  // needs the directory before it can make a key package.
  const identity = await generateIdentityKeyPair();
  const directory = createRelayDirectory({
    api,
    self: { userId: signedIn.userId, identityKey: identity.publicKey },
    renewToken: async () => {
      tokens.invalidate();
      await tokens.token(true);
    },
  });
  const engine = await createTsMlsEngine({ directory, policy: NO_FAMILY, now: () => Date.now() });
  const self = await enrol({
    engine,
    api,
    userId: signedIn.userId,
    deviceId: signedIn.deviceId,
    displayName: signedIn.displayName,
    identity,
  });

  const names = new Map<string, string>([[self.userId, self.displayName]]);
  const rooms = new Map<string, Room>();
  const opened = new Set<string>();
  const seen = new Map<string, number>();
  const listeners = new Set<() => void>();
  let people: readonly PersonView[] = [];
  let problem: string | undefined;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const selfView = { userId: self.userId, deviceId: self.deviceId, displayName: self.displayName };

  function unreadIn(room: RoomSnapshot): number {
    const after = seen.get(room.conversationId) ?? 0;
    return room.history.filter((item) => item.senderUserId !== self.userId && item.seq > after).length;
  }

  function build(): RuntimeSnapshot {
    const chats: ChatSummary[] = [];
    for (const [conversationId, room] of rooms) {
      const view = room.snapshot();
      if (!opened.has(conversationId) && view.epoch === undefined) continue;
      chats.push({
        conversationId,
        peerUserId: room.peerUserId,
        peerName: names.get(room.peerUserId) ?? room.peerUserId,
        unread: unreadIn(view),
        room: view,
      });
    }
    chats.sort((a, b) => lastActivity(b.room) - lastActivity(a.room));
    return { self: selfView, people, chats, problem };
  }

  let snapshot = build();
  function notify(): void {
    snapshot = build();
    for (const listener of listeners) listener();
  }

  function ensureRoom(peerUserId: string): Room {
    const conversationId = conversationIdOf(self.userId, peerUserId);
    let room = rooms.get(conversationId);
    if (room === undefined) {
      room = new Room({ engine, api, self, peerUserId, conversationId, onChange: notify });
      rooms.set(conversationId, room);
    }
    return room;
  }

  async function refreshPeople(): Promise<void> {
    try {
      const next = await fetchPeople(signedIn.session, doFetch);
      // Someone new: the token this tab holds does not introduce them yet, so it is replaced.
      if (next.some((person) => !names.has(person.userId))) tokens.invalidate();
      for (const person of next) names.set(person.userId, person.displayName);
      const changed =
        next.length !== people.length || next.some((person, i) => person.userId !== people[i]?.userId);
      // The list object is replaced only when the people changed, so a reader that compares by identity
      // (the address book reloads on it) is not woken by every poll.
      const recovered = problem !== undefined;
      if (changed) people = next;
      problem = undefined;
      if (changed || recovered) notify();
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      if (text !== problem) {
        problem = text;
        notify();
      }
    }
  }

  async function pollOnce(): Promise<void> {
    await refreshPeople();
    for (const person of people.slice(0, PROBE_MAX)) ensureRoom(person.userId);
    // A room nobody has joined is asked about only while the other person is here; a chat that exists
    // (opened here, or with an epoch) keeps being read.
    const here = new Set(people.map((person) => person.userId));
    const live = [...rooms.values()].filter(
      (room) =>
        here.has(room.peerUserId) || opened.has(room.conversationId) || room.snapshot().epoch !== undefined,
    );
    await Promise.allSettled(live.map((room) => room.sync()));
  }

  function schedule(): void {
    if (stopped || input.autoPoll === false) return;
    timer = setTimeout(() => {
      void pollOnce().finally(schedule);
    }, input.pollMs ?? POLL_MS);
  }
  void pollOnce().finally(schedule);

  return {
    self,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    roomSnapshot: (conversationId) =>
      snapshot.chats.find((chat) => chat.conversationId === conversationId)?.room,
    conversationWith: (peerUserId) => conversationIdOf(self.userId, peerUserId),
    open(peerUserId) {
      const room = ensureRoom(peerUserId);
      opened.add(room.conversationId);
      notify();
      void room.open();
      return room.conversationId;
    },
    send(conversationId, payload) {
      const room = rooms.get(conversationId);
      return room === undefined ? Promise.reject(new Error('NO_SUCH_CHAT')) : room.send(payload);
    },
    nameOf: (userId) => names.get(userId),
    markSeen(conversationId) {
      const room = rooms.get(conversationId)?.snapshot();
      const newest = room?.history.reduce((max, item) => Math.max(max, item.seq), 0) ?? 0;
      if (newest > (seen.get(conversationId) ?? 0)) {
        seen.set(conversationId, newest);
        notify();
      }
    },
    pollOnce,
    stop() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

function lastActivity(room: RoomSnapshot): number {
  const last = room.history[room.history.length - 1];
  return last === undefined ? 0 : Date.parse(last.createdAt) || 0;
}
