/**
 * PeoplePanel: the "People" tab of the contacts menu (plan `player-wide-holo-tabs-people`, Ш5;
 * founder 2026-10-08: «керування колами і групами злити в одну іконку в стилі і один UI з табами —
 * там пошук контактів, створення кіл та груп і тд»; Г3 = A).
 *
 * It is what "Circles" and "Search" used to be, folded into ONE body:
 *
 *   [ search: name or @tag                 ]  <- my own contacts, locally, AND (>= 2 chars) new people
 *   [ All ][ Family ][ Friends ]...[ + circle ]  <- circles as filter chips; a custom circle's ... edits it
 *   - Mine / In this circle / Other contacts  <- a row = [open chat] [star: pin] [tick/plus: in this circle]
 *   - New, by @tag                            <- only while searching: "Send request"
 *
 * Nothing new is stored or fetched here: circles, memberships, pins and the `@tag` search are the
 * `useContactCircles` hook's, called exactly as the two panels called them.
 *
 * ## The two rules this component does NOT get to bend
 *
 * RED: **the home circle ("Family") is a VIEW, not a row** (ADR-115 §5). The host marks it
 * `virtual`: it is computed on every read and has no menu, because renaming or deleting it would be
 * renaming the family. The chips render in the host's own order (it puts the home circle first),
 * never re-sorted here.
 *
 * AMBER: since ADR-116 (2026-09-06) that view has a SECOND half. It is the family's own people UNION
 * the contacts I flagged as "in the home circle". So its tick appears ONLY on contacts who are not
 * family: a family member is owned by their family record, so that row stays untoggleable (the host
 * answers `CIRCLE_MEMBER_IS_FAMILY` if anyone tries). The friends the flag seats there wear a
 * "from another family" badge.
 *
 * RED: **a circle is a VIEW on accepted contacts, never a way to acquire one** (ADR-115 §6). Every
 * row under a chip comes from the contacts list, people I already have, and the ONLY door to a new
 * person is the "New, by @tag" section, which sends a REQUEST. Nothing here can put a stranger into
 * a circle; the host refuses it too (`NOT_A_CONTACT`).
 *
 * The suggested circle names (Friends, Study, Work, General) are chips on the create form, not
 * seeded rows (ADR-115 Г6A): a suggestion costs nothing and leaves no dead rows in anybody's data.
 *
 * ## The star replaces "Pin contact..."
 *
 * The bank's pinned seats are the host's pinned contacts. A family member's pin is a pure
 * preference; a contact from another family IS their pin (the acceptance record), so that star is
 * shown ON and inert, never offered as "unpin" (it would delete the contact; `setPinned` refuses
 * it too).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, TextInput } from '@mantine/core';
import {
  CONTACT_SEARCH_DEBOUNCE_MS,
  CONTACT_SEARCH_MIN,
  splitByCircle,
  type CircleMember,
  type Contact,
  type ContactCircles,
  type UserSearchHit,
} from '../../contacts/index.js';
import { useMessengerUi, useT } from '../provider/messenger-ui.js';
import { SeedContactsEmpty } from './seed-contacts-empty.js';
import './circle-selector.css';

/** The "All" chip's id: not a circle, so it can never collide with a host id. */
export const ALL_PEOPLE_ID = 'all';

/**
 * The refusal codes of the home-circle toggle that are worth naming to the person who tapped it
 * (`CircleWriteResult.code`, ADR-116 К3b). Any other refusal gets the generic line.
 */
const HOME_CIRCLE_REFUSALS = {
  memberIsFamily: 'CIRCLE_MEMBER_IS_FAMILY',
  notAContact: 'NOT_A_CONTACT',
} as const;

/** The search text, as a tag query: no leading `@`, trimmed. */
const tagQuery = (q: string): string => q.trim().replace(/^@/, '');

/** Does this person match the text? Name or @tag, case-insensitive; empty text matches everyone. */
export function matchesPerson(p: { displayName: string; username?: string | null }, q: string): boolean {
  const needle = tagQuery(q).toLowerCase();
  if (!needle) return true;
  return p.displayName.toLowerCase().includes(needle) || (p.username ?? '').toLowerCase().includes(needle);
}

/** What a row shows: the fields a circle seat (`CircleMember`) and an accepted contact share. */
type RowPerson = Pick<CircleMember, 'userId' | 'displayName' | 'avatarUrl' | 'username'>;

