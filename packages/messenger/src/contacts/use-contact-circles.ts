/**
 * useContactCircles — the ONE client-side home for the contact-circles axis
 * (ADR-115): circles, accepted contacts, open requests, and every mutation that
 * changes them.
 *
 * ## Why a hook and not fetches in the component
 *
 * Four surfaces read this data — the bank (contact plates), the circle selector
 * (tabs + membership chips), the search box, the requests section — and every
 * mutation invalidates two or three of them at once (accepting a request creates
 * a contact, which changes the circles' member pool AND the bank's plates). A
 * component that fetched its own would have made the bank and the modal free to
 * disagree about who my contacts are, which is exactly the split
 * `ChannelBank`'s own docblock exists to warn about. One owner, one refetch.
 *
 * ## The data comes through the `ContactsDirectory` port
 *
 * The hook knows no URL, no fetch and no host API type: it reads and writes through the port
 * (`@masia/contracts`) and the host adapter maps that onto its own API. The shapes below are the
 * port's own, so a host whose server changes breaks its ADAPTER at compile time, never this file.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ContactRequestAction,
  ContactsDirectory,
  DirectoryCircle,
  DirectoryCircleMember,
  DirectoryContact,
  DirectoryRequest,
  DirectoryRequestUser,
  DirectoryRequests,
  DirectoryUserHit,
  DirectoryWriteResult,
} from '@masia/contracts';

/** A named circle of contacts (`virtual` = computed by the host, no stored row). */
export type Circle = DirectoryCircle;

/** A seat in a circle. */
export type CircleMember = DirectoryCircleMember;

/** An accepted contact. */
export type Contact = DirectoryContact;

/** One hit of the global handle search. */
export type UserSearchHit = DirectoryUserHit;

/** The three request lists in one payload. */
export type ContactRequests = DirectoryRequests;

/** One request. `awaitingParent` = both said yes, a parent has not (ADR-115 §2). */
export type ContactRequest = DirectoryRequest;

/** The person on either end of a request. */
export type RequestUser = DirectoryRequestUser;

const NO_REQUESTS: ContactRequests = { incoming: [], outgoing: [], awaitingParent: [] };

/** The minimum query length before the search box asks the host anything. */
export const CONTACT_SEARCH_MIN = 2;
/** Debounce for the `@tag` box, ms. */
export const CONTACT_SEARCH_DEBOUNCE_MS = 300;

/** The leading sign of a handle; the host's search wants the bare username. */
const HANDLE_PREFIX = /^@/;

/**
 * Who is IN a circle vs every other contact — the ONE partition the «Кола» tab
 * renders from (К8a, 2026-10-07).
 *
 * The bug it closes: the tab badge counted `circle.members` (3) while the list
 * under «Хто в родині» rendered every accepted contact (4) and marked
 * membership only with a ✓ — so a pinned friend who was NOT in the circle sat
 * under a heading that promised he was. Now both read `members`, the server's
 * own answer: `inside` IS `members` (same order, same length — the badge and the
 * list cannot disagree), and `outside` is every contact that is not seated.
 */
export function splitByCircle(
  members: readonly CircleMember[],
  contacts: readonly Contact[],
): { inside: CircleMember[]; outside: Contact[] } {
  const seated = new Set(members.map((m) => m.userId));
  return { inside: [...members], outside: contacts.filter((c) => !seated.has(c.userId)) };
}

/**
 * The outcome of one write, WITH the host's refusal code (ADR-116, К3b).
 *
 * Most mutations here answer a plain boolean, because the only thing a failed rename can say is
 * «no». The home-circle toggle is different: its refusals are meaningful to the person who tapped
 * it («they are already family», «they have to accept you first»), and a toast that cannot name
 * which one happened is a shrug. So the code travels out of the hook.
 */
export type CircleWriteResult = DirectoryWriteResult;

