/**
 * EpochSystemRow: the permanent system line a thread shows when the room's keys change — a device
 * added or removed, Masia joining or leaving, a person's key changing, encryption switching on
 * (canon sections 3 and 4). A line, not a toast: it stays in the thread where it happened.
 *
 * INTEGRATION POINT (not wired yet): `MessengerChatView` has no system-row slot today. The wiring
 * step merges the engine's `EpochEvent`s with the messages by time and renders this row between
 * them; a row also breaks the sender grouping of the bubbles around it. Until then the row is
 * exported and tested on its own.
 */
import type { MessengerI18nKey, MessengerIconName } from '@masia/contracts';
import type { EpochEvent } from '../../protocol/security-state.js';
import { useIcon, useMessengerUi, useT } from '../provider/messenger-ui.js';
import './security.css';

const EPOCH_ICON_SIZE = 13;

export interface EpochSystemRowProps {
  event: EpochEvent;
}

interface RowParts {
  readonly key: MessengerI18nKey;
  readonly vars?: Record<string, string>;
  readonly icon: MessengerIconName;
  /** A change the people in the room should look at, not just read. */
  readonly caution: boolean;
}

function partsOf(event: EpochEvent): RowParts {
  switch (event.kind) {
    case 'device-added':
      return {
        key: 'epoch.deviceAdded',
        vars: { name: event.personName, device: event.deviceLabel },
        icon: 'devices',
        caution: false,
      };
    case 'device-removed':
      return {
        key: 'epoch.deviceRemoved',
        vars: { name: event.personName, device: event.deviceLabel },
        icon: 'devices',
        caution: false,
      };
    case 'masia-joined':
      return { key: 'epoch.masiaJoined', icon: 'masia', caution: false };
    case 'masia-left':
      return { key: 'epoch.masiaLeft', icon: 'masia', caution: false };
    case 'key-changed':
      return { key: 'epoch.keyChanged', vars: { name: event.personName }, icon: 'warning', caution: true };
    case 'encryption-on':
      return { key: 'epoch.encryptionOn', icon: 'lock', caution: false };
  }
}

export function EpochSystemRow({ event }: EpochSystemRowProps) {
  const t = useT();
  const icon = useIcon();
  const { themeStyle } = useMessengerUi();
  const parts = partsOf(event);
  return (
    <div
      className={`msec-epoch${parts.caution ? ' is-caution' : ''}`}
      style={themeStyle}
      role="note"
      data-epoch-kind={event.kind}
      data-epoch-id={event.id}
    >
      <span className="msec-epoch__icon" aria-hidden="true">
        {icon(parts.icon, EPOCH_ICON_SIZE)}
      </span>
      <span className="msec-epoch__text">{t(parts.key, parts.vars)}</span>
    </div>
  );
}