export interface PeoplePanelProps {
  /** The one data owner (`useContactCircles`), lifted by the page. */
  data: ContactCircles;
  /** Open the chat with this contact: the SAME `selectContact` the plates use. */
  onOpenContact(userId: string): void;
  /** Focus the search field on mount. Desktop only (a phone keyboard must be asked for). */
  autoFocusSearch?: boolean;
}

export function PeoplePanel({ data, onOpenContact, autoFocusSearch = true }: PeoplePanelProps) {
  const { themeStyle, env } = useMessengerUi();
  const t = useT();
  const { circles, contacts } = data;

  const [q, setQ] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!autoFocusSearch) return;
    const phone = typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia(env.phoneQuery).matches;
    if (phone) return;
    // after the menu's own initial focus (a 0 ms timer), or it would take the focus back
    const id = window.setTimeout(() => searchRef.current?.focus(), 60);
    return () => window.clearTimeout(id);
  }, [autoFocusSearch, env.phoneQuery]);

  // The chip in view. Resolved, not stored: a circle can be deleted under us, and a `useState`
  // seeded from a prop is this lane's §6 trap.
  const [pickedId, setPickedId] = useState<string>(ALL_PEOPLE_ID);
  const active = circles.find((c) => c.id === pickedId) ?? null;
  const activeId = active ? active.id : ALL_PEOPLE_ID;
  const isHomeTab = !!active?.virtual;

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  /** ADR-115 Г6A: SUGGESTIONS on the create form, never seeded rows. */
  const suggestions = [
    t('circles.suggestFriends'),
    t('circles.suggestStudy'),
    t('circles.suggestWork'),
    t('circles.suggestGeneral'),
  ].filter((s) => !circles.some((c) => c.name.toLowerCase() === s.toLowerCase()));

  const byId = useMemo(() => new Map(contacts.map((c) => [c.userId, c])), [contacts]);

  /** К8a: the ONE partition. `inside` IS `active.members` (the chip's own count), `outside` every
   *  other accepted contact. */
  const { inside, outside } = useMemo(() => splitByCircle(active?.members ?? [], contacts), [active, contacts]);

  const mine = useMemo(() => contacts.filter((c) => matchesPerson(c, q)), [contacts, q]);
  const insideShown = useMemo(() => inside.filter((m) => matchesPerson(m, q)), [inside, q]);
  const outsideShown = useMemo(() => outside.filter((c) => matchesPerson(c, q)), [outside, q]);

  /** Who the "Mine"/circle lists already show: a search hit that is one of them is not repeated. */
  const shownIds = useMemo(
    () => new Set((active ? [...insideShown, ...outsideShown] : mine).map((p) => p.userId)),
    [active, insideShown, outsideShown, mine],
  );

  /**
   * ONE toggle handler for both kinds of circle. The branch is about WHERE the state lives (a
   * membership row vs the contact's flag), and the hook owns the writes. Only the home circle can
   * refuse in a way worth naming, so only it reads the code back.
   */
  const toggleMembership = async (userId: string, next: boolean) => {
    if (!active) return;
    if (!isHomeTab) {
      await data.setMembership(active.id, userId, next);
      return;
    }
    const res = await data.setInHomeCircle(userId, next);
    if (res.ok) return;
    env.notifyError(
      res.code === HOME_CIRCLE_REFUSALS.memberIsFamily
        ? t('circles.errMemberIsFamily')
        : res.code === HOME_CIRCLE_REFUSALS.notAContact
          ? t('circles.errNotAContact')
          : t('circles.errToggleFailed'),
    );
  };

  const submitCreate = async () => {
    const name = newName.trim();
    if (!name) return;
    const ok = await data.createCircle(name);
    if (ok) {
      setNewName('');
      setCreating(false);
    }
  };

  const submitRename = async () => {
    if (!renamingId) return;
    const name = renameValue.trim();
    if (!name) return;
    const ok = await data.renameCircle(renamingId, name);
    if (ok) {
      setRenamingId(null);
      setRenameValue('');
    }
  };

  const open = (userId: string) => () => onOpenContact(userId);
  const row = (p: RowPerson, opts: { inCircle: boolean; toggleable: boolean; external?: boolean }) => (
    <PersonRow
      key={p.userId}
      person={p}
      contact={byId.get(p.userId)}
      inCircle={opts.inCircle}
      toggleable={opts.toggleable}
      external={opts.external}
      onOpen={open(p.userId)}
      onPin={(c) => {
        void data.setPinned(c, !c.isPinned);
      }}
      onToggle={(next) => {
        void toggleMembership(p.userId, next);
      }}
    />
  );

  const chipLabel = (virtual: boolean, name: string) => (virtual ? t('circles.family') : name);

  return (
    <div className="circlesel peoplesel" data-panel="people" style={themeStyle}>
      {/* 1. ONE SEARCH: my contacts (here, instantly) and new people (@tag, below) */}
      <TextInput
        ref={searchRef}
        size="xs"
        value={q}
        onChange={(e) => setQ(e.currentTarget.value)}
        placeholder={t('contacts.searchPlaceholder')}
        aria-label={t('contacts.searchLabel')}
        data-testid="people-search"
        autoComplete="off"
        enterKeyHint="search"
      />

      {/* 2. CIRCLES AS FILTER CHIPS */}
      <section className="circlesel__sec" data-sec="circles">
        <div className="circlesel__tabs" role="tablist" aria-label={t('circles.title')}>
          <span className={`circlesel__tab-wrap${activeId === ALL_PEOPLE_ID ? ' is-live' : ''}`}>
            <button
              type="button"
              role="tab"
              aria-selected={activeId === ALL_PEOPLE_ID}
              data-circle-id={ALL_PEOPLE_ID}
              className="circlesel__tab"
              onClick={() => {
                setPickedId(ALL_PEOPLE_ID);
                setRenamingId(null);
              }}
            >
              {t('contacts.all')}
              <span className="circlesel__tab-n">{contacts.length}</span>
            </button>
          </span>
          {circles.map((c) => {
            const live = c.id === activeId;
            return (
              <span key={c.id} className={`circlesel__tab-wrap${live ? ' is-live' : ''}`}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={live}
                  data-circle-id={c.id}
                  data-virtual={c.virtual ? 'true' : undefined}
                  className="circlesel__tab"
                  onClick={() => {
                    setPickedId(c.id);
                    setRenamingId(null);
                  }}
                >
                  {chipLabel(c.virtual, c.name)}
                  <span className="circlesel__tab-n">{c.members.length}</span>
                </button>
                {/* ADR-115 §5: the virtual home circle has NO editor. The dots sit on the chip in
                    view and open the INLINE editor below (rename, delete), never a popup. */}
                {!c.virtual && live && (
                  <button
                    type="button"
                    className="circlesel__tab-more"
                    aria-label={t('circles.editCircle')}
                    aria-expanded={renamingId === c.id}
                    onClick={() => {
                      if (renamingId === c.id) {
                        setRenamingId(null);
                        return;
                      }
                      setRenamingId(c.id);
                      setRenameValue(c.name);
                    }}
                  >
                    ⋯
                  </button>
                )}
              </span>
            );
          })}
          <button
            type="button"
            className="circlesel__tab is-add"
            data-circle-add
            aria-expanded={creating}
            onClick={() => setCreating((v) => !v)}
          >
            {t('contacts.addCircle')}
          </button>
        </div>

        {creating && (
          <div className="circlesel__form" data-sec="create-circle">
            <TextInput
              size="xs"
              value={newName}
              onChange={(e) => setNewName(e.currentTarget.value)}
              placeholder={t('circles.namePlaceholder')}
              aria-label={t('circles.namePlaceholder')}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submitCreate();
              }}
            />
            <Button size="xs" color="cyan" disabled={!newName.trim()} onClick={() => void submitCreate()}>
              {t('common.create')}
            </Button>
            {suggestions.length > 0 && (
              <div className="circlesel__suggest">
                {suggestions.map((s) => (
                  <button key={s} type="button" className="circlesel__chip is-suggest" onClick={() => setNewName(s)}>
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {renamingId && (
          <div className="circlesel__form" data-sec="edit-circle">
            <TextInput
              size="xs"
              value={renameValue}
              aria-label={t('circles.rename')}
              onChange={(e) => setRenameValue(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submitRename();
              }}
            />
            <Button size="xs" color="cyan" disabled={!renameValue.trim()} onClick={() => void submitRename()}>
              {t('common.save')}
            </Button>
            <Button
              size="xs"
              variant="subtle"
              color="red"
              onClick={() => {
                const id = renamingId;
                setRenamingId(null);
                setPickedId(ALL_PEOPLE_ID);
                void data.deleteCircle(id);
              }}
            >
              {t('circles.delete')}
            </Button>
            <Button size="xs" variant="subtle" color="gray" onClick={() => setRenamingId(null)}>
              {t('common.cancel')}
            </Button>
          </div>
        )}
      </section>

      {/* 3. THE PEOPLE UNDER THE CHIP
          "All" -> one list, "Mine". A circle -> ONE partition (`splitByCircle`): the list under the
          heading IS the circle's `members`, so it always matches the chip's count (К8a: the badge
          said 3 while the heading listed every contact, 4); every other accepted contact follows
          under its own heading with a plus. The name opens the chat, the star pins, the tick/plus
          files into the circle: three targets, because "talk to them", "keep them in the bank" and
          "file them" are three intentions and one control that did all of them would guess wrong. */}
      {!active ? (
        <section className="circlesel__sec" data-sec="mine">
          <h3 className="circlesel__h">
            {t('contacts.mine')}
            <span className="circlesel__h-n">{mine.length}</span>
          </h3>
          {contacts.length === 0 ? (
            <SeedContactsEmpty />
          ) : mine.length === 0 ? (
            <p className="circlesel__empty">{t('contacts.noneMatch')}</p>
          ) : (
            <div className="circlesel__people" data-list="mine">
              {mine.map((c) => row(c, { inCircle: false, toggleable: false }))}
            </div>
          )}
        </section>
      ) : (
        <>
          <section className="circlesel__sec" data-sec="members">
            <h3 className="circlesel__h">{isHomeTab ? t('circles.familyMembers') : t('circles.inCircle')}</h3>
            {inside.length === 0 ? (
              <p className="circlesel__empty">
                {contacts.length === 0 ? t('contacts.noContacts') : t('circles.circleEmpty')}
              </p>
            ) : insideShown.length === 0 ? (
              <p className="circlesel__empty">{t('contacts.noneMatch')}</p>
            ) : (
              <div className="circlesel__people" data-list="inside">
                {insideShown.map((m) =>
                  row(m, {
                    inCircle: true,
                    /* A personal circle: every seat is toggleable. The home circle (ADR-116): only
                       the seats the per-user flag put there (`external`); a family member is owned
                       by their family record, so there is nothing to toggle (ADR-115 §5). The
                       host's own bit, never a guess. */
                    toggleable: isHomeTab ? m.external : !active.virtual,
                    external: isHomeTab && m.external,
                  }),
                )}
              </div>
            )}
          </section>
          {outsideShown.length > 0 && (
            <section className="circlesel__sec" data-sec="others">
              <h3 className="circlesel__h">{t('circles.notInCircle')}</h3>
              <div className="circlesel__people" data-list="outside">
                {outsideShown.map((c) =>
                  row(c, {
                    inCircle: false,
                    toggleable: isHomeTab ? !c.isPrimaryMember : !active.virtual,
                  }),
                )}
              </div>
            </section>
          )}
        </>
      )}

      {/* 4. NEW PEOPLE: the ONLY door to a stranger, and it sends a REQUEST */}
      <NewPeople data={data} q={q} shownIds={shownIds} />
    </div>
  );
}

interface PersonRowProps {
  person: RowPerson;
  /** The accepted-contact record (pin state); absent for a seat the contacts list does not carry. */
  contact: Contact | undefined;
  inCircle: boolean;
  toggleable: boolean;
  /** ADR-116: seated in the home circle by the per-user flag, not by a family record. */
  external?: boolean;
  onOpen(): void;
  onPin(contact: Contact): void;
  onToggle(next: boolean): void;
}

/** One person: [open chat] [star: pin] [tick/plus: in this circle]. */
function PersonRow({
  person,
  contact,
  inCircle,
  toggleable,
  external = false,
  onOpen,
  onPin,
  onToggle,
}: PersonRowProps) {
  const { slots } = useMessengerUi();
  const t = useT();
  const { PersonChip } = slots;
  const locked = !!contact && contact.isPinned && !contact.isPrimaryMember;
  const starLabel = locked
    ? t('contacts.pinAlways')
    : contact?.isPinned
      ? t('contacts.unpin')
      : t('contacts.pinOne');
  return (
    <span
      className={`circlesel__person${inCircle ? ' is-in' : ''}`}
      data-user-id={person.userId}
      data-external={external ? 'true' : undefined}
    >
      <button type="button" className="circlesel__person-open" onClick={onOpen} title={t('circles.openChat')}>
        <PersonChip name={person.displayName} avatarUrl={person.avatarUrl} kind="HUMAN" label={person.displayName} />
        <span className="circlesel__person-name">{person.displayName}</span>
        {person.username && <span className="circlesel__person-tag">@{person.username}</span>}
        {external && <span className="circlesel__person-badge">{t('circles.externalBadge')}</span>}
      </button>
      {contact && (
        <button
          type="button"
          className="circlesel__person-star"
          data-pin
          aria-pressed={contact.isPinned}
          aria-disabled={locked || undefined}
          aria-label={starLabel}
          title={starLabel}
          onClick={() => {
            if (!locked) onPin(contact);
          }}
        >
          {contact.isPinned ? '★' : '☆'}
        </button>
      )}
      {toggleable && (
        <button
          type="button"
          className="circlesel__person-tick"
          aria-pressed={inCircle}
          aria-label={inCircle ? t('circles.removeFromCircle') : t('circles.addToCircle')}
          onClick={() => onToggle(!inCircle)}
        >
          {inCircle ? '✓' : '+'}
        </button>
      )}
    </span>
  );
}

/**
 * "New, by @tag": the GLOBAL search. `@tag` is the account's username (ADR-115 Г7A), so this wires
 * the search the host already had. Debounced, and silent under `CONTACT_SEARCH_MIN` characters: a
 * one-letter prefix over every user on the platform is an enumeration query, not a search.
 */
function NewPeople({ data, q, shownIds }: { data: ContactCircles; q: string; shownIds: ReadonlySet<string> }) {
  const t = useT();
  const [hits, setHits] = useState<UserSearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const runId = useRef(0);
  const query = tagQuery(q);
  const enabled = query.length >= CONTACT_SEARCH_MIN;

  useEffect(() => {
    if (!enabled) {
      runId.current += 1;
      setHits([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const id = ++runId.current;
    const timer = setTimeout(() => {
      void data.searchUsers(query).then((res) => {
        // A slower earlier keystroke must never overwrite a newer answer.
        if (id !== runId.current) return;
        setHits(res);
        setSearching(false);
      });
    }, CONTACT_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `data` changes on every reload; the query is the trigger
  }, [query, enabled]);

  const known = useMemo(() => new Set(data.contacts.map((c) => c.userId)), [data.contacts]);
  const outgoing = useMemo(
    () => new Map(data.requests.outgoing.map((r) => [r.toUser.userId, r])),
    [data.requests.outgoing],
  );
  const incoming = useMemo(
    () => new Set(data.requests.incoming.map((r) => r.fromUser.userId)),
    [data.requests.incoming],
  );

  /** The states one row can be in, named once so the button and the label can never disagree. */
  const stateOf = (hit: UserSearchHit): 'contact' | 'sent' | 'waiting' | 'incoming' | 'open' => {
    if (known.has(hit.userId)) return 'contact';
    const out = outgoing.get(hit.userId);
    if (out) return out.awaitingParent ? 'waiting' : 'sent';
    if (incoming.has(hit.userId)) return 'incoming';
    return 'open';
  };

  if (!enabled) return null;
  // someone already listed under "Mine" is not offered a second time as "new"
  const fresh = hits.filter((h) => !(known.has(h.userId) && shownIds.has(h.userId)));
  return (
    <section className="circlesel__sec" data-sec="new">
      <h3 className="circlesel__h">{t('contacts.newByTag')}</h3>
      <div className="circlesel__hits">
        {searching && <p className="circlesel__empty">{t('common.loading')}</p>}
        {!searching && fresh.length === 0 && <p className="circlesel__empty">{t('circles.noHits')}</p>}
        {!searching &&
          fresh.map((hit) => {
            const state = stateOf(hit);
            return (
              <div key={hit.userId} className="circlesel__hit" data-user-id={hit.userId} data-state={state}>
                <span className="circlesel__hit-name">{hit.displayName}</span>
                <span className="circlesel__hit-tag">@{hit.username}</span>
                {state === 'open' ? (
                  <Button size="compact-xs" color="cyan" onClick={() => void data.sendRequest(hit.userId)}>
                    {t('circles.sendRequest')}
                  </Button>
                ) : (
                  <span className="circlesel__hit-state">
                    {state === 'contact' && t('circles.alreadyContact')}
                    {state === 'sent' && t('circles.requestSent')}
                    {state === 'waiting' && t('circles.awaitingParent')}
                    {state === 'incoming' && t('circles.wantsYou')}
                  </span>
                )}
              </div>
            );
          })}
      </div>
    </section>
  );
}
