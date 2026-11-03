import type {
  ContactRequestAction,
  ContactRequestDirection,
  ContactsDirectory,
  DirectoryCircle,
  DirectoryContact,
  DirectoryGroup,
  DirectoryGroupMember,
  DirectoryGroupRole,
  DirectoryRequest,
  DirectoryRequests,
  DirectoryRequestUser,
  DirectoryUserHit,
  DirectoryWriteResult,
  ResolvedDisplay,
} from '../ports/contacts-directory.js';
import { FAKE_USER_ID } from './fake-auth-session.js';

export const FAKE_ACCEPTED_USER_ID = 'fake-accepted-contact';
export const FAKE_STRANGER_USER_ID = 'fake-stranger';
/** The id of the one virtual circle every fake directory has: the "closest people" circle. */
export const FAKE_HOME_CIRCLE_ID = 'fake-home-circle';

const FAKE_TIMESTAMP = '2026-01-01T00:00:00.000Z';

const DEFAULT_ACCEPTED: Readonly<Record<string, ResolvedDisplay>> = {
  [FAKE_ACCEPTED_USER_ID]: { name: 'Fake Contact' },
};
const DEFAULT_STRANGERS: Readonly<Record<string, ResolvedDisplay>> = {
  [FAKE_STRANGER_USER_ID]: { name: 'Fake Stranger' },
};

/** Machine-readable refusals the fake sends, so a test can assert WHY a write was refused. */
export const FAKE_DIRECTORY_REFUSALS = {
  invalidName: 'INVALID_NAME',
  notFound: 'NOT_FOUND',
  notAContact: 'NOT_A_CONTACT',
  alreadyContact: 'ALREADY_CONTACT',
  requestExists: 'REQUEST_EXISTS',
  invalidAction: 'INVALID_ACTION',
  circleIsVirtual: 'CIRCLE_IS_VIRTUAL',
} as const;

const REFUSED = FAKE_DIRECTORY_REFUSALS;

/** Which list a request must be in for an action to apply: you accept what you received, not what you sent. */
const ACTION_DIRECTION: Readonly<Record<ContactRequestAction, ContactRequestDirection>> = {
  accept: 'incoming',
  decline: 'incoming',
  cancel: 'outgoing',
  'parent-approve': 'parent',
  'parent-deny': 'parent',
};
const OK: DirectoryWriteResult = { ok: true };
const refuse = (code: string): DirectoryWriteResult => ({ ok: false, code });

/** The directory plus the one control a test needs: someone else sends the user a request. */
export interface FakeContactsDirectory extends ContactsDirectory {
  /**
   * Makes `fromUserId` send the current user a contact request and returns its id. `parent`
   * makes it a request a parent must decide (it lands in `awaitingParent`).
   */
  receiveRequest(
    fromUserId: string,
    direction?: Extract<ContactRequestDirection, 'incoming' | 'parent'>,
  ): string;
}

export interface FakeContactsDirectoryOptions {
  /** Users who passed the consent gate, with the name they are shown under. */
  readonly accepted?: Readonly<Record<string, ResolvedDisplay>>;
  /** Users who exist and are searchable but have NOT passed the gate. */
  readonly strangers?: Readonly<Record<string, ResolvedDisplay>>;
}

/**
 * In-memory `ContactsDirectory`: exactly the users in `accepted` pass the gate, everyone else
 * (including `FAKE_STRANGER_USER_ID`) cannot be addressed until a request from them is accepted.
 * State lives for the life of the instance, and every write is visible to the next read.
 */
