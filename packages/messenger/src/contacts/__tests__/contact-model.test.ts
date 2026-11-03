/**
 * bankSections — К4 (founder 2026-10-07, plan icom-player-contacts): the row is
 * `[live] │ [Masia 📌][Родина 📌][pinned 📌…] │ [recent people AND groups, windowed + lazy]`.
 * These are the assertions the render harness cannot make cheaply: that Masia is first pinned
 * whatever recency did, that the pins keep `PinnedContact` order, that people and groups merge into
 * ONE recency list, and that the window takes the limit the host gives it.
 * (The host's default window and its lazy growth are asserted in the host, beside the constants.)
 */
import { describe, it, expect } from 'vitest';
import type { MessengerConversationPreview } from '../../protocol/conversations.js';
import {
  bankSections,
  buildContacts,
  contactRouteKey,
  contactUnread,
  decodeContactKey,
  getEntityConversations,
  pinnedContactKeys,
  recencySnapshot,
  recentWindow,
  seatContacts,
  type ContactLite,
  type FamilyMemberLite,
  type MessengerContact,
} from '../contact-model.js';

const person = (n: string): MessengerContact => ({
  key: `m_${n}`,
  kind: 'MEMBER',
  entityType: 'FAMILY_MEMBER',
  id: n,
  name: n,
  avatarUrl: null,
  isAi: false,
});
const group = (n: string): MessengerContact => ({
  key: `g_${n}`,
  kind: 'GROUP',
  entityType: 'GROUP',
  id: n,
  name: n,
  avatarUrl: null,
  isAi: false,
});
const masia: MessengerContact = {
  key: 'masia',
  kind: 'MASIA',
  entityType: 'MASIA',
  id: 'masia',
  name: 'Мася',
  avatarUrl: null,
  isAi: true,
};
const family: MessengerContact = {
  key: 'family',
  kind: 'FAMILY',
  entityType: 'FAMILY_GROUP',
  id: 'family',
  name: 'Родина',
  avatarUrl: null,
  isAi: false,
};

const people8 = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'].map(person);
const groups7 = ['g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7'].map(group);
const row = [masia, family, ...people8, ...groups7];
const names = (cs: readonly MessengerContact[]): string[] => cs.map((c) => c.name);

describe('bankSections (К4)', () => {
  it('seats Masia FIRST among the pinned, then the family berth', () => {
    // Recency put a group ahead of everything — Masia and Родина still lead the pinned seats.
    const seated = seatContacts(row, undefined, ['g_g7', 'm_p3']);
    const s = bankSections(seated, undefined);
    expect(names(s.pinned)).toEqual(['Мася', 'Родина']);
    expect(s.pinned[0]?.isAi).toBe(true);
  });

  it('keeps the pinned contacts in the order PinnedContact gives, after the berths', () => {
    const s = bankSections(seatContacts(row, undefined), undefined, ['m_p5', 'g_g2', 'm_p1']);
    expect(names(s.pinned)).toEqual(['Мася', 'Родина', 'p5', 'g2', 'p1']);
    // …and a pin that is not in the row (a removed contact) is skipped, never rendered blank.
    const gone = bankSections(seatContacts(row, undefined), undefined, ['u_ghost', 'm_p2']);
    expect(names(gone.pinned)).toEqual(['Мася', 'Родина', 'p2']);
  });

  it('merges people AND groups into ONE recent list in recency order, excluding the pinned', () => {
    const seated = seatContacts(row, undefined, ['g_g7', 'm_p8', 'g_g6', 'm_p7']);
    const s = bankSections(seated, undefined, ['m_p1']);
    expect(names(s.recent).slice(0, 4)).toEqual(['g7', 'p8', 'g6', 'p7']);
    // Everyone not pinned and not live, exactly once: 8 people + 7 groups − 1 pinned (p1).
    expect(s.recent).toHaveLength(14);
    expect(names(s.recent)).not.toContain('p1');
    expect(s.recent.some((c) => c.kind === 'GROUP')).toBe(true);
    expect(s.recent.some((c) => c.kind === 'MEMBER')).toBe(true);
    expect(s.recent.every((c) => !c.isAi && c.kind !== 'FAMILY')).toBe(true);
  });

  it('never repeats the live channel in either list', () => {
    for (const liveKey of ['g_g3', 'm_p2', 'family', 'masia']) {
      const s = bankSections(seatContacts(row, liveKey), liveKey, ['m_p2', 'g_g3']);
      expect(s.live?.key).toBe(liveKey);
      expect([...s.pinned, ...s.recent].some((c) => c.key === liveKey)).toBe(false);
    }
    // A live Masia leaves the pinned seats to the family berth + pins (she is seat 1).
    const m = bankSections(seatContacts(row, 'masia'), 'masia');
    expect(names(m.pinned)).toEqual(['Родина']);
  });

  it('is undefined-live safe (a lane room seats nobody) and empty-safe', () => {
    const s = bankSections(seatContacts(row, undefined), undefined);
    expect(s.live).toBeUndefined();
    expect(s.pinned[0]?.key).toBe('masia');
    expect(bankSections([], undefined)).toEqual({ live: undefined, pinned: [], recent: [] });
  });

  it('applies ONE window limit to the recent list (people and groups share it)', () => {
    const s = bankSections(seatContacts(row, undefined), undefined);
    expect(recentWindow(s.recent, 5)).toHaveLength(5);
    expect(names(recentWindow(s.recent, 3))).toEqual(names(s.recent).slice(0, 3));
    expect(recentWindow(s.recent, 0)).toEqual([]);
    expect(recentWindow(s.recent, -4)).toEqual([]);
    // A short list is simply shown whole.
    expect(recentWindow(s.recent, 100)).toHaveLength(s.recent.length);
  });
});

