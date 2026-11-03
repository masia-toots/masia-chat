import { describe, expect, it } from 'vitest';
import {
  Actor,
  administersUser,
  CREDENTIAL_IDENTITY_VERSION,
  DEVICE_ROLE_CODES,
  DEVICE_ROLES,
  DeviceRole,
  guardsUser,
  ID_PATTERN,
  isDeviceRole,
  isWireId,
  MAX_ADMIN_OF_USERS,
  MAX_ENVELOPE_BYTES,
  MAX_HANDSHAKE_BYTES,
  MAX_ID_BYTES,
  MlsContentType,
  MlsHeaderError,
  MlsHeaderErrorReason,
  MlsSenderType,
  MlsWireFormat,
  NO_ADMIN_SCOPE,
  parseMlsHeader,
  readRelayTokenClaims,
  introducedTo,
  MAX_REACH_USERS,
  RELAY_TOKEN_TTL_SECONDS,
  RelayTokenClaimsError,
  RelayTokenClaimsErrorReason,
  relayTokenClaims,
} from '../wire/index.js';

const bytes = (text: string): Uint8Array => {
  const clean = text.replaceAll(' ', '');
  const out = new Uint8Array(clean.length / 2);
  for (let index = 0; index < out.length; index += 1) {
    out[index] = Number.parseInt(clean.slice(index * 2, index * 2 + 2), 16);
  }
  return out;
};
const GROUP = bytes('67727031'); // "grp1"

function headerFailure(input: Uint8Array, maxBytes?: number): MlsHeaderError {
  try {
    parseMlsHeader(input, maxBytes);
  } catch (error) {
    if (error instanceof MlsHeaderError) return error;
    throw error;
  }
  throw new Error('expected parseMlsHeader to throw');
}

describe('wire vocabulary', () => {
  it('names no product: the third role is the generic ASSISTANT, still byte code 3', () => {
    expect(DEVICE_ROLES).toEqual(['USER', 'GUARDIAN', 'ASSISTANT']);
    expect(DEVICE_ROLE_CODES).toEqual({ USER: 1, GUARDIAN: 2, ASSISTANT: 3 });
    expect(CREDENTIAL_IDENTITY_VERSION).toBe(1);
    expect(isDeviceRole(DeviceRole.ASSISTANT)).toBe(true);
    for (const value of ['MASIA', 'toString', 'constructor', '', 3, null]) {
      expect(isDeviceRole(value)).toBe(false);
    }
  });

  it('keeps the id alphabet as one pattern', () => {
    expect(ID_PATTERN).toBe(`^[A-Za-z0-9_-]{1,${MAX_ID_BYTES}}$`);
    expect(isWireId('a'.repeat(MAX_ID_BYTES))).toBe(true);
    for (const value of ['', 'a'.repeat(MAX_ID_BYTES + 1), 'a:b', 'a.b', 'a/b', 'é', 7]) {
      expect(isWireId(value)).toBe(false);
    }
  });
});

