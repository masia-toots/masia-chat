/**
 * Which tab the contacts menu opens on (founder 2026-10-08, plan `player-wide-holo-tabs-people` Г2 = A):
 *
 *   1. an incoming request I have not looked at yet -> "Requests" (the badge on the door said so);
 *   2. otherwise the tab I used LAST, remembered per device;
 *   3. the very first time -> "People".
 *
 * "Looked at" = the "Requests" tab was on screen while that request was pending. The seen ids are
 * kept beside the tab, so a request I read and left pending does not drag every later open to
 * "Requests": only a NEW one does. Both live in `localStorage` (per device, nothing here is a server
 * fact), and every access is wrapped: a private window, blocked storage or a full quota must cost
 * the memory, never the menu.
 */

export const CONTACTS_TABS = ['people', 'groups', 'requests'] as const;
export type ContactsTab = (typeof CONTACTS_TABS)[number];

/**
 * Last-used tab. Versioned: a changed tab set bumps the suffix instead of misreading old values.
 * The key text is kept verbatim from before the menu moved into this package, so a person's
 * remembered tab survives the move.
 */
export const CONTACTS_TAB_KEY = 'masia.contacts.tab.v1';
/** Ids of the incoming requests the "Requests" tab has already shown (same keep-verbatim rule). */
export const CONTACTS_SEEN_KEY = 'masia.contacts.seen.v1';

/** The most seen ids kept: a pending list is short; this only bounds a pathological one. */
const SEEN_MAX = 200;

const isTab = (v: unknown): v is ContactsTab => (CONTACTS_TABS as readonly unknown[]).includes(v);

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* memory lost, menu fine */
  }
}

/** The remembered tab, or `null` (first time, storage blocked, or a value from another version). */
export function readContactsTab(): ContactsTab | null {
  const v = read(CONTACTS_TAB_KEY);
  return isTab(v) ? v : null;
}

/** Remember the tab the person chose. */
export function rememberContactsTab(tab: ContactsTab): void {
  write(CONTACTS_TAB_KEY, tab);
}

function readSeen(): string[] {
  const raw = read(CONTACTS_SEEN_KEY);
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** The "Requests" tab showed these incoming requests: they are no longer "unseen". */
export function markRequestsSeen(incomingIds: readonly string[]): void {
  if (incomingIds.length === 0) return;
  const seen = new Set(readSeen());
  let changed = false;
  for (const id of incomingIds) {
    if (!seen.has(id)) {
      seen.add(id);
      changed = true;
    }
  }
  if (changed) write(CONTACTS_SEEN_KEY, JSON.stringify([...seen].slice(-SEEN_MAX)));
}

/** Is any of these incoming requests new to this device? */
export function hasUnseenRequests(incomingIds: readonly string[]): boolean {
  if (incomingIds.length === 0) return false;
  const seen = new Set(readSeen());
  return incomingIds.some((id) => !seen.has(id));
}

/** The tab the menu opens on: the three rules above, in that order. */
export function pickContactsTab(incomingIds: readonly string[]): ContactsTab {
  if (hasUnseenRequests(incomingIds)) return 'requests';
  return readContactsTab() ?? 'people';
}
