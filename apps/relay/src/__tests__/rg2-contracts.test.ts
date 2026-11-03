import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DeviceRole, type IdentityKeyChangedBody, RelayErrorCode } from '@masia/relay';
import { describe, expect, it } from 'vitest';
import {
  b64,
  type Caller,
  countRows,
  databaseSuite,
  expectStatus,
  type Harness,
  keysOf,
  OPERATOR,
} from './support/harness.js';

// R-G2 (2026-10-11): the relay pins the OPERATOR's identity key on its first ASSISTANT device, the way
// it pins a person's on the first USER device — TODO-518, ADR-117 amendment (о). Without it a member
// (the hub) that reads `GET /users/<operator>/devices` got `identityKeyPub: null` and could not verify
// the operator's signed `mls-device-list/v1`.

const OPERATOR_KEY = b64('operator-key-of-the-assistant-0001');
const OTHER_KEY = b64('another-key-that-is-not-the-operator');

interface DevicesPage {
  rows: Array<{ id: string; role: string }>;
  nextCursor: string | null;
  identityKeyPub: string | null;
}

databaseSuite('TODO-518: the first ASSISTANT device pins the operator key', (harness) => {
  /** An ASSISTANT device under the operator's own token, as the custody worker registers it (no `userId`). */
  async function registerAssistant(deviceId: string, identityKeyPub: string) {
    const device = await harness().caller({
      userId: OPERATOR,
      deviceId,
      role: DeviceRole.ASSISTANT,
    });
    return device.post('/devices', {
      id: deviceId,
      role: DeviceRole.ASSISTANT,
      name: 'Assistant',
      platform: 'custody',
      identityKeyPub,
      signatureKeyPub: keysOf(deviceId).signatureKeyPub,
    });
  }

  /** What a member reads: the operator's directory, public to every registered device. */
  async function operatorDirectory(reader: Caller): Promise<DevicesPage> {
    const reply = await reader.get(`/users/${OPERATOR}/devices`);
    expectStatus(reply, 200);
    return reply.json<DevicesPage>();
  }

  it('hands a member the operator key beside the rows, and null before any ASSISTANT device', async () => {
    const bob = await harness().enrol('bob', 'bob-phone');
    expect(await operatorDirectory(bob)).toEqual({
      rows: [],
      nextCursor: null,
      identityKeyPub: null,
    });

    expectStatus(await registerAssistant('assistant-a', OPERATOR_KEY), 201);

    const page = await operatorDirectory(bob);
    expect(page.identityKeyPub).toBe(OPERATOR_KEY);
    expect(page.rows.map((row) => [row.id, row.role])).toEqual([
      ['assistant-a', DeviceRole.ASSISTANT],
    ]);
    // The pin is the operator's; bob's own is untouched.
    expect((await bob.get('/users/bob/devices')).json<DevicesPage>().identityKeyPub).toBe(
      keysOf('bob-phone', 'bob').identityKeyPub,
    );
  });

  it('accepts later ASSISTANT devices with the same key and refuses another key, with the pin in the 409', async () => {
    expectStatus(await registerAssistant('assistant-a', OPERATOR_KEY), 201);
    expectStatus(await registerAssistant('assistant-b', OPERATOR_KEY), 201);

    const refused = await registerAssistant('assistant-c', OTHER_KEY);
    expectStatus(refused, 409);
    const body = refused.json<IdentityKeyChangedBody>();
    expect(body.error).toBe(RelayErrorCode.IDENTITY_KEY_CHANGED);
    expect(body.identityKeyPub).toBe(OPERATOR_KEY);
    // Refused means not registered: the insert rolled back with the pin check.
    expect(
      await countRows("SELECT count(*) AS n FROM devices WHERE id = 'assistant-c'", harness().db),
    ).toBe(0);

    // The retry with the key the refusal named goes through.
    expectStatus(await registerAssistant('assistant-c', body.identityKeyPub), 201);
    const bob = await harness().enrol('bob', 'bob-phone');
    expect((await operatorDirectory(bob)).rows.map((row) => row.id)).toEqual([
      'assistant-a',
      'assistant-b',
      'assistant-c',
    ]);
  });

  it('judges a re-registration of an existing device by the immutability rule, not by the pin', async () => {
    expectStatus(await registerAssistant('assistant-a', OPERATOR_KEY), 201);
    expectStatus(await registerAssistant('assistant-a', OPERATOR_KEY), 200);
    const changed = await registerAssistant('assistant-a', OTHER_KEY);
    expectStatus(changed, 409);
    expect(changed.json()).toMatchObject({ error: RelayErrorCode.DEVICE_IDENTITY_IMMUTABLE });
    expect(changed.json()).not.toHaveProperty('identityKeyPub');
  });

  it('never gives the key to a token that is not the operator: it cannot register an ASSISTANT device at all', async () => {
    expectStatus(await registerAssistant('assistant-a', OPERATOR_KEY), 201);
    const mallory = await harness().caller({
      userId: 'mallory',
      deviceId: 'mallory-assistant',
      role: DeviceRole.ASSISTANT,
    });
    const forged = await mallory.post('/devices', {
      id: 'mallory-assistant',
      role: DeviceRole.ASSISTANT,
      userId: OPERATOR,
      identityKeyPub: OTHER_KEY,
      signatureKeyPub: keysOf('mallory-assistant').signatureKeyPub,
    });
    expectStatus(forged, 403);
    expect(forged.json()).toMatchObject({ error: RelayErrorCode.ROLE_FORBIDDEN });
    expect(forged.json()).not.toHaveProperty('identityKeyPub');
    expect(JSON.stringify(forged.json())).not.toContain(OPERATOR_KEY);
  });

  it('keeps ONE key per account across roles: a USER and an ASSISTANT device of the operator account share the pin', async () => {
    // The relay does not forbid the operator account from holding a USER device (a hub test's fake
    // relay registered the assistant's devices that way). If it does, the pin is the same row.
    const user = await harness().caller({ userId: OPERATOR, deviceId: 'operator-user-device' });
    expectStatus(
      await user.post('/devices', {
        id: 'operator-user-device',
        identityKeyPub: OPERATOR_KEY,
        signatureKeyPub: keysOf('operator-user-device').signatureKeyPub,
      }),
      201,
    );
    expectStatus(await registerAssistant('assistant-a', OPERATOR_KEY), 201);
    const refused = await registerAssistant('assistant-b', OTHER_KEY);
    expectStatus(refused, 409);
    expect(refused.json<IdentityKeyChangedBody>().identityKeyPub).toBe(OPERATOR_KEY);
  });

  describe('the reset releases the operator key (same admin rule, same IDENTITY_KEY_IN_USE guard)', () => {
    it('is refused to anyone who does not administer the operator, and the operator’s own device cannot pass the guard', async () => {
      expectStatus(await registerAssistant('assistant-a', OPERATOR_KEY), 201);
      const plain = await harness().caller({
        userId: OPERATOR,
        deviceId: 'assistant-a',
        role: DeviceRole.ASSISTANT,
      });
      const bob = await harness().enrol('bob', 'bob-phone');
      const introduced = await harness().introduce(bob, OPERATOR);
      for (const caller of [plain, bob, introduced]) {
        const refused = await caller.del(`/users/${OPERATOR}/identity-key`);
        expectStatus(refused, 403);
        expect(refused.json()).toMatchObject({ error: RelayErrorCode.REVOKE_FORBIDDEN });
      }

      // The worker's token names the operator in its own `adminOf`; its calling device is an active
      // ASSISTANT device, so the guard answers (the pin stays).
      const worker = await harness().caller(
        { userId: OPERATOR, deviceId: 'assistant-a', role: DeviceRole.ASSISTANT },
        { adminOf: [OPERATOR] },
      );
      const inUse = await worker.del(`/users/${OPERATOR}/identity-key`);
      expectStatus(inUse, 409);
      expect(inUse.json()).toMatchObject({ error: RelayErrorCode.IDENTITY_KEY_IN_USE, devices: 1 });
      expect((await operatorDirectory(bob)).identityKeyPub).toBe(OPERATOR_KEY);
    });

    it('waits for every ACTIVE ASSISTANT device, then the next ASSISTANT device pins a fresh key', async () => {
      expectStatus(await registerAssistant('assistant-a', OPERATOR_KEY), 201);
      expectStatus(await registerAssistant('assistant-b', OPERATOR_KEY), 201);
      await harness().enrol('mum', 'mum-phone');
      const mum = await harness().caller(
        { userId: 'mum', deviceId: 'mum-phone' },
        { adminOf: [OPERATOR] },
      );
      const bob = await harness().enrol('bob', 'bob-phone');

      const inUse = await mum.del(`/users/${OPERATOR}/identity-key`);
      expectStatus(inUse, 409);
      expect(inUse.json()).toMatchObject({ error: RelayErrorCode.IDENTITY_KEY_IN_USE, devices: 2 });

      // A revoked device is not counted; the one still active is.
      expectStatus(await mum.post('/devices/assistant-b/revoke'), 200);
      const stillInUse = await mum.del(`/users/${OPERATOR}/identity-key`);
      expectStatus(stillInUse, 409);
      expect(stillInUse.json()).toMatchObject({ devices: 1 });

      expectStatus(await mum.post('/devices/assistant-a/revoke'), 200);
      // 204: no body, so the status alone (expectStatus would print the body).
      expect((await mum.del(`/users/${OPERATOR}/identity-key`)).status).toBe(204);
      expect(await operatorDirectory(bob)).toEqual({
        rows: [],
        nextCursor: null,
        identityKeyPub: null,
      });

      expectStatus(await registerAssistant('assistant-d', OTHER_KEY), 201);
      expect((await operatorDirectory(bob)).identityKeyPub).toBe(OTHER_KEY);
      // The old key is refused now, with the new pin in the answer.
      const stale = await registerAssistant('assistant-e', OPERATOR_KEY);
      expectStatus(stale, 409);
      expect(stale.json<IdentityKeyChangedBody>().identityKeyPub).toBe(OTHER_KEY);
    });
  });
});

