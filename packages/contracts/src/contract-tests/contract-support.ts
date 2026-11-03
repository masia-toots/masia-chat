import { isSecureStorageError, type SecureStorageErrorKind } from '../ports/secure-storage.js';

/**
 * How a contract suite obtains the implementation under test: a fresh one per assertion, so no
 * test depends on another's state (and on execution order).
 */
export type ContractFactory<T> = () => Promise<T> | T;

/** One title format for every suite, so a failing line names the port AND the implementation. */
export function contractTitle(port: string, implementation: string): string {
  return `${port} contract: ${implementation}`;
}

/** Bytes as plain numbers, so equality does not depend on Buffer vs Uint8Array identity. */
export function bytesToNumbers(bytes: Uint8Array): number[] {
  return Array.from(bytes);
}

/**
 * What a `SecureStorage` call settled as: `'resolved'`, or the `kind` of the `SecureStorageError` it
 * rejected with. Anything else it rejects with is rethrown, so a test cannot mistake a stray `Error`
 * for one of the port's kinds. Shared by this package's suite and the hosts' own adapter tests.
 */
export async function secureStorageOutcome(
  promise: Promise<unknown>,
): Promise<SecureStorageErrorKind | 'resolved'> {
  try {
    await promise;
    return 'resolved';
  } catch (error) {
    if (isSecureStorageError(error)) return error.kind;
    throw error;
  }
}
