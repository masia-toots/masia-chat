/**
 * ContactsPanel: everything the old «Люди» door opened, as the BODY of one tab of the host's header menu (Ф2.4 of plan
 * `chat-public-polish`, founder 2026-11-03 — SUPERSEDES `ContactsMenu` + `ContactsDoor`, which were a separate `Menu`
 * behind a door in the bank row and a second «Контакти» row in `⋯`). There is no door now and no second menu: the header
 * `⋯` has a «Люди» tab, and this is what stands in it, in full («повний фарш»):
 *
 *   [ People ][ Groups ][ Requests · N ]            ← three SEGMENTS of this panel (a tablist of its own)
 *   the active segment's body: `PeoplePanel` · `GroupsPanel` · `RequestsPanel`
 *
 * "People" is one search field (my contacts and new people by @tag), the circles as filter chips and a star to pin; "Groups"
 * and "Requests" are the bodies they have always been. The panel owns only the SEGMENT: which one it opens on is the page's
 * call (`pickContactsTab`: unseen incoming request -> "Requests"; else the segment last used on this device; else "People"),
 * read ONCE on mount — the host mounts it when its tab opens, so every open re-asks the rule. A segment the person CHOSE is
 * remembered (`rememberContactsTab`); the one the rule picked for them is not, because it must not overwrite their habit.
 *
 * Why it does not draw a `Menu`: the host's menu IS the surface (popover / phone sheet, decided by its shell breakpoint),
 * and a menu cannot hold a menu. So the panel is a plain body: it asks the host to close the surface (`onClose`) before it
 * opens a chat, and brings its own keyboard contract for the segments (← → Home End; the host menu steps out of the way
 * inside a section's free content).
 */
import { useEffect, useId, useState, type KeyboardEvent } from 'react';
import type { ContactCircles, Groups } from '../../contacts/index.js';
import { useMessengerUi, useT } from '../provider/messenger-ui.js';
import { CONTACTS_TABS, markRequestsSeen, rememberContactsTab, type ContactsTab } from './contacts-tab-memory.js';
import { GroupsPanel } from './groups-panel.js';
import { PeoplePanel } from './people-panel.js';
import { RequestsPanel, openRequestCount } from './requests-panel.js';

export interface ContactsPanelProps {
  /** The segment to open on (read once, on mount): the page's `pickContactsTab`. */
  tab: ContactsTab;
  /** The circles owner (`useContactCircles`), lifted by the page. */
  circles: ContactCircles;
  /** The groups owner (`useGroups`), lifted by the page. */
  groups: Groups;
  /** Open a contact's chat: the SAME `selectContact` the chips fire. */
  onOpenContact(userId: string): void;
  /** Open a group's chat: likewise. */
  onOpenGroup(groupId: string): void;
  /** Close the surrounding host menu — called BEFORE a chat is opened (the surface must not stay over the conversation). */
  onClose(): void;
  /**
   * Put the caret in the People search when the panel opens straight onto People (desktop only — `PeoplePanel` skips a phone).
   * Default OFF: the panel stands in a TAB, and a tab reached by the arrow keys must keep the keyboard on the tab bar. Never
   * applied after the person has switched a segment — focus then belongs to the segment they just chose.
   */
  autoFocusSearch?: boolean;
}

export function ContactsPanel({
  tab: initial,
  circles,
  groups,
  onOpenContact,
  onOpenGroup,
  onClose,
  autoFocusSearch = false,
}: ContactsPanelProps) {
  const { themeStyle } = useMessengerUi();
  const t = useT();
  const uid = useId();
  const [seg, setSeg] = useState<ContactsTab>(initial);
  const [focusSearch, setFocusSearch] = useState(autoFocusSearch);
  const requestCount = openRequestCount(circles.requests);
  const incomingIds = circles.requests.incoming.map((r) => r.id);
  const incomingKey = incomingIds.join(',');

  // "Requests" on screen = those incoming requests are seen: here when the panel OPENED on it (the rule's pick) and when
  // the person switches to it (below) — the effect covers both, and a request that arrives while it is on screen.
  useEffect(() => {
    if (seg === 'requests') markRequestsSeen(incomingIds);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `incomingKey` stands for the id list
  }, [seg, incomingKey]);

  const labels: Record<ContactsTab, string> = {
    people: t('contacts.people'),
    groups: t('groups.title'),
    requests: requestCount > 0 ? `${t('circles.requests')} · ${requestCount}` : t('circles.requests'),
  };

  const choose = (next: ContactsTab): void => {
    setFocusSearch(false);
    setSeg(next);
    rememberContactsTab(next);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const i = CONTACTS_TABS.indexOf(seg);
    let n = -1;
    if (e.key === 'ArrowRight') n = (i + 1) % CONTACTS_TABS.length;
    else if (e.key === 'ArrowLeft') n = (i - 1 + CONTACTS_TABS.length) % CONTACTS_TABS.length;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = CONTACTS_TABS.length - 1;
    if (n < 0) return;
    e.preventDefault();
    const id = CONTACTS_TABS[n]!;
    choose(id);
    window.setTimeout(() => document.getElementById(`${uid}-seg-${id}`)?.focus(), 0);
  };

  return (
    <div className="cpanel" data-panel="contacts" style={themeStyle}>
      <div className="cpanel__segs" role="tablist" aria-label={t('contacts.people')} onKeyDown={onKeyDown}>
        {CONTACTS_TABS.map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`${uid}-seg-${id}`}
            data-seg={id}
            aria-selected={id === seg}
            aria-controls={`${uid}-body`}
            tabIndex={id === seg ? 0 : -1}
            className={`cpanel__seg${id === seg ? ' is-on' : ''}`}
            onClick={() => choose(id)}
          >
            {labels[id]}
          </button>
        ))}
      </div>
      <div className="cpanel__body" role="tabpanel" id={`${uid}-body`} aria-labelledby={`${uid}-seg-${seg}`}>
        {seg === 'people' && (
          <PeoplePanel
            data={circles}
            autoFocusSearch={focusSearch}
            onOpenContact={(id) => {
              onClose();
              onOpenContact(id);
            }}
          />
        )}
        {seg === 'groups' && (
          <GroupsPanel
            data={groups}
            circles={circles}
            onOpenGroup={(id) => {
              onClose();
              onOpenGroup(id);
            }}
          />
        )}
        {seg === 'requests' && <RequestsPanel data={circles} />}
      </div>
    </div>
  );
}