export function createFakeContactsDirectory(
  options: FakeContactsDirectoryOptions = {},
): FakeContactsDirectory {
  const known = new Map<string, ResolvedDisplay>(
    Object.entries({ ...(options.strangers ?? DEFAULT_STRANGERS) }),
  );
  const contacts = new Map<string, DirectoryContact>();
  const circles = new Map<string, DirectoryCircle>();
  const groups = new Map<string, DirectoryGroup>();
  const requests = new Map<string, DirectoryRequest>();
  let nextId = 1;
  const newId = (prefix: string): string => `${prefix}-${nextId++}`;

  const toContact = (userId: string, display: ResolvedDisplay): DirectoryContact => ({
    userId,
    username: userId,
    displayName: display.name,
    avatarUrl: display.avatarUrl ?? null,
    isPrimaryMember: false,
    isPinned: false,
    pinnedAt: null,
    note: null,
    persons: [],
  });
  const toRequestUser = (userId: string): DirectoryRequestUser => {
    const display = contacts.get(userId)?.displayName ?? known.get(userId)?.name ?? userId;
    return { userId, username: userId, displayName: display, avatarUrl: null };
  };

  for (const [userId, display] of Object.entries(options.accepted ?? DEFAULT_ACCEPTED)) {
    contacts.set(userId, toContact(userId, display));
  }
  circles.set(FAKE_HOME_CIRCLE_ID, {
    id: FAKE_HOME_CIRCLE_ID,
    name: 'Home',
    position: -1,
    virtual: true,
    members: [],
    createdAt: null,
  });

  const circleMember = (userId: string) => {
    const contact = contacts.get(userId);
    return {
      userId,
      displayName: contact?.displayName ?? userId,
      avatarUrl: contact?.avatarUrl ?? null,
      username: contact?.username ?? null,
      external: false,
      familyName: null,
    };
  };
  const toGroupMember = (userId: string, role: DirectoryGroupRole): DirectoryGroupMember => {
    const contact = contacts.get(userId);
    return {
      userId,
      displayName: contact?.displayName ?? 'Me',
      avatarUrl: contact?.avatarUrl ?? null,
      username: contact?.username ?? null,
      role,
    };
  };
  const withMember = (
    circle: DirectoryCircle,
    userId: string,
    member: boolean,
  ): DirectoryCircle => {
    const others = circle.members.filter((m) => m.userId !== userId);
    return { ...circle, members: member ? [...others, circleMember(userId)] : others };
  };

  const openRequests = (direction: ContactRequestDirection): DirectoryRequest[] =>
    [...requests.values()].filter((r) => r.status === 'PENDING' && r.direction === direction);

  const resolveRequest = (id: string, patch: Partial<DirectoryRequest>): void => {
    const request = requests.get(id);
    if (request) requests.set(id, { ...request, ...patch, resolvedAt: FAKE_TIMESTAMP });
  };

  const respond = (
    request: DirectoryRequest,
    action: ContactRequestAction,
  ): DirectoryWriteResult => {
    if (request.status !== 'PENDING' || request.direction !== ACTION_DIRECTION[action]) {
      return refuse(REFUSED.invalidAction);
    }
    switch (action) {
      case 'accept': {
        const display = known.get(request.fromUser.userId) ?? {
          name: request.fromUser.displayName,
        };
        contacts.set(request.fromUser.userId, toContact(request.fromUser.userId, display));
        resolveRequest(request.id, { status: 'ACCEPTED' });
        break;
      }
      case 'decline':
        resolveRequest(request.id, { status: 'DECLINED' });
        break;
      case 'cancel':
        resolveRequest(request.id, { status: 'CANCELLED' });
        break;
      case 'parent-approve':
        resolveRequest(request.id, { parentApproval: 'APPROVED', awaitingParent: false });
        break;
      case 'parent-deny':
        resolveRequest(request.id, { parentApproval: 'DENIED', status: 'DECLINED' });
        break;
    }
    return OK;
  };

  const trimmed = (name: string): string => name.trim();

  return {
    async canAddressUser(userId) {
      return contacts.has(userId);
    },
    async resolveDisplay(userId) {
      const contact = contacts.get(userId);
      if (!contact) return null;
      return {
        name: contact.displayName,
        ...(contact.avatarUrl === null ? {} : { avatarUrl: contact.avatarUrl }),
      };
    },

    async listContacts() {
      return [...contacts.values()];
    },
    async listCircles() {
      return [...circles.values()];
    },
    async listGroups() {
      return [...groups.values()];
    },
    async listRequests(): Promise<DirectoryRequests> {
      return {
        incoming: openRequests('incoming'),
        outgoing: openRequests('outgoing'),
        awaitingParent: openRequests('parent'),
      };
    },
    async searchUsers(query) {
      const needle = query.trim().toLowerCase();
      if (needle === '') return [];
      // A contact is also a known user; keying by id keeps one hit per person.
      const everyone = new Map<string, { name: string; avatarUrl: string | null }>();
      for (const [userId, d] of known)
        everyone.set(userId, { name: d.name, avatarUrl: d.avatarUrl ?? null });
      for (const c of contacts.values())
        everyone.set(c.userId, { name: c.displayName, avatarUrl: c.avatarUrl });
      const hits: DirectoryUserHit[] = [];
      for (const [userId, who] of everyone) {
        if (userId.toLowerCase().includes(needle) || who.name.toLowerCase().includes(needle)) {
          hits.push({
            userId,
            username: userId,
            displayName: who.name,
            avatarUrl: who.avatarUrl,
            persons: [],
            isPinned: contacts.get(userId)?.isPinned ?? false,
          });
        }
      }
      return hits;
    },

    async setPinned(userId, pinned) {
      const contact = contacts.get(userId);
      if (!contact) return refuse(REFUSED.notAContact);
      contacts.set(userId, {
        ...contact,
        isPinned: pinned,
        pinnedAt: pinned ? FAKE_TIMESTAMP : null,
      });
      return OK;
    },
    async sendRequest(userId) {
      if (contacts.has(userId)) return refuse(REFUSED.alreadyContact);
      if (!known.has(userId)) return refuse(REFUSED.notFound);
      if (openRequests('outgoing').some((r) => r.toUser.userId === userId)) {
        return refuse(REFUSED.requestExists);
      }
      const id = newId('fake-request');
      requests.set(id, {
        id,
        status: 'PENDING',
        parentApproval: null,
        direction: 'outgoing',
        awaitingParent: false,
        fromUser: toRequestUser(FAKE_USER_ID),
        toUser: toRequestUser(userId),
        createdAt: FAKE_TIMESTAMP,
        resolvedAt: null,
      });
      return OK;
    },
    async respondToRequest(requestId, action) {
      const request = requests.get(requestId);
      return request ? respond(request, action) : refuse(REFUSED.notFound);
    },

    async createCircle(name) {
      if (trimmed(name) === '') return refuse(REFUSED.invalidName);
      const id = newId('fake-circle');
      circles.set(id, {
        id,
        name: trimmed(name),
        position: circles.size,
        virtual: false,
        members: [],
        createdAt: FAKE_TIMESTAMP,
      });
      return OK;
    },
    async renameCircle(circleId, name) {
      const circle = circles.get(circleId);
      if (!circle) return refuse(REFUSED.notFound);
      if (circle.virtual) return refuse(REFUSED.circleIsVirtual);
      if (trimmed(name) === '') return refuse(REFUSED.invalidName);
      circles.set(circleId, { ...circle, name: trimmed(name) });
      return OK;
    },
    async deleteCircle(circleId) {
      const circle = circles.get(circleId);
      if (!circle) return refuse(REFUSED.notFound);
      if (circle.virtual) return refuse(REFUSED.circleIsVirtual);
      circles.delete(circleId);
      return OK;
    },
    async setCircleMembership(circleId, userId, member) {
      const circle = circles.get(circleId);
      if (!circle) return refuse(REFUSED.notFound);
      if (circle.virtual) return refuse(REFUSED.circleIsVirtual);
      if (!contacts.has(userId)) return refuse(REFUSED.notAContact);
      circles.set(circleId, withMember(circle, userId, member));
      return OK;
    },
    async setHomeCircleMembership(userId, inCircle) {
      const home = circles.get(FAKE_HOME_CIRCLE_ID);
      if (!home) return refuse(REFUSED.notFound);
      if (!contacts.has(userId)) return refuse(REFUSED.notAContact);
      circles.set(FAKE_HOME_CIRCLE_ID, withMember(home, userId, inCircle));
      return OK;
    },

    async createGroup(name, memberUserIds) {
      if (trimmed(name) === '') return null;
      const id = newId('fake-group');
      const group: DirectoryGroup = {
        id,
        name: trimmed(name),
        avatarUrl: null,
        createdById: FAKE_USER_ID,
        myRole: 'ADMIN',
        conversationId: null,
        members: [
          toGroupMember(FAKE_USER_ID, 'ADMIN'),
          ...memberUserIds
            .filter((userId) => contacts.has(userId))
            .map((userId) => toGroupMember(userId, 'MEMBER')),
        ],
        createdAt: FAKE_TIMESTAMP,
        updatedAt: FAKE_TIMESTAMP,
      };
      groups.set(id, group);
      return group;
    },
    async renameGroup(groupId, name) {
      const group = groups.get(groupId);
      if (!group) return refuse(REFUSED.notFound);
      if (trimmed(name) === '') return refuse(REFUSED.invalidName);
      groups.set(groupId, { ...group, name: trimmed(name) });
      return OK;
    },
    async deleteGroup(groupId) {
      return groups.delete(groupId) ? OK : refuse(REFUSED.notFound);
    },
    async setGroupMembership(groupId, userId, member) {
      const group = groups.get(groupId);
      if (!group) return refuse(REFUSED.notFound);
      if (member && !contacts.has(userId)) return refuse(REFUSED.notAContact);
      const others = group.members.filter((m) => m.userId !== userId);
      groups.set(groupId, {
        ...group,
        members: member ? [...others, toGroupMember(userId, 'MEMBER')] : others,
      });
      return OK;
    },
    async leaveGroup(groupId) {
      return groups.delete(groupId) ? OK : refuse(REFUSED.notFound);
    },
    async ensureGroupConversation(groupId) {
      const group = groups.get(groupId);
      if (!group) return null;
      const conversationId = group.conversationId ?? newId('fake-conversation');
      groups.set(groupId, { ...group, conversationId });
      return conversationId;
    },

    receiveRequest(fromUserId, direction = 'incoming') {
      const id = newId('fake-request');
      requests.set(id, {
        id,
        status: 'PENDING',
        parentApproval: direction === 'parent' ? 'PENDING' : null,
        direction,
        awaitingParent: direction === 'parent',
        fromUser: toRequestUser(fromUserId),
        toUser: toRequestUser(FAKE_USER_ID),
        createdAt: FAKE_TIMESTAMP,
        resolvedAt: null,
      });
      return id;
    },
  };
}

/** @deprecated The fake under its old name; use `createFakeContactsDirectory`. */
export const createFakePresenceDirectory = createFakeContactsDirectory;