describe('pinnedContactKeys (PinnedContact → bank keys)', () => {
  const c = (userId: string, isPinned: boolean, pinnedAt: string | null) => ({
    userId,
    isPinned,
    pinnedAt,
  });
  it('keeps only pinned contacts, oldest pin first, as `u_` keys', () => {
    expect(
      pinnedContactKeys([
        c('uB', true, '2026-02-01T00:00:00Z'),
        c('uX', false, null),
        c('uA', true, '2026-01-01T00:00:00Z'),
      ]),
    ).toEqual(['u_uA', 'u_uB']);
  });
});

/**
 * buildContacts — ADR-116 (2026-09-06): the BASE order and the one-plate-per-human rule.
 *
 * These are the claims a screenshot cannot make: that a person who arrives twice (a family member
 * AND an accepted contact) leaves ONE plate, that the surviving key is the one that addresses their
 * homeless DM, and that a friend flagged into «Родина» opens the contact tail rather than landing
 * wherever the endpoint happened to list them. The berth assertion above is repeated here end-to-end
 * because re-keying humans is exactly the change that could push the family plate back across the seam.
 */
describe('buildContacts (ADR-116)', () => {
  const labels = { masia: 'Masia', family: 'Родина' };
  const mem = (id: string, name: string, userId?: string): FamilyMemberLite => ({
    id,
    name,
    avatarUrl: null,
    type: 'HUMAN',
    ...(userId ? { userId } : {}),
  });
  const con = (userId: string, displayName: string, isPrimaryMember = false): ContactLite => ({
    userId,
    displayName,
    avatarUrl: null,
    username: null,
    isPrimaryMember,
  });
  const keys = (cs: readonly MessengerContact[]): string[] => cs.map((c) => c.key);

  it('seats a human who is BOTH a member and a contact ONCE, keyed by `u_` (ADR-116 §3)', () => {
    const built = buildContacts([mem('p1', 'Марʼяна', 'u1'), mem('p2', 'Данило')], [], labels, 'p0', [
      con('u1', 'Maryana', true),
    ]);
    // One plate for Марʼяна, and it is the CONTACT one: `getEntityConversations` finds the pair's
    // one homeless DM by userId, so an `m_p1` plate would open an empty chat beside a live one.
    expect(keys(built)).toEqual(['masia', 'family', 'u_u1', 'm_p2']);
    const her = built.find((c) => c.key === 'u_u1');
    expect(her?.kind).toBe('CONTACT');
    expect(her?.entityType).toBe('CONTACT');
    // The family's own name for her survives the key swap — only the address changed.
    expect(her?.name).toBe('Марʼяна');
    // A member WITHOUT an account keeps their person seat: their DM really is family-homed.
    expect(built.find((c) => c.key === 'm_p2')?.kind).toBe('MEMBER');
  });

  it('keeps the member ORDER when a member is re-keyed, and never seats them twice', () => {
    const built = buildContacts(
      [mem('p1', 'A', 'u1'), mem('p2', 'B'), mem('p3', 'C', 'u3')],
      [],
      labels,
      'p0',
      [con('u3', 'C', true), con('u1', 'A', true), con('u9', 'Стороння')],
    );
    // The contacts endpoint listed u3 before u1; the ROW still follows the family's own order,
    // and the outside contact lands after all of them.
    expect(keys(built)).toEqual(['masia', 'family', 'u_u1', 'm_p2', 'u_u3', 'u_u9']);
    expect(built.filter((c) => c.id === 'u1')).toHaveLength(1);
  });

  it('opens the contact tail with the friends flagged into «Родина» (ADR-116 rule 1)', () => {
    const built = buildContacts(
      [mem('p1', 'Данило')],
      [],
      labels,
      'p0',
      [con('uA', 'Аня'), con('uL', 'Ірина'), con('uZ', 'Зоя')],
      new Set(['uL']),
    );
    // Ірина is in my family circle, so she sits right after the family members — ahead of Аня, whom
    // the endpoint listed first. Everyone else keeps the server's order behind her.
    expect(keys(built)).toEqual(['masia', 'family', 'm_p1', 'u_uL', 'u_uA', 'u_uZ']);
  });

  it('keeps the FAMILY plate a pinned berth after re-keying humans (Г4 → К4)', () => {
    const built = buildContacts(
      [mem('p1', 'Данило', 'u1')],
      [{ id: 'g1', name: 'Похід', avatarUrl: null }],
      labels,
      'p0',
      [con('u1', 'Данило', true), con('uL', 'Ірина')],
      new Set(['uL']),
    );
    const s = bankSections(seatContacts(built, undefined), undefined);
    expect(names(s.pinned)).toEqual(['Masia', 'Родина']);
    expect(names(s.recent)).toEqual(['Данило', 'Ірина', 'Похід']);
  });

  it('is unchanged for a family with no accounts and no flags', () => {
    const built = buildContacts([mem('p1', 'Данило'), mem('p2', 'Соломія')], [], labels, 'p0');
    expect(keys(built)).toEqual(['masia', 'family', 'm_p1', 'm_p2']);
  });

  it("keeps my PRIMARY family out of another family's row", () => {
    // Standing in a family that is not my primary one: `GET /users/me/contacts` still computes my
    // primary family's people, and they must not leak into this family's bank. Only the person who
    // is actually seated here (and my ordinary contacts) show up.
    const built = buildContacts([mem('p9', 'Ірина', 'uL')], [], labels, 'p0', [
      con('uMum', 'Мама', true),
      con('uL', 'Ірина'),
      con('uZ', 'Зоя'),
    ]);
    expect(keys(built)).toEqual(['masia', 'family', 'u_uL', 'u_uZ']);
  });
});

