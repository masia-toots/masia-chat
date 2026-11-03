/**
 * GroupsPanel: the body of the "Groups" tab of the contacts menu (plan `circles-bank` К4; К5b).
 *
 * Founder 2026-09-01: «Після контактів йдуть групи, КРАД та вибір чату із групою. Групи скрізні
 * можна між колами.»
 *
 * ## A TAB BODY of the contacts menu (К5b, 2026-10-07)
 *
 * This is what the "Groups" tab shows: the list, "+ new group", the roster editor. A group's own
 * actions (rename, leave, delete) open INLINE under the list, never in a nested popup: a menu
 * inside a menu is a second focus trap.
 *
 * ## The three rules this component does NOT get to bend
 *
 * RED: **a group exists BEFORE it has a chat.** The list comes from the groups owner
 * (`useGroups`), never from the inbox. That is the whole point of К4: until then a group with no
 * conversation was invisible, so a group could not be created and then written in.
 *
 * RED: **groups are "скрізні": the circles do NOT partition them** (founder). The people picker
 * below is grouped BY circle purely so a long list can be read; membership is per-person, any
 * circle, plus contacts in none of them. Nothing here filters the pool by the group's "own" circle,
 * because a group has none.
 *
 * RED: **the pool is my ACCEPTED CONTACTS.** Exactly the pool the circles offer (family members
 * included). A group is not a door to a stranger; the host refuses one too (`NOT_A_CONTACT`), which
 * is what makes the rule real rather than a UI convention.
 */
import { useMemo, useState } from 'react';
import { Button, TextInput } from '@mantine/core';
import { GROUP_NAME_MAX, type Contact, type ContactCircles, type Group, type Groups } from '../../contacts/index.js';
import { useMessengerUi, useT } from '../provider/messenger-ui.js';
import './group-manager.css';

export interface GroupsPanelProps {
  /** The groups owner (`useGroups`), lifted by the page. */
  data: Groups;
  /** The circles owner (`useContactCircles`): the people pool and its grouping. */
  circles: ContactCircles;
  /** Open the group's chat: the SAME `selectContact` the plates fire. */
  onOpenGroup(groupId: string): void;
}

// ── "Groups": the list, the create form, the roster ──────────────────────────────

