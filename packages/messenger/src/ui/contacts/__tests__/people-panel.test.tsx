// @vitest-environment jsdom
/**
 * The "People" tab (plan `player-wide-holo-tabs-people` Ш5, 2026-10-09): ONE search field, circles as
 * filter chips, a star to pin, circle editing under the chip (ADR-115 / ADR-116 rules kept).
 *
 *   - search: the text filters MY contacts locally ("Mine") and, at >= 2 chars, asks the host for new
 *     people ("New, by @tag"); a hit already listed under "Mine" is not offered twice; the
 *     request / already-contact / pending states show; "Send request" is the only door to a stranger;
 *   - chips: All, the home circle, own circles, "+ circle"; a circle shows its members (and the
 *     contacts that are not in it, with "+"); the home circle is virtual: no editor, family members
 *     untoggleable;
 *   - the star calls `setPinned`, and a contact from another family (their pin IS the acceptance
 *     record) shows it lit and inert;
 *   - circle editing (rename, delete, create) is reachable under the chip, through the same hook calls.
 *
 * Test by failure (planted in the hub original of this panel when the test was written, then ported):
 *   - `matchesPerson` returning true for everything -> "search filters mine";
 *   - the `enabled` gate dropped from `NewPeople` -> "one-letter query asks nobody";
 *   - `fresh` not filtered by `shownIds` -> "a known contact is not repeated";
 *   - star `onClick` without the `locked` guard -> "star: pins; a cross-family pin is inert";
 *   - `!c.virtual && live` -> `live` only (the home circle gets the editor) -> "home chip is virtual";
 *   - `setPickedId` not wired to the chips -> "chips filter".
 */
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  circle,
  contact,
  hit,
  HOME_CIRCLE_ID,
  incomingRequest,
  makeCircles,
  outgoingRequest,
  seat,
} from '../../../test-support/fake-circles.js';
import {
  cleanupUi,
  click,
  ensureMatchMedia,
  q,
  qa,
  renderUi,
  typeInto,
  type RenderedUi,
} from '../../../test-support/fake-ui.js';
import { matchesPerson, PeoplePanel } from '../people-panel.js';

afterEach(() => {
  cleanupUi();
  vi.useRealTimers();
});

type Data = ReturnType<typeof makeCircles>['data'];

function mount(data: Data, onOpenContact: (id: string) => void = () => undefined): RenderedUi {
  return renderUi(<PeoplePanel data={data} onOpenContact={onOpenContact} autoFocusSearch={false} />);
}

const ids = (sel: string) => qa(`${sel} [data-user-id]`).map((e) => e.dataset.userId);
const type = (value: string) => typeInto(q<HTMLInputElement>('[data-testid=people-search]'), value);
const settle = async (ms = 400) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};
const chip = (id: string) => q(`[data-circle-id="${id}"]`);

// Mum + Dad are the family; Olia a friend from another family (pinned = the acceptance record);
// Max an ordinary friend of mine.
const FIXTURE = () => {
  const mama = contact('mama', 'Mum', true, true);
  const tato = contact('tato', 'Dad', false, true);
  const olia = contact('olia', 'Olia', true, false);
  const maks = contact('maks', 'Max', false, false, 'maks_w');
  const family = circle(HOME_CIRCLE_ID, 'Smith', [seat('mama'), seat('tato')], true);
  const friends = circle('c-friends', 'Friends', [seat('olia')]);
  return { contacts: [mama, tato, olia, maks], circles: [family, friends] };
};

