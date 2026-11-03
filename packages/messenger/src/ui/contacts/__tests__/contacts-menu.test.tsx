// @vitest-environment jsdom
/**
 * Ш5 (plan `player-wide-holo-tabs-people`, 2026-10-09): ONE door, ONE contacts menu.
 *
 *   - the bank has ONE door (`[data-contacts-door=people]`); it opens the menu (`[data-cm=contacts]`)
 *     with three tabs (People, Groups, Requests) and NO "Pin contact" row (the star replaced it);
 *   - the door's badge is the count of INCOMING requests, absent at 0, repeated in its aria-label;
 *   - the tab it opens on: unseen incoming request -> "Requests"; else the tab last chosen on this
 *     device (`masia.contacts.tab.v1`); the first time "People": the page's `pickContactsTab`, wired
 *     here as the page wires it.
 *
 * Test by failure (planted in the hub original when the test was written, then ported):
 *   - a second door in the bank / `ContactsDoor` drawn twice -> "ONE door" test;
 *   - badge rendered at 0, or counting `openRequestCount` instead of incoming -> "badge" test;
 *   - `pickContactsTab` ignoring unseen requests, or `onTabChange` not remembering -> the "tab" tests;
 *   - a pin picker row put back as the first row -> "ONE door" test (rowIds must be empty).
 *
 * The menu is the fake of the host's Menu slot (the real one is covered by the host's own tests).
 */
import { useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  contact,
  incomingRequest,
  makeCircles,
  makeGroups,
  outgoingRequest,
  parentRequest,
} from '../../../test-support/fake-circles.js';
import {
  cleanupUi,
  click,
  pressEscape,
  q,
  qa,
  renderUi,
} from '../../../test-support/fake-ui.js';
import { ContactsDoor } from '../contacts-door.js';
import { ContactsMenu } from '../contacts-menu.js';
import {
  CONTACTS_SEEN_KEY,
  CONTACTS_TAB_KEY,
  pickContactsTab,
  type ContactsTab,
} from '../contacts-tab-memory.js';
import { incomingRequestCount } from '../requests-panel.js';

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  cleanupUi();
  vi.useRealTimers();
});

type Circles = ReturnType<typeof makeCircles>['data'];

const base = () =>
  makeCircles({ contacts: [contact('mama', 'Mum', false, true), contact('olia', 'Olia', true, false)] });
const groups = makeGroups().data;

/** The page's wiring in miniature: ONE door, ONE menu, `pickContactsTab` picks the tab. */
function Bank({ circles }: { circles: Circles }) {
  const [tab, setTab] = useState<ContactsTab | null>(null);
  const anchor = useRef<HTMLElement | null>(null);
  const open = (el: HTMLElement) => {
    anchor.current = el;
    setTab(pickContactsTab(circles.requests.incoming.map((r) => r.id)));
  };
  return (
    <>
      <ContactsDoor expanded={tab !== null} badge={incomingRequestCount(circles.requests)} onOpen={open} />
      <ContactsMenu
        open={tab !== null}
        onClose={() => setTab(null)}
        anchorRef={anchor}
        tab={tab ?? 'people'}
        circles={circles}
        groups={groups}
        onOpenContact={() => undefined}
        onOpenGroup={() => undefined}
      />
    </>
  );
}

const door = () => q('[data-contacts-door=people]')!;
const menu = () => q('[data-cm=contacts]');
const selectedTab = () => q('[role=tab][data-cm-tab][aria-selected=true]')?.dataset.cmTab;
const tabIds = () => qa('[data-cm=contacts] [role=tab][data-cm-tab]').map((e) => e.dataset.cmTab);
const rowIds = () => qa('[data-cm-row]').map((e) => e.dataset.cmRow);
const clickTab = (id: string) => click(q(`[data-cm-tab=${id}]`));

