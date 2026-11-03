import {
  CLAIM_LIMIT,
  CLAIM_TARGET_LIMIT,
  CLAIM_USER_LIMIT,
  CLAIM_WINDOW_MS,
  createTtlCounter,
  KEY_PACKAGE_UPLOAD_DEVICE_LIMIT,
  KEY_PACKAGE_UPLOAD_USER_LIMIT,
  KEY_PACKAGE_UPLOAD_WINDOW_MS,
  MAX_UNCLAIMED_KEY_PACKAGES_PER_DEVICE,
  MlsHeaderError,
  parseKeyPackageLifetime,
  RateLimitedError,
  RelayError,
  RelayErrorCode,
  retryAfterSeconds,
} from '@masia/relay';
import type { Principal } from '../auth.js';
import type { Database, Queryable } from '../db.js';
import { lookupReach } from './devices.js';
import { createLookupLimiter } from './lookup-limits.js';

/** A key package a device offers for being added to a group. The bytes are opaque to the relay. */
export interface KeyPackageUpload {
  readonly bytes: Buffer;
  readonly lastResort: boolean;
}

export interface UploadResult {
  /**
   * Packages really stored. A package the device already holds (the same bytes, spent or not) is
   * skipped, so a retried upload answers 0.
   */
  readonly uploaded: number;
  /** Ordinary packages still unclaimed and unexpired: how a client knows when to top up. */
  readonly available: number;
}

/** One package handed to a claimer, for one device of the user being added. */
export interface ClaimedKeyPackage {
  readonly deviceId: string;
  readonly keyPackageId: string;
  readonly bytes: Buffer;
  readonly lastResort: boolean;
}

/** Who is acting: the device that uploads or will use the packages, and the user it belongs to. */
export interface KeyPackageActor {
  readonly userId: string;
  readonly deviceId: string;
}

export interface KeyPackageDirectory {
  upload(uploader: KeyPackageActor, packages: readonly KeyPackageUpload[]): Promise<UploadResult>;
  /**
   * The claimer is the whole token principal: the contact gate reads its `adminOf`. `deviceIds`
   * narrows the claim to those of the user's devices (TODO-513): it is a filter over the ACTIVE
   * devices, so an id that is unknown, revoked, another person's or without a package is just absent
   * from the answer, and no other device's package is touched. Left out: every active device.
   */
  claim(
    claimer: Principal,
    targetUserId: string,
    deviceIds?: readonly string[],
  ): Promise<ClaimedKeyPackage[]>;
}

export interface KeyPackageDirectoryOptions {
  /** Injected so tests can move time. */
  readonly now?: () => number;
  /** The account that owns every ASSISTANT device (config.ts); anyone may claim its packages. */
  readonly operatorUserId?: string | null;
}

/**
 * The largest `not_after` stored (9999-12-31T23:59:59Z, the last second both a Postgres timestamp
 * and a JS Date print in four digits). A package may say "valid until 2^64 - 1"; it is kept as
 * "valid for ever", not refused.
 */
export const MAX_NOT_AFTER_SECONDS = 253_402_300_799n;
const MS_PER_SECOND = 1000;

/** `notAfter` of a package as a Date, clamped to what a timestamp column can hold. */
function notAfterDate(notAfterSeconds: bigint): Date {
  const clamped = notAfterSeconds > MAX_NOT_AFTER_SECONDS ? MAX_NOT_AFTER_SECONDS : notAfterSeconds;
  return new Date(Number(clamped) * MS_PER_SECOND);
}

/**
 * Reads the lifetime from a package's cleartext (no key needed). An unreadable package is refused
 * with the field and reason, so a client bug is findable; one that has already expired could never
 * be used to add anyone, so it is refused rather than stored and served.
 */
function lifetimeEnd(item: KeyPackageUpload, index: number, now: number): Date {
  let notAfter: bigint;
  try {
    notAfter = parseKeyPackageLifetime(item.bytes).notAfter;
  } catch (error) {
    if (error instanceof MlsHeaderError) {
      throw new RelayError(
        RelayErrorCode.KEY_PACKAGE_UNREADABLE,
        `Key package ${index} is not a readable MLS KeyPackage: ${error.field} (${error.reason}).`,
        { index, field: error.field, reason: error.reason },
      );
    }
    throw error;
  }
  const end = notAfterDate(notAfter);
  if (end.getTime() <= now) {
    throw new RelayError(
      RelayErrorCode.KEY_PACKAGE_EXPIRED,
      `Key package ${index} has already expired.`,
      {
        index,
      },
    );
  }
  return end;
}

/**
 * Packages whose lifetime has not ended, with the current time as `$2`. An unknown lifetime (a
 * package uploaded before the column existed) counts as alive.
 */
const ALIVE = '(not_after IS NULL OR not_after > $2)';

