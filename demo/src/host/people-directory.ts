import type {
  ContactsDirectory,
  DirectoryCircle,
  DirectoryContact,
  DirectoryRequests,
  DirectoryWriteResult,
} from '@masia/contracts';
import type { PersonView } from '../client/session.js';

// The playground's address book, as the messenger's `ContactsDirectory` port: everybody who signed in
// on this server is a contact. There is no consent flow (no requests, no parents, no groups), so those
// calls answer the way a host without the feature does: empty lists, and a refusal for a write.
// Pins and circles are the person's own tidying and live in this tab's memory.

const REFUSED: DirectoryWriteResult = { ok: false, code: 'NOT_IN_THE_PLAYGROUND' };
const OK: DirectoryWriteResult = { ok: true };
const NO_REQUESTS: DirectoryRequests = { incoming: [], outgoing: [], awaitingParent: [] };
const CIRCLE_NAME_MAX = 40;

export interface PeopleDirectory extends ContactsDirectory {
  /** The server's people changed; the next read shows them. */
  setPeople(people: readonly PersonView[]): void;
}

export function createPeopleDirectory(initial: readonly PersonView[] = []): PeopleDirectory {
  let people = initial;
  const pinned = new Map<string, string>();
  const circles = new Map<string, { id: string; name: string; members: Set<string>; createdAt: string }>();
  let next = 1;

  const find = (userId: string) => people.find((person) => person.userId === userId);

  const asContact = (person: PersonView): DirectoryContact => ({
    userId: person.userId,
    username: null,
    displayName: person.displayName,
    avatarUrl: null,
    // The "primary" flag is what lets the pin star be switched off again; it is the only meaning here.
    isPrimaryMember: true,
    isPinned: pinned.has(person.userId),
    pinnedAt: pinned.get(person.userId) ?? null,
    note: null,
    persons: [],
  });

  const asCircle = (circle: { id: string; name: string; members: Set<string>; createdAt: string }, index: number): DirectoryCircle => ({
    id: circle.id,
    name: circle.name,
    position: index,
    virtual: false,
    createdAt: circle.createdAt,
    members: [...circle.members].flatMap((userId) => {
      const person = find(userId);
      return person
        ? [{ userId, displayName: person.displayName, avatarUrl: null, username: null, external: false, familyName: null }]
        : [];
    }),
  });

  return {
    setPeople(list) {
      people = list;
    },
    canAddressUser: async (userId) => find(userId) !== undefined,
    resolveDisplay: async (userId) => {
      const person = find(userId);
      return person ? { name: person.displayName } : null;
    },
    listContacts: async () => people.map(asContact),
    listCircles: async () => [...circles.values()].map(asCircle),
    listGroups: async () => [],
    listRequests: async () => NO_REQUESTS,
    searchUsers: async () => [],

    setPinned: async (userId, value) => {
      if (find(userId) === undefined) return REFUSED;
      if (value) pinned.set(userId, new Date().toISOString());
      else pinned.delete(userId);
      return OK;
    },
    sendRequest: async () => REFUSED,
    respondToRequest: async () => REFUSED,

    createCircle: async (name) => {
      const clean = name.trim().slice(0, CIRCLE_NAME_MAX);
      if (clean === '') return { ok: false, code: 'INVALID_NAME' };
      const id = `circle-${next++}`;
      circles.set(id, { id, name: clean, members: new Set(), createdAt: new Date().toISOString() });
      return OK;
    },
    renameCircle: async (circleId, name) => {
      const circle = circles.get(circleId);
      const clean = name.trim().slice(0, CIRCLE_NAME_MAX);
      if (!circle || clean === '') return REFUSED;
      circle.name = clean;
      return OK;
    },
    deleteCircle: async (circleId) => (circles.delete(circleId) ? OK : REFUSED),
    setCircleMembership: async (circleId, userId, member) => {
      const circle = circles.get(circleId);
      if (!circle || find(userId) === undefined) return REFUSED;
      if (member) circle.members.add(userId);
      else circle.members.delete(userId);
      return OK;
    },
    setHomeCircleMembership: async () => REFUSED,

    createGroup: async () => null,
    renameGroup: async () => REFUSED,
    deleteGroup: async () => REFUSED,
    setGroupMembership: async () => REFUSED,
    leaveGroup: async () => REFUSED,
    ensureGroupConversation: async () => null,
  };
}
