import {
  Actor,
  MAX_ADMIN_OF_USERS,
  RELAY_TOKEN_CLOCK_TOLERANCE_SECONDS,
  RELAY_TOKEN_TTL_SECONDS,
  RelayErrorCode,
} from '@masia/relay';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyAccessToken } from '../auth.js';
import { buildServer } from '../server.js';
import { tokenKeyringOf } from '../token-keys.js';
import {
  databaseSuite,
  expectStatus,
  generateTestKeyPair,
  signHs256TestToken,
  signTestToken,
  TEST_KEY_PAIR,
  TEST_TOKEN_KEYS,
  unusedDatabase,
  TEST_TOKEN_EXPECTATIONS,
  TEST_VERIFY,
} from './support/harness.js';

/** A token whose header says `alg: none` and which has no signature: the classic forgery. */
function unsignedToken(): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const iat = Math.floor(Date.now() / 1000);
  return `${part({ alg: 'none', typ: 'JWT', kid: TEST_KEY_PAIR.kid })}.${part({
    iss: TEST_TOKEN_EXPECTATIONS.issuer,
    aud: TEST_TOKEN_EXPECTATIONS.audience,
    sub: 'alice',
    did: 'alice-phone',
    iat,
    exp: iat + 600,
  })}.`;
}

/** The trusted public key's own bytes: what a key-confusion attack uses as an HMAC secret. */
function publicKeyBytes(): Uint8Array {
  return TEST_KEY_PAIR.publicKey.export({ type: 'spki', format: 'der' });
}

