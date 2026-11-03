import {
  DEVICE_LIST_ERRORS,
  type DeviceListEntry,
  DeviceListError,
  DeviceRole,
  deviceListSigningBytes,
  RelayErrorCode,
  verifyDeviceListSignature,
} from '@masia/relay';
import { describe, expect, it } from 'vitest';
import { DEVICE_LIST_V1_VECTOR } from './fixtures/device-list-v1.js';
import {
  b64,
  type Caller,
  countRows,
  databaseSuite,
  expectStatus,
  keysOf,
  listEntry,
  OPERATOR,
  signedList,
} from './support/harness.js';

interface VersionsPage {
  rows: Array<{ userId: string; version: number; devices: DeviceListEntry[]; signature: string }>;
  nextCursor: string | null;
}

const NO_SIGNATURE = Buffer.alloc(64).toString('base64');

/** Every served version checked the way a member does: under the pinned key, oldest first. */
async function everyVersionVerifies(identityKeyPub: string, page: VersionsPage): Promise<void> {
  expect(page.rows.length).toBeGreaterThan(0);
  for (const row of page.rows) {
    await verifyDeviceListSignature(Buffer.from(identityKeyPub, 'base64'), {
      userId: row.userId,
      version: row.version,
      devices: row.devices,
      signature: Buffer.from(row.signature, 'base64'),
    });
  }
}

describe('the shared encoder reproduces the client-signed vector', () => {
  const vectors = [DEVICE_LIST_V1_VECTOR.person, DEVICE_LIST_V1_VECTOR.operator].flatMap((owner) =>
    owner.versions.map((version) => ({ owner, version })),
  );

  it.each(vectors)(
    'v$version.version of $owner.userId: same canonical bytes, and the signature verifies',
    async ({ owner, version }) => {
      const devices: DeviceListEntry[] = version.devices.map((device) => ({ ...device }));
      const bytes = deviceListSigningBytes(owner.userId, version.version, devices);
      expect(new TextDecoder().decode(bytes)).toBe(version.signingBytes);

      const identityKey = Buffer.from(owner.identityKeyPub, 'base64');
      const signature = Buffer.from(version.signature, 'base64');
      const list = { userId: owner.userId, version: version.version, devices, signature };
      await expect(verifyDeviceListSignature(identityKey, list)).resolves.toEqual(bytes);

      // The same signature does not carry over to another owner, version or contents.
      for (const other of [
        { ...list, userId: 'mallory' },
        { ...list, version: version.version + 1 },
        { ...list, devices: [...devices, listEntry('ghost')] },
      ]) {
        await expect(verifyDeviceListSignature(identityKey, other)).rejects.toMatchObject({
          code: DEVICE_LIST_ERRORS.BAD_SIGNATURE,
        });
      }
    },
  );

  it('refuses entries it cannot encode, whoever signed them', () => {
    const shortKey: DeviceListEntry = { id: 'a', role: DeviceRole.USER, signatureKey: b64('short') };
    expect(() => deviceListSigningBytes('alice', 1, [shortKey])).toThrow(DeviceListError);
    const unbound: DeviceListEntry = { ...listEntry('a'), role: DeviceRole.ASSISTANT };
    expect(() => deviceListSigningBytes('alice', 1, [unbound])).toThrow(DeviceListError);
  });
});

