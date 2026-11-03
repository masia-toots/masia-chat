import type { webcrypto } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DEVICE_LIST_ERRORS,
  DEVICE_LIST_FORMAT,
  DeviceListError,
  decodeBase64,
  deviceListSigningBytes,
  ED25519_PUBLIC_KEY_BYTES,
  ED25519_SIGNATURE_BYTES,
  ed25519,
  encodeBase64,
  verifyDeviceListSignature,
} from '../device-list.js';
import type { DeviceListEntry } from '../relay-api.js';
import { DeviceRole, MAX_DEVICES_PER_USER } from '../vocabulary.js';

const KEY_A = encodeBase64(new Uint8Array(ED25519_PUBLIC_KEY_BYTES).fill(1));
const KEY_B = encodeBase64(new Uint8Array(ED25519_PUBLIC_KEY_BYTES).fill(2));

const person = (id: string, signatureKey = KEY_A): DeviceListEntry => ({
  id,
  role: DeviceRole.USER,
  signatureKey,
});
const assistant = (id: string, conversationId = 'room-1'): DeviceListEntry => ({
  id,
  role: DeviceRole.ASSISTANT,
  signatureKey: KEY_B,
  conversationId,
});

async function identity(): Promise<{ publicKey: Uint8Array; sign: (bytes: Uint8Array) => Promise<Uint8Array> }> {
  const pair = (await crypto.subtle.generateKey(ed25519(), true, ['sign', 'verify'])) as webcrypto.CryptoKeyPair;
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return {
    publicKey,
    sign: async (bytes) => new Uint8Array(await crypto.subtle.sign(ed25519(), pair.privateKey, bytes)),
  };
}

function codeOf(action: () => unknown): string | null {
  try {
    action();
    return null;
  } catch (error) {
    return error instanceof DeviceListError ? error.code : 'NOT_A_DEVICE_LIST_ERROR';
  }
}

async function rejectionOf(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    return error instanceof DeviceListError ? error.code : 'NOT_A_DEVICE_LIST_ERROR';
  }
}

describe('deviceListSigningBytes: the one canonical encoding of mls-device-list/v1', () => {
  it('is a fixed-order JSON of the format tag, the owner, the version and the entries sorted by id', () => {
    const text = new TextDecoder().decode(
      deviceListSigningBytes('alice', 3, [person('b-phone'), person('a-tablet')]),
    );
    expect(text).toBe(
      JSON.stringify({
        format: DEVICE_LIST_FORMAT,
        userId: 'alice',
        version: 3,
        devices: [
          { id: 'a-tablet', role: 'USER', signatureKey: KEY_A },
          { id: 'b-phone', role: 'USER', signatureKey: KEY_A },
        ],
      }),
    );
  });

  it('puts an ASSISTANT conversation inside the signed bytes and never invents one for a person', () => {
    const text = new TextDecoder().decode(
      deviceListSigningBytes('masia', 1, [assistant('seat-1', 'room-9'), person('a')]),
    );
    expect(text).toContain('"conversationId":"room-9"');
    expect(text.match(/conversationId/g)).toHaveLength(1);
  });

  it('does not depend on the order the entries were given in', () => {
    const entries = [person('c'), person('a'), person('b')];
    expect(deviceListSigningBytes('alice', 1, entries)).toEqual(
      deviceListSigningBytes('alice', 1, [...entries].reverse()),
    );
  });

  it('refuses what no member would accept (MALFORMED), before anything is signed', () => {
    expect(codeOf(() => deviceListSigningBytes('u', 1, [person('a'), person('a')]))).toBe(
      DEVICE_LIST_ERRORS.MALFORMED,
    );
    expect(codeOf(() => deviceListSigningBytes('u', 1, [person('a', encodeBase64(new Uint8Array(31)))]))).toBe(
      DEVICE_LIST_ERRORS.MALFORMED,
    );
    expect(codeOf(() => deviceListSigningBytes('u', 1, [person('a', 'not base64!')]))).toBe(
      DEVICE_LIST_ERRORS.MALFORMED,
    );
    // An ASSISTANT without its room, and a person with one.
    expect(
      codeOf(() => deviceListSigningBytes('u', 1, [{ ...assistant('a'), conversationId: undefined }])),
    ).toBe(DEVICE_LIST_ERRORS.MALFORMED);
    expect(codeOf(() => deviceListSigningBytes('u', 1, [{ ...person('a'), conversationId: 'room-1' }]))).toBe(
      DEVICE_LIST_ERRORS.MALFORMED,
    );
    expect(
      codeOf(() => deviceListSigningBytes('u', 1, [{ ...person('a'), role: 'ROOT' as DeviceRole }])),
    ).toBe(DEVICE_LIST_ERRORS.MALFORMED);
    const tooMany = Array.from({ length: MAX_DEVICES_PER_USER + 1 }, (_unused, index) => person(`d${index}`));
    expect(codeOf(() => deviceListSigningBytes('u', 1, tooMany))).toBe(DEVICE_LIST_ERRORS.MALFORMED);
  });

  it('writes a key the same way however its base64 was spelled', () => {
    const bytes = decodeBase64(KEY_A);
    expect(bytes).not.toBeNull();
    expect(encodeBase64(bytes ?? new Uint8Array())).toBe(KEY_A);
    expect(decodeBase64('%%%')).toBeNull();
  });
});

