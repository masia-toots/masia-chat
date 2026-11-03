import { createPublicKey, verify } from 'node:crypto';
import {
  DEVICE_LIST_VERSIONS_PAGE_MAX,
  type DeviceListEntry,
  DeviceRole,
  RelayErrorCode,
} from '@masia/relay';
import { describe, expect, it } from 'vitest';
import { DEVICE_LIST_V1_FORMAT, DEVICE_LIST_V1_VECTOR } from './fixtures/device-list-v1.js';
import {
  b64,
  type Caller,
  databaseSuite,
  expectStatus,
  keysOf,
  listEntry,
  OPERATOR,
  signedList,
} from './support/harness.js';

// R2-A2 (2026-10-10): the relay contracts the hub's enrolment needs for К8 — TODO-504 (a)(b)(c) and
// the host introduction of TODO-506 (ADR-117 amendment (к)).

interface VersionsPage {
  rows: Array<{ userId: string; version: number; devices: DeviceListEntry[]; signature: string }>;
  nextCursor: string | null;
}

/** Ed25519 SPKI DER prefix for a raw 32-byte public key (RFC 8410). */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function ed25519Verifies(publicKeyB64: string, message: string, signatureB64: string): boolean {
  const key = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKeyB64, 'base64')]),
    format: 'der',
    type: 'spki',
  });
  return verify(null, Buffer.from(message, 'utf8'), key, Buffer.from(signatureB64, 'base64'));
}

/**
 * What a client's verifier signs over, rebuilt from a SERVED row only: the format tag, the owner, the
 * version and the entries sorted by id, fixed key order (the vector's `signingBytes` came from the
 * client's own `deviceListSigningBytes`; equality below is what proves the relay kept every byte).
 */
function rebuiltSigningBytes(row: VersionsPage['rows'][number]): string {
  const devices = [...row.devices]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((d) => ({
      id: d.id,
      role: d.role,
      signatureKey: d.signatureKey,
      ...(d.conversationId === undefined ? {} : { conversationId: d.conversationId }),
    }));
  return JSON.stringify({
    format: DEVICE_LIST_V1_FORMAT,
    userId: row.userId,
    version: row.version,
    devices,
  });
}

const SECOND_IDENTITY = b64('another-identity-key-of-the-same-person');

