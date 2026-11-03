/**
 * Messenger contacts model (ADR-039 two-level design):
 *   contact (person · group · Masia · family) → its conversations.
 *
 * The sidebar lists CONTACTS (this module derives them); the chat window
 * shows the PARTICULAR chats for the selected contact. Pure functions over plain data: no React,
 * no network, no host constants — a window size or a label comes in as an argument.
 */
import type { EntityType, MessengerConversationPreview } from '../protocol/conversations.js';

/**
 * A person's status in a family, as the host's members API sends it (ADR-110 guests · ADR-186 contributors).
 * This package talks to its host only through `@masia/contracts`, so the union is spelled here; the host
 * asserts at compile time that it equals its own `Membership`, so a new status cannot reach one side silently.
 */
export type FamilyMembership = 'MEMBER' | 'GUEST' | 'CONTRIBUTOR';

/** `{ outsiderStatus }` for anyone but a full member; nothing for a member or an absent status (a badge is not a gate). */
function outsiderStatusOf(membership: FamilyMembership | undefined): Pick<MessengerContact, 'outsiderStatus'> {
  return membership && membership !== 'MEMBER' ? { outsiderStatus: membership } : {};
}

export interface FamilyMemberLite {
  id: string;
  name: string;
  avatarUrl: string | null;
  type: 'HUMAN' | 'AGENT' | 'PET';
  isChild?: boolean;
  /** Membership status (guests К5 · contributors ADR-186): an outsider status → the picker badges this contact. */
  membership?: FamilyMembership;
  /** The account behind the person, when they have one (`personSchema.userId`).
   *  Read only to keep one human off the row twice (ADR-115 К3). */
  userId?: string | null;
}

export interface GroupLite {
  id: string;
  name: string;
  avatarUrl: string | null;
}

export type ContactKind = 'MASIA' | 'FAMILY' | 'MEMBER' | 'GROUP' | 'CONTACT';

/**
 * An accepted CONTACT (ADR-115) — the shape `GET /api/users/me/contacts`
 * returns, narrowed to what the bank needs. A member of my primary family
 * arrives on the SAME endpoint with `isPrimaryMember: true`.
 *
 * 🔴 That member USED to be dropped here in favour of the `/families/:id/members`
 * seat. Since ADR-116 the opposite is true — see `buildContacts`: a human with
 * an account who is an accepted contact is seated by `u_<userId>`, because their
 * DM is the one homeless conversation of the pair and only the USER id addresses
 * it. `p_`/`m_` (a personId) is now for people WITHOUT an account.
 */
export interface ContactLite {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  username: string | null;
  isPrimaryMember: boolean;
  /** `PinnedContact` — is this contact pinned to the bank, and since when (ordering of the pins). */
  isPinned?: boolean;
  pinnedAt?: string | null;
}

export interface MessengerContact {
  /** Stable route key (`/messenger/:contactKey`). */
  key: string;
  kind: ContactKind;
  entityType: EntityType;
  /**
   * personId for MEMBER, groupId for GROUP, **userId for CONTACT**; sentinel
   * otherwise. A contact from another family has no person in mine, so the user
   * is the only id both inboxes share (see `getEntityConversations`).
   */
  id: string;
  name: string;
  avatarUrl: string | null;
  /** Masia (AI) — its chats use the AI chat path, not P2P messenger. */
  isAi: boolean;
  /** An outsider of the family (guest К5 · contributor ADR-186) — the picker badges them by THIS status. Absent = a member. */
  outsiderStatus?: Exclude<FamilyMembership, 'MEMBER'>;
}

const MASIA_KEY = 'masia';
const FAMILY_KEY = 'family';
/** Route prefix for a CONTACT plate: `u_<userId>` (ADR-115 К3). */
const CONTACT_PREFIX = 'u_';

/** Route key for an accepted contact — the one home for this encoding. */
export function contactRouteKey(userId: string): string {
  return `${CONTACT_PREFIX}${userId}`;
}

