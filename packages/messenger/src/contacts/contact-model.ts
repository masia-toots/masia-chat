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
  /**
   * The family this person is FROM, as the host says (polishing П16): for a member of MY primary family that family,
   * for anyone else THEIR OWN primary family; `null` when they have none. Read only to name the delimiter behind which
   * a contact of another family sits (`MessengerContact.otherFamily`). Absent (an older host) = unknown.
   */
  familyId?: string | null;
  familyName?: string | null;
}

/**
 * The family a contact is from when it is NOT the family I am standing in (polishing П16, founder 2026-11-08). `id` is the
 * grouping key — contacts with the same `id` sit behind ONE delimiter; `name` is what the delimiter says. Both `null` =
 * a contact whose family is not known: they still sit behind a delimiter (a nameless one), never among the family's own people.
 */
export interface ContactFamily {
  id: string | null;
  name: string | null;
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
  /**
   * Set ONLY on a person who is not in the family I am standing in (`buildContacts`): a friend, or a relative of the
   * primary family while I stand in another one. `bankStrip` seats them behind a delimiter per family; absent = the
   * family's own (Masia · the family chat · its members · my groups).
   */
  otherFamily?: ContactFamily;
  /**
   * ADR-201 — what waits for me across this contact's rooms, as the HOST's unread store says (never derived here from
   * messages). Absent = nothing to show. `unread` is the raw sum; `unreadMentions` the part that calls me by name
   * (`<= unread`); `muted` = every room of the contact is muted for me (the chip then shows 🔇, and a number only for
   * mentions — Г2 A). The bank draws them (`chipAttention`); it computes none of them.
   */
  unread?: number;
  unreadMentions?: number;
  muted?: boolean;
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

/**
 * The INVERSE of {@link getEntityConversations}: the key of the contact a conversation belongs to, or null.
 *
 * A push tap (and every older `/messages/<id>` link) names a CONVERSATION, while the messenger route is
 * `/messenger/:contactKey` (2026-11-07: a tap on a message push opened the messenger on its empty «pick a contact»
 * placeholder — no contact matched the bare id). The page asks THIS, once the inbox
 * is in, and lands on the right contact AND that very chat. Same matching rule as the forward direction — the contact
 * whose conversations contain the id — so the two can never disagree; the first such contact in `contacts` order wins.
 * A chat whose contact is not on my bank (a member who left, a contact not listed yet) still gets one: the keys the
 * conversation itself suggests (Masia · the family · its group · each other seat by person, then by user) are tried
 * through the same forward rule, so a derived key is always one the page itself resolves back to this chat.
 */
export function contactKeyForConversation(
  contacts: readonly Pick<MessengerContact, 'key' | 'entityType' | 'id'>[],
  conversations: MessengerConversationPreview[],
  conversationId: string,
  selfPersonId: string | undefined,
  selfUserId?: string | undefined,
): string | null {
  if (!conversations.some((c) => c.id === conversationId)) return null;
  const owns = (entityType: EntityType, id: string): boolean =>
    getEntityConversations(entityType, id, conversations, selfPersonId, selfUserId).some((conv) => conv.id === conversationId);
  const listed = contacts.find((c) => owns(c.entityType, c.id));
  if (listed) return listed.key;
  const conv = conversations.find((c) => c.id === conversationId)!;
  const others = conv.participants.filter((p) => p.personId !== selfPersonId);
  const suggested = [
    MASIA_KEY,
    FAMILY_KEY,
    ...(conv.groupId ? [`g_${conv.groupId}`] : []),
    ...others.map((p) => `m_${p.personId}`),
    ...others.flatMap((p) => (p.userId && p.userId !== selfUserId ? [contactRouteKey(p.userId)] : [])),
  ];
  return (
    suggested.find((key) => {
      const dec = decodeContactKey(key);
      return dec !== null && owns(dec.entityType, dec.id);
    }) ?? null
  );
}

/**
 * THE ROOMS NO DOOR OPENS — the inbox rooms that nobody can reach from the channel bank.
 *
 * A room is reachable when some plate owns it under the ONE matching rule (`getEntityConversations`): the assistant's
 * chats, the family chat, a member's DM, a LIVE group's chat, an accepted contact's DM. Everything else is a room the
 * inbox still returns but no door leads to — a group that was deleted (its chat outlives the row), a contact who was
 * unpinned or blocked (the contacts list drops them, so their DM loses its plate), a member who left. Nothing about such
 * a room can wait for the person, so a count of «where am I waited for?» leaves it out.
 *
 * `doors` are the bank's plates; `acceptedContacts` are ALL of the person's accepted contacts, because a contact outside
 * the active family's row (a relative of the primary family) is still opened from the circles — they are doors too.
 * Pure over what the page already holds; a room the inbox has not returned yet is not in the answer (it is not known to
 * be unreachable), so a brand-new DM counts from its first message.
 */
export function conversationsWithoutDoor(input: {
  doors: readonly Pick<MessengerContact, 'entityType' | 'id'>[];
  acceptedContacts: readonly Pick<ContactLite, 'userId'>[];
  conversations: readonly MessengerConversationPreview[];
  selfPersonId: string | undefined;
  selfUserId?: string | undefined;
}): ReadonlySet<string> {
  const { doors, acceptedContacts, selfPersonId, selfUserId } = input;
  const conversations = [...input.conversations];
  const owners = [
    ...doors,
    ...acceptedContacts.map((c) => ({ entityType: 'CONTACT' as EntityType, id: c.userId })),
  ];
  const reachable = new Set<string>();
  for (const owner of owners) {
    for (const room of getEntityConversations(owner.entityType, owner.id, conversations, selfPersonId, selfUserId)) {
      reachable.add(room.id);
    }
  }
  return new Set(conversations.filter((c) => !reachable.has(c.id)).map((c) => c.id));
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
 * has an account. `bankStrip` then orders the whole row (active · Masia · pins · recency), so this
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
 * This is a BASE order only: `bankStrip` still ranks the tail by recency and
 * falls back to this order for anyone never talked to.
 *
 * ## …and they are behind a DELIMITER (polishing П16, founder 2026-11-08)
 *
 * Every contact that is not one of `members` (the family I am standing in) carries `otherFamily`
 * ({@link ContactFamily}); `bankStrip` seats those after the family's own people, one delimiter per family. «Родина»-circle
 * friends included — the flag orders them inside their group, it does not move them into mine.
 */
export function buildContacts(
  members: FamilyMemberLite[],
  groups: GroupLite[],
  labels: { masia: string; family: string },
  selfPersonId: string | undefined,
  contacts: readonly ContactLite[] = [],
  familyCircleUserIds: ReadonlySet<string> = new Set(),
  /** `membersKnown` — the member list has answered (it carries MY row). Before that a member of my primary family looks
   *  exactly like a person of another family, so they are held back rather than flashed behind a delimiter. */
  { membersKnown = true }: { membersKnown?: boolean } = {},
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

  // The rest of my contacts, «friends of the family» first (ADR-116 rule 1) — every one of them is a person of ANOTHER
  // family than the one I am standing in, so each carries `otherFamily` and `bankStrip` seats them behind a delimiter per
  // family (polishing П16, founder 2026-11-08).
  //
  // That includes `isPrimaryMember` who did NOT turn up in `members`: `GET /users/me/contacts` computes my PRIMARY
  // family's people whatever family I am standing in. They used to be DROPPED here («keeping them would drop my relatives
  // into another family's bank»); behind a delimiter named for that family they are no longer a leak into this one, and
  // dropping them was what made the open chat's chip vanish from the strip when I switched family (the last-opened
  // contact stays first ACROSS families, so it must resolve in every family's list). While the member list has not
  // answered (`membersKnown: false`) nobody can be told from a family member, so they stay out — unknown is not foreign.
  const restContacts = contacts.filter(
    (c) => !seatedUserIds.has(c.userId) && (membersKnown || !c.isPrimaryMember),
  );
  const crossFamilyContacts: MessengerContact[] = [
    ...restContacts.filter((c) => familyCircleUserIds.has(c.userId)),
    ...restContacts.filter((c) => !familyCircleUserIds.has(c.userId)),
  ].map((c) => ({
    ...contactPlate(c),
    otherFamily: { id: c.familyId ?? null, name: c.familyName ?? null },
  }));

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
 * THE BANK STRIP — the host's chat canon §12.1 (private; summarised in docs/canon.md §6), the ONE row the header is built on
 * (founder 2026-11-03, plan chat-public-polish Ф2.4 — SUPERSEDES `seatContacts` + `bankSections`: the row is no longer sections
 * with a hairline between them, it is ONE continuous strip, and the order is the whole contract):
 *
 *   [the ACTIVE conversation's chip] · [Masia — always 2nd when she is not 1st] · [the family berth] · [pinned…] · [recent…]
 *     · [per OTHER family: its people — pinned…, recent… — behind a delimiter «ІНША РОДИНА · <name>»]   (П16, 2026-11-08)
 *
 *   1. Seat 1 = the ACTIVE contact (it sits beside its own name). `undefined` in a lane room — nothing is active.
 *   2. Masia is the highest non-active seat, so she is never lower than SECOND (and the stone machine parents into her berth,
 *      so she must always be in the strip — never trimmed, never counted against the window).
 *   3. The family chat is a pinned GROUP by nature (the groups panel lists only real `Group` rows, so a family chip the window
 *      could trim would be reachable from nowhere), so it follows Masia without being asked.
 *   4. The contacts I pinned (`PinnedContact`, ADR-115), in the order the caller gives (`pinnedKeys`, oldest pin first). A pin
 *      that is not in the row (a contact since removed) is skipped.
 *   5. Everyone else — people AND groups, ONE list — by RECENCY (`recency`, most-recent key first). A never-contacted channel
 *      goes after the contacted ones and keeps `buildContacts`' own order (the index tiebreak: a stable sort alone is not a promise
 *      to rely on across engines).
 *   6. A key appears ONCE — the active chip is not repeated as a pin or a recent.
 *   7. (П16, founder 2026-11-08) The CURRENT family comes first, the others after it. A contact carrying `otherFamily` (a friend,
 *      or a relative of my primary family while I stand in another one) is seated in its family's GROUP at the end of the strip —
 *      behind a delimiter, one group per family, the same inner order (pins · recency) — never among the current family's
 *      people. The ACTIVE chip is the one exception: it is seat 1 even when it is foreign, so the last-opened contact stays
 *      first ACROSS a family switch (the contact is addressed by the user pair, not by the family — ADR-116 rule 2) and the
 *      current family's people follow it. A contact in several of my families is the current family's (`buildContacts` seats it
 *      as a member, so it carries no `otherFamily`).
 *
 * `groups` records where each other family's run starts so that the delimiter cannot be separated from its first chip by the
 * window ({@link stripSegments} cuts the visible prefix into runs).
 *
 * Why not sort the whole row by recency: a row of small faces is tapped from spatial memory, and an order that changes on every
 * selection never lets that memory form. The head of the strip is fixed by ROLE (active · Masia · family · pins); only the tail
 * self-organises.
 *
 * 🔴 PURE — it reorders nothing on its own. `recency` is a snapshot the caller owns, and §12 requires that snapshot to move ONLY
 * on the local user's own tap: remote activity must never reshuffle the row under a finger, it applies on the next open.
 */
export interface BankStripInput {
  contacts: readonly MessengerContact[];
  /** The open channel's key — seat 1. `undefined` in a lane room. */
  activeKey?: string | undefined;
  /** Contact keys, most recent first (`recencySnapshot` + the local taps). */
  recency?: readonly string[];
  /** The contacts I pinned, oldest pin first (`pinnedContactKeys`). */
  pinnedKeys?: readonly string[];
}

/**
 * ONE other family's run of chips — `chips[from..to)` — behind a delimiter «ІНША РОДИНА · <name>» (polishing П16, founder
 * 2026-11-08). The delimiter is NOT a chip: it stands before `chips[from]`, so it can never be separated from the chip it
 * introduces, and a window that ends before `from` simply never reaches it.
 */
export interface BankStripGroup {
  family: ContactFamily;
  /** Index in `BankStrip.chips` of the group's first chip (the delimiter stands right before it). */
  from: number;
  /** One past the group's last chip. */
  to: number;
}

export interface BankStrip {
  /** The WHOLE strip, in order. */
  chips: MessengerContact[];
  /** How many leading chips are fixed by role (active · Masia · family · pins) — the window never cuts into them. */
  fixed: number;
  /** The other families' runs, in order, each a slice of the TAIL of `chips` (after the current family's own people). */
  groups: BankStripGroup[];
}

export function bankStrip(input: BankStripInput): BankStrip {
  const { contacts, activeKey, recency = [], pinnedKeys = [] } = input;
  const rest = new Map<string, MessengerContact>();
  for (const c of contacts) if (!rest.has(c.key)) rest.set(c.key, c);

  const head: MessengerContact[] = [];
  const take = (c: MessengerContact | undefined): void => {
    if (c && rest.delete(c.key)) head.push(c);
  };
  // The ACTIVE chip is seat 1 whichever family it is from: the last-opened contact stays first across a family switch
  // (founder 2026-11-08), so it is taken BEFORE any family is looked at and belongs to no group.
  take(activeKey ? rest.get(activeKey) : undefined);
  // The highest non-active seat is hers — seat 2 when someone else is active; when SHE is active she took seat 1 above.
  take([...rest.values()].find((c) => c.isAi));
  take([...rest.values()].find((c) => c.kind === 'FAMILY'));
  // A pin of a person of ANOTHER family is not fixed by role: it leads its own family's group instead (below), so the
  // current family's people always come right after the head.
  for (const k of pinnedKeys) {
    const c = rest.get(k);
    if (c && !c.otherFamily) take(c);
  }

  const recencyRank = (key: string): number => {
    const seen = recency.indexOf(key);
    return seen < 0 ? Number.POSITIVE_INFINITY : seen;
  };
  const left = [...rest.values()].map((c, i) => ({ c, i }));

  // The current family's own tail — people AND groups, ONE list, by recency.
  const own = left
    .filter(({ c }) => !c.otherFamily)
    .map((x) => ({ ...x, rank: recencyRank(x.c.key) }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i);

  // The other families' people: inside a family the SAME inner order as the current one (pins first — oldest pin first —
  // then recency, then the base order), and the families themselves in the order their first contact comes up.
  const pinRank = (key: string): number => {
    const at = pinnedKeys.indexOf(key);
    return at < 0 ? Number.POSITIVE_INFINITY : at;
  };
  const foreign = left
    .filter(({ c }) => c.otherFamily)
    .map((x) => ({ ...x, pin: pinRank(x.c.key), rank: recencyRank(x.c.key) }))
    .sort((a, b) => a.pin - b.pin || a.rank - b.rank || a.i - b.i);
  const byFamily = new Map<string | null, { family: ContactFamily; chips: MessengerContact[] }>();
  for (const { c } of foreign) {
    const family = c.otherFamily as ContactFamily;
    const run = byFamily.get(family.id) ?? { family, chips: [] };
    run.chips.push(c);
    byFamily.set(family.id, run);
  }

  const chips = [...head, ...own.map((x) => x.c)];
  const groups: BankStripGroup[] = [];
  for (const run of byFamily.values()) {
    groups.push({ family: run.family, from: chips.length, to: chips.length + run.chips.length });
    chips.push(...run.chips);
  }
  return { chips, fixed: head.length, groups };
}

/**
 * The visible prefix of the strip — the ONE place the window is applied. The fixed head is always whole; `recentLimit` caps only the
 * recency tail behind it (the current family's own people first, then the other families' runs).
 *
 * `recentLimit` is required: how many chips fit is a UI decision the host owns (in Masia, the `BANK_RECENT_WINDOW` constant of
 * `@masia/shared`), so this package neither guesses nor copies it.
 */
export function stripWindow(strip: BankStrip, recentLimit: number): MessengerContact[] {
  return strip.chips.slice(0, strip.fixed + Math.max(0, recentLimit));
}

/**
 * One run of the VISIBLE strip: `family === null` is the current family's own run (the head + its people — no delimiter),
 * otherwise the other family's chips that sit behind a delimiter naming it.
 */
export interface StripSegment {
  family: ContactFamily | null;
  chips: MessengerContact[];
}

/**
 * The visible strip (`stripWindow`'s `shown` chips) cut into its runs — what the renderer draws, so it decides nothing about
 * who sits where. The rules, each one a test:
 *   · the delimiter belongs to the FIRST chip of its group: a group whose first chip the window did not reach is not drawn,
 *     and a group the window cuts in the middle keeps its delimiter and the chips that fit;
 *   · nothing is delimited when nothing of the current family precedes it (a group that opens the strip — no active chip, no
 *     Masia — is drawn as a plain run: «other» needs a «this» before it, and the delimiter is never the strip's first thing).
 */
export function stripSegments(strip: BankStrip, shown: number): StripSegment[] {
  const count = Math.max(0, Math.min(shown, strip.chips.length));
  const segments: StripSegment[] = [];
  const plain = (from: number, to: number): void => {
    if (to > from) segments.push({ family: null, chips: strip.chips.slice(from, to) });
  };
  let at = 0;
  for (const g of strip.groups) {
    if (g.from >= count) break;
    plain(at, g.from);
    const to = Math.min(g.to, count);
    if (g.from === 0) plain(0, to);
    else segments.push({ family: g.family, chips: strip.chips.slice(g.from, to) });
    at = to;
  }
  plain(at, count);
  return segments;
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