/**
 * The key-package directory (ADR-117 §2, H6). Handing out packages is the one place an attacker
 * can do harm without holding any key: drain a victim's pool so nobody can add them (a DoS), or
 * watch who answers (a presence oracle). Rules that close that:
 *   - the LAST-RESORT package of a device is never consumed, so an empty pool still has an answer;
 *   - claims are rate-limited per claiming device, per claiming USER (all of a user's devices
 *     together) and per TARGET user (all claimers together), see lookup-limits.ts;
 *   - every claim is RECORDED (`key_package_claims`), so a commit that later declares an Add can be
 *     held to "the package you name is one your own device claimed" (`assertAddsClaimedBy`).
 * And the pool itself stays honest and bounded (review round 1, 2026-10-10):
 *   - every package's MLS lifetime end is read at upload and stored; an expired package is never
 *     served, and is purged (on the device's next upload, and by the retention job);
 *   - the NEWEST package is served first: the one with the most life left;
 *   - a claim may name the devices it wants (`deviceIds`), so adding ONE device of a person does not
 *     burn a package of each of their others. It narrows, never widens: the gate and the budgets are
 *     the same, and one claim still takes at most one package per device, so naming one device drains
 *     it no faster than an unnamed claim did;
 *   - a device holds at most MAX_UNCLAIMED_KEY_PACKAGES_PER_DEVICE unclaimed packages, and uploads
 *     are rate-limited per device and per user, so the table cannot be filled from one account.
 *   - only the owner, an admin of the owner, or a CONTACT may claim (`lookupReach`, the same gate
 *     as the device-list read; 403 NOT_A_CONTACT, asked after the budgets and before any package
 *     is touched). The operator's packages are claimable by every device: that is how a member
 *     adds the assistant to a room it was never in. A first Add between two people who share no
 *     room yet needs a host introduction (docs/TODO.md), as `GET /users/:userId/devices` does.
 */