/** Conversations belonging to a given contact entity (the entity decides how a conversation is matched). */
export function getEntityConversations(
  entityType: EntityType,
  id: string,
  conversations: MessengerConversationPreview[],
  selfPersonId: string | undefined,
  selfUserId?: string | undefined,
): MessengerConversationPreview[] {
  switch (entityType) {
    case 'MASIA':
      // canon chat §10 — the pinned primary Masia conversation sorts FIRST so
      // opening /messenger/masia (incl. the avatar tap-to-expand) lands on it.
      return conversations
        .filter((c) => c.type === 'AI_CHAT')
        .sort((a, b) => (b.isPrimary ? 1 : 0) - (a.isPrimary ? 1 : 0));
    case 'FAMILY_GROUP':
      return conversations.filter((c) => c.type === 'FAMILY');
    case 'FAMILY_MEMBER':
      return conversations.filter(
        (c) =>
          c.type === 'DIRECT' &&
          c.participants.some((p) => p.personId === id && p.personId !== selfPersonId),
      );
    // 🔴 A CONTACT IS MATCHED BY USER, NOT BY PERSON (ADR-115 К3). Both branches
    // used to share the `personId` filter, which silently returned NOTHING for a
    // cross-family contact: they have no Person in my family, so no `personId` I
    // hold can ever equal theirs. `id` is their USER id here, and the inbox now
    // projects `participants[].userId` (`messenger.service.ts`) so the seat can
    // be read. The self-exclusion is by user for the same reason.
    case 'CONTACT':
      return conversations.filter(
        (c) =>
          c.type === 'DIRECT' &&
          c.participants.some((p) => !!p.userId && p.userId === id && p.userId !== selfUserId),
      );
    case 'GROUP':
      return conversations.filter((c) => c.groupId === id);
    default:
      return [];
  }
}

/** Total unread across a contact's conversations. */
export function contactUnread(
  contact: MessengerContact,
  conversations: MessengerConversationPreview[],
  selfPersonId: string | undefined,
  selfUserId?: string | undefined,
): number {
  return getEntityConversations(
    contact.entityType,
    contact.id,
    conversations,
    selfPersonId,
    selfUserId,
  ).reduce((sum, c) => sum + c.unreadCount, 0);
}

/**
 * Build the ordered contact list: Masia, Family, members, **accepted contacts**,
 * groups.
 *
 * `contacts` (ADR-115 К3) are the founder's «пікнуті контакти» — accepted
 * contacts, which since ADR-116 includes every member of my primary family who
 * has an account. `seatContacts` then reorders the whole row by recency, so this
 * function only ever states the BASE order; it never seats anybody (§12.1).
 *
 * ## 🔴 ONE HUMAN, ONE PLATE — and `u_` wins (ADR-116 §3, 2026-09-06)
 *
 * The same person can reach this function twice: as a `Person` in `members`
 * (`m_<personId>`) and as a `ContactLite` (`u_<userId>`). Before ADR-116 the
 * member seat won and the contact was dropped. That is now backwards, and not as
 * a matter of taste:
 *
 *   · a DM between two people who both have accounts and are contacts is ONE
 *     homeless conversation (`familyId: null`, seats carrying `userId`) —
 *     `ensureDirectConversation` itself delegates to `ensureContactConversation`,
 *     so this is true no matter which endpoint the client asks;
 *   · `getEntityConversations('FAMILY_MEMBER', …)` finds that conversation by
 *     `participants[].personId`, and the seat's person is whichever person the
 *     server resolved for them — not necessarily the one in MY family. The
 *     member plate would therefore show an EMPTY chat while the conversation
 *     exists. `CONTACT` matches by `userId`, which is the one id both inboxes
 *     agree on.
 *
 * So: a human who is in `contacts` is seated as `u_<userId>` even when they are
 * also a family member; `m_<personId>` survives for a person WITHOUT an account
 * (a child with no login), whose DM really is family-homed. The member's
 * POSITION is kept — only their key changes — so the row does not reshuffle when
 * a member signs up.
 *
 * ## Friends of the family sit right after the family (ADR-116 rule 1)
 *
 * `familyCircleUserIds` are the contacts I flagged into my virtual «Родина»
 * circle. They are not family, but I said they belong beside it, so they open
 * the tail of the people — ahead of my other contacts and behind every member.
 * This is a BASE order only: `seatContacts` still ranks the tail by recency and
 * falls back to this order for anyone never talked to.
 */
