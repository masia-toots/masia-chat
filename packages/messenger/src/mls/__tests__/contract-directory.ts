import { describe, expect, it } from 'vitest';
import { DeviceRole } from '../mls-engine.js';
import type { DeviceDirectory, ListedDevice } from '../mls-engine.js';

/**
 * DIRECTORY CONTRACT: what the engine needs from `DeviceDirectory.listedSince` (the engine code review),
 * independent of any engine. A host runs this suite against its real directory (a database of
 * verified, signed list versions) the way the messenger runs it against the in-memory fake: the
 * engine's backlog safety is only as good as this answer.
 *
 * The harness publishes VERIFIED versions of a user's list; version numbers start at 1 and grow by
 * one per publication.
 */

export interface DirectoryHarness {
  readonly directory: DeviceDirectory;
  /** Publishes a new verified version of `userId`'s list that adds (or replaces) `device`. Returns the version. */
  list(userId: string, device: ListedDevice): number;
  /** Publishes a new verified version of `userId`'s list without `deviceId`. Returns the version. */
  unlist(userId: string, deviceId: string): number;
}

export interface DirectorySubject {
  readonly name: string;
  /** A fresh, empty directory with no lists at all. */
  readonly create: () => DirectoryHarness | Promise<DirectoryHarness>;
}

const KEY_BYTES = 32;
const keyOf = (fill: number) => new Uint8Array(KEY_BYTES).fill(fill);

const phone = (deviceId: string, fill: number): ListedDevice => ({
  deviceId,
  role: DeviceRole.USER,
  signatureKey: keyOf(fill),
});

export function defineDirectoryContract(subject: DirectorySubject): void {
  describe(`${subject.name}: device directory`, () => {
    it('knows nothing about a user it has no list for', async () => {
      const { directory } = await subject.create();
      await expect(directory.deviceListOf('nobody')).resolves.toBeUndefined();
      await expect(directory.listedSince('nobody', phone('d1', 1), 0)).resolves.toBeUndefined();
    });

    it('serves the newest verified list as the current one', async () => {
      const { directory, list, unlist } = await subject.create();
      list('dave', phone('d1', 1));
      list('dave', phone('d2', 2));
      unlist('dave', 'd1');
      const current = await directory.deviceListOf('dave');
      expect(current?.version).toBe(3);
      expect(current?.devices.map((d) => d.deviceId)).toEqual(['d2']);
    });

    it('listedSince answers with the OLDEST verified version at or above the minimum that lists the device', async () => {
      const { directory, list, unlist } = await subject.create();
      const d1 = phone('d1', 1);
      expect(list('dave', d1)).toBe(1); // v1: d1
      expect(list('dave', phone('d2', 2))).toBe(2); // v2: d1, d2
      expect(unlist('dave', 'd1')).toBe(3); // v3: d2
      expect(list('dave', phone('d3', 3))).toBe(4); // v4: d2, d3

      // d1 was listed in v1 and v2, and is not listed any more.
      await expect(directory.listedSince('dave', d1, 0)).resolves.toBe(1);
      await expect(directory.listedSince('dave', d1, 1)).resolves.toBe(1);
      await expect(directory.listedSince('dave', d1, 2)).resolves.toBe(2);
      await expect(directory.listedSince('dave', d1, 3)).resolves.toBeUndefined();
      // d2 appears in v2 and stays: the oldest version at or above the minimum.
      await expect(directory.listedSince('dave', phone('d2', 2), 0)).resolves.toBe(2);
      await expect(directory.listedSince('dave', phone('d2', 2), 3)).resolves.toBe(3);
      await expect(directory.listedSince('dave', phone('d2', 2), 5)).resolves.toBeUndefined();
      // d3 is only in the newest version.
      await expect(directory.listedSince('dave', phone('d3', 3), 0)).resolves.toBe(4);
    });

    it('a device that was never listed is never found, however old the minimum', async () => {
      const { directory, list } = await subject.create();
      list('dave', phone('d1', 1));
      await expect(directory.listedSince('dave', phone('ghost', 9), 0)).resolves.toBeUndefined();
      // Another user's list does not vouch for it either.
      list('erin', phone('ghost', 9));
      await expect(directory.listedSince('dave', phone('ghost', 9), 0)).resolves.toBeUndefined();
    });

    it('matches the device EXACTLY: id, role and signature key', async () => {
      const { directory, list } = await subject.create();
      list('dave', phone('d1', 1));
      await expect(directory.listedSince('dave', phone('d1', 1), 0)).resolves.toBe(1);
      await expect(directory.listedSince('dave', phone('d1', 2), 0)).resolves.toBeUndefined(); // another key
      await expect(
        directory.listedSince('dave', { ...phone('d1', 1), role: DeviceRole.GUARDIAN }, 0),
      ).resolves.toBeUndefined(); // another role
      await expect(directory.listedSince('dave', phone('d2', 1), 0)).resolves.toBeUndefined(); // another id
    });

    it('a Masia entry is bound to its conversation', async () => {
      const { directory, list } = await subject.create();
      const masia: ListedDevice = {
        deviceId: 'm1',
        role: DeviceRole.ASSISTANT,
        signatureKey: keyOf(7),
        conversationId: 'conv-1',
      };
      list('masia', masia);
      await expect(directory.listedSince('masia', masia, 0)).resolves.toBe(1);
      await expect(
        directory.listedSince('masia', { ...masia, conversationId: 'conv-2' }, 0),
      ).resolves.toBeUndefined();
      const { conversationId: _bound, ...unbound } = masia;
      await expect(directory.listedSince('masia', unbound, 0)).resolves.toBeUndefined();
    });

    it('treats a minimum below 1 as 1 and never invents a version above the newest', async () => {
      const { directory, list } = await subject.create();
      list('dave', phone('d1', 1));
      await expect(directory.listedSince('dave', phone('d1', 1), -5)).resolves.toBe(1);
      await expect(directory.listedSince('dave', phone('d1', 1), 2)).resolves.toBeUndefined();
    });
  });
}
