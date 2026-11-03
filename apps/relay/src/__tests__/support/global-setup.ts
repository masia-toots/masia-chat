import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { GlobalSetupContext } from 'vitest/node';
import {
  assertThrowawayDatabaseName,
  databaseNameOf,
  REQUIRE_DATABASE_ENV,
  resolveTestDatabaseUrl,
  withDatabase,
} from './test-database.js';

/** What the setup tells every test file: the URL to use, or `null` when there is no database. */
export interface RelayTestDatabase {
  readonly url: string | null;
}

declare module 'vitest' {
  export interface ProvidedContext {
    relayTestDatabase: RelayTestDatabase;
  }
}

const MAINTENANCE_DATABASE = 'postgres';
const MIGRATIONS_DIR = fileURLToPath(new URL('../../../prisma/migrations/', import.meta.url));

/** Errors that mean "nobody is listening", as opposed to "something is wrong with our SQL". */
const UNREACHABLE_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'EAI_AGAIN']);

function isUnreachable(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code, errors } = error as { code?: unknown; errors?: unknown };
  if (typeof code === 'string' && UNREACHABLE_CODES.has(code)) return true;
  return Array.isArray(errors) && errors.length > 0 && errors.every(isUnreachable);
}

async function withClient<T>(url: string, work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

async function ensureDatabase(url: string, name: string): Promise<void> {
  await withClient(withDatabase(url, MAINTENANCE_DATABASE), async (client) => {
    const found = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    // The name is validated against a strict alphabet by `assertThrowawayDatabaseName`, because an
    // identifier cannot be a bind parameter.
    if (found.rowCount === 0) await client.query(`CREATE DATABASE "${name}"`);
  });
}

/**
 * Applies the real migration files, in order, once each. A migration counts as applied if either
 * this runner or `prisma migrate deploy` recorded it, so a database prepared by either works.
 */
async function applyMigrations(url: string): Promise<void> {
  await withClient(url, async (client) => {
    await client.query(
      'CREATE TABLE IF NOT EXISTS relay_test_migrations (name text PRIMARY KEY, checksum text NOT NULL)',
    );
    const recorded = new Set<string>();
    for (const row of (await client.query<{ name: string }>('SELECT name FROM relay_test_migrations')).rows) {
      recorded.add(row.name);
    }
    const prismaTable = await client.query<{ present: string | null }>(
      "SELECT to_regclass('_prisma_migrations') AS present",
    );
    if (typeof prismaTable.rows[0]?.present === 'string') {
      const prisma = await client.query<{ name: string }>(
        'SELECT migration_name AS name FROM _prisma_migrations WHERE finished_at IS NOT NULL',
      );
      for (const row of prisma.rows) recorded.add(row.name);
    }

    const entries = await readdir(MIGRATIONS_DIR, { withFileTypes: true });
    const names = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    for (const name of names) {
      if (recorded.has(name)) continue;
      const sql = await readFile(path.join(MIGRATIONS_DIR, name, 'migration.sql'), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO relay_test_migrations (name, checksum) VALUES ($1, $2)', [name, checksum]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  });
}

export default async function setup({ provide }: GlobalSetupContext): Promise<void> {
  const url = resolveTestDatabaseUrl();
  const name = databaseNameOf(url);
  assertThrowawayDatabaseName(name);

  try {
    await ensureDatabase(url, name);
    await applyMigrations(url);
    provide('relayTestDatabase', { url });
  } catch (error) {
    // Only "nobody is listening" is a skip. A broken migration or a refused login is a real
    // failure and must not turn a red suite into a quietly skipped one.
    if (!isUnreachable(error) || process.env[REQUIRE_DATABASE_ENV] === '1') throw error;
    console.warn(
      `[relay tests] Postgres is not reachable at ${new URL(url).host}; the database suites are SKIPPED. ` +
        `Start the dev Postgres, or set ${REQUIRE_DATABASE_ENV}=1 to make this an error.`,
    );
    provide('relayTestDatabase', { url: null });
  }
}
