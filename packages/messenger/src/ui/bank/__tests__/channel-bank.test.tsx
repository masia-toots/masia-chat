// @vitest-environment jsdom
/**
 * The channel bank against the package's fakes (a fake scroller without arrows, a fake menu and
 * person chip). What is proven here is the bank's OWN behaviour (Ф2.4, 2026-11-03 — ONE strip):
 *   · structure — ONE scroller slot holds every chip; there is no hairline, no door, no picker chip, no seat slot;
 *   · order — the strip is `bankStrip`'s (active first, Masia second, family, pins, then recency);
 *   · chips — the active one is marked, every chip keeps its name as the accessible name + hover title (none draws it),
 *     the locked ones, the face slot;
 *   · the lazy window grows when its end sentinel comes into view, until nothing is left, and never cuts the fixed head.
 * The arrow, the wheel and the edge fade belong to the host's real scroller and are proven there.
 *
 * jsdom has no layout: `IntersectionObserver` is a fake the test fires by hand.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { assistantContact, contactsOf, familyContact, personContact } from '../../../test-support/fake-contacts.js';
import { cleanupUi, click, q, qa, renderUi } from '../../../test-support/fake-ui.js';
import { ChannelBank, chipAttention, type ChannelBankProps } from '../channel-bank.js';

const WINDOW = 12; // the fake env's `bankWindow.initial`

class FakeIO {
  static all = new Set<FakeIO>();
  constructor(private cb: (e: Array<{ isIntersecting: boolean }>) => void) {
    FakeIO.all.add(this);
  }
  observe() {}
  unobserve() {}
  disconnect() {
    FakeIO.all.delete(this);
  }
  hit() {
    this.cb([{ isIntersecting: true }]);
  }
}

beforeEach(() => {
  FakeIO.all.clear();
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = FakeIO;
});

afterEach(() => {
  cleanupUi();
  delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
  vi.restoreAllMocks();
});

function mount(n: number, props: Partial<ChannelBankProps> = {}) {
  return renderUi(<ChannelBank contacts={contactsOf(n)} activeKey="masia" onSelect={() => undefined} {...props} />);
}
const strip = () => q('.chbank__strip')!;
const chips = () => qa('.chbank__plate', strip());
const titles = () => chips().map((p) => p.title);

describe('ChannelBank: structure', () => {
  it('is ONE scroller slot holding every chip — no sections, hairline, doors, picker chip or seat', () => {
    mount(5);
    expect(qa('.hscroll')).toHaveLength(1);
    expect(strip().classList.contains('hscroll__viewport')).toBe(true);
    expect(chips()).toHaveLength(7); // Masia, the family, five people — all in the one strip
    for (const gone of ['.chbank__sep', '.chbank__doors', '.chbank__convs', '.chbank__seat', '.chbank__people', '.chbank__pinned', '.chbank__recent']) {
      expect(q(gone), gone).toBeNull();
    }
  });

  it('asks the scroller slot for the gutter arrows (never over a chip; hover only)', () => {
    mount(3, { activeKey: 'u_1' });
    expect(q('.chbank__scroll')!.getAttribute('data-arrows')).toBe('gutter');
  });

  it('is a toolbar named from the bundle and carries the theme tokens on its own root', () => {
    mount(2);
    expect(strip().getAttribute('role')).toBe('toolbar');
    expect(strip().getAttribute('aria-label')).toBe('Channels');
    expect(q('.chbank')!.style.getPropertyValue('--msg-chip-size')).toBe('2.5rem');
  });

  it('draws nothing for an empty contact list', () => {
    renderUi(<ChannelBank contacts={[]} onSelect={() => undefined} />);
    expect(q('.chbank')).toBeNull();
  });
});

describe('ChannelBank: the strip order (bankStrip)', () => {
  it('seats the ACTIVE contact first and Masia SECOND, then the family, then everyone else', () => {
    mount(3, { activeKey: 'u_1' });
    expect(chips().map((p) => p.dataset.kind)).toEqual(['CONTACT', 'MASIA', 'FAMILY', 'CONTACT', 'CONTACT']);
    expect(titles()).toEqual(['Person 1', 'Assistant', 'Family', 'Person 0', 'Person 2']);
  });

  it('seats Masia first when she is the active one, never repeated', () => {
    mount(2);
    expect(titles()).toEqual(['Assistant', 'Family', 'Person 0', 'Person 1']);
  });

  it('puts the pinned contacts after the family, before the recency tail, and the recency tail by recency', () => {
    mount(4, { activeKey: 'masia', pinnedKeys: ['u_2'], recency: ['u_3', 'u_1'] });
    expect(titles()).toEqual(['Assistant', 'Family', 'Person 2', 'Person 3', 'Person 1', 'Person 0']);
  });
});

describe('ChannelBank: chips', () => {
  it('marks the active chip, names it for a screen reader and on hover (no drawn name), and selects a contact on click', () => {
    const onSelect = vi.fn();
    mount(2, { onSelect });
    const live = q('.chbank__plate.is-live')!;
    expect(live.getAttribute('aria-current')).toBe('true');
    // The name is the accessible name + the hover title — Ф2.8b-A draws it on NO chip, the live one included. jsdom has no layout, so
    // «not drawn» is read off the markup: the name sits in the visually-hidden `.chbank__name` and is the ONLY text in the chip
    // (`check-bank-strip.mjs` asserts the same on the real layout).
    expect(live.querySelector('.chbank__name')!.textContent).toBe('Assistant');
    expect(live.title).toBe('Assistant');
    expect(live.textContent).toBe('Assistant');
    expect(qa('.chbank__plate.is-live')).toHaveLength(1);
    click(chips()[3]!);
    expect(onSelect).toHaveBeenCalledWith(personContact(1));
  });

  it('keeps every chip named for a screen reader (the name element exists on every chip, the live one included)', () => {
    mount(2);
    expect(chips().map((p) => p.querySelector('.chbank__name')!.textContent)).toEqual([
      'Assistant',
      'Family',
      'Person 0',
      'Person 1',
    ]);
  });

  it('locks a channel: it explains itself, shows the lock icon, and reports instead of selecting', () => {
    const onSelect = vi.fn();
    const onLockedSelect = vi.fn();
    mount(1, { onSelect, onLockedSelect, lockedKeys: ['u_0'] });
    const chip = chips().find((p) => p.classList.contains('is-locked'))!;
    expect(chip.title).toBe('Available in the full version');
    const lock = chip.querySelector('svg')!;
    expect(lock.getAttribute('data-icon')).toBe('close');
    expect(lock.getAttribute('data-size')).toBe('11');
    expect(lock.getAttribute('class')).toBe('chbank__lock');
    click(chip);
    expect(onLockedSelect).toHaveBeenCalledWith(personContact(0));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('draws the default face: a group for the family, a human for a person', () => {
    mount(1);
    const byName = Object.fromEntries(qa('[data-chip]').map((c) => [c.getAttribute('data-chip-name'), c.getAttribute('data-chip')]));
    expect(byName[familyContact.name]).toBe('GROUP');
    expect(byName['Person 0']).toBe('HUMAN');
  });

  it('lets the host put its own face and berth attributes on a chip, and keeps the default elsewhere', () => {
    mount(1, {
      renderFace: (c) =>
        c.isAi ? { berth: { 'data-host-slot': 'intercom' }, node: <i data-host-face="" /> } : null,
    });
    const berth = q('[data-host-slot]')!;
    expect(berth.getAttribute('data-host-slot')).toBe('intercom');
    expect(berth.classList.contains('chbank__chip')).toBe(true);
    expect(berth.getAttribute('aria-hidden')).toBe('true');
    expect(berth.querySelector('[data-host-face]')).toBeTruthy();
    expect(berth.querySelector('[data-chip]')).toBeNull();
    expect(qa('[data-chip]').length).toBeGreaterThan(0); // the other chips kept the default
  });

  it('keeps an empty berth in the DOM when the host face draws nothing yet', () => {
    mount(0, { renderFace: (c) => (c.isAi ? { berth: { 'data-host-slot': 'x' }, node: null } : null) });
    expect(q('[data-host-slot]')).toBeTruthy();
  });

  it('needs no host to draw the assistant: the default face stands in', () => {
    renderUi(<ChannelBank contacts={[assistantContact]} activeKey="masia" onSelect={() => undefined} />);
    expect(chips()).toHaveLength(1);
    expect(q('[data-chip]')!.getAttribute('data-chip')).toBe('HUMAN');
  });
});

describe('ChannelBank: the lazy window', () => {
  it('renders the fixed head plus the first window of the tail, keeps the sentinel, and grows until none are left', () => {
    mount(WINDOW + 8); // head = Masia + family (active is Masia) = 2; tail = 20
    expect(chips()).toHaveLength(2 + WINDOW);
    expect(strip().querySelector('.chbank__more')).not.toBeNull();
    expect(q('.chbank__scroll')!.getAttribute('data-end-more')).toBe('true');
    act(() => {
      FakeIO.all.forEach((io) => io.hit());
    });
    expect(chips()).toHaveLength(2 + WINDOW + 8);
    expect(strip().querySelector('.chbank__more')).toBeNull();
    expect(q('.chbank__scroll')!.hasAttribute('data-end-more')).toBe(false);
  });

  it('never cuts the fixed head: Masia, the family and the pins are there with a window of nothing', () => {
    renderUi(<ChannelBank contacts={contactsOf(6)} activeKey="u_3" pinnedKeys={['u_5']} onSelect={() => undefined} />, {
      env: {
        bankWindow: { initial: 0, grow: (c, t) => Math.min(t, c + 2) },
        phoneQuery: '(max-width: 1px)',
        reactions: [],
        notifyError: () => undefined,
      },
    });
    expect(titles()).toEqual(['Person 3', 'Assistant', 'Family', 'Person 5']);
  });

  it('asks the host how far to grow, with the current size and the TAIL total', () => {
    const grow = vi.fn((current: number, total: number) => Math.min(total, current + 3));
    renderUi(<ChannelBank contacts={contactsOf(10)} activeKey="masia" onSelect={() => undefined} />, {
      env: {
        bankWindow: { initial: 4, grow },
        phoneQuery: '(max-width: 1px)',
        reactions: [],
        notifyError: () => undefined,
      },
    });
    expect(chips()).toHaveLength(2 + 4);
    act(() => {
      FakeIO.all.forEach((io) => io.hit());
    });
    expect(grow).toHaveBeenCalledWith(4, 10); // 12 contacts − 2 fixed = 10 in the tail
    expect(chips()).toHaveLength(2 + 7);
  });

  it('shows no sentinel when everything fits the window', () => {
    mount(3);
    expect(strip().querySelector('.chbank__more')).toBeNull();
  });
});

/**
 * OTHER FAMILIES (polishing П16, founder 2026-11-08, variant Г). The model (`bankStrip` / `stripSegments`) decides who sits where
 * and its own tests falsify that; what is proven HERE is what the bank draws from it: a delimiter — a thin tick and the family's
 * name (founder 2026-11-22: «тільки назва»; the caps kicker only for an unnamed family), in a group named for a screen reader —
 * before the FIRST chip of each other family, only when such a chip is shown,
 * never before the active chip, never a control, and no badge on any chip.
 */
