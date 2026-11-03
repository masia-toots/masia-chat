/**
 * ChannelBank — who you are talking to, as a bank of channel plates.
 *
 * Founder 2026-07-20: «Там буде вибір контактів та груп… вибір контактів як банк каналів усередині
 * інтеркома.»
 *
 * ## Why a channel selector and not a contact list
 *
 * Every intercom that has ever existed picks its destination the same way: a BANK of labelled,
 * lit buttons — one per channel — always visible, never a menu. That is not decoration, it is what
 * the object is for: you must be able to see, without acting, which channels exist and which one is
 * live. A dropdown hides exactly that, and a chat sidebar spends a whole column on it.
 *
 * So each contact is a PLATE: a face, a lamp, and nothing else. Lit = selected. The bank scrolls
 * horizontally on a phone and wraps on a desktop; either way it stays a row of equipment rather than
 * a list of people, which is the difference between «choose a channel» and «browse your contacts».
 *
 * ## Since the host's chat canon §12 (2026-07-23) the bank IS the header row
 *
 * The bank no longer stands beside the conversation as a rail — it lives INSIDE the chat header,
 * which is one line: `[○][○][○] │ ‹  📁 <current>  ⋯`. Two rows saying "who am I talking to" (the
 * header's portrait and the bank's own `.is-live` plate) became one, and the rail's width went back
 * to the conversation. SEAT ORDER is the owner's business — the bank renders the list it is given,
 * in the order it is given (see `seatContacts`, §12.1).
 *
 * ## What it deliberately does not do
 *
 * No avatars-as-identity (the plate's LABEL is the identity — that is how ship equipment names
 * things), no counts beyond «there is something», no search. If the bank ever grows past what fits,
 * that is a signal to group channels, not to add a filter box: a selector you have to search is a
 * menu wearing a costume.
 *
 * Data comes from `buildContacts` — the SAME list the Messenger's nav builds. The bank is the ONLY
 * contact list in the product, so «who exists» has one home.
 *
 * ## The face of a plate is a slot
 *
 * By default a plate wears the person's chip (the `PersonChip` slot). A host may put something else
 * on a contact's plate through `renderFace` (the Masia hub puts its assistant's docked stone on the
 * assistant's plate); the bank only guarantees the plate, the berth's box, and the live mark around it.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { bankSections, recentWindow, type MessengerContact } from '../../contacts/contact-model.js';
import { useIcon, useMessengerUi, useT } from '../provider/messenger-ui.js';
import { convPickerRows, type ConvPickerProps } from './conv-picker.js';
import './channel-bank.css';

/** What a host draws on one contact's plate in place of the default chip. */
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
  /** The channel currently open. */
  activeKey?: string;
  onSelect(contact: MessengerContact): void;
  /** The demo runs the same bank with channels LOCKED rather than hidden (canon §20C-3): it must
   *  teach the real product, and a control that is absent teaches that it does not exist. */
  lockedKeys?: readonly string[];
  onLockedSelect?(contact: MessengerContact): void;
  /**
   * =4 (founder 2026-08-02, «вузький інтерком-борт»): fires when the row's content stops/starts
   * fitting its box (the bank itself already scrolls — this only REPORTS the state). The owner uses
   * it to fold its header controls into the `⋯` menu when the family outgrows the width.
   */
  onOverflowChange?(overflowing: boolean): void;
  /**
   * THE CONVERSATION PICKER OF THE LIVE CONTACT (founder 2026-09-01). It sits right after seat 1 and
   * IS the divider between the live channel and the rest of the row — the axis «which conversation
   * with this person» lives here. Absent → no picker (a contact with no chat yet, a demo).
   */
  convPicker?: ConvPickerProps;
  /**
   * К8a (2026-10-07): fires when the row is too narrow to seat the picker chip and the bank's
   * container query folds it away (`channel-bank.css` § WHAT FOLDS). The owner then offers the SAME
   * rows (`convPickerRows`) in its header `⋯` menu, so the axis is never unreachable.
   */
  onConvsFoldChange?(folded: boolean): void;
  /** THE door at the END of the row, outside the scroller («People»: circles · groups · requests as tabs). */
  peopleSlot?: ReactNode;
  /**
   * A SEAT the host keeps in the row at every width: it sits after the pinned plates and, unlike the doors, never folds
   * (a door is a shortcut to something `⋯` also offers; a seat is a plate the host decided must stay one tap away —
   * the hub's on-call icon, founder 2026-10-14). It is one fixed box, so a crowded row gives up recent plates first.
   */
  seatSlot?: ReactNode;
  /**
   * The route keys of the contacts the user PINNED, oldest pin first. The owner's own pinned seats
   * (the assistant, the family) are pinned without being listed here. Everyone not pinned is RECENT,
   * rendered in a lazily-growing window.
   */
  pinnedKeys?: readonly string[];
  /** Replaces a contact's default chip; `null` keeps the default. */
  renderFace?(contact: MessengerContact): ChannelBankFace | null;
}

