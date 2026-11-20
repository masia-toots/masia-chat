/**
 * An OUTBOX store: per-address lists of what a person sent that the server has not confirmed yet, kept
 * OUTSIDE the screen that made them.
 *
 * Why outside: a chat screen unmounts on a tab switch, a conversation switch, an app resume. A list held
 * in the screen's own state died with it, and the words the person typed vanished without a trace. Held
 * here, an entry outlives the screen; with a `storage`, it outlives the page too (a reload, an app the
 * system killed in the background).
 *
 * Shape: a subscriber store. `read` returns the SAME array until that address changes, so it is a valid
 * `useSyncExternalStore` snapshot; every write tells every subscriber.
 *
 * Persistence is the caller's choice: a Web Storage subset (`localStorage` in a browser), or `null` for
 * memory only. An end-to-end encrypted room passes `null`: its plaintext must never sit in plain browser
 * storage. Every storage access is wrapped: blocked storage, a private window or a full quota cost an
 * entry its survival of a reload, never the send itself.
 */

/** The part of Web Storage the outbox uses (`window.localStorage` is one). */
export interface OutboxStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** What every outbox entry has: an id, unique within its address. */
export interface OutboxEntryBase {
  readonly id: string;
}

export interface OutboxStoreOptions<E extends OutboxEntryBase> {
  /** Where entries are written to survive a reload; `null` keeps them for the life of the page only. */
  readonly storage: OutboxStorage | null;
  /** Prefix of every storage key. Versioned: a new entry shape takes a new prefix, never a migration. */
  readonly keyPrefix: string;
  /**
   * Turns one stored value back into an entry, or `null` to drop it. It runs when an address is first
   * read in this page, so it is also where the caller says what a reload means for an entry (nothing is
   * in flight any more after one).
   */
  revive(value: unknown): E | null;
  /** Whether an entry may be written to storage (absent = all). One that may not lives in memory only. */
  persistable?(entry: E, address: string): boolean;
}

export interface OutboxStore<E extends OutboxEntryBase> {
  /** The entries at `address`, oldest first: the same array until they change. */
  read(address: string): readonly E[];
  /** Called after every write, at any address. Returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
  /** Replaces the list at `address` with what `change` makes of it (the same array = no write). */
  rewrite(address: string, change: (entries: readonly E[]) => readonly E[]): void;
  /** Adds `entry` at the end, or replaces the entry with its id where it stands. */
  put(address: string, entry: E): void;
  /** Applies `change` to the entry with this id; an unknown id changes nothing. */
  update(address: string, id: string, change: (entry: E) => E): void;
  /** Drops the entry with this id; an unknown id changes nothing. */
  remove(address: string, id: string): void;
}

const NOTHING: readonly never[] = Object.freeze([]);

function readStored(storage: OutboxStorage | null, key: string): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

export function createOutboxStore<E extends OutboxEntryBase>(
  options: OutboxStoreOptions<E>,
): OutboxStore<E> {
  const { storage, keyPrefix, revive, persistable } = options;
  const lists = new Map<string, readonly E[]>();
  const listeners = new Set<() => void>();

  function read(address: string): readonly E[] {
    const held = lists.get(address);
    if (held) return held;
    let loaded: readonly E[] = NOTHING;
    const raw = readStored(storage, keyPrefix + address);
    if (raw) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          const revived = parsed.map((value: unknown) => revive(value)).filter((e): e is E => e !== null);
          if (revived.length > 0) loaded = revived;
        }
      } catch {
        // A value this version cannot read: as if nothing were stored.
      }
    }
    lists.set(address, loaded);
    return loaded;
  }

  function persist(address: string, entries: readonly E[]): void {
    if (!storage) return;
    const kept = persistable ? entries.filter((entry) => persistable(entry, address)) : entries;
    try {
      if (kept.length > 0) storage.setItem(keyPrefix + address, JSON.stringify(kept));
      else storage.removeItem(keyPrefix + address);
    } catch {
      // Quota or blocked storage: the entries still live in memory for this page.
    }
  }

  function rewrite(address: string, change: (entries: readonly E[]) => readonly E[]): void {
    const before = read(address);
    const after = change(before);
    if (after === before) return;
    const next = after.length > 0 ? after : NOTHING;
    lists.set(address, next);
    persist(address, next);
    for (const listener of [...listeners]) listener();
  }

  return {
    read,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    rewrite,
    put(address, entry) {
      rewrite(address, (entries) => {
        const at = entries.findIndex((e) => e.id === entry.id);
        if (at === -1) return [...entries, entry];
        const copy = [...entries];
        copy[at] = entry;
        return copy;
      });
    },
    update(address, id, change) {
      rewrite(address, (entries) => {
        const at = entries.findIndex((e) => e.id === id);
        if (at === -1) return entries;
        const copy = [...entries];
        copy[at] = change(entries[at]!);
        return copy;
      });
    },
    remove(address, id) {
      rewrite(address, (entries) =>
        entries.some((e) => e.id === id) ? entries.filter((e) => e.id !== id) : entries,
      );
    },
  };
}

/** The browser's `localStorage`, or `null` where there is none or it cannot be reached. */
export function browserOutboxStorage(): OutboxStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}
