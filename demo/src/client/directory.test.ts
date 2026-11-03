import { describe, expect, it } from 'vitest';
import { DeviceRole, RelayErrorCode } from '@masia/contracts/wire';
import { generateIdentityKeyPair, signDeviceList } from '@masia/messenger/mls';
import { toBase64 } from './bytes.js';
import { createRelayDirectory, LIST_TTL_MS } from './directory.js';
import { RelayHttpError, type RelayApi, type ServedDeviceList } from './relay-api.js';

type Identity = Awaited<ReturnType<typeof generateIdentityKeyPair>>;

const SIGNATURE_KEY = new Uint8Array(32).fill(7);

async function listFor(userId: string, identity: Identity, version = 1, deviceId = 'd1'): Promise<ServedDeviceList> {
  const signed = await signDeviceList(identity.privateKeyPkcs8, {
    userId,
    version,
    devices: [{ deviceId, role: DeviceRole.USER, signatureKey: SIGNATURE_KEY }],
  });
  return {
    userId,
    version,
    devices: [{ id: deviceId, role: DeviceRole.USER, signatureKey: toBase64(SIGNATURE_KEY) }],
    signature: signed.signature,
  };
}

/** The two relay calls the directory makes, scripted, with a count of each. */
function fakeApi(handlers: {
  list: (userId: string) => Promise<ServedDeviceList | null>;
  key?: (userId: string) => Promise<Uint8Array | null>;
}) {
  const calls = { list: 0, key: 0 };
  const api = {
    getDeviceList: (userId: string) => {
      calls.list += 1;
      return handlers.list(userId);
    },
    identityKeyOf: (userId: string) => {
      calls.key += 1;
      return (handlers.key ?? (() => Promise.resolve(null)))(userId);
    },
  } as unknown as RelayApi;
  return { api, calls };
}

