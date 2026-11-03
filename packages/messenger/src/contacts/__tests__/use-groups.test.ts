// @vitest-environment jsdom
/**
 * useGroups against the contracts' fake directory: load, the fire-then-re-read write cycle, and the
 * get-or-create chat that must refresh the group it just changed.
 */
import { createFakeContactsDirectory, FAKE_ACCEPTED_USER_ID } from '@masia/contracts/fakes';
import type { ContactsDirectory } from '@masia/contracts';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, settle, type RenderedHook } from '../../test-support/render-hook.js';
import { useGroups, type Groups } from '../use-groups.js';

afterEach(() => {
  vi.restoreAllMocks();
});

async function setup(
  directory: ContactsDirectory = createFakeContactsDirectory(),
  disabled = false,
): Promise<RenderedHook<Groups>> {
  const hook = await renderHook(() => useGroups({ directory, disabled }));
  await settle();
  return hook;
}

describe('useGroups', () => {
  it('starts empty and not loading once the first read is back', async () => {
    const hook = await setup();
    expect(hook.current.loading).toBe(false);
    expect(hook.current.groups).toEqual([]);
  });

  it('stays completely inert when disabled', async () => {
    const directory = createFakeContactsDirectory();
    const read = vi.spyOn(directory, 'listGroups');
    const hook = await setup(directory, true);

    expect(read).not.toHaveBeenCalled();
    expect(await hook.current.createGroup('Trip', [])).toBeNull();
    expect(await hook.current.ensureConversation('g')).toBeNull();
  });

  it('creates a group with its members and shows it', async () => {
    const hook = await setup();

    let created: Awaited<ReturnType<Groups['createGroup']>> = null;
    await act(async () => {
      created = await hook.current.createGroup('Trip', [FAKE_ACCEPTED_USER_ID]);
    });

    expect(created).not.toBeNull();
    expect(hook.current.groups.map((g) => g.name)).toEqual(['Trip']);
    expect(hook.current.groups[0]?.members.map((m) => m.userId)).toContain(FAKE_ACCEPTED_USER_ID);
  });

  it('answers null for a refused create and leaves the list alone', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const hook = await setup();

    await act(async () => {
      expect(await hook.current.createGroup('  ', [])).toBeNull();
    });
    expect(hook.current.groups).toEqual([]);
  });

  it('renames, changes membership and deletes, re-reading after each', async () => {
    const hook = await setup();
    await act(async () => {
      await hook.current.createGroup('Trip', []);
    });
    const groupId = hook.current.groups[0]?.id ?? '';

    await act(async () => {
      expect(await hook.current.renameGroup(groupId, 'Hike')).toBe(true);
    });
    expect(hook.current.groups[0]?.name).toBe('Hike');

    await act(async () => {
      expect(await hook.current.setMembership(groupId, FAKE_ACCEPTED_USER_ID, true)).toBe(true);
    });
    expect(hook.current.groups[0]?.members.map((m) => m.userId)).toContain(FAKE_ACCEPTED_USER_ID);

    await act(async () => {
      expect(await hook.current.deleteGroup(groupId)).toBe(true);
    });
    expect(hook.current.groups).toEqual([]);
  });

  it('refuses a write on a group that does not exist without throwing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const hook = await setup();

    await act(async () => {
      expect(await hook.current.leaveGroup('nope')).toBe(false);
    });
  });

  it("opens the group's chat once, hands back its id and refreshes the group", async () => {
    const hook = await setup();
    await act(async () => {
      await hook.current.createGroup('Trip', []);
    });
    const groupId = hook.current.groups[0]?.id ?? '';
    expect(hook.current.groups[0]?.conversationId).toBeNull();

    let first: string | null = null;
    let second: string | null = null;
    await act(async () => {
      first = await hook.current.ensureConversation(groupId);
      second = await hook.current.ensureConversation(groupId);
    });

    expect(first).not.toBeNull();
    expect(second).toBe(first);
    expect(hook.current.groups[0]?.conversationId).toBe(first);
  });
});
