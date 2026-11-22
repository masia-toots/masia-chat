/**
 * ChannelBank — who you are talking to, as ONE strip of channel chips.
 *
 * Founder 2026-07-20: «Там буде вибір контактів та груп… вибір контактів як банк каналів усередині
 * інтеркома.» Founder 2026-11-03 (plan chat-public-polish Ф2.4): «один суцільний рядок-стрічка», no sections.
 *
 * ## Why a channel selector and not a contact list
 *
 * Every intercom that has ever existed picks its destination the same way: a BANK of labelled,
 * lit buttons — one per channel — always visible, never a menu. That is not decoration, it is what
 * the object is for: you must be able to see, without acting, which channels exist and which one is
 * live. A dropdown hides exactly that, and a chat sidebar spends a whole column on it.
 *
 * So each contact is a CHIP: a face and nothing else — no chip draws a name, the active one included (founder 2026-11-03,
 * Ф2.8b-A: «слово мася між фішками — то не треба»; who the chat is with is the composer's placeholder). The name stays as
 * the button's accessible name and its `title` (hover). Lit = selected.
 *
 * ## ONE strip (Ф2.4 — SUPERSEDES the 2026-09-03 two sections, the 2026-10-07 `live │ pinned │ recent` row and the
 * 2026-10-14 doors/seat)
 *
 * The row is ONE continuous scroller (`HScroll`) with an edge fade; its order is `bankStrip` (the model — ONE pure
 * function the unit test falsifies): `[active] · [Masia] · [family] · [pinned…] · [recent…]`, then — behind a thin amber
 * tick and a tiny caps header «ІНША РОДИНА · <name>» — each OTHER family's people (polishing П16, founder 2026-11-08; no
 * badge on the chips themselves, and the active chip stays first even when it is one of them). There is NO hairline
 * between pinned and recent, no separate pinned block, no door, no bell and no conversation picker in the row:
 *   · the conversations of a contact, the people/groups/requests panels and everything else that used to stand as a
 *     door live in the header's `⋯` menu (tabs «Чати» · «Люди» · «Де» · «Дії»);
 *   · a strip that does not fit simply scrolls — at every width, so a 274 px bank on a phone needs no folding rules.
 * The arrow (`›`) is for a fine pointer only: it appears on hover, in a gutter BESIDE the last visible chip, never on it.
 *
 * Seat order is the OWNER's contract (`bankStrip`, canon §12.1); the bank renders it and tells nobody anything about
 * who is where except through `onSelect`.
 *
 * ## What it deliberately does not do
 *
 * No counts beyond «there is something», no search. If the bank ever grows past what fits, that is a signal to group
 * channels, not to add a filter box: a selector you have to search is a menu wearing a costume (the full list, with
 * search, is one tap away in `⋯` → «Чати» / «Люди»).
 *
 * Data comes from `buildContacts` — the SAME list the Messenger's nav builds. The bank is the ONLY
 * contact strip in the product, so «who exists» has one home.
 *
 * ## The face of a chip is a slot
 *
 * By default a chip wears the person's face (the `PersonChip` slot). A host may put something else
 * on a contact's chip through `renderFace` (the Masia hub puts its assistant's docked stone on the
 * assistant's chip); the bank only guarantees the chip, the berth's box, and the live mark around it.
 */
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { bankStrip, stripSegments, stripWindow, type MessengerContact } from '../../contacts/contact-model.js';
import { useIcon, useMessengerUi, useT } from '../provider/messenger-ui.js';
import './channel-bank.css';

/** The chip's number stops at two digits: a corner badge is a signal, not a counter. */
const CHIP_UNREAD_CAP = 99;

/**
 * What a chip's corner badge says (ADR-201 Г2 A) — a pure reading of the host's numbers, the one place the rule lives:
 *  · not muted: the unread number (`99+` past the cap), ACCENTED when some of it calls me by name;
 *  · muted: 🔇 — alone (a quiet dot) when nothing calls me, beside the accented MENTION number when something does;
 *  · nothing unread: no badge at all (a muted room says so in the open chat's header, not on every chip).
 */
export interface ChipAttention {
  /** The digits drawn, or `null` for the muted dot. */
  readonly text: string | null;
  readonly mention: boolean;
  readonly muted: boolean;
}

export function chipAttention(c: Pick<MessengerContact, 'unread' | 'unreadMentions' | 'muted'>): ChipAttention | null {
  const unread = c.unread ?? 0;
  const mentions = Math.min(c.unreadMentions ?? 0, unread);
  if (unread <= 0) return null;
  const digits = (n: number) => (n > CHIP_UNREAD_CAP ? `${CHIP_UNREAD_CAP}+` : String(n));
  if (c.muted) return { text: mentions > 0 ? digits(mentions) : null, mention: mentions > 0, muted: true };
  return { text: digits(unread), mention: mentions > 0, muted: false };
}