describe('parseMlsHeader — one parser for engine and relay (literal RFC 9420 vectors)', () => {
  it('reads a PrivateMessage and a PublicMessage', () => {
    expect(parseMlsHeader(bytes('0001 0002 04 67727031 0000000000000007 01 00'))).toEqual({
      wireFormat: MlsWireFormat.PRIVATE_MESSAGE,
      groupId: GROUP,
      epoch: 7n,
      contentType: MlsContentType.APPLICATION,
    });
    expect(
      parseMlsHeader(bytes('0001 0001 04 67727031 000000000000000a 01 00000003 00 03')),
    ).toEqual({
      wireFormat: MlsWireFormat.PUBLIC_MESSAGE,
      groupId: GROUP,
      epoch: 10n,
      contentType: MlsContentType.COMMIT,
      sender: { type: MlsSenderType.MEMBER, index: 3 },
    });
  });

  it('reads a Welcome, a GroupInfo, and a KeyPackage with its inner version and cipher suite', () => {
    expect(parseMlsHeader(bytes('0001 0003 0001 03 010203'))).toEqual({
      wireFormat: MlsWireFormat.WELCOME,
      cipherSuite: 1,
    });
    expect(parseMlsHeader(bytes('0001 0004'))).toEqual({ wireFormat: MlsWireFormat.GROUP_INFO });
    expect(parseMlsHeader(bytes('0001 0005 0001 0001 ff'))).toEqual({
      wireFormat: MlsWireFormat.KEY_PACKAGE,
      cipherSuite: 1,
    });
  });

  it('refuses a KeyPackage that is truncated or not MLS 1.0 inside', () => {
    expect(headerFailure(bytes('0001 0005 ff')).reason).toBe(MlsHeaderErrorReason.TRUNCATED);
    expect(headerFailure(bytes('0001 0005 0002 0001')).reason).toBe(
      MlsHeaderErrorReason.UNSUPPORTED_VERSION,
    );
  });

  it('checks the caller cap first, defaulting to the handshake cap', () => {
    expect(headerFailure(new Uint8Array(MAX_HANDSHAKE_BYTES + 1)).reason).toBe(
      MlsHeaderErrorReason.TOO_LARGE,
    );
    const envelope = headerFailure(new Uint8Array(MAX_ENVELOPE_BYTES + 1), MAX_ENVELOPE_BYTES);
    expect({ reason: envelope.reason, field: envelope.field }).toEqual({
      reason: MlsHeaderErrorReason.TOO_LARGE,
      field: 'message',
    });
  });

  it('refuses a non-minimal length, an unknown wire format and another protocol version', () => {
    expect(headerFailure(bytes('0001 0002 4004 67727031 0000000000000007 01')).reason).toBe(
      MlsHeaderErrorReason.NON_MINIMAL_LENGTH,
    );
    expect(headerFailure(bytes('0001 0009')).reason).toBe(MlsHeaderErrorReason.UNKNOWN_WIRE_FORMAT);
    expect(headerFailure(bytes('0002 0002')).reason).toBe(MlsHeaderErrorReason.UNSUPPORTED_VERSION);
  });
});

