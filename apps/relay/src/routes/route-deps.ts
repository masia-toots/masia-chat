import type { AuthHooks } from '../auth.js';
import type { Database } from '../db.js';
import type { DeviceListDirectory } from '../domain/device-lists.js';
import type { IdentityRequestDirectory } from '../domain/identity-requests.js';
import type { KeyPackageDirectory } from '../domain/key-packages.js';
import type { LookupLimiter } from '../domain/lookup-limits.js';
import type { EpochSerializer } from '../epoch-serializer.js';

/**
 * What a route module is given, instead of reaching for globals: the database for reads, the
 * auth hooks, and the services that own state with rules (the epoch serializer owns every write to
 * a room; the key-package directory owns the pool of packages and its rate limits; the device-list
 * directory owns the rate-limited read of another user's list; `deviceLookups` is the one budget
 * every "which devices does this user have" read shares; the identity-request directory owns the
 * ADR-218 transfer of the identity key between a person's devices).
 */
export interface RouteDeps {
  readonly db: Database;
  readonly auth: AuthHooks;
  readonly serializer: EpochSerializer;
  readonly keyPackages: KeyPackageDirectory;
  readonly deviceLists: DeviceListDirectory;
  readonly deviceLookups: LookupLimiter;
  readonly identityRequests: IdentityRequestDirectory;
  /** The account that owns every ASSISTANT device (config.ts). */
  readonly operatorUserId: string | null;
  /** The relay's clock (epoch ms), injected so tests can move time; tokens use the real clock. */
  readonly now: () => number;
}
