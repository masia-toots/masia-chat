/** Small helpers shared by the page and the Worker: statistics, timing, scenario results, progress. */

export interface Stats {
  readonly n: number;
  readonly min: number;
  readonly median: number;
  /** Nearest-rank 95th percentile. With few samples (5) it is the maximum, on purpose. */
  readonly p95: number;
  readonly max: number;
  readonly mean: number;
  /** In the order they were taken, so a cold first sample is visible. */
  readonly samples: readonly number[];
}

const PERCENTILE_95 = 0.95;
const DECIMALS = 100;

const round = (value: number): number => Math.round(value * DECIMALS) / DECIMALS;

export function statsOf(samples: readonly number[]): Stats {
  const sorted = [...samples].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) throw new Error('statsOf: no samples');
  const at = (index: number): number => sorted[index] ?? Number.NaN;
  const middle = Math.floor(n / 2);
  const median = n % 2 === 1 ? at(middle) : (at(middle - 1) + at(middle)) / 2;
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    n,
    min: round(at(0)),
    median: round(median),
    p95: round(at(Math.max(0, Math.ceil(PERCENTILE_95 * n) - 1))),
    max: round(at(n - 1)),
    mean: round(total / n),
    samples: samples.map(round),
  };
}

/** Runs `action` and returns how long it took (milliseconds) next to what it returned. */
export async function timeIt<T>(action: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const started = performance.now();
  const value = await action();
  return { ms: performance.now() - started, value };
}

/** One sample per call of `action`, in milliseconds. */
export async function sampleMs(count: number, action: (index: number) => Promise<void>): Promise<Stats> {
  const samples: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const { ms } = await timeIt(() => action(i));
    samples.push(ms);
  }
  return statsOf(samples);
}

export interface ScenarioResult {
  readonly name: string;
  readonly ok: boolean;
  readonly ms: number;
  readonly error?: string;
  /** Wall time of each named step, in milliseconds. */
  readonly steps: Readonly<Record<string, number>>;
  readonly detail: Readonly<Record<string, unknown>>;
}

export interface ScenarioContext {
  /** Runs one named step and records how long it took. */
  step<T>(name: string, action: () => Promise<T>): Promise<T>;
  /** Records a fact about the run (sizes, counts). */
  note(key: string, value: unknown): void;
}

const STACK_LINES = 6;

export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    const head = `${error.name}${typeof code === 'string' ? `(${code})` : ''}: ${error.message}`;
    const stack = (error.stack ?? '').split('\n').slice(0, STACK_LINES).join(' | ');
    return stack === '' ? head : `${head} @ ${stack}`;
  }
  return String(error);
}

let progressSink: (line: string) => void = () => undefined;

export function setProgressSink(sink: (line: string) => void): void {
  progressSink = sink;
}

export function progress(line: string): void {
  progressSink(line);
}

/** Runs a scenario body; any throw (including a failed expectation) becomes a failed result, never an escape. */
export async function scenario(
  name: string,
  body: (context: ScenarioContext) => Promise<void>,
): Promise<ScenarioResult> {
  const steps: Record<string, number> = {};
  const detail: Record<string, unknown> = {};
  const context: ScenarioContext = {
    async step(stepName, action) {
      const { ms, value } = await timeIt(action);
      steps[stepName] = round(ms);
      return value;
    },
    note(key, value) {
      detail[key] = value;
    },
  };
  progress(`start ${name}`);
  const started = performance.now();
  try {
    await body(context);
    const ms = round(performance.now() - started);
    progress(`ok    ${name} (${ms} ms)`);
    return { name, ok: true, ms, steps, detail };
  } catch (error) {
    const ms = round(performance.now() - started);
    progress(`FAIL  ${name}: ${describeError(error)}`);
    return { name, ok: false, ms, error: describeError(error), steps, detail };
  }
}

export const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
export const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
