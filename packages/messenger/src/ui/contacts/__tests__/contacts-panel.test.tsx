// @vitest-environment jsdom
/**
 * Ф2.4 (plan `chat-public-polish`, 2026-11-03): the «Люди» tab of the header menu is ONE body, `ContactsPanel` — the
 * old door in the bank row and the `Menu` behind it are gone.
 *
 *   - three SEGMENTS (People, Groups, Requests) with no pin row; the Requests one counts every open request;
 *   - the segment it opens on: unseen incoming request -> "Requests"; else the segment last chosen on this device
 *     (`masia.contacts.tab.v1`); the first time "People": the page's `pickContactsTab`, wired here as the page wires it
 *     (it is asked on every mount, because the host mounts the panel when its tab opens);
 *   - a segment the person CHOSE is remembered; the one the rule picked is not;
 *   - arrow keys / Home / End move between the segments, and move the selection with them;
 *   - picking a person closes the host surface FIRST, then opens the chat.
 *
 * Test by failure (planted, then restored): a second segment bar drawn · `pickContactsTab` ignoring unseen requests ·
 * `choose` not remembering · the effect not marking `Requests` seen · `onClose` called after `onOpenContact`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  contact,
  incomingRequest,
  makeCircles,
  makeGroups,
  outgoingRequest,
  parentRequest,
} from '../../../test-support/fake-circles.js';
import { act } from 'react';
import { cleanupUi, click, q, qa, renderUi } from '../../../test-support/fake-ui.js';
import { ContactsPanel } from '../contacts-panel.js';
import {
  CONTACTS_SEEN_KEY,
  CONTACTS_TAB_KEY,
  pickContactsTab,
} from '../contacts-tab-memory.js';

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

/** The page's wiring in miniature: `pickContactsTab` picks the segment on every mount. */
function mount(circles: Circles, extra: Partial<React.ComponentProps<typeof ContactsPanel>> = {}) {
  return renderUi(
    <ContactsPanel
      tab={pickContactsTab(circles.requests.incoming.map((r) => r.id))}
      circles={circles}
      groups={groups}
      onOpenContact={() => undefined}
      onOpenGroup={() => undefined}
      onClose={() => undefined}
      {...extra}
    />,
  );
}

const segIds = () => qa('.cpanel__segs [role=tab]').map((e) => e.dataset.seg);
const selected = () => q('.cpanel__segs [role=tab][aria-selected=true]')?.dataset.seg;
const clickSeg = (id: string) => click(q(`[data-seg=${id}]`));
const key = (el: Element, k: string) =>
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  });

