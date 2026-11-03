// @vitest-environment jsdom
/**
 * DevicesCard: the list of signed-in sessions, the confirm-then-revoke flow, and the quiet answers
 * (403 is an empty state, not an error). It talks to the relay only through the transport port.
 */
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { TransportRequest, TransportResponse } from '@masia/contracts';
import { cleanupUi, click, flush, q, qa, renderUi } from '../../../test-support/fake-ui.js';
import { DevicesCard, type DeviceView, type DevicesTransport } from '../devices-card.js';

const PATH = '/api/auth/devices';

const device = (over: Partial<DeviceView> = {}): DeviceView => ({
  deviceId: 'd1',
  deviceName: 'Pixel 9',
  platform: 'android',
  authMethod: 'password',
  createdAt: '2026-01-01T00:00:00Z',
  lastSeenAt: '2026-03-04T10:20:00Z',
  ipMasked: '10.0.x.x',
  current: false,
  ...over,
});

const json = (status: number, value: unknown): TransportResponse => ({
  status,
  headers: {},
  body: new TextEncoder().encode(JSON.stringify(value)),
});

interface Call {
  path: string;
  init: TransportRequest | undefined;
}

/** A relay whose answers a test scripts per `METHOD path`; every request is recorded. */
function scriptedTransport(script: Record<string, () => TransportResponse | Promise<TransportResponse>>) {
  const calls: Call[] = [];
  const transport: DevicesTransport = {
    async fetch(path, init) {
      calls.push({ path, init });
      const answer = script[`${init?.method ?? 'GET'} ${path}`];
      return answer ? answer() : { status: 404, headers: {}, body: new Uint8Array() };
    },
  };
  return { transport, calls };
}

let confirm: MockInstance<(message?: string) => boolean>;
beforeEach(() => {
  confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
});
afterEach(() => {
  confirm.mockRestore();
  cleanupUi();
});

async function mount(
  transport: DevicesTransport,
  props: Partial<ComponentProps<typeof DevicesCard>> = {},
) {
  const tree = renderUi(<DevicesCard transport={transport} devicesPath={PATH} {...props} />);
  await flush();
  return tree;
}

const rows = () => qa('.mdev-row');
const revokeButtons = () => qa<HTMLButtonElement>('.mdev-revoke');

describe('DevicesCard: the list', () => {
  it('shows each session with its platform icon, label, mask and last-seen line', async () => {
    const { transport } = scriptedTransport({
      [`GET ${PATH}`]: () =>
        json(200, {
          devices: [
            device(),
            device({ deviceId: 'd2', deviceName: null, platform: null, ipMasked: null }),
            device({ deviceId: 'd3', deviceName: 'MacBook', platform: 'web' }),
            device({ deviceId: 'd4', deviceName: 'iPhone', platform: 'ios' }),
          ],
        }),
    });
    await mount(transport);

    expect(rows()).toHaveLength(4);
    expect(qa('.mdev-icon svg').map((i) => `${i.getAttribute('data-icon')}:${i.getAttribute('data-size')}`)).toEqual([
      'device-mobile:20',
      'device-desktop:20',
      'device-web:20',
      'device-mobile:20',
    ]);
    expect(qa('.mdev-name').map((n) => n.textContent)).toEqual(['Pixel 9', 'Unknown device', 'MacBook', 'iPhone']);
    const sub = qa('.mdev-sub').map((n) => n.textContent ?? '');
    expect(sub[0]).toMatch(/^Android · 10\.0\.x\.x · Last seen /);
    expect(sub[1]).toMatch(/^Last seen /); // no platform, no mask: only the time
    expect(sub[2]).toMatch(/^Browser · 10\.0\.x\.x · Last seen /);
    expect(sub[3]).toMatch(/^iOS · /);
  });

  it('the current session wears the badge and has no revoke button', async () => {
    const { transport } = scriptedTransport({
      [`GET ${PATH}`]: () => json(200, { devices: [device({ current: true }), device({ deviceId: 'd2' })] }),
    });
    await mount(transport);
    expect(qa('.mdev-row')[0]!.textContent).toContain('current');
    expect(q('.mdev-revoke', rows()[0]!)).toBeNull();
    expect(revokeButtons()).toHaveLength(1);
  });

  it('draws the Card chrome with the section title and description; bare draws the list alone', async () => {
    const { transport } = scriptedTransport({ [`GET ${PATH}`]: () => json(200, { devices: [device()] }) });
    await mount(transport);
    expect(q('.mdev-card h4')?.textContent).toBe('Devices');
    expect(q('.mdev-card')?.textContent).toContain('Where you are signed in.');
    cleanupUi();

    await mount(transport, { bare: true });
    expect(q('.mdev-card')).toBeNull();
    expect(rows()).toHaveLength(1);
  });

  it('an empty list says so; a member scope has its own wording', async () => {
    const { transport } = scriptedTransport({ [`GET ${PATH}`]: () => json(200, { devices: [] }) });
    await mount(transport);
    expect(q('.mdev-card')?.textContent).toContain('No active sessions.');
    cleanupUi();

    await mount(transport, { scope: 'member' });
    expect(q('.mdev-card')?.textContent).toContain('This member has no active sessions.');
  });

  it('a 403 is a normal answer for the parental view: the empty state, no error', async () => {
    const { transport } = scriptedTransport({ [`GET ${PATH}`]: () => json(403, {}) });
    await mount(transport, { scope: 'member' });
    expect(q('[role=status]')).toBeNull();
    expect(q('.mdev-card')?.textContent).toContain('This member has no active sessions.');
  });

  it('any other failure names the load error, and a thrown request does too', async () => {
    await mount(scriptedTransport({ [`GET ${PATH}`]: () => json(500, {}) }).transport);
    expect(q('[role=status]')?.textContent).toBe('Could not load the device list.');
    cleanupUi();

    await mount({
      fetch: async () => {
        throw new Error('offline');
      },
    });
    expect(q('[role=status]')?.textContent).toBe('Could not load the device list.');
  });
});

