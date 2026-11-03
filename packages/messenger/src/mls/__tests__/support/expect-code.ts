import { expect } from 'vitest';
import type { MlsEngineErrorCode } from '../../mls-error.js';

/**
 * Runs `action` and demands it throws an `MlsEngineError` with exactly `code`. A different code, a
 * different error type (the engine promises `MlsEngineError` and nothing else) or no error at all
 * fails the test with the reason. Works for sync and async actions, on any `MlsEngine`.
 */
export async function expectCode(action: () => unknown, code: MlsEngineErrorCode): Promise<void> {
  let thrown: unknown;
  try {
    await action();
  } catch (error) {
    thrown = error;
  }
  if (thrown === undefined) {
    expect.fail(`expected ${code}, but nothing was thrown`);
  }
  const named = thrown as { name?: unknown; code?: unknown; message?: unknown };
  if (named.name !== 'MlsEngineError') {
    expect.fail(
      `expected MlsEngineError(${code}), got ${String(named.name)}: ${String(named.message)}`,
    );
  }
  expect(named.code, `the error was: ${String(named.message)}`).toBe(code);
}

/** The error an action throws, for tests that look at more than the code. */
export async function thrownBy(action: () => unknown): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }
  return undefined;
}

/** Demands an `MlsEngineError` whose code does not matter (for inputs where only "refused, and cleanly" is the contract). */
export async function expectAnyEngineError(action: () => unknown): Promise<void> {
  const thrown = await thrownBy(action);
  if (thrown === undefined) expect.fail('expected an MlsEngineError, but nothing was thrown');
  const named = thrown as { name?: unknown; message?: unknown };
  if (named.name !== 'MlsEngineError') {
    expect.fail(`expected MlsEngineError, got ${String(named.name)}: ${String(named.message)}`);
  }
}

/**
 * Runs `action` and returns whether it was refused. The only way it may fail is with an
 * `MlsEngineError`: any other throw (TypeError, RangeError, a library error escaping) fails the test
 * with what was thrown. For fuzzing, where the input is garbage and the contract is "refuse cleanly".
 */
export async function refusedCleanly(action: () => unknown): Promise<boolean> {
  const thrown = await thrownBy(action);
  if (thrown === undefined) return false;
  const named = thrown as { name?: unknown; message?: unknown };
  if (named.name !== 'MlsEngineError') {
    expect.fail(
      `only MlsEngineError may escape the engine, got ${String(named.name)}: ${String(named.message)}`,
    );
  }
  return true;
}
