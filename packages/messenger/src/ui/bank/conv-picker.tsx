/**
 * The conversation picker of the live contact: the types it speaks and the ONE builder of its rows.
 *
 * Since Ф2.4 (2026-11-03) the bank row has no picker chip — the rows live in ONE place, the owner's header
 * menu (`⋯` → «Чати»), which is what the «📌 60 ▾» chip used to open. One builder, so the list is the list.
 */
import type { CSSProperties } from 'react';
import type { IconSet } from '@masia/contracts';
import { renderIcon } from '../provider/messenger-ui.js';
import type { MenuRow } from '../provider/slots.js';
import './channel-bank.css';

/**
 * The picker glyphs, as icon NAMES from the icon set, never a string, so no emoji can come back
 * (an emoji paints itself in its vendor's hand and the theme cannot touch it).
 * `pin` primary · `lock` private · `chat` the rest.
 */
export type ConvPickerGlyph = 'pin' | 'lock' | 'chat';

export interface ConvPickerItem {
  id: string;
  label: string;
  glyph: ConvPickerGlyph;
  current: boolean;
  /** The family space the conversation is attached to, when any — shown as a dim suffix. */
  spaceName?: string | null;
  unread?: number;
}

export interface ConvPickerProps {
  items: readonly ConvPickerItem[];
  onPick(id: string): void;
  /** The list's label (e.g. «Anna · conversations»). */
  title: string;
}

/**
 * What the row builder needs from its surroundings. A caller inside a provider passes
 * `useMessengerUi()`; a caller outside one (the host's header menu, built in a plain function) passes
 * its own icon set and theme style.
 */
export interface ConvPickerRowsEnv {
  readonly icons: IconSet;
  /** The theme as inline custom properties; the rows are drawn in a portal, outside the bank's root. */
  readonly themeStyle: CSSProperties;
}

/**
 * A chat's name as a menu row shows it: PLAIN text. A fork has no title of its own, so the host names it by the head of
 * its last message — and Masia writes markdown («**Конфлікт у Ормузькій протоці**: …»). The marks are dropped wherever
 * they sit, paired or not: the host cuts the head to a fixed length first, which can leave an opening `**` with no mate.
 * (Local on purpose: this package depends on nothing but `@masia/contracts`, so the shared text helpers are out of reach.)
 */
export function plainConvLabel(raw: string): string {
  return raw
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // [label](url) → label
    .replace(/\*\*|__|~~|`/g, '') // bold · strike · code marks
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+])\s+/gm, '') // a heading / quote / bullet mark opening a line
    .replace(/(^|[\s(])[*_]+(?=\S)/g, '$1') // `*word` · `_word`: single emphasis hugging a word's start…
    .replace(/(\S)[*_]+(?=$|[\s).,:;!?])/g, '$1') // …or its end (a `snake_case` inside a word stays)
    .replace(/\s+/g, ' ')
    .trim();
}

/** The longest a chat name the row carries: a fork named by an essay is cut to its head here, never mid-word. */
export const CONV_LABEL_MAX = 80;

/**
 * A name's head: whole words up to `max` characters, then «…». The host used to `slice(0, 80)` the raw text — «Чим можу допомогт»,
 * a word cut off clean with no mark that it was cut — and the two-line clamp below never fires on a text that already fits.
 */
export function clipAtWord(text: string, max: number = CONV_LABEL_MAX): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const lastSpace = head.lastIndexOf(' ');
  // A single unbroken token longer than the cap has no word boundary to cut at: cut it where it stands.
  return `${(lastSpace > max / 2 ? head.slice(0, lastSpace) : head).trimEnd()}…`;
}

/**
 * The picker's rows as menu rows. The current conversation carries `current` (→ `aria-current`, the
 * one place its name is asserted) and a tick. The name is plain text ({@link plainConvLabel}), cut to its head at a word
 * ({@link clipAtWord}); the row clamps it to two lines with «…» (`MessengerPage.css`).
 */
export function convPickerRows(picker: ConvPickerProps, env: ConvPickerRowsEnv): MenuRow[] {
  const { icons, themeStyle } = env;
  return picker.items.map((i) => ({
    id: `conv:${i.id}`,
    label: clipAtWord(plainConvLabel(i.label)) || i.label, // (a name that was ONLY marks keeps its marks rather than an empty row)
    icon: renderIcon(icons, i.glyph, 16),
    hint: i.spaceName ? (
      <span className="chbank-convs__space">
        {renderIcon(icons, 'folder', 12, 'chbank-convs__space-glyph')}
        <span className="chbank-convs__space-name">{i.spaceName}</span>
      </span>
    ) : undefined,
    badge: i.current ? (
      renderIcon(icons, 'check', 14)
    ) : i.unread ? (
      // Drawn inside a menu portal, which sits outside the bank's root: it carries the tokens itself.
      <span className="chbank-convs__unread" style={themeStyle}>
        {i.unread}
      </span>
    ) : undefined,
    current: i.current,
    onSelect: () => picker.onPick(i.id),
  }));
}
