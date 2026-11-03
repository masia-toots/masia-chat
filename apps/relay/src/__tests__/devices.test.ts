import {
  DEVICE_LIST_USER_LIMIT,
  DEVICE_LIST_WINDOW_MS,
  DeviceRole,
  MAX_PUBLIC_KEY_BYTES,
  RelayErrorCode,
} from '@masia/relay';
import { describe, expect, it } from 'vitest';
import { b64, databaseSuite, expectStatus, OPERATOR } from './support/harness.js';

const KEYS = {
  identityKeyPub: b64('identity-key-material-aaaaaaaa'),
  signatureKeyPub: b64('signature-key-material-bbbbbb'),
};

interface DeviceBody {
  id: string;
  userId: string;
  role: string;
  name: string | null;
  platform: string | null;
  identityKeyPub: string;
  signatureKeyPub: string;
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
}

databaseSuite('POST /devices', (harness) => {
  it('registers the calling device (201) and shows its keys as base64', async () => {
    const alice = await harness().caller({ userId: 'alice', deviceId: 'alice-phone' });
    const reply = await alice.post('/devices', {
      id: 'alice-phone',
      name: 'Alice phone',
      platform: 'ios',
      ...KEYS,
    });

    expectStatus(reply, 201);
    expect(reply.json<DeviceBody>()).toMatchObject({
      id: 'alice-phone',
      userId: 'alice',
      role: DeviceRole.USER,
      name: 'Alice phone',
      platform: 'ios',
      ...KEYS,
      revokedAt: null,
    });
  });

  it('refreshes the label of a registered device (200) and leaves its keys alone', async () => {
    const alice = await harness().caller({ userId: 'alice', deviceId: 'alice-phone' });
    expectStatus(await alice.post('/devices', { id: 'alice-phone', name: 'Old', ...KEYS }), 201);

    const reply = await alice.post('/devices', { id: 'alice-phone', name: 'New', ...KEYS });
    expectStatus(reply, 200);
    expect(reply.json<DeviceBody>()).toMatchObject({ name: 'New', ...KEYS });
  });

  it('refuses to register a device id other than the one in the token (403)', async () => {
    const alice = await harness().caller({ userId: 'alice', deviceId: 'alice-phone' });
    const reply = await alice.post('/devices', { id: 'alice-tablet', ...KEYS });
    expectStatus(reply, 403);
    expect(reply.json()).toMatchObject({ error: RelayErrorCode.DEVICE_MISMATCH });
  });

  it('refuses a device id that belongs to another user (403)', async () => {
    await harness().enrol('alice', 'shared-id');
    const mallory = await harness().caller({ userId: 'mallory', deviceId: 'shared-id' });
    const reply = await mallory.post('/devices', { id: 'shared-id', ...KEYS });
    expectStatus(reply, 403);
    expect(reply.json()).toMatchObject({ error: RelayErrorCode.DEVICE_OWNED_BY_OTHER });
  });

  it('refuses to change the keys of a registered device (409): that would take over its MLS leaves', async () => {
    const alice = await harness().enrol('alice', 'alice-phone');
    const reply = await alice.post('/devices', {
      id: 'alice-phone',
      ...KEYS,
      signatureKeyPub: b64('another-signature-key-zzzzzz'),
    });
    expectStatus(reply, 409);
    expect(reply.json()).toMatchObject({ error: RelayErrorCode.DEVICE_IDENTITY_IMMUTABLE });
  });

  it('refuses a revoked device that tries to register again (403)', async () => {
    const phone = await harness().enrol('alice', 'alice-phone');
    const tablet = await harness().enrol('alice', 'alice-tablet');
    expectStatus(await tablet.post('/devices/alice-phone/revoke'), 200);

    const reply = await phone.post('/devices', { id: 'alice-phone', name: 'Back again', ...KEYS });
    expectStatus(reply, 403);
    expect(reply.json()).toMatchObject({ error: RelayErrorCode.ACTOR_DEVICE_REVOKED });
  });

  describe('a GUARDIAN device (review round 1, 2026-10-10: guardianOf)', () => {
    // The guardian device belongs to the CHILD (its MLS leaf carries the child's user id) and is
    // driven by the adult's token, which must list the child in `guardianOf`.
    const guardianBody = { id: 'mum-guardian', role: DeviceRole.GUARDIAN, userId: 'kid', ...KEYS };
    const mumFor = (claims: { adminOf?: string[]; guardianOf?: string[] }) =>
      harness().caller(
        { userId: 'kid', deviceId: 'mum-guardian', role: DeviceRole.GUARDIAN, tokenUserId: 'mum' },
        claims,
      );

    it('is registered on the child account by a token whose guardianOf lists the child (201)', async () => {
      const mum = await mumFor({ guardianOf: ['kid'] });
      const reply = await mum.post('/devices', guardianBody);
      expectStatus(reply, 201);
      expect(reply.json<DeviceBody>()).toMatchObject({
        id: 'mum-guardian',
        userId: 'kid',
        role: DeviceRole.GUARDIAN,
      });
    });

    it.each([
      ['no claim at all', {}],
      ['the bare marker (guardianOf empty)', { guardianOf: [] }],
      ['another child only', { guardianOf: ['another-kid'] }],
      ['adminOf the child but no guardianOf: administering is not guarding', { adminOf: ['kid'] }],
    ])('is refused with %s (403 ROLE_FORBIDDEN)', async (_label, claims) => {
      const mum = await mumFor(claims);
      const refused = await mum.post('/devices', guardianBody);
      expectStatus(refused, 403);
      expect(refused.json()).toMatchObject({ error: RelayErrorCode.ROLE_FORBIDDEN });
    });

    it("is refused on the guardian's OWN account, even when guardianOf lists it (403)", async () => {
      const mum = await harness().caller(
        { userId: 'mum', deviceId: 'mum-guardian', role: DeviceRole.GUARDIAN },
        { guardianOf: ['mum'] },
      );
      expectStatus(await mum.post('/devices', { ...guardianBody, userId: 'mum' }), 403);
    });

    it("refuses a USER device on someone else's account, whatever the token guards (403)", async () => {
      const mum = await mumFor({ guardianOf: ['kid'], adminOf: ['kid'] });
      const refused = await mum.post('/devices', { ...guardianBody, role: DeviceRole.USER });
      expectStatus(refused, 403);
      expect(refused.json()).toMatchObject({ error: RelayErrorCode.ROLE_FORBIDDEN });
    });
  });

  describe('an ASSISTANT device (only under the operator principal)', () => {
    it('is registered by the operator on its own account (201)', async () => {
      const operator = await harness().caller(
        { userId: OPERATOR, deviceId: 'masia-1' },
        { adminOf: [OPERATOR] },
      );
      const reply = await operator.post('/devices', {
        id: 'masia-1',
        role: DeviceRole.ASSISTANT,
        ...KEYS,
      });
      expectStatus(reply, 201);
      expect(reply.json<DeviceBody>()).toMatchObject({
        userId: OPERATOR,
        role: DeviceRole.ASSISTANT,
      });
    });

    it.each([
      ['a plain user', {}],
      ['a family admin of herself and others', { adminOf: ['mum', 'kid'] }],
      ['a token that names the operator in adminOf', { adminOf: [OPERATOR] }],
    ])('is refused for %s (403 ROLE_FORBIDDEN)', async (_label, claims) => {
      const mum = await harness().caller({ userId: 'mum', deviceId: 'masia-1' }, claims);
      for (const body of [{}, { userId: OPERATOR }]) {
        const refused = await mum.post('/devices', {
          id: 'masia-1',
          role: DeviceRole.ASSISTANT,
          ...KEYS,
          ...body,
        });
        expectStatus(refused, 403);
        expect(refused.json()).toMatchObject({ error: RelayErrorCode.ROLE_FORBIDDEN });
      }
      // A plain USER device of her own needs no admin at all.
      expectStatus(await mum.post('/devices', { id: 'masia-1', ...KEYS }), 201);
    });
  });

  it('rejects a field it does not know instead of dropping it (400): a body cannot claim to be admin', async () => {
    const mum = await harness().caller({ userId: 'mum', deviceId: 'mum-guardian' });
    const reply = await mum.post('/devices', {
      id: 'mum-guardian',
      role: DeviceRole.GUARDIAN,
      actor: 'FAMILY_ADMIN',
      ...KEYS,
    });
    expectStatus(reply, 400);
    expect(reply.json()).toMatchObject({ error: RelayErrorCode.VALIDATION_FAILED });
  });

  it('takes a key of exactly the size limit and refuses one byte more', async () => {
    const alice = await harness().caller({ userId: 'alice', deviceId: 'alice-phone' });
    const keyOf = (size: number) => Buffer.alloc(size, 7).toString('base64');

    expectStatus(
      await alice.post('/devices', {
        id: 'alice-phone',
        identityKeyPub: keyOf(MAX_PUBLIC_KEY_BYTES),
        signatureKeyPub: KEYS.signatureKeyPub,
      }),
      201,
    );
    const tooLong = await alice.post('/devices', {
      id: 'alice-phone',
      identityKeyPub: keyOf(MAX_PUBLIC_KEY_BYTES + 1),
      signatureKeyPub: KEYS.signatureKeyPub,
    });
    expectStatus(tooLong, 400);
  });

  it.each([
    [
      'a key that is not base64',
      { identityKeyPub: 'not base64!!', signatureKeyPub: KEYS.signatureKeyPub },
    ],
    [
      'a key that is too long',
      {
        identityKeyPub: Buffer.alloc(257).toString('base64'),
        signatureKeyPub: KEYS.signatureKeyPub,
      },
    ],
    [
      'an unknown role',
      { identityKeyPub: KEYS.identityKeyPub, signatureKeyPub: KEYS.signatureKeyPub, role: 'ROOT' },
    ],
  ])('rejects %s (400)', async (_label, fields) => {
    const alice = await harness().caller({ userId: 'alice', deviceId: 'alice-phone' });
    const reply = await alice.post('/devices', { id: 'alice-phone', ...fields });
    expectStatus(reply, 400);
  });
});

