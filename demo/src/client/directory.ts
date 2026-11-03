import {
  verifyDeviceList,
  type DeviceDirectory,
  type DeviceListPin,
  type ListedDevice,
  type VerifiedDeviceList,
} from '@masia/messenger/mls';
import { RelayErrorCode } from '@masia/contracts/wire';
import { fromBase64, sameBytes } from './bytes.js';
import { RelayHttpError, type RelayApi } from './relay-api.js';

// The device directory the MLS engine asks: "whose devices may be in a room with this person?". A
// device list is only believed after it passes `verifyDeviceList` against the person's identity key,
// and that key is trusted on FIRST USE (TOFU): the first key the relay shows for a person is pinned
// in this tab's memory, a different one later is refused (the engine then says the person's devices
// are not listed). Two people comparing the room's security code is what closes the gap TOFU leaves.
//
// The relay limits list and device lookups (per caller and per target), so a verified list is kept
// for `LIST_TTL_MS`; the engine's "refresh and retry once" bypasses the cache.

export const LIST_TTL_MS = 20_000;

export interface DirectoryDeps {
  readonly api: RelayApi;
  /** This tab's own person: its key is known, never looked up. */
  readonly self: { readonly userId: string; readonly identityKey: Uint8Array };
  /**
   * Called when the relay says the caller shares no room with the person and its token does not
   * introduce them: the token was minted before they signed in. The host renews the token; the lookup
   * is then made once more.
   */
  readonly renewToken?: () => Promise<void>;
  readonly now?: () => number;
}

interface Entry {
  readonly list: VerifiedDeviceList;
  readonly fetchedAt: number;
}

export interface RelayDirectory extends DeviceDirectory {
  /** The identity key this tab pinned for a person (TOFU), or undefined before the first lookup. */
  pinnedKeyOf(userId: string): Uint8Array | undefined;
}

export function createRelayDirectory(deps: DirectoryDeps): RelayDirectory {
  const now = deps.now ?? Date.now;
  const pins = new Map<string, DeviceListPin>();
  const cache = new Map<string, Entry>();
  const inflight = new Map<string, Promise<VerifiedDeviceList | undefined>>();

  async function withRenewal<T>(job: () => Promise<T>): Promise<T> {
    try {
      return await job();
    } catch (error) {
      if (
        error instanceof RelayHttpError &&
        error.code === RelayErrorCode.NOT_A_CONTACT &&
        deps.renewToken !== undefined
      ) {
        await deps.renewToken();
        return job();
      }
      throw error;
    }
  }

  async function load(userId: string): Promise<VerifiedDeviceList | undefined> {
    const served = await withRenewal(() => deps.api.getDeviceList(userId));
    if (served === null) return undefined;

    // Trust on first use: the person's identity key, as the relay pinned it, is pinned here too. After
    // that the pin decides: a list signed by any other key fails `verifyDeviceList` (BAD_SIGNATURE).
    let pin = pins.get(userId);
    if (pin === undefined) {
      const identityKey =
        userId === deps.self.userId
          ? deps.self.identityKey
          : await withRenewal(() => deps.api.identityKeyOf(userId));
      if (identityKey === null) return undefined;
      pin = { identityKey, version: 0 };
    }

    const devices: ListedDevice[] = served.devices.map((entry) => ({
      deviceId: entry.id,
      role: entry.role,
      signatureKey: fromBase64(entry.signatureKey),
      ...(entry.conversationId === undefined ? {} : { conversationId: entry.conversationId }),
    }));
    const verified = await verifyDeviceList(
      userId,
      { userId, version: served.version, devices, signature: served.signature },
      pin,
    );
    pins.set(userId, verified.pin);
    cache.set(userId, { list: verified.list, fetchedAt: now() });
    return verified.list;
  }

  function fetchList(userId: string): Promise<VerifiedDeviceList | undefined> {
    const running = inflight.get(userId);
    if (running !== undefined) return running;
    const started = load(userId).finally(() => inflight.delete(userId));
    inflight.set(userId, started);
    return started;
  }

  async function current(userId: string): Promise<VerifiedDeviceList | undefined> {
    const hit = cache.get(userId);
    if (hit !== undefined && now() - hit.fetchedAt < LIST_TTL_MS) return hit.list;
    return fetchList(userId);
  }

  return {
    deviceListOf: current,

    // Only the current list is known here, so only it can vouch: a device listed in it counts for every
    // version up to it. (A host that keeps list history would answer the oldest version that lists it.)
    async listedSince(userId, device, minVersion) {
      const list = await current(userId);
      if (list === undefined || list.version < minVersion) return undefined;
      const listed = list.devices.some(
        (entry) =>
          entry.deviceId === device.deviceId &&
          entry.role === device.role &&
          sameBytes(entry.signatureKey, device.signatureKey) &&
          entry.conversationId === device.conversationId,
      );
      return listed ? list.version : undefined;
    },

    async refreshDeviceList(userId) {
      cache.delete(userId);
      await fetchList(userId);
    },

    pinnedKeyOf: (userId) => pins.get(userId)?.identityKey,
  };
}