describe('the relay directory', () => {
  it('believes a device list only after it passes the person\'s identity key, and says who is listed', async () => {
    const me = await generateIdentityKeyPair();
    const bo = await generateIdentityKeyPair();
    const { api } = fakeApi({
      list: async () => listFor('u-bo', bo),
      key: async () => bo.publicKey,
    });
    const directory = createRelayDirectory({ api, self: { userId: 'u-ada', identityKey: me.publicKey } });

    const list = await directory.deviceListOf('u-bo');
    expect(list?.version).toBe(1);
    expect(list?.devices.map((d) => d.deviceId)).toEqual(['d1']);
    expect(await directory.listedSince('u-bo', { deviceId: 'd1', role: DeviceRole.USER, signatureKey: SIGNATURE_KEY }, 1)).toBe(1);
    expect(await directory.listedSince('u-bo', { deviceId: 'd9', role: DeviceRole.USER, signatureKey: SIGNATURE_KEY }, 1)).toBeUndefined();
    expect(
      await directory.listedSince('u-bo', { deviceId: 'd1', role: DeviceRole.USER, signatureKey: new Uint8Array(32) }, 1),
    ).toBeUndefined();
    expect(await directory.listedSince('u-bo', { deviceId: 'd1', role: DeviceRole.USER, signatureKey: SIGNATURE_KEY }, 2)).toBeUndefined();
  });

  it('pins a person\'s identity key at first use and refuses a list signed by any other key later', async () => {
    const me = await generateIdentityKeyPair();
    const bo = await generateIdentityKeyPair();
    const impostor = await generateIdentityKeyPair();
    let served: Promise<ServedDeviceList> = listFor('u-bo', bo, 1);
    let now = 0;
    const { api } = fakeApi({ list: () => served, key: async () => bo.publicKey });
    const directory = createRelayDirectory({ api, self: { userId: 'u-ada', identityKey: me.publicKey }, now: () => now });

    await directory.deviceListOf('u-bo');
    expect(directory.pinnedKeyOf('u-bo')).toEqual(bo.publicKey);

    served = listFor('u-bo', impostor, 2);
    now += LIST_TTL_MS;
    await expect(directory.deviceListOf('u-bo')).rejects.toThrow();
    expect(directory.pinnedKeyOf('u-bo')).toEqual(bo.publicKey);
  });

  it('never looks up its own key: the tab made it', async () => {
    const me = await generateIdentityKeyPair();
    const { api, calls } = fakeApi({ list: async () => listFor('u-ada', me) });
    const directory = createRelayDirectory({ api, self: { userId: 'u-ada', identityKey: me.publicKey } });
    expect((await directory.deviceListOf('u-ada'))?.version).toBe(1);
    expect(calls.key).toBe(0);
  });

  it('keeps a verified list for a while so the relay is not asked on every message, and asks again after', async () => {
    const me = await generateIdentityKeyPair();
    const bo = await generateIdentityKeyPair();
    let now = 1_000;
    const { api, calls } = fakeApi({ list: async () => listFor('u-bo', bo), key: async () => bo.publicKey });
    const directory = createRelayDirectory({ api, self: { userId: 'u-ada', identityKey: me.publicKey }, now: () => now });

    await directory.deviceListOf('u-bo');
    await directory.deviceListOf('u-bo');
    expect(calls.list).toBe(1);
    now += LIST_TTL_MS - 1;
    await directory.deviceListOf('u-bo');
    expect(calls.list).toBe(1);
    now += 1;
    await directory.deviceListOf('u-bo');
    expect(calls.list).toBe(2);
  });

  it('asks the relay again when the engine asks for a refresh, whatever it holds', async () => {
    const me = await generateIdentityKeyPair();
    const bo = await generateIdentityKeyPair();
    const { api, calls } = fakeApi({ list: async () => listFor('u-bo', bo), key: async () => bo.publicKey });
    const directory = createRelayDirectory({ api, self: { userId: 'u-ada', identityKey: me.publicKey } });
    await directory.deviceListOf('u-bo');
    await directory.refreshDeviceList?.('u-bo');
    expect(calls.list).toBe(2);
  });

  it('shares one request between lookups of the same person made at the same moment', async () => {
    const me = await generateIdentityKeyPair();
    const bo = await generateIdentityKeyPair();
    const { api, calls } = fakeApi({ list: async () => listFor('u-bo', bo), key: async () => bo.publicKey });
    const directory = createRelayDirectory({ api, self: { userId: 'u-ada', identityKey: me.publicKey } });
    await Promise.all([directory.deviceListOf('u-bo'), directory.deviceListOf('u-bo'), directory.deviceListOf('u-bo')]);
    expect(calls.list).toBe(1);
  });

  it('knows nothing about a person with no list, or with no key on the relay', async () => {
    const me = await generateIdentityKeyPair();
    const bo = await generateIdentityKeyPair();
    const none = fakeApi({ list: async () => null });
    expect(await createRelayDirectory({ api: none.api, self: { userId: 'u-ada', identityKey: me.publicKey } }).deviceListOf('u-bo')).toBeUndefined();

    const keyless = fakeApi({ list: async () => listFor('u-bo', bo), key: async () => null });
    expect(await createRelayDirectory({ api: keyless.api, self: { userId: 'u-ada', identityKey: me.publicKey } }).deviceListOf('u-bo')).toBeUndefined();
  });

  it('renews the token once and asks again when the relay says the person is not introduced yet', async () => {
    const me = await generateIdentityKeyPair();
    const bo = await generateIdentityKeyPair();
    let introduced = false;
    let renewals = 0;
    const { api } = fakeApi({
      list: async () => {
        if (!introduced) throw new RelayHttpError(403, RelayErrorCode.NOT_A_CONTACT, 'not a contact');
        return listFor('u-bo', bo);
      },
      key: async () => bo.publicKey,
    });
    const directory = createRelayDirectory({
      api,
      self: { userId: 'u-ada', identityKey: me.publicKey },
      renewToken: async () => {
        renewals += 1;
        introduced = true;
      },
    });
    expect((await directory.deviceListOf('u-bo'))?.version).toBe(1);
    expect(renewals).toBe(1);
  });

  it('does not loop: a second refusal after renewing is passed on, and so is any other error', async () => {
    const me = await generateIdentityKeyPair();
    const stubborn = fakeApi({
      list: async () => {
        throw new RelayHttpError(403, RelayErrorCode.NOT_A_CONTACT, 'not a contact');
      },
    });
    let renewals = 0;
    const directory = createRelayDirectory({
      api: stubborn.api,
      self: { userId: 'u-ada', identityKey: me.publicKey },
      renewToken: async () => {
        renewals += 1;
      },
    });
    await expect(directory.deviceListOf('u-bo')).rejects.toMatchObject({ code: RelayErrorCode.NOT_A_CONTACT });
    expect(renewals).toBe(1);

    const down = fakeApi({
      list: async () => {
        throw new RelayHttpError(0, 'NETWORK', 'down');
      },
    });
    await expect(
      createRelayDirectory({ api: down.api, self: { userId: 'u-ada', identityKey: me.publicKey }, renewToken: async () => undefined }).deviceListOf('u-bo'),
    ).rejects.toMatchObject({ status: 0 });
  });
});
