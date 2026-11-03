/**
 * The one device-list verifier (canon section 3, ADR-117 amendment (і)): signature under the pinned
 * identity key, owner, rollback, and the ASSISTANT binding inside the signed bytes.
 */
import { describe, expect, it } from 'vitest';
import {
  DEVICE_LIST_ERRORS,
  DeviceRole,
  generateIdentityKeyPair,
  signDeviceList,
  verifyDeviceList,
  type ListedDevice,
} from '../index.js';

const key = (fill: number) => new Uint8Array(32).fill(fill);
const phone: ListedDevice = { deviceId: 'dev-phone', role: DeviceRole.USER, signatureKey: key(1) };
const laptop: ListedDevice = {
  deviceId: 'dev-laptop',
  role: DeviceRole.USER,
  signatureKey: key(2),
};

async function owner() {
  const identity = await generateIdentityKeyPair();
  const sign = (version: number, devices: readonly ListedDevice[], userId = 'alice') =>
    signDeviceList(identity.privateKeyPkcs8, { userId, version, devices });
  return { identity, sign, firstPin: { identityKey: identity.publicKey, version: 0 } };
}

describe('verifyDeviceList', () => {
  it('accepts v1, then v2 with a second device, and advances the pin', async () => {
    const alice = await owner();
    const v1 = await verifyDeviceList('alice', await alice.sign(1, [phone]), alice.firstPin);
    expect(v1.list.devices.map((d) => d.deviceId)).toEqual(['dev-phone']);
    const v2 = await verifyDeviceList('alice', await alice.sign(2, [phone, laptop]), v1.pin);
    expect(v2.pin.version).toBe(2);
    expect(v2.list.devices).toHaveLength(2);
  });

  it('refuses a list signed by another key, a forged entry, or another owner', async () => {
    const alice = await owner();
    const mallory = await owner();
    await expect(
      verifyDeviceList('alice', await mallory.sign(1, [phone]), alice.firstPin),
    ).rejects.toMatchObject({ code: DEVICE_LIST_ERRORS.BAD_SIGNATURE });
    const signed = await alice.sign(1, [phone]);
    const ghost = { ...signed, devices: [...signed.devices, laptop] }; // a server adds a device
    await expect(verifyDeviceList('alice', ghost, alice.firstPin)).rejects.toMatchObject({
      code: DEVICE_LIST_ERRORS.BAD_SIGNATURE,
    });
    await expect(
      verifyDeviceList('alice', await alice.sign(1, [phone], 'bob'), alice.firstPin),
    ).rejects.toMatchObject({ code: DEVICE_LIST_ERRORS.OWNER_MISMATCH });
  });

  it('refuses a rollback: an older version, or the same version with other contents', async () => {
    const alice = await owner();
    const v1 = await verifyDeviceList(
      'alice',
      await alice.sign(1, [phone, laptop]),
      alice.firstPin,
    );
    const v2 = await verifyDeviceList('alice', await alice.sign(2, [phone]), v1.pin); // laptop revoked
    await expect(
      verifyDeviceList('alice', await alice.sign(1, [phone, laptop]), v2.pin),
    ).rejects.toMatchObject({ code: DEVICE_LIST_ERRORS.ROLLBACK });
    await expect(
      verifyDeviceList('alice', await alice.sign(2, [phone, laptop]), v2.pin),
    ).rejects.toMatchObject({ code: DEVICE_LIST_ERRORS.ROLLBACK });
    // The same version served again is fine (idempotent refresh).
    await expect(
      verifyDeviceList('alice', await alice.sign(2, [phone]), v2.pin),
    ).resolves.toBeDefined();
  });

  it('binds an ASSISTANT entry to its conversation inside the signed bytes', async () => {
    const operator = await owner();
    const assistant: ListedDevice = {
      deviceId: 'asst-1',
      role: DeviceRole.ASSISTANT,
      signatureKey: key(3),
      conversationId: 'conv-1',
    };
    const signed = await operator.sign(1, [assistant], 'operator');
    const ok = await verifyDeviceList('operator', signed, operator.firstPin);
    expect(ok.list.devices[0]?.conversationId).toBe('conv-1');
    const moved = { ...signed, devices: [{ ...assistant, conversationId: 'conv-2' }] };
    await expect(verifyDeviceList('operator', moved, operator.firstPin)).rejects.toMatchObject({
      code: DEVICE_LIST_ERRORS.BAD_SIGNATURE,
    });
    await expect(
      operator.sign(1, [{ ...assistant, conversationId: undefined }], 'operator'),
    ).rejects.toMatchObject({ code: DEVICE_LIST_ERRORS.MALFORMED });
  });
});