export function buildContacts(
  members: FamilyMemberLite[],
  groups: GroupLite[],
  labels: { masia: string; family: string },
  selfPersonId: string | undefined,
  contacts: readonly ContactLite[] = [],
  familyCircleUserIds: ReadonlySet<string> = new Set(),
): MessengerContact[] {
  const agent = members.find((m) => m.type === 'AGENT');
  const masia: MessengerContact = {
    key: MASIA_KEY,
    kind: 'MASIA',
    entityType: 'MASIA',
    id: agent?.id ?? MASIA_KEY,
    name: agent?.name ?? labels.masia,
    avatarUrl: agent?.avatarUrl ?? null,
    isAi: true,
  };

  const family: MessengerContact = {
    key: FAMILY_KEY,
    kind: 'FAMILY',
    entityType: 'FAMILY_GROUP',
    id: FAMILY_KEY,
    name: labels.family,
    avatarUrl: null,
    isAi: false,
  };

  const contactByUserId = new Map(contacts.map((c) => [c.userId, c]));

  /** One accepted contact → the `u_` plate that addresses their ONE DM. */
  const contactPlate = (c: ContactLite, membership?: FamilyMembership): MessengerContact => ({
    key: contactRouteKey(c.userId),
    kind: 'CONTACT',
    entityType: 'CONTACT' as EntityType,
    id: c.userId,
    name: c.displayName,
    avatarUrl: c.avatarUrl,
    isAi: false,
    ...outsiderStatusOf(membership),
  });

  // The family's own people, IN THEIR ORDER — but keyed by whichever id actually
  // addresses their chat (see the docblock). `seatedUserIds` records who was
  // spent here so the contact tail below cannot seat them a second time.
  const seatedUserIds = new Set<string>();
  const memberContacts: MessengerContact[] = members
    .filter((m) => m.type === 'HUMAN' && m.id !== selfPersonId)
    .map((m) => {
      const asContact = m.userId ? contactByUserId.get(m.userId) : undefined;
      if (asContact) {
        seatedUserIds.add(asContact.userId);
        // The member's own display name and avatar are the family's view of them
        // and stay; only the KEY (and with it the conversation lookup) changes.
        return {
          ...contactPlate(asContact, m.membership),
          name: m.name,
          avatarUrl: m.avatarUrl,
        };
      }
      return {
        key: `m_${m.id}`,
        kind: 'MEMBER' as const,
        entityType: 'FAMILY_MEMBER' as EntityType,
        id: m.id,
        name: m.name,
        avatarUrl: m.avatarUrl,
        isAi: false,
        ...outsiderStatusOf(m.membership),
      };
    });

  // The rest of my contacts, «friends of the family» first (ADR-116 rule 1).
  //
  // `isPrimaryMember` who did NOT turn up in `members` is dropped, exactly as
  // before: `GET /users/me/contacts` computes my PRIMARY family's people whatever
  // family I am standing in, so keeping them would drop my relatives into another
  // family's bank. Their one DM is still reachable from here — through the circles
  // door, which lists every contact — this row just shows the family I am in.
  const restContacts = contacts.filter((c) => !seatedUserIds.has(c.userId) && !c.isPrimaryMember);
  const crossFamilyContacts: MessengerContact[] = [
    ...restContacts.filter((c) => familyCircleUserIds.has(c.userId)),
    ...restContacts.filter((c) => !familyCircleUserIds.has(c.userId)),
  ].map((c) => contactPlate(c));

  const groupContacts: MessengerContact[] = groups.map((g) => ({
    key: `g_${g.id}`,
    kind: 'GROUP',
    entityType: 'GROUP',
    id: g.id,
    name: g.name,
    avatarUrl: g.avatarUrl,
    isAi: false,
  }));

  return [masia, family, ...memberContacts, ...crossFamilyContacts, ...groupContacts];
}

