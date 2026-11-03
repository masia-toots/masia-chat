import type { DeviceListEntry } from '@masia/contracts/wire';

/** A user's first list is version 1: "no list yet" counts as version 0. */
export const NO_DEVICE_LIST_VERSION = 0;

/**
 * The only thing the relay checks about a list upload: it must be exactly the next version.
 * Why exactly +1: a gap or a repeat means the uploader was working from a list that is not the
 * one on file, and silently accepting it would let two devices overwrite each other's changes.
 * `current` is the stored version, or `null` when the user has no list yet.
 */
export function isNextDeviceListVersion(current: number | null, proposed: number): boolean {
  return proposed === (current ?? NO_DEVICE_LIST_VERSION) + 1;
}

export function findListedDevice(
  devices: readonly DeviceListEntry[],
  deviceId: string,
): DeviceListEntry | undefined {
  return devices.find((entry) => entry.id === deviceId);
}