databaseSuite('TODO-518: GUARDIAN devices neither pin nor block', (harness) => {
  const GUARDIAN_KEY = b64('the-adult-behind-the-guardian-leaf');

  /** A GUARDIAN device on `child`, driven by the adult `mum` (the token lists the child in `guardianOf`). */
  async function registerGuardian(child: string, deviceId: string) {
    const device = await harness().caller(
      { userId: child, deviceId, role: DeviceRole.GUARDIAN, tokenUserId: 'mum' },
      { guardianOf: [child] },
    );
    return device.post('/devices', {
      id: deviceId,
      role: DeviceRole.GUARDIAN,
      userId: child,
      identityKeyPub: GUARDIAN_KEY,
      signatureKeyPub: keysOf(deviceId).signatureKeyPub,
    });
  }

  async function directoryOf(userId: string): Promise<DevicesPage> {
    const bob = await harness().enrol('bob', 'bob-phone');
    const introduced = await harness().introduce(bob, userId);
    const reply = await introduced.get(`/users/${userId}/devices`);
    expectStatus(reply, 200);
    return reply.json<DevicesPage>();
  }

  it('does not pin the key of a GUARDIAN device, and does not have to match the child’s pin', async () => {
    await harness().enrol('kid', 'kid-tablet');
    const pinned = keysOf('kid-tablet', 'kid').identityKeyPub;
    expect(pinned).not.toBe(GUARDIAN_KEY);

    // A different key on the guardian leaf is not a 409: it is not the child's key.
    expectStatus(await registerGuardian('kid', 'kid-guardian'), 201);
    const page = await directoryOf('kid');
    expect(page.identityKeyPub).toBe(pinned);
    expect(page.rows.map((row) => row.role).sort()).toEqual([DeviceRole.GUARDIAN, DeviceRole.USER]);
  });

  it('leaves an account whose only device is a GUARDIAN one without a pin', async () => {
    expectStatus(await registerGuardian('kid', 'kid-guardian'), 201);
    expect((await directoryOf('kid')).identityKeyPub).toBeNull();
  });

  it('does not count toward IDENTITY_KEY_IN_USE', async () => {
    await harness().enrol('kid', 'kid-tablet');
    expectStatus(await registerGuardian('kid', 'kid-guardian'), 201);
    await harness().enrol('mum', 'mum-phone');
    const mum = await harness().caller(
      { userId: 'mum', deviceId: 'mum-phone' },
      { adminOf: ['kid'] },
    );
    expectStatus(await mum.post('/devices/kid-tablet/revoke'), 200);
    // The guardian leaf is still active, and the reset goes through.
    expect((await mum.del('/users/kid/identity-key')).status).toBe(204);
  });
});

