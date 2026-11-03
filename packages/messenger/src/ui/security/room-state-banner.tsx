/**
 * RoomStateBanner: the live E2EE state of a room, above the thread (canon section 11).
 *
 * One line at a time, the most serious first: the device must sign in again, it was removed from the
 * room, another tab holds the room, part of the history is only on other devices, a change of keys or
 * a message is on its way. Like the stall banner it cannot be dismissed: each one is true until the
 * state changes, and a banner a person could wave away would let a stuck room look healthy.
 *
 * "Sending…" is a state, not a lock: the composer stays usable, and what is typed meanwhile is queued
 * by the host and goes out right after (no frozen button).
 */
import type { MessengerI18nKey } from '@masia/contracts';
import type { ConversationSecurityState } from '../../protocol/security-state.js';
import { useIcon, useMessengerUi, useT } from '../provider/messenger-ui.js';
import './security.css';

const BANNER_ICON_SIZE = 16;

/** The line a state shows, or `undefined` when there is nothing to say. Pure: the test reads the order here. */
export function roomStateLineOf(
  state: Pick<
    ConversationSecurityState,
    'signInRequired' | 'removed' | 'readOnly' | 'historyBefore' | 'sending'
  >,
): MessengerI18nKey | undefined {
  if (state.signInRequired) return 'roomState.signIn';
  if (state.removed) return 'roomState.removed';
  if (state.readOnly) return 'roomState.readOnly';
  if (state.historyBefore) return 'roomState.historyGap';
  if (state.sending) return 'roomState.sending';
  return undefined;
}

/** The date of a history gap in the reader's language ("10 October 2026"); the raw value if it is not a date. */
export function formatHistoryDate(iso: string, lang: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(lang, { day: 'numeric', month: 'long', year: 'numeric' }).format(
    date,
  );
}

export interface RoomStateBannerProps {
  state: ConversationSecurityState;
}

export function RoomStateBanner({ state }: RoomStateBannerProps) {
  const t = useT();
  const icon = useIcon();
  const { themeStyle, i18n } = useMessengerUi();
  const line = roomStateLineOf(state);
  if (line === undefined) return null;
  const busy = line === 'roomState.sending';
  const text =
    line === 'roomState.historyGap' && state.historyBefore
      ? t(line, { date: formatHistoryDate(state.historyBefore, i18n.lang) })
      : t(line);
  return (
    <div
      className={`msec-banner${busy ? ' msec-banner--quiet' : ''}`}
      style={themeStyle}
      role="status"
      aria-live="polite"
      data-room-state={line}
    >
      <span className="msec-banner__icon" aria-hidden="true">
        {icon(busy ? 'lock' : 'warning', BANNER_ICON_SIZE)}
      </span>
      <span className="msec-banner__text">{text}</span>
    </div>
  );
}