export interface UseContactCirclesOptions {
  /** The host's address book. Must be STABLE across renders (memoize it): a new one reloads. */
  directory: ContactsDirectory;
  /** Landing/anon: the hook stays completely inert (no read, empty data). */
  disabled?: boolean;
}

export interface ContactCircles {
  circles: Circle[];
  contacts: Contact[];
  requests: ContactRequests;
  loading: boolean;
  /** Refetch all three. Every mutation below already calls it. */
  reload: () => Promise<void>;
  createCircle: (name: string) => Promise<boolean>;
  renameCircle: (circleId: string, name: string) => Promise<boolean>;
  deleteCircle: (circleId: string) => Promise<boolean>;
  /**
   * Seat a contact in (or out of) a circle. A VIRTUAL circle has no row to write to, so it is routed
   * to `setInHomeCircle`: ONE client path to that state, so a future change to the rule cannot land
   * on half of them.
   */
  setMembership: (circleId: string, userId: string, member: boolean) => Promise<boolean>;
  /**
   * ⭐ ADR-116 rule 1 — put a FRIEND into (or out of) the host's «closest people» circle (in Masia:
   * «Родина»). The canonical write, because that circle is virtual: the bit is a preference on the
   * contact, not a circle row.
   */
  setInHomeCircle: (userId: string, inCircle: boolean) => Promise<CircleWriteResult>;
  /**
   * Pin / unpin a contact to the bank (ADR-115).
   *
   * ⚠️ A pin is ALSO the acceptance record of a cross-family contact (an accepted request writes the
   * pair of pins), so unpinning one of those would DELETE the contact, not just take it off the
   * bank. Only a member of my primary family (`isPrimaryMember` — computed from `Person`, so the pin
   * is a pure preference) may be unpinned; the menu enforces that and so does this guard.
   */
  setPinned: (
    contact: Pick<Contact, 'userId' | 'isPrimaryMember'>,
    pinned: boolean,
  ) => Promise<boolean>;
  searchUsers: (q: string) => Promise<UserSearchHit[]>;
  sendRequest: (userId: string) => Promise<boolean>;
  actOnRequest: (requestId: string, action: ContactRequestAction) => Promise<boolean>;
}

