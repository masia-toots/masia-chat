// @vitest-environment jsdom
/**
 * useContactCircles against the contracts' fake directory: the hook owns the load-and-reload cycle
 * and the routing of writes; the directory owns the rules (which the contract suite already proves).
 */
import {
  createFakeContactsDirectory,
  FAKE_ACCEPTED_USER_ID,
  FAKE_HOME_CIRCLE_ID,
  FAKE_STRANGER_USER_ID,
  type FakeContactsDirectory,
} from '@masia/contracts/fakes';
import type { ContactsDirectory } from '@masia/contracts';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, settle, type RenderedHook } from '../../test-support/render-hook.js';
import {
  CONTACT_SEARCH_MIN,
  splitByCircle,
  useContactCircles,
  type ContactCircles,
} from '../use-contact-circles.js';

afterEach(() => {
  vi.restoreAllMocks();
});

async function setup(
  directory: ContactsDirectory = createFakeContactsDirectory(),
  disabled = false,
): Promise<RenderedHook<ContactCircles>> {
  const hook = await renderHook(() => useContactCircles({ directory, disabled }));
  await settle();
  return hook;
}

describe('loading', () => {
  it('reads circles, contacts and requests together and stops loading', async () => {
    const directory = createFakeContactsDirectory();
    directory.receiveRequest(FAKE_STRANGER_USER_ID);
    const hook = await setup(directory);

    expect(hook.current.loading).toBe(false);
    expect(hook.current.circles.map((c) => c.id)).toEqual([FAKE_HOME_CIRCLE_ID]);
    expect(hook.current.contacts.map((c) => c.userId)).toEqual([FAKE_ACCEPTED_USER_ID]);
    expect(hook.current.requests.incoming).toHaveLength(1);
  });

  it('stays completely inert when disabled', async () => {
    const directory = createFakeContactsDirectory();
    const read = vi.spyOn(directory, 'listContacts');
    const hook = await setup(directory, true);

    expect(read).not.toHaveBeenCalled();
    expect(hook.current.contacts).toEqual([]);
    expect(await hook.current.createCircle('Friends')).toBe(false);
    expect(await hook.current.searchUsers('fake')).toEqual([]);
  });

  it('keeps what it had when a read fails', async () => {
    const directory = createFakeContactsDirectory();
    vi.spyOn(directory, 'listCircles').mockRejectedValue(new Error('offline'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const hook = await setup(directory);

    expect(hook.current.loading).toBe(false);
    expect(hook.current.circles).toEqual([]);
  });
});

describe('writes re-read the directory', () => {
  it('creates, renames and deletes a circle, and shows each result', async () => {
    const hook = await setup();

    await act(async () => {
      expect(await hook.current.createCircle('Friends')).toBe(true);
    });
    const created = hook.current.circles.find((c) => !c.virtual);
    expect(created?.name).toBe('Friends');

    await act(async () => {
      expect(await hook.current.renameCircle(created?.id ?? '', 'Pals')).toBe(true);
    });
    expect(hook.current.circles.find((c) => !c.virtual)?.name).toBe('Pals');

    await act(async () => {
      expect(await hook.current.deleteCircle(created?.id ?? '')).toBe(true);
    });
    expect(hook.current.circles.every((c) => c.virtual)).toBe(true);
  });

  it('reports a refusal as false and does not pretend the state changed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const hook = await setup();

    await act(async () => {
      expect(await hook.current.createCircle('   ')).toBe(false);
    });
    expect(hook.current.circles.every((c) => c.virtual)).toBe(true);
  });

  it('routes the virtual home circle to the home membership and a real circle to its own', async () => {
    const directory: FakeContactsDirectory = createFakeContactsDirectory();
    const home = vi.spyOn(directory, 'setHomeCircleMembership');
    const regular = vi.spyOn(directory, 'setCircleMembership');
    const hook = await setup(directory);

    await act(async () => {
      expect(
        await hook.current.setMembership(FAKE_HOME_CIRCLE_ID, FAKE_ACCEPTED_USER_ID, true),
      ).toBe(true);
    });
    expect(home).toHaveBeenCalledWith(FAKE_ACCEPTED_USER_ID, true);
    expect(regular).not.toHaveBeenCalled();
    expect(hook.current.circles.find((c) => c.virtual)?.members.map((m) => m.userId)).toEqual([
      FAKE_ACCEPTED_USER_ID,
    ]);

    await act(async () => {
      await hook.current.createCircle('Friends');
    });
    const friends = hook.current.circles.find((c) => !c.virtual);
    await act(async () => {
      expect(await hook.current.setMembership(friends?.id ?? '', FAKE_ACCEPTED_USER_ID, true)).toBe(
        true,
      );
    });
    expect(regular).toHaveBeenCalledWith(friends?.id, FAKE_ACCEPTED_USER_ID, true);
  });

  it("hands the home circle's refusal code back to the caller", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const hook = await setup();

    let result: Awaited<ReturnType<ContactCircles['setInHomeCircle']>> | undefined;
    await act(async () => {
      result = await hook.current.setInHomeCircle(FAKE_STRANGER_USER_ID, true);
    });
    expect(result).toEqual({ ok: false, code: 'NOT_A_CONTACT' });
  });

  it('pins any contact but refuses to unpin one that is not a primary member', async () => {
    const hook = await setup();
    const contact = { userId: FAKE_ACCEPTED_USER_ID, isPrimaryMember: false };

    await act(async () => {
      expect(await hook.current.setPinned(contact, true)).toBe(true);
    });
    expect(hook.current.contacts[0]?.isPinned).toBe(true);

    // Unpinning would delete a cross-family contact, so the hook says no without asking the host.
    await act(async () => {
      expect(await hook.current.setPinned(contact, false)).toBe(false);
    });
    expect(hook.current.contacts[0]?.isPinned).toBe(true);

    await act(async () => {
      expect(await hook.current.setPinned({ ...contact, isPrimaryMember: true }, false)).toBe(true);
    });
    expect(hook.current.contacts[0]?.isPinned).toBe(false);
  });

  it('sends a request and acts on a received one', async () => {
    const directory = createFakeContactsDirectory();
    const requestId = directory.receiveRequest(FAKE_STRANGER_USER_ID);
    const hook = await setup(directory);

    await act(async () => {
      expect(await hook.current.actOnRequest(requestId, 'accept')).toBe(true);
    });
    expect(hook.current.requests.incoming).toEqual([]);
    expect(hook.current.contacts.map((c) => c.userId)).toContain(FAKE_STRANGER_USER_ID);
  });
});

