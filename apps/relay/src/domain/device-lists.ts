import {
  DEVICE_LIST_ERRORS,
  DEVICE_LIST_TARGET_LIMIT,
  DEVICE_LIST_USER_LIMIT,
  DEVICE_LIST_VERSIONS_PAGE_MAX,
  DEVICE_LIST_WINDOW_MS,
  type DeviceListEntry,
  DeviceListError,
  DeviceRole,
  isNextDeviceListVersion,
  NO_DEVICE_LIST_VERSION,
  RelayError,
  RelayErrorCode,
  verifyDeviceListSignature,
} from '@masia/relay';
import type { Principal } from '../auth.js';
import type { Database, Queryable } from '../db.js';
import { admitLookup } from './devices.js';
import { createLookupLimiter, type LookupLimiter } from './lookup-limits.js';

/**
 * A user's signed device list (ADR-117 §2a), exactly as the user's client uploaded it.
 *
 * The relay STORES this and SERVES it; it never signs, edits or re-orders it, so an operator who
 * wants a "ghost device" in a room has no signature to put on the list. It does CHECK the signature
 * before it stores a version, against the identity key pinned for the account (`putDeviceList`):
 * every reader verifies the whole chain of versions, so one version nobody can verify would block
 * all of them for good. Clients still verify what they are served; the relay is not trusted for it.
 */
export interface StoredDeviceList {
  readonly userId: string;
  readonly version: number;
  readonly devices: readonly DeviceListEntry[];
  readonly signature: Buffer;
  readonly updatedAt: Date;
}

interface DeviceListRow {
  readonly userId: string;
  readonly version: number;
  readonly devicesJson: readonly DeviceListEntry[];
  readonly signature: Buffer;
  readonly updatedAt: Date;
}

const DEVICE_LIST_COLUMNS = `user_id AS "userId", version, devices_json AS "devicesJson",
  signature, updated_at AS "updatedAt"`;

function fromRow(row: DeviceListRow): StoredDeviceList {
  return {
    userId: row.userId,
    version: row.version,
    devices: row.devicesJson,
    signature: row.signature,
    updatedAt: row.updatedAt,
  };
}

export async function findDeviceList(
  q: Queryable,
  userId: string,
): Promise<StoredDeviceList | null> {
  const { rows } = await q.query<DeviceListRow>(
    `SELECT ${DEVICE_LIST_COLUMNS} FROM device_lists WHERE user_id = $1`,
    [userId],
  );
  const row = rows[0];
  return row === undefined ? null : fromRow(row);
}

/** One stored version (`device_list_versions`): the list as it was signed, never edited afterwards. */
export interface StoredDeviceListVersion {
  readonly userId: string;
  readonly version: number;
  readonly devices: readonly DeviceListEntry[];
  readonly signature: Buffer;
}

/** A page of versions, oldest first; `hasMore` when versions newer than the last row exist. */
export interface DeviceListVersionPage {
  readonly rows: readonly StoredDeviceListVersion[];
  readonly hasMore: boolean;
}

/**
 * The versions of `userId`'s list newer than `afterVersion`, oldest first, at most `limit`
 * (`DEVICE_LIST_VERSIONS_PAGE_MAX`). Each row is exactly what its owner uploaded, so a client rebuilds
 * the signed `mls-device-list/v1` bytes from it and verifies them with the pinned identity key.
 */
export async function listDeviceListVersions(
  q: Queryable,
  userId: string,
  afterVersion: number,
  limit: number = DEVICE_LIST_VERSIONS_PAGE_MAX,
): Promise<DeviceListVersionPage> {
  const take = Math.min(Math.max(1, limit), DEVICE_LIST_VERSIONS_PAGE_MAX);
  const { rows } = await q.query<{
    userId: string;
    version: number;
    devicesJson: readonly DeviceListEntry[];
    signature: Buffer;
  }>(
    `SELECT user_id AS "userId", version, devices_json AS "devicesJson", signature
     FROM device_list_versions WHERE user_id = $1 AND version > $2
     ORDER BY version LIMIT $3`,
    [userId, afterVersion, take + 1],
  );
  return {
    rows: rows.slice(0, take).map((row) => ({
      userId: row.userId,
      version: row.version,
      devices: row.devicesJson,
      signature: row.signature,
    })),
    hasMore: rows.length > take,
  };
}

export interface DeviceListProposal {
  readonly version: number;
  readonly devices: readonly DeviceListEntry[];
  readonly signature: Buffer;
}