describe('verifyAccessToken', () => {
  it('reads the user, the device and no elevated actor from an ordinary token', async () => {
    const token = await signTestToken({ sub: 'alice', did: 'alice-phone' });
    await expect(verifyAccessToken(token, TEST_TOKEN_KEYS, TEST_VERIFY)).resolves.toEqual({
      userId: 'alice',
      deviceId: 'alice-phone',
      actor: null,
      adminOf: [],
      guardianOf: [],
      reach: [],
    });
  });

  it('reads the FAMILY_ADMIN claim, which on its own covers nobody (security review 2026-10-10 §4)', async () => {
    const token = await signTestToken({ sub: 'dad', did: 'dad-phone', role: Actor.FAMILY_ADMIN });
    await expect(verifyAccessToken(token, TEST_TOKEN_KEYS, TEST_VERIFY)).resolves.toEqual({
      userId: 'dad',
      deviceId: 'dad-phone',
      actor: Actor.FAMILY_ADMIN,
      adminOf: [],
      guardianOf: [],
      reach: [],
    });
  });

  it('reads the adminOf list of a FAMILY_ADMIN token, in order', async () => {
    const token = await signTestToken({
      sub: 'dad',
      did: 'dad-phone',
      role: Actor.FAMILY_ADMIN,
      adminOf: ['dad', 'kid-1', 'kid-2'],
    });
    await expect(verifyAccessToken(token, TEST_TOKEN_KEYS, TEST_VERIFY)).resolves.toEqual({
      userId: 'dad',
      deviceId: 'dad-phone',
      actor: Actor.FAMILY_ADMIN,
      adminOf: ['dad', 'kid-1', 'kid-2'],
      guardianOf: [],
      reach: [],
    });
  });

  it('reads the guardianOf list beside adminOf: the minors whose guardian devices the token may drive', async () => {
    const token = await signTestToken({
      sub: 'mum',
      did: 'mum-guardian',
      role: Actor.FAMILY_ADMIN,
      adminOf: ['kid-1', 'kid-2'],
      guardianOf: ['kid-2'],
    });
    await expect(verifyAccessToken(token, TEST_TOKEN_KEYS, TEST_VERIFY)).resolves.toEqual({
      userId: 'mum',
      deviceId: 'mum-guardian',
      actor: Actor.FAMILY_ADMIN,
      adminOf: ['kid-1', 'kid-2'],
      guardianOf: ['kid-2'],
      reach: [],
    });
  });

  it('checks the issuer and audience the relay is configured with, and nothing else', async () => {
    const staged = { issuer: 'staging-api', audience: 'staging-relay' };
    const staging = await signTestToken({ sub: 'alice', did: 'alice-phone' }, staged);
    await expect(
      verifyAccessToken(staging, TEST_TOKEN_KEYS, { expect: staged }),
    ).resolves.toMatchObject({ userId: 'alice' });
    // A token for the test pair is a token for ANOTHER relay here, and the reverse.
    const production = await signTestToken({ sub: 'alice', did: 'alice-phone' });
    await expect(
      verifyAccessToken(production, TEST_TOKEN_KEYS, { expect: staged }),
    ).rejects.toMatchObject({
      code: RelayErrorCode.UNAUTHENTICATED,
    });
    await expect(verifyAccessToken(staging, TEST_TOKEN_KEYS, TEST_VERIFY)).rejects.toMatchObject({
      code: RelayErrorCode.UNAUTHENTICATED,
    });
  });

  describe(`tolerates ${RELAY_TOKEN_CLOCK_TOLERANCE_SECONDS} s of clock skew between the host and the relay`, () => {
    const claims = { sub: 'alice', did: 'alice-phone' };
    const nowSeconds = () => Math.floor(Date.now() / 1000);
    const WITHIN = RELAY_TOKEN_CLOCK_TOLERANCE_SECONDS - 10;
    const BEYOND = RELAY_TOKEN_CLOCK_TOLERANCE_SECONDS + 30;

    it('accepts a token issued a little in the future (a host clock ahead) and one just expired', async () => {
      const ahead = await signTestToken(claims, { issuedAt: nowSeconds() + WITHIN });
      await expect(verifyAccessToken(ahead, TEST_TOKEN_KEYS, TEST_VERIFY)).resolves.toMatchObject({
        userId: 'alice',
      });
      const justExpired = await signTestToken(claims, { expiresInSeconds: -WITHIN });
      await expect(
        verifyAccessToken(justExpired, TEST_TOKEN_KEYS, TEST_VERIFY),
      ).resolves.toMatchObject({
        userId: 'alice',
      });
    });

    it('refuses a token issued further in the future, and one expired longer ago', async () => {
      const ahead = await signTestToken(claims, { issuedAt: nowSeconds() + BEYOND });
      await expect(verifyAccessToken(ahead, TEST_TOKEN_KEYS, TEST_VERIFY)).rejects.toMatchObject({
        code: RelayErrorCode.UNAUTHENTICATED,
      });
      const expired = await signTestToken(claims, { expiresInSeconds: -BEYOND });
      await expect(verifyAccessToken(expired, TEST_TOKEN_KEYS, TEST_VERIFY)).rejects.toMatchObject({
        code: RelayErrorCode.UNAUTHENTICATED,
      });
    });
  });

  it('accepts exactly MAX_ADMIN_OF_USERS users in adminOf', async () => {
    const adminOf = Array.from({ length: MAX_ADMIN_OF_USERS }, (_, index) => `user-${index}`);
    const token = await signTestToken({
      sub: 'dad',
      did: 'dad-phone',
      role: Actor.FAMILY_ADMIN,
      adminOf,
    });
    await expect(verifyAccessToken(token, TEST_TOKEN_KEYS, TEST_VERIFY)).resolves.toMatchObject({
      adminOf,
    });
  });

  it('accepts a token that lives exactly as long as the contract allows', async () => {
    const token = await signTestToken(
      { sub: 'alice', did: 'alice-phone' },
      { expiresInSeconds: RELAY_TOKEN_TTL_SECONDS },
    );
    await expect(verifyAccessToken(token, TEST_TOKEN_KEYS, TEST_VERIFY)).resolves.toMatchObject({
      userId: 'alice',
    });
  });

  describe('refuses with the one UNAUTHENTICATED answer a token that is', () => {
    const other = generateTestKeyPair();
    const claims = { sub: 'a', did: 'd' };

    it.each([
      // Signature and key.
      [
        'signed by a key the relay does not trust, under the trusted key id',
        () => signTestToken(claims, { key: other.privateKey }),
      ],
      [
        "signed by an unknown key, under that key's own id",
        () => signTestToken(claims, { key: other.privateKey, kid: other.kid }),
      ],
      [
        'named by a key id the relay does not know',
        () => signTestToken(claims, { kid: 'ffffffffffffffff' }),
      ],
      ['without a key id', () => signTestToken(claims, { kid: null })],
      // The retired scheme and the classic forgeries.
      [
        'HS256 under a shared secret, otherwise well-formed',
        () =>
          signHs256TestToken(
            claims,
            new TextEncoder().encode('relay-test-secret-0123456789-abcdefghijklmnop'),
          ),
      ],
      [
        "HS256 under the trusted public key's own bytes (key confusion)",
        () => signHs256TestToken(claims, publicKeyBytes()),
      ],
      ['unsigned (alg none)', () => Promise.resolve(unsignedToken())],
      ['not a token at all', () => Promise.resolve('garbage')],
      // Issuer and audience.
      ['for another audience', () => signTestToken(claims, { audience: 'some-other-service' })],
      [
        'for a list of audiences that merely contains ours',
        () =>
          signTestToken(claims, {
            audience: [TEST_TOKEN_EXPECTATIONS.audience, 'some-other-service'],
          }),
      ],
      ['without an audience', () => signTestToken(claims, { audience: null })],
      ['from another issuer', () => signTestToken(claims, { issuer: 'some-other-issuer' })],
      ['without an issuer', () => signTestToken(claims, { issuer: null })],
      // Time.
      ['expired', () => signTestToken(claims, { expiresInSeconds: -60 })],
      ['without an expiry', () => signTestToken(claims, { expiresInSeconds: null })],
      ['without an issue time', () => signTestToken(claims, { issuedAt: null })],
      [
        'claiming a longer life than the contract allows',
        () => signTestToken(claims, { expiresInSeconds: RELAY_TOKEN_TTL_SECONDS + 1 }),
      ],
      // Subject and device.
      ['without a user', () => signTestToken({ did: 'd' })],
      ['without a device', () => signTestToken({ sub: 'a' })],
      ['with an empty device', () => signTestToken({ sub: 'a', did: '' })],
      ['with an over-long device', () => signTestToken({ sub: 'a', did: 'd'.repeat(129) })],
      // Role and admin reach.
      [
        'with a role the relay does not know',
        () => signTestToken({ sub: 'a', did: 'd', role: 'SUPERUSER' }),
      ],
      // A malformed grant must not quietly become a narrower one: refuse the whole token.
      [
        'with an adminOf but no admin role',
        () => signTestToken({ sub: 'a', did: 'd', adminOf: ['kid'] }),
      ],
      [
        'with a guardianOf but no admin role',
        () => signTestToken({ sub: 'a', did: 'd', guardianOf: ['kid'] }),
      ],
      [
        'with a guardianOf that is not a list',
        () => signTestToken({ sub: 'a', did: 'd', role: Actor.FAMILY_ADMIN, guardianOf: 'kid' }),
      ],
      [
        'with an adminOf that is not a list',
        () => signTestToken({ sub: 'a', did: 'd', role: Actor.FAMILY_ADMIN, adminOf: 'kid' }),
      ],
      [
        'with an adminOf that is null',
        () => signTestToken({ sub: 'a', did: 'd', role: Actor.FAMILY_ADMIN, adminOf: null }),
      ],
      [
        'with a non-string user in adminOf',
        () => signTestToken({ sub: 'a', did: 'd', role: Actor.FAMILY_ADMIN, adminOf: ['kid', 7] }),
      ],
      [
        'with an empty user id in adminOf',
        () => signTestToken({ sub: 'a', did: 'd', role: Actor.FAMILY_ADMIN, adminOf: [''] }),
      ],
      [
        'with an over-long user id in adminOf',
        () =>
          signTestToken({
            sub: 'a',
            did: 'd',
            role: Actor.FAMILY_ADMIN,
            adminOf: ['k'.repeat(129)],
          }),
      ],
      [
        `with more than ${MAX_ADMIN_OF_USERS} users in adminOf`,
        () =>
          signTestToken({
            sub: 'a',
            did: 'd',
            role: Actor.FAMILY_ADMIN,
            adminOf: Array.from({ length: MAX_ADMIN_OF_USERS + 1 }, (_, index) => `user-${index}`),
          }),
      ],
    ])('%s', async (_label, makeToken) => {
      await expect(
        verifyAccessToken(await makeToken(), TEST_TOKEN_KEYS, TEST_VERIFY),
      ).rejects.toMatchObject({
        code: RelayErrorCode.UNAUTHENTICATED,
        message: 'A valid bearer token is required.',
      });
    });
  });

  describe('key rotation', () => {
    const retired = generateTestKeyPair();
    const claims = { sub: 'alice', did: 'alice-phone' };

    it('accepts tokens of the current and of the previous key while both are listed', async () => {
      const keyring = tokenKeyringOf([TEST_KEY_PAIR.publicKey, retired.publicKey]);
      const current = await signTestToken(claims);
      const previous = await signTestToken(claims, { key: retired.privateKey, kid: retired.kid });
      await expect(verifyAccessToken(current, keyring, TEST_VERIFY)).resolves.toMatchObject({
        userId: 'alice',
      });
      await expect(verifyAccessToken(previous, keyring, TEST_VERIFY)).resolves.toMatchObject({
        userId: 'alice',
      });
    });

    it("refuses the previous key's tokens once it is dropped from the list", async () => {
      const previous = await signTestToken(claims, { key: retired.privateKey, kid: retired.kid });
      await expect(verifyAccessToken(previous, TEST_TOKEN_KEYS, TEST_VERIFY)).rejects.toMatchObject(
        {
          code: RelayErrorCode.UNAUTHENTICATED,
        },
      );
    });

    it('does not let a token name one listed key and be signed by another', async () => {
      const keyring = tokenKeyringOf([TEST_KEY_PAIR.publicKey, retired.publicKey]);
      const swapped = await signTestToken(claims, {
        key: retired.privateKey,
        kid: TEST_KEY_PAIR.kid,
      });
      await expect(verifyAccessToken(swapped, keyring, TEST_VERIFY)).rejects.toMatchObject({
        code: RelayErrorCode.UNAUTHENTICATED,
      });
    });
  });
});

