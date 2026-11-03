import {
  CLAIM_LIMIT,
  CLAIM_WINDOW_MS,
  DeviceRole,
  type IdentityKeyChangedBody,
  MAX_DEVICE_TEXT_LENGTH,
  MAX_DEVICES_PER_USER,
  RelayErrorCode,
} from '@masia/relay';
import { describe, expect, it } from 'vitest';
import {
  b64,
  type Caller,
  countRows,
  databaseSuite,
  expectStatus,
  type Harness,
  keyPackageItem,
  keysOf,
  OPERATOR,
} from './support/harness.js';

// R-G (2026-10-11): the two relay contracts the hub's enrolment (W3c) asked for — TODO-507 (the pinned
// identity key travels with the 409 IDENTITY_KEY_CHANGED) and TODO-513 (a key-package claim may name
// the devices it wants), ADR-117 amendment (м).

interface Claim {
  deviceId: string;
  keyPackageId: string;
  bytes: string;
  lastResort: boolean;
}

const SECOND_IDENTITY = b64('another-identity-key-of-the-same-person');
const ED25519_PUBLIC_KEY_BYTES = 32;

databaseSuite('TODO-507: the 409 IDENTITY_KEY_CHANGED carries the pinned key', (harness) => {
  /** A USER device of `userId` registering with `identityKeyPub`, as a client does on its first call. */
  async function register(userId: string, deviceId: string, identityKeyPub: string) {
    const device = await harness().caller({ userId, deviceId });
    return device.post('/devices', {
      id: deviceId,
      identityKeyPub,
      signatureKeyPub: keysOf(deviceId).signatureKeyPub,
    });
  }

  it('tells an UNREGISTERED second device the key to register with, and the retry succeeds', async () => {
    await harness().enrol('alice', 'alice-phone');
    const pinned = keysOf('alice-phone', 'alice').identityKeyPub;

    // The second device cannot read the pin first: it is not registered.
    const tablet = await harness().caller({ userId: 'alice', deviceId: 'alice-tablet' });
    const blind = await tablet.get('/users/alice/devices');
    expectStatus(blind, 403);
    expect(blind.json()).toMatchObject({ error: RelayErrorCode.ACTOR_DEVICE_UNKNOWN });
    expect(JSON.stringify(blind.json())).not.toContain(pinned);

    // It registers with a key of its own; the refusal hands it the person's.
    const refused = await register('alice', 'alice-tablet', SECOND_IDENTITY);
    expectStatus(refused, 409);
    const body = refused.json<IdentityKeyChangedBody>();
    expect(body.error).toBe(RelayErrorCode.IDENTITY_KEY_CHANGED);
    expect(body.identityKeyPub).toBe(pinned);
    expect(Buffer.from(body.identityKeyPub, 'base64')).toHaveLength(ED25519_PUBLIC_KEY_BYTES);
    expect(typeof body.message).toBe('string');

    const retried = await register('alice', 'alice-tablet', body.identityKeyPub);
    expectStatus(retried, 201);
    expect(retried.json()).toMatchObject({ id: 'alice-tablet', identityKeyPub: pinned });
  });

  it('never tells a token another person’s key: a USER device is registered for the token’s own user only', async () => {
    await harness().enrol('alice', 'alice-phone');
    await harness().enrol('bob', 'bob-phone');
    const alicesKey = keysOf('alice-phone', 'alice').identityKeyPub;
    const bobsKey = keysOf('bob-phone', 'bob').identityKeyPub;
    expect(alicesKey).not.toBe(bobsKey);

    // Bob's token asks for a device ON ALICE'S ACCOUNT: refused before the pin is looked at.
    const bobsSecondDevice = await harness().caller({ userId: 'bob', deviceId: 'bob-tablet' });
    const forAlice = await bobsSecondDevice.post('/devices', {
      id: 'bob-tablet',
      userId: 'alice',
      identityKeyPub: SECOND_IDENTITY,
      signatureKeyPub: keysOf('bob-tablet').signatureKeyPub,
    });
    expectStatus(forAlice, 403);
    expect(forAlice.json()).toMatchObject({ error: RelayErrorCode.ROLE_FORBIDDEN });
    expect(forAlice.json()).not.toHaveProperty('identityKeyPub');
    expect(JSON.stringify(forAlice.json())).not.toContain(alicesKey);

    // On his own account Bob's conflicting key gets BOB's pin, never Alice's.
    const own = await register('bob', 'bob-tablet', SECOND_IDENTITY);
    expectStatus(own, 409);
    expect(own.json<IdentityKeyChangedBody>().identityKeyPub).toBe(bobsKey);
    expect(JSON.stringify(own.json())).not.toContain(alicesKey);

    // Alice's family admin cannot register a USER device on her account either (an admin's token is
    // an admin's own account), so no refusal of hers ever names Alice's pin.
    const mum = await harness().caller(
      { userId: 'mum', deviceId: 'mum-phone' },
      { adminOf: ['alice'] },
    );
    const adminForAlice = await mum.post('/devices', {
      id: 'mum-phone',
      userId: 'alice',
      identityKeyPub: SECOND_IDENTITY,
      signatureKeyPub: keysOf('mum-phone').signatureKeyPub,
    });
    expectStatus(adminForAlice, 403);
    expect(adminForAlice.json()).not.toHaveProperty('identityKeyPub');
  });

  it('adds the key to this refusal only, not to the other 409 of the same route', async () => {
    const phone = await harness().enrol('alice', 'alice-phone');
    const changed = await phone.post('/devices', {
      id: 'alice-phone',
      identityKeyPub: keysOf('alice-phone', 'alice').identityKeyPub,
      signatureKeyPub: b64('another-signature-key-zzzzzz'),
    });
    expectStatus(changed, 409);
    expect(changed.json()).toMatchObject({ error: RelayErrorCode.DEVICE_IDENTITY_IMMUTABLE });
    expect(changed.json()).not.toHaveProperty('identityKeyPub');
  });

  it('gives no key when nothing is pinned, and none to a device that carries the right one', async () => {
    const first = await register('alice', 'alice-phone', keysOf('x', 'alice').identityKeyPub);
    expectStatus(first, 201);
    expect(first.json()).not.toHaveProperty('error');
    const second = await register('alice', 'alice-tablet', keysOf('x', 'alice').identityKeyPub);
    expectStatus(second, 201);
  });

  it('still refuses to list devices to an unregistered caller, even its own user (the pin travels with the 409 instead)', async () => {
    await harness().enrol('alice', 'alice-phone');
    const stranger = await harness().caller({ userId: 'mallory', deviceId: 'mallory-phone' });
    for (const userId of ['alice', 'mallory']) {
      const reply = await stranger.get(`/users/${userId}/devices`);
      expectStatus(reply, 403);
      expect(reply.json()).toMatchObject({ error: RelayErrorCode.ACTOR_DEVICE_UNKNOWN });
    }
  });
});

