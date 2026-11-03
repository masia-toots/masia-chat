/**
 * GuardianRibbon: a persistent thin line under the header, "<name> sees this chat", one per guardian.
 *
 * Shown to EVERY member of the room, the child included and people from other families too (ADR-117
 * section 4): a parent must never read a child without the child and the other side knowing. So it
 * has no close button, no "don't show again" and no collapsed-by-default state. Beyond
 * `GUARDIAN_NAMED_MAX` guardians it counts instead of naming ("3 adults see this chat"), still one
 * visible line, still not dismissable.
 */
import type { SecurityGuardian } from '../../protocol/security-state.js';
import { useIcon, useMessengerUi, useT } from '../provider/messenger-ui.js';
import { distinctGuardians, GUARDIAN_NAMED_MAX } from './zone.js';
import './security.css';

const RIBBON_ICON_SIZE = 13;

export interface GuardianRibbonProps {
  guardians: readonly SecurityGuardian[];
}

export function GuardianRibbon({ guardians }: GuardianRibbonProps) {
  const t = useT();
  const icon = useIcon();
  const { themeStyle } = useMessengerUi();
  const adults = distinctGuardians(guardians);
  if (adults.length === 0) return null;

  const lines =
    adults.length <= GUARDIAN_NAMED_MAX
      ? adults.map((guardian) => ({
          key: guardian.userId,
          text: t('guardians.seesChat', { name: guardian.displayName }),
        }))
      : [{ key: 'many', text: t('guardians.seesChatMany', { count: adults.length }) }];

  return (
    <div className="msec-ribbon" style={themeStyle} role="note" data-guardians={adults.length}>
      {lines.map((line) => (
        <p key={line.key} className="msec-ribbon__line">
          <span className="msec-ribbon__icon" aria-hidden="true">
            {icon('guardian', RIBBON_ICON_SIZE)}
          </span>
          <span className="msec-ribbon__text">{line.text}</span>
        </p>
      ))}
    </div>
  );
}
