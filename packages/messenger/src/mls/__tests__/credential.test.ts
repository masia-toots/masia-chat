import { describe, expect, it } from 'vitest';
import {
  CREDENTIAL_IDENTITY_VERSION,
  DeviceRole,
  decodeCredentialIdentity,
  encodeCredentialIdentity,
  decodeId,
  encodeId,
  identityOf,
  isDeviceRole,
  isValidId,
} from '../credential.js';
import { ID_PATTERN, MAX_ID_BYTES } from '../constants.js';
import { MlsEngineErrorCode } from '../mls-error.js';
import { expectCode } from './support/expect-code.js';

const ROLE_CODE = { USER: 1, GUARDIAN: 2, ASSISTANT: 3 } as const;
const MAX_ID = 'x'.repeat(128);
const ROUND_TRIP_RANDOM_CASES = 2000;
const RANDOM_MAX_LENGTH = 24;
const RANDOM_SEED = 0x63726564; // "cred"

/** The canonical bytes, spelled out so the wire form is pinned by a test and not only by the encoder. */
function bytesOf(
  role: number,
  user: string,
  device: string,
  version = CREDENTIAL_IDENTITY_VERSION,
): Uint8Array {
  const text = new TextEncoder();
  return Uint8Array.from([
    version,
    role,
    user.length,
    ...text.encode(user),
    device.length,
    ...text.encode(device),
  ]);
}

