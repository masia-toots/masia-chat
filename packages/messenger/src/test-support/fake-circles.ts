/**
 * Fixtures for the people menu's DOM tests: ONE shape of "a person / a circle / a request / the
 * circles owner" instead of a hand-rolled copy in every test. Plain data plus `vi.fn`s; the tests
 * own their mocks.
 */
import { vi } from 'vitest';
import type {
  Circle,
  CircleMember,
  Contact,
  ContactCircles,
  ContactRequest,
  Group,
  Groups,
  UserSearchHit,
} from '../contacts/index.js';

/** The id the tests give the host's virtual home circle ("Family"). */
export const HOME_CIRCLE_ID = 'home';

export const contact = (
  userId: string,
  displayName: string,
  isPinned: boolean,
  isPrimaryMember: boolean,
  username: string | null = userId,
): Contact => ({
  userId,
  displayName,
  username,
  avatarUrl: null,
  isPinned,
  isPrimaryMember,
  pinnedAt: isPinned ? '2026-01-01T00:00:00Z' : null,
  note: null,
  persons: [],
});

export const seat = (userId: string, external = false): CircleMember => ({
  userId,
  displayName: userId,
  avatarUrl: null,
  username: userId,
  external,
  familyName: null,
});

export const circle = (id: string, name: string, members: CircleMember[], virtual = false): Circle => ({
  id,
  name,
  position: virtual ? -1 : 0,
  virtual,
  createdAt: null,
  members,
});

const requestUser = (userId: string) => ({ userId, displayName: userId, username: userId, avatarUrl: null });

const request = (
  id: string,
  direction: ContactRequest['direction'],
  from: string,
  to: string,
  awaitingParent: boolean,
): ContactRequest => ({
  id,
  status: 'PENDING',
  parentApproval: awaitingParent ? 'PENDING' : null,
  direction,
  awaitingParent,
  fromUser: requestUser(from),
  toUser: requestUser(to),
  createdAt: '2026-01-01T00:00:00Z',
  resolvedAt: null,
});

export const incomingRequest = (id: string, from: string): ContactRequest =>
  request(id, 'incoming', from, 'me', false);

export const outgoingRequest = (id: string, to: string, awaitingParent = false): ContactRequest =>
  request(id, 'outgoing', 'me', to, awaitingParent);

export const parentRequest = (id: string, from: string, to: string): ContactRequest =>
  request(id, 'parent', from, to, true);

export const hit = (userId: string, displayName: string, username = userId): UserSearchHit => ({
  userId,
  displayName,
  username,
  avatarUrl: null,
  persons: [],
  isPinned: false,
});

const ok = async (): Promise<boolean> => true;

/** The circles owner, every mutation a `vi.fn` the test can assert on. */
export function makeCircles(
  over: Partial<{
    circles: Circle[];
    contacts: Contact[];
    incoming: ContactRequest[];
    outgoing: ContactRequest[];
    awaitingParent: ContactRequest[];
    searchUsers: (q: string) => Promise<UserSearchHit[]>;
  }> = {},
): { data: ContactCircles; fns: ReturnType<typeof circleFns> } {
  const fns = circleFns(over.searchUsers);
  const data: ContactCircles = {
    circles: over.circles ?? [],
    contacts: over.contacts ?? [],
    requests: {
      incoming: over.incoming ?? [],
      outgoing: over.outgoing ?? [],
      awaitingParent: over.awaitingParent ?? [],
    },
    loading: false,
    reload: async () => undefined,
    ...fns,
  };
  return { data, fns };
}

function circleFns(searchUsers?: (q: string) => Promise<UserSearchHit[]>) {
  return {
    setPinned: vi.fn(ok),
    setMembership: vi.fn(ok),
    setInHomeCircle: vi.fn(async (): Promise<{ ok: boolean; code?: string }> => ({ ok: true })),
    createCircle: vi.fn(ok),
    renameCircle: vi.fn(ok),
    deleteCircle: vi.fn(ok),
    sendRequest: vi.fn(ok),
    actOnRequest: vi.fn(ok),
    searchUsers: vi.fn(searchUsers ?? (async (): Promise<UserSearchHit[]> => [])),
  };
}

export const group = (
  id: string,
  name: string,
  members: Array<{ userId: string; role?: 'ADMIN' | 'MEMBER' }>,
  myRole: 'ADMIN' | 'MEMBER' = 'ADMIN',
  conversationId: string | null = null,
): Group => ({
  id,
  name,
  avatarUrl: null,
  createdById: 'me',
  myRole,
  conversationId,
  members: members.map((m) => ({
    userId: m.userId,
    displayName: m.userId,
    avatarUrl: null,
    username: m.userId,
    role: m.role ?? 'MEMBER',
  })),
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
});

/** The groups owner, every mutation a `vi.fn`. */
export function makeGroups(groups: Group[] = []): { data: Groups; fns: ReturnType<typeof groupFns> } {
  const fns = groupFns();
  return {
    data: { groups, loading: false, reload: async () => undefined, ...fns },
    fns,
  };
}

function groupFns() {
  return {
    createGroup: vi.fn(async (_name: string, _members: string[]): Promise<Group | null> => null),
    renameGroup: vi.fn(ok),
    deleteGroup: vi.fn(ok),
    setMembership: vi.fn(ok),
    leaveGroup: vi.fn(ok),
    ensureConversation: vi.fn(async (): Promise<string | null> => null),
  };
}
