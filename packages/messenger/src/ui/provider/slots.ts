/**
 * The pieces of the host's UI that the messenger draws WITH but does not own.
 *
 * Why slots and not ports: the contracts package carries no React types (a port that said
 * `ComponentType` would pull a UI framework into the one package every other package depends on),
 * so a React component the messenger needs from its host is declared HERE, as the narrowest props
 * the messenger actually passes, and the host hands its own component in through `MessengerUiProvider`.
 * Each type below is a requirement written from the messenger's side; the host's component only has
 * to accept these props (it may accept more).
 */
import type { ComponentType, ReactNode, Ref, RefObject } from 'react';
import type { BroadcastMention } from '../../protocol/messages.js';

// ── Menu: the host's popover/sheet menu ──────────────────────────────────────

export interface MenuRow {
  readonly id: string;
  readonly label: string;
  readonly icon?: ReactNode;
  /** A second line under the label. */
  readonly hint?: ReactNode;
  /** A trailing chip (a count, a tick). */
  readonly badge?: ReactNode;
  readonly destructive?: boolean;
  /** The row that IS the current one in a picker (`aria-current`). */
  readonly current?: boolean;
  onSelect(): void;
}

export interface MenuSection {
  readonly id: string;
  readonly title?: string;
  /** Shown only while this tab is active. */
  readonly tab?: string;
  readonly rows: MenuRow[];
  /** A free-form body under the rows (a form, a list); the caller owns its keys and strings. */
  readonly content?: ReactNode;
}

export interface MenuSlotProps {
  open: boolean;
  onClose(): void;
  /** The opener: the popover's anchor and where focus returns. */
  anchorRef: RefObject<HTMLElement | null>;
  /** Accessible name of the menu. */
  label: string;
  sections: MenuSection[];
  tabs?: { id: string; label: string }[];
  defaultTab?: string;
  onTabChange?(id: string): void;
  closeLabel?: string;
  /** A wider panel for content-heavy surfaces. */
  wide?: boolean;
  /** A stable handle for harnesses (`data-cm="<name>"`); never user-facing. */
  name?: string;
}

// ── HScroll: one horizontal scroller with arrows ────────────────────────────

export interface HScrollSlotProps {
  children?: ReactNode;
  /** Class of the wrapper (layout in the row). */
  className?: string;
  /** Class of the scroller itself (the flex row holding the children). */
  viewportClassName?: string;
  /** The scroller element, for hosts that observe it. */
  viewportRef?: Ref<HTMLDivElement>;
  /** The host has MORE content than it renders (a lazy window): keep the end arrow on. */
  endMore?: boolean;
  /** Changes whenever the active child changes — the scroller brings it into view. */
  activeKey?: string | number | null;
  /** The arrows live in a gutter BESIDE the strip (never over a child) and show only on hover/focus — fine pointers only. */
  arrowsInGutter?: boolean;
  role?: string;
  'aria-label'?: string;
  prevLabel?: string;
  nextLabel?: string;
}

// ── Lightbox: a full-screen picture pager ────────────────────────────────────

export interface LightboxItem {
  readonly src: string;
  readonly alt: string;
}

export interface LightboxSlotProps {
  items: LightboxItem[];
  index: number;
  onIndexChange(index: number): void;
  onClose(): void;
}

// ── PersonChip: a person's or group's picture token ──────────────────────────

export interface PersonChipSlotProps {
  name: string;
  avatarUrl?: string | null;
  kind: 'HUMAN' | 'GROUP';
  /** Accessible name / title. */
  label?: string;
}

// ── Composer: the message input ──────────────────────────────────────────────

export interface ComposerImage {
  dataUrl: string;
  mimeType: string;
}

/**
 * Someone in the room, as the host knows them (internal ADR-199 §8): ONE list feeds the avatar and the
 * colour of a sender's bubbles, the `@tag` chips and the composer's completion. The package derives
 * nothing — not the colour (the host's palette and its default rule), not the handle (the host's grammar).
 */
export interface Participant {
  /** The participant's id (`personId`; the assistant's sentinel for her). Used for «is me» and «who sent this». */
  readonly id: string;
  readonly name: string;
  /** A displayable picture URL (already resolved by the host); absent: an initial on `color`. */
  readonly avatarUrl?: string;
  /** The CSS colour the host draws this person in (name, bubble edge, initial); absent: the theme's default. */
  readonly color?: string;
  /** The handle without `@`, lower-case — present only when this person can be mentioned (ADR-199 §5). */
  readonly tag?: string;
}

/**
 * Someone the composer may offer after `@` (ADR-199 §5): a participant WITH a handle. The package never
 * parses the host's handle grammar: it matches the list it is given, so a chip or a row exists only for a
 * real participant.
 */
export type MentionCandidate = Participant & {
  readonly tag: string;
  /**
   * Set on the two rows that call the ROOM, not a person (ADR-201 Decision 4): `all` = everyone, `online` = everyone
   * with the chat open now. `id` is then a sentinel, `name` the host-worded label. The popover draws a glyph instead
   * of a face; the chip reads «is me» by this tag, not by the id.
   */
  readonly broadcast?: BroadcastMention;
};

export type { BroadcastMention };

export interface ComposerSlotProps {
  onSend(text: string, images?: ComposerImage[]): void;
  /** The link is down: the input is locked. */
  disabled?: boolean;
  /** Tell the conversation this person is typing. */
  onTyping?(typing: boolean): void;
  /** Whether pictures may be attached (off while editing a sent message). */
  allowImages?: boolean;
  /** Opens the host's sticker picker; absent hides the control. */
  onStickers?(): void;
  /** Whether voice dictation is offered (off while editing). */
  enableVoice?: boolean;
  /** Seeds the draft (the text of the message being edited). */
  initialDraft?: string;
  /**
   * ArrowUp in an EMPTY draft (internal ADR-199 §3): «recall my last message to edit». The composer only
   * reports the key; the host VIEW decides which message that is (own · text · not a sticker · not
   * deleted) and re-seeds the composer through `initialDraft`. Not called while dictation or a
   * translator is active, nor while the draft has text (then ArrowUp moves the caret as usual).
   */
  onRecallLast?(): void;
  /** Who `@` may complete to; absent or empty hides the mention popover. */
  mentionCandidates?: readonly MentionCandidate[];
}

/**
 * What the host supplies. `Composer` is optional: without it the messenger uses its own slim one
 * (text and send only), so the package is usable on its own; a host with a richer input (attach,
 * stickers, dictation) passes it here and the conversation view uses that instead.
 */
export interface MessengerUiSlots {
  Menu: ComponentType<MenuSlotProps>;
  HScroll: ComponentType<HScrollSlotProps>;
  Lightbox: ComponentType<LightboxSlotProps>;
  PersonChip: ComponentType<PersonChipSlotProps>;
  Composer?: ComponentType<ComposerSlotProps>;
}