describe('People: one search field', () => {
  it('search filters mine, locally and instantly (name or @tag), without asking the host for <2 chars', async () => {
    vi.useFakeTimers();
    const { data, fns } = makeCircles(FIXTURE());
    mount(data);
    expect(ids('[data-sec=mine]')).toEqual(['mama', 'tato', 'olia', 'maks']);

    type('l'); // one letter: only "Olia" has it
    expect(ids('[data-sec=mine]')).toEqual(['olia']);
    await settle();
    expect(fns.searchUsers).not.toHaveBeenCalled(); // the one-letter query asks nobody
    expect(q('[data-sec=new]')).toBeNull();

    type('@maks_w'); // by @tag, with the leading @
    expect(ids('[data-sec=mine]')).toEqual(['maks']);
    type('nobody at all');
    expect(q('[data-sec=mine] .circlesel__empty')?.textContent).toBe('None of mine match.');
  });

  it('matchesPerson: name or @tag, case-insensitive, @ ignored, empty matches everyone', () => {
    const p = { displayName: 'Olia Ivanova', username: 'Olia_I' };
    expect(matchesPerson(p, '')).toBe(true);
    expect(matchesPerson(p, '  ')).toBe(true);
    expect(matchesPerson(p, 'OLIA')).toBe(true);
    expect(matchesPerson(p, '@olia_i')).toBe(true);
    expect(matchesPerson(p, 'petrov')).toBe(false);
    expect(matchesPerson({ displayName: 'X', username: null }, 'y')).toBe(false);
  });

  it('at >= 2 chars: "Mine" AND "New, by @tag"; a known contact is not repeated; states show', async () => {
    vi.useFakeTimers();
    const searchUsers = async () => [
      hit('olia', 'Olia'), // already mine AND on screen under "Mine": not repeated
      hit('new1', 'Zoriana New', 'zoriana'), // a stranger: "Send request"
      hit('pend', 'Taras Pending', 'taras'), // I already asked: "Request sent"
      hit('wait', 'Oleksii Small', 'oleksii'), // asked, a parent has not approved: "Waiting for a parent"
      hit('inc', 'Olesia Writes', 'olesia'), // she asked me: "Waiting for your answer"
    ];
    const { data, fns } = makeCircles({
      ...FIXTURE(),
      searchUsers,
      outgoing: [outgoingRequest('o1', 'pend'), outgoingRequest('o2', 'wait', true)],
      incoming: [incomingRequest('i1', 'inc')],
    });
    mount(data);

    type('ol');
    expect(ids('[data-sec=mine]')).toEqual(['olia']); // local, before the host answered
    await settle(); // debounce
    expect(fns.searchUsers).toHaveBeenCalledTimes(1);
    expect(fns.searchUsers).toHaveBeenCalledWith('ol');

    const fresh = qa('[data-sec=new] .circlesel__hit');
    expect(fresh.map((h) => h.dataset.userId)).toEqual(['new1', 'pend', 'wait', 'inc']); // not "olia" twice
    expect(fresh.map((h) => h.dataset.state)).toEqual(['open', 'sent', 'waiting', 'incoming']);
    expect(q('[data-sec=new] h3')?.textContent).toBe('New, by @tag');

    // "Send request" exists ONLY on the stranger, and is the door: one call, with her id
    const buttons = qa('[data-sec=new] button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.textContent).toBe('Send request');
    click(buttons[0]!);
    expect(fns.sendRequest).toHaveBeenCalledTimes(1);
    expect(fns.sendRequest).toHaveBeenCalledWith('new1');
  });

  it('a known contact the local list does not show is still listed as "Already a contact" under "New"', async () => {
    vi.useFakeTimers();
    // the host matched Max by something the local filter cannot see (e.g. a former tag)
    const { data } = makeCircles({ ...FIXTURE(), searchUsers: async () => [hit('maks', 'Max', 'maks_w')] });
    mount(data);
    type('maks_old');
    expect(ids('[data-sec=mine]')).toEqual([]);
    await settle();
    const rows = qa('[data-sec=new] .circlesel__hit');
    expect(rows.map((r) => r.dataset.userId)).toEqual(['maks']);
    expect(rows[0]!.dataset.state).toBe('contact');
    expect(rows[0]!.textContent).toContain('Already a contact');
  });

  it('no hits: an explicit empty state, never nothing', async () => {
    vi.useFakeTimers();
    const { data } = makeCircles({ ...FIXTURE(), searchUsers: async () => [] });
    mount(data);
    type('qqq');
    await settle();
    expect(q('[data-sec=new] .circlesel__empty')?.textContent).toBe('Nobody found with that tag.');
  });

  it('shows the loading line while the answer is in flight', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { data } = makeCircles({
      ...FIXTURE(),
      searchUsers: async () => {
        await gate;
        return [];
      },
    });
    mount(data);
    type('qq');
    await settle();
    expect(q('[data-sec=new] .circlesel__empty')?.textContent).toBe('Searching…');
    await act(async () => {
      release();
      await Promise.resolve();
    });
    expect(q('[data-sec=new] .circlesel__empty')?.textContent).toBe('Nobody found with that tag.');
  });

  it('a slower earlier answer never overwrites a newer one', async () => {
    vi.useFakeTimers();
    let release!: (v: ReturnType<typeof hit>[]) => void;
    const slow = new Promise<ReturnType<typeof hit>[]>((r) => {
      release = r;
    });
    const searchUsers = vi.fn(async (query: string) => (query === 'ab' ? slow : [hit('fast', 'Fast', 'fast')]));
    const { data } = makeCircles({ ...FIXTURE(), searchUsers });
    mount(data);
    type('ab');
    await settle(); // "ab" is in flight
    type('abc');
    await settle(); // "abc" answered
    expect(qa('[data-sec=new] .circlesel__hit').map((h) => h.dataset.userId)).toEqual(['fast']);
    await act(async () => {
      release([hit('stale', 'Stale', 'stale')]);
      await Promise.resolve();
    });
    expect(qa('[data-sec=new] .circlesel__hit').map((h) => h.dataset.userId)).toEqual(['fast']);
  });
});