describe('People: one menu behind the bank door', () => {
  it('ONE door; it opens three tabs People, Groups, Requests, with no pin row; Esc returns focus', () => {
    renderUi(<Bank circles={base().data} />);
    expect(qa('[data-contacts-door]')).toHaveLength(1);
    expect(door().getAttribute('aria-label')).toBe('People');
    expect(menu()).toBeNull();

    click(door());
    expect(menu()?.getAttribute('role')).toBe('dialog');
    expect(door().getAttribute('aria-expanded')).toBe('true');
    expect(tabIds()).toEqual(['people', 'groups', 'requests']);
    expect(selectedTab()).toBe('people');
    expect(q('[data-panel=people]')).not.toBeNull();
    // the star replaced "Pin contact": no console row at all on this menu
    expect(rowIds()).toEqual([]);
    expect(q('[data-cm-row=pin]')).toBeNull();

    // every tab is a body of the same menu
    clickTab('groups');
    expect(q('[data-panel=groups]')).not.toBeNull();
    expect(q('[data-panel=people]')).toBeNull();
    clickTab('requests');
    expect(q('[data-panel=requests]')).not.toBeNull();

    pressEscape();
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(door());
  });

  it('the door draws the host users icon at the glyph size class', () => {
    renderUi(<Bank circles={base().data} />);
    const icon = q('[data-contacts-door=people] svg');
    expect(icon?.getAttribute('data-icon')).toBe('users');
    expect(icon?.getAttribute('class')).toBe('chbank__ic');
  });

  it('badge: the count of INCOMING requests, hidden at 0, repeated in the aria-label', () => {
    const first = renderUi(<Bank circles={base().data} />);
    expect(q('[data-door-badge]')).toBeNull();
    expect(door().getAttribute('aria-label')).toBe('People');
    first.unmount();

    // 2 incoming + 1 outgoing + 1 awaiting parent: the badge counts only what waits for MY answer
    const { data } = makeCircles({
      incoming: [incomingRequest('r1', 'anna'), incomingRequest('r2', 'boris')],
      outgoing: [outgoingRequest('r3', 'carl')],
      awaitingParent: [parentRequest('r4', 'dina', 'eve')],
    });
    renderUi(<Bank circles={data} />);
    expect(q('[data-door-badge]')?.textContent).toBe('2');
    expect(door().getAttribute('aria-label')).toBe('People, 2 new requests');
    expect(door().getAttribute('title')).toBe('People, 2 new requests');
    // ...while the TAB counts every open request (incoming + outgoing + waiting for a parent)
    click(door());
    expect(q('[data-cm-tab=requests]')?.textContent).toBe('Requests · 4');
  });

  it('the badge caps at 99+', () => {
    const many = Array.from({ length: 120 }, (_, i) => incomingRequest(`r${i}`, `u${i}`));
    renderUi(<Bank circles={makeCircles({ incoming: many }).data} />);
    expect(q('[data-door-badge]')?.textContent).toBe('99+');
  });

  it('tab memory: first time "People"; the tab the person chose comes back on the next open', () => {
    renderUi(<Bank circles={base().data} />);
    click(door());
    expect(selectedTab()).toBe('people');
    expect(window.localStorage.getItem(CONTACTS_TAB_KEY)).toBeNull(); // opening alone remembers nothing

    clickTab('groups');
    expect(window.localStorage.getItem(CONTACTS_TAB_KEY)).toBe('groups');
    pressEscape();

    click(door());
    expect(selectedTab()).toBe('groups');
  });

  it('requests first: an unseen incoming request opens "Requests" once; then the habit returns', () => {
    window.localStorage.setItem(CONTACTS_TAB_KEY, 'groups');
    const { data } = makeCircles({ incoming: [incomingRequest('r1', 'anna')] });
    renderUi(<Bank circles={data} />);

    click(door());
    expect(selectedTab()).toBe('requests');
    // the rule's pick did not overwrite the person's habit...
    expect(window.localStorage.getItem(CONTACTS_TAB_KEY)).toBe('groups');
    // ...and showing the tab marked the request as seen
    expect(JSON.parse(window.localStorage.getItem(CONTACTS_SEEN_KEY) ?? '[]')).toEqual(['r1']);
    pressEscape();

    click(door());
    expect(selectedTab()).toBe('groups');
  });

  it('a NEW request after the old one was seen pulls the menu to "Requests" again', () => {
    window.localStorage.setItem(CONTACTS_SEEN_KEY, JSON.stringify(['r1']));
    expect(pickContactsTab(['r1'])).toBe('people');
    expect(pickContactsTab(['r1', 'r2'])).toBe('requests');
  });

  it('a stored value from another version is ignored', () => {
    window.localStorage.setItem(CONTACTS_TAB_KEY, 'circles');
    expect(pickContactsTab([])).toBe('people');
    window.localStorage.setItem(CONTACTS_SEEN_KEY, '{not json');
    expect(pickContactsTab(['r1'])).toBe('requests');
  });

  it('storage that throws costs the memory, never the menu', () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    try {
      renderUi(<Bank circles={base().data} />);
      click(door());
      expect(selectedTab()).toBe('people');
      clickTab('groups');
      expect(selectedTab()).toBe('groups');
    } finally {
      get.mockRestore();
      set.mockRestore();
    }
  });

  it('picking a person closes the menu, then opens their chat', () => {
    const order: string[] = [];
    const circles = base().data;
    function Page() {
      const [open, setOpen] = useState(true);
      const anchor = useRef<HTMLElement | null>(null);
      return (
        <ContactsMenu
          open={open}
          onClose={() => {
            order.push('close');
            setOpen(false);
          }}
          anchorRef={anchor}
          tab="people"
          circles={circles}
          groups={groups}
          onOpenContact={(id) => order.push(`open:${id}`)}
          onOpenGroup={() => undefined}
        />
      );
    }
    renderUi(<Page />);
    click(q('[data-user-id=olia] .circlesel__person-open'));
    expect(order).toEqual(['close', 'open:olia']);
    expect(menu()).toBeNull();
  });
});
