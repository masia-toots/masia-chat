/**
 * bankStrip — Ф2.4 of plan chat-public-polish (founder 2026-11-03, SUPERSEDES the К4 sections row): the bank is ONE strip,
 * `[active] · [Masia — 2nd when she is not 1st] · [family berth] · [pinned…] · [recent…]`. These are the assertions the render
 * harness cannot make cheaply: the ORDER (active first, Masia second-or-first, then pins in PinnedContact order, then recency),
 * that every key appears once, and that the window cuts only the recency tail and never the fixed head.
 * (The host's default window and its lazy growth are asserted in the host, beside the constants.)
 */
import { describe, it, expect } from 'vitest';
import type { MessengerConversationPreview } from '../../protocol/conversations.js';
import {
  bankStrip,
  buildContacts,
  contactKeyForConversation,
  contactRouteKey,
  contactUnread,
  conversationsWithoutDoor,
  decodeContactKey,
  getEntityConversations,
  pinnedContactKeys,
  recencySnapshot,
  stripSegments,
  stripWindow,
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

describe('bankStrip (Ф2.4)', () => {
  const strip = (activeKey: string | undefined, recency: string[] = [], pinnedKeys: string[] = []) =>
    bankStrip({ contacts: row, activeKey, recency, pinnedKeys });

  it('puts the ACTIVE chip first, Masia SECOND, then the family berth', () => {
    // Recency put a group ahead of everything — the head is still fixed by role.
    const s = strip('m_p3', ['g_g7', 'm_p3']);
    expect(names(s.chips).slice(0, 3)).toEqual(['p3', 'Мася', 'Родина']);
    expect(s.chips[1]?.isAi).toBe(true);
  });

  it('puts Masia FIRST when she is the active one (never repeated, never lower than second)', () => {
    const s = strip('masia', ['g_g7']);
    expect(names(s.chips).slice(0, 2)).toEqual(['Мася', 'Родина']);
    expect(s.chips.filter((c) => c.isAi)).toHaveLength(1);
  });

  it('keeps Masia first with nobody active (a lane room)', () => {
    const s = strip(undefined, ['g_g7']);
    expect(s.chips[0]?.key).toBe('masia');
    expect(s.fixed).toBe(2); // Masia + the family berth
  });

  it('keeps the pinned contacts in the order PinnedContact gives, after the berths and before recency', () => {
    const s = strip('g_g1', ['m_p8', 'm_p7'], ['m_p5', 'g_g2', 'm_p1']);
    expect(names(s.chips).slice(0, 7)).toEqual(['g1', 'Мася', 'Родина', 'p5', 'g2', 'p1', 'p8']);
    expect(s.fixed).toBe(6);
    // …and a pin that is not in the row (a removed contact) is skipped, never rendered blank.
    const gone = strip(undefined, [], ['u_ghost', 'm_p2']);
    expect(names(gone.chips).slice(0, 3)).toEqual(['Мася', 'Родина', 'p2']);
    expect(gone.fixed).toBe(3);
  });

  it('merges people AND groups into ONE recency tail, most recent first', () => {
    const s = strip(undefined, ['g_g7', 'm_p8', 'g_g6', 'm_p7']);
    const tail = s.chips.slice(s.fixed);
    expect(names(tail).slice(0, 4)).toEqual(['g7', 'p8', 'g6', 'p7']);
    expect(tail.some((c) => c.kind === 'GROUP')).toBe(true);
    expect(tail.some((c) => c.kind === 'MEMBER')).toBe(true);
    // The never-contacted keep the row's own order behind the contacted ones.
    expect(names(tail).slice(4, 7)).toEqual(['p1', 'p2', 'p3']);
  });

  it('shows every key exactly once, whoever is active or pinned', () => {
    for (const activeKey of ['g_g3', 'm_p2', 'family', 'masia', undefined]) {
      const s = strip(activeKey, ['g_g7', 'm_p8'], ['m_p2', 'g_g3', 'masia', 'family', 'm_p2']);
      const keys = s.chips.map((c) => c.key);
      expect(new Set(keys).size).toBe(keys.length);
      expect(keys).toHaveLength(row.length);
      if (activeKey) expect(keys[0]).toBe(activeKey);
    }
  });

  it('dedupes a contact list that carries a key twice', () => {
    const s = bankStrip({ contacts: [masia, person('p1'), person('p1')], activeKey: undefined });
    expect(names(s.chips)).toEqual(['Мася', 'p1']);
  });

  it('is empty-safe and unknown-active safe', () => {
    expect(bankStrip({ contacts: [] })).toEqual({ chips: [], fixed: 0, groups: [] });
    // An active key that is not in the row seats nobody first (Masia leads).
    expect(strip('m_ghost').chips[0]?.key).toBe('masia');
  });

  it('applies ONE window limit to the recency tail and never cuts the fixed head', () => {
    const s = strip('m_p3', [], ['m_p5']);
    expect(s.fixed).toBe(4); // active · Masia · family · pin
    expect(stripWindow(s, 5)).toHaveLength(4 + 5);
    expect(names(stripWindow(s, 3))).toEqual(names(s.chips).slice(0, 4 + 3));
    expect(stripWindow(s, 0)).toHaveLength(4);
    expect(stripWindow(s, -4)).toHaveLength(4);
    // A short tail is simply shown whole.
    expect(stripWindow(s, 100)).toHaveLength(s.chips.length);
  });
});

/**
 * bankStrip — OTHER FAMILIES (polishing П16, founder 2026-11-08, variant Г): the current family's people first, then each other
 * family behind a delimiter; the last-opened contact stays first even when it is one of them; the window never parts a
 * delimiter from its first chip. The strip is ONE function and these are its claims.
 */
describe('bankStrip — other families (П16)', () => {
  const bobr = { id: 'f-bobry', name: 'Бобри' } as const;
  const lisy = { id: 'f-lisy', name: 'Лиси' } as const;
  /** A friend of another family, as `buildContacts` plates them (`u_<userId>` + `otherFamily`). */
  const friend = (n: string, otherFamily: { id: string | null; name: string | null }): MessengerContact => ({
    key: `u_${n}`,
    kind: 'CONTACT',
    entityType: 'CONTACT',
    id: n,
    name: n,
    avatarUrl: null,
    isAi: false,
    otherFamily,
  });
  const own = [masia, family, person('p1'), person('p2'), person('p3'), group('g1')];
  const b1 = friend('b1', bobr);
  const b2 = friend('b2', bobr);
  const b3 = friend('b3', bobr);
  const l1 = friend('l1', lisy);
  const n1 = friend('n1', { id: null, name: null });
  /** The row as `buildContacts` returns it: the family's own, then the strangers (the endpoint's order). */
  const row2 = [...own, b1, l1, b2, b3, n1];
  const strip = (opts: { activeKey?: string; recency?: string[]; pinnedKeys?: string[]; contacts?: MessengerContact[] } = {}) =>
    bankStrip({ contacts: opts.contacts ?? row2, activeKey: opts.activeKey, recency: opts.recency ?? [], pinnedKeys: opts.pinnedKeys ?? [] });
  const runs = (s: ReturnType<typeof bankStrip>, shown = s.chips.length) =>
    stripSegments(s, shown).map((seg) => ({ family: seg.family?.name ?? null, chips: names(seg.chips) }));

  it('puts the current family first and each OTHER family behind it, one group per family', () => {
    const s = strip();
    expect(names(s.chips)).toEqual(['Мася', 'Родина', 'p1', 'p2', 'p3', 'g1', 'b1', 'b2', 'b3', 'l1', 'n1']);
    expect(s.fixed).toBe(2);
    expect(s.groups.map((g) => [g.family.id, g.from, g.to])).toEqual([
      ['f-bobry', 6, 9],
      ['f-lisy', 9, 10],
      [null, 10, 11],
    ]);
    // A group is exactly the contiguous slice of chips it names, and none of them is the current family's.
    for (const g of s.groups) {
      expect(s.chips.slice(g.from, g.to).every((c) => c.otherFamily?.id === g.family.id)).toBe(true);
    }
    expect(s.chips.slice(0, 6).some((c) => c.otherFamily)).toBe(false);
  });

  it('a contact with no known family is grouped with the other nameless ones, never into a family it may not belong to', () => {
    const s = strip({ contacts: [...own, n1, friend('n2', { id: null, name: null })] });
    expect(s.groups).toHaveLength(1);
    expect(s.groups[0]).toMatchObject({ family: { id: null, name: null }, from: 6, to: 8 });
  });

  it('orders a family INSIDE its group like the current one — pins first (oldest pin first), then recency, then the base order', () => {
    const s = strip({ recency: ['u_b3', 'u_b2'], pinnedKeys: ['u_b2'] });
    // b2 is pinned (leads); b3 is the more recently talked-to of the rest; b1 never was.
    expect(names(s.chips.slice(6, 9))).toEqual(['b2', 'b3', 'b1']);
    // The family whose contact leads the foreign order comes first: recency alone puts Лиси ahead of Бобри here.
    const lisyFirst = strip({ recency: ['u_l1'] });
    expect(lisyFirst.groups.map((g) => g.family.name)).toEqual(['Лиси', 'Бобри', null]);
  });

  it("a PINNED stranger leads its own family's group, not the fixed head — the current family's people come right after the head", () => {
    const s = strip({ pinnedKeys: ['u_l1', 'm_p3'] });
    expect(names(s.chips.slice(0, 4))).toEqual(['Мася', 'Родина', 'p3', 'p1']);
    expect(s.fixed).toBe(3); // Masia · family · the family's own pin
    expect(s.groups[0]?.family.name).toBe('Лиси'); // a pin lifts its family to the front of the others
  });

  it('keeps the LAST-OPENED contact first when it is from another family — across a family switch — and the current family follows', () => {
    const s = strip({ activeKey: 'u_b2' });
    expect(names(s.chips).slice(0, 5)).toEqual(['b2', 'Мася', 'Родина', 'p1', 'p2']);
    expect(s.fixed).toBe(3);
    // It sits in the head, so it is in no group; its family's other people are still behind a delimiter, further on.
    expect(s.chips.indexOf(b2)).toBe(0);
    expect(s.groups.flatMap((g) => s.chips.slice(g.from, g.to)).includes(b2)).toBe(false);
    expect(runs(s)[0]).toEqual({ family: null, chips: ['b2', 'Мася', 'Родина', 'p1', 'p2', 'p3', 'g1'] });
    expect(runs(s)[1]).toEqual({ family: 'Бобри', chips: ['b1', 'b3'] });
  });

  it('draws no empty group: an active stranger who is the ONLY one of their family leaves that family without a delimiter', () => {
    const s = strip({ activeKey: 'u_l1' });
    expect(s.groups.map((g) => g.family.name)).toEqual(['Бобри', null]);
    expect(runs(s).some((r) => r.family === 'Лиси')).toBe(false);
  });

  it('shows every key exactly once, whoever is active or pinned', () => {
    for (const activeKey of ['u_b1', 'u_n1', 'g_g1', 'masia', undefined]) {
      const s = strip({ activeKey, recency: ['u_l1', 'm_p2'], pinnedKeys: ['u_b3', 'm_p1', 'u_b3'] });
      const keys = s.chips.map((c) => c.key);
      expect(new Set(keys).size).toBe(keys.length);
      expect(keys).toHaveLength(row2.length);
      if (activeKey) expect(keys[0]).toBe(activeKey);
    }
  });

  it('draws nothing extra when nobody is from another family', () => {
    const s = strip({ contacts: row });
    expect(s.groups).toEqual([]);
    expect(stripSegments(s, s.chips.length)).toEqual([{ family: null, chips: s.chips }]);
  });

  describe('the window (stripWindow + stripSegments)', () => {
    it('caps the tail as before — the current family first, so strangers are the first to wait behind the limit', () => {
      const s = strip({ activeKey: 'm_p1' });
      expect(names(stripWindow(s, 2))).toEqual(names(s.chips).slice(0, s.fixed + 2));
      expect(names(stripWindow(s, 2)).some((n) => n.startsWith('b') || n.startsWith('l'))).toBe(false);
    });

    it('never parts a delimiter from its first chip: a window ending before the group never draws it', () => {
      const s = strip();
      const first = s.groups[0]!.from; // 6
      for (let shown = 0; shown <= first; shown++) {
        expect(stripSegments(s, shown).every((seg) => seg.family === null)).toBe(true);
      }
      // One chip into the group and the delimiter is there, with exactly that chip.
      const into = runs(s, first + 1);
      expect(into[into.length - 1]).toEqual({ family: 'Бобри', chips: ['b1'] });
    });

    it('a window that ends INSIDE a group keeps the delimiter and the chips that fit; the next group is not reached', () => {
      const s = strip();
      expect(runs(s, 8)).toEqual([
        { family: null, chips: ['Мася', 'Родина', 'p1', 'p2', 'p3', 'g1'] },
        { family: 'Бобри', chips: ['b1', 'b2'] },
      ]);
    });

    it('a group is cut exactly at the window — never an empty group, and the runs always add up to the shown chips', () => {
      const s = strip({ activeKey: 'u_b1', recency: ['u_l1'] });
      for (let shown = 0; shown <= s.chips.length + 2; shown++) {
        const segs = stripSegments(s, shown);
        expect(segs.every((seg) => seg.chips.length > 0)).toBe(true);
        expect(segs.flatMap((seg) => seg.chips)).toEqual(s.chips.slice(0, shown));
        // The delimiter is never the strip's first thing: the first run is always the current family's.
        if (segs.length) expect(segs[0]?.family).toBeNull();
      }
    });

    it("a delimiter is not the strip's first thing: a strip that OPENS with strangers (no active chip, no Masia) is drawn bare", () => {
      const s = bankStrip({ contacts: [b1, b2, l1] });
      expect(s.groups.map((g) => g.from)).toEqual([0, 2]);
      expect(runs(s)).toEqual([
        { family: null, chips: ['b1', 'b2'] },
        { family: 'Лиси', chips: ['l1'] },
      ]);
    });
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
  /** A contact with the family the host says they are from (П16). */
  const conF = (
    userId: string,
    displayName: string,
    isPrimaryMember: boolean,
    familyId: string | null,
    familyName: string | null,
  ): ContactLite => ({ ...con(userId, displayName, isPrimaryMember), familyId, familyName });
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
    const s = bankStrip({ contacts: built });
    expect(names(s.chips.slice(0, s.fixed))).toEqual(['Masia', 'Родина']);
    // П16: Ірина (a «Родина» friend, no primary family of her own on the row) is not the current family's — she
    // sits behind the family's own tail (the group «Похід») under a delimiter; the fixed head is unchanged.
    expect(names(s.chips.slice(s.fixed))).toEqual(['Данило', 'Похід', 'Ірина']);
  });

  it('is unchanged for a family with no accounts and no flags', () => {
    const built = buildContacts([mem('p1', 'Данило'), mem('p2', 'Соломія')], [], labels, 'p0');
    expect(keys(built)).toEqual(['masia', 'family', 'm_p1', 'm_p2']);
  });

  it("seats my PRIMARY family behind a delimiter in another family's row — as a foreign group, never among its people (П16)", () => {
    // Standing in a family that is not my primary one: `GET /users/me/contacts` still computes my primary family's people.
    // They USED to be dropped here; now they are kept — as another family's people (`otherFamily`, named by the host) — so
    // the contact I last opened (a relative) does not vanish from the strip when I switch family. Only the person who is
    // actually seated here is the family's own.
    const built = buildContacts([mem('p9', 'Ірина', 'uL')], [], labels, 'p0', [
      conF('uMum', 'Мама', true, 'f-home', 'Масіні'),
      con('uL', 'Ірина'),
      conF('uZ', 'Зоя', false, 'f-zoya', 'Зої'),
    ]);
    expect(keys(built)).toEqual(['masia', 'family', 'u_uL', 'u_uMum', 'u_uZ']);
    expect(built.find((c) => c.key === 'u_uL')?.otherFamily).toBeUndefined();
    expect(built.find((c) => c.key === 'u_uMum')?.otherFamily).toEqual({ id: 'f-home', name: 'Масіні' });
    expect(built.find((c) => c.key === 'u_uZ')?.otherFamily).toEqual({ id: 'f-zoya', name: 'Зої' });
    // …and the strip puts them behind one delimiter each, after the family's own person.
    const s = bankStrip({ contacts: built });
    expect(names(s.chips)).toEqual(['Masia', 'Родина', 'Ірина', 'Мама', 'Зоя']);
    expect(s.groups.map((g) => g.family.name)).toEqual(['Масіні', 'Зої']);
  });

  it('a contact I know through several families belongs to the CURRENT family when they are in it (no otherFamily)', () => {
    // Zoya is my friend (her own primary family is «Зої») AND a member of the family I stand in: one plate, the family's.
    const built = buildContacts([mem('p1', 'Зоя', 'uZ')], [], labels, 'p0', [conF('uZ', 'Zoya', false, 'f-zoya', 'Зої')]);
    expect(keys(built)).toEqual(['masia', 'family', 'u_uZ']);
    expect(built.find((c) => c.key === 'u_uZ')?.otherFamily).toBeUndefined();
    expect(bankStrip({ contacts: built }).groups).toEqual([]);
  });

  it('keeps a «Родина»-circle friend a stranger: the flag orders them inside their group, it does not move them into mine', () => {
    const built = buildContacts(
      [mem('p1', 'Данило')],
      [],
      labels,
      'p0',
      [conF('uA', 'Аня', false, 'f-a', 'Ані'), conF('uL', 'Ірина', false, 'f-l', 'Лісові')],
      new Set(['uL']),
    );
    expect(keys(built)).toEqual(['masia', 'family', 'm_p1', 'u_uL', 'u_uA']);
    expect(built.find((c) => c.key === 'u_uL')?.otherFamily).toEqual({ id: 'f-l', name: 'Лісові' });
    expect(names(bankStrip({ contacts: built }).chips)).toEqual(['Masia', 'Родина', 'Данило', 'Ірина', 'Аня']);
  });

  it('a contact whose family the host did not say is a stranger with a NAMELESS family — never a guessed name', () => {
    const built = buildContacts([mem('p1', 'Данило')], [], labels, 'p0', [con('uX', 'Х')]);
    expect(built.find((c) => c.key === 'u_uX')?.otherFamily).toEqual({ id: null, name: null });
  });

  it('holds back my primary family until the member list has answered — unknown is not foreign', () => {
    // Before `members` carries MY row (a first load, or the beat after a family switch) a relative of my primary family looks
    // exactly like a person of another family; flashing them behind «ІНША РОДИНА» for that beat would be a lie.
    const contacts = [conF('uMum', 'Мама', true, 'f-home', 'Масіні'), conF('uZ', 'Зоя', false, 'f-zoya', 'Зої')];
    const early = buildContacts([], [], labels, 'p0', contacts, new Set(), { membersKnown: false });
    expect(keys(early)).toEqual(['masia', 'family', 'u_uZ']);
    const answered = buildContacts([mem('p0', 'Я')], [], labels, 'p0', contacts, new Set(), { membersKnown: true });
    expect(keys(answered)).toEqual(['masia', 'family', 'u_uMum', 'u_uZ']); // (I am not my own plate)
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
    unreadMentions: 0,
    mutedUntil: null,
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

  // 2026-11-07: a tap on a message push opened the empty «pick a contact» placeholder — the push names a CONVERSATION
  // (`/messages/<id>` → `/messenger/<id>`), the route wants a contact. The page asks the inverse below.
  it('🔴 a push’s conversation id leads back to its contact — the inverse of the same rule', () => {
    const masiaPlate: MessengerContact = { key: 'masia', kind: 'MASIA', entityType: 'MASIA', id: 'masia', name: 'Мася', avatarUrl: null, isAi: true };
    const familyPlate: MessengerContact = { key: 'family', kind: 'FAMILY', entityType: 'FAMILY_GROUP', id: 'family', name: 'Родина', avatarUrl: null, isAi: false };
    const plates = [masiaPlate, familyPlate, person('p1'), contactPlate('uX'), group('g1')];
    const owner = (id: string) => contactKeyForConversation(plates, inbox, id, 'me', 'uMe');
    expect(owner('dm-person')).toBe('m_p1');
    expect(owner('dm-user')).toBe(contactRouteKey('uX'));
    expect(owner('grp')).toBe(group('g1').key);
    expect(owner('fam')).toBe('family');
    expect(owner('ai-old')).toBe('masia');
    // Every id the forward rule hands out comes back to the plate it came from.
    for (const plate of plates) {
      for (const c of getEntityConversations(plate.entityType, plate.id, inbox, 'me', 'uMe')) {
        expect(owner(c.id), c.id).toBe(plate.key);
      }
    }
  });

  it('a chat whose contact is not on my bank still finds one — derived, and checked by the same forward rule', () => {
    expect(contactKeyForConversation([person('p1')], inbox, 'grp', 'me')).toBe('g_g1');
    expect(contactKeyForConversation([], inbox, 'dm-person', 'me')).toBe('m_p1');
    expect(contactKeyForConversation([], inbox, 'ai-old', 'me')).toBe('masia');
    expect(contactKeyForConversation([], inbox, 'fam', 'me')).toBe('family');
    // A cross-family seat: its person key matches by person, which the forward rule accepts for this very chat.
    const derived = contactKeyForConversation([], inbox, 'dm-user', 'me', 'uMe')!;
    const dec = decodeContactKey(derived)!;
    expect(ids(getEntityConversations(dec.entityType, dec.id, inbox, 'me', 'uMe'))).toContain('dm-user');
  });

  it('an id that is not in my inbox (another family, deleted) gives null', () => {
    expect(contactKeyForConversation([person('p1')], inbox, 'not-mine', 'me')).toBeNull();
    expect(contactKeyForConversation([], [], 'dm-person', 'me')).toBeNull();
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

/**
 * conversationsWithoutDoor — the rooms the inbox returns but no door of the bank opens. The pad's count leaves them out
 * (polishing П17): a deleted group's chat, a DM with a contact who was unpinned or blocked (the contacts list drops them, so
 * the DM loses its plate), a DM with a member who left. The matching rule is the ONE `getEntityConversations`; this only
 * asks which known rooms nothing owns.
 */
describe('conversationsWithoutDoor (П17)', () => {
  const room = (id: string, over: Partial<MessengerConversationPreview> = {}): MessengerConversationPreview => ({
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
    unreadMentions: 0,
    mutedUntil: null,
    participantCount: 2,
    participants: [],
    createdAt: '2026-01-01T00:00:00Z',
    ...over,
  });
  const dmWith = (id: string, userId: string, personId: string) =>
    room(id, {
      participants: [
        { personId: 'me', name: 'Я', userId: 'uMe' },
        { personId, name: personId, userId },
      ],
    });
  const contactPlate = (userId: string): MessengerContact => ({
    key: contactRouteKey(userId),
    kind: 'CONTACT',
    entityType: 'CONTACT',
    id: userId,
    name: userId,
    avatarUrl: null,
    isAi: false,
  });

  const inbox = [
    room('ai-primary', { type: 'AI_CHAT', isPrimary: true }),
    room('ai-old', { type: 'AI_CHAT' }),
    room('fam', { type: 'FAMILY' }),
    room('dm-member', { participants: [{ personId: 'me', name: 'Я' }, { personId: 'p1', name: 'Данило' }] }),
    dmWith('dm-friend', 'uFriend', 'pf'),
    dmWith('dm-blocked', 'uBlocked', 'pb'),
    dmWith('dm-unpinned', 'uOld', 'po'),
    dmWith('dm-relative', 'uRel', 'pr'),
    room('grp-live', { type: 'GROUP', groupId: 'g-live' }),
    room('grp-deleted', { type: 'GROUP', groupId: 'g-gone' }),
  ];
  const doors = [masia, family, person('p1'), contactPlate('uFriend'), group('g-live')];
  const without = (over: { doors?: typeof doors; accepted?: { userId: string }[]; conversations?: typeof inbox } = {}) =>
    [
      ...conversationsWithoutDoor({
        doors: over.doors ?? doors,
        acceptedContacts: over.accepted ?? [],
        conversations: over.conversations ?? inbox,
        selfPersonId: 'me',
        selfUserId: 'uMe',
      }),
    ].sort();

  it('a deleted group\'s chat (no live group owns it), a blocked contact\'s DM and an unpinned contact\'s DM have no door', () => {
    // `getContacts` drops the blocked and the unpinned, so neither has a `u_` plate; the deleted group has no `g_` plate.
    expect(without({ accepted: [{ userId: 'uFriend' }, { userId: 'uRel' }] })).toEqual(['dm-blocked', 'dm-unpinned', 'grp-deleted']);
  });

  it('every kind of plate opens its rooms: the assistant (ALL her chats), the family, a member, a contact, a live group', () => {
    const open = without({ accepted: [{ userId: 'uFriend' }, { userId: 'uRel' }] });
    for (const id of ['ai-primary', 'ai-old', 'fam', 'dm-member', 'dm-friend', 'grp-live', 'dm-relative']) {
      expect(open).not.toContain(id);
    }
  });

  it('an accepted contact outside the active family\'s row (a relative of the primary family) is still a door — the circles open it', () => {
    expect(without()).toContain('dm-relative'); // not accepted here → no door
    expect(without({ accepted: [{ userId: 'uRel' }] })).not.toContain('dm-relative');
  });

  it('a member who left (no `m_` plate any more) leaves their DM without a door', () => {
    expect(without({ doors: doors.filter((d) => d.id !== 'p1') })).toContain('dm-member');
  });

  it('a room the inbox has not returned is not in the answer (unknown is not unreachable); an empty inbox gives an empty set', () => {
    expect(without({ conversations: [] })).toEqual([]);
    expect(without()).not.toContain('brand-new-dm');
  });
});
