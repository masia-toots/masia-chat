import { describe, expect, it } from 'vitest';
import { createPeopleDirectory } from './people-directory.js';

const BO = { userId: 'u-bo', displayName: 'Bo' };
const CY = { userId: 'u-cy', displayName: 'Cy' };

describe('the playground address book', () => {
  it('lists everybody who is here as a contact, with no consent flow around them', async () => {
    const directory = createPeopleDirectory([BO, CY]);
    const contacts = await directory.listContacts();
    expect(contacts.map((c) => c.displayName)).toEqual(['Bo', 'Cy']);
    expect(contacts.every((c) => c.isPrimaryMember && !c.isPinned)).toBe(true);
    expect(await directory.listRequests()).toEqual({ incoming: [], outgoing: [], awaitingParent: [] });
    expect(await directory.listGroups()).toEqual([]);
    expect(await directory.searchUsers('x')).toEqual([]);
  });

  it('shows the next read what setPeople was given', async () => {
    const directory = createPeopleDirectory([BO]);
    directory.setPeople([BO, CY]);
    expect((await directory.listContacts()).map((c) => c.displayName)).toEqual(['Bo', 'Cy']);
    expect(await directory.canAddressUser('u-cy')).toBe(true);
    directory.setPeople([]);
    expect(await directory.canAddressUser('u-cy')).toBe(false);
    expect(await directory.resolveDisplay('u-cy')).toBeNull();
  });

  it('resolves a name for someone it knows', async () => {
    expect(await createPeopleDirectory([BO]).resolveDisplay('u-bo')).toEqual({ name: 'Bo' });
  });

  it('pins and unpins a contact, and refuses a stranger', async () => {
    const directory = createPeopleDirectory([BO]);
    expect(await directory.setPinned('u-bo', true)).toEqual({ ok: true });
    const pinned = (await directory.listContacts())[0];
    expect(pinned?.isPinned).toBe(true);
    expect(pinned?.pinnedAt).not.toBeNull();
    expect(await directory.setPinned('u-bo', false)).toEqual({ ok: true });
    expect((await directory.listContacts())[0]?.isPinned).toBe(false);
    expect(await directory.setPinned('u-nobody', true)).toMatchObject({ ok: false });
  });

  it('keeps circles in memory: create, rename, add and remove a member, delete', async () => {
    const directory = createPeopleDirectory([BO, CY]);
    expect(await directory.createCircle('  Friends  ')).toEqual({ ok: true });
    const [circle] = await directory.listCircles();
    expect(circle?.name).toBe('Friends');

    expect(await directory.setCircleMembership(circle?.id ?? '', 'u-bo', true)).toEqual({ ok: true });
    expect((await directory.listCircles())[0]?.members.map((m) => m.displayName)).toEqual(['Bo']);

    expect(await directory.renameCircle(circle?.id ?? '', 'Pals')).toEqual({ ok: true });
    expect((await directory.listCircles())[0]?.name).toBe('Pals');

    expect(await directory.setCircleMembership(circle?.id ?? '', 'u-bo', false)).toEqual({ ok: true });
    expect((await directory.listCircles())[0]?.members).toEqual([]);

    expect(await directory.deleteCircle(circle?.id ?? '')).toEqual({ ok: true });
    expect(await directory.listCircles()).toEqual([]);
  });

  it('drops a circle member who has left from what it shows', async () => {
    const directory = createPeopleDirectory([BO]);
    await directory.createCircle('Friends');
    const id = (await directory.listCircles())[0]?.id ?? '';
    await directory.setCircleMembership(id, 'u-bo', true);
    directory.setPeople([]);
    expect((await directory.listCircles())[0]?.members).toEqual([]);
  });

  it('refuses what makes no sense: an empty circle name, an unknown circle, an unknown member', async () => {
    const directory = createPeopleDirectory([BO]);
    expect(await directory.createCircle('   ')).toMatchObject({ ok: false });
    expect(await directory.renameCircle('nope', 'x')).toMatchObject({ ok: false });
    expect(await directory.deleteCircle('nope')).toMatchObject({ ok: false });
    await directory.createCircle('Friends');
    const id = (await directory.listCircles())[0]?.id ?? '';
    expect(await directory.setCircleMembership(id, 'u-nobody', true)).toMatchObject({ ok: false });
    expect(await directory.renameCircle(id, '  ')).toMatchObject({ ok: false });
  });

  it('answers the way a host without the feature does for requests, groups and the home circle', async () => {
    const directory = createPeopleDirectory([BO]);
    expect(await directory.sendRequest('u-bo')).toMatchObject({ ok: false });
    expect(await directory.respondToRequest('r', 'accept')).toMatchObject({ ok: false });
    expect(await directory.createGroup('g', [])).toBeNull();
    expect(await directory.setHomeCircleMembership('u-bo', true)).toMatchObject({ ok: false });
    expect(await directory.ensureGroupConversation('g')).toBeNull();
  });
});
