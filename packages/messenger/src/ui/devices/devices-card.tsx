/**
 * DevicesCard: the sessions an account is signed in on (host plan "signal-safe messenger", 2026-09-09
 * К3, T0-b).
 *
 * A row is one refresh-token rotation chain: a device. "Log out" revokes the whole chain, so the
 * phone in question stops refreshing within its access-token life and cannot recover (the host's
 * reuse detection finishes the job if it replays an old token). The CURRENT session shows a badge
 * and no button: ending it is what Logout is for (it also clears the cookie).
 *
 * ONE component for both surfaces (my settings, a member's sheet) so the list, the confirm and the
 * strings have a single home. It knows no URL: the host passes the path of the device list and the
 * card reads and deletes beneath it through the transport.
 *
 * With a `conversationId` the card also shows what the room's key tree says about devices (К5b): a
 * session whose id is a leaf of the room wears its role, whether its key was verified and whether it
 * still owes its first key update, and the room's other devices (other people's, a guardian, Masia)
 * are listed read-only under "Devices in this room". Those rows carry NO action: ending a session
 * stays exactly where it was, on the session rows.
 */
import { Badge, Button, Card, Group, Loader, Stack, Text, Title } from '@mantine/core';
import { useCallback, useEffect, useState } from 'react';
import type { MessengerIconName, Transport } from '@masia/contracts';
import type { SecurityDevice } from '../../protocol/security-state.js';
import { useIcon, useMessengerUi, useT } from '../provider/messenger-ui.js';
import { RoleChip, ROLE_ICON, SelfUpdateWarning, VerifiedMark } from '../security/device-marks.js';
import { useSecurityState } from '../security/use-security-state.js';
import './devices-card.css';

/** What the card needs of the relay: requests only (it never subscribes). */
export type DevicesTransport = Pick<Transport, 'fetch'>;

/** One device row as the host's list answers it. Never carries a token. */
export interface DeviceView {
  deviceId: string;
  deviceName: string | null;
  platform: string | null;
  authMethod: string;
  createdAt: string;
  lastSeenAt: string;
  ipMasked: string | null;
  current: boolean;
}

export interface DevicesCardProps {
  transport: DevicesTransport;
  /**
   * The path of the device list. `GET` reads it; `DELETE <path>/<deviceId>` ends one session. The
   * host decides whether the caller may see it (a supervising adult for a member's list).
   */
  devicesPath: string;
  /** `self` = my own sessions; `member` = a family member's (the parental view): only the empty text differs. */
  scope?: 'self' | 'member';
  /** Render bare (no Card chrome): the member sheet supplies its own section frame. */
  bare?: boolean;
  /**
   * A room whose key tree decorates the list (role, verified, owes a key update) and adds the room's
   * other devices. Absent: the card is exactly the session list.
   */
  conversationId?: string;
}

const HTTP_FORBIDDEN = 403;
const HTTP_OK_MIN = 200;
const HTTP_OK_MAX = 299;

const isOk = (status: number): boolean => status >= HTTP_OK_MIN && status <= HTTP_OK_MAX;

/** One icon language, no emoji: the platform picks a stencil. */
function platformIcon(platform: string | null): MessengerIconName {
  if (platform === 'ios' || platform === 'android') return 'device-mobile';
  if (platform === 'web') return 'device-web';
  return 'device-desktop';
}

function decodeDevices(body: Uint8Array): DeviceView[] {
  const parsed = JSON.parse(new TextDecoder().decode(body)) as { devices?: DeviceView[] };
  return parsed.devices ?? [];
}

/** The marks of one room device under its name; a session row shows the same set when it is a leaf. */
function SecurityMarks({ device }: { device: SecurityDevice }) {
  return (
    <>
      <span className="mdev-marks">
        <RoleChip role={device.role} />
        <VerifiedMark verified={device.verified} />
      </span>
      {device.needsSelfUpdate && <SelfUpdateWarning />}
    </>
  );
}

