/**
 * ZoneBadge: the one-line, tappable statement of what protects a room, for the conversation header.
 *
 * It says only what the client knows (`ConversationSecurityState`): "Text is encrypted · Masia is not
 * here", "Masia zone — the server reads this room", "Setting up encryption…", or "Not end-to-end
 * encrypted". With no state for the room it draws NOTHING (an unknown room must not look secure).
 * A tap opens the sheet (`SecuritySheetBody`) in the host's own menu slot, so it is a popover on a
 * desk and a bottom sheet on a phone without this package knowing which.
 *
 * The host mounts the badge in its header (this package draws no header), inside the provider.
 */
import { Loader } from '@mantine/core';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useIcon, useMessengerUi, useT } from '../provider/messenger-ui.js';
import type { MenuSection } from '../provider/slots.js';
import { SecuritySheetBody } from './security-sheet.js';
import { useSecurityState } from './use-security-state.js';
import { ZONE_ICON, ZONE_LABEL_KEY, zoneOf } from './zone.js';
import './security.css';

/** Pixel size of the badge's icon and spinner. */
const BADGE_ICON_SIZE = 14;
const DEVICES_ROW_ICON_SIZE = 16;
/** The handle harnesses find the sheet by (`data-cm="security"`); never user-facing. */
const SHEET_NAME = 'security';

export interface ZoneBadgeProps {
  conversationId: string;
  /**
   * Opens the host's devices screen (where `DevicesCard` lives). Absent: the sheet has no link, the
   * badge never invents a destination.
   */
  onOpenDevices?: () => void;
}

export function ZoneBadge({ conversationId, onOpenDevices }: ZoneBadgeProps) {
  const t = useT();
  const icon = useIcon();
  const { slots, themeStyle } = useMessengerUi();
  const state = useSecurityState(conversationId);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const toggle = useCallback(() => setOpen((was) => !was), []);

  const sections = useMemo<MenuSection[]>(() => {
    if (!state) return [];
    const list: MenuSection[] = [
      {
        id: 'security',
        title: t('zone.sheetTitle'),
        rows: [],
        content: <SecuritySheetBody state={state} />,
      },
    ];
    if (onOpenDevices) {
      list.push({
        id: 'security-devices',
        rows: [
          {
            id: 'devices',
            label: t('zone.openDevices'),
            icon: icon('devices', DEVICES_ROW_ICON_SIZE),
            onSelect: onOpenDevices,
          },
        ],
      });
    }
    return list;
  }, [state, onOpenDevices, t, icon]);

  if (!state) return null;

  const Menu = slots.Menu;
  const zone = zoneOf(state);
  const label = t(ZONE_LABEL_KEY[zone]);
  const zoneIcon = ZONE_ICON[zone];

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className={`msec-badge is-${zone}`}
        style={themeStyle}
        data-zone={zone}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={toggle}
      >
        <span className="msec-badge__icon" aria-hidden="true">
          {zoneIcon ? icon(zoneIcon, BADGE_ICON_SIZE) : <Loader size={BADGE_ICON_SIZE - 2} />}
        </span>
        <span className="msec-badge__text">{label}</span>
      </button>
      <Menu
        open={open}
        onClose={close}
        anchorRef={anchorRef}
        label={t('zone.sheetTitle')}
        sections={sections}
        closeLabel={t('common.close')}
        name={SHEET_NAME}
      />
    </>
  );
}
