import { describe, expect, it } from 'vitest';
import type { ContactsDirectory } from '../ports/contacts-directory.js';
import { contractTitle, type ContractFactory } from './contract-support.js';

/** An id no host will ever have issued. */
const UNKNOWN_USER_ID = 'contract-unknown-user-id';
const UNKNOWN_ID = 'contract-unknown-id';
const NO_MATCH_QUERY = 'contract-query-that-matches-nobody';
const CIRCLE_NAME = 'Contract circle';
const CIRCLE_RENAMED = 'Contract circle renamed';
const GROUP_NAME = 'Contract group';
const GROUP_RENAMED = 'Contract group renamed';

/**
 * What the suite needs beyond the port itself.
 *
 * Why: whether someone is an accepted contact is host data, and a real host cannot be told to
 * receive a request from the outside. The host's test wiring names the users and supplies the trigger.
 */
export interface ContactsDirectoryContractHarness<T extends ContactsDirectory> {
  /** A user who has passed the consent gate, is a plain contact (not in the user's closest group). */
  readonly acceptedUserId: string;
  /** A user who exists, can be found by `strangerSearchQuery`, and has NOT passed the gate. */
  readonly strangerUserId: string;
  /** A query that finds `strangerUserId` in the global search. */
  readonly strangerSearchQuery: string;
  /** Makes `fromUserId` send the current user a contact request; returns the request's id. */
  receiveRequest(subject: T, fromUserId: string): string | Promise<string>;
}