describe('search', () => {
  it('strips the @, skips queries that are too short, and asks the directory otherwise', async () => {
    const directory = createFakeContactsDirectory();
    const search = vi.spyOn(directory, 'searchUsers');
    const hook = await setup(directory);

    expect(await hook.current.searchUsers('a'.repeat(CONTACT_SEARCH_MIN - 1))).toEqual([]);
    expect(await hook.current.searchUsers('@')).toEqual([]);
    expect(search).not.toHaveBeenCalled();

    const hits = await hook.current.searchUsers('  @fake-stranger ');
    expect(search).toHaveBeenCalledWith('fake-stranger');
    expect(hits.map((h) => h.userId)).toEqual([FAKE_STRANGER_USER_ID]);
  });
});

describe('splitByCircle', () => {
  it("seats the circle's members first and leaves every other contact outside", async () => {
    const hook = await setup();
    await act(async () => {
      await hook.current.setInHomeCircle(FAKE_ACCEPTED_USER_ID, true);
    });
    const home = hook.current.circles.find((c) => c.virtual);

    const inHome = splitByCircle(home?.members ?? [], hook.current.contacts);
    expect(inHome.inside.map((m) => m.userId)).toEqual([FAKE_ACCEPTED_USER_ID]);
    expect(inHome.outside).toEqual([]);

    const nobody = splitByCircle([], hook.current.contacts);
    expect(nobody.inside).toEqual([]);
    expect(nobody.outside.map((c) => c.userId)).toEqual([FAKE_ACCEPTED_USER_ID]);
  });
});