describe('People: circles as filter chips', () => {
  it('chips: All, the home circle, own, "+ circle", with the counts; All lists every contact', () => {
    const { data } = makeCircles(FIXTURE());
    mount(data);
    const chips = qa('.circlesel__tabs [role=tab]').map((c) => c.dataset.circleId);
    expect(chips).toEqual(['all', HOME_CIRCLE_ID, 'c-friends']);
    expect(chip('all')?.textContent).toBe('All4');
    expect(chip(HOME_CIRCLE_ID)?.textContent).toBe('Family2'); // the host's circle name is replaced by the word
    expect(chip('c-friends')?.textContent).toBe('Friends1');
    expect(q('[data-circle-add]')?.textContent).toBe('＋ circle');
    expect(chip('all')?.getAttribute('aria-selected')).toBe('true');
    expect(ids('[data-sec=mine]')).toEqual(['mama', 'tato', 'olia', 'maks']);
  });

  it('chips filter: a circle shows its members and, apart, the contacts that are not in it', () => {
    const { data, fns } = makeCircles(FIXTURE());
    mount(data);
    click(chip('c-friends'));
    expect(chip('c-friends')?.getAttribute('aria-selected')).toBe('true');
    expect(q('[data-sec=mine]')).toBeNull();
    expect(ids('[data-list=inside]')).toEqual(['olia']);
    expect(ids('[data-list=outside]')).toEqual(['mama', 'tato', 'maks']);
    expect(qa('[data-list=inside] .circlesel__person-tick').map((t) => t.textContent)).toEqual(['✓']);

    // "+" files Max into "Friends" through the hook's own call; the tick takes Olia out
    click(q('[data-list=outside] [data-user-id=maks] .circlesel__person-tick'));
    expect(fns.setMembership).toHaveBeenCalledWith('c-friends', 'maks', true);
    click(q('[data-list=inside] [data-user-id=olia] .circlesel__person-tick'));
    expect(fns.setMembership).toHaveBeenCalledWith('c-friends', 'olia', false);

    // the search narrows the chip's lists too
    type('max');
    expect(ids('[data-list=outside]')).toEqual(['maks']);
    expect(q('[data-list=inside]')).toBeNull();

    click(chip('all'));
    expect(ids('[data-sec=mine]')).toEqual(['maks']);
  });

  it('home chip is virtual: no editor; a family member has no tick; a friend is addable via the flag', () => {
    const { data, fns } = makeCircles(FIXTURE());
    mount(data);
    click(chip(HOME_CIRCLE_ID));
    expect(chip(HOME_CIRCLE_ID)?.dataset.virtual).toBe('true');
    expect(q('.circlesel__tab-more')).toBeNull(); // selected, and still no editor (ADR-115 §5)
    expect(ids('[data-list=inside]')).toEqual(['mama', 'tato']);
    expect(qa('[data-list=inside] .circlesel__person-tick')).toHaveLength(0); // owned by the family record
    // a friend outside can be flagged in: through `setInHomeCircle`, never `setMembership`
    click(q('[data-list=outside] [data-user-id=maks] .circlesel__person-tick'));
    expect(fns.setInHomeCircle).toHaveBeenCalledWith('maks', true);
    expect(fns.setMembership).not.toHaveBeenCalled();
    // ...and a family member is not offered under "Other contacts"
    expect(q('[data-list=outside] [data-user-id=mama]')).toBeNull();
  });

  it('the home circle heading says "family" and the others say "circle"', () => {
    const { data } = makeCircles(FIXTURE());
    mount(data);
    click(chip(HOME_CIRCLE_ID));
    expect(q('[data-sec=members] h3')?.textContent).toBe('In the family');
    click(chip('c-friends'));
    expect(q('[data-sec=members] h3')?.textContent).toBe('In this circle');
  });

  it('the home chip count equals the home list (the К8a badge-vs-list bug stays closed)', () => {
    const { data } = makeCircles(FIXTURE());
    mount(data);
    click(chip(HOME_CIRCLE_ID));
    const n = Number(chip(HOME_CIRCLE_ID)!.querySelector('.circlesel__tab-n')!.textContent);
    expect(qa('[data-sec=members] [data-user-id]')).toHaveLength(n);
  });

  it('a "from another family" friend seated in the home circle by the flag wears the badge', () => {
    const f = FIXTURE();
    const family = circle(HOME_CIRCLE_ID, 'R', [seat('mama'), seat('tato'), seat('maks', true)], true);
    const { data } = makeCircles({ ...f, circles: [family, f.circles[1]!] });
    mount(data);
    click(chip(HOME_CIRCLE_ID));
    expect(q('[data-user-id=maks]')?.dataset.external).toBe('true');
    expect(q('[data-user-id=maks] .circlesel__person-badge')?.textContent).toBe('from another family');
    expect(q('[data-user-id=mama]')?.dataset.external).toBeUndefined();
  });

  it('a refused home-circle toggle is named to the person, by the host code', async () => {
    const { data, fns } = makeCircles(FIXTURE());
    const tree = mount(data);
    click(chip(HOME_CIRCLE_ID));
    const tick = () => q('[data-list=outside] [data-user-id=maks] .circlesel__person-tick');

    fns.setInHomeCircle.mockResolvedValueOnce({ ok: false, code: 'CIRCLE_MEMBER_IS_FAMILY' });
    await act(async () => tick()!.click());
    fns.setInHomeCircle.mockResolvedValueOnce({ ok: false, code: 'NOT_A_CONTACT' });
    await act(async () => tick()!.click());
    fns.setInHomeCircle.mockResolvedValueOnce({ ok: false });
    await act(async () => tick()!.click());

    expect(tree.ui.notices).toEqual([
      'They are already family — that membership lives in the family profile.',
      'Become contacts first — send a request.',
      'Could not change the «Family» circle.',
    ]);
  });
});

