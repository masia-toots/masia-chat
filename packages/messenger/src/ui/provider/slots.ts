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
