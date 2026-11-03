// @vitest-environment jsdom
/**
 * DevicesCard with a room's key tree (К5b): role chip, verified mark, "owes its first key update"
 * warning and the "this device" marker — and NO new action.
 *
 * A session whose id is a leaf of the room is decorated in place; the room's other devices (another
 * person's, a guardian's, Masia's) sit read-only under "Devices in this room". Ending a session stays
 * where it was: on the session rows, and only there.
 *
 * Test by failure: a revoke button on a room-only row -> the "no new action" test; a device listed in
 * both places -> the "once" test; marks drawn without a `conversationId` -> the "unchanged" test.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import type { TransportResponse } from '@masia/contracts';
import {
  createFakeSecuritySource,
  makeSecurityDevice,
  makeSecurityState,
} from '../../../test-support/fake-security.js';
import { cleanupUi, flush, q, qa, renderUi } from '../../../test-support/fake-ui.js';
import { DevicesCard, type DeviceView, type DevicesTransport } from '../devices-card.js';

afterEach(cleanupUi);

const PATH = '/api/auth/devices';
const ROOM = 'c1';

const session = (over: Partial<DeviceView> = {}): DeviceView => ({
  deviceId: 'dev-1',
  deviceName: 'iPhone 17',
  platform: 'ios',
  authMethod: 'password',
  createdAt: '2026-01-01T00:00:00Z',
  lastSeenAt: '2026-03-04T10:20:00Z',
  ipMasked: null,
  current: false,
  ...over,
});

const transportOf = (devices: DeviceView[]): DevicesTransport => ({
  async fetch(): Promise<TransportResponse> {
    return {
      status: 200,
      headers: {},
      body: new TextEncoder().encode(JSON.stringify({ devices })),
    };
  },
});

const roomState = () =>
  makeSecurityState({
    devices: [
      makeSecurityDevice({
        deviceId: 'dev-1',
        label: 'iPhone 17',
        role: 'USER',
        verified: true,
        isThis: true,
      }),
      makeSecurityDevice({
        deviceId: 'masia-1',
        label: 'Masia',
        role: 'ASSISTANT',
        verified: true,
      }),
      makeSecurityDevice({
        deviceId: 'guard-1',
        label: 'Mom’s phone',
        role: 'GUARDIAN',
        verified: false,
        needsSelfUpdate: true,
      }),
    ],
  });

async function mount(
  sessions: DeviceView[],
  conversationId: string | null = ROOM,
  state = roomState(),
) {
  const security = createFakeSecuritySource({ [ROOM]: state });
  const tree = renderUi(
    <DevicesCard
      transport={transportOf(sessions)}
      devicesPath={PATH}
      conversationId={conversationId ?? undefined}
    />,
    { security },
  );
  await flush();
  return { ...tree, security };
}

const roomRows = () => qa('.mdev-room-row');

describe('DevicesCard with a conversation: a session that is a leaf of the room', () => {
  it('wears its role chip, the verified check and the "this device" marker', async () => {
    await mount([session()]);
    const row = qa('.mdev-row')[0]!;
    expect(q('.msec-chip', row)!.getAttribute('data-role')).toBe('USER');
    expect(q('.msec-chip', row)!.textContent).toBe('Person');
    expect(q('.msec-verified', row)!.getAttribute('data-verified')).toBe('true');
    expect(q('.msec-verified', row)!.textContent).toBe('Verified');
    expect(q('.msec-verified__icon svg', row)!.getAttribute('data-icon')).toBe('check');
    expect(row.textContent).toContain('current'); // isThis, although the session itself is not `current`
  });

  it('a session that is not in the room is left exactly as it was', async () => {
    await mount([session({ deviceId: 'other', deviceName: 'Old tablet' })]);
    const row = qa('.mdev-row')[0]!;
    expect(q('.msec-chip', row)).toBeNull();
    expect(q('.msec-verified', row)).toBeNull();
  });
});

describe("DevicesCard with a conversation: the room's other devices", () => {
  it('lists them read-only under "Devices in this room", each device once', async () => {
    await mount([session()]);
    expect(q('.mdev-room__title')!.textContent).toBe('Devices in this room');
    expect(roomRows().map((row) => q('.mdev-name', row)!.textContent)).toEqual([
      'Masia',
      'Mom’s phone',
    ]);
    // dev-1 is a session AND a leaf: it appears on the session row, not again in the room section
    expect(qa('.mdev-name').map((n) => n.textContent)).toEqual([
      'iPhone 17',
      'Masia',
      'Mom’s phone',
    ]);
  });

  it('shows each role with its own chip and icon', async () => {
    await mount([session()]);
    const [masia, guardian] = roomRows();
    expect(q('.msec-chip', masia!)!.textContent).toBe('Assistant');
    expect(q('.mdev-icon svg', masia!)!.getAttribute('data-icon')).toBe('masia');
    expect(q('.msec-chip', guardian!)!.textContent).toBe('Guardian');
    expect(q('.mdev-icon svg', guardian!)!.getAttribute('data-icon')).toBe('guardian');
  });

  it('marks an unverified device as not verified, and verified ones with the check', async () => {
    await mount([session()]);
    const [masia, guardian] = roomRows();
    expect(q('.msec-verified', masia!)!.getAttribute('data-verified')).toBe('true');
    const unverified = q('.msec-verified', guardian!)!;
    expect(unverified.getAttribute('data-verified')).toBe('false');
    expect(unverified.textContent).toBe('Not verified');
    expect(q('.msec-verified__icon', guardian!)).toBeNull();
  });

  it('warns only the device that owes its first key update', async () => {
    await mount([session()]);
    const [masia, guardian] = roomRows();
    expect(q('.msec-selfupdate', masia!)).toBeNull();
    expect(q('.msec-selfupdate', guardian!)!.textContent).toBe(
      'Waiting for this device’s first key update',
    );
  });

  it('marks this device when it is not one of the listed sessions', async () => {
    await mount(
      [],
      ROOM,
      makeSecurityState({
        devices: [makeSecurityDevice({ deviceId: 'solo', label: 'This browser', isThis: true })],
      }),
    );
    expect(roomRows()).toHaveLength(1);
    expect(roomRows()[0]!.textContent).toContain('current');
  });

  it('adds NO action: the only buttons are the revoke buttons of the sessions', async () => {
    await mount([
      session({ deviceId: 'dev-1' }),
      session({ deviceId: 'dev-2', deviceName: 'Tab' }),
    ]);
    const buttons = qa('button');
    expect(buttons).toHaveLength(2);
    for (const button of buttons) expect(button.classList.contains('mdev-revoke')).toBe(true);
    for (const row of roomRows()) expect(qa('button', row)).toHaveLength(0);
  });

  it('shows the room section even when the session list is empty', async () => {
    await mount([]);
    expect(q('.mdev-card')!.textContent).toContain('No active sessions.');
    expect(roomRows()).toHaveLength(3);
  });

  it('follows the room live: a device that gets its key update loses its warning', async () => {
    const { security } = await mount([session()]);
    expect(qa('.msec-selfupdate')).toHaveLength(1);
    act(() =>
      security.set(
        ROOM,
        makeSecurityState({
          devices: roomState().devices.map((d) => ({ ...d, needsSelfUpdate: false })),
        }),
      ),
    );
    expect(qa('.msec-selfupdate')).toHaveLength(0);
  });
});

describe('DevicesCard without a room: unchanged', () => {
  it('draws no marks and no room section without a conversationId', async () => {
    await mount([session()], null);
    expect(qa('.msec-chip, .msec-verified, .msec-selfupdate, .mdev-room')).toHaveLength(0);
  });

  it('draws no marks when the host mounted no security source', async () => {
    const tree = renderUi(
      <DevicesCard transport={transportOf([session()])} devicesPath={PATH} conversationId={ROOM} />,
    );
    await flush();
    expect(tree.container.querySelectorAll('.msec-chip, .mdev-room')).toHaveLength(0);
    expect(qa('.mdev-row')).toHaveLength(1);
  });
});