describe('People: the star pins', () => {
  it('star: pins an ordinary contact; a cross-family pin is lit and inert; an own-family pin unpins', () => {
    const { data, fns } = makeCircles(FIXTURE());
    mount(data);
    const star = (id: string) => q(`[data-user-id=${id}] [data-pin]`)!;

    expect(star('tato').getAttribute('aria-pressed')).toBe('false');
    expect(star('tato').textContent).toBe('☆');
    click(star('tato'));
    expect(fns.setPinned).toHaveBeenCalledTimes(1);
    expect(fns.setPinned).toHaveBeenCalledWith(expect.objectContaining({ userId: 'tato' }), true);

    // Mum: a family member, pinned: the star un-pins (a pure preference)
    expect(star('mama').textContent).toBe('★');
    click(star('mama'));
    expect(fns.setPinned).toHaveBeenLastCalledWith(expect.objectContaining({ userId: 'mama' }), false);

    // Olia: from another family, pinned = the acceptance record: lit, inert, explained
    fns.setPinned.mockClear();
    expect(star('olia').getAttribute('aria-pressed')).toBe('true');
    expect(star('olia').getAttribute('aria-disabled')).toBe('true');
    expect(star('olia').getAttribute('title')).toBe('From another family — stays pinned while you’re contacts');
    click(star('olia'));
    expect(fns.setPinned).not.toHaveBeenCalled();
  });

  it('there is no "Pin contact" row any more; the star works under a circle chip too', () => {
    const { data, fns } = makeCircles(FIXTURE());
    mount(data);
    expect(document.body.textContent).not.toContain('Pin contact');
    click(chip('c-friends'));
    click(q('[data-list=outside] [data-user-id=maks] [data-pin]'));
    expect(fns.setPinned).toHaveBeenCalledWith(expect.objectContaining({ userId: 'maks' }), true);
  });

  it('the name opens the chat (a different target from the star and the tick)', () => {
    const open = vi.fn();
    const { data } = makeCircles(FIXTURE());
    mount(data, open);
    click(q('[data-user-id=maks] .circlesel__person-open'));
    expect(open).toHaveBeenCalledWith('maks');
  });

  it('draws each person through the host chip slot, as a human', () => {
    const { data } = makeCircles(FIXTURE());
    mount(data);
    const chips = qa('[data-user-id=maks] [data-chip]');
    expect(chips).toHaveLength(1);
    expect(chips[0]!.dataset.chip).toBe('HUMAN');
    expect(chips[0]!.dataset.chipName).toBe('Max');
  });
});

