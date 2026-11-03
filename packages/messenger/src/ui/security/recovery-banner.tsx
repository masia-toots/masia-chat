/**
 * RecoveryBanner: shown while a room is stalled (`recovery === 'stalled'`), above the thread.
 *
 * Non-dismissable on purpose: the room really is waiting, and a banner a person can wave away would
 * let a stalled room look healthy. The words promise an order, not a time ("once it completes"):
 * we do not know how long a key refresh takes, so we do not say.
 */
import type { RecoveryStatus } from '../../protocol/security-state.js';
import { useIcon, useMessengerUi, useT } from '../provider/messenger-ui.js';
import './security.css';

const BANNER_ICON_SIZE = 16;

export interface RecoveryBannerProps {
  recovery?: RecoveryStatus;
}

export function RecoveryBanner({ recovery }: RecoveryBannerProps) {
  const t = useT();
  const icon = useIcon();
  const { themeStyle } = useMessengerUi();
  if (recovery !== 'stalled') return null;
  return (
    <div className="msec-banner" style={themeStyle} role="status" data-recovery="stalled">
      <span className="msec-banner__icon" aria-hidden="true">
        {icon('warning', BANNER_ICON_SIZE)}
      </span>
      <span className="msec-banner__text">{t('recovery.stalled')}</span>
    </div>
  );
}
