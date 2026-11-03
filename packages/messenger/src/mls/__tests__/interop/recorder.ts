import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { MlsEngineError, type MlsEngineErrorCode } from '../../mls-engine.js';

/**
 * What the interop run writes down. A scenario is a list of CHECKS; a check is one question put to
 * one side ("does our engine refuse this?", "does OpenMLS accept that?") with the exact answer. The
 * matrix in `results.json` is these records, so a FAIL carries the error text as the library words it.
 */

export type Outcome = 'PASS' | 'FAIL' | 'NOT-TRIGGERABLE';

export interface CheckRecord {
  readonly name: string;
  readonly outcome: Outcome;
  /** What was expected, when the check is a refusal. */
  readonly expected?: string;
  /** What actually happened, verbatim for an error. */
  readonly observed: string;
}

export interface ScenarioRecord {
  readonly id: string;
  readonly title: string;
  readonly outcome: Outcome;
  readonly ms: number;
  readonly checks: readonly CheckRecord[];
  readonly notes: readonly string[];
  readonly error?: string;
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message.split('\n')[0] ?? error.message;
  return String(error);
}

export class Scenario {
  readonly checks: CheckRecord[] = [];
  readonly notes: string[] = [];
  private crashed: string | undefined;
  private readonly startedAt = Date.now();

  constructor(
    readonly id: string,
    readonly title: string,
  ) {}

  pass(name: string, observed = 'ok'): void {
    this.checks.push({ name, outcome: 'PASS', observed });
  }

  fail(name: string, expected: string | undefined, observed: string): void {
    this.checks.push({
      name,
      outcome: 'FAIL',
      ...(expected === undefined ? {} : { expected }),
      observed,
    });
  }

  notTriggerable(name: string, observed: string): void {
    this.checks.push({ name, outcome: 'NOT-TRIGGERABLE', observed });
  }

  note(text: string): void {
    this.notes.push(text);
  }

  /** The step threw: the scenario is a FAIL with that error. */
  crash(error: unknown): void {
    this.crashed = describeError(error);
  }

  /** Runs `thunk`; it must not throw. */
  async accepted(name: string, thunk: () => Promise<unknown>): Promise<void> {
    try {
      await thunk();
      this.pass(name, 'accepted');
    } catch (error) {
      this.fail(name, 'accepted', describeError(error));
    }
  }

  /** Runs `thunk`; it must throw an `MlsEngineError` whose code is one of `expected`. */
  async refusal(
    name: string,
    expected: MlsEngineErrorCode | readonly MlsEngineErrorCode[],
    thunk: () => Promise<unknown>,
  ): Promise<MlsEngineErrorCode | undefined> {
    const wanted = typeof expected === 'string' ? [expected] : expected;
    const label = wanted.join(' | ');
    try {
      await thunk();
    } catch (error) {
      if (error instanceof MlsEngineError) {
        if (wanted.includes(error.code)) this.pass(name, error.message);
        else this.fail(name, label, error.message);
        return error.code;
      }
      this.fail(name, label, `not an MlsEngineError: ${describeError(error)}`);
      return undefined;
    }
    this.fail(name, label, 'accepted (no error)');
    return undefined;
  }

  failures(): readonly CheckRecord[] {
    return this.checks.filter((check) => check.outcome === 'FAIL');
  }

  record(): ScenarioRecord {
    const failed = this.crashed !== undefined || this.failures().length > 0;
    const allUntriggerable =
      this.checks.length > 0 && this.checks.every((check) => check.outcome === 'NOT-TRIGGERABLE');
    const outcome: Outcome = failed ? 'FAIL' : allUntriggerable ? 'NOT-TRIGGERABLE' : 'PASS';
    return {
      id: this.id,
      title: this.title,
      outcome,
      ms: Date.now() - this.startedAt,
      checks: this.checks,
      notes: this.notes,
      ...(this.crashed === undefined ? {} : { error: this.crashed }),
    };
  }
}

/** Everything one run learned, written once at the end. */
export class RunLog {
  readonly scenarios: ScenarioRecord[] = [];
  readonly findings: string[] = [];

  add(record: ScenarioRecord): void {
    this.scenarios.push(record);
  }

  finding(text: string): void {
    if (!this.findings.includes(text)) this.findings.push(text);
  }

  write(path: string, extra: Readonly<Record<string, unknown>> = {}): void {
    mkdirSync(dirname(path), { recursive: true });
    const sorted = [...this.scenarios].sort((a, b) => a.id.localeCompare(b.id, 'en'));
    writeFileSync(
      path,
      `${JSON.stringify({ ...extra, scenarios: sorted, findings: this.findings }, null, 2)}\n`,
      'utf8',
    );
  }
}
