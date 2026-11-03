/**
 * The marks a device row can carry in the security view: its role, whether its key was checked, and
 * whether it still owes its first key update. Small, presentational, shared by `DevicesCard`.
 *
 * "Verified" here means the client checked the device's key against its owner's signed device list.
 * It does NOT mean a person compared security codes; the label never says "trusted" or "safe".
 */
import type { MessengerIconName } from '@masia/contracts';
import type { SecurityDeviceRole } from '../../protocol/security-state.js';
import { useIcon, useT } from '../provider/messenger-ui.js';
import './security.css';

const MARK_ICON_SIZE = 12;

/** The role's own stencil for a device that has no platform of its own (Masia, a guardian). */
export const ROLE_ICON: Readonly<Record<SecurityDeviceRole, MessengerIconName>> = {
  USER: 'device-mobile',
  GUARDIAN: 'guardian',
  ASSISTANT: 'masia',
};

export function RoleChip({ role }: { role: SecurityDeviceRole }) {
  const t = useT();
  return (
    <span className={`msec-chip is-${role.toLowerCase()}`} data-role={role}>
      {t(`devices.role.${role}`)}
    </span>
  );
}

export function VerifiedMark({ verified }: { verified: boolean }) {
  const t = useT();
  const icon = useIcon();
  return (
    <span
      className={`msec-verified${verified ? '' : ' is-unverified'}`}
      data-verified={String(verified)}
    >
      {verified && (
        <span className="msec-verified__icon" aria-hidden="true">
          {icon('check', MARK_ICON_SIZE)}
        </span>
      )}
      {t(verified ? 'devices.verified' : 'devices.unverified')}
    </span>
  );
}

export function SelfUpdateWarning() {
  const t = useT();
  const icon = useIcon();
  return (
    <p className="msec-selfupdate" data-needs-self-update="true">
      <span className="msec-selfupdate__icon" aria-hidden="true">
        {icon('warning', MARK_ICON_SIZE)}
      </span>
      {t('devices.needsSelfUpdate')}
    </p>
  );
}
