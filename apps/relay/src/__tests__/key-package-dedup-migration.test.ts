import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { databaseSuite } from './support/harness.js';

const MIGRATION = readFileSync(
  fileURLToPath(
    new URL('../../prisma/migrations/20261011180000_key_package_dedup/migration.sql', import.meta.url),
  ),
  'utf8',
);
const INDEX = 'key_packages_device_id_bytes_sha256_key';
const ROLLBACK = new Error('undo the migration test');

const MS_PER_HOUR = 3_600_000;
const FAR_FUTURE = new Date(Date.UTC(2030, 0, 1));

databaseSuite('the key-package de-duplication migration', (harness) => {
  async function insert(
    run: (sql: string, params: unknown[]) => Promise<{ rows: Array<{ id: string }> }>,
    row: {
      deviceId: string;
      bytes: string;
      lastResort?: boolean;
      consumed?: boolean;
      ageHours: number;
    },
  ): Promise<string> {
    const created = new Date(Date.UTC(2026, 9, 1) - row.ageHours * MS_PER_HOUR);
    const result = await run(
      `INSERT INTO key_packages (device_id, bytes, last_resort, consumed_at, not_after, created_at)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [
        row.deviceId,
        Buffer.from(row.bytes),
        row.lastResort ?? false,
        row.consumed ? created : null,
        FAR_FUTURE,
        created,
      ],
    );
    return result.rows[0]?.id ?? '';
  }

  it('collapses copies already stored (keeping the last resort, then the handed-out one, with its claims) and then refuses new copies', async () => {
    await harness().enrol('bob', 'bob-phone');
    await harness().enrol('alice', 'alice-phone');

    let survivors: Array<{ id: string; deviceId: string; lastResort: boolean }> = [];
    let claimsOfSurvivor: string[] = [];
    let indexed = 0;
    let expected: { handedOut: string; lastResort: string; single: string; otherDevice: string } | null =
      null;

    await expect(
      harness().db.transaction(async (tx) => {
        // The migration runs on a database that has not got the index yet.
        await tx.query(`DROP INDEX ${INDEX}`);
        const run = (sql: string, params: unknown[]) => tx.query<{ id: string }>(sql, params);

        // Three copies of one package: the old unspent one, the one that was handed out, a newer one.
        const oldest = await insert(run, { deviceId: 'bob-phone', bytes: 'A', ageHours: 3 });
        const handedOut = await insert(run, {
          deviceId: 'bob-phone',
          bytes: 'A',
          consumed: true,
          ageHours: 2,
        });
        const newest = await insert(run, { deviceId: 'bob-phone', bytes: 'A', ageHours: 1 });
        await tx.query(
          'INSERT INTO key_package_claims (key_package_id, claimer_device_id) VALUES ($1, $2), ($3, $4)',
          [handedOut, 'alice-phone', newest, 'bob-phone'],
        );
        await tx.query(
          'INSERT INTO key_package_claims (key_package_id, claimer_device_id) VALUES ($1, $2)',
          [oldest, 'alice-phone'],
        );
        // An ordinary copy and a last-resort copy of the same bytes: the device keeps its last resort.
        await insert(run, { deviceId: 'bob-phone', bytes: 'B', ageHours: 5 });
        const lastResort = await insert(run, {
          deviceId: 'bob-phone',
          bytes: 'B',
          lastResort: true,
          ageHours: 4,
        });
        // A package that is stored once, and the same bytes on ANOTHER device: both stay.
        const single = await insert(run, { deviceId: 'bob-phone', bytes: 'C', ageHours: 1 });
        const otherDevice = await insert(run, { deviceId: 'alice-phone', bytes: 'A', ageHours: 1 });
        expected = { handedOut, lastResort, single, otherDevice };

        await tx.query(MIGRATION);

        survivors = (
          await tx.query<{ id: string; deviceId: string; lastResort: boolean }>(
            'SELECT id, device_id AS "deviceId", last_resort AS "lastResort" FROM key_packages ORDER BY id',
          )
        ).rows;
        claimsOfSurvivor = (
          await tx.query<{ claimer: string }>(
            'SELECT claimer_device_id AS claimer FROM key_package_claims WHERE key_package_id = $1 ORDER BY 1',
            [handedOut],
          )
        ).rows.map((row) => row.claimer);
        indexed = (
          await tx.query('SELECT 1 FROM pg_indexes WHERE indexname = $1', [INDEX])
        ).rows.length;
        throw ROLLBACK;
      }),
    ).rejects.toBe(ROLLBACK);

    expect(expected).not.toBeNull();
    const kept = expected as unknown as { handedOut: string; lastResort: string; single: string; otherDevice: string };
    expect(survivors.map((row) => row.id).sort()).toEqual(
      [kept.handedOut, kept.lastResort, kept.single, kept.otherDevice].sort(),
    );
    // The claim record of a copy that went (bob's claim of the newest) now sits on the survivor.
    expect(claimsOfSurvivor).toEqual(['alice-phone', 'bob-phone']);
    expect(indexed).toBe(1);
  });

  it('leaves the database refusing a second copy of the same bytes on a device', async () => {
    await harness().enrol('bob', 'bob-phone');
    await insert((sql, params) => harness().db.query<{ id: string }>(sql, params), {
      deviceId: 'bob-phone',
      bytes: 'A',
      ageHours: 1,
    });
    await expect(
      insert((sql, params) => harness().db.query<{ id: string }>(sql, params), {
        deviceId: 'bob-phone',
        bytes: 'A',
        ageHours: 2,
      }),
    ).rejects.toThrow(new RegExp(INDEX));
  });
});