export function GroupsPanel({ data, circles, onOpenGroup }: GroupsPanelProps) {
  const { themeStyle } = useMessengerUi();
  const t = useT();
  const { groups } = data;

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newMembers, setNewMembers] = useState<string[]>([]);
  /** The group whose inline editor (rename, leave, delete) is open. */
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  /** The group whose roster is open for editing. `null` = nobody's. */
  const [editingId, setEditingId] = useState<string | null>(null);

  const editing = groups.find((g) => g.id === editingId) ?? null;
  const renaming = groups.find((g) => g.id === renamingId) ?? null;

  const submitCreate = async () => {
    const name = newName.trim();
    if (!name) return;
    const group = await data.createGroup(name, newMembers);
    if (group) {
      setNewName('');
      setNewMembers([]);
      setCreating(false);
      // A brand-new group opens straight into its roster: the next thing anyone wants after
      // naming one is to check who is in it.
      setEditingId(group.id);
    }
  };

  const submitRename = async () => {
    if (!renamingId) return;
    const name = renameValue.trim();
    if (!name) return;
    const ok = await data.renameGroup(renamingId, name);
    if (ok) {
      setRenamingId(null);
      setRenameValue('');
    }
  };

  return (
    <div className="groupman" data-panel="groups" style={themeStyle}>
      {/* 1. MY GROUPS. The list is the groups owner's, so a group with NO conversation is here
          too: that is the К4 fix, not a detail. */}
      <section className="groupman__sec" data-sec="groups">
        <h3 className="groupman__h">
          {t('groups.title')}
          <span className="groupman__h-n">{groups.length}</span>
        </h3>

        {groups.length === 0 ? (
          <p className="groupman__empty">{t('groups.none')}</p>
        ) : (
          <div className="groupman__list">
            {groups.map((g) => (
              <GroupRow
                key={g.id}
                group={g}
                isEditing={g.id === editingId}
                actionsOpen={g.id === renamingId}
                onOpen={() => onOpenGroup(g.id)}
                onMembers={() => setEditingId((v) => (v === g.id ? null : g.id))}
                onActions={() => {
                  if (renamingId === g.id) {
                    setRenamingId(null);
                    return;
                  }
                  setRenamingId(g.id);
                  setRenameValue(g.name);
                }}
              />
            ))}
          </div>
        )}

        <button type="button" className="groupman__add" onClick={() => setCreating((v) => !v)}>
          {t('groups.add')}
        </button>

        {creating && (
          <div className="groupman__form" data-sec="create">
            <TextInput
              size="xs"
              value={newName}
              maxLength={GROUP_NAME_MAX}
              onChange={(e) => setNewName(e.currentTarget.value)}
              placeholder={t('groups.namePlaceholder')}
              aria-label={t('groups.namePlaceholder')}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submitCreate();
              }}
              data-testid="group-name"
            />
            <Button
              size="xs"
              color="cyan"
              disabled={!newName.trim()}
              onClick={() => void submitCreate()}
              data-testid="group-create"
            >
              {t('common.create')}
            </Button>
            <PeoplePicker
              circles={circles}
              selected={new Set(newMembers)}
              onToggle={(userId, next) =>
                setNewMembers((prev) => (next ? [...prev, userId] : prev.filter((u) => u !== userId)))
              }
            />
          </div>
        )}

        {/* THE GROUP'S OWN ACTIONS, INLINE (К5b): rename is an admin's; leaving is anyone's;
            deleting is an admin's. Same three verbs the old popup held. */}
        {renaming && (
          <div className="groupman__form" data-sec="edit-group" data-group-id={renaming.id}>
            {renaming.myRole === 'ADMIN' && (
              <>
                <TextInput
                  size="xs"
                  value={renameValue}
                  maxLength={GROUP_NAME_MAX}
                  aria-label={t('groups.rename')}
                  onChange={(e) => setRenameValue(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void submitRename();
                  }}
                />
                <Button size="xs" color="cyan" disabled={!renameValue.trim()} onClick={() => void submitRename()}>
                  {t('common.save')}
                </Button>
              </>
            )}
            <Button
              size="xs"
              variant="subtle"
              color="gray"
              onClick={() => {
                setRenamingId(null);
                void data.leaveGroup(renaming.id);
              }}
            >
              {t('groups.leave')}
            </Button>
            {renaming.myRole === 'ADMIN' && (
              <Button
                size="xs"
                variant="subtle"
                color="red"
                onClick={() => {
                  setRenamingId(null);
                  void data.deleteGroup(renaming.id);
                }}
              >
                {t('groups.delete')}
              </Button>
            )}
            <Button size="xs" variant="subtle" color="gray" onClick={() => setRenamingId(null)}>
              {t('common.cancel')}
            </Button>
          </div>
        )}
      </section>

      {/* 2. WHO IS IN THE GROUP. Only when a group is open for editing: the pool is every accepted
          contact, grouped by circle for READING, and a person may come from any of them (or from
          none). Ticking is an ADMIN's action: a plain member sees the roster and cannot change it,
          which the host enforces too. */}
      {editing && (
        <section className="groupman__sec" data-sec="members">
          <h3 className="groupman__h">
            {t('groups.inGroup')}
            <span className="groupman__h-sub">{editing.name}</span>
          </h3>
          {editing.myRole !== 'ADMIN' && <p className="groupman__empty">{t('groups.memberOnly')}</p>}
          <PeoplePicker
            circles={circles}
            selected={new Set(editing.members.map((m) => m.userId))}
            readOnly={editing.myRole !== 'ADMIN'}
            onToggle={(userId, next) => void data.setMembership(editing.id, userId, next)}
          />
        </section>
      )}
    </div>
  );
}

// ── One group's row ────────────────────────────────────────────────────────────

interface GroupRowProps {
  group: Group;
  isEditing: boolean;
  actionsOpen: boolean;
  onOpen(): void;
  onMembers(): void;
  onActions(): void;
}

