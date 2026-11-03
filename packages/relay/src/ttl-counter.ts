/**
 * A counter per key that forgets: the one in-memory primitive behind both the rebase limit
 * (consecutive lost races) and the key-package claim rate limit (claims per window).
 *
 * Why in memory and not in the database: both limits protect a single relay process from a
 * misbehaving client, lose nothing important on restart, and must not add a write to the hot path.
 * The price is that they are per process; scaling the relay out (several processes behind one
 * address) would need a shared counter, which is a decision for that day, not this one.
 */

export interface TtlCounterOptions {
  /** How long a count lives. */
  readonly ttlMs: number;
  /**
   * `fixed`: the window opens at the first hit and closes ttlMs later, whatever happens in between
   * (a rate limit). `sliding`: every hit pushes the end out, so only a pause of ttlMs forgets
   * (a run of consecutive failures).
   */
  readonly window: 'fixed' | 'sliding';
  /** Injected so tests can move time without sleeping. */
  readonly now?: () => number;
}

export interface CounterReading {
  /** Hits in the current window, this one included. */
  readonly count: number;
  /** Epoch milliseconds at which the count will be forgotten. */
  readonly resetsAt: number;
}

export interface TtlCounter {
  /** Counts one more occurrence of `key` and says where the count stands. */
  hit(key: string): CounterReading;
  /** Forgets `key` now (the run was broken, e.g. by a success). */
  reset(key: string): void;
  /** Keys currently remembered; exposed so tests can prove expired keys are released. */
  readonly size: number;
}

interface Entry {
  count: number;
  resetsAt: number;
}

export function createTtlCounter(options: TtlCounterOptions): TtlCounter {
  const { ttlMs, window } = options;
  const now = options.now ?? Date.now;
  const entries = new Map<string, Entry>();
  let lastSweepAt = now();

  // Expired keys are dropped lazily, at most once per ttl, so a stream of one-off keys (the
  // attacker's best move) cannot grow the map without bound and no timer keeps the process alive.
  function sweepIfDue(at: number): void {
    if (at - lastSweepAt < ttlMs) return;
    lastSweepAt = at;
    for (const [key, entry] of entries) {
      if (entry.resetsAt <= at) entries.delete(key);
    }
  }

  return {
    hit(key) {
      const at = now();
      sweepIfDue(at);
      const existing = entries.get(key);
      if (existing === undefined || existing.resetsAt <= at) {
        const fresh = { count: 1, resetsAt: at + ttlMs };
        entries.set(key, fresh);
        return { ...fresh };
      }
      existing.count += 1;
      if (window === 'sliding') existing.resetsAt = at + ttlMs;
      return { count: existing.count, resetsAt: existing.resetsAt };
    },
    reset(key) {
      entries.delete(key);
    },
    get size() {
      return entries.size;
    },
  };
}