describe('verifyDeviceListSignature: the one signature check, shared by clients and relay', () => {
  const devices = [person('a-phone'), assistant('seat-1')];

  it('accepts the owner signature and answers the bytes that were signed', async () => {
    const owner = await identity();
    const signature = await owner.sign(deviceListSigningBytes('alice', 2, devices));
    const bytes = await verifyDeviceListSignature(owner.publicKey, {
      userId: 'alice',
      version: 2,
      devices,
      signature,
    });
    expect(bytes).toEqual(deviceListSigningBytes('alice', 2, devices));
  });

  it('refuses a signature moved to another owner, version or contents, and another key', async () => {
    const owner = await identity();
    const stranger = await identity();
    const signature = await owner.sign(deviceListSigningBytes('alice', 2, devices));
    const base = { userId: 'alice', version: 2, devices, signature };
    expect(await rejectionOf(verifyDeviceListSignature(stranger.publicKey, base))).toBe(
      DEVICE_LIST_ERRORS.BAD_SIGNATURE,
    );
    expect(await rejectionOf(verifyDeviceListSignature(owner.publicKey, { ...base, userId: 'bob' }))).toBe(
      DEVICE_LIST_ERRORS.BAD_SIGNATURE,
    );
    expect(await rejectionOf(verifyDeviceListSignature(owner.publicKey, { ...base, version: 3 }))).toBe(
      DEVICE_LIST_ERRORS.BAD_SIGNATURE,
    );
    expect(
      await rejectionOf(verifyDeviceListSignature(owner.publicKey, { ...base, devices: [person('a-phone')] })),
    ).toBe(DEVICE_LIST_ERRORS.BAD_SIGNATURE);
  });

  it('refuses junk of the wrong size, zeros and a key that is not a curve point', async () => {
    const owner = await identity();
    const base = { userId: 'alice', version: 1, devices };
    for (const signature of [
      new Uint8Array(0),
      new Uint8Array(ED25519_SIGNATURE_BYTES - 1),
      new Uint8Array(ED25519_SIGNATURE_BYTES + 1),
      new Uint8Array(ED25519_SIGNATURE_BYTES),
    ]) {
      expect(await rejectionOf(verifyDeviceListSignature(owner.publicKey, { ...base, signature }))).toBe(
        DEVICE_LIST_ERRORS.BAD_SIGNATURE,
      );
    }
    const signature = new Uint8Array(ED25519_SIGNATURE_BYTES).fill(7);
    expect(
      await rejectionOf(verifyDeviceListSignature(new Uint8Array(ED25519_PUBLIC_KEY_BYTES - 1), { ...base, signature })),
    ).toBe(DEVICE_LIST_ERRORS.BAD_SIGNATURE);
    expect(
      await rejectionOf(verifyDeviceListSignature(new Uint8Array(ED25519_PUBLIC_KEY_BYTES).fill(0xff), { ...base, signature })),
    ).toBe(DEVICE_LIST_ERRORS.BAD_SIGNATURE);
  });

  it('calls a version below 1 and unencodable entries MALFORMED, not a bad signature', async () => {
    const owner = await identity();
    const signature = new Uint8Array(ED25519_SIGNATURE_BYTES);
    for (const version of [0, -1, 1.5, Number.NaN]) {
      expect(
        await rejectionOf(verifyDeviceListSignature(owner.publicKey, { userId: 'alice', version, devices, signature })),
      ).toBe(DEVICE_LIST_ERRORS.MALFORMED);
    }
    expect(
      await rejectionOf(
        verifyDeviceListSignature(owner.publicKey, {
          userId: 'alice',
          version: 1,
          devices: [person('a'), person('a')],
          signature,
        }),
      ),
    ).toBe(DEVICE_LIST_ERRORS.MALFORMED);
  });
});
