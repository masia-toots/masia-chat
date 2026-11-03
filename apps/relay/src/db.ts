import { ROOM_BUSY_RETRY_AFTER_SECONDS, RoomBusyError } from '@masia/relay';
import pg from 'pg';

/** Anything that can run a statement: the pool, or one connection inside a transaction. */
export interface Queryable {
  query<Row extends pg.QueryResultRow>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<pg.QueryResult<Row>>;
}

/** The relay's only door to Postgres. Domain code is written against this, never against `pg`. */
export interface Database extends Queryable {
  /**
   * Runs `work` in one transaction: COMMIT if it resolves, ROLLBACK if it throws (the error is
   * rethrown unchanged). Every write that must be atomic goes through here.
   */
  transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/**
 * How long the relay waits on Postgres, in milliseconds. Every request holds at most one connection
 * and at most one conversation lock for a few statements, so anything slower than these is a stuck
 * database or a stuck peer, and the right answer is to give the connection back and say so.
 */
export interface DatabaseTimeouts {
  /** Waiting for a free pooled connection (or a new one) before the request fails. */
  readonly connectionTimeoutMs: number;
  /** One statement, server side (`statement_timeout`). */
  readonly statementTimeoutMs: number;
  /**
   * Waiting for a row lock (`lock_timeout`): in practice the conversation row a busy room's writers
   * queue on. Hitting it is answered 503 ROOM_BUSY with `Retry-After`, never a hung request.
   */
  readonly lockTimeoutMs: number;
  /** A transaction left open with nothing running (`idle_in_transaction_session_timeout`). */
  readonly idleInTransactionTimeoutMs: number;
}

export const DEFAULT_DATABASE_TIMEOUTS: DatabaseTimeouts = {
  connectionTimeoutMs: 5_000,
  statementTimeoutMs: 10_000,
  lockTimeoutMs: 3_000,
  idleInTransactionTimeoutMs: 15_000,
};


/** Postgres `lock_not_available`: the lock timeout fired (or NOWAIT found the row taken). */
const PG_LOCK_NOT_AVAILABLE = '55P03';

export interface DatabaseOptions {
  /** Called with errors from idle connections; without a listener `pg` would crash the process. */
  readonly onIdleError: (error: Error) => void;
  /** Upper bound on simultaneous connections. */
  readonly maxConnections?: number;
  /** Overrides of `DEFAULT_DATABASE_TIMEOUTS` (tests shorten the lock timeout). */
  readonly timeouts?: Partial<DatabaseTimeouts>;
}

/** Enough for one process: every transaction here is short and holds at most one conversation lock. */
const DEFAULT_MAX_CONNECTIONS = 10;

/**
 * Turns the database errors a client can act on into relay refusals. Only the lock timeout is one:
 * the request changed nothing and can be sent again as it is. Everything else is a 500 upstream.
 */
function translateError(error: unknown): unknown {
  if (error instanceof Error && (error as { code?: unknown }).code === PG_LOCK_NOT_AVAILABLE) {
    return new RoomBusyError(ROOM_BUSY_RETRY_AFTER_SECONDS);
  }
  return error;
}

async function translated<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw translateError(error);
  }
}

/** `pg` types its parameter list as mutable; ours is read-only, so hand it a copy. */
function asMutable(params: readonly unknown[] | undefined): unknown[] | undefined {
  return params === undefined ? undefined : [...params];
}

export function createDatabase(connectionString: string, options: DatabaseOptions): Database {
  const timeouts = { ...DEFAULT_DATABASE_TIMEOUTS, ...options.timeouts };
  const pool = new pg.Pool({
    connectionString,
    max: options.maxConnections ?? DEFAULT_MAX_CONNECTIONS,
    connectionTimeoutMillis: timeouts.connectionTimeoutMs,
    // Sent as session settings when each connection opens, so they hold for every statement.
    statement_timeout: timeouts.statementTimeoutMs,
    lock_timeout: timeouts.lockTimeoutMs,
    idle_in_transaction_session_timeout: timeouts.idleInTransactionTimeoutMs,
  });
  pool.on('error', options.onIdleError);

  return {
    query(sql, params) {
      return translated(() => pool.query(sql, asMutable(params)));
    },

    async transaction(work) {
      const client = await translated(() => pool.connect());
      let brokenBy: Error | undefined;
      try {
        await client.query('BEGIN');
        const result = await work({
          query: (sql, params) => translated(() => client.query(sql, asMutable(params))),
        });
        await client.query('COMMIT');
        return result;
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          // The connection is unusable: the caller needs the ORIGINAL error, and the pool must
          // discard this connection instead of handing it to the next request.
          brokenBy =
            rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
        }
        throw error;
      } finally {
        client.release(brokenBy);
      }
    },

    close() {
      return pool.end();
    },
  };
}
