// @vitest-environment jsdom
/**
 * The channel bank against the package's fakes (a fake scroller without arrows, a fake menu and
 * person chip). What is proven here is the bank's OWN behaviour:
 *   · structure — the pinned and recent strips are scroller slots, the doors stand outside them;
 *   · plates — the live one, the locked ones, the face slot;
 *   · the lazy window grows when its end sentinel comes into view, until nothing is left;
 *   · the overflow latch folds fast and unfolds only with real slack;
 *   · the picker chip and the fold report.
 * The arrows, the wheel and the edge fade belong to the host's real scroller and are proven there.
 *
 * jsdom has no layout: geometry is faked per class (`.chbank` and the two scrollers);
 * `ResizeObserver` and `IntersectionObserver` are fakes the test fires by hand.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { assistantContact, contactsOf, familyContact, personContact } from '../../../test-support/fake-contacts.js';
import { cleanupUi, click, q, qa, renderUi } from '../../../test-support/fake-ui.js';
import { ChannelBank, type ChannelBankProps } from '../channel-bank.js';

const WINDOW = 12; // the fake env's `bankWindow.initial`

const geo = {
  bank: { cw: 400, sw: 400 },
  recent: { cw: 200, sw: 200 },
  pinned: { cw: 120, sw: 120 },
};
const kindOf = (el: Element): keyof typeof geo | null =>
  el.classList.contains('chbank')
    ? 'bank'
    : el.classList.contains('chbank__recent')
      ? 'recent'
      : el.classList.contains('chbank__pinned')
        ? 'pinned'
        : null;

class FakeRO {
  static all = new Set<FakeRO>();
  constructor(private cb: () => void) {
    FakeRO.all.add(this);
  }
  observe() {
    FakeRO.all.add(this);
  }
  unobserve() {}
  disconnect() {
    FakeRO.all.delete(this);
  }
  fire() {
    this.cb();
  }
}
const fireResize = () =>
  act(() => {
    FakeRO.all.forEach((r) => r.fire());
  });

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

const restore: Array<() => void> = [];
function patch(proto: object, key: string, desc: PropertyDescriptor): void {
  const prev = Object.getOwnPropertyDescriptor(proto, key);
  Object.defineProperty(proto, key, { configurable: true, ...desc });
  restore.push(() => {
    if (prev) Object.defineProperty(proto, key, prev);
    else delete (proto as Record<string, unknown>)[key];
  });
}

beforeEach(() => {
  geo.bank = { cw: 400, sw: 400 };
  geo.recent = { cw: 200, sw: 200 };
  geo.pinned = { cw: 120, sw: 120 };
  FakeRO.all.clear();
  FakeIO.all.clear();
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeRO;
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = FakeIO;
  patch(HTMLElement.prototype, 'clientWidth', {
    get(this: HTMLElement) {
      const k = kindOf(this);
      return k ? geo[k].cw : 0;
    },
  });
  patch(HTMLElement.prototype, 'scrollWidth', {
    get(this: HTMLElement) {
      const k = kindOf(this);
      return k ? geo[k].sw : 0;
    },
  });
});

afterEach(() => {
  cleanupUi();
  restore.splice(0).reverse().forEach((r) => r());
  delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
  vi.restoreAllMocks();
});

function mount(n: number, props: Partial<ChannelBankProps> = {}) {
  return renderUi(
    <ChannelBank
      contacts={contactsOf(n)}
      activeKey="masia"
      onSelect={() => undefined}
      peopleSlot={<button data-contacts-door="people">p</button>}
      {...props}
    />,
  );
}
const recentVp = () => q('.chbank__recent')!;
const plateCount = () => qa('.chbank__plate', recentVp()).length;

describe('ChannelBank: structure', () => {
  it('pinned and recent are scroller slots; the door stands OUTSIDE every scroller', () => {
    mount(5);
    for (const sel of ['.chbank__scroll--pinned', '.chbank__scroll--recent']) {
      expect(q(sel)!.classList.contains('hscroll'), sel).toBe(true);
    }
    expect(recentVp().classList.contains('hscroll__viewport')).toBe(true);
    expect(recentVp().getAttribute('role')).toBe('group');
    expect(recentVp().getAttribute('aria-label')).toBe('Recent');
    expect(q('.chbank__scroll--pinned .hscroll__viewport')!.getAttribute('aria-label')).toBe('Pinned');
    const doors = q('.chbank__doors')!;
    expect(doors.closest('.hscroll')).toBeNull();
    expect(qa('[data-contacts-door]', doors)).toHaveLength(1);
  });

  it('is a toolbar named from the bundle and carries the theme tokens on its own root', () => {
    mount(2);
    const bank = q('.chbank')!;
    expect(bank.getAttribute('role')).toBe('toolbar');
    expect(bank.getAttribute('aria-label')).toBe('Channels');
    expect(bank.style.getPropertyValue('--msg-chip-size')).toBe('2.5rem');
  });

  it('draws nothing for an empty contact list', () => {
    renderUi(<ChannelBank contacts={[]} onSelect={() => undefined} />);
    expect(q('.chbank')).toBeNull();
  });

  it('seats the live contact first, the assistant and the family pinned, everyone else recent', () => {
    mount(3, { activeKey: 'u_1' });
    const order = qa('.chbank__plate').map((p) => p.dataset.kind);
    expect(order[0]).toBe('CONTACT'); // seat 1 is the live one, whoever it is
    expect(qa('.chbank__plate', q('.chbank__pinned')!).map((p) => p.dataset.kind)).toEqual(['MASIA', 'FAMILY']);
    expect(qa('.chbank__plate', recentVp()).map((p) => p.title)).toEqual(['Person 0', 'Person 2']);
    expect(q('.chbank__sep')).toBeTruthy();
  });
});

describe('ChannelBank: plates', () => {
  it('marks the live plate and selects a contact on click', () => {
    const onSelect = vi.fn();
    mount(2, { onSelect });
    const live = q('.chbank__plate.is-live')!;
    expect(live.getAttribute('aria-current')).toBe('true');
    expect(live.querySelector('.chbank__name')!.textContent).toBe('Assistant');
    click(qa('.chbank__plate', recentVp())[1]!);
    expect(onSelect).toHaveBeenCalledWith(personContact(1));
  });

  it('locks a channel: it explains itself, shows the lock icon, and reports instead of selecting', () => {
    const onSelect = vi.fn();
    const onLockedSelect = vi.fn();
    mount(1, { onSelect, onLockedSelect, lockedKeys: ['u_0'] });
    const plate = qa('.chbank__plate', recentVp())[0]!;
    expect(plate.classList.contains('is-locked')).toBe(true);
    expect(plate.title).toBe('Available in the full version');
    const lock = plate.querySelector('svg')!;
    expect(lock.getAttribute('data-icon')).toBe('close');
    expect(lock.getAttribute('data-size')).toBe('11');
    expect(lock.getAttribute('class')).toBe('chbank__lock');
    click(plate);
    expect(onLockedSelect).toHaveBeenCalledWith(personContact(0));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('draws the default chip: a group for the family, a human for a person', () => {
    mount(1);
    const chips = qa('[data-chip]');
    const byName = Object.fromEntries(chips.map((c) => [c.getAttribute('data-chip-name'), c.getAttribute('data-chip')]));
    expect(byName[familyContact.name]).toBe('GROUP');
    expect(byName['Person 0']).toBe('HUMAN');
  });

  it('lets the host put its own face and berth attributes on a plate, and keeps the default elsewhere', () => {
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
    expect(qa('[data-chip]').length).toBeGreaterThan(0); // the other plates kept the default
  });

  it('keeps an empty berth in the DOM when the host face draws nothing yet', () => {
    mount(0, { renderFace: (c) => (c.isAi ? { berth: { 'data-host-slot': 'x' }, node: null } : null) });
    expect(q('[data-host-slot]')).toBeTruthy();
  });
});

describe('ChannelBank: the lazy window', () => {
  it('renders the first window, keeps the sentinel, and grows when the sentinel is seen, until none are left', () => {
    mount(WINDOW + 8);
    expect(plateCount()).toBe(WINDOW);
    expect(recentVp().querySelector('.chbank__more')).not.toBeNull();
    expect(q('.chbank__scroll--recent')!.getAttribute('data-end-more')).toBe('true');
    act(() => {
      FakeIO.all.forEach((io) => io.hit());
    });
    expect(plateCount()).toBe(WINDOW + 8);
    expect(recentVp().querySelector('.chbank__more')).toBeNull();
    expect(q('.chbank__scroll--recent')!.hasAttribute('data-end-more')).toBe(false);
  });

  it('asks the host how far to grow, with the current size and the total', () => {
    const grow = vi.fn((current: number, total: number) => Math.min(total, current + 3));
    renderUi(<ChannelBank contacts={contactsOf(10)} activeKey="masia" onSelect={() => undefined} />, {
      env: {
        bankWindow: { initial: 4, grow },
        phoneQuery: '(max-width: 1px)',
        reactions: [],
        notifyError: () => undefined,
      },
    });
    expect(plateCount()).toBe(4);
    act(() => {
      FakeIO.all.forEach((io) => io.hit());
    });
    expect(grow).toHaveBeenCalledWith(4, 10);
    expect(plateCount()).toBe(7);
  });

  it('shows no sentinel when everything fits the window', () => {
    mount(3);
    expect(recentVp().querySelector('.chbank__more')).toBeNull();
  });
});

describe('ChannelBank: the overflow latch', () => {
  it('folds on genuine overflow and unfolds only with at least 180 px of slack', () => {
    const on = vi.fn();
    mount(5, { onOverflowChange: on });
    expect(on.mock.calls).toEqual([[false]]); // the latch's first report
    geo.bank = { cw: 400, sw: 410 }; // 410 > 400 + 4 → fold
    fireResize();
    expect(on.mock.calls).toEqual([[false], [true]]);
    geo.bank = { cw: 400, sw: 300 }; // fits again, but 300 > 400 − 180 → STAY folded
    fireResize();
    expect(on.mock.calls).toEqual([[false], [true]]);
    geo.bank = { cw: 400, sw: 210 }; // 210 ≤ 220 → real room → unfold
    fireResize();
    expect(on.mock.calls).toEqual([[false], [true], [false]]);
  });
});

describe('ChannelBank: the conversation picker', () => {
  const picker = (onPick = vi.fn()) => ({
    title: 'Ada · conversations',
    onPick,
    items: [
      { id: 'c1', label: 'Main', glyph: 'pin' as const, current: true },
      { id: 'c2', label: 'Trip', glyph: 'chat' as const, current: false, spaceName: 'Travel', unread: 3 },
    ],
  });

  it('shows the chip with the current glyph and the count, between seat 1 and the pinned strip', () => {
    mount(1, { convPicker: picker() });
    const chip = q('.chbank__convs')!;
    expect(chip.getAttribute('aria-label')).toBe('Ada · conversations');
    expect(chip.querySelector('.chbank__convs-count')!.textContent).toBe('2');
    const icons = qa('svg', chip).map((s) => `${s.getAttribute('data-icon')}:${s.getAttribute('class')}`);
    expect(icons).toEqual(['pin:chbank__ic chbank__convs-glyph', 'chevron:chbank__ic chbank__convs-caret']);
    const bank = q('.chbank')!;
    const children = [...bank.children];
    expect(children.indexOf(chip)).toBe(1);
    expect(children[0]!.classList.contains('chbank__plate')).toBe(true);
  });

  it('opens the menu with the rows, marks the current one, and a pick reports its id once', () => {
    const onPick = vi.fn();
    mount(1, { convPicker: picker(onPick) });
    expect(q('[data-cm=convs]')).toBeNull();
    click(q('.chbank__convs'));
    expect(q('.chbank__convs')!.getAttribute('aria-expanded')).toBe('true');
    expect(q('[data-cm=convs]')).toBeTruthy();
    expect(q('[data-cm-row="conv:c1"]')!.getAttribute('aria-current')).toBe('true');
    expect(q('[data-cm-row="conv:c2"]')!.getAttribute('aria-current')).toBeNull();
    expect(q('[data-cm-row="conv:c2"] .chbank-convs__unread')!.textContent).toBe('3');
    click(q('[data-cm-row="conv:c2"]'));
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith('c2');
    expect(q('[data-cm=convs]')).toBeNull();
  });

  it('has no chip without a live contact or without conversations', () => {
    mount(1, { convPicker: { ...picker(), items: [] } });
    expect(q('.chbank__convs')).toBeNull();
  });

  it('reports whether the host stylesheet folded the chip away', () => {
    const onFold = vi.fn();
    const realStyle = window.getComputedStyle.bind(window);
    let folded = false;
    vi.spyOn(window, 'getComputedStyle').mockImplementation((el: Element) =>
      el.classList.contains('chbank__convs') ? ({ display: folded ? 'none' : 'inline-flex' } as CSSStyleDeclaration) : realStyle(el),
    );
    mount(1, { convPicker: picker(), onConvsFoldChange: onFold });
    expect(onFold.mock.calls).toEqual([[false]]);
    folded = true;
    fireResize();
    expect(onFold.mock.calls).toEqual([[false], [true]]);
  });
});

describe('ChannelBank: the assistant is just a contact to it', () => {
  it('needs no host to draw its plate: the default chip stands in', () => {
    renderUi(<ChannelBank contacts={[assistantContact]} activeKey="masia" onSelect={() => undefined} />);
    expect(qa('.chbank__plate')).toHaveLength(1);
    expect(q('[data-chip]')!.getAttribute('data-chip')).toBe('HUMAN');
  });
});
