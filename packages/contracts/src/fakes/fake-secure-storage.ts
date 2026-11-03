import {
  isStorageClass,
  SECURE_STORAGE_MAX_KEY_CHARS,
  SECURE_STORAGE_MAX_VALUE_BYTES,
  SecureStorageError,
  type SecureStorage,
  type SecureStorageErrorKind,
  type StorageClass,
} from '../ports/secure-storage.js';

/**
 * A fake store that also tells a test which protection class a key was written under, and lets it
 * put the store into the failure states a real platform has (a locked phone, a damaged value).
 */
export interface FakeSecureStorage extends SecureStorage {
  classOf(key: string): StorageClass | undefined;
  /** From now on every call rejects with `kind` (a locked phone is `unavailable`); `null` heals it. */
  failWith(kind: SecureStorageErrorKind | null): void;
  /** The value under `key` stays stored but no longer authenticates: `get` rejects `corrupt`. */
  corrupt(key: string): void;
}

interface StoredSecret {
  readonly value: Uint8Array;
  readonly cls: StorageClass;
  readonly corrupt: boolean;
}

/** In-memory `SecureStorage`; copies on the way in and out, like a real keychain does. */
export function createFakeSecureStorage(): FakeSecureStorage {
  const entries = new Map<string, StoredSecret>();
  let failure: SecureStorageErrorKind | null = null;

  function checkReachable(): void {
    if (failure !== null) throw new SecureStorageError(failure);
  }

  function checkKey(key: unknown, allowEmpty = false): void {
    if (
      typeof key !== 'string' ||
      (!allowEmpty && key.length === 0) ||
      key.length > SECURE_STORAGE_MAX_KEY_CHARS
    ) {
      throw new SecureStorageError('invalid');
    }
  }

  return {
    async get(key) {
      checkKey(key);
      checkReachable();
      const entry = entries.get(key);
      if (!entry) return null;
      if (entry.corrupt) throw new SecureStorageError('corrupt');
      return entry.value.slice();
    },
    async set(key, value, cls) {
      checkKey(key);
      if (
        !(value instanceof Uint8Array) ||
        value.byteLength === 0 ||
        value.byteLength > SECURE_STORAGE_MAX_VALUE_BYTES ||
        !isStorageClass(cls)
      ) {
        throw new SecureStorageError('invalid');
      }
      checkReachable();
      entries.set(key, { value: value.slice(), cls, corrupt: false });
    },
    async delete(key) {
      checkKey(key);
      checkReachable();
      entries.delete(key);
    },
    async clear(prefix) {
      checkKey(prefix, true);
      checkReachable();
      for (const key of [...entries.keys()]) {
        if (key.startsWith(prefix)) entries.delete(key);
      }
    },
    classOf: (key) => entries.get(key)?.cls,
    failWith(kind) {
      failure = kind;
    },
    corrupt(key) {
      const entry = entries.get(key);
      if (entry) entries.set(key, { ...entry, corrupt: true });
    },
  };
}