describe('People: circle editing stays reachable under the chip', () => {
  it('"+ circle" creates (with suggestions); the dots on a custom chip rename and delete; the home circle has none', async () => {
    vi.useFakeTimers();
    const { data, fns } = makeCircles(FIXTURE());
    mount(data);

    click(q('[data-circle-add]'));
    const form = q('[data-sec=create-circle]')!;
    expect(form).not.toBeNull();
    // suggestions are chips on the form, not seeded rows; "Friends" exists already so it is not offered
    const sugg = qa('[data-sec=create-circle] .circlesel__chip.is-suggest').map((b) => b.textContent);
    expect(sugg).toEqual(['Study', 'Work', 'General']);
    click(qa('[data-sec=create-circle] .circlesel__chip.is-suggest')[1]!);
    const input = form.querySelector('input') as HTMLInputElement;
    expect(input.value).toBe('Work');
    await act(async () => {
      qa('[data-sec=create-circle] button')
        .find((b) => b.textContent === 'Create')!
        .click();
    });
    expect(fns.createCircle).toHaveBeenCalledWith('Work');

    // the dots appear only on the SELECTED custom chip
    expect(q('.circlesel__tab-more')).toBeNull();
    click(chip('c-friends'));
    const more = q('.circlesel__tab-more')!;
    expect(more).not.toBeNull();
    click(more);
    const edit = q('[data-sec=edit-circle]')!;
    expect((edit.querySelector('input') as HTMLInputElement).value).toBe('Friends');
    await act(async () => {
      qa('[data-sec=edit-circle] button')
        .find((b) => b.textContent === 'Delete circle')!
        .click();
    });
    expect(fns.deleteCircle).toHaveBeenCalledWith('c-friends');
  });

  it('rename sends the trimmed name', async () => {
    const { data, fns } = makeCircles(FIXTURE());
    mount(data);
    click(chip('c-friends'));
    click(q('.circlesel__tab-more'));
    typeInto(q<HTMLInputElement>('[data-sec=edit-circle] input'), '  Pals  ');
    await act(async () => {
      qa('[data-sec=edit-circle] button')
        .find((b) => b.textContent === 'Save')!
        .click();
    });
    expect(fns.renameCircle).toHaveBeenCalledWith('c-friends', 'Pals');
    expect(q('[data-sec=edit-circle]')).toBeNull();
  });

  it('a circle deleted under us falls back to "All" instead of a dead chip', () => {
    const f = FIXTURE();
    const tree = mount(makeCircles(f).data);
    click(chip('c-friends'));
    expect(chip('c-friends')?.getAttribute('aria-selected')).toBe('true');
    // the host reload drops the circle
    tree.rerender(
      <PeoplePanel
        data={makeCircles({ ...f, circles: [f.circles[0]!] }).data}
        onOpenContact={() => undefined}
        autoFocusSearch={false}
      />,
    );
    expect(chip('c-friends')).toBeNull();
    expect(chip('all')?.getAttribute('aria-selected')).toBe('true');
    expect(ids('[data-sec=mine]')).toHaveLength(4);
  });

  it('empty states: no contacts at all says where to look', () => {
    const { data } = makeCircles({ circles: [circle(HOME_CIRCLE_ID, 'R', [], true)], contacts: [] });
    mount(data);
    expect(q('[data-sec=mine] .circlesel__empty')?.textContent).toBe('No contacts yet — find someone by @tag.');
  });

  it('carries the messenger theme on its own root: it is drawn inside a menu portal', () => {
    const { data } = makeCircles(FIXTURE());
    mount(data);
    expect(q('[data-panel=people]')?.style.getPropertyValue('--msg-accent-rgb')).toBe('47, 111, 237');
  });
});

describe('People: focus', () => {
  it('desktop: the search field takes the focus; a phone leaves the keyboard alone', async () => {
    vi.useFakeTimers();
    const render = (phone: boolean) => {
      ensureMatchMedia(phone);
      return renderUi(<PeoplePanel data={makeCircles(FIXTURE()).data} onOpenContact={() => undefined} />);
    };

    const desktop = render(false);
    await settle(100);
    expect(document.activeElement).toBe(q('[data-testid=people-search]'));
    desktop.unmount();

    render(true);
    await settle(100);
    expect(document.activeElement).not.toBe(q('[data-testid=people-search]'));
  });
});