databaseSuite('GET /users/:userId/devices', (harness) => {
  it('lists the active devices of a user, oldest first, in the collection envelope', async () => {
    const first = await harness().enrol('alice', 'alice-a-phone');
    await harness().enrol('alice', 'alice-b-tablet');
    await harness().enrol('bob', 'bob-phone');

    const reply = await first.get('/users/alice/devices');
    expectStatus(reply, 200);
    const body = reply.json<{ rows: DeviceBody[]; nextCursor: string | null }>();
    expect(body.rows.map((device) => device.id)).toEqual(['alice-a-phone', 'alice-b-tablet']);
    expect(body.nextCursor).toBeNull();
  });

  it('leaves revoked devices out', async () => {
    const phone = await harness().enrol('alice', 'alice-a-phone');
    await harness().enrol('alice', 'alice-b-tablet');
    expectStatus(await phone.post('/devices/alice-b-tablet/revoke'), 200);

    const body = (await phone.get('/users/alice/devices')).json<{ rows: DeviceBody[] }>();
    expect(body.rows.map((device) => device.id)).toEqual(['alice-a-phone']);
  });

  it('refuses a user id with a separator in it (400): ids are a closed alphabet', async () => {
    const alice = await harness().enrol('alice', 'alice-phone');
    expectStatus(await alice.get('/users/alice%3Aphone/devices'), 400);
  });

  it('answers an empty collection to the admin of an account with no devices', async () => {
    await harness().enrol('dad', 'dad-phone');
    const dad = await harness().caller(
      { userId: 'dad', deviceId: 'dad-phone' },
      { adminOf: ['newborn'] },
    );
    const reply = await dad.get('/users/newborn/devices');
    expectStatus(reply, 200);
    expect(reply.json()).toEqual({ rows: [], nextCursor: null, identityKeyPub: null });
  });

  describe('who may look (review round 1, 2026-10-10: the contact gate and the lookup budget)', () => {
    it('shows a stranger nothing: 403 NOT_A_CONTACT, the same for a user that exists and one that does not', async () => {
      await harness().enrol('bob', 'bob-phone');
      const mallory = await harness().enrol('mallory', 'mallory-phone');

      const existing = await mallory.get('/users/bob/devices');
      expectStatus(existing, 403);
      expect(existing.json()).toMatchObject({ error: RelayErrorCode.NOT_A_CONTACT });
      const missing = await mallory.get('/users/nobody/devices');
      expectStatus(missing, 403);
      expect(missing.json()).toEqual(existing.json());
    });

    it('shows a contact (a user in a room with the caller) only id, role and keys', async () => {
      const alice = await harness().enrol('alice', 'alice-phone');
      const bob = await harness().enrol('bob', 'bob-phone');
      await harness().createRoom('room-1', alice);
      expectStatus(await harness().addToRoom('room-1', alice, bob), 201);

      const reply = await alice.get('/users/bob/devices');
      expectStatus(reply, 200);
      const [row] = reply.json<{ rows: Array<Record<string, unknown>> }>().rows;
      expect(row).toEqual({
        id: 'bob-phone',
        role: DeviceRole.USER,
        identityKeyPub: expect.any(String),
        signatureKeyPub: expect.any(String),
      });
    });

    it('shows the owner and the admin of the account everything, including labels', async () => {
      const kidPhone = await harness().enrol('kid', 'kid-phone');
      await harness().enrol('dad', 'dad-phone');
      const dad = await harness().caller(
        { userId: 'dad', deviceId: 'dad-phone' },
        { adminOf: ['kid'] },
      );

      for (const viewer of [kidPhone, dad]) {
        const reply = await viewer.get('/users/kid/devices');
        expectStatus(reply, 200);
        expect(reply.json<{ rows: DeviceBody[] }>().rows[0]).toMatchObject({
          id: 'kid-phone',
          userId: 'kid',
          revokedAt: null,
        });
      }
      expectStatus(await kidPhone.get('/users/nobody/devices'), 403); // no admin reach of its own
    });

    it(`spends the SAME budget as /device-list: ${DEVICE_LIST_USER_LIMIT} lookups in all, then 429 with Retry-After`, async () => {
      const alice = await harness().enrol('alice', 'alice-phone');
      for (let attempt = 0; attempt < DEVICE_LIST_USER_LIMIT; attempt += 1) {
        const url =
          attempt % 2 === 0
            ? `/users/target-${attempt}/devices`
            : `/users/target-${attempt}/device-list`;
        const reply = await alice.get(url);
        expect(reply.status, `lookup ${attempt + 1}`).toBeLessThan(429);
      }
      const limited = await alice.get('/users/one-too-many/devices');
      expectStatus(limited, 429);
      expect(limited.json()).toMatchObject({ error: RelayErrorCode.ACTOR_RATE_LIMITED });
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
      // Both routes draw on the one budget: the other route is stopped too. Your own directory is
      // free, though (see lookup-budget.test.ts), so the spent budget does not lock you out of it.
      expectStatus(await alice.get('/users/another-target/device-list'), 429);
      expectStatus(await alice.get('/users/alice/device-list'), 200);

      harness().clock.advance(DEVICE_LIST_WINDOW_MS);
      expectStatus(await alice.get('/users/alice/devices'), 200);
    });
  });
});

