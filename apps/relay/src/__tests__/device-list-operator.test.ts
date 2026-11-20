import { DeviceRole, RelayErrorCode } from '@masia/relay';
import { describe, expect, it } from 'vitest';
import type { Database } from '../db.js';
import { putDeviceList } from '../domain/device-lists.js';

/**
 * ADR-212 §13: «assistant» means the operator, everywhere. The relay refuses an ASSISTANT entry on any
 * other account's list before it touches the database (the database suite covers the stored side), so
 * a member cannot list a device of their own as Masia and wear her badge in a room.
 */
const untouchable = {
  transaction: () => Promise.reject(new Error('the database must not be reached')),
} as unknown as Database;

const key = Buffer.alloc(32, 1).toString('base64');
const proposal = (role: DeviceRole, conversationId?: string) => ({
  version: 2,
  devices: [
    { id: 'phone', role: DeviceRole.USER, signatureKey: key },
    { id: 'seat', role, signatureKey: key, ...(conversationId ? { conversationId } : {}) },
  ],
  signature: Buffer.alloc(64, 2),
});

describe('putDeviceList — an ASSISTANT entry belongs on the operator’s list only', () => {
  it('refuses one on a person’s list (422 DEVICE_LIST_ENTRY_INVALID)', async () => {
    await expect(
      putDeviceList(untouchable, 'alice', proposal(DeviceRole.ASSISTANT, 'room-1'), 'operator'),
    ).rejects.toMatchObject({ code: RelayErrorCode.DEVICE_LIST_ENTRY_INVALID });
  });

  it('refuses one when no operator is configured at all', async () => {
    await expect(
      putDeviceList(untouchable, 'alice', proposal(DeviceRole.ASSISTANT, 'room-1'), null),
    ).rejects.toMatchObject({ code: RelayErrorCode.DEVICE_LIST_ENTRY_INVALID });
  });

  it('lets the operator’s own list through to the version check', async () => {
    await expect(
      putDeviceList(untouchable, 'operator', proposal(DeviceRole.ASSISTANT, 'room-1'), 'operator'),
    ).rejects.toThrow('the database must not be reached');
  });
});
