import {
  DeviceRole,
  type DeviceDirectory,
  type DeviceKeys,
  type GuardianPolicy,
  type ListedDevice,
  type MlsEngine,
  type MlsEngineContext,
  type VerifiedDeviceList,
} from '../../mls-engine.js';
import { sameListedDevice } from '../../validator.js';

/**
 * A test host: the verified-signed-device-list directory and the guardian policy that a real host
 * supplies, with a clock the tests can move. Engine-agnostic, so the contract suite can run on any
 * `MlsEngine`.
 *
 * The directory is VERSIONED like a real one: every `list` / `unlist` publishes a new version of a
 * user's list (1, 2, 3 ...) and keeps the old ones, so `listedSince` can answer "was this device in
 * a verified version no older than ...". A user can be made to LAG (`holdBack`): newer versions then
 * exist at the source but the directory serves (has verified) only the older ones until
 * `refreshDeviceList` is called, which is how the host's "refresh and retry once" is tested.
 */

export type EngineFactory = (context: MlsEngineContext) => Promise<MlsEngine>;

export interface TestDevice {
  readonly keys: DeviceKeys;
  readonly userId: string;
  readonly deviceId: string;
  readonly role: DeviceRole;
}

export class TestWorld {
  /** userId -> every version of that user's list at the source, oldest first (version = index + 1). */
  private readonly history = new Map<string, ListedDevice[][]>();
  /** userId -> the newest version the directory has VERIFIED (what it serves). */
  private readonly verified = new Map<string, number>();
  private readonly lagging = new Set<string>();
  private readonly admins = new Set<string>();
  private readonly minors = new Set<string>();
  /** `${childUserId}/${deviceId}` -> the admin who owns that guardian device. */
  private readonly guardianOwners = new Map<string, string>();
  /** Every `refreshDeviceList` call, in order: tests assert "exactly once". */
  readonly refreshCalls: string[] = [];
  /** Milliseconds; the engine reads it through `context.now`. */
  nowMs = Date.now();

  readonly directory: DeviceDirectory = {
    deviceListOf: (userId) => Promise.resolve(this.servedList(userId)),

    listedSince: (userId, device, minVersion) => {
      const versions = this.history.get(userId) ?? [];
      const upTo = this.verified.get(userId) ?? 0;
      for (let version = Math.max(minVersion, 1); version <= upTo; version += 1) {
        const devices = versions[version - 1] ?? [];
        if (devices.some((entry) => sameListedDevice(entry, device))) {
          return Promise.resolve(version);
        }
      }
      return Promise.resolve(undefined);
    },

    refreshDeviceList: (userId) => {
      this.refreshCalls.push(userId);
      this.verified.set(userId, this.history.get(userId)?.length ?? 0);
      return Promise.resolve();
    },
  };

  readonly policy: GuardianPolicy = {
    isAdminOf: (adminUserId, childUserId) => this.admins.has(`${adminUserId}>${childUserId}`),
    isMinor: (userId) => this.minors.has(userId),
    guardianOwnerOf: (childUserId, deviceId) =>
      this.guardianOwners.get(`${childUserId}/${deviceId}`),
  };

  readonly context: MlsEngineContext = {
    directory: this.directory,
    policy: this.policy,
    now: () => this.nowMs,
  };

  private engineRef: MlsEngine | undefined;

  get engine(): MlsEngine {
    if (this.engineRef === undefined) throw new Error('TestWorld.create() was not awaited.');
    return this.engineRef;
  }

  static async create(factory: EngineFactory): Promise<TestWorld> {
    const world = new TestWorld();
    world.engineRef = await factory(world.context);
    return world;
  }

  /** Makes a device with a fresh signing key and (unless `listed: false`) puts it on its owner's signed list. */
  async device(
    userId: string,
    deviceId: string,
    role: DeviceRole = DeviceRole.USER,
    options: { listed?: boolean; conversationId?: string } = {},
  ): Promise<TestDevice> {
    const signingKey = await this.engine.generateSigningKeyPair();
    const keys: DeviceKeys = { identity: { userId, deviceId, role }, signingKey };
    if (options.listed !== false) {
      this.list(userId, {
        deviceId,
        role,
        signatureKey: signingKey.publicKey,
        ...(options.conversationId === undefined ? {} : { conversationId: options.conversationId }),
      });
    }
    return { keys, userId, deviceId, role };
  }

  private servedList(userId: string): VerifiedDeviceList | undefined {
    const version = this.verified.get(userId) ?? 0;
    const devices = this.history.get(userId)?.[version - 1];
    return devices === undefined ? undefined : { userId, version, devices };
  }

  /** Publishes a new version of `userId`'s list. The directory serves it at once unless the user lags. */
  private publish(userId: string, devices: ListedDevice[]): number {
    const versions = this.history.get(userId) ?? [];
    versions.push(devices);
    this.history.set(userId, versions);
    if (!this.lagging.has(userId)) this.verified.set(userId, versions.length);
    return versions.length;
  }

  private latest(userId: string): ListedDevice[] {
    const versions = this.history.get(userId) ?? [];
    return versions[versions.length - 1] ?? [];
  }

  /** Adds (or replaces) a device on the user's list: a new list version. Returns that version. */
  list(userId: string, device: ListedDevice): number {
    return this.publish(userId, [
      ...this.latest(userId).filter((d) => d.deviceId !== device.deviceId),
      device,
    ]);
  }

  /** Takes a device off its owner's signed list (revokes it): a new list version. Returns that version. */
  unlist(userId: string, deviceId: string): number {
    return this.publish(
      userId,
      this.latest(userId).filter((d) => d.deviceId !== deviceId),
    );
  }

  /** From now on the directory has verified only the versions up to the current one, until `refreshDeviceList`. */
  holdBack(userId: string): void {
    this.lagging.add(userId);
  }

  /**
   * The directory (of this receiver) has verified `userId`'s list only up to `version`, although the
   * source has newer ones: it serves `version` until `refreshDeviceList` brings the rest.
   */
  lagBehind(userId: string, version: number): void {
    this.lagging.add(userId);
    this.verified.set(userId, version);
  }

  /** The newest version of the user's list at the source (what a refresh would bring). */
  sourceVersion(userId: string): number {
    return this.history.get(userId)?.length ?? 0;
  }

  /** `adminUserId` administers `childUserId`: it may remove the child's GUARDIAN leaf (internal ADR-117 §4). */
  makeAdmin(adminUserId: string, childUserId: string): void {
    this.admins.add(`${adminUserId}>${childUserId}`);
  }

  /** `userId` is a child account: an ASSISTANT leaf may join its rooms only by an admin's hand (internal ADR-117 §3). */
  makeMinor(userId: string): void {
    this.minors.add(userId);
  }

  /** The guardian device `deviceId` of `childUserId` belongs to `adminUserId` (the directory knows whose it is). */
  registerGuardianDevice(childUserId: string, deviceId: string, adminUserId: string): void {
    this.guardianOwners.set(`${childUserId}/${deviceId}`, adminUserId);
  }
}
