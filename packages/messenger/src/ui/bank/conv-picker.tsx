/**
 * The conversation picker of the live contact: the types it speaks and the ONE builder of its rows.
 *
 * The same rows have two homes: the picker chip's own menu in the bank, and the owner's header menu
 * (`⋯` → «where») when the bank folds the chip away because the row is too narrow. One builder, so
 * the two lists cannot drift.
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
  /** The dropdown's label and the chip's accessible name (e.g. «Anna · conversations»). */
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
 * The picker's rows as menu rows. The current conversation carries `current` (→ `aria-current`, the
 * one place its name is asserted) and a tick.
 */
export function convPickerRows(picker: ConvPickerProps, env: ConvPickerRowsEnv): MenuRow[] {
  const { icons, themeStyle } = env;
  return picker.items.map((i) => ({
    id: `conv:${i.id}`,
    label: i.label,
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