databaseSuite('TODO-513: a key-package claim may name the devices it wants', (harness) => {
  /** Bob with three devices (oldest first: phone, tablet, laptop), each with an ordinary and a last-resort package. */
  async function bobWithThreeDevices(): Promise<Record<'phone' | 'tablet' | 'laptop', Caller>> {
    const phone = await harness().enrol('bob', 'bob-phone');
    const tablet = await harness().enrol('bob', 'bob-tablet');
    const laptop = await harness().enrol('bob', 'bob-laptop');
    for (const [name, device] of Object.entries({ phone, tablet, laptop })) {
      expectStatus(
        await device.post('/key-packages', [
          keyPackageItem(harness().clock, false, `${name}-ordinary`),
          keyPackageItem(harness().clock, true, `${name}-last`),
        ]),
        201,
      );
    }
    return { phone, tablet, laptop };
  }

  async function aliceWhoKnowsBob(): Promise<Caller> {
    return harness().introduce(await harness().enrol('alice', 'alice-phone'), 'bob');
  }

  const claim = async (by: Caller, payload: object) => by.post('/key-packages/claim', payload);
  const rowsOf = (reply: { json<T>(): T }) => reply.json<{ rows: Claim[] }>().rows;
  const consumed = (harness_: Harness) =>
    countRows('SELECT count(*) AS n FROM key_packages WHERE consumed_at IS NOT NULL', harness_.db);

  it('hands out a package only for the devices named, and burns no other device’s package', async () => {
    await bobWithThreeDevices();
    const alice = await aliceWhoKnowsBob();

    const reply = await claim(alice, { userId: 'bob', deviceIds: ['bob-tablet'] });
    expectStatus(reply, 200);
    expect(rowsOf(reply)).toMatchObject([{ deviceId: 'bob-tablet', lastResort: false }]);
    expect(reply.json()).toMatchObject({ nextCursor: null });
    expect(await consumed(harness())).toBe(1);
    expect(
      await countRows(
        `SELECT count(*) AS n FROM key_packages WHERE consumed_at IS NOT NULL AND device_id <> 'bob-tablet'`,
        harness().db,
      ),
    ).toBe(0);
    expect(await countRows('SELECT count(*) AS n FROM key_package_claims', harness().db)).toBe(1);
  });

  it('answers the devices named oldest first, whatever order they were asked in, and a repeated id counts once', async () => {
    await bobWithThreeDevices();
    const alice = await aliceWhoKnowsBob();

    const reply = await claim(alice, {
      userId: 'bob',
      deviceIds: ['bob-laptop', 'bob-phone', 'bob-laptop'],
    });
    expectStatus(reply, 200);
    expect(rowsOf(reply).map((row) => row.deviceId)).toEqual(['bob-phone', 'bob-laptop']);
    expect(await consumed(harness())).toBe(2);
  });

  it('still hands out every active device when `deviceIds` is left out', async () => {
    await bobWithThreeDevices();
    const alice = await aliceWhoKnowsBob();
    const reply = await claim(alice, { userId: 'bob' });
    expectStatus(reply, 200);
    expect(rowsOf(reply).map((row) => row.deviceId)).toEqual(['bob-phone', 'bob-tablet', 'bob-laptop']);
  });

  it('leaves out an id that is unknown, revoked, another person’s or without a package: one answer for all, nothing else touched', async () => {
    const { phone } = await bobWithThreeDevices();
    await harness().enrol('bob', 'bob-empty'); // active, but uploaded nothing
    await harness().enrol('carol', 'carol-phone');
    expectStatus(
      await (await harness().caller({ userId: 'carol', deviceId: 'carol-phone' })).post(
        '/key-packages',
        [keyPackageItem(harness().clock, true, 'carol-last')],
      ),
      201,
    );
    expectStatus(await phone.post('/devices/bob-tablet/revoke'), 200);
    const alice = await harness().introduce(
      await harness().enrol('alice', 'alice-phone'),
      'bob',
      'carol',
    );

    const reply = await claim(alice, {
      userId: 'bob',
      deviceIds: [
        'bob-phone', // active: served
        'bob-tablet', // revoked
        'carol-phone', // another person's device
        'nobody-at-all', // unknown
        'bob-empty', // active, no package to give
      ],
    });
    expectStatus(reply, 200);
    expect(rowsOf(reply).map((row) => row.deviceId)).toEqual(['bob-phone']);
    // Carol's package was not touched by a claim on Bob; Bob's other packages neither.
    expect(await consumed(harness())).toBe(1);
    expect(await countRows('SELECT count(*) AS n FROM key_package_claims', harness().db)).toBe(1);

    // All-unknown is not an error either: an empty page, as for a user without devices.
    const none = await claim(alice, { userId: 'bob', deviceIds: ['nobody-at-all', 'carol-phone'] });
    expectStatus(none, 200);
    expect(none.json()).toEqual({ rows: [], nextCursor: null });
  });

  it('serves a named last-resort package without consuming it once the pool is empty', async () => {
    await bobWithThreeDevices();
    const alice = await aliceWhoKnowsBob();
    const first = await claim(alice, { userId: 'bob', deviceIds: ['bob-phone'] });
    const second = await claim(alice, { userId: 'bob', deviceIds: ['bob-phone'] });
    expect(rowsOf(first)[0]).toMatchObject({ lastResort: false });
    expect(rowsOf(second)[0]).toMatchObject({ lastResort: true });
    expect(
      await countRows(
        'SELECT count(*) AS n FROM key_packages WHERE last_resort AND consumed_at IS NOT NULL',
        harness().db,
      ),
    ).toBe(0);
  });

  it('takes one assistant device out of an operator’s many, the case that burned them all', async () => {
    for (const seat of ['masia-seat-1', 'masia-seat-2', 'masia-seat-3']) {
      const assistant = await harness().enrol(OPERATOR, seat, DeviceRole.ASSISTANT);
      expectStatus(
        await assistant.post('/key-packages', [
          keyPackageItem(harness().clock, false, `${seat}-ordinary`),
          keyPackageItem(harness().clock, true, `${seat}-last`),
        ]),
        201,
      );
    }
    const alice = await harness().enrol('alice', 'alice-phone');

    const reply = await claim(alice, { userId: OPERATOR, deviceIds: ['masia-seat-2'] });
    expectStatus(reply, 200);
    expect(rowsOf(reply).map((row) => row.deviceId)).toEqual(['masia-seat-2']);
    expect(await consumed(harness())).toBe(1);
  });

  describe('what it does not change', () => {
    it('keeps the contact gate: a stranger is 403 NOT_A_CONTACT for any `deviceIds`, the same for ids that exist and ids that do not, and nothing is handed out', async () => {
      await bobWithThreeDevices();
      const mallory = await harness().enrol('mallory', 'mallory-phone');

      const existing = await claim(mallory, { userId: 'bob', deviceIds: ['bob-phone'] });
      expectStatus(existing, 403);
      expect(existing.json()).toMatchObject({ error: RelayErrorCode.NOT_A_CONTACT });
      const missing = await claim(mallory, { userId: 'bob', deviceIds: ['not-a-device'] });
      expectStatus(missing, 403);
      expect(missing.json()).toEqual(existing.json());
      expect(await consumed(harness())).toBe(0);
      expect(await countRows('SELECT count(*) AS n FROM key_package_claims', harness().db)).toBe(0);
    });

    it(`keeps the per-device rate limit: ${CLAIM_LIMIT} claims per window, named or not (429 CLAIM_RATE_LIMITED, Retry-After)`, async () => {
      await bobWithThreeDevices();
      const alice = await aliceWhoKnowsBob();
      for (let attempt = 1; attempt <= CLAIM_LIMIT; attempt += 1) {
        // Alternate the two forms: they share one budget.
        const payload =
          attempt % 2 === 0 ? { userId: 'bob' } : { userId: 'bob', deviceIds: ['bob-phone'] };
        expectStatus(await claim(alice, payload), 200);
      }
      const limited = await claim(alice, { userId: 'bob', deviceIds: ['bob-phone'] });
      expectStatus(limited, 429);
      expect(limited.json()).toMatchObject({ error: RelayErrorCode.CLAIM_RATE_LIMITED });
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);

      harness().clock.advance(CLAIM_WINDOW_MS);
      expectStatus(await claim(alice, { userId: 'bob', deviceIds: ['bob-phone'] }), 200);
    });
  });

  describe('a malformed `deviceIds` is 400 VALIDATION_FAILED, and nothing is handed out', () => {
    it.each([
      ['an empty list (it must never mean "all")', []],
      ['a list over the devices a user may have', Array.from({ length: MAX_DEVICES_PER_USER + 1 }, (_, i) => `d${i}`)],
      ['an id outside the id alphabet', ['bob:phone']],
      ['an id past the id length', ['d'.repeat(129)]],
      ['null', null],
    ])('refuses %s', async (_name, deviceIds) => {
      await bobWithThreeDevices();
      const alice = await aliceWhoKnowsBob();
      const reply = await claim(alice, { userId: 'bob', deviceIds });
      expectStatus(reply, 400);
      expect(reply.json()).toMatchObject({ error: RelayErrorCode.VALIDATION_FAILED });
      expect(await consumed(harness())).toBe(0);
    });

    it('accepts exactly as many ids as a user may have devices', async () => {
      await bobWithThreeDevices();
      const alice = await aliceWhoKnowsBob();
      const reply = await claim(alice, {
        userId: 'bob',
        deviceIds: Array.from({ length: MAX_DEVICES_PER_USER }, (_, i) => `d${i}`),
      });
      expectStatus(reply, 200);
      expect(rowsOf(reply)).toEqual([]);
    });

    it('refuses an unknown field, as the route always has', async () => {
      await bobWithThreeDevices();
      const alice = await aliceWhoKnowsBob();
      expectStatus(await claim(alice, { userId: 'bob', deviceId: 'bob-phone' }), 400);
    });
  });
});

databaseSuite('TODO-513: the device label limit is the wire’s', (harness) => {
  it(`takes a name of ${MAX_DEVICE_TEXT_LENGTH} characters and refuses one character more (400)`, async () => {
    const alice = await harness().caller({ userId: 'alice', deviceId: 'alice-phone' });
    const base = { id: 'alice-phone', ...keysOf('alice-phone', 'alice') };
    const over = await alice.post('/devices', { ...base, name: 'n'.repeat(MAX_DEVICE_TEXT_LENGTH + 1) });
    expectStatus(over, 400);
    expect(over.json()).toMatchObject({ error: RelayErrorCode.VALIDATION_FAILED });
    const platformOver = await alice.post('/devices', {
      ...base,
      platform: 'p'.repeat(MAX_DEVICE_TEXT_LENGTH + 1),
    });
    expectStatus(platformOver, 400);
    const exact = await alice.post('/devices', { ...base, name: 'n'.repeat(MAX_DEVICE_TEXT_LENGTH) });
    expectStatus(exact, 201);
  });
});
