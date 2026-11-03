/**
 * ContactsMenu: ONE menu for everything behind the bank's ONE door (plan
 * `player-wide-holo-tabs-people` Ш5, founder 2026-10-08: «керування колами і групами злити в одну
 * іконку в стилі і один UI з табами»; before that К5b, 2026-10-07).
 *
 * The bank used to carry two doors (Circles, Groups) that opened the same menu on different tabs.
 * Now there is one door and the menu is three tabs:
 *
 *   [ People ][ Groups ][ Requests N ]
 *   - the active tab's body (`PeoplePanel`, `GroupsPanel`, `RequestsPanel`)
 *
 * "People" is one search field (my contacts and new people by @tag), the circles as filter chips
 * and a star to pin; "Groups" and "Requests" are the bodies they have always been.
 *
 * Which tab it opens on is the page's call (`pickContactsTab`): unseen incoming request ->
 * "Requests"; else the tab last used on this device; else "People". A tab the person CHOSE is
 * remembered here (`onTabChange`); the one the rule picked for them is not, because it must not
 * overwrite their habit.
 *
 * The header menu reaches the same menu (its "Contacts" row carries the badge too); on a narrow
 * bank the door folds into that row. One menu, two doors, never two surfaces that could disagree
 * about who my contacts are.
 *
 * Form: popover beside the door on a wide screen, full-screen sheet on a phone. That is decided by
 * the host's `Menu` slot (its shell breakpoint), never by a number here.
 */
import { useEffect, type RefObject } from 'react';
import type { ContactCircles, Groups } from '../../contacts/index.js';
import type { MenuSection } from '../provider/slots.js';
import { useMessengerUi, useT } from '../provider/messenger-ui.js';
import { markRequestsSeen, rememberContactsTab, type ContactsTab } from './contacts-tab-memory.js';
import { GroupsPanel } from './groups-panel.js';
import { PeoplePanel } from './people-panel.js';
import { RequestsPanel, openRequestCount } from './requests-panel.js';

export interface ContactsMenuProps {
  open: boolean;
  onClose(): void;
  /** The door (or the header menu) that opened it: popover anchor and where focus returns. */
  anchorRef: RefObject<HTMLElement | null>;
  /** The tab to open on (read on the open edge): the page's `pickContactsTab`. */
  tab: ContactsTab;
  /** The circles owner (`useContactCircles`), lifted by the page. */
  circles: ContactCircles;
  /** The groups owner (`useGroups`), lifted by the page. */
  groups: Groups;
  /** Open a contact's chat: the SAME `selectContact` the plates fire. */
  onOpenContact(userId: string): void;
  /** Open a group's chat: likewise. */
  onOpenGroup(groupId: string): void;
}

export function ContactsMenu({
  open,
  onClose,
  anchorRef,
  tab,
  circles,
  groups,
  onOpenContact,
  onOpenGroup,
}: ContactsMenuProps) {
  const { slots } = useMessengerUi();
  const t = useT();
  const { Menu } = slots;
  const requestCount = openRequestCount(circles.requests);
  const incomingIds = circles.requests.incoming.map((r) => r.id);
  const incomingKey = incomingIds.join(',');

  // "Requests" on screen = those incoming requests are seen: here when the menu OPENED on it (the
  // rule's pick); `onTabChange` below does the same when the person switches to it.
  useEffect(() => {
    if (open && tab === 'requests') markRequestsSeen(incomingIds);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `incomingKey` stands for the id list
  }, [open, tab, incomingKey]);

  const sections: MenuSection[] = [
    {
      id: 'people',
      tab: 'people',
      rows: [],
      content: (
        <PeoplePanel
          data={circles}
          onOpenContact={(id) => {
            onClose();
            onOpenContact(id);
          }}
        />
      ),
    },
    {
      id: 'groups',
      tab: 'groups',
      rows: [],
      content: (
        <GroupsPanel
          data={groups}
          circles={circles}
          onOpenGroup={(id) => {
            onClose();
            onOpenGroup(id);
          }}
        />
      ),
    },
    { id: 'requests', tab: 'requests', rows: [], content: <RequestsPanel data={circles} /> },
  ];

  const requestsLabel = t('circles.requests');
  return (
    <Menu
      name="contacts"
      open={open}
      onClose={onClose}
      anchorRef={anchorRef}
      label={t('contacts.people')}
      closeLabel={t('common.close')}
      wide
      defaultTab={tab}
      onTabChange={(id) => {
        const next = id as ContactsTab;
        rememberContactsTab(next);
        if (next === 'requests') markRequestsSeen(incomingIds);
      }}
      tabs={[
        { id: 'people', label: t('contacts.people') },
        { id: 'groups', label: t('groups.title') },
        { id: 'requests', label: requestCount > 0 ? `${requestsLabel} · ${requestCount}` : requestsLabel },
      ]}
      sections={sections}
    />
  );
}