/**
 * getEntityConversations / contactUnread / recencySnapshot / decodeContactKey — the lookup half of the
 * model: which chats belong to a plate, how many are unread, and how a route key maps back. The one
 * claim worth a test of its own is ADR-115 К3: a CONTACT is matched by USER id, never by person.
 */
describe('conversations of a contact', () => {
  const conv = (
    id: string,
    over: Partial<MessengerConversationPreview> = {},
  ): MessengerConversationPreview => ({
    id,
    title: null,
    titleCustom: false,
    type: 'DIRECT',
    isPrivate: false,
    autoTranslate: false,
    masiaMode: 'ACTIVE',
    avatarUrl: null,
    groupId: null,
    group: null,
    lastMessage: null,
    unreadCount: 0,
    participantCount: 2,
    participants: [],
    createdAt: '2026-01-01T00:00:00Z',
    ...over,
  });

  const inbox = [
    conv('ai-old', { type: 'AI_CHAT' }),
    conv('ai-primary', { type: 'AI_CHAT', isPrimary: true }),
    conv('fam', { type: 'FAMILY', unreadCount: 2 }),
    conv('dm-person', {
      participants: [
        { personId: 'me', name: 'Я' },
        { personId: 'p1', name: 'Данило' },
      ],
      unreadCount: 3,
    }),
    conv('dm-user', {
      participants: [
        { personId: 'me', name: 'Я', userId: 'uMe' },
        { personId: 'px', name: 'Стороння', userId: 'uX' },
      ],
      unreadCount: 4,
      lastMessage: {
        text: 'hi',
        senderName: 'X',
        createdAt: '2026-03-01T00:00:00Z',
        messageType: 'TEXT',
        isDeleted: false,
      },
    }),
    conv('grp', { type: 'GROUP', groupId: 'g1', unreadCount: 1 }),
  ];
  const ids = (cs: readonly MessengerConversationPreview[]): string[] => cs.map((c) => c.id);
  const contactPlate = (userId: string): MessengerContact => ({
    key: contactRouteKey(userId),
    kind: 'CONTACT',
    entityType: 'CONTACT',
    id: userId,
    name: userId,
    avatarUrl: null,
    isAi: false,
  });

  it('puts the pinned primary Masia chat first', () => {
    expect(ids(getEntityConversations('MASIA', 'masia', inbox, 'me'))).toEqual([
      'ai-primary',
      'ai-old',
    ]);
  });

  it('matches a family member by person and never the viewer themself', () => {
    expect(ids(getEntityConversations('FAMILY_MEMBER', 'p1', inbox, 'me'))).toEqual(['dm-person']);
    expect(getEntityConversations('FAMILY_MEMBER', 'me', inbox, 'me')).toEqual([]);
  });

  it('matches a CONTACT by user id, so a cross-family contact finds their chat', () => {
    expect(ids(getEntityConversations('CONTACT', 'uX', inbox, 'me', 'uMe'))).toEqual(['dm-user']);
    // …and the viewer's own user id never matches themself.
    expect(getEntityConversations('CONTACT', 'uMe', inbox, 'me', 'uMe')).toEqual([]);
    // A person id is not a user id: a legacy seat without a userId is not guessed at.
    expect(getEntityConversations('CONTACT', 'p1', inbox, 'me', 'uMe')).toEqual([]);
  });

  it('matches a group by its group id and the family plate by type', () => {
    expect(ids(getEntityConversations('GROUP', 'g1', inbox, 'me'))).toEqual(['grp']);
    expect(ids(getEntityConversations('FAMILY_GROUP', 'family', inbox, 'me'))).toEqual(['fam']);
  });

  it('sums the unread of a contact across its chats', () => {
    expect(contactUnread(person('p1'), inbox, 'me')).toBe(3);
    expect(contactUnread(group('g1'), inbox, 'me')).toBe(1);
    expect(contactUnread(contactPlate('uX'), inbox, 'me', 'uMe')).toBe(4);
    expect(contactUnread(person('nobody'), inbox, 'me')).toBe(0);
  });

  it('snapshots recency from the last message, falling back to the creation time', () => {
    // uX has a message in March; p1 and Masia only have chats created in January (a tie → row order).
    const snapshot = recencySnapshot([masia, person('p1'), contactPlate('uX')], inbox, 'me', 'uMe');
    expect(snapshot).toEqual(['u_uX', 'masia', 'm_p1']);
  });

  it('decodes route keys back to their kind, and refuses a foreign one', () => {
    expect(decodeContactKey('masia')).toEqual({ kind: 'MASIA', entityType: 'MASIA', id: 'masia' });
    expect(decodeContactKey('m_p1')).toEqual({
      kind: 'MEMBER',
      entityType: 'FAMILY_MEMBER',
      id: 'p1',
    });
    expect(decodeContactKey('g_g1')).toEqual({ kind: 'GROUP', entityType: 'GROUP', id: 'g1' });
    expect(decodeContactKey(contactRouteKey('uX'))).toEqual({
      kind: 'CONTACT',
      entityType: 'CONTACT',
      id: 'uX',
    });
    expect(decodeContactKey('lane_mind')).toBeNull();
  });
});
