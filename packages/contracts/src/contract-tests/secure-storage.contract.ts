import { describe, expect, it } from 'vitest';
import {
  isSecureStorageError,
  SECURE_STORAGE_ERROR_KINDS,
  SECURE_STORAGE_ERROR_MESSAGES,
  SECURE_STORAGE_MAX_KEY_CHARS,
  SECURE_STORAGE_MAX_VALUE_BYTES,
  STORAGE_CLASSES,
  type SecureStorage,
} from '../ports/secure-storage.js';
import {
  bytesToNumbers,
  contractTitle,
  secureStorageOutcome,
  type ContractFactory,
} from './contract-support.js';

const CONTRACT_KEY = 'contract-key';
const OTHER_KEY = 'contract-other-key';
const ACCOUNT_A = 'contract/account-a/';
const ACCOUNT_B = 'contract/account-b/';

/**
 * How the suite puts an implementation into the failure states a real platform has. Without these
 * the port's "a failure is not an absence" rule could not be tested, only promised.
 */
export interface SecureStorageContractHarness<T extends SecureStorage> {
  /**
   * From now on the platform store behind `storage` cannot be reached (a locked phone, a Keystore
   * daemon that is down, IndexedDB refusing to open). Every call must then reject `unavailable`.
   */
  makeUnreachable(storage: T): void | Promise<void>;
  /** Damages the value stored under `key` so it no longer authenticates (but stays stored). */
  corrupt(storage: T, key: string): void | Promise<void>;
  /**
   * A second writer over the SAME device store as `storage` (another browser tab over one IndexedDB).
   * Omit it only where the platform has one writer per device by construction (a native app process).
   */
  secondWriter?(storage: T): SecureStorage | Promise<SecureStorage>;
}

async function read(storage: SecureStorage, key: string): Promise<number[] | null> {
  const stored = await storage.get(key);
  return stored === null ? null : bytesToNumbers(stored);
}