/** What a host draws on one contact's chip in place of the default face. */
export interface ChannelBankFace {
  /** Attributes for the face's box (the berth), e.g. a host anchor the face is parented into. */
  readonly berth?: Readonly<Record<`data-${string}`, string>>;
  readonly node: ReactNode;
}

export interface ChannelBankProps {
  /**
   * The channels, built by the OWNER from the same members+inbox load the Messenger does. The bank
   * used to fetch its own, so the two surfaces could disagree about who exists. A view that fetches
   * its own data is a second source of truth wearing a component's name.
   */
  contacts: readonly MessengerContact[];
  /** The channel currently open — seat 1 of the strip, the one chip that is lit. */
  activeKey?: string;
  /** Contact keys, most recent first — the order of the strip's tail (`recencySnapshot` + the local taps). */
  recency?: readonly string[];
  /**
   * The route keys of the contacts the user PINNED, oldest pin first. The owner's own fixed seats
   * (the assistant, the family) are seated without being listed here. Everyone else is the recency tail,
   * rendered in a lazily-growing window.
   */
  pinnedKeys?: readonly string[];
  onSelect(contact: MessengerContact): void;
  /** The demo runs the same bank with channels LOCKED rather than hidden (canon §20C-3): it must
   *  teach the real product, and a control that is absent teaches that it does not exist. */
  lockedKeys?: readonly string[];
  onLockedSelect?(contact: MessengerContact): void;
  /** Replaces a contact's default face; `null` keeps the default. */
  renderFace?(contact: MessengerContact): ChannelBankFace | null;
}