export function ChannelBank({
  contacts,
  activeKey,
  onSelect,
  lockedKeys = [],
  onLockedSelect,
  onOverflowChange,
  onConvsFoldChange,
  convPicker,
  peopleSlot,
  seatSlot,
  pinnedKeys,
  renderFace,
}: ChannelBankProps) {
  const ui = useMessengerUi();
  const { slots, env, themeStyle } = ui;
  const { Menu, HScroll, PersonChip } = slots;
  const t = useT();
  const icon = useIcon();
  const [convsOpen, setConvsOpen] = useState(false);
  const convsRef = useRef<HTMLButtonElement>(null);
  const hasPickerItems = !!convPicker?.items.length; // re-measure the fold when the chip mounts
  // ── =4 OVERFLOW DETECTION (founder 2026-08-02): the bank has always scrolled («лісталка» is the
  // 2026-07-23 §12 behavior) — what was missing is (a) telling the OWNER the family stopped fitting
  // (so it can fold its controls into `⋯`) and (b) telling the READER there is more to the right
  // (the fade and arrows are the scroller slot's, Ш3 2026-10-09). One ResizeObserver answers the report. ──
  //
  // ⚠️ =9 (founder 2026-08-02 «меню відкривається та починає блимати»): the report FEEDS BACK into
  // this very measurement — the owner reacts by HIDING its header controls, the bank (flex 1) gets
  // their width, stops overflowing, the controls return, the bank shrinks, overflows again… an
  // OSCILLATION that mounted/unmounted the menu targets every frame (the founder's blinking menus).
  // The latch is therefore ASYMMETRIC: fold the moment content stops fitting, but UNFOLD only when
  // there is enough slack to seat the folded controls back (≥ UNFOLD_SLACK_PX) — the state that
  // changes the layout can never be immediately contradicted by the layout it produces.
  const UNFOLD_SLACK_PX = 180; // ≈ the space-switch chip + `⋯` + gaps, with margin
  const bankRef = useRef<HTMLDivElement>(null);
  const overflowRef = useRef<boolean | null>(null);
  const reportRef = useRef(onOverflowChange);
  reportRef.current = onOverflowChange;
  const convsFoldRef = useRef<boolean | null>(null);
  const reportConvsFold = useRef(onConvsFoldChange);
  reportConvsFold.current = onConvsFoldChange;
  useEffect(() => {
    const el = bankRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const measure = (): void => {
      // The FOLD report carries the asymmetric latch so it can't oscillate (=9). Since К4 the row's
      // FIXED part (live · picker · pinned · doors) is what can fail to fit — the recent scroller
      // shrinks to whatever is left and never overflows the bank — so this is `chbank` itself
      // (`overflow: hidden`, `scrollWidth` still honest).
      const overflowing =
        overflowRef.current === true
          ? el.scrollWidth > el.clientWidth - UNFOLD_SLACK_PX // folded: stay folded until real room
          : el.scrollWidth > el.clientWidth + 4; // unfolded: fold on genuine overflow
      if (overflowRef.current !== overflowing) {
        overflowRef.current = overflowing;
        reportRef.current?.(overflowing);
      }
      // К8a — WHAT FOLDS is the bank's own container query (CSS is the one owner of the widths);
      // this only READS the outcome, so the owner can seat the same rows in `⋯`. A chip that is
      // absent (no live conversation list) is not «folded».
      const chip = convsRef.current;
      const convsFolded = !!chip && getComputedStyle(chip).display === 'none';
      if (convsFoldRef.current !== convsFolded) {
        convsFoldRef.current = convsFolded;
        reportConvsFold.current?.(convsFolded);
      }
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [contacts.length, hasPickerItems]);

  // ── THE RECENT SCROLLER: lazy window (К4, founder 2026-10-07) on the scroller slot (Ш3, 2026-10-09) ──
  // The recent list is already in memory, so «lazy» is RENDERING: a window of `win` plates, grown
  // by the host's `bankWindow.grow` when an end-of-row sentinel scrolls into the scroller's own
  // viewport (a CONTAINER scroll — never the document). The arrows, the wheel and the edge fade are
  // the scroller slot's (ONE owner — the holo tab strip runs the same component); the bank only tells
  // it that more exists beyond the rendered window (`endMore`) and hands over the scroller as the
  // sentinel's root.
  const recentRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLSpanElement>(null);
  const [win, setWin] = useState(env.bankWindow.initial);
  const { live: liveContact, pinned, recent } = bankSections(contacts, activeKey, pinnedKeys);
  const visibleRecent = recentWindow(recent, win);
  const hasMore = visibleRecent.length < recent.length;
  const recentTotal = recent.length;
  // Read through a ref so a host that passes a fresh `grow` each render does not re-arm the observer.
  const growRef = useRef(env.bankWindow.grow);
  growRef.current = env.bankWindow.grow;
  useEffect(() => {
    const root = recentRef.current;
    const sentinel = sentinelRef.current;
    if (!root || !sentinel || !hasMore || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setWin((w) => growRef.current(w, recentTotal));
      },
      { root, rootMargin: '0px 160px 0px 0px' },
    );
    io.observe(sentinel);
    return () => io.disconnect();
    // Re-armed after every growth: a sentinel that is STILL in view (a wide row) fires again.
  }, [hasMore, visibleRecent.length, recentTotal]);

  if (!contacts.length) return null;

  // A TOOLBAR, not a tablist. §12 (2026-07-23) put the row's ONE title between seat 1 and the rest
  // — a `titleSlot` that could hold a button (the back chevron / the P2P chats switcher), which a
  // tablist may not contain. The 2026-08-09 head pass moved that name (and back) OUT to the head's
  // own control cluster, so the bank is plates again — but `toolbar` STAYS: these are channel
  // buttons that switch a conversation, not tabs that reveal a panel, and the demo renders some of
  // them LOCKED (a disabled tab in a tablist is a different contract).
  const renderPlate = (c: MessengerContact) => {
    const locked = lockedKeys.includes(c.key);
    const live = c.key === activeKey;
    const face = renderFace?.(c) ?? null;
    return (
      <button
        key={c.key}
        type="button"
        aria-current={live ? 'true' : undefined}
        /* WHAT THIS SEAT IS, published for the guard (2026-09-03). The two sections are
           structural — a group may never appear among the people — and a row of identical
           `.chbank__plate` buttons gives a harness no way to assert that. One attribute, read
           only by `check-bank-sections.mjs`; the CSS keys off nothing here. */
        data-kind={c.kind}
        className={`chbank__plate${live ? ' is-live' : ''}${locked ? ' is-locked' : ''}`}
        onClick={() => {
          if (locked) {
            onLockedSelect?.(c);
            return;
          }
          // The plate's click is just the selection: whatever else «is she seated here» means is
          // derived by the host from which channel is open (a second write from the click would be
          // the two-homes drift canon §7 exists to stop).
          onSelect(c);
        }}
        title={locked ? t('bank.lockedChannel') : c.name}
      >
        <span className="chbank__lamp" aria-hidden="true" />
        {/* The plate is the person's own face (founder 2026-07-21: «зроби юзер фішки замість імен
            контактів»). Since §12 the stencilled NAME is gone from every plate at every width — the
            ONE name in the row is the header's, not a copy per plate. The label survives as the
            plate's accessible name (visually hidden) so a screen reader still reads a row of people.
            A host face (`renderFace`) is a BERTH: the host parents its own node into the box, so the
            box is reserved whether or not it has arrived (§12: a reserved seat that collapses when
            empty is not reserved). */}
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
        <span className="chbank__name">{c.name}</span>
        {locked && icon('close', 11, 'chbank__lock')}
      </button>
    );
  };

  // ROW ORDER (founder 2026-10-07, plan icom-player-contacts К4 — supersedes the 2026-09-03 two
  // sections and their N+M limits):
  //   [live][its conversations] │ [pinned 📌…] │ [recent people AND groups ⟶] [doors]
  // `contacts` arrives already SEATED (§12.1: live first, the rest by recency); the split into
  // pinned / recent is `bankSections`' business (computed above, beside the hooks that need it) —
  // ONE pure function the unit test can falsify. The live channel is seat 1 whatever it is and is
  // absent from both lists. Only the RECENT list scrolls (a window that grows lazily); the pinned
  // seats and the doors are fixed, so the doors can never be pushed out of the row (it overflowed
  // 408 vs 355 on a phone before).
  const picker = liveContact && convPicker && convPicker.items.length > 0 ? convPicker : undefined;
  const currentItem = picker?.items.find((i) => i.current);
  const scrollPrev = t('common.scrollPrev');
  const scrollNext = t('common.scrollNext');

  return (
    <div
      ref={bankRef}
      className="chbank"
      style={themeStyle}
      role="toolbar"
      aria-orientation="horizontal"
      aria-label={t('bank.channels')}
    >
      {liveContact && renderPlate(liveContact)}
      {picker && (
        <>
          {/* The chip = the current conversation's glyph + how many there are + a caret. It is a
              DIVIDER too (CSS: a hairline on its right) — the row reads «this person, their
              conversations │ everyone else». Its list is the host's menu (К8a: one console menu like
              every other intercom `⋯`). Too narrow a row folds the chip away (container query) and
              the owner seats the same rows in `⋯` → «where». */}
          <button
            ref={convsRef}
            type="button"
            className={`chbank__convs${convsOpen ? ' is-open' : ''}`}
            aria-haspopup="true"
            aria-expanded={convsOpen}
            aria-label={picker.title}
            title={picker.title}
            onClick={() => setConvsOpen((o) => !o)}
          >
            {icon(currentItem?.glyph ?? 'chat', undefined, 'chbank__ic chbank__convs-glyph')}
            <span className="chbank__convs-count">{picker.items.length}</span>
            {icon('chevron', undefined, 'chbank__ic chbank__convs-caret')}
          </button>
          <Menu
            name="convs"
            open={convsOpen}
            onClose={() => setConvsOpen(false)}
            anchorRef={convsRef}
            label={picker.title}
            closeLabel={t('common.close')}
            sections={[{ id: 'convs', title: picker.title, rows: convPickerRows(picker, ui) }]}
          />
        </>
      )}
      {/* К8a: a crowded pin set scrolls inside its own box — the scroller says so with the fade and the
          arrows instead of a plate cut in half by the box edge (390 px, 2026-10-07: the second pin
          showed 0 of 44 px). */}
      <HScroll
        className="chbank__scroll chbank__scroll--pinned"
        viewportClassName="chbank__pinned"
        viewportRef={pinnedRef}
        role="group"
        aria-label={t('bank.pinned')}
        prevLabel={scrollPrev}
        nextLabel={scrollNext}
      >
        {pinned.map(renderPlate)}
      </HScroll>
      {seatSlot && <div className="chbank__seat">{seatSlot}</div>}
      {/* THE SEAM (founder 2026-09-03, kept): a hairline between the pinned seats and the recent
          scroller. Nothing is labelled — a hairline is the whole statement. */}
      {recent.length > 0 && <span className="chbank__sep" aria-hidden />}
      <HScroll
        className="chbank__scroll chbank__scroll--recent"
        viewportClassName="chbank__recent"
        viewportRef={recentRef}
        endMore={hasMore}
        role="group"
        aria-label={t('bank.recent')}
        prevLabel={scrollPrev}
        nextLabel={scrollNext}
      >
        {visibleRecent.map(renderPlate)}
        {hasMore && <span ref={sentinelRef} className="chbank__more" aria-hidden />}
      </HScroll>
      {/* THE DOOR stands OUTSIDE the scroller, at the row's end: «People». */}
      {peopleSlot && <div className="chbank__doors">{peopleSlot}</div>}
    </div>
  );
}
