/**
 * The security-state view-model: the security code's format (what two people compare) and the proof
 * that the view-model's roles are the engine's roles. Pure data, no React.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import { DeviceRole } from '../../mls/credential.js';
import {
  EPOCH_AUTHENTICATOR_GROUP_LENGTH,
  EPOCH_AUTHENTICATOR_GROUPS,
  epochAuthenticatorGroups,
  formatEpochAuthenticator,
  type SecurityDeviceRole,
} from '../security-state.js';

const SHOWN_BYTES = (EPOCH_AUTHENTICATOR_GROUPS * EPOCH_AUTHENTICATOR_GROUP_LENGTH) / 2;

describe('formatEpochAuthenticator', () => {
  it('writes the first 16 bytes as 8 groups of 4 upper-case hex digits', () => {
    const bytes = Uint8Array.from({ length: 32 }, (_, i) => i * 8 + 1);
    const code = formatEpochAuthenticator(bytes);
    expect(code).toBe('0109 1119 2129 3139 4149 5159 6169 7179');
    const groups = code.split(' ');
    expect(groups).toHaveLength(EPOCH_AUTHENTICATOR_GROUPS);
    for (const group of groups) expect(group).toMatch(/^[0-9A-F]{4}$/);
  });

  it('pins a known value (a change of format is a decision, not a refactor)', () => {
    const bytes = Uint8Array.from([
      0xa1, 0xb2, 0xc3, 0xd4, 0xe5, 0xf6, 0x07, 0x18, 0x29, 0x3a, 0x4b, 0x5c, 0x6d, 0x7e, 0x8f,
      0x90, 0xff,
    ]);
    expect(formatEpochAuthenticator(bytes)).toBe('A1B2 C3D4 E5F6 0718 293A 4B5C 6D7E 8F90');
  });

  it('pads single-digit bytes so no group is short', () => {
    expect(formatEpochAuthenticator(new Uint8Array(SHOWN_BYTES))).toBe(
      Array(EPOCH_AUTHENTICATOR_GROUPS)
        .fill('0'.repeat(EPOCH_AUTHENTICATOR_GROUP_LENGTH))
        .join(' '),
    );
  });

  it('refuses fewer bytes than a full code (a short value would look like a code and prove little)', () => {
    expect(() => formatEpochAuthenticator(new Uint8Array(SHOWN_BYTES - 1))).toThrow(RangeError);
  });

  it('is the same for the same bytes and different for different bytes', () => {
    const a = new Uint8Array(SHOWN_BYTES).fill(1);
    const b = new Uint8Array(SHOWN_BYTES).fill(1);
    b[SHOWN_BYTES - 1] = 2;
    expect(formatEpochAuthenticator(a)).toBe(formatEpochAuthenticator(Uint8Array.from(a)));
    expect(formatEpochAuthenticator(a)).not.toBe(formatEpochAuthenticator(b));
  });
});

describe('epochAuthenticatorGroups', () => {
  it('splits a formatted code on whitespace', () => {
    expect(epochAuthenticatorGroups('A1B2 C3D4  E5F6\n0718')).toEqual([
      'A1B2',
      'C3D4',
      'E5F6',
      '0718',
    ]);
  });

  it('treats a value without spaces as one group and an empty value as none', () => {
    expect(epochAuthenticatorGroups('A1B2C3D4')).toEqual(['A1B2C3D4']);
    expect(epochAuthenticatorGroups('')).toEqual([]);
  });
});

describe('SecurityDeviceRole', () => {
  it('is exactly the wire DeviceRole, which the engine re-exports (one home: @masia/contracts/wire)', () => {
    expectTypeOf<SecurityDeviceRole>().toEqualTypeOf<DeviceRole>();
    expect(Object.values(DeviceRole).sort()).toEqual(['ASSISTANT', 'GUARDIAN', 'USER']);
  });
});