describe('relay token claims — built by a host, read by a relay, from one contract', () => {
  const EXPECT = { issuer: 'test-host', audience: 'test-relay' } as const;
  const ISSUED_AT = 1_700_000_000;
  const subject = { userId: 'user_1', deviceId: 'device_1', adminOf: [], guardianOf: [] };
  const tooMany = Array.from({ length: MAX_ADMIN_OF_USERS + 1 }, (_, index) => `u${index}`);

  function refusal(run: () => unknown): RelayTokenClaimsErrorReason {
    try {
      run();
    } catch (error) {
      if (error instanceof RelayTokenClaimsError) return error.reason;
      throw error;
    }
    throw new Error('expected a RelayTokenClaimsError');
  }

  it('round-trips a plain token and an admin token', () => {
    const plain = relayTokenClaims(subject, { ...EXPECT, issuedAt: ISSUED_AT, jti: 'j1' });
    expect(plain).toEqual({
      iss: 'test-host',
      aud: 'test-relay',
      sub: 'user_1',
      did: 'device_1',
      iat: ISSUED_AT,
      exp: ISSUED_AT + RELAY_TOKEN_TTL_SECONDS,
      jti: 'j1',
    });
    expect(readRelayTokenClaims({ ...plain }, EXPECT)).toEqual({
      userId: 'user_1',
      deviceId: 'device_1',
      ...NO_ADMIN_SCOPE,
      reach: [],
    });

    const admin = relayTokenClaims(
      { ...subject, adminOf: ['kid_1', 'adult_1'], guardianOf: ['kid_1'] },
      { ...EXPECT, issuedAt: ISSUED_AT, jti: 'j2' },
    );
    const principal = readRelayTokenClaims({ ...admin }, EXPECT);
    expect(principal.actor).toBe(Actor.FAMILY_ADMIN);
    expect(administersUser(principal, 'adult_1')).toBe(true);
    expect(guardsUser(principal, 'kid_1')).toBe(true);
    expect(guardsUser(principal, 'adult_1')).toBe(false);
  });

  it('carries the host introduction (`reach`) on any token, never the subject, bounded', () => {
    const at = { ...EXPECT, issuedAt: ISSUED_AT, jti: 'j3' };
    const claims = relayTokenClaims({ ...subject, reach: ['friend_1', 'user_1', 'friend_1'] }, at);
    expect(claims.reach).toEqual(['friend_1']);
    expect(claims.role).toBeUndefined();
    const principal = readRelayTokenClaims({ ...claims }, EXPECT);
    expect(introducedTo(principal, 'friend_1')).toBe(true);
    expect(introducedTo(principal, 'stranger')).toBe(false);
    expect(administersUser(principal, 'friend_1')).toBe(false);
    expect(relayTokenClaims({ ...subject, reach: [] }, at).reach).toBeUndefined();
    const over = Array.from({ length: MAX_REACH_USERS + 1 }, (_, index) => `r${index}`);
    expect(refusal(() => relayTokenClaims({ ...subject, reach: over }, at))).toBe(
      RelayTokenClaimsErrorReason.BAD_USER_LIST,
    );
    const good = { ...relayTokenClaims(subject, at) };
    for (const bad of [over, 'friend_1', ['a b']]) {
      expect(refusal(() => readRelayTokenClaims({ ...good, reach: bad }, EXPECT))).toBe(
        RelayTokenClaimsErrorReason.BAD_USER_LIST,
      );
    }
  });

  it('has no default issuer or audience: an empty pair is refused on both sides', () => {
    const empty = { issuer: '', audience: ' ' };
    expect(refusal(() => relayTokenClaims(subject, { ...empty, issuedAt: 1, jti: 'j' }))).toBe(
      RelayTokenClaimsErrorReason.BAD_EXPECTATIONS,
    );
    expect(refusal(() => readRelayTokenClaims({}, empty))).toBe(
      RelayTokenClaimsErrorReason.BAD_EXPECTATIONS,
    );
  });

  it('refuses what a relay must refuse', () => {
    const good = { ...relayTokenClaims(subject, { ...EXPECT, issuedAt: ISSUED_AT, jti: 'j' }) };
    const admin = { ...good, role: Actor.FAMILY_ADMIN };
    const cases: [Record<string, unknown>, RelayTokenClaimsErrorReason][] = [
      [{ ...good, iss: 'other' }, RelayTokenClaimsErrorReason.WRONG_ISSUER],
      [{ ...good, aud: ['test-relay'] }, RelayTokenClaimsErrorReason.WRONG_AUDIENCE],
      [
        { ...good, exp: ISSUED_AT + RELAY_TOKEN_TTL_SECONDS + 1 },
        RelayTokenClaimsErrorReason.BAD_LIFETIME,
      ],
      [{ ...good, iat: undefined }, RelayTokenClaimsErrorReason.BAD_LIFETIME],
      [{ ...good, sub: 'a:b' }, RelayTokenClaimsErrorReason.BAD_SUBJECT],
      [{ ...good, did: '' }, RelayTokenClaimsErrorReason.BAD_DEVICE],
      [{ ...good, role: 'ROOT' }, RelayTokenClaimsErrorReason.BAD_ROLE],
      [{ ...good, adminOf: ['user_2'] }, RelayTokenClaimsErrorReason.BAD_USER_LIST],
      [{ ...admin, adminOf: 'user_2' }, RelayTokenClaimsErrorReason.BAD_USER_LIST],
      [{ ...admin, guardianOf: tooMany }, RelayTokenClaimsErrorReason.BAD_USER_LIST],
    ];
    for (const [payload, reason] of cases) {
      expect(refusal(() => readRelayTokenClaims(payload, EXPECT))).toBe(reason);
    }
  });

  it('refuses at minting what a relay would refuse', () => {
    const at = { ...EXPECT, issuedAt: ISSUED_AT, jti: 'j' };
    expect(refusal(() => relayTokenClaims({ ...subject, userId: 'a b' }, at))).toBe(
      RelayTokenClaimsErrorReason.BAD_SUBJECT,
    );
    expect(refusal(() => relayTokenClaims({ ...subject, deviceId: 'x'.repeat(129) }, at))).toBe(
      RelayTokenClaimsErrorReason.BAD_DEVICE,
    );
    expect(refusal(() => relayTokenClaims({ ...subject, adminOf: tooMany }, at))).toBe(
      RelayTokenClaimsErrorReason.BAD_USER_LIST,
    );
  });
});