/**
 * SEATING — the host's chat canon §12.1 (private; summarised in docs/canon.md §6), the rule the one-row header is built on.
 *
 *   Seat 1 = the LIVE contact (it sits immediately beside its name).
 *   Masia is PINNED to the highest non-live seat — so she is never lower than SECOND.
 *   Everyone else follows by RECENCY (`recency`, most-recent key first).
 *
 * Why not sort the whole row by recency: a row of unlabelled ~33 px faces is tapped from spatial
 * memory, and an order that changes on every selection never lets that memory form. Pinning Masia
 * keeps the most-used target spatially fixed while the tail still self-organises.
 *
 * 🔴 This function is PURE — it reorders nothing on its own. `recency` is a snapshot the caller
 * owns, and §12 requires that snapshot to move ONLY on the local user's own tap: remote activity
 * must never reshuffle the row under a finger, it applies on the next open.
 */
export function seatContacts(
  contacts: readonly MessengerContact[],
  liveKey: string | undefined,
  recency: readonly string[] = [],
): MessengerContact[] {
  const rest = new Map(contacts.map((c) => [c.key, c]));
  const seats: MessengerContact[] = [];

  const live = liveKey ? rest.get(liveKey) : undefined;
  if (live) {
    seats.push(live);
    rest.delete(live.key);
  }

  // The highest non-live seat is hers — seat 2 when someone else is live, and when SHE is live she
  // already took seat 1 above, so the pin is satisfied either way.
  const masia = [...rest.values()].find((c) => c.isAi);
  if (masia) {
    seats.push(masia);
    rest.delete(masia.key);
  }

  // The tail, by recency. `Infinity` keeps a never-contacted channel after the contacted ones, and
  // the index tiebreak keeps `buildContacts`' own order stable underneath (a stable sort alone is
  // not enough of a promise to rely on across engines).
  const tail = [...rest.values()].map((c, i) => {
    const seen = recency.indexOf(c.key);
    return { c, rank: seen < 0 ? Number.POSITIVE_INFINITY : seen, i };
  });
  tail.sort((a, b) => a.rank - b.rank || a.i - b.i);

  return [...seats, ...tail.map((x) => x.c)];
}

/**
 * BANK SECTIONS — the row, split into what it actually is (founder 2026-10-07, plan
 * icom-player-contacts К4 — SUPERSEDES the 2026-09-03 «≤ N people / ≤ M groups» two-section row):
 *
 *   [live][its conversations] │ [Masia 📌][Родина 📌][pinned 📌…] │ [recent people AND groups…]
 *
 *   1. PINNED = Masia (ALWAYS the first seat, never counted, never trimmed — the stone machine
 *      parents into her berth) · the family chat (a pinned GROUP; the groups door lists only real
 *      `Group` rows, so a family plate that could be trimmed would be reachable from nowhere) · then
 *      the contacts I pinned (`PinnedContact`, ADR-115), in the order the caller gives (`pinnedKeys`,
 *      oldest pin first). A pin that is not in the row (a contact since removed) is skipped.
 *   2. RECENT = EVERYONE ELSE, people and groups MERGED into ONE list by recency — the order of the
 *      seated input, not a second sort. It is returned WHOLE: the row renders a window of it
 *      (`BANK_RECENT_WINDOW`) and grows it as the scroller nears its end (`growBankWindow`) — the list is
 *      already in memory, so lazy is rendering, not fetching. `recentWindow` is the one place that
 *      takes the prefix.
 *   3. The LIVE channel is seat 1 whatever it is and appears in neither list — a live Masia is
 *      therefore not in `pinned` that render (the same non-duplication rule a live person has).
 *
 * 🔴 PURE, and it takes the row ALREADY SEATED (`seatContacts`): recency ordering is that
 * function's business and the snapshot is the caller's.
 */
export interface BankSections {
  /** Seat 1 — the open channel, person or group. `undefined` in a lane room (nothing is live). */
  live: MessengerContact | undefined;
  /** Masia first, then the family berth, then my pinned contacts. Never contains the live one. */
  pinned: MessengerContact[];
  /** Everyone else — people and groups, one list, most recent first. The WHOLE list; see
   *  `recentWindow`. Never contains the live one or a pinned one. */
  recent: MessengerContact[];
}