describe('credential identity (internal ADR-117 §2; review §1: the role lives in the credential)', () => {
  it('has the documented canonical wire form', () => {
    const encoded = encodeCredentialIdentity({
      userId: 'alice',
      deviceId: 'a1',
      role: DeviceRole.GUARDIAN,
    });
    expect(Array.from(encoded)).toEqual(Array.from(bytesOf(ROLE_CODE.GUARDIAN, 'alice', 'a1')));
  });

  it('round-trips every role', () => {
    for (const role of Object.values(DeviceRole)) {
      const identity = { userId: 'user_1-x', deviceId: 'dev-2_y', role };
      expect(decodeCredentialIdentity(encodeCredentialIdentity(identity))).toEqual(identity);
    }
  });

  it('accepts ids of 1 and of 128 characters', () => {
    const identity = { userId: 'u', deviceId: MAX_ID, role: DeviceRole.USER };
    expect(decodeCredentialIdentity(encodeCredentialIdentity(identity))).toEqual(identity);
  });

  it('refuses to encode an id outside the alphabet or length, and an unknown role', async () => {
    const good = { userId: 'alice', deviceId: 'a1', role: DeviceRole.USER };
    for (const bad of ['', 'x'.repeat(129), 'has space', 'clé', 'a:b', 'a/b', 'a\u0000b']) {
      await expectCode(
        () => encodeCredentialIdentity({ ...good, userId: bad }),
        MlsEngineErrorCode.CREDENTIAL_INVALID,
      );
      await expectCode(
        () => encodeCredentialIdentity({ ...good, deviceId: bad }),
        MlsEngineErrorCode.CREDENTIAL_INVALID,
      );
    }
    await expectCode(
      () => encodeCredentialIdentity({ ...good, role: 'ADMIN' as unknown as DeviceRole }),
      MlsEngineErrorCode.CREDENTIAL_INVALID,
    );
  });

  it('decodes strictly: version, role, truncation, trailing bytes, bad ids', async () => {
    const valid = bytesOf(ROLE_CODE.USER, 'alice', 'a1');
    const mutations: [string, Uint8Array][] = [
      ['empty', new Uint8Array()],
      ['unknown version', bytesOf(ROLE_CODE.USER, 'alice', 'a1', 2)],
      ['role 0', bytesOf(0, 'alice', 'a1')],
      ['role 4', bytesOf(4, 'alice', 'a1')],
      ['truncated', valid.slice(0, valid.length - 1)],
      ['trailing byte', Uint8Array.from([...valid, 0])],
      ['empty user id', bytesOf(ROLE_CODE.USER, '', 'a1')],
      ['empty device id', bytesOf(ROLE_CODE.USER, 'alice', '')],
      ['space in id', bytesOf(ROLE_CODE.USER, 'al ice', 'a1')],
      ['high byte in id', Uint8Array.from([1, 1, 2, 0xc3, 0xa9, 1, 0x61])],
      ['length past the end', Uint8Array.from([1, 1, 200, 0x61, 0x62, 1, 0x61])],
    ];
    for (const [, bytes] of mutations) {
      await expectCode(
        () => decodeCredentialIdentity(bytes),
        MlsEngineErrorCode.CREDENTIAL_INVALID,
      );
    }
  });

  it('has one spelling per identity: whatever decodes encodes back to the same bytes', () => {
    let state = RANDOM_SEED;
    const next = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state;
    };
    let decodedAny = false;
    for (let i = 0; i < ROUND_TRIP_RANDOM_CASES; i += 1) {
      // Biased towards the interesting region: a plausible header, then short noise.
      const length = next() % RANDOM_MAX_LENGTH;
      const bytes = Uint8Array.from({ length }, () => next() & 0xff);
      if (length >= 2) {
        bytes[0] = CREDENTIAL_IDENTITY_VERSION;
        bytes[1] = 1 + (next() % 3);
      }
      try {
        const identity = decodeCredentialIdentity(bytes);
        decodedAny = true;
        expect(Array.from(encodeCredentialIdentity(identity))).toEqual(Array.from(bytes));
      } catch (error) {
        expect((error as { code?: string }).code).toBe(MlsEngineErrorCode.CREDENTIAL_INVALID);
      }
    }
    // The generator is too noisy to hit a valid credential often; make the property non-vacuous.
    for (const sample of [
      bytesOf(1, 'a', 'b'),
      bytesOf(2, 'kid', 'g1'),
      bytesOf(3, 'masia', 'm-1'),
    ]) {
      expect(Array.from(encodeCredentialIdentity(decodeCredentialIdentity(sample)))).toEqual(
        Array.from(sample),
      );
      decodedAny = true;
    }
    expect(decodedAny).toBe(true);
  });

  it('reads the identity of a leaf, and only from a basic credential', async () => {
    const identity = { userId: 'kid', deviceId: 'g1', role: DeviceRole.GUARDIAN };
    const leaf = {
      credential: { credentialType: 'basic', identity: encodeCredentialIdentity(identity) },
    };
    expect(identityOf(leaf)).toEqual(identity);
    await expectCode(
      () => identityOf({ credential: { credentialType: 'x509' } }),
      MlsEngineErrorCode.CREDENTIAL_INVALID,
    );
    await expectCode(
      () => identityOf({ credential: { credentialType: 'basic' } }),
      MlsEngineErrorCode.CREDENTIAL_INVALID,
    );
  });

  it('encodes an id one way: ASCII bytes, valid ids only, and back', async () => {
    expect(Array.from(encodeId('a-B_9'))).toEqual([0x61, 0x2d, 0x42, 0x5f, 0x39]);
    expect(decodeId(encodeId(MAX_ID))).toBe(MAX_ID);
    await expectCode(() => encodeId('has space'), MlsEngineErrorCode.INVALID_ARGUMENT);
    expect(decodeId(new Uint8Array())).toBeUndefined();
    expect(decodeId(new Uint8Array(MAX_ID_BYTES + 1).fill(0x61))).toBeUndefined();
    expect(decodeId(Uint8Array.of(0x61, 0x20))).toBeUndefined(); // 'a ' is outside the alphabet
    expect(decodeId(Uint8Array.of(0xc3, 0xa9))).toBeUndefined(); // UTF-8 for an accented letter
  });

  it('builds the id pattern from the byte cap, so the two cannot disagree', () => {
    expect(ID_PATTERN.test('x'.repeat(MAX_ID_BYTES))).toBe(true);
    expect(ID_PATTERN.test('x'.repeat(MAX_ID_BYTES + 1))).toBe(false);
  });

  it('type guards', () => {
    expect(isDeviceRole('USER')).toBe(true);
    expect(isDeviceRole('toString')).toBe(false); // an inherited property is not a role
    expect(isDeviceRole(1)).toBe(false);
    expect(isValidId('a-b_C9')).toBe(true);
    expect(isValidId('')).toBe(false);
    expect(isValidId(undefined)).toBe(false);
  });
});
