/**
 * How the host wants a user shown in the room list and thread headers.
 *
 * Why: names and avatars live in the host's own directory; the messenger renders them but never
 * stores or invents them.
 */
export interface ResolvedDisplay {
  readonly name: string;
  readonly avatarUrl?: string;
}

// ── The people the user may talk to ──────────────────────────────────────────────────────────────
//
// Plain data, no host API types: the shapes below are what the messenger reads, whatever wire format
// the host speaks to get them. Fields are `readonly` all the way down so a consumer cannot mutate a
// directory answer in place.

/** A person a user belongs to in the host's own grouping (in Masia: a family member), for labelling. */
export interface DirectoryPerson {
  readonly personId: string;
  readonly familyId: string;
  readonly familyName: string;
  readonly name: string;
  readonly avatarUrl: string | null;
}

/** An accepted contact: someone the current user may address. */
export interface DirectoryContact {
  readonly userId: string;
  readonly username: string | null;
  readonly displayName: string;
  readonly avatarUrl: string | null;
  /** Belongs to the user's own closest group in the host (Masia: the primary family). */
  readonly isPrimaryMember: boolean;
  /** Pinned to the user's channel bank; since when is `pinnedAt`. */
  readonly isPinned: boolean;
  readonly pinnedAt: string | null;
  readonly note: string | null;
  readonly persons: readonly DirectoryPerson[];
}

/** One hit of the global handle search. */
export interface DirectoryUserHit {
  readonly userId: string;
  readonly username: string;
  readonly displayName: string;
  readonly avatarUrl: string | null;
  readonly persons: readonly DirectoryPerson[];
  readonly isPinned: boolean;
}

/** A seat in a circle. `external` = the person belongs to another family than the user's. */
export interface DirectoryCircleMember {
  readonly userId: string;
  readonly displayName: string;
  readonly avatarUrl: string | null;
  readonly username: string | null;
  readonly external: boolean;
  readonly familyName: string | null;
}

/** A named circle of contacts. A `virtual` circle is computed by the host and has no stored row. */
export interface DirectoryCircle {
  readonly id: string;
  readonly name: string;
  readonly position: number;
  readonly virtual: boolean;
  readonly members: readonly DirectoryCircleMember[];
  readonly createdAt: string | null;
}

/** The roles a person can hold in a group. */
export type DirectoryGroupRole = 'ADMIN' | 'MEMBER';

export interface DirectoryGroupMember {
  readonly userId: string;
  readonly displayName: string;
  readonly avatarUrl: string | null;
  readonly username: string | null;
  readonly role: DirectoryGroupRole;
}

