import { RELAY_BACKLOG_RETENTION_SECONDS } from '@masia/relay';
import type { Queryable } from './db.js';

/**
 * THE RETENTION JOB (ADR-117 §2; review round 1, 2026-10-10). The relay is a mailbox, not an
 * archive: handshakes and envelopes older than `RELAY_BACKLOG_RETENTION_SECONDS` are deleted, and
 * so are key packages nobody can use any more (expired, or consumed that long ago). A device that
 * was away longer than the retention finds `oldestAvailableSeq` above its cursor and recovers from
 * the group state instead of paging (the client's rule, packages/messenger).
 *
 * Deleting never disturbs ordering: seq numbers come from per-conversation counters
 * (`conversation_e2ee.handshake_seq` / `envelope_seq`) that only move forward, so a deleted row's
 * seq is never handed out again.
 */

/** How often the job runs. Retention is measured in days, so minutes of lag cost nothing. */
export const RETENTION_SWEEP_INTERVAL_MS = 10 * 60_000;

/**
 * Rows deleted per statement. Small batches keep each statement far below the statement timeout
 * and never hold many row locks at once, so a sweep never stalls the writers of a busy room.
 */
export const RETENTION_DELETE_BATCH = 1000;

const MS_PER_SECOND = 1000;

export interface PurgeResult {
  readonly handshakes: number;
  readonly envelopes: number;
  readonly keyPackages: number;
}

/** Deletes, batch by batch, the rows of `table` that `where` (with the cutoff as `$1`) selects. */
async function deleteInBatches(
  db: Queryable,
  table: string,
  where: string,
  params: readonly unknown[],
  batch: number,
): Promise<number> {
  let total = 0;
  for (;;) {
    const { rowCount } = await db.query(
      `DELETE FROM ${table} WHERE ctid IN (SELECT ctid FROM ${table} WHERE ${where} LIMIT ${batch})`,
      params,
    );
    const deleted = rowCount ?? 0;
    total += deleted;
    if (deleted < batch) return total;
  }
}

export interface PurgeOptions {
  /** The current time (epoch ms). */
  readonly now: number;
  /** Overrides `RETENTION_DELETE_BATCH` (tests use small batches to exercise the loop). */
  readonly batch?: number;
}

/** One sweep: everything past retention, and every key package nobody can use. */
export async function purgeExpired(db: Queryable, options: PurgeOptions): Promise<PurgeResult> {
  const batch = options.batch ?? RETENTION_DELETE_BATCH;
  const now = new Date(options.now);
  const cutoff = new Date(options.now - RELAY_BACKLOG_RETENTION_SECONDS * MS_PER_SECOND);
  return {
    handshakes: await deleteInBatches(db, 'mls_handshakes', 'created_at < $1', [cutoff], batch),
    envelopes: await deleteInBatches(db, 'envelopes', 'created_at < $1', [cutoff], batch),
    // A consumed package is kept for the retention period because its claim record is what a
    // later commit's Add is checked against (`assertAddsClaimedBy`); the claim goes with it.
    keyPackages: await deleteInBatches(
      db,
      'key_packages',
      'not_after <= $1 OR consumed_at < $2',
      [now, cutoff],
      batch,
    ),
  };
}

export interface RetentionJobOptions {
  readonly onSwept?: (result: PurgeResult) => void;
  readonly onError: (error: unknown) => void;
  readonly now?: () => number;
  readonly intervalMs?: number;
}

export interface RetentionJob {
  stop(): void;
}

/**
 * Runs `purgeExpired` now and then every interval. A sweep still running when the next is due is
 * not doubled up; a failed sweep is reported and the next one tries again.
 */
export function startRetentionJob(db: Queryable, options: RetentionJobOptions): RetentionJob {
  const now = options.now ?? Date.now;
  let running = false;

  const sweep = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      // Purge first, report second: `onSwept?.(await purge())` would skip the purge itself when
      // no `onSwept` is given (an optional call short-circuits its arguments).
      const result = await purgeExpired(db, { now: now() });
      options.onSwept?.(result);
    } catch (error) {
      options.onError(error);
    } finally {
      running = false;
    }
  };

  void sweep();
  const timer = setInterval(() => void sweep(), options.intervalMs ?? RETENTION_SWEEP_INTERVAL_MS);
  // The job must never be what keeps the process alive after the server closed.
  timer.unref();
  return {
    stop() {
      clearInterval(timer);
    },
  };
}