function versionConflict(currentVersion: number): RelayError {
  return new RelayError(
    RelayErrorCode.DEVICE_LIST_VERSION_CONFLICT,
    'A device list must be exactly one version newer than the stored one.',
    { currentVersion },
  );
}

/** Why a proposal's signature is refused, for `reason` in the answer: a client can tell the two apart. */
const SIGNATURE_REFUSAL = {
  /** The account has no pinned identity key, so there is nothing to verify the signature under. */
  NO_PINNED_KEY: 'NO_PINNED_KEY',
  /** The signature does not verify under the pinned key. */
  BAD_SIGNATURE: 'BAD_SIGNATURE',
} as const;

function signatureRefused(reason: keyof typeof SIGNATURE_REFUSAL, message: string): RelayError {
  return new RelayError(RelayErrorCode.DEVICE_LIST_SIGNATURE_INVALID, message, { reason });
}

/**
 * Checks `proposal` against the account's pinned identity key with the same verifier the clients
 * use (`verifyDeviceListSignature`): the canonical `mls-device-list/v1` bytes of the owner, the
 * version and the entries. Entries that cannot be encoded (a key that is not 32 bytes, an ASSISTANT
 * without its conversation) are refused as `DEVICE_LIST_ENTRY_INVALID`: no client would accept
 * them either.
 */
async function assertSignedByPinnedKey(
  userId: string,
  pinned: Buffer | null,
  proposal: DeviceListProposal,
): Promise<void> {
  if (pinned === null) {
    throw signatureRefused(
      SIGNATURE_REFUSAL.NO_PINNED_KEY,
      'This account has no pinned identity key to verify the list under; register a device first.',
    );
  }
  try {
    await verifyDeviceListSignature(pinned, { userId, ...proposal });
  } catch (error) {
    if (!(error instanceof DeviceListError)) throw error;
    if (error.code === DEVICE_LIST_ERRORS.MALFORMED) {
      throw new RelayError(RelayErrorCode.DEVICE_LIST_ENTRY_INVALID, error.message);
    }
    throw signatureRefused(
      SIGNATURE_REFUSAL.BAD_SIGNATURE,
      "The signature does not verify under this account's pinned identity key.",
    );
  }
}

/**
 * Stores `proposal` as the user's list if, and only if, its version is the stored one + 1 AND it is
 * signed by the identity key pinned for the account (422 DEVICE_LIST_SIGNATURE_INVALID otherwise).
 * The checks and the write happen in one transaction: the pin is read under a shared lock (a
 * concurrent identity-key reset waits for this upload, or this upload sees the reset), and the
 * compare and the write happen under one row lock, so two devices uploading from the same base cannot
 * both win: the second gets a 409 carrying the version to rebuild on.
 *
 * Why the signature is checked here although clients check it too: the relay keeps EVERY version and
 * a client verifies the chain from the version it pinned. One stored version with a bad signature
 * would make every reader refuse the list for ever, and any active device of the account (an
 * unapproved second device, a stolen session) could upload it without holding the identity key.
 */