databaseSuite('POST /devices/:id/revoke', (harness) => {
  it('lets another device of the same user revoke a device, and stamps revokedAt', async () => {
    await harness().enrol('alice', 'alice-phone');
    const tablet = await harness().enrol('alice', 'alice-tablet');

    const reply = await tablet.post('/devices/alice-phone/revoke');
    expectStatus(reply, 200);
    expect(reply.json<DeviceBody>().revokedAt).not.toBeNull();
  });

  it('is idempotent: revoking a revoked device returns it again', async () => {
    await harness().enrol('alice', 'alice-phone');
    const tablet = await harness().enrol('alice', 'alice-tablet');
    const first = (await tablet.post('/devices/alice-phone/revoke')).json<DeviceBody>();
    const second = await tablet.post('/devices/alice-phone/revoke');
    expectStatus(second, 200);
    expect(second.json<DeviceBody>().revokedAt).toBe(first.revokedAt);
  });

  it('does not let a device revoke itself (use another device, so the user is never locked out)', async () => {
    const phone = await harness().enrol('alice', 'alice-phone');
    const reply = await phone.post('/devices/alice-phone/revoke');
    expectStatus(reply, 403);
    expect(reply.json()).toMatchObject({ error: RelayErrorCode.REVOKE_FORBIDDEN });
  });

  it("does not let a user revoke someone else's device, and does not reveal whether it exists", async () => {
    await harness().enrol('bob', 'bob-phone');
    const mallory = await harness().enrol('mallory', 'mallory-phone');

    const real = await mallory.post('/devices/bob-phone/revoke');
    const missing = await mallory.post('/devices/no-such-device/revoke');
    expectStatus(real, 403);
    expectStatus(missing, 403);
    expect(missing.json()).toEqual(real.json());
  });

  describe('a family admin (the marker AND adminOf)', () => {
    it('revokes a device of a user in adminOf', async () => {
      await harness().enrol('kid', 'kid-phone');
      await harness().enrol('dad', 'dad-phone');
      const admin = await harness().caller(
        { userId: 'dad', deviceId: 'dad-phone' },
        { adminOf: ['kid'] },
      );

      const reply = await admin.post('/devices/kid-phone/revoke');
      expectStatus(reply, 200);
      expect(reply.json<DeviceBody>().revokedAt).not.toBeNull();
    });

    it("refuses a device of a user NOT in adminOf (403), exactly as it refuses a non-admin: family A's admin has no say over family B", async () => {
      await harness().enrol('kid-b', 'kid-b-phone');
      await harness().enrol('dad-a', 'dad-a-phone');
      const mallory = await harness().enrol('mallory', 'mallory-phone');
      const adminA = await harness().caller(
        { userId: 'dad-a', deviceId: 'dad-a-phone' },
        { adminOf: ['dad-a', 'kid-a'] },
      );

      const asAdmin = await adminA.post('/devices/kid-b-phone/revoke');
      const asStranger = await mallory.post('/devices/kid-b-phone/revoke');
      expectStatus(asAdmin, 403);
      expect(asAdmin.json()).toMatchObject({ error: RelayErrorCode.REVOKE_FORBIDDEN });
      expect(asAdmin.json()).toEqual(asStranger.json());
      const { rows } = await harness().db.query<{ revoked: boolean }>(
        "SELECT revoked_at IS NOT NULL AS revoked FROM devices WHERE id = 'kid-b-phone'",
      );
      expect(rows[0]?.revoked).toBe(false);
    });

    it('gets nothing from the marker alone (adminOf empty)', async () => {
      await harness().enrol('kid', 'kid-phone');
      await harness().enrol('dad', 'dad-phone');
      const bare = await harness().caller(
        { userId: 'dad', deviceId: 'dad-phone' },
        { adminOf: [] },
      );
      expectStatus(await bare.post('/devices/kid-phone/revoke'), 403);
    });

    it('answers a device that does not exist with the same 403 as one it may not touch (no admin probe for ids)', async () => {
      await harness().enrol('kid', 'kid-phone');
      await harness().enrol('dad', 'dad-phone');
      const admin = await harness().caller(
        { userId: 'dad', deviceId: 'dad-phone' },
        { adminOf: ['kid'] },
      );
      const outOfScope = await harness().caller(
        { userId: 'dad', deviceId: 'dad-phone' },
        { adminOf: ['nobody-at-all'] },
      );

      const missing = await admin.post('/devices/no-such-device/revoke');
      expectStatus(missing, 403);
      expect(missing.json()).toMatchObject({ error: RelayErrorCode.REVOKE_FORBIDDEN });
      const notYours = await outOfScope.post('/devices/kid-phone/revoke');
      expectStatus(notYours, 403);
      expect(notYours.json()).toEqual(missing.json());
    });

    it('may revoke its OWN current device only if it administers its own user (the self-revoke exception follows adminOf)', async () => {
      await harness().enrol('dad', 'dad-phone');
      await harness().enrol('dad', 'dad-tablet');
      const notOwn = await harness().caller(
        { userId: 'dad', deviceId: 'dad-phone' },
        { adminOf: ['kid'] },
      );
      // The plain "another device of the same user" rule still holds, whatever the token's adminOf...
      expectStatus(await notOwn.post('/devices/dad-tablet/revoke'), 200);
      // ...but revoking the CURRENT device is an exception a plain device never gets, and an admin
      // gets only for the users it administers.
      expectStatus(await notOwn.post('/devices/dad-phone/revoke'), 403);

      const ownToo = await harness().caller(
        { userId: 'dad', deviceId: 'dad-phone' },
        { adminOf: ['dad'] },
      );
      expectStatus(await ownToo.post('/devices/dad-phone/revoke'), 200);
    });
  });
});
