/**
 * Where the database suites run, and the guard that keeps them off anything else.
 *
 * The suites EMPTY every table between tests, so the one thing that must never happen is pointing
 * them at a database that holds real rows. Two independent guards: the URL must name a database
 * whose name ends in `_test`, and the harness re-checks `current_database()` on the live
 * connection before it truncates anything.
 */

/** Overrides the test database, e.g. in CI where Postgres is a service container. */
export const TEST_DATABASE_URL_ENV = 'RELAY_TEST_DATABASE_URL';

/** `1` makes an unreachable test database a failure instead of a skip (set it in CI). */
export const REQUIRE_DATABASE_ENV = 'RELAY_TEST_REQUIRE_DB';

export const THROWAWAY_DATABASE_SUFFIX = '_test';

/** A Postgres on this machine, with a throwaway database of its own (its name ends in `_test`). */
export const DEFAULT_TEST_DATABASE_URL = 'postgresql://relay@localhost:5432/relay_test';

/** Database names are interpolated into `CREATE DATABASE`, so they are restricted to this alphabet. */
const DATABASE_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

export function resolveTestDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env[TEST_DATABASE_URL_ENV];
  return raw === undefined || raw === '' ? DEFAULT_TEST_DATABASE_URL : raw;
}

export function databaseNameOf(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
}

/** Throws unless `name` is a database these suites may empty. */
export function assertThrowawayDatabaseName(name: string): void {
  if (!DATABASE_NAME_PATTERN.test(name) || !name.endsWith(THROWAWAY_DATABASE_SUFFIX)) {
    throw new Error(
      `Refusing to run database tests against "${name}": the name must be lowercase ` +
        `letters/digits/underscores and end in "${THROWAWAY_DATABASE_SUFFIX}".`,
    );
  }
}

/** The same server, a different database: how the setup reaches the `postgres` maintenance DB. */
export function withDatabase(url: string, name: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.toString();
}