export async function putDeviceList(
  db: Database,
  userId: string,
  proposal: DeviceListProposal,
): Promise<StoredDeviceList> {
  const ids = proposal.devices.map((entry) => entry.id);
  if (new Set(ids).size !== ids.length) {
    throw new RelayError(RelayErrorCode.VALIDATION_FAILED, 'A device appears twice in the list.');
  }
  // The room binding is an ASSISTANT's alone (canon §2, `mls-device-list/v1`): a person's device bound
  // to one conversation would be a statement the verifier refuses, so the relay refuses it first.
  if (
    proposal.devices.some(
      (entry) => entry.conversationId !== undefined && entry.role !== DeviceRole.ASSISTANT,
    )
  ) {
    throw new RelayError(
      RelayErrorCode.DEVICE_LIST_ENTRY_INVALID,
      'Only an ASSISTANT entry may carry a conversationId.',
    );
  }
  // jsonb keeps array order and drops object-key order, so clients must sign a canonical byte
  // encoding of the entries, not the JSON text they sent. That is a client rule (ADR-117 §2a).
  const devicesJson = JSON.stringify(proposal.devices);

  return db.transaction(async (tx) => {
    // Lock order everywhere: the pin, then the list (`resetIdentityKey` takes them the same way).
    const pin = await tx.query<{ identityKeyPub: Buffer }>(
      'SELECT identity_key_pub AS "identityKeyPub" FROM identity_keys WHERE user_id = $1 FOR SHARE',
      [userId],
    );
    const current = await tx.query<{ version: number }>(
      'SELECT version FROM device_lists WHERE user_id = $1 FOR UPDATE',
      [userId],
    );
    const currentVersion = current.rows[0]?.version ?? null;
    if (!isNextDeviceListVersion(currentVersion, proposal.version)) {
      throw versionConflict(currentVersion ?? NO_DEVICE_LIST_VERSION);
    }
    await assertSignedByPinnedKey(userId, pin.rows[0]?.identityKeyPub ?? null, proposal);

    const written =
      currentVersion === null
        ? await tx.query<DeviceListRow>(
            // No row to lock for a first list: the primary key arbitrates a simultaneous first upload.
            `INSERT INTO device_lists (user_id, version, devices_json, signature)
             VALUES ($1, $2, $3::jsonb, $4)
             ON CONFLICT (user_id) DO NOTHING
             RETURNING ${DEVICE_LIST_COLUMNS}`,
            [userId, proposal.version, devicesJson, proposal.signature],
          )
        : await tx.query<DeviceListRow>(
            `UPDATE device_lists
             SET version = $2, devices_json = $3::jsonb, signature = $4, updated_at = now()
             WHERE user_id = $1
             RETURNING ${DEVICE_LIST_COLUMNS}`,
            [userId, proposal.version, devicesJson, proposal.signature],
          );
    const row = written.rows[0];
    // Lost the first-upload race: someone else's first list is stored now.
    if (row === undefined) throw versionConflict(NO_DEVICE_LIST_VERSION + 1);
    // Append-only history (TODO-504 (a)): the same transaction, so the current list and its version
    // row never disagree. The primary key (user, version) is a second guard against a lost race.
    await tx.query(
      `INSERT INTO device_list_versions (user_id, version, devices_json, signature, created_at)
       VALUES ($1, $2, $3::jsonb, $4, $5)`,
      [userId, row.version, devicesJson, row.signature, row.updatedAt],
    );
    return fromRow(row);
  });
}

/**
 * THE budget for looking up another user's devices, shared by every route that answers "which
 * devices does this user have" (`/device-list` and `/devices`): two routes with two budgets would be
 * twice the enumeration rate.
 */
export function createDeviceLookupLimiter(options: { now?: () => number } = {}): LookupLimiter {
  return createLookupLimiter({
    windowMs: DEVICE_LIST_WINDOW_MS,
    actorLimit: DEVICE_LIST_USER_LIMIT,
    targetLimit: DEVICE_LIST_TARGET_LIMIT,
    now: options.now,
  });
}

export interface DeviceListDirectoryOptions {
  /** The shared device-lookup budget (`createDeviceLookupLimiter`). */
  readonly limiter: LookupLimiter;
  /** The account that owns every ASSISTANT device (config.ts); its list is public (`lookupAccess`). */
  readonly operatorUserId: string | null;
}

export interface DeviceListDirectory {
  /**
   * Reads `targetUserId`'s list on behalf of `viewer`, or `null` if the user has none. Asks the
   * contact gate first (`admitLookup`: 403 NOT_A_CONTACT) and charges the lookup budget it prices
   * (429 when spent; your own list and that of a user you share a room with are free), and only
   * then looks for the list, so a stranger learns nothing, not even whether the user exists.
   */
  lookup(viewer: Principal, targetUserId: string): Promise<StoredDeviceList | null>;
  /**
   * The versions of `targetUserId`'s list newer than `afterVersion`, oldest first: the same gate and
   * the same budget as `lookup`. An empty page for a user with no list (or none newer).
   */
  versions(
    viewer: Principal,
    targetUserId: string,
    afterVersion: number,
    limit?: number,
  ): Promise<DeviceListVersionPage>;
}

/**
 * The READ side of device lists that other users call (`GET /users/:userId/device-list`). Readers
 * are the owner, an admin of the owner and contacts (security review round 2, M5: until then the
 * list was public to every registered device, so any device could map a child's GUARDIAN leaf).
 * The order is the devices route's: the gate, then the budget it prices, the same predicate
 * (`admitLookup`). The relay's own reads (the add-device rule) go through `findDeviceList` and are
 * never limited.
 */
export function createDeviceListDirectory(
  db: Database,
  options: DeviceListDirectoryOptions,
): DeviceListDirectory {
  const { limiter, operatorUserId } = options;
  return {
    async lookup(viewer, targetUserId) {
      await admitLookup(db, limiter, viewer, targetUserId, operatorUserId);
      return findDeviceList(db, targetUserId);
    },
    async versions(viewer, targetUserId, afterVersion, limit) {
      await admitLookup(db, limiter, viewer, targetUserId, operatorUserId);
      return listDeviceListVersions(db, targetUserId, afterVersion, limit);
    },
  };
}
