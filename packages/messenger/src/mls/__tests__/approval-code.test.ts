/**
 * The second-device approval code (canon section 3): deterministic, names one device, and survives the
 * way a person types it.
 */
import { describe, expect, it } from 'vitest';
import {
  APPROVAL_CODE_DIGITS,
  deviceApprovalCode,
  formatApprovalCode,
  parseApprovalCode,
} from '../index.js';

const key = (fill: number) => new Uint8Array(32).fill(fill);
const device = { userId: 'alice', deviceId: 'dev-new', signatureKey: key(7) };

describe('deviceApprovalCode', () => {
  it('is APPROVAL_CODE_DIGITS decimal digits and the same for the same device', async () => {
    const first = await deviceApprovalCode(device);
    expect(first).toMatch(new RegExp(`^\\d{${APPROVAL_CODE_DIGITS}}$`));
    expect(await deviceApprovalCode({ ...device, signatureKey: key(7) })).toBe(first);
  });

  it('changes with the user, the device id and the signature key', async () => {
    const base = await deviceApprovalCode(device);
    const others = await Promise.all([
      deviceApprovalCode({ ...device, userId: 'bob' }),
      deviceApprovalCode({ ...device, deviceId: 'dev-other' }),
      deviceApprovalCode({ ...device, signatureKey: key(8) }),
    ]);
    for (const other of others) expect(other).not.toBe(base);
    expect(new Set(others).size).toBe(others.length);
  });

  it('spreads over the whole range (no bucket of a hundred random devices repeats)', async () => {
    const codes = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        deviceApprovalCode({ userId: 'alice', deviceId: `dev-${i}`, signatureKey: key(i) }),
      ),
    );
    expect(new Set(codes).size).toBe(100);
  });
});

describe('formatApprovalCode / parseApprovalCode', () => {
  it('shows a code in groups of four and reads back what a person types', () => {
    expect(formatApprovalCode('1234567890123456')).toBe('1234 5678 9012 3456');
    expect(parseApprovalCode('1234 5678 9012 3456')).toBe('1234567890123456');
    expect(parseApprovalCode(' 1234-5678-9012-3456 ')).toBe('1234567890123456');
    expect(parseApprovalCode('1234.5678.9012.3456')).toBe('1234567890123456');
  });

  it('refuses a wrong length or a non-digit', () => {
    expect(parseApprovalCode('123456789012345')).toBeUndefined();
    expect(parseApprovalCode('12345678901234567')).toBeUndefined();
    expect(parseApprovalCode('1234 5678 9012 345a')).toBeUndefined();
    expect(parseApprovalCode('')).toBeUndefined();
  });
});