/** A group the user is a member of. `conversationId` is null until its chat was first opened. */
export interface DirectoryGroup {
  readonly id: string;
  readonly name: string;
  readonly avatarUrl: string | null;
  readonly createdById: string;
  readonly myRole: DirectoryGroupRole;
  readonly conversationId: string | null;
  readonly members: readonly DirectoryGroupMember[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

// ── Contact requests (the consent flow) ──────────────────────────────────────────────────────────

export type ContactRequestStatus = 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'CANCELLED';

/** The parent's decision on a request a child made or received; null when no parent is involved. */
export type ContactRequestParentApproval = 'PENDING' | 'APPROVED' | 'DENIED' | null;

/** Which list a request belongs to for the current user. */
export type ContactRequestDirection = 'incoming' | 'outgoing' | 'parent';

/** A closed list, so no caller invents an action the host would have to guess at. */
export const CONTACT_REQUEST_ACTIONS = [
  'accept',
  'decline',
  'cancel',
  'parent-approve',
  'parent-deny',
] as const;
export type ContactRequestAction = (typeof CONTACT_REQUEST_ACTIONS)[number];

export interface DirectoryRequestUser {
  readonly userId: string;
  readonly username: string | null;
  readonly displayName: string;
  readonly avatarUrl: string | null;
}

export interface DirectoryRequest {
  readonly id: string;
  readonly status: ContactRequestStatus;
  readonly parentApproval: ContactRequestParentApproval;
  readonly direction: ContactRequestDirection;
  /** Both people said yes and a parent has not decided yet. */
  readonly awaitingParent: boolean;
  readonly fromUser: DirectoryRequestUser;
  readonly toUser: DirectoryRequestUser;
  readonly createdAt: string;
  readonly resolvedAt: string | null;
}

/** The three request lists, read together because they change together. */
export interface DirectoryRequests {
  readonly incoming: readonly DirectoryRequest[];
  readonly outgoing: readonly DirectoryRequest[];
  readonly awaitingParent: readonly DirectoryRequest[];
}

/**
 * The outcome of one write. `ok: false` means the host refused it; `code` is the host's reason when
 * it sent one, so the UI can word it («they have to accept you first») instead of shrugging.
 */
export interface DirectoryWriteResult {
  readonly ok: boolean;
  readonly code?: string;
}

// ── The port ─────────────────────────────────────────────────────────────────────────────────────

/**
 * The host's answer to "who may I address, what do they look like, and what is my address book?".
 *
 * Why: the gate that decides whether two people may talk (the contact-request / consent flow)
 * lives on the host side, because it depends on the host's accounts, circles and parental rules.
 * The messenger asks before it requests another user's key packages, and never builds its own
 * address book. A `false` answer is final for that moment; it is not an error.
 *
 * Reads reject when the host cannot be reached. Writes resolve `{ ok: false }` when the host
 * refuses and may reject when it cannot be reached; a caller handles both as "did not happen".
 * Every write leaves the next read showing its effect.
 *
 * It grew out of `PresenceDirectory` (the first two methods) when the contacts, circles, groups and
 * requests screens moved into the messenger package: those screens are the gate's user interface,
 * so they read and write through the same port.
 */
export interface ContactsDirectory {
  /** True when the current user may start or join an encrypted conversation with `userId`. */
  canAddressUser(userId: string): Promise<boolean>;
  /** The display data for `userId`, or `null` when the host does not know (or will not say). */
  resolveDisplay(userId: string): Promise<ResolvedDisplay | null>;

  // Reads
  listContacts(): Promise<readonly DirectoryContact[]>;
  listCircles(): Promise<readonly DirectoryCircle[]>;
  listGroups(): Promise<readonly DirectoryGroup[]>;
  listRequests(): Promise<DirectoryRequests>;
  /**
   * The global handle search. `query` arrives trimmed, without a leading `@` and long enough to be
   * worth asking (the messenger enforces the minimum); the host decides the page size.
   */
  searchUsers(query: string): Promise<readonly DirectoryUserHit[]>;

  // Writes: contacts and requests
  /** Pin (or unpin) an accepted contact to the channel bank. */
  setPinned(userId: string, pinned: boolean): Promise<DirectoryWriteResult>;
  sendRequest(userId: string): Promise<DirectoryWriteResult>;
  respondToRequest(requestId: string, action: ContactRequestAction): Promise<DirectoryWriteResult>;

  // Writes: circles
  createCircle(name: string): Promise<DirectoryWriteResult>;
  renameCircle(circleId: string, name: string): Promise<DirectoryWriteResult>;
  deleteCircle(circleId: string): Promise<DirectoryWriteResult>;
  setCircleMembership(
    circleId: string,
    userId: string,
    member: boolean,
  ): Promise<DirectoryWriteResult>;
  /**
   * Put a contact into (or out of) the host's built-in "closest people" circle. It is virtual, so it
   * has no row to write to; the host keeps that state wherever it likes.
   */
  setHomeCircleMembership(userId: string, inCircle: boolean): Promise<DirectoryWriteResult>;

  // Writes: groups
  /** The created group, or `null` when the host refused. */
  createGroup(name: string, memberUserIds: readonly string[]): Promise<DirectoryGroup | null>;
  renameGroup(groupId: string, name: string): Promise<DirectoryWriteResult>;
  deleteGroup(groupId: string): Promise<DirectoryWriteResult>;
  setGroupMembership(
    groupId: string,
    userId: string,
    member: boolean,
  ): Promise<DirectoryWriteResult>;
  leaveGroup(groupId: string): Promise<DirectoryWriteResult>;
  /** Get-or-create the group's chat and return its conversation id; idempotent. `null` on refusal. */
  ensureGroupConversation(groupId: string): Promise<string | null>;
}

/**
 * The port under its old name.
 *
 * @deprecated Use `ContactsDirectory`. Kept for one release so a host still importing the old name
 * keeps compiling; note that the type now carries the whole address book, not only the gate.
 */
export type PresenceDirectory = ContactsDirectory;