describe('authentication on the routes', () => {
  const database = unusedDatabase();
  let app: Awaited<ReturnType<typeof buildServer>>;

  beforeAll(async () => {
    app = await buildServer({
      database,
      tokenKeys: TEST_TOKEN_KEYS,
      tokenExpectations: TEST_TOKEN_EXPECTATIONS,
    });
  });
  afterAll(async () => {
    await app.close();
    await database.close();
  });

  it('answers 401 UNAUTHENTICATED when there is no Authorization header', async () => {
    const response = await app.inject({ method: 'GET', url: '/users/alice/devices' });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: RelayErrorCode.UNAUTHENTICATED });
  });

  it('answers 401 for a bad token without revealing why', async () => {
    const forged = await signTestToken(
      { sub: 'a', did: 'd' },
      { key: generateTestKeyPair().privateKey },
    );
    const response = await app.inject({
      method: 'GET',
      url: '/users/alice/devices',
      headers: { authorization: `Bearer ${forged}` },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: RelayErrorCode.UNAUTHENTICATED,
      message: 'A valid bearer token is required.',
    });
  });

  it('gives the same answer for a wrong audience, a wrong issuer and an unknown key id', async () => {
    const claims = { sub: 'a', did: 'd' };
    const tokens = await Promise.all([
      signTestToken(claims, { audience: 'some-other-service' }),
      signTestToken(claims, { issuer: 'some-other-issuer' }),
      signTestToken(claims, { kid: 'ffffffffffffffff' }),
    ]);
    const answers = await Promise.all(
      tokens.map(async (token) => {
        const response = await app.inject({
          method: 'GET',
          url: '/users/alice/devices',
          headers: { authorization: `Bearer ${token}` },
        });
        return { status: response.statusCode, body: response.json() };
      }),
    );
    expect(new Set(answers.map((answer) => JSON.stringify(answer))).size).toBe(1);
    expect(answers[0]?.status).toBe(401);
  });

  it('checks the token before it looks at the body', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/devices',
      payload: { nonsense: true },
    });
    expect(response.statusCode).toBe(401);
  });
});