export function ChannelBank({
  contacts,
  activeKey,
  recency,
  pinnedKeys,
  onSelect,
  lockedKeys = [],
  onLockedSelect,
  renderFace,
}: ChannelBankProps) {
  const ui = useMessengerUi();
  const { slots, env, themeStyle } = ui;
  const { HScroll, PersonChip } = slots;
  const t = useT();
  const icon = useIcon();

  // ── THE LAZY WINDOW (К4, founder 2026-10-07) on the scroller slot (Ш3, 2026-10-09) ──
  // The whole strip is already in memory, so «lazy» is RENDERING: the fixed head (active · Masia · family · pins) is
  // always whole, the recency tail is a window of `win` chips, grown by the host's `bankWindow.grow` when an end-of-strip
  // sentinel scrolls into the scroller's own viewport (a CONTAINER scroll — never the document). The arrow, the wheel and
  // the edge fade are the scroller slot's (ONE owner — the holo tab strip runs the same component); the bank only tells
  // it that more exists beyond the rendered window (`endMore`) and hands over the scroller as the sentinel's root.
  const viewportRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLSpanElement>(null);
  const [win, setWin] = useState(env.bankWindow.initial);
  const strip = useMemo(
    () => bankStrip({ contacts, activeKey, recency, pinnedKeys }),
    [contacts, activeKey, recency, pinnedKeys],
  );
  const shown = stripWindow(strip, win);
  const tailTotal = strip.chips.length - strip.fixed;
  const hasMore = shown.length < strip.chips.length;
  // Read through a ref so a host that passes a fresh `grow` each render does not re-arm the observer.
  const growRef = useRef(env.bankWindow.grow);
  growRef.current = env.bankWindow.grow;
  useEffect(() => {
    const root = viewportRef.current;
    const sentinel = sentinelRef.current;
    if (!root || !sentinel || !hasMore || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setWin((w) => growRef.current(w, tailTotal));
      },
      { root, rootMargin: '0px 160px 0px 0px' },
    );
    io.observe(sentinel);
    return () => io.disconnect();
    // Re-armed after every growth: a sentinel that is STILL in view (a wide strip) fires again.
  }, [hasMore, shown.length, tailTotal]);

  if (!contacts.length) return null;

  // A TOOLBAR, not a tablist: these are channel buttons that switch a conversation, not tabs that reveal a panel, and
  // the demo renders some of them LOCKED (a disabled tab in a tablist is a different contract).
  const renderChip = (c: MessengerContact) => {
    const locked = lockedKeys.includes(c.key);
    const live = c.key === activeKey;
    const face = renderFace?.(c) ?? null;
    const waits = locked ? null : chipAttention(c);
    // The badge in words, for the accessible name (the badge itself is a picture of these words, so it is hidden).
    const waitsSaid = !waits ? '' : [
      waits.muted ? t('bank.muted') : t('bank.unread', { count: c.unread ?? 0 }),
      waits.mention ? t('bank.unreadMentions', { count: c.unreadMentions ?? 0 }) : '',
    ].filter(Boolean).join(', ');
    return (
      <button
        key={c.key}
        type="button"
        aria-current={live ? 'true' : undefined}
        /* WHAT THIS SEAT IS, published for the guard: a row of identical `.chbank__plate` buttons gives a harness no
           way to assert that Masia is where the strip says she is. One attribute, read only by the harnesses; the CSS
           keys off nothing here. */
        data-kind={c.kind}
        className={`chbank__plate${live ? ' is-live' : ''}${locked ? ' is-locked' : ''}${waits ? ' has-unread' : ''}`}
        onClick={() => {
          if (locked) {
            onLockedSelect?.(c);
            return;
          }
          // The chip's click is just the selection: whatever else «is she seated here» means is
          // derived by the host from which channel is open (a second write from the click would be
          // the two-homes drift canon §7 exists to stop).
          onSelect(c);
        }}
        title={locked ? t('bank.lockedChannel') : c.name}
      >
        <span className="chbank__lamp" aria-hidden="true" />
        {/* The chip is the person's own face (founder 2026-07-21: «зроби юзер фішки замість імен контактів»). The name is
            drawn on NO chip (Ф2.8b-A, 2026-11-03: «слово мася між фішками — то не треба» — it supersedes Ф2.4's «активний
            чіп — аватар + ім'я»); `.chbank__name` below is the accessible name (visually hidden), so a screen reader still
            reads a strip of people, and `title` says it on hover.
            A host face (`renderFace`) is a BERTH: the host parents its own node into the box, so the box is reserved
            whether or not it has arrived (§12: a reserved seat that collapses when empty is not reserved). */}
        <span className="chbank__chip" aria-hidden="true" {...face?.berth}>
          {face ? (
            face.node
          ) : (
            <PersonChip
              name={c.name}
              avatarUrl={c.avatarUrl}
              kind={c.kind === 'GROUP' || c.kind === 'FAMILY' ? 'GROUP' : 'HUMAN'}
              label={c.name}
            />
          )}
        </span>
        <span className="chbank__name">{waitsSaid ? `${c.name}, ${waitsSaid}` : c.name}</span>
        {/* ADR-201 — the corner badge rides the PLATE, never the berth: a host face is parented INTO the berth (the hub's
            live stone, or its static ghost), so a badge there would come and go with her. On the plate both forms show it,
            and it stays inside the plate's own 44 px box, so the strip's scroller clips nothing. */}
        {waits && (
          <span
            className={`chbank__unread${waits.mention ? ' chbank__unread--mention' : ''}${waits.muted ? ' chbank__unread--muted' : ''}`}
            data-unread={waits.text ?? 'muted'}
            aria-hidden="true"
          >
            {waits.muted && icon('muted', 10, 'chbank__unread-mute')}
            {waits.text !== null && <span className="chbank__unread-n">{waits.text}</span>}
          </span>
        )}
        {locked && icon('close', 11, 'chbank__lock')}
      </button>
    );
  };

  return (
    <div className="chbank" style={themeStyle}>
      <HScroll
        className="chbank__scroll"
        viewportClassName="chbank__strip"
        viewportRef={viewportRef}
        activeKey={activeKey ?? null}
        endMore={hasMore}
        arrowsInGutter
        role="toolbar"
        aria-label={t('bank.channels')}
        prevLabel={t('common.scrollPrev')}
        nextLabel={t('common.scrollNext')}
      >
        {/* Each OTHER family's people sit behind a delimiter (polishing П16, founder 2026-11-08): a group container named for a
            screen reader («Інша родина · Бобри»), the visible tick + header aria-hidden and not a control. The header shows
            the family's NAME alone (founder 2026-11-22: «тільки назва»); the «Інша родина» kicker appears only for a family
            the host could not name, so the tick never stands bare. The current family's own run — the head and its
            people — is drawn bare, exactly as before. The model decides who sits where (`stripSegments`); this only draws it. */}
        {stripSegments(strip, shown.length).map((seg, at) =>
          seg.family ? (
            <div
              key={`family:${seg.family.id ?? ''}`}
              role="group"
              className="chbank__family"
              aria-label={seg.family.name ? t('bank.otherFamilyNamed', { name: seg.family.name }) : t('bank.otherFamily')}
            >
              <span className="chbank__delim" aria-hidden="true">
                {seg.family.name
                  ? <span className="chbank__delim-name">{seg.family.name}</span>
                  : <span className="chbank__delim-kicker">{t('bank.otherFamily')}</span>}
              </span>
              {seg.chips.map(renderChip)}
            </div>
          ) : (
            // The bare run is always the FIRST segment (a group never precedes it), so the index is a stable key.
            <Fragment key={`own:${at}`}>{seg.chips.map(renderChip)}</Fragment>
          ),
        )}
        {hasMore && <span ref={sentinelRef} className="chbank__more" aria-hidden />}
      </HScroll>
    </div>
  );
}
