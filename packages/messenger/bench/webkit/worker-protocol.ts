import type { CurveMode } from './curves.js';
import type { Violation, WasmCall } from './instrument.js';
import type { PerfResult } from './perf.js';
import type { ControlResult, RoundTripProbe } from './probes.js';
import type { ScenarioResult } from './util.js';

/** What the module Worker tells the page. The page only ever reads these shapes. */

export interface WorkerEnv {
  readonly userAgent: string;
  readonly isSecureContext: boolean;
  readonly crossOriginIsolated: boolean;
  readonly subtleDefined: boolean;
  readonly sharedArrayBufferDefined: boolean;
  readonly webAssemblyDefined: boolean;
}

export interface WorkerRun {
  readonly env: WorkerEnv;
  /** Whether the Worker's own `crypto.subtle` had the curves or the bench stand-in was installed there. */
  readonly curves: CurveMode;
  /** What one WebCrypto round trip costs on the Worker's thread (measured before the stand-in goes in). */
  readonly roundTrip: RoundTripProbe;
  /** A group of 5 through the whole lifecycle. */
  readonly lifecycle: ScenarioResult;
  /** A group of 50, when the page asked for it. */
  readonly lifecycleBig?: ScenarioResult;
  /** The performance probes, when the page asked for them. */
  readonly perf?: PerfResult;
  /** eval / Function / WebAssembly.compile attempted INSIDE the Worker: did the policy follow it there? */
  readonly controls: readonly ControlResult[];
  readonly engineViolations: readonly Violation[];
  readonly engineWasmCalls: readonly WasmCall[];
}

export type WorkerMessage =
  | { readonly type: 'booted'; readonly env: WorkerEnv }
  | { readonly type: 'progress'; readonly line: string }
  | { readonly type: 'done'; readonly run: WorkerRun }
  | { readonly type: 'error'; readonly error: string };

/** What the page asks the Worker to run once it has said it booted. */
export interface RunRequest {
  readonly type: 'run';
  /** Run the performance probes (a group of 50 is built and measured). */
  readonly perf: boolean;
  /** Run the lifecycle in a group of 50 as well as the one of 5. */
  readonly bigLifecycle: boolean;
}

export const isRunRequest = (data: unknown): data is RunRequest =>
  typeof data === 'object' && data !== null && (data as { type?: unknown }).type === 'run';