databaseSuite('R2-A2 relay contracts (TODO-504, TODO-506)', (harness) => {
  async function registerUser(userId: string, deviceId: string, identityKeyPub: string) {
    const device = await harness().caller({ userId, deviceId });
    return device.post('/devices', {
      id: deviceId,
      identityKeyPub,
      signatureKeyPub: keysOf(deviceId).signatureKeyPub,
    });
  }

  describe('(a) every version is kept and served oldest first, byte-exact', () => {
    it('serves the client-signed mls-device-list/v1 vector back so the signature verifies unchanged', async () => {
      const { person } = DEVICE_LIST_V1_VECTOR;
      expectStatus(await registerUser('alice', 'alice-phone', person.identityKeyPub), 201);
      const alice = await harness().caller({ userId: 'alice', deviceId: 'alice-phone' });
      for (const version of person.versions) {
        const put = await alice.post('/users/me/device-list', {
          version: version.version,
          devices: version.devices,
          signature: version.signature,
        });
        expectStatus(put, 201);
      }

      const page = await alice.get('/users/alice/device-list/versions?afterVersion=0');
      expectStatus(page, 200);
      const { rows, nextCursor } = page.json<VersionsPage>();
      expect(nextCursor).toBeNull();
      expect(rows.map((row) => row.version)).toEqual([1, 2]);
      rows.forEach((row, index) => {
        const signed = person.versions[index];
        expect(rebuiltSigningBytes(row)).toBe(signed?.signingBytes);
        expect(
          ed25519Verifies(person.identityKeyPub, rebuiltSigningBytes(row), row.signature),
        ).toBe(true);
      });

      // The pinned identity key travels with the directory: the key the list verifies under.
      const devices = await alice.get('/users/alice/devices');
      expect(devices.json<{ identityKeyPub: string }>().identityKeyPub).toBe(person.identityKeyPub);
    });

    it('pages by version: `nextCursor` is the last version, passed back as `afterVersion`', async () => {
      const alice = await harness().enrol('alice', 'alice-phone');
      for (const version of [2, 3]) {
        expectStatus(
          await alice.post('/users/me/device-list', signedList('alice', version, [listEntry('alice-phone')])),
          201,
        );
      }
      const first = (
        await alice.get('/users/alice/device-list/versions?limit=2')
      ).json<VersionsPage>();
      expect(first.rows.map((row) => row.version)).toEqual([1, 2]);
      expect(first.nextCursor).toBe('2');
      const rest = (
        await alice.get(`/users/alice/device-list/versions?afterVersion=${first.nextCursor}`)
      ).json<VersionsPage>();
      expect(rest).toMatchObject({ nextCursor: null });
      expect(rest.rows.map((row) => row.version)).toEqual([3]);
      // A user with no list newer than the pin: an empty page, not a 404.
      const none = await alice.get('/users/alice/device-list/versions?afterVersion=3');
      expect(none.json<VersionsPage>()).toEqual({ rows: [], nextCursor: null });
      expectStatus(
        await alice.get(
          `/users/alice/device-list/versions?limit=${DEVICE_LIST_VERSIONS_PAGE_MAX + 1}`,
        ),
        400,
      );
    });

    it('sits behind the contact gate: a stranger is refused, an introduced device reads', async () => {
      await harness().enrol('alice', 'alice-phone');
      const bob = await harness().enrol('bob', 'bob-phone');
      const refused = await bob.get('/users/alice/device-list/versions');
      expectStatus(refused, 403);
      expect(refused.json()).toMatchObject({ error: RelayErrorCode.NOT_A_CONTACT });
      const introduced = await harness().introduce(bob, 'alice');
      const read = await introduced.get('/users/alice/device-list/versions');
      expectStatus(read, 200);
      expect(read.json<VersionsPage>().rows).toHaveLength(1);
    });
  });

  describe('(b) a conversationId belongs to an ASSISTANT entry only', () => {
    it('stores the operator vector with its binding and serves it back', async () => {
      const { operator } = DEVICE_LIST_V1_VECTOR;
      const [version] = operator.versions;
      // The first ASSISTANT device pins the operator key, which the vector's list is signed by.
      const device = await harness().caller({
        userId: OPERATOR,
        deviceId: 'assistant-room-1',
        role: DeviceRole.ASSISTANT,
      });
      expectStatus(
        await device.post('/devices', {
          id: 'assistant-room-1',
          role: DeviceRole.ASSISTANT,
          userId: OPERATOR,
          name: 'assistant-room-1',
          identityKeyPub: operator.identityKeyPub,
          signatureKeyPub: version.devices[0].signatureKey,
        }),
        201,
      );
      expectStatus(
        await device.post('/users/me/device-list', {
          version: version.version,
          devices: version.devices,
          signature: version.signature,
        }),
        201,
      );
      const bob = await harness().enrol('bob', 'bob-phone');
      const page = (await bob.get(`/users/${OPERATOR}/device-list/versions`)).json<VersionsPage>();
      const [row] = page.rows;
      expect(row?.devices).toEqual(version.devices);
      expect(row && rebuiltSigningBytes(row)).toBe(version.signingBytes);
      expect(
        row && ed25519Verifies(operator.identityKeyPub, version.signingBytes, row.signature),
      ).toBe(true);
    });

    it('refuses a conversationId on a USER entry (422) and stores nothing', async () => {
      const alice = await harness().enrol('alice', 'alice-phone');
      const reply = await alice.post('/users/me/device-list', {
        version: 2,
        devices: [
          {
            id: 'alice-phone',
            role: DeviceRole.USER,
            signatureKey: keysOf('alice-phone').signatureKeyPub,
            conversationId: 'room-1',
          },
        ],
        signature: b64('sig'),
      });
      expectStatus(reply, 422);
      expect(reply.json()).toMatchObject({ error: RelayErrorCode.DEVICE_LIST_ENTRY_INVALID });
      const list = (await alice.get('/users/alice/device-list')).json<{ version: number }>();
      expect(list.version).toBe(1);
    });
  });

  describe('(c) one identity key per person', () => {
    it('pins the first USER device key; a second USER device must carry it (409 otherwise)', async () => {
      const key = keysOf('x', 'alice').identityKeyPub;
      expectStatus(await registerUser('alice', 'alice-phone', key), 201);
      expectStatus(await registerUser('alice', 'alice-laptop', key), 201);
      const changed = await registerUser('alice', 'alice-tablet', SECOND_IDENTITY);
      expectStatus(changed, 409);
      expect(changed.json()).toMatchObject({ error: RelayErrorCode.IDENTITY_KEY_CHANGED });
      // Refused means not registered: the device row was rolled back with the pin check.
      const owner = await harness().caller({ userId: 'alice', deviceId: 'alice-phone' });
      const devices = (await owner.get('/users/alice/devices')).json<{
        rows: Array<{ id: string }>;
        identityKeyPub: string;
      }>();
      expect(devices.rows.map((row) => row.id).sort()).toEqual(['alice-laptop', 'alice-phone']);
      expect(devices.identityKeyPub).toBe(key);
    });

    it('does not pin a GUARDIAN device (an ASSISTANT one pins the operator key: rg2-contracts.test.ts)', async () => {
      await harness().enrol('kid', 'kid-tablet');
      await harness().enrol('kid', 'kid-guardian', DeviceRole.GUARDIAN);
      await harness().enrol(OPERATOR, 'assistant-a', DeviceRole.ASSISTANT);
      await harness().enrol(OPERATOR, 'assistant-b', DeviceRole.ASSISTANT);
      const kid = await harness().caller({ userId: 'kid', deviceId: 'kid-tablet' });
      const devices = (await kid.get('/users/kid/devices')).json<{ identityKeyPub: string }>();
      expect(devices.identityKeyPub).toBe(keysOf('kid-tablet', 'kid').identityKeyPub);
    });

    it('is reset only explicitly: by an admin of the person, once every USER device is revoked', async () => {
      const key = keysOf('x', 'alice').identityKeyPub;
      expectStatus(await registerUser('alice', 'alice-phone', key), 201);
      await harness().enrol('mum', 'mum-phone');
      const mum = await harness().caller(
        { userId: 'mum', deviceId: 'mum-phone' },
        { adminOf: ['alice'] },
      );
      const plainMum = await harness().caller({ userId: 'mum', deviceId: 'mum-phone' });
      const alice = await harness().caller({ userId: 'alice', deviceId: 'alice-phone' });
      // An introduction is no admin right either.
      const introduced: Caller = await harness().introduce(plainMum, 'alice');
      for (const caller of [plainMum, introduced, alice]) {
        const refused = await caller.del('/users/alice/identity-key');
        expectStatus(refused, 403);
        expect(refused.json()).toMatchObject({ error: RelayErrorCode.REVOKE_FORBIDDEN });
      }
      const inUse = await mum.del('/users/alice/identity-key');
      expectStatus(inUse, 409);
      expect(inUse.json()).toMatchObject({ error: RelayErrorCode.IDENTITY_KEY_IN_USE, devices: 1 });

      expectStatus(await mum.post('/devices/alice-phone/revoke'), 200);
      // 204: no body, so the status alone (expectStatus would print the body).
      expect((await mum.del('/users/alice/identity-key')).status).toBe(204);
      expectStatus(await registerUser('alice', 'alice-new-phone', SECOND_IDENTITY), 201);
      const fresh = await harness().caller({ userId: 'alice', deviceId: 'alice-new-phone' });
      const devices = (await fresh.get('/users/alice/devices')).json<{ identityKeyPub: string }>();
      expect(devices.identityKeyPub).toBe(SECOND_IDENTITY);
    });
  });

  describe('TODO-506: the host introduction (`reach` claim) opens the first Add', () => {
    it('lets an introduced device claim a key package of a person it shares no room with', async () => {
      await harness().enrol('alice', 'alice-phone');
      const bob = await harness().enrol('bob', 'bob-phone');
      const strangers = await bob.post('/key-packages/claim', { userId: 'alice' });
      expectStatus(strangers, 403);
      expect(strangers.json()).toMatchObject({ error: RelayErrorCode.NOT_A_CONTACT });
      const introduced = await harness().introduce(bob, 'alice');
      const claimed = await introduced.post('/key-packages/claim', { userId: 'alice' });
      expect(claimed.json()).not.toMatchObject({ error: RelayErrorCode.NOT_A_CONTACT });
      expect(claimed.status).toBe(200);
      expect((await introduced.get('/users/alice/devices')).status).toBe(200);
      expect((await introduced.get('/users/alice/device-list')).status).toBe(200);
    });

    it("gives a child's directory as PUBLIC rows only, and no guardian rights", async () => {
      await harness().enrol('kid', 'kid-tablet');
      const bob = await harness().enrol('bob', 'bob-phone');
      const introduced = await harness().introduce(bob, 'kid');
      const devices = (await introduced.get('/users/kid/devices')).json<{
        rows: Array<Record<string, unknown>>;
      }>();
      expect(devices.rows).toHaveLength(1);
      expect(Object.keys(devices.rows[0] ?? {}).sort()).toEqual([
        'id',
        'identityKeyPub',
        'role',
        'signatureKeyPub',
      ]);
      const guardian = await harness().caller(
        { userId: 'kid', deviceId: 'bob-guardian', role: DeviceRole.GUARDIAN, tokenUserId: 'bob' },
        { reach: ['kid'] },
      );
      const planted = await guardian.post('/devices', {
        id: 'bob-guardian',
        userId: 'kid',
        role: DeviceRole.GUARDIAN,
        ...keysOf('bob-guardian', 'bob'),
      });
      expectStatus(planted, 403);
      expect(planted.json()).toMatchObject({ error: RelayErrorCode.ROLE_FORBIDDEN });
    });
  });
});