databaseSuite('the relay verifies the signature of every device list it stores', (harness) => {
  async function register(userId: string, deviceId: string, identityKeyPub: string) {
    const device = await harness().caller({ userId, deviceId });
    expectStatus(
      await device.post('/devices', {
        id: deviceId,
        identityKeyPub,
        signatureKeyPub: keysOf(deviceId).signatureKeyPub,
      }),
      201,
    );
    return device;
  }

  async function currentVersion(reader: Caller, userId: string): Promise<number> {
    return (await reader.get(`/users/${userId}/device-list`)).json<{ version: number }>().version;
  }

  describe('refuses a signature the pinned identity key did not make (422 DEVICE_LIST_SIGNATURE_INVALID)', () => {
    it('refuses junk from a device of the account, and stores nothing', async () => {
      const alice = await harness().enrol('alice', 'alice-phone');
      const reply = await alice.post('/users/me/device-list', {
        version: 2,
        devices: [listEntry('alice-phone'), listEntry('ghost-phone')],
        signature: NO_SIGNATURE,
      });
      expectStatus(reply, 422);
      expect(reply.json()).toMatchObject({
        error: RelayErrorCode.DEVICE_LIST_SIGNATURE_INVALID,
        reason: 'BAD_SIGNATURE',
      });
      // Nothing was stored, and the refusal burned no version: the next honest upload is v2.
      expect(await currentVersion(alice, 'alice')).toBe(1);
      expect(
        await countRows(
          "SELECT count(*) AS n FROM device_list_versions WHERE user_id = 'alice'",
          harness().db,
        ),
      ).toBe(1);
      expectStatus(
        await alice.post(
          '/users/me/device-list',
          signedList('alice', 2, [listEntry('alice-phone'), listEntry('alice-tablet')]),
        ),
        201,
      );
    });

    it.each([
      ['a signature of the wrong length', b64('short')],
      ['a signature of zeros', NO_SIGNATURE],
    ])('refuses %s', async (_label, signature) => {
      const alice = await harness().enrol('alice', 'alice-phone');
      const reply = await alice.post('/users/me/device-list', {
        version: 2,
        devices: [listEntry('alice-phone')],
        signature,
      });
      expectStatus(reply, 422);
      expect(reply.json()).toMatchObject({ error: RelayErrorCode.DEVICE_LIST_SIGNATURE_INVALID });
    });

    it("refuses a list signed by another account's identity key", async () => {
      const mallory = await harness().enrol('mallory', 'mallory-phone');
      await harness().enrol('alice', 'alice-phone');
      // The bytes name mallory, the signature is alice's key over them.
      const forged = signedList('mallory', 2, [listEntry('mallory-phone')], 'alice');
      const reply = await mallory.post('/users/me/device-list', forged);
      expectStatus(reply, 422);
      expect(reply.json()).toMatchObject({ error: RelayErrorCode.DEVICE_LIST_SIGNATURE_INVALID });
    });

    it('refuses a genuine signature moved to other contents, another version or another owner', async () => {
      const alice = await harness().enrol('alice', 'alice-phone');
      const mallory = await harness().enrol('mallory', 'mallory-phone');
      const genuine = signedList('alice', 2, [listEntry('alice-phone'), listEntry('alice-tablet')]);

      // Other contents under the same signature (a ghost device added to a signed list).
      const ghosted = { ...genuine, devices: [...genuine.devices, listEntry('ghost-phone')] };
      expectStatus(await alice.post('/users/me/device-list', ghosted), 422);
      // The same contents under a signature made for another version (a replayed signature).
      expectStatus(
        await alice.post('/users/me/device-list', {
          ...signedList('alice', 3, genuine.devices),
          version: 2,
        }),
        422,
      );
      expectStatus(
        await alice.post('/users/me/device-list', {
          ...signedList('alice', 2, [listEntry('alice-phone')]),
          devices: genuine.devices,
        }),
        422,
      );
      // Alice's own signed list, uploaded by mallory under mallory's name.
      expectStatus(await mallory.post('/users/me/device-list', genuine), 422);
      expect(await currentVersion(alice, 'alice')).toBe(1);
    });

    it('refuses a list for an account that has no pinned key, whoever signed it', async () => {
      const alice = await harness().enrol('alice', 'alice-phone');
      await harness().db.query("DELETE FROM identity_keys WHERE user_id = 'alice'");
      const reply = await alice.post(
        '/users/me/device-list',
        signedList('alice', 2, [listEntry('alice-phone')]),
      );
      expectStatus(reply, 422);
      expect(reply.json()).toMatchObject({
        error: RelayErrorCode.DEVICE_LIST_SIGNATURE_INVALID,
        reason: 'NO_PINNED_KEY',
      });
    });

    it('checks the version first: a stale version is a 409 whatever the signature says', async () => {
      const alice = await harness().enrol('alice', 'alice-phone');
      const reply = await alice.post('/users/me/device-list', {
        version: 1,
        devices: [listEntry('alice-phone')],
        signature: NO_SIGNATURE,
      });
      expectStatus(reply, 409);
      expect(reply.json()).toMatchObject({ currentVersion: 1 });
    });
  });

  describe('refuses entries no member could accept (422 DEVICE_LIST_ENTRY_INVALID)', () => {
    it('refuses a signature key that is not 32 bytes', async () => {
      const alice = await harness().enrol('alice', 'alice-phone');
      const reply = await alice.post('/users/me/device-list', {
        version: 2,
        devices: [{ ...listEntry('alice-phone'), signatureKey: b64('not-32-bytes') }],
        signature: NO_SIGNATURE,
      });
      expectStatus(reply, 422);
      expect(reply.json()).toMatchObject({ error: RelayErrorCode.DEVICE_LIST_ENTRY_INVALID });
    });

    it('refuses an ASSISTANT entry without its conversation, and accepts one with it', async () => {
      const assistant = await harness().registerUnlisted(
        OPERATOR,
        'assistant-1',
        DeviceRole.ASSISTANT,
      );
      const unbound: DeviceListEntry = { ...listEntry('assistant-1'), role: DeviceRole.ASSISTANT };
      const refused = await assistant.post('/users/me/device-list', {
        version: 1,
        devices: [unbound],
        signature: NO_SIGNATURE,
      });
      expectStatus(refused, 422);
      expect(refused.json()).toMatchObject({ error: RelayErrorCode.DEVICE_LIST_ENTRY_INVALID });

      const bound = listEntry('assistant-1', DeviceRole.ASSISTANT, 'room-1');
      expectStatus(
        await assistant.post('/users/me/device-list', signedList(OPERATOR, 1, [bound])),
        201,
      );
    });
  });

  describe('keeps one forged version from blocking an account for good', () => {
    it('an unapproved device of the account cannot plant a version; the real chain stays verifiable', async () => {
      const alice = await harness().enrol('alice', 'alice-phone');
      // A second device that registered with the public pinned key but is on no signed list yet,
      // and holds no private key.
      const intruder = await harness().registerUnlisted('alice', 'alice-intruder');
      const planted = await intruder.post('/users/me/device-list', {
        version: 2,
        devices: [listEntry('alice-phone'), listEntry('alice-intruder')],
        signature: NO_SIGNATURE,
      });
      expectStatus(planted, 422);

      // The real phone publishes v2 without any repair step, and every reader verifies the chain.
      expectStatus(
        await alice.post(
          '/users/me/device-list',
          signedList('alice', 2, [listEntry('alice-phone'), listEntry('alice-laptop')]),
        ),
        201,
      );
      const bob = await harness().introduce(await harness().enrol('bob', 'bob-phone'), 'alice');
      const page = (await bob.get('/users/alice/device-list/versions?afterVersion=0')).json<VersionsPage>();
      expect(page.rows.map((row) => row.version)).toEqual([1, 2]);
      const directory = (await bob.get('/users/alice/devices')).json<{ identityKeyPub: string }>();
      await everyVersionVerifies(directory.identityKeyPub, page);
    });
  });

  describe('an identity-key reset starts a new chain', () => {
    it("drops the account's old versions, so nothing signed by the released key is served", async () => {
      await harness().enrol('alice', 'alice-phone'); // v1
      await harness().enrol('alice', 'alice-tablet'); // v2
      const bobPhone = await harness().enrol('bob', 'bob-phone'); // bob's own chain: v1
      await harness().enrol('mum', 'mum-phone');
      const mum = await harness().caller(
        { userId: 'mum', deviceId: 'mum-phone' },
        { adminOf: ['alice'] },
      );
      const dave = await harness().introduce(await harness().enrol('dave', 'dave-phone'), 'alice');

      expectStatus(await mum.post('/devices/alice-phone/revoke'), 200);
      expectStatus(await mum.post('/devices/alice-tablet/revoke'), 200);
      expect((await mum.del('/users/alice/identity-key')).status).toBe(204);

      // Nothing of the old chain is left to serve, to the admin or to a new correspondent.
      for (const table of ['device_lists', 'device_list_versions']) {
        expect(
          await countRows(`SELECT count(*) AS n FROM ${table} WHERE user_id = 'alice'`, harness().db),
        ).toBe(0);
      }
      const noList = await dave.get('/users/alice/device-list');
      expectStatus(noList, 404);
      expect(noList.json()).toMatchObject({ error: RelayErrorCode.DEVICE_LIST_NOT_FOUND });
      expect((await dave.get('/users/alice/device-list/versions')).json<VersionsPage>()).toEqual({
        rows: [],
        nextCursor: null,
      });
      // Other accounts keep their chains.
      expect(await currentVersion(bobPhone, 'bob')).toBe(1);

      // The next device pins a NEW key and starts at version 1.
      const newKey = keysOf('alice-new-phone', 'alice-v2').identityKeyPub;
      const newPhone = await register('alice', 'alice-new-phone', newKey);
      const entries = [listEntry('alice-new-phone')];
      // Not a continuation of the old chain...
      const continued = await newPhone.post(
        '/users/me/device-list',
        signedList('alice', 3, entries, 'alice-v2'),
      );
      expectStatus(continued, 409);
      expect(continued.json()).toMatchObject({ currentVersion: 0 });
      // ...and not under the released key.
      const underOldKey = await newPhone.post('/users/me/device-list', signedList('alice', 1, entries));
      expectStatus(underOldKey, 422);
      expect(underOldKey.json()).toMatchObject({ error: RelayErrorCode.DEVICE_LIST_SIGNATURE_INVALID });
      expectStatus(
        await newPhone.post('/users/me/device-list', signedList('alice', 1, entries, 'alice-v2')),
        201,
      );

      const page = (await dave.get('/users/alice/device-list/versions?afterVersion=0')).json<VersionsPage>();
      expect(page.rows.map((row) => row.version)).toEqual([1]);
      const directory = (await dave.get('/users/alice/devices')).json<{ identityKeyPub: string }>();
      expect(directory.identityKeyPub).toBe(newKey);
      await everyVersionVerifies(directory.identityKeyPub, page);
    });
  });
});