databaseSuite('authentication against registered devices', (harness) => {
  it('answers 403 ACTOR_DEVICE_UNKNOWN for a valid token of a device that was never registered', async () => {
    const stranger = await harness().caller({ userId: 'alice', deviceId: 'alice-phone' });
    const reply = await stranger.get('/users/alice/devices');
    expectStatus(reply, 403);
    expect(reply.json()).toMatchObject({ error: RelayErrorCode.ACTOR_DEVICE_UNKNOWN });
  });

  it('answers 403 ACTOR_DEVICE_UNKNOWN when the device belongs to a different user than the token says', async () => {
    await harness().enrol('alice', 'alice-phone');
    const impostor = await harness().caller({ userId: 'mallory', deviceId: 'alice-phone' });
    const reply = await impostor.get('/users/alice/devices');
    expectStatus(reply, 403);
    expect(reply.json()).toMatchObject({ error: RelayErrorCode.ACTOR_DEVICE_UNKNOWN });
  });

  it('cuts a revoked device off at once even though its token has not expired', async () => {
    const phone = await harness().enrol('alice', 'alice-phone');
    const tablet = await harness().enrol('alice', 'alice-tablet');
    expectStatus(await tablet.post('/devices/alice-phone/revoke'), 200);

    const reply = await phone.get('/users/alice/devices');
    expectStatus(reply, 403);
    expect(reply.json()).toMatchObject({ error: RelayErrorCode.ACTOR_DEVICE_REVOKED });
  });
});