describe('DevicesCard: revoke', () => {
  const list = () => json(200, { devices: [device({ deviceId: 'a/b c' }), device({ deviceId: 'd2', deviceName: 'Tab' })] });

  it('asks first; on yes sends DELETE under the list path with the id encoded, then reloads', async () => {
    let remaining = [device({ deviceId: 'a/b c' }), device({ deviceId: 'd2', deviceName: 'Tab' })];
    const { transport, calls } = scriptedTransport({
      [`GET ${PATH}`]: () => json(200, { devices: remaining }),
      [`DELETE ${PATH}/a%2Fb%20c`]: () => {
        remaining = remaining.filter((d) => d.deviceId !== 'a/b c');
        return json(200, {});
      },
    });
    await mount(transport);
    expect(rows()).toHaveLength(2);

    click(revokeButtons()[0]!);
    await flush();

    expect(confirm).toHaveBeenCalledWith('Log out “Pixel 9”? That device loses access immediately.');
    expect(calls.map((c) => `${c.init?.method ?? 'GET'} ${c.path}`)).toEqual([
      `GET ${PATH}`,
      `DELETE ${PATH}/a%2Fb%20c`,
      `GET ${PATH}`,
    ]);
    expect(rows()).toHaveLength(1);
  });

  it('on no, nothing is sent', async () => {
    confirm.mockReturnValue(false);
    const { transport, calls } = scriptedTransport({ [`GET ${PATH}`]: list });
    await mount(transport);
    click(revokeButtons()[0]!);
    await flush();
    expect(calls).toHaveLength(1); // only the initial read
    expect(rows()).toHaveLength(2);
  });

  it('a refused revoke names the error and keeps the list', async () => {
    const { transport } = scriptedTransport({
      [`GET ${PATH}`]: list,
      [`DELETE ${PATH}/a%2Fb%20c`]: () => json(409, {}),
    });
    await mount(transport);
    click(revokeButtons()[0]!);
    await flush();
    expect(q('[role=status]')?.textContent).toBe('Could not log that device out.');
    expect(rows()).toHaveLength(2);
  });

  it('a thrown revoke names the error too', async () => {
    const { transport } = scriptedTransport({
      [`GET ${PATH}`]: list,
      [`DELETE ${PATH}/a%2Fb%20c`]: () => {
        throw new Error('offline');
      },
    });
    await mount(transport);
    click(revokeButtons()[0]!);
    await flush();
    expect(q('[role=status]')?.textContent).toBe('Could not log that device out.');
  });
});

describe('DevicesCard: the path is the host\'s', () => {
  it('reads and deletes beneath whatever path it is given (the parental view)', async () => {
    const path = '/api/families/f1/members/p1/devices';
    const { transport, calls } = scriptedTransport({
      [`GET ${path}`]: () => json(200, { devices: [device()] }),
      [`DELETE ${path}/d1`]: () => json(200, {}),
    });
    renderUi(<DevicesCard transport={transport} devicesPath={path} scope="member" bare />);
    await flush();
    click(revokeButtons()[0]!);
    await flush();
    expect(calls.map((c) => `${c.init?.method ?? 'GET'} ${c.path}`)).toContain(`DELETE ${path}/d1`);
  });
});