/** Registers the behavioural contract every `ContactsDirectory` implementation must honour. */
export function describeContactsDirectoryContract<T extends ContactsDirectory>(
  name: string,
  factory: ContractFactory<T>,
  harness: ContactsDirectoryContractHarness<T>,
): void {
  describe(contractTitle('ContactsDirectory', name), () => {
    describe('the consent gate', () => {
      it('lets the messenger address a user who passed the consent gate', async () => {
        const directory = await factory();
        expect(await directory.canAddressUser(harness.acceptedUserId)).toBe(true);
      });

      it('refuses a user who has not passed the consent gate', async () => {
        const directory = await factory();
        expect(await directory.canAddressUser(harness.strangerUserId)).toBe(false);
      });

      it('refuses an id the host does not know', async () => {
        const directory = await factory();
        expect(await directory.canAddressUser(UNKNOWN_USER_ID)).toBe(false);
      });

      it('resolves a display name for an accepted user', async () => {
        const directory = await factory();
        const display = await directory.resolveDisplay(harness.acceptedUserId);
        expect(display).not.toBeNull();
        expect(display?.name).not.toBe('');
      });

      it('resolves null, not an error, for an id the host does not know', async () => {
        const directory = await factory();
        expect(await directory.resolveDisplay(UNKNOWN_USER_ID)).toBeNull();
      });

      it('gives the same answer when asked twice (asking is not consuming)', async () => {
        const directory = await factory();
        const first = await directory.canAddressUser(harness.acceptedUserId);
        const second = await directory.canAddressUser(harness.acceptedUserId);
        expect(second).toBe(first);
      });
    });

    describe('reads', () => {
      it('lists the accepted user once, with a name, among the contacts', async () => {
        const directory = await factory();
        const matches = (await directory.listContacts()).filter(
          (c) => c.userId === harness.acceptedUserId,
        );
        expect(matches).toHaveLength(1);
        expect(matches[0]?.displayName).not.toBe('');
      });

      it('does not list a user who has not passed the gate among the contacts', async () => {
        const directory = await factory();
        const ids = (await directory.listContacts()).map((c) => c.userId);
        expect(ids).not.toContain(harness.strangerUserId);
      });

      it('answers lists, never null, when nothing has been written', async () => {
        const directory = await factory();
        expect(Array.isArray(await directory.listCircles())).toBe(true);
        expect(Array.isArray(await directory.listGroups())).toBe(true);
        const requests = await directory.listRequests();
        expect(Array.isArray(requests.incoming)).toBe(true);
        expect(Array.isArray(requests.outgoing)).toBe(true);
        expect(Array.isArray(requests.awaitingParent)).toBe(true);
      });

      it('finds a user by the global search', async () => {
        const directory = await factory();
        const hits = await directory.searchUsers(harness.strangerSearchQuery);
        expect(hits.map((h) => h.userId)).toContain(harness.strangerUserId);
      });

      it('finds nobody for a query that matches nobody', async () => {
        const directory = await factory();
        expect(await directory.searchUsers(NO_MATCH_QUERY)).toEqual([]);
      });
    });

    describe('pins', () => {
      it('shows a pinned contact as pinned', async () => {
        const directory = await factory();
        expect((await directory.setPinned(harness.acceptedUserId, true)).ok).toBe(true);
        const contact = (await directory.listContacts()).find(
          (c) => c.userId === harness.acceptedUserId,
        );
        expect(contact?.isPinned).toBe(true);
      });
    });

    describe('circles', () => {
      it('creates, renames and deletes a circle, each visible to the next read', async () => {
        const directory = await factory();
        expect((await directory.createCircle(CIRCLE_NAME)).ok).toBe(true);
        const created = (await directory.listCircles()).find((c) => c.name === CIRCLE_NAME);
        expect(created).toBeDefined();
        expect(created?.virtual).toBe(false);
        expect(created?.members).toEqual([]);

        const id = created?.id ?? UNKNOWN_ID;
        expect((await directory.renameCircle(id, CIRCLE_RENAMED)).ok).toBe(true);
        expect((await directory.listCircles()).map((c) => c.name)).toContain(CIRCLE_RENAMED);

        expect((await directory.deleteCircle(id)).ok).toBe(true);
        expect((await directory.listCircles()).map((c) => c.id)).not.toContain(id);
      });

      it('seats a contact in a circle and takes them out again', async () => {
        const directory = await factory();
        await directory.createCircle(CIRCLE_NAME);
        const id = (await directory.listCircles()).find((c) => c.name === CIRCLE_NAME)?.id;
        expect(id).toBeDefined();
        const circleId = id ?? UNKNOWN_ID;

        expect(
          (await directory.setCircleMembership(circleId, harness.acceptedUserId, true)).ok,
        ).toBe(true);
        const seated = (await directory.listCircles()).find((c) => c.id === circleId);
        expect(seated?.members.map((m) => m.userId)).toContain(harness.acceptedUserId);

        expect(
          (await directory.setCircleMembership(circleId, harness.acceptedUserId, false)).ok,
        ).toBe(true);
        const emptied = (await directory.listCircles()).find((c) => c.id === circleId);
        expect(emptied?.members.map((m) => m.userId)).not.toContain(harness.acceptedUserId);
      });

      it('refuses to rename or delete a circle it does not have', async () => {
        const directory = await factory();
        expect((await directory.renameCircle(UNKNOWN_ID, CIRCLE_NAME)).ok).toBe(false);
        expect((await directory.deleteCircle(UNKNOWN_ID)).ok).toBe(false);
      });

      it('puts a contact into the built-in closest-people circle and out again', async () => {
        const directory = await factory();
        expect((await directory.setHomeCircleMembership(harness.acceptedUserId, true)).ok).toBe(
          true,
        );
        const inside = (await directory.listCircles()).find((c) => c.virtual);
        expect(inside?.members.map((m) => m.userId)).toContain(harness.acceptedUserId);

        expect((await directory.setHomeCircleMembership(harness.acceptedUserId, false)).ok).toBe(
          true,
        );
        const outside = (await directory.listCircles()).find((c) => c.virtual);
        expect(outside?.members.map((m) => m.userId)).not.toContain(harness.acceptedUserId);
      });

      it('refuses a seat for someone who is not a contact, and says so with a code', async () => {
        const directory = await factory();
        const refusal = await directory.setHomeCircleMembership(harness.strangerUserId, true);
        expect(refusal.ok).toBe(false);
        expect(refusal.code).toEqual(expect.any(String));
      });
    });

    describe('groups', () => {
      it('creates a group the user administers, with the chosen contact in it', async () => {
        const directory = await factory();
        const group = await directory.createGroup(GROUP_NAME, [harness.acceptedUserId]);
        expect(group).not.toBeNull();
        expect(group?.name).toBe(GROUP_NAME);
        expect(group?.myRole).toBe('ADMIN');
        expect(group?.conversationId).toBeNull();
        expect(group?.members.map((m) => m.userId)).toContain(harness.acceptedUserId);
        expect((await directory.listGroups()).map((g) => g.id)).toContain(group?.id);
      });

      it('refuses to create a group without a name', async () => {
        const directory = await factory();
        expect(await directory.createGroup('', [])).toBeNull();
      });

      it('renames a group and ticks a contact out and in', async () => {
        const directory = await factory();
        const created = await directory.createGroup(GROUP_NAME, [harness.acceptedUserId]);
        const id = created?.id ?? UNKNOWN_ID;

        expect((await directory.renameGroup(id, GROUP_RENAMED)).ok).toBe(true);
        expect((await directory.setGroupMembership(id, harness.acceptedUserId, false)).ok).toBe(
          true,
        );
        let listed = (await directory.listGroups()).find((g) => g.id === id);
        expect(listed?.name).toBe(GROUP_RENAMED);
        expect(listed?.members.map((m) => m.userId)).not.toContain(harness.acceptedUserId);

        expect((await directory.setGroupMembership(id, harness.acceptedUserId, true)).ok).toBe(
          true,
        );
        listed = (await directory.listGroups()).find((g) => g.id === id);
        expect(listed?.members.map((m) => m.userId)).toContain(harness.acceptedUserId);
      });

      it('opens the group chat once: asking again returns the same conversation', async () => {
        const directory = await factory();
        const id = (await directory.createGroup(GROUP_NAME, []))?.id ?? UNKNOWN_ID;
        const first = await directory.ensureGroupConversation(id);
        const second = await directory.ensureGroupConversation(id);
        expect(first).not.toBeNull();
        expect(second).toBe(first);
        const listed = (await directory.listGroups()).find((g) => g.id === id);
        expect(listed?.conversationId).toBe(first);
      });

      it('answers null for the chat of a group it does not have', async () => {
        const directory = await factory();
        expect(await directory.ensureGroupConversation(UNKNOWN_ID)).toBeNull();
      });

      it('deletes a group, and lets the user leave one', async () => {
        const directory = await factory();
        const toDelete = (await directory.createGroup(GROUP_NAME, []))?.id ?? UNKNOWN_ID;
        const toLeave = (await directory.createGroup(GROUP_RENAMED, []))?.id ?? UNKNOWN_ID;

        expect((await directory.deleteGroup(toDelete)).ok).toBe(true);
        expect((await directory.leaveGroup(toLeave)).ok).toBe(true);
        const ids = (await directory.listGroups()).map((g) => g.id);
        expect(ids).not.toContain(toDelete);
        expect(ids).not.toContain(toLeave);
      });

      it('refuses to change a group it does not have', async () => {
        const directory = await factory();
        expect((await directory.renameGroup(UNKNOWN_ID, GROUP_NAME)).ok).toBe(false);
        expect((await directory.deleteGroup(UNKNOWN_ID)).ok).toBe(false);
        expect((await directory.leaveGroup(UNKNOWN_ID)).ok).toBe(false);
      });
    });

    describe('contact requests', () => {
      it('lists a request the user sent as outgoing, and lets the user cancel it', async () => {
        const directory = await factory();
        expect((await directory.sendRequest(harness.strangerUserId)).ok).toBe(true);
        const sent = (await directory.listRequests()).outgoing.find(
          (r) => r.toUser.userId === harness.strangerUserId,
        );
        expect(sent).toBeDefined();
        expect(sent?.status).toBe('PENDING');

        expect((await directory.respondToRequest(sent?.id ?? UNKNOWN_ID, 'cancel')).ok).toBe(true);
        const left = (await directory.listRequests()).outgoing.filter(
          (r) => r.toUser.userId === harness.strangerUserId,
        );
        expect(left).toEqual([]);
        expect(await directory.canAddressUser(harness.strangerUserId)).toBe(false);
      });

      it('does not let the user ask someone who is already a contact', async () => {
        const directory = await factory();
        expect((await directory.sendRequest(harness.acceptedUserId)).ok).toBe(false);
      });

      it('opens the gate when the user accepts an incoming request', async () => {
        const directory = await factory();
        const id = await harness.receiveRequest(directory, harness.strangerUserId);
        const incoming = (await directory.listRequests()).incoming.find((r) => r.id === id);
        expect(incoming?.fromUser.userId).toBe(harness.strangerUserId);

        expect((await directory.respondToRequest(id, 'accept')).ok).toBe(true);
        expect(await directory.canAddressUser(harness.strangerUserId)).toBe(true);
        expect((await directory.listRequests()).incoming.map((r) => r.id)).not.toContain(id);
      });

      it('keeps the gate shut when the user declines an incoming request', async () => {
        const directory = await factory();
        const id = await harness.receiveRequest(directory, harness.strangerUserId);

        expect((await directory.respondToRequest(id, 'decline')).ok).toBe(true);
        expect(await directory.canAddressUser(harness.strangerUserId)).toBe(false);
        expect((await directory.listRequests()).incoming.map((r) => r.id)).not.toContain(id);
      });

      it('refuses an action on a request it does not have', async () => {
        const directory = await factory();
        expect((await directory.respondToRequest(UNKNOWN_ID, 'accept')).ok).toBe(false);
      });

      it('refuses to cancel a request that was sent to the user, not by them', async () => {
        const directory = await factory();
        const id = await harness.receiveRequest(directory, harness.strangerUserId);
        expect((await directory.respondToRequest(id, 'cancel')).ok).toBe(false);
        expect((await directory.listRequests()).incoming.map((r) => r.id)).toContain(id);
      });
    });
  });
}
