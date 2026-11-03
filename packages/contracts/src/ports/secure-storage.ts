/**
 * The access class of a stored secret. Each class maps to a different platform protection level
 * (ADR-117 section 2, published as `docs/adr/0001-e2ee-on-mls.md` in the messenger package):
 *
 * - `identity` and `history` -> iOS Keychain `WhenUnlockedThisDeviceOnly` (optionally behind an
 *   app lock), Android Keystore with StrongBox where available, and on the web a non-extractable
 *   WebCrypto key wrapping an IndexedDB blob.
 * - `push` -> iOS Keychain `AfterFirstUnlockThisDeviceOnly`: the one sub-key that must stay
 *   readable while the phone is locked so a generic push can be decrypted locally.
 *
 * Why a class and not one bucket: a single Keychain class for everything would force the push
 * sub-key to be as exposed as the identity key, or the identity key to be unreadable at push time.
 */
export const STORAGE_CLASSES = ['identity', 'history', 'push'] as const;
export type StorageClass = (typeof STORAGE_CLASSES)[number];

/** True for one of the port's `StorageClass` strings. */
export function isStorageClass(value: unknown): value is StorageClass {
  return typeof value === 'string' && (STORAGE_CLASSES as readonly string[]).includes(value);
}

/**
 * The longest `key` (and `clear` prefix) every host takes, in UTF-16 code units. The messenger's keys
 * are short paths (`mls/state/<device>`); the limit stops a runaway string from becoming a Keychain
 * account name or a file name. The native stores mirror it (a hub test reads their sources).
 */
export const SECURE_STORAGE_MAX_KEY_CHARS = 256;

/**
 * The largest `value` every host takes, in bytes. MLS group state for a large room is hundreds of KB;
 * four MiB is far above that and far below what a Keychain item or a bridge message handles comfortably.
 * A caller that may produce more must split its value or refuse it itself: the host rejects it as
 * `invalid`.
 */
export const SECURE_STORAGE_MAX_VALUE_BYTES = 4 * 1024 * 1024;

/**
 * Why a call failed, the same way on every host, so the messenger can act on it:
 *
 * - `unavailable`: the store cannot be reached right now (phone locked, Keystore daemon down, a native
 *   plugin missing from this build, a browser without IndexedDB). Retry later; nothing is lost.
 * - `corrupt`: a value is stored but fails authentication or cannot be decoded. It will never read
 *   again; the caller deletes it and re-enrols.
 * - `invalid`: the request itself is refused (empty value, over-long key, unknown class, over-size
 *   value). A bug in the caller; retrying cannot help.
 * - `conflict`: another writer on this device changed the key after this one last read it (a second
 *   browser tab). The write did not happen; read the key again and decide afresh.
 * - `failed`: anything else the platform reported.
 */
export const SECURE_STORAGE_ERROR_KINDS = [
  'unavailable',
  'corrupt',
  'invalid',
  'conflict',
  'failed',
] as const;
export type SecureStorageErrorKind = (typeof SECURE_STORAGE_ERROR_KINDS)[number];

/** The fixed text for each kind. A host picks the kind; it never composes a message from platform text. */
export const SECURE_STORAGE_ERROR_MESSAGES: Readonly<Record<SecureStorageErrorKind, string>> = {
  unavailable: 'SecureStorage: the store is not available right now',
  corrupt: 'SecureStorage: a stored value cannot be read',
  invalid: 'SecureStorage: the request was refused',
  conflict: 'SecureStorage: another writer changed this key first',
  failed: 'SecureStorage: the store reported a failure',
};

const SECURE_STORAGE_ERROR_NAME = 'SecureStorageError';

/**
 * What every `SecureStorage` method rejects with. The message is the fixed text of its kind: it never
 * carries a key name (a device id) or a value (a secret), because errors end up in logs and crash
 * reports.
 */
export class SecureStorageError extends Error {
  readonly kind: SecureStorageErrorKind;
  /** The platform's own error, for a debugger. Never read it into a log line: it may name a key. */
  readonly cause?: unknown;

  constructor(kind: SecureStorageErrorKind, cause?: unknown) {
    super(SECURE_STORAGE_ERROR_MESSAGES[kind]);
    this.name = SECURE_STORAGE_ERROR_NAME;
    this.kind = kind;
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * True for a `SecureStorageError`, including one built by another copy of this package (a host bundle
 * and the messenger may not share the class), so it checks the shape, not only the prototype.
 */
export function isSecureStorageError(value: unknown): value is SecureStorageError {
  if (value instanceof SecureStorageError) return true;
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { name?: unknown; kind?: unknown };
  return (
    candidate.name === SECURE_STORAGE_ERROR_NAME &&
    (SECURE_STORAGE_ERROR_KINDS as readonly unknown[]).includes(candidate.kind)
  );
}

/**
 * Device-local secret storage for key material and MLS state.
 *
 * Why: where a key may live is a platform decision (Keychain, Keystore, WebCrypto), not a
 * messenger decision. The messenger states the class it needs; the host maps it to hardware.
 * Values are copied in and out so a caller wiping its buffer cannot wipe, or alias, the stored key.
 *
 * What a host owes (a store that does less than this is not a `SecureStorage`; the contract suite in
 * `@masia/contracts/contract-tests` checks every point a test can observe):
 * - **Device-bound.** A value never leaves the install that wrote it: no cloud sync, no backup that
 *   restores it elsewhere, gone with the install (an app uninstall; in a browser, cleared site data).
 *   The key is the caller's whole namespace (the messenger puts account and device into the key
 *   string); the host adds only its own prefix.
 * - **A failure is not an absence.** Every method rejects with a `SecureStorageError` when the platform
 *   store cannot be reached or a stored value cannot be read (device locked, store down, value fails
 *   authentication). `get` resolves `null` only when nothing is stored: a caller that took a read
 *   failure for "no key" would mint a new identity over a good one.
 * - **Limits.** A key is 1 to `SECURE_STORAGE_MAX_KEY_CHARS` characters; a value is 1 to
 *   `SECURE_STORAGE_MAX_VALUE_BYTES` bytes (platform stores differ on empty items, so no host promises
 *   them); anything else is `invalid` before the store is touched.
 * - **Wiped on sign-out.** `clear(prefix)` removes every key under `prefix`, and the host calls it from
 *   its sign-out path for the namespace of the account that signs out. A shared family tablet must not
 *   hand the next person the previous one's identity key.
 * - **One writer per device.** A store that one device can open from several places at once (browser
 *   tabs over one IndexedDB) serialises writers and refuses a stale one: a write from a writer that last
 *   read an older version of the key rejects `conflict` instead of overwriting newer state. A native app
 *   is one process with one store, so it has one writer by construction.
 */
export interface SecureStorage {
  /** Resolves the stored bytes, or `null` when nothing is stored under `key`. */
  get(key: string): Promise<Uint8Array | null>;
  /** Stores (or replaces) `value` under `key` with the protection of class `cls`. Rejects an empty `value`. */
  set(key: string, value: Uint8Array, cls: StorageClass): Promise<void>;
  /** Removes `key`; removing a key that is not there is not an error. */
  delete(key: string): Promise<void>;
  /**
   * Removes every key that starts with `prefix` (`''` = everything this store holds). Removing nothing is
   * not an error. The sign-out duty above.
   */
  clear(prefix: string): Promise<void>;
}
