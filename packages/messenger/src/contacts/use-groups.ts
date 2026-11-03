/**
 * useGroups — the ONE client-side home for the groups axis (plan `circles-bank`
 * К4): my groups, their members, their chat, and every mutation.
 *
 * ## Why a hook, lifted to the page
 *
 * Two surfaces read groups: the BANK (a plate per group, whether or not the
 * group has a conversation yet) and the «Групи» tab of «Контакти» (`GroupsPanel`, К5b) behind `👥+`. One
 * owner, one refetch — the same rule, and the same reason, as the circles.
 *
 * The data comes through the `ContactsDirectory` port (`@masia/contracts`); the hook knows no URL
 * and no host API type.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  ContactsDirectory,
  DirectoryGroup,
  DirectoryGroupMember,
  DirectoryWriteResult,
} from '@masia/contracts';

/** A group I am a member of, with its members and its chat (if one was opened). */
export type Group = DirectoryGroup;
export type GroupMember = DirectoryGroupMember;

/** Same cap as the server — the field just stops earlier. */
export const GROUP_NAME_MAX = 40;

export interface UseGroupsOptions {
  /** The host's address book. Must be STABLE across renders (memoize it): a new one reloads. */
  directory: ContactsDirectory;
  /** Landing/anon: the hook stays completely inert (no read, empty data). */
  disabled?: boolean;
}

export interface Groups {
  groups: Group[];
  loading: boolean;
  reload: () => Promise<void>;
  createGroup: (name: string, memberUserIds: string[]) => Promise<Group | null>;
  renameGroup: (groupId: string, name: string) => Promise<boolean>;
  deleteGroup: (groupId: string) => Promise<boolean>;
  /** Tick a person in or out of a group I administer. */
  setMembership: (groupId: string, userId: string, member: boolean) => Promise<boolean>;
  leaveGroup: (groupId: string) => Promise<boolean>;
  /** Get-or-create the group's chat. Returns the conversation id. */
  ensureConversation: (groupId: string) => Promise<string | null>;
}

export function useGroups({ directory, disabled }: UseGroupsOptions): Groups {
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(!disabled);

  const reload = useCallback(async () => {
    if (disabled) return;
    try {
      setGroups([...(await directory.listGroups())]);
    } catch (err) {
      console.error('[useGroups] load failed:', err);
    } finally {
      setLoading(false);
    }
  }, [directory, disabled]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** «Fire, then re-read» — no optimistic copy of host state to drift from it. */
  const mutate = useCallback(
    async (label: string, write: () => Promise<DirectoryWriteResult>): Promise<boolean> => {
      if (disabled) return false;
      try {
        const result = await write();
        if (!result.ok) {
          console.error('[useGroups] mutation rejected:', label, result.code);
          return false;
        }
        await reload();
        return true;
      } catch (err) {
        console.error('[useGroups] mutation failed:', label, err);
        return false;
      }
    },
    [reload, disabled],
  );

  const createGroup = useCallback(
    async (name: string, memberUserIds: string[]): Promise<Group | null> => {
      if (disabled) return null;
      try {
        const group = await directory.createGroup(name, memberUserIds);
        if (!group) {
          console.error('[useGroups] create rejected');
          return null;
        }
        await reload();
        return group;
      } catch (err) {
        console.error('[useGroups] create failed:', err);
        return null;
      }
    },
    [directory, reload, disabled],
  );

  const renameGroup = useCallback(
    (groupId: string, name: string) =>
      mutate('renameGroup', () => directory.renameGroup(groupId, name)),
    [directory, mutate],
  );

  const deleteGroup = useCallback(
    (groupId: string) => mutate('deleteGroup', () => directory.deleteGroup(groupId)),
    [directory, mutate],
  );

  const setMembership = useCallback(
    (groupId: string, userId: string, member: boolean) =>
      mutate('setGroupMembership', () => directory.setGroupMembership(groupId, userId, member)),
    [directory, mutate],
  );

  const leaveGroup = useCallback(
    (groupId: string) => mutate('leaveGroup', () => directory.leaveGroup(groupId)),
    [directory, mutate],
  );

  /** Get-or-create the chat. Idempotent on the host, so the caller may fire it
   *  on every selection without forking a second conversation. */
  const ensureConversation = useCallback(
    async (groupId: string): Promise<string | null> => {
      if (disabled) return null;
      try {
        const conversationId = await directory.ensureGroupConversation(groupId);
        if (conversationId === null) return null;
        // The group's `conversationId` just changed from null to this — re-read,
        // or the bank keeps believing the group has no chat.
        await reload();
        return conversationId;
      } catch (err) {
        console.error('[useGroups] ensure conversation failed:', err);
        return null;
      }
    },
    [directory, reload, disabled],
  );

  return useMemo(
    () => ({
      groups,
      loading,
      reload,
      createGroup,
      renameGroup,
      deleteGroup,
      setMembership,
      leaveGroup,
      ensureConversation,
    }),
    [
      groups,
      loading,
      reload,
      createGroup,
      renameGroup,
      deleteGroup,
      setMembership,
      leaveGroup,
      ensureConversation,
    ],
  );
}