export function bankSections(
  seated: readonly MessengerContact[],
  liveKey: string | undefined,
  pinnedKeys: readonly string[] = [],
): BankSections {
  const live = seated.find((c) => c.key === liveKey);
  const tail = seated.filter((c) => c.key !== live?.key);

  const byKey = new Map(tail.map((c) => [c.key, c]));
  const pinned: MessengerContact[] = [];
  const take = (c: MessengerContact | undefined): void => {
    if (c && byKey.delete(c.key)) pinned.push(c);
  };
  take(tail.find((c) => c.isAi));
  take(tail.find((c) => c.kind === 'FAMILY'));
  for (const k of pinnedKeys) take(byKey.get(k));

  // What is left keeps the seated (recency) order — `tail` is that order, `byKey` only says who remains.
  const recent = tail.filter((c) => byKey.has(c.key));
  return { live, pinned, recent };
}

/**
 * The visible prefix of the recent list — the ONE place the window is applied.
 *
 * `limit` is required: how many plates fit is a UI decision the host owns (in Masia, the
 * `BANK_RECENT_WINDOW` constant of `@masia/shared`), so this package neither guesses nor copies it.
 */
export function recentWindow(
  recent: readonly MessengerContact[],
  limit: number,
): MessengerContact[] {
  return recent.slice(0, Math.max(0, limit));
}

/**
 * The route keys of the contacts I pinned (`PinnedContact`, ADR-115), OLDEST PIN FIRST — the order
 * the pins were made is the order the row keeps, so a pin never moves under a finger. A person with
 * an account is seated as `u_<userId>` (ADR-116 §3), so the key is the contact key whether or not
 * they also sit in my family.
 */
export function pinnedContactKeys(
  contacts: readonly Pick<ContactLite, 'userId' | 'isPinned' | 'pinnedAt'>[],
): string[] {
  return contacts
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c.isPinned)
    .sort((a, b) => (a.c.pinnedAt ?? '').localeCompare(b.c.pinnedAt ?? '') || a.i - b.i)
    .map(({ c }) => contactRouteKey(c.userId));
}

/**
 * The recency SNAPSHOT — contact keys ordered most-recently-active first, derived from the inbox's
 * last-message times. Read ONCE per open (§12: "recency applies on the next open"); after that the
 * only thing allowed to move a key to the front is the local user's own tap.
 */
export function recencySnapshot(
  contacts: readonly MessengerContact[],
  conversations: MessengerConversationPreview[],
  selfPersonId: string | undefined,
  selfUserId?: string | undefined,
): string[] {
  const at = (c: MessengerContact): string => {
    const convs = getEntityConversations(
      c.entityType,
      c.id,
      conversations,
      selfPersonId,
      selfUserId,
    );
    let last = '';
    for (const conv of convs) {
      const ts = conv.lastMessage?.createdAt ?? conv.createdAt;
      if (ts > last) last = ts;
    }
    return last;
  };
  return [...contacts]
    .map((c, i) => ({ key: c.key, ts: at(c), i }))
    .sort((a, b) => b.ts.localeCompare(a.ts) || a.i - b.i)
    .map((x) => x.key);
}

/** Resolve a route key back to a partial contact descriptor. */
export function decodeContactKey(
  key: string,
): { kind: ContactKind; entityType: EntityType; id: string } | null {
  if (key === MASIA_KEY) return { kind: 'MASIA', entityType: 'MASIA', id: MASIA_KEY };
  if (key === FAMILY_KEY) return { kind: 'FAMILY', entityType: 'FAMILY_GROUP', id: FAMILY_KEY };
  if (key.startsWith('m_'))
    return { kind: 'MEMBER', entityType: 'FAMILY_MEMBER', id: key.slice(2) };
  if (key.startsWith('g_')) return { kind: 'GROUP', entityType: 'GROUP', id: key.slice(2) };
  // `u_` = an accepted contact; the id is their USER id, not a person (ADR-115 К3).
  if (key.startsWith(CONTACT_PREFIX)) {
    return { kind: 'CONTACT', entityType: 'CONTACT', id: key.slice(CONTACT_PREFIX.length) };
  }
  return null;
}