/** Registers the behavioural contract every `SecureStorage` implementation must honour. */
export function describeSecureStorageContract<T extends SecureStorage>(
  name: string,
  factory: ContractFactory<T>,
  harness: SecureStorageContractHarness<T>,
): void {
  describe(contractTitle('SecureStorage', name), () => {
    it('answers null for a key that was never stored', async () => {
      const storage = await factory();
      expect(await storage.get(CONTRACT_KEY)).toBeNull();
    });

    it.each(STORAGE_CLASSES)('round-trips a value stored under the %s class', async (cls) => {
      const storage = await factory();
      await storage.set(CONTRACT_KEY, Uint8Array.of(1, 2, 3), cls);
      expect(await read(storage, CONTRACT_KEY)).toEqual([1, 2, 3]);
    });

    it('replaces the value when the same key is set again', async () => {
      const storage = await factory();
      await storage.set(CONTRACT_KEY, Uint8Array.of(1), 'identity');
      await storage.set(CONTRACT_KEY, Uint8Array.of(2), 'identity');
      expect(await read(storage, CONTRACT_KEY)).toEqual([2]);
    });

    it('keeps different keys apart', async () => {
      const storage = await factory();
      await storage.set(CONTRACT_KEY, Uint8Array.of(1), 'history');
      await storage.set(OTHER_KEY, Uint8Array.of(2), 'history');
      expect(await read(storage, CONTRACT_KEY)).toEqual([1]);
      expect(await read(storage, OTHER_KEY)).toEqual([2]);
    });

    it('forgets a deleted key, and deleting a missing key is not an error', async () => {
      const storage = await factory();
      await storage.set(CONTRACT_KEY, Uint8Array.of(1), 'identity');
      await storage.delete(CONTRACT_KEY);
      expect(await storage.get(CONTRACT_KEY)).toBeNull();
      await expect(storage.delete(CONTRACT_KEY)).resolves.toBeUndefined();
    });

    it('takes a key of exactly the longest allowed length', async () => {
      const storage = await factory();
      const longest = 'k'.repeat(SECURE_STORAGE_MAX_KEY_CHARS);
      await storage.set(longest, Uint8Array.of(4), 'identity');
      expect(await read(storage, longest)).toEqual([4]);
    });

    it('stores a copy: wiping the caller buffer does not wipe the stored key', async () => {
      const storage = await factory();
      const secret = Uint8Array.of(5, 5, 5);
      await storage.set(CONTRACT_KEY, secret, 'identity');
      secret.fill(0);
      expect(await read(storage, CONTRACT_KEY)).toEqual([5, 5, 5]);
    });

    it('hands out a copy: wiping what get returned does not wipe the stored key', async () => {
      const storage = await factory();
      await storage.set(CONTRACT_KEY, Uint8Array.of(6, 6, 6), 'identity');
      const first = await storage.get(CONTRACT_KEY);
      first?.fill(0);
      expect(await read(storage, CONTRACT_KEY)).toEqual([6, 6, 6]);
    });

    describe('invalid: a request no store can hold is refused, and nothing changes', () => {
      const refusals: Array<[string, (storage: SecureStorage) => Promise<unknown>]> = [
        ['an empty value', (s) => s.set(CONTRACT_KEY, new Uint8Array(0), 'identity')],
        [
          'a value one byte over the limit',
          (s) =>
            s.set(CONTRACT_KEY, new Uint8Array(SECURE_STORAGE_MAX_VALUE_BYTES + 1), 'identity'),
        ],
        ['an empty key', (s) => s.set('', Uint8Array.of(1), 'identity')],
        [
          'a key one character over the limit',
          (s) => s.set('k'.repeat(SECURE_STORAGE_MAX_KEY_CHARS + 1), Uint8Array.of(1), 'identity'),
        ],
        ['an unknown class', (s) => s.set(CONTRACT_KEY, Uint8Array.of(1), 'vault' as never)],
        ['a get of an empty key', (s) => s.get('')],
        ['a delete of an empty key', (s) => s.delete('')],
        [
          'a clear with an over-long prefix',
          (s) => s.clear('k'.repeat(SECURE_STORAGE_MAX_KEY_CHARS + 1)),
        ],
      ];

      it.each(refusals)('%s', async (_label, request) => {
        const storage = await factory();
        await storage.set(CONTRACT_KEY, Uint8Array.of(7), 'identity');
        expect(await secureStorageOutcome(request(storage))).toBe('invalid');
        expect(await read(storage, CONTRACT_KEY)).toEqual([7]);
      });
    });

    describe('clear(prefix): the sign-out wipe', () => {
      it('removes every key under the prefix and nothing else', async () => {
        const storage = await factory();
        await storage.set(`${ACCOUNT_A}identity`, Uint8Array.of(1), 'identity');
        await storage.set(`${ACCOUNT_A}mls/state`, Uint8Array.of(2), 'history');
        await storage.set(`${ACCOUNT_B}identity`, Uint8Array.of(3), 'identity');
        await storage.clear(ACCOUNT_A);
        expect(await storage.get(`${ACCOUNT_A}identity`)).toBeNull();
        expect(await storage.get(`${ACCOUNT_A}mls/state`)).toBeNull();
        expect(await read(storage, `${ACCOUNT_B}identity`)).toEqual([3]);
      });

      it("removes everything for '', and clearing nothing is not an error", async () => {
        const storage = await factory();
        await storage.set(`${ACCOUNT_A}identity`, Uint8Array.of(1), 'identity');
        await storage.set(OTHER_KEY, Uint8Array.of(2), 'push');
        await storage.clear('');
        expect(await storage.get(`${ACCOUNT_A}identity`)).toBeNull();
        expect(await storage.get(OTHER_KEY)).toBeNull();
        await expect(storage.clear('')).resolves.toBeUndefined();
        await expect(storage.clear(ACCOUNT_B)).resolves.toBeUndefined();
      });

      it('leaves the store writable afterwards', async () => {
        const storage = await factory();
        await storage.set(CONTRACT_KEY, Uint8Array.of(1), 'identity');
        await storage.clear('');
        await storage.set(CONTRACT_KEY, Uint8Array.of(2), 'identity');
        expect(await read(storage, CONTRACT_KEY)).toEqual([2]);
      });
    });

    describe('a failure is not an absence', () => {
      it('rejects unavailable, never null, when the store cannot be reached', async () => {
        const storage = await factory();
        await storage.set(CONTRACT_KEY, Uint8Array.of(1), 'identity');
        await harness.makeUnreachable(storage);
        expect(await secureStorageOutcome(storage.get(CONTRACT_KEY))).toBe('unavailable');
        // A key that was never stored is not "absent" either while the store cannot be asked.
        expect(await secureStorageOutcome(storage.get(OTHER_KEY))).toBe('unavailable');
        expect(
          await secureStorageOutcome(storage.set(CONTRACT_KEY, Uint8Array.of(2), 'identity')),
        ).toBe('unavailable');
        expect(await secureStorageOutcome(storage.delete(CONTRACT_KEY))).toBe('unavailable');
        expect(await secureStorageOutcome(storage.clear(''))).toBe('unavailable');
      });

      it('rejects corrupt, never null, for a stored value that fails authentication', async () => {
        const storage = await factory();
        await storage.set(CONTRACT_KEY, Uint8Array.of(1, 2, 3), 'identity');
        await storage.set(OTHER_KEY, Uint8Array.of(9), 'identity');
        await harness.corrupt(storage, CONTRACT_KEY);
        expect(await secureStorageOutcome(storage.get(CONTRACT_KEY))).toBe('corrupt');
        // Only that value is lost; the caller deletes it and writes afresh.
        expect(await read(storage, OTHER_KEY)).toEqual([9]);
        await storage.delete(CONTRACT_KEY);
        await storage.set(CONTRACT_KEY, Uint8Array.of(4), 'identity');
        expect(await read(storage, CONTRACT_KEY)).toEqual([4]);
      });

      it("rejects with a SecureStorageError of a known kind and that kind's fixed message", async () => {
        const storage = await factory();
        await storage.set('device-4711', Uint8Array.of(0xde, 0xad), 'identity');
        await harness.corrupt(storage, 'device-4711');
        const error = await storage.get('device-4711').then(
          () => null,
          (rejection: unknown) => rejection,
        );
        expect(isSecureStorageError(error)).toBe(true);
        if (!isSecureStorageError(error)) return;
        expect(SECURE_STORAGE_ERROR_KINDS).toContain(error.kind);
        expect(error.message).toBe(SECURE_STORAGE_ERROR_MESSAGES[error.kind]);
        expect(error.message).not.toContain('4711');
      });
    });

    if (harness.secondWriter) {
      const secondWriter = harness.secondWriter.bind(harness);

      describe('one writer per device: a stale writer gets conflict', () => {
        it('refuses a write from a writer that read an older version, and keeps the newer value', async () => {
          const tabA = await factory();
          const tabB = await secondWriter(tabA);
          await tabA.set(CONTRACT_KEY, Uint8Array.of(1), 'history');
          expect(await read(tabB, CONTRACT_KEY)).toEqual([1]);

          await tabA.set(CONTRACT_KEY, Uint8Array.of(2), 'history');
          expect(
            await secureStorageOutcome(tabB.set(CONTRACT_KEY, Uint8Array.of(3), 'history')),
          ).toBe('conflict');
          expect(await read(tabA, CONTRACT_KEY)).toEqual([2]);

          // Having read the newer version, the same writer may write again.
          expect(await read(tabB, CONTRACT_KEY)).toEqual([2]);
          await tabB.set(CONTRACT_KEY, Uint8Array.of(3), 'history');
          expect(await read(tabA, CONTRACT_KEY)).toEqual([3]);
        });

        it('refuses a stale write over a key another writer deleted or cleared', async () => {
          const tabA = await factory();
          const tabB = await secondWriter(tabA);
          await tabA.set(CONTRACT_KEY, Uint8Array.of(1), 'identity');
          await tabA.set(OTHER_KEY, Uint8Array.of(1), 'identity');
          expect(await read(tabB, CONTRACT_KEY)).toEqual([1]);
          expect(await read(tabB, OTHER_KEY)).toEqual([1]);

          await tabA.delete(CONTRACT_KEY);
          await tabA.clear('');
          expect(
            await secureStorageOutcome(tabB.set(CONTRACT_KEY, Uint8Array.of(2), 'identity')),
          ).toBe('conflict');
          expect(
            await secureStorageOutcome(tabB.set(OTHER_KEY, Uint8Array.of(2), 'identity')),
          ).toBe('conflict');
          expect(await tabA.get(CONTRACT_KEY)).toBeNull();
        });
      });
    }
  });
}