describe('ChannelBank: other families (П16)', () => {
  const bobry = { id: 'f-bobry', name: 'Бобри' };
  const lisy = { id: 'f-lisy', name: 'Лиси' };
  const stranger = (i: number, otherFamily: { id: string | null; name: string | null }) => ({ ...personContact(i), otherFamily });
  const groups = () => qa('.chbank__family', strip());
  const delims = () => qa('.chbank__delim', strip());
  const mine = [assistantContact, familyContact, personContact(0)];

  it('draws no delimiter, no group and no extra wrapper when nobody is from another family', () => {
    mount(3);
    expect(delims()).toHaveLength(0);
    expect(groups()).toHaveLength(0);
    // The chips are the scroller's own children, exactly as before.
    expect([...strip().children].every((el) => el.classList.contains('chbank__plate'))).toBe(true);
  });

  it('puts a delimiter before the first chip of another family — a group named for a screen reader, the header aria-hidden and not a control', () => {
    mount(0, { contacts: [...mine, stranger(1, bobry), stranger(2, bobry)] });
    expect(titles()).toEqual(['Assistant', 'Family', 'Person 0', 'Person 1', 'Person 2']);
    expect(delims()).toHaveLength(1);
    const group = groups()[0]!;
    expect(group.getAttribute('role')).toBe('group');
    expect(group.getAttribute('aria-label')).toBe('Other family · Бобри');
    // The delimiter is the group's FIRST child, so nothing can part it from the chip it introduces…
    const delim = group.firstElementChild!;
    expect(delim.classList.contains('chbank__delim')).toBe(true);
    expect(delim.getAttribute('aria-hidden')).toBe('true');
    // The visible header is the family's NAME alone (founder 2026-11-22: «тільки назва»); the screen reader still hears
    // «Other family · Бобри» from the group's label.
    expect(q('.chbank__delim-name', delim)!.textContent).toBe('Бобри');
    expect(q('.chbank__delim-kicker', delim)).toBeNull();
    expect(delim.textContent).toBe('Бобри');
    // …and it is a picture, not a control: no button, nothing focusable.
    expect(delim.tagName).not.toBe('BUTTON');
    expect(qa('button, [tabindex]', delim)).toHaveLength(0);
    // The group holds the strangers' chips, and ONLY theirs; the family's own stay bare in the scroller.
    expect(qa('.chbank__plate', group).map((p) => p.title)).toEqual(['Person 1', 'Person 2']);
    expect(chips().filter((p) => p.parentElement === strip()).map((p) => p.title)).toEqual(['Assistant', 'Family', 'Person 0']);
    // No badge on the chips themselves (founder: a delimiter, not a badge).
    expect(qa('.chbank__plate [data-family], .chbank__plate .chbank__family-badge', strip())).toHaveLength(0);
  });

  it('draws ONE delimiter per family, each before its own first chip', () => {
    mount(0, { contacts: [...mine, stranger(1, bobry), stranger(2, lisy), stranger(3, bobry)] });
    expect(groups().map((g) => g.getAttribute('aria-label'))).toEqual(['Other family · Бобри', 'Other family · Лиси']);
    expect(groups().map((g) => qa('.chbank__plate', g).map((p) => p.title))).toEqual([['Person 1', 'Person 3'], ['Person 2']]);
  });

  it('never puts the delimiter before the ACTIVE chip: an active stranger sits first, bare, with its family behind the delimiter', () => {
    mount(0, { contacts: [...mine, stranger(1, bobry), stranger(2, bobry)], activeKey: 'u_1' });
    expect(titles()).toEqual(['Person 1', 'Assistant', 'Family', 'Person 0', 'Person 2']);
    const first = strip().firstElementChild!;
    expect(first.tagName).toBe('BUTTON');
    expect(first.getAttribute('aria-current')).toBe('true');
    // Its family's OTHER person is still behind a delimiter; the active chip is in no group.
    expect(groups()).toHaveLength(1);
    expect(qa('.chbank__plate', groups()[0]).map((p) => p.title)).toEqual(['Person 2']);
    // …and if the active one was the only person of their family there is no delimiter for that family at all.
    cleanupUi();
    mount(0, { contacts: [...mine, stranger(1, bobry)], activeKey: 'u_1' });
    expect(delims()).toHaveLength(0);
    expect(titles()).toEqual(['Person 1', 'Assistant', 'Family', 'Person 0']);
  });

  it('a family the host could not name gets a delimiter with the kicker alone — never a guessed name', () => {
    mount(0, { contacts: [...mine, stranger(1, { id: null, name: null })] });
    const group = groups()[0]!;
    expect(group.getAttribute('aria-label')).toBe('Other family');
    expect(q('.chbank__delim-kicker', group)!.textContent).toBe('Other family');
    expect(q('.chbank__delim-name', group)).toBeNull();
  });

  it('keeps a delimiter with its first chip under the lazy window: not drawn while the window ends before the group, drawn WITH its chip once it grows', () => {
    const env = {
      bankWindow: { initial: 2, grow: (c: number, t: number) => Math.min(t, c + 2) },
      phoneQuery: '(max-width: 1px)',
      reactions: [],
      notifyError: () => undefined,
    };
    // head = Masia + family; tail = Person 0..3 (own) then one stranger → total 5.
    renderUi(
      <ChannelBank
        contacts={[assistantContact, familyContact, ...[0, 1, 2, 3].map(personContact), stranger(9, bobry)]}
        activeKey="masia"
        onSelect={() => undefined}
      />,
      { env },
    );
    expect(titles()).toEqual(['Assistant', 'Family', 'Person 0', 'Person 1']);
    expect(delims()).toHaveLength(0);
    act(() => FakeIO.all.forEach((io) => io.hit()));
    expect(titles()).toEqual(['Assistant', 'Family', 'Person 0', 'Person 1', 'Person 2', 'Person 3']);
    expect(delims()).toHaveLength(0);
    act(() => FakeIO.all.forEach((io) => io.hit()));
    expect(titles().slice(-1)).toEqual(['Person 9']);
    expect(delims()).toHaveLength(1);
    expect(qa('.chbank__plate', groups()[0]).map((p) => p.title)).toEqual(['Person 9']);
  });

  it('a click on a stranger selects them like any chip; a click on the delimiter selects nothing', () => {
    const onSelect = vi.fn();
    mount(0, { contacts: [...mine, stranger(1, bobry)], onSelect });
    click(delims()[0]!);
    expect(onSelect).not.toHaveBeenCalled();
    click(chips().find((p) => p.title === 'Person 1')!);
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ key: 'u_1' }));
  });
});