export function useContactCircles({
  directory,
  disabled,
}: UseContactCirclesOptions): ContactCircles {
  const [circles, setCircles] = useState<Circle[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [requests, setRequests] = useState<ContactRequests>(NO_REQUESTS);
  const [loading, setLoading] = useState(!disabled);

  // The latest circles, readable from a callback without making every callback depend on them.
  const circlesRef = useRef<readonly Circle[]>(circles);
  circlesRef.current = circles;

  const reload = useCallback(async () => {
    if (disabled) return;
    try {
      // One round-trip for the three lists — they are read together on every
      // open and change together on every mutation.
      const [nextCircles, nextContacts, nextRequests] = await Promise.all([
        directory.listCircles(),
        directory.listContacts(),
        directory.listRequests(),
      ]);
      setCircles([...nextCircles]);
      setContacts([...nextContacts]);
      setRequests({
        incoming: nextRequests.incoming,
        outgoing: nextRequests.outgoing,
        awaitingParent: nextRequests.awaitingParent,
      });
    } catch (err) {
      console.error('[useContactCircles] load failed:', err);
    } finally {
      setLoading(false);
    }
  }, [directory, disabled]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** Every mutation is «fire, then re-read» — no optimistic copy of host state
   *  to drift from it. Returns whether the host accepted, and the code it
   *  sent when it did not (see `CircleWriteResult`). */
  const mutateResult = useCallback(
    async (
      label: string,
      write: () => Promise<DirectoryWriteResult>,
    ): Promise<CircleWriteResult> => {
      if (disabled) return { ok: false };
      try {
        const result = await write();
        if (!result.ok) {
          console.error('[useContactCircles] mutation rejected:', label, result.code);
          return result.code === undefined ? { ok: false } : { ok: false, code: result.code };
        }
        await reload();
        return { ok: true };
      } catch (err) {
        console.error('[useContactCircles] mutation failed:', label, err);
        return { ok: false };
      }
    },
    [reload, disabled],
  );

  /** The boolean face of the same one write path — every caller that has nothing
   *  to say about WHY a write failed. */
  const mutate = useCallback(
    async (label: string, write: () => Promise<DirectoryWriteResult>): Promise<boolean> =>
      (await mutateResult(label, write)).ok,
    [mutateResult],
  );

  const createCircle = useCallback(
    (name: string) => mutate('createCircle', () => directory.createCircle(name)),
    [directory, mutate],
  );

  const renameCircle = useCallback(
    (circleId: string, name: string) =>
      mutate('renameCircle', () => directory.renameCircle(circleId, name)),
    [directory, mutate],
  );

  const deleteCircle = useCallback(
    (circleId: string) => mutate('deleteCircle', () => directory.deleteCircle(circleId)),
    [directory, mutate],
  );

  const setInHomeCircle = useCallback(
    (userId: string, inCircle: boolean) =>
      mutateResult('setHomeCircleMembership', () =>
        directory.setHomeCircleMembership(userId, inCircle),
      ),
    [directory, mutateResult],
  );

  const setMembership = useCallback(
    async (circleId: string, userId: string, member: boolean) => {
      // A virtual circle (the home circle) has no member row to write — its state is a per-user bit
      // on the contact (ADR-116 rule 1). Routing it here rather than letting the host's delegating
      // endpoint do it keeps ONE client path to that state.
      const circle = circlesRef.current.find((c) => c.id === circleId);
      if (circle?.virtual) return (await setInHomeCircle(userId, member)).ok;
      return mutate('setCircleMembership', () =>
        directory.setCircleMembership(circleId, userId, member),
      );
    },
    [directory, mutate, setInHomeCircle],
  );

  const setPinned = useCallback(
    async (contact: Pick<Contact, 'userId' | 'isPrimaryMember'>, pinned: boolean) => {
      if (!pinned && !contact.isPrimaryMember) return false; // would delete the contact (see type doc)
      return mutate('setPinned', () => directory.setPinned(contact.userId, pinned));
    },
    [directory, mutate],
  );

  const sendRequest = useCallback(
    (userId: string) => mutate('sendRequest', () => directory.sendRequest(userId)),
    [directory, mutate],
  );

  const actOnRequest = useCallback(
    (requestId: string, action: ContactRequestAction) =>
      mutate('respondToRequest', () => directory.respondToRequest(requestId, action)),
    [directory, mutate],
  );

  /** The global `@tag` search (ADR-115 Г7A — a username IS the masia-tag). A read, so it is NOT
   *  routed through `mutate`: no refetch, and the caller owns the result list and its abort signal. */
  const searchUsers = useCallback(
    async (q: string): Promise<UserSearchHit[]> => {
      const query = q.trim().replace(HANDLE_PREFIX, '');
      if (disabled || query.length < CONTACT_SEARCH_MIN) return [];
      try {
        return [...(await directory.searchUsers(query))];
      } catch (err) {
        console.error('[useContactCircles] search failed:', err);
        return [];
      }
    },
    [directory, disabled],
  );

  return useMemo(
    () => ({
      circles,
      contacts,
      requests,
      loading,
      reload,
      createCircle,
      renameCircle,
      deleteCircle,
      setMembership,
      setInHomeCircle,
      setPinned,
      searchUsers,
      sendRequest,
      actOnRequest,
    }),
    [
      circles,
      contacts,
      requests,
      loading,
      reload,
      createCircle,
      renameCircle,
      deleteCircle,
      setMembership,
      setInHomeCircle,
      setPinned,
      searchUsers,
      sendRequest,
      actOnRequest,
    ],
  );
}