export function DevicesCard({
  transport,
  devicesPath,
  scope = 'self',
  bare = false,
  conversationId,
}: DevicesCardProps) {
  const { i18n } = useMessengerUi();
  const t = useT();
  const icon = useIcon();
  const security = useSecurityState(conversationId);
  const roomDevices = security?.devices ?? [];
  const roomById = new Map(roomDevices.map((device) => [device.deviceId, device] as const));

  const [devices, setDevices] = useState<DeviceView[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await transport.fetch(devicesPath);
      if (!isOk(res.status)) {
        // 403 = the caller is not a supervising adult. That is a normal answer for this surface,
        // not an error worth shouting about: show the empty state.
        if (res.status !== HTTP_FORBIDDEN) setError(t('devices.loadError'));
        setDevices([]);
        return;
      }
      setDevices(decodeDevices(res.body));
      setError(null);
    } catch {
      setError(t('devices.loadError'));
    } finally {
      setLoading(false);
    }
  }, [transport, devicesPath, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const revoke = useCallback(
    async (device: DeviceView) => {
      const name = device.deviceName ?? t('devices.unknown');
      // `window.confirm` is the house pattern for a destructive settings action: revoking a
      // session is exactly that kind of action.
      if (!window.confirm(t('devices.revokeConfirm', { name }))) return;
      setBusyId(device.deviceId);
      setError(null);
      try {
        const res = await transport.fetch(`${devicesPath}/${encodeURIComponent(device.deviceId)}`, {
          method: 'DELETE',
        });
        if (!isOk(res.status)) {
          setError(t('devices.revokeError'));
          return;
        }
        await load();
      } catch {
        setError(t('devices.revokeError'));
      } finally {
        setBusyId(null);
      }
    },
    [transport, devicesPath, load, t],
  );

  const when = (iso: string): string => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    try {
      return new Intl.DateTimeFormat(i18n.lang, {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      }).format(d);
    } catch {
      return d.toLocaleString();
    }
  };

  const platformLabel = (platform: string | null): string | null =>
    platform === 'ios' || platform === 'android' || platform === 'web' ? t(`devices.platform.${platform}`) : null;

  // The room's devices that are not one of the listed sessions: other people's, a guardian's, Masia's.
  const sessionIds = new Set(devices.map((d) => d.deviceId));
  const onlyInRoom = roomDevices.filter((device) => !sessionIds.has(device.deviceId));

  const body = loading ? (
    <Loader size="sm" />
  ) : (
    <Stack gap="sm">
      {devices.length === 0 && (
        <Text size="sm" c="dimmed">
          {t(scope === 'member' ? 'devices.memberEmpty' : 'devices.empty')}
        </Text>
      )}

      {devices.map((d) => {
        const leaf = roomById.get(d.deviceId);
        const name = d.deviceName ?? t('devices.unknown');
        const sub = [platformLabel(d.platform), d.ipMasked, t('devices.lastSeen', { when: when(d.lastSeenAt) })]
          .filter(Boolean)
          .join(' · ');
        return (
          <Group key={d.deviceId} className="mdev-row" justify="space-between" wrap="nowrap" gap="sm">
            <Group gap="sm" wrap="nowrap" className="mdev-id">
              <span className="mdev-icon" aria-hidden="true">
                {icon(platformIcon(d.platform), 20)}
              </span>
              <Stack gap={0} className="mdev-text">
                <Group gap="xs" wrap="nowrap">
                  <Text size="sm" fw={500} className="mdev-name">
                    {name}
                  </Text>
                  {(d.current || leaf?.isThis) && (
                    <Badge size="xs" variant="light" color="cyan">
                      {t('devices.current')}
                    </Badge>
                  )}
                </Group>
                <Text size="xs" c="dimmed" className="mdev-sub">
                  {sub}
                </Text>
                {leaf && <SecurityMarks device={leaf} />}
              </Stack>
            </Group>

            {/* The current session is ended through Logout, never here: the host refuses it too
                (409 CURRENT_DEVICE), so the guard is not just visual. */}
            {!d.current && (
              // The button sits in its OWN element, not straight in the Mantine Group: the Group
              // writes an inline `justify` and a wrapped flex child of it could not be made
              // full-width from a stylesheet without `!important`.
              <div className="mdev-actions">
                <Button
                  variant="subtle"
                  color="red"
                  size="compact-sm"
                  className="mdev-revoke"
                  loading={busyId === d.deviceId}
                  onClick={() => void revoke(d)}
                  leftSection={icon('logout', 14)}
                >
                  {t('devices.revoke')}
                </Button>
              </div>
            )}
          </Group>
        );
      })}

      {error && (
        <Text size="xs" c="red" role="status">
          {error}
        </Text>
      )}

      {onlyInRoom.length > 0 && (
        <section className="mdev-room" aria-label={t('devices.roomSection')}>
          <Text size="xs" fw={600} c="dimmed" className="mdev-room__title">
            {t('devices.roomSection')}
          </Text>
          {onlyInRoom.map((device) => (
            <Group
              key={device.deviceId}
              className="mdev-row mdev-room-row"
              wrap="nowrap"
              gap="sm"
              data-device-role={device.role}
            >
              <span className="mdev-icon" aria-hidden="true">
                {icon(ROLE_ICON[device.role], 20)}
              </span>
              <Stack gap={0} className="mdev-text">
                <Group gap="xs" wrap="nowrap">
                  <Text size="sm" fw={500} className="mdev-name">
                    {device.label}
                  </Text>
                  {device.isThis && (
                    <Badge size="xs" variant="light" color="cyan">
                      {t('devices.current')}
                    </Badge>
                  )}
                </Group>
                <SecurityMarks device={device} />
              </Stack>
            </Group>
          ))}
        </section>
      )}
    </Stack>
  );

  if (bare) return body;

  return (
    <Card withBorder radius="md" p="lg" className="mdev-card">
      <Title order={4} mb={4}>
        {t('devices.section')}
      </Title>
      <Text size="xs" c="dimmed" mb="md">
        {t('devices.desc')}
      </Text>
      {body}
    </Card>
  );
}
