/**
 * A stand-in for `vitest`, just big enough for the shared test support (`TestWorld`, `Room`,
 * `expectCode`, `expectRefusedEverywhere`), which the bench bundles unchanged. Vite aliases the
 * import `vitest` to this file, so the support code runs in a browser page without a test runner.
 *
 * Only what the support code calls exists: `expect(actual, message?).toBe / .toEqual` and
 * `expect.fail`. A failed expectation throws `ExpectationError`, which the bench reports as a
 * failed scenario (and which the engine's own `MlsEngineError` is never mistaken for).
 */

export class ExpectationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExpectationError';
  }
}

function show(value: unknown): string {
  if (value instanceof Uint8Array) return `Uint8Array(${value.length})`;
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'string') return JSON.stringify(value);
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    return a.length === b.length && a.every((byte, i) => byte === b[i]);
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  }
  if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    return (
      keysA.length === keysB.length &&
      keysA.every((key) =>
        deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
      )
    );
  }
  return false;
}

function assertion(actual: unknown, message?: string) {
  const because = message === undefined ? '' : ` (${message})`;
  return {
    toBe(expected: unknown): void {
      if (!Object.is(actual, expected)) {
        throw new ExpectationError(`expected ${show(actual)} to be ${show(expected)}${because}`);
      }
    },
    toEqual(expected: unknown): void {
      if (!deepEqual(actual, expected)) {
        throw new ExpectationError(
          `expected ${show(actual)} to equal ${show(expected)}${because}`,
        );
      }
    },
  };
}

function fail(message?: string): never {
  throw new ExpectationError(message ?? 'expect.fail()');
}

export const expect = Object.assign(assertion, { fail });