// The back-fill of 20261011120000_assistant_identity_keys: the migration is one INSERT, so the test
// seeds rows as the relay stored them BEFORE the pin existed (devices, no `identity_keys` row) and
// runs the migration file itself.
const MIGRATION_SQL = readFileSync(
  fileURLToPath(
    new URL(
      '../../prisma/migrations/20261011120000_assistant_identity_keys/migration.sql',
      import.meta.url,
    ),
  ),
  'utf8',
);

interface SeededDevice {
  id: string;
  userId: string;
  role: DeviceRole;
  key: string;
  createdAt: string;
  revoked?: true;
}

databaseSuite(
  'TODO-518: the migration back-fills the pin of an operator that registered before it',
  (harness) => {
    async function seed(h: Harness, devices: readonly SeededDevice[]): Promise<void> {
      for (const device of devices) {
        await h.db.query(
          `INSERT INTO devices (id, user_id, role, identity_key_pub, signature_key_pub, created_at, revoked_at)
         VALUES ($1, $2, $3::device_role, $4, $5, $6::timestamptz, $7::timestamptz)`,
          [
            device.id,
            device.userId,
            device.role,
            Buffer.from(device.key),
            Buffer.from(`signature-of-${device.id}`),
            device.createdAt,
            device.revoked === true ? '2026-10-10T12:00:00Z' : null,
          ],
        );
      }
    }

    async function pins(h: Harness): Promise<Record<string, string>> {
      const { rows } = await h.db.query<{ userId: string; key: Buffer }>(
        'SELECT user_id AS "userId", identity_key_pub AS key FROM identity_keys ORDER BY user_id',
      );
      return Object.fromEntries(rows.map((row) => [row.userId, row.key.toString()]));
    }

    it('pins the OLDEST ACTIVE ASSISTANT device’s key, once, and touches no other account', async () => {
      const h = harness();
      await seed(h, [
        // The operator: a revoked oldest device (never pins), then two active ones.
        {
          id: 'op-revoked',
          userId: OPERATOR,
          role: DeviceRole.ASSISTANT,
          key: 'key-Z',
          createdAt: '2026-10-10T08:00:00Z',
          revoked: true,
        },
        {
          id: 'op-b',
          userId: OPERATOR,
          role: DeviceRole.ASSISTANT,
          key: 'key-B',
          createdAt: '2026-10-10T10:00:00Z',
        },
        {
          id: 'op-a',
          userId: OPERATOR,
          role: DeviceRole.ASSISTANT,
          key: 'key-A',
          createdAt: '2026-10-10T09:00:00Z',
        },
        // A tie on created_at is broken by id.
        {
          id: 'tie-2',
          userId: 'tie',
          role: DeviceRole.ASSISTANT,
          key: 'key-T2',
          createdAt: '2026-10-10T09:00:00Z',
        },
        {
          id: 'tie-1',
          userId: 'tie',
          role: DeviceRole.ASSISTANT,
          key: 'key-T1',
          createdAt: '2026-10-10T09:00:00Z',
        },
        // Only a revoked ASSISTANT device: nothing to pin.
        {
          id: 'gone-1',
          userId: 'gone',
          role: DeviceRole.ASSISTANT,
          key: 'key-G',
          createdAt: '2026-10-10T09:00:00Z',
          revoked: true,
        },
        // A GUARDIAN device never pins.
        {
          id: 'kid-guardian',
          userId: 'kid',
          role: DeviceRole.GUARDIAN,
          key: 'key-adult',
          createdAt: '2026-10-10T09:00:00Z',
        },
        // A USER device the R2-A2 migration already pinned keeps its pin; the ASSISTANT one does not replace it.
        {
          id: 'dual-user',
          userId: 'dual',
          role: DeviceRole.USER,
          key: 'key-U',
          createdAt: '2026-10-10T08:00:00Z',
        },
        {
          id: 'dual-assistant',
          userId: 'dual',
          role: DeviceRole.ASSISTANT,
          key: 'key-V',
          createdAt: '2026-10-10T09:00:00Z',
        },
        // A USER-only account is not this migration's business (R2-A2 did it).
        {
          id: 'alice-phone',
          userId: 'alice',
          role: DeviceRole.USER,
          key: 'key-alice',
          createdAt: '2026-10-10T09:00:00Z',
        },
      ]);
      await h.db.query(
        "INSERT INTO identity_keys (user_id, identity_key_pub) VALUES ('dual', $1)",
        [Buffer.from('key-U')],
      );

      await h.db.query(MIGRATION_SQL);
      const expected = { [OPERATOR]: 'key-A', dual: 'key-U', tie: 'key-T1' };
      expect(await pins(h)).toEqual(expected);

      // Running it again changes nothing.
      await h.db.query(MIGRATION_SQL);
      expect(await pins(h)).toEqual(expected);
    });

    it('serves the back-filled pin, and holds the next ASSISTANT device to it', async () => {
      const h = harness();
      const stored = 'operator-key-from-before-the-pin';
      await seed(h, [
        {
          id: 'op-a',
          userId: OPERATOR,
          role: DeviceRole.ASSISTANT,
          key: stored,
          createdAt: '2026-10-10T09:00:00Z',
        },
      ]);
      await h.db.query(MIGRATION_SQL);

      const bob = await h.enrol('bob', 'bob-phone');
      const page = await bob.get(`/users/${OPERATOR}/devices`);
      expectStatus(page, 200);
      expect(page.json<DevicesPage>().identityKeyPub).toBe(b64(stored));

      const register = async (deviceId: string, identityKeyPub: string) =>
        (await h.caller({ userId: OPERATOR, deviceId, role: DeviceRole.ASSISTANT })).post(
          '/devices',
          {
            id: deviceId,
            role: DeviceRole.ASSISTANT,
            identityKeyPub,
            signatureKeyPub: keysOf(deviceId).signatureKeyPub,
          },
        );
      const refused = await register('op-next', OTHER_KEY);
      expectStatus(refused, 409);
      expect(refused.json<IdentityKeyChangedBody>().identityKeyPub).toBe(b64(stored));
      expectStatus(await register('op-next', b64(stored)), 201);
    });
  },
);