export function createKeyPackageDirectory(
  db: Database,
  options: KeyPackageDirectoryOptions = {},
): KeyPackageDirectory {
  const now = options.now ?? Date.now;
  const operatorUserId = options.operatorUserId ?? null;
  const claims = createTtlCounter({ ttlMs: CLAIM_WINDOW_MS, window: 'fixed', now });
  const lookups = createLookupLimiter({
    windowMs: CLAIM_WINDOW_MS,
    actorLimit: CLAIM_USER_LIMIT,
    targetLimit: CLAIM_TARGET_LIMIT,
    now,
  });
  const uploadsByDevice = createTtlCounter({
    ttlMs: KEY_PACKAGE_UPLOAD_WINDOW_MS,
    window: 'fixed',
    now,
  });
  const uploadsByUser = createTtlCounter({
    ttlMs: KEY_PACKAGE_UPLOAD_WINDOW_MS,
    window: 'fixed',
    now,
  });

  /** Two budgets, as for lookups: a user's devices share one, so adding devices buys nothing. */
  function assertUploadBudget(uploader: KeyPackageActor): void {
    const budgets = [
      { counter: uploadsByDevice, key: uploader.deviceId, limit: KEY_PACKAGE_UPLOAD_DEVICE_LIMIT },
      { counter: uploadsByUser, key: uploader.userId, limit: KEY_PACKAGE_UPLOAD_USER_LIMIT },
    ];
    for (const { counter, key, limit } of budgets) {
      const { count, resetsAt } = counter.hit(key);
      if (count > limit) {
        throw new RateLimitedError(
          RelayErrorCode.UPLOAD_RATE_LIMITED,
          'Too many key-package uploads; try again later.',
          retryAfterSeconds(resetsAt, now()),
        );
      }
    }
  }

  /** Remembers that `claimerDeviceId` was handed `keyPackageId` (again, for a last-resort package). */
  async function recordClaim(
    tx: Queryable,
    keyPackageId: string,
    claimerDeviceId: string,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO key_package_claims (key_package_id, claimer_device_id)
       VALUES ($1, $2)
       ON CONFLICT (key_package_id, claimer_device_id) DO UPDATE SET claimed_at = now()`,
      [keyPackageId, claimerDeviceId],
    );
  }

  return {
    async upload(uploader, packages) {
      assertUploadBudget(uploader);
      const at = now();
      const ends = packages.map((item, index) => lifetimeEnd(item, index, at));
      const atDate = new Date(at);

      return db.transaction(async (tx) => {
        // Expired packages of this device are dead weight: drop them before counting the pool.
        await tx.query('DELETE FROM key_packages WHERE device_id = $1 AND not_after <= $2', [
          uploader.deviceId,
          atDate,
        ]);
        // A package this device already holds (the same bytes, spent or not) is skipped, not stored
        // twice: a retried upload must not give one init key to two claimers. The unique index on
        // (device, sha256(bytes)) decides, so two simultaneous uploads cannot both store it either.
        let stored = 0;
        for (const [index, item] of packages.entries()) {
          const inserted = await tx.query(
            `INSERT INTO key_packages (device_id, bytes, last_resort, not_after)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT DO NOTHING
             RETURNING id`,
            [uploader.deviceId, item.bytes, item.lastResort, ends[index]],
          );
          stored += inserted.rows.length;
        }
        const { rows } = await tx.query<{
          lastResort: string;
          available: string;
          unclaimed: string;
        }>(
          `SELECT count(*) FILTER (WHERE last_resort AND ${ALIVE}) AS "lastResort",
                  count(*) FILTER (WHERE NOT last_resort AND consumed_at IS NULL AND ${ALIVE}) AS available,
                  count(*) FILTER (WHERE consumed_at IS NULL) AS unclaimed
           FROM key_packages WHERE device_id = $1`,
          [uploader.deviceId, atDate],
        );
        const counts = rows[0];
        // Checked AFTER the insert and inside the transaction: the rules are about the state the
        // device ends up in, and a refusal rolls the whole upload back.
        if (counts === undefined || Number(counts.lastResort) < 1) {
          throw new RelayError(
            RelayErrorCode.LAST_RESORT_REQUIRED,
            'A device must always have at least one unexpired last-resort key package.',
          );
        }
        if (Number(counts.unclaimed) > MAX_UNCLAIMED_KEY_PACKAGES_PER_DEVICE) {
          throw new RelayError(
            RelayErrorCode.KEY_PACKAGE_POOL_FULL,
            'This device already holds as many unclaimed key packages as the relay keeps.',
            { max: MAX_UNCLAIMED_KEY_PACKAGES_PER_DEVICE },
          );
        }
        return { uploaded: stored, available: Number(counts.available) };
      });
    },

    async claim(claimer, targetUserId, deviceIds) {
      const { count, resetsAt } = claims.hit(claimer.deviceId);
      if (count > CLAIM_LIMIT) {
        throw new RateLimitedError(
          RelayErrorCode.CLAIM_RATE_LIMITED,
          'Too many key-package claims; try again later.',
          retryAfterSeconds(resetsAt, now()),
        );
      }
      // After the per-device cap, which is the narrowest: see LookupLimiter for why the order matters.
      lookups.check(claimer.userId, targetUserId);
      await lookupReach(db, claimer, targetUserId, operatorUserId);
      const atDate = new Date(now());

      return db.transaction(async (tx) => {
        // `deviceIds` only ever NARROWS the user's own active devices (`user_id = $1` stays): an id
        // of someone else's device matches nothing, exactly like an unknown one.
        const devices = await tx.query<{ id: string }>(
          `SELECT id FROM devices
           WHERE user_id = $1 AND revoked_at IS NULL AND ($2::text[] IS NULL OR id = ANY($2::text[]))
           ORDER BY created_at, id`,
          [targetUserId, deviceIds ?? null],
        );
        const claimed: ClaimedKeyPackage[] = [];
        for (const { id: deviceId } of devices.rows) {
          // SKIP LOCKED: two simultaneous claimers get different packages instead of one waiting
          // for the other, and a package is never handed out twice. Newest first: most life left.
          const ordinary = await tx.query<{ id: string; bytes: Buffer }>(
            `UPDATE key_packages SET consumed_at = now()
             WHERE id = (
               SELECT id FROM key_packages
               WHERE device_id = $1 AND NOT last_resort AND consumed_at IS NULL AND ${ALIVE}
               ORDER BY created_at DESC, id DESC LIMIT 1
               FOR UPDATE SKIP LOCKED
             )
             RETURNING id, bytes`,
            [deviceId, atDate],
          );
          const taken = ordinary.rows[0];
          if (taken !== undefined) {
            await recordClaim(tx, taken.id, claimer.deviceId);
            claimed.push({
              deviceId,
              keyPackageId: taken.id,
              bytes: taken.bytes,
              lastResort: false,
            });
            continue;
          }
          // Pool empty: serve the last-resort package WITHOUT consuming it (the table CHECK
          // forbids marking it consumed). Newest unexpired first, so a rotated last-resort wins.
          const fallback = await tx.query<{ id: string; bytes: Buffer }>(
            `SELECT id, bytes FROM key_packages
             WHERE device_id = $1 AND last_resort AND ${ALIVE}
             ORDER BY created_at DESC, id DESC LIMIT 1`,
            [deviceId, atDate],
          );
          const lastResort = fallback.rows[0];
          if (lastResort !== undefined) {
            await recordClaim(tx, lastResort.id, claimer.deviceId);
            claimed.push({
              deviceId,
              keyPackageId: lastResort.id,
              bytes: lastResort.bytes,
              lastResort: true,
            });
          }
        }
        return claimed;
      });
    },
  };
}