describe('ContactsPanel: the «Люди» tab body', () => {
  it('ONE segment bar: People, Groups, Requests; the active segment is its body; no pin row, no console rows', () => {
    mount(base().data);
    expect(qa('.cpanel__segs')).toHaveLength(1);
    expect(segIds()).toEqual(['people', 'groups', 'requests']);
    expect(q('.cpanel__segs')!.getAttribute('aria-label')).toBe('People');
    expect(selected()).toBe('people');
    expect(q('[data-panel=people]')).not.toBeNull();
    expect(q('[data-cm-row]')).toBeNull();

    // every segment is a body of the same panel
    clickSeg('groups');
    expect(q('[data-panel=groups]')).not.toBeNull();
    expect(q('[data-panel=people]')).toBeNull();
    clickSeg('requests');
    expect(q('[data-panel=requests]')).not.toBeNull();
    expect(q('[data-panel=groups]')).toBeNull();
  });

  it('the segments are a real tablist: roving tabindex, aria-selected, a labelled tabpanel', () => {
    mount(base().data);
    const tabs = qa('.cpanel__segs [role=tab]');
    expect(tabs.map((e) => e.getAttribute('tabindex'))).toEqual(['0', '-1', '-1']);
    const panel = q('[role=tabpanel]')!;
    expect(panel.getAttribute('aria-labelledby')).toBe(tabs[0]!.id);
    expect(tabs[0]!.getAttribute('aria-controls')).toBe(panel.id);
  });

  it('the Requests segment counts EVERY open request (incoming + outgoing + waiting for a parent); no count at 0', () => {
    const first = mount(base().data);
    expect(q('[data-seg=requests]')?.textContent).toBe('Requests');
    first.unmount();

    const { data } = makeCircles({
      incoming: [incomingRequest('r1', 'anna'), incomingRequest('r2', 'boris')],
      outgoing: [outgoingRequest('r3', 'carl')],
      awaitingParent: [parentRequest('r4', 'dina', 'eve')],
    });
    mount(data);
    expect(q('[data-seg=requests]')?.textContent).toBe('Requests · 4');
  });

  it('segment memory: first time "People"; the segment the person chose comes back on the next mount', () => {
    const first = mount(base().data);
    expect(selected()).toBe('people');
    expect(window.localStorage.getItem(CONTACTS_TAB_KEY)).toBeNull(); // opening alone remembers nothing

    clickSeg('groups');
    expect(window.localStorage.getItem(CONTACTS_TAB_KEY)).toBe('groups');
    first.unmount();

    mount(base().data);
    expect(selected()).toBe('groups');
  });

  it('requests first: an unseen incoming request opens "Requests" once; then the habit returns', () => {
    window.localStorage.setItem(CONTACTS_TAB_KEY, 'groups');
    const { data } = makeCircles({ incoming: [incomingRequest('r1', 'anna')] });
    const first = mount(data);
    expect(selected()).toBe('requests');
    // the rule's pick did not overwrite the person's habit...
    expect(window.localStorage.getItem(CONTACTS_TAB_KEY)).toBe('groups');
    // ...and showing the segment marked the request as seen
    expect(JSON.parse(window.localStorage.getItem(CONTACTS_SEEN_KEY) ?? '[]')).toEqual(['r1']);
    first.unmount();

    mount(data);
    expect(selected()).toBe('groups');
  });

  it('switching to Requests marks the incoming ones seen', () => {
    const { data } = makeCircles({ incoming: [incomingRequest('r1', 'anna')] });
    window.localStorage.setItem(CONTACTS_SEEN_KEY, JSON.stringify(['r1']));
    mount(data);
    expect(selected()).toBe('people');
    window.localStorage.setItem(CONTACTS_SEEN_KEY, '[]');
    clickSeg('requests');
    expect(JSON.parse(window.localStorage.getItem(CONTACTS_SEEN_KEY) ?? '[]')).toEqual(['r1']);
  });

  it('a NEW request after the old one was seen pulls the panel to "Requests" again', () => {
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

  it('storage that throws costs the memory, never the panel', () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    try {
      mount(base().data);
      expect(selected()).toBe('people');
      clickSeg('groups');
      expect(selected()).toBe('groups');
    } finally {
      get.mockRestore();
      set.mockRestore();
    }
  });

  it('arrow keys, Home and End move the selection (wrapping) and focus follows', () => {
    vi.useFakeTimers();
    mount(base().data);
    const bar = q('.cpanel__segs')!;
    key(q('[data-seg=people]')!, 'ArrowRight');
    expect(selected()).toBe('groups');
    key(q('[data-seg=groups]')!, 'End');
    expect(selected()).toBe('requests');
    key(q('[data-seg=requests]')!, 'ArrowRight');
    expect(selected()).toBe('people'); // wraps
    key(q('[data-seg=people]')!, 'ArrowLeft');
    expect(selected()).toBe('requests');
    key(q('[data-seg=requests]')!, 'Home');
    expect(selected()).toBe('people');
    act(() => {
      vi.runAllTimers();
    });
    expect(document.activeElement).toBe(bar.querySelector('[data-seg=people]'));
    expect(window.localStorage.getItem(CONTACTS_TAB_KEY)).toBe('people');
  });

  it('does not steal the keyboard from the tab bar: the People search is focused only when asked, and only on the first mount', () => {
    vi.useFakeTimers();
    const first = mount(base().data);
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(document.activeElement).not.toBe(q('[data-testid=people-search]'));
    first.unmount();

    mount(base().data, { autoFocusSearch: true });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(document.activeElement).toBe(q('[data-testid=people-search]'));
    // switching away and back is the person's own navigation: the keyboard stays on the segment they chose
    clickSeg('groups');
    clickSeg('people');
    (document.activeElement as HTMLElement).blur();
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(document.activeElement).not.toBe(q('[data-testid=people-search]'));
  });

  it('picking a person closes the host surface first, then opens their chat', () => {
    const order: string[] = [];
    mount(base().data, {
      onClose: () => order.push('close'),
      onOpenContact: (id) => order.push(`open:${id}`),
    });
    click(q('[data-user-id=olia] .circlesel__person-open'));
    expect(order).toEqual(['close', 'open:olia']);
  });
});