describe('ChannelBank: who waits (ADR-201, chat-attention К2)', () => {
  const plateOf = (name: string) => chips().find((p) => p.title === name)!;
  const withPerson = (extra: Partial<ReturnType<typeof personContact>>) => [assistantContact, familyContact, { ...personContact(0), ...extra }];

  it('draws the unread count on the plate, says it in the accessible name, and nothing when there is none', () => {
    renderUi(<ChannelBank contacts={withPerson({ unread: 3 })} activeKey="masia" onSelect={() => undefined} />);
    const b = plateOf('Person 0').querySelector('.chbank__unread')!;
    expect(b.textContent).toBe('3');
    expect(b.getAttribute('aria-hidden')).toBe('true');
    expect(b.classList.contains('chbank__unread--mention')).toBe(false);
    expect(plateOf('Person 0').querySelector('.chbank__name')!.textContent).toBe('Person 0, 3 unread');
    expect(plateOf('Person 0').classList.contains('has-unread')).toBe(true);
    expect(plateOf('Family').querySelector('.chbank__unread')).toBeNull();
  });

  it('caps at 99+', () => {
    renderUi(<ChannelBank contacts={withPerson({ unread: 148 })} activeKey="masia" onSelect={() => undefined} />);
    expect(plateOf('Person 0').querySelector('.chbank__unread-n')!.textContent).toBe('99+');
  });

  it('accents a mention', () => {
    renderUi(<ChannelBank contacts={withPerson({ unread: 5, unreadMentions: 2 })} activeKey="masia" onSelect={() => undefined} />);
    const b = plateOf('Person 0').querySelector('.chbank__unread')!;
    expect(b.classList.contains('chbank__unread--mention')).toBe(true);
    expect(b.textContent).toBe('5');
    expect(plateOf('Person 0').querySelector('.chbank__name')!.textContent).toBe('Person 0, 5 unread, 2 mentions of you');
  });

  it('a muted room with no mention shows only the 🔇 dot; with a mention, the mention count', () => {
    renderUi(<ChannelBank contacts={withPerson({ unread: 12, muted: true })} activeKey="masia" onSelect={() => undefined} />);
    let b = plateOf('Person 0').querySelector('.chbank__unread')!;
    expect(b.classList.contains('chbank__unread--muted')).toBe(true);
    expect(b.querySelector('.chbank__unread-n')).toBeNull();
    expect(b.querySelector('[data-icon="muted"]')).toBeTruthy();
    expect(plateOf('Person 0').querySelector('.chbank__name')!.textContent).toBe('Person 0, muted');
    cleanupUi();
    renderUi(<ChannelBank contacts={withPerson({ unread: 12, unreadMentions: 2, muted: true })} activeKey="masia" onSelect={() => undefined} />);
    b = plateOf('Person 0').querySelector('.chbank__unread')!;
    expect(b.querySelector('.chbank__unread-n')!.textContent).toBe('2');
    expect(b.classList.contains('chbank__unread--mention')).toBe(true);
  });

  it('a muted room with nothing unread draws nothing', () => {
    renderUi(<ChannelBank contacts={withPerson({ unread: 0, muted: true })} activeKey="masia" onSelect={() => undefined} />);
    expect(plateOf('Person 0').querySelector('.chbank__unread')).toBeNull();
  });

  it('chipAttention is the one rule', () => {
    const p = personContact(1);
    expect(chipAttention(p)).toBeNull();
    expect(chipAttention({ ...p, unread: 2 })).toEqual({ text: '2', mention: false, muted: false });
    expect(chipAttention({ ...p, unread: 100, unreadMentions: 1 })).toEqual({ text: '99+', mention: true, muted: false });
    expect(chipAttention({ ...p, unread: 12, muted: true })).toEqual({ text: null, mention: false, muted: true });
    expect(chipAttention({ ...p, unread: 12, unreadMentions: 2, muted: true })).toEqual({ text: '2', mention: true, muted: true });
    expect(chipAttention({ ...p, unread: 1, unreadMentions: 5 })).toEqual({ text: '1', mention: true, muted: false });
  });
});
