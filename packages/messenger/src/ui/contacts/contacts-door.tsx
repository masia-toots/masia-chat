/**
 * ContactsDoor: the bank's ONE door to the contacts menu (plan `player-wide-holo-tabs-people` Ш5,
 * founder 2026-10-08: «керування колами і групами злити в одну іконку»).
 *
 * A door PLATE, not a pill (canon §12: the bank is equipment): the same flat mono vocabulary as the
 * conversation picker chip (styles: `channel-bank.css` § THE DOOR). The mark is the `users` icon
 * (two people, no plus; founder 2026-10-08, Г1 = A: «двоє людей, без плюса для чистоти») and a badge
 * with the count of INCOMING requests rides its corner (hidden at 0).
 */
import { useIcon, useT } from '../provider/messenger-ui.js';

export interface ContactsDoorProps {
  /** Is the menu open FROM this door (drives `aria-expanded` and the lit plate). */
  expanded: boolean;
  /** Incoming contact requests waiting for my answer: the badge; hidden at 0. */
  badge?: number;
  /** Open the menu; the element is the popover anchor and where focus returns. */
  onOpen(el: HTMLButtonElement): void;
}

export function ContactsDoor({ expanded, badge = 0, onOpen }: ContactsDoorProps) {
  const t = useT();
  const icon = useIcon();
  const name = t('contacts.people');
  const badgeLabel = badge > 0 ? t('contacts.newRequests', { count: badge }) : '';
  const label = badge > 0 ? `${name}, ${badgeLabel}` : name;
  return (
    <button
      type="button"
      className={`chbank__people${expanded ? ' is-open' : ''}`}
      aria-label={label}
      aria-haspopup="dialog"
      aria-expanded={expanded}
      title={label}
      data-contacts-door="people"
      onClick={(e) => onOpen(e.currentTarget)}
    >
      <span aria-hidden className="chbank__people-glyph chbank__door-glyph">
        {icon('users', undefined, 'chbank__ic')}
        {badge > 0 && (
          <span className="chbank__door-badge" data-door-badge>
            {badge > 99 ? '99+' : badge}
          </span>
        )}
      </span>
    </button>
  );
}