function GroupRow({ group, isEditing, actionsOpen, onOpen, onMembers, onActions }: GroupRowProps) {
  const { slots } = useMessengerUi();
  const t = useT();
  const { PersonChip } = slots;
  return (
    <span
      className={`groupman__row${isEditing ? ' is-editing' : ''}`}
      data-group-id={group.id}
      data-has-chat={group.conversationId ? 'true' : 'false'}
    >
      {/* THE NAME OPENS THE CHAT (founder: «вибір чату із групою»). The group may have none yet:
          the page's `ensureConversation` makes it on arrival. */}
      <button type="button" className="groupman__row-open" onClick={onOpen} title={t('groups.openChat')}>
        <PersonChip name={group.name} avatarUrl={group.avatarUrl} kind="GROUP" label={group.name} />
        <span className="groupman__row-name">{group.name}</span>
        <span className="groupman__row-n">{group.members.length}</span>
      </button>
      <button type="button" className="groupman__row-members" aria-pressed={isEditing} onClick={onMembers}>
        {t('groups.members')}
      </button>
      <button
        type="button"
        className="groupman__row-more"
        aria-label={t('groups.editGroup')}
        aria-expanded={actionsOpen}
        onClick={onActions}
      >
        ⋯
      </button>
    </span>
  );
}

// ── The people pool, grouped by circle for reading ─────────────────────────────

interface PeoplePickerProps {
  circles: ContactCircles;
  selected: Set<string>;
  readOnly?: boolean;
  onToggle(userId: string, next: boolean): void;
}

/**
 * ONE picker for both "who goes into the new group" and "who is in this one": the two are the same
 * question asked at two moments, and a second copy would be the first place the two lists diverged.
 *
 * The grouping is presentational: a circle is a per-user VIEW over accepted contacts (ADR-115 §6),
 * so it orders a long list and nothing more. A contact who is in no circle still has to be
 * pickable: "Other contacts" is that bucket, and it is why this cannot simply iterate `circles`.
 */
function PeoplePicker({ circles, selected, readOnly, onToggle }: PeoplePickerProps) {
  const { slots } = useMessengerUi();
  const t = useT();
  const { PersonChip } = slots;

  const sections = useMemo(() => {
    const byId = new Map(circles.contacts.map((c) => [c.userId, c]));
    const placed = new Set<string>();
    const out: Array<{ id: string; name: string; people: Contact[] }> = [];
    for (const circle of circles.circles) {
      const people = circle.members.map((m) => byId.get(m.userId)).filter((c): c is Contact => !!c);
      if (people.length === 0) continue;
      for (const p of people) placed.add(p.userId);
      out.push({ id: circle.id, name: circle.virtual ? t('circles.family') : circle.name, people });
    }
    const rest = circles.contacts.filter((c) => !placed.has(c.userId));
    if (rest.length > 0) out.push({ id: '_rest', name: t('groups.otherContacts'), people: rest });
    return out;
  }, [circles.circles, circles.contacts, t]);

  if (circles.contacts.length === 0) {
    return <p className="groupman__empty">{t('groups.noContacts')}</p>;
  }

  return (
    <div className="groupman__pool">
      {sections.map((s) => (
        <div key={s.id} className="groupman__pool-sec" data-circle-id={s.id}>
          <h4 className="groupman__pool-h">{s.name}</h4>
          <div className="groupman__people">
            {s.people.map((c) => {
              const inGroup = selected.has(c.userId);
              return (
                <button
                  key={c.userId}
                  type="button"
                  className={`groupman__person${inGroup ? ' is-in' : ''}`}
                  data-user-id={c.userId}
                  aria-pressed={inGroup}
                  disabled={readOnly}
                  onClick={() => onToggle(c.userId, !inGroup)}
                >
                  <PersonChip name={c.displayName} avatarUrl={c.avatarUrl} kind="HUMAN" label={c.displayName} />
                  <span className="groupman__person-name">{c.displayName}</span>
                  <span aria-hidden className="groupman__person-tick">
                    {inGroup ? '✓' : '+'}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
