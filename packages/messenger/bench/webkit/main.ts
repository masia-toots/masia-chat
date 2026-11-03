// The instrumentation must be evaluated before the engine: keep this import first.
import './instrument.js';
import { CURVES_FORCED, CURVES_QUERY, curveStats, ensureCurves, subtleStats, type CurveMode } from './curves.js';
import { setPhase, violations, wasmCalls, type Violation, type WasmCall } from './instrument.js';
import { runAttacks } from './attacks.js';
import { LIFECYCLE_SIZES, runLifecycle } from './lifecycle.js';
import { ADD_BUDGET_MS, runPerf, type PerfResult } from './perf.js';
import {
  probeCrypto,
  probeEnv,
  probeRoundTrip,
  runCspControls,
  type ControlResult,
  type CryptoProbe,
  type EnvProbe,
  type RoundTripProbe,
} from './probes.js';
import { describeError, progress, setProgressSink, type ScenarioResult } from './util.js';
import workerUrl from './worker.ts?worker&url';
import type { RunRequest, WorkerEnv, WorkerMessage, WorkerRun } from './worker-protocol.js';
import './style.css';

/**
 * The MLS engine bench page. It bundles `@masia/messenger/mls` with the contract suite's in-memory
 * test support and runs, under a strict CSP (`default-src 'self'; script-src 'self'`, see index.html):
 * environment and WebCrypto probes; the performance probes (cold, and again warm at the end); the
 * lifecycle in groups of 2, 5 and 50; a handful of attack checks and a short seeded fuzz; a module
 * Worker that carries the engine too; and the CSP controls that prove the policy is in force.
 *
 * Everything is reported as one JSON object on `window.__results` (and on the console). The page
 * sets `done` last; a crash sets `fatal` and `done` so a runner never waits for nothing.
 */

const WORKER_TIMEOUT_MS = 1_800_000;
const HEARTBEAT_MS = 10_000;
/** On a page thread that stalls, the page itself runs groups up to this size; the Worker runs the big ones. */
const STALLED_PAGE_MAX_GROUP = 5;
/** The full Worker run (lifecycle in 50, performance probes) and the light one (policy and boot only). */
const WORKER_FULL: RunRequest = { type: 'run', perf: true, bigLifecycle: true };
const WORKER_LIGHT: RunRequest = { type: 'run', perf: false, bigLifecycle: false };
/** `?nocsp=1` on the Worker script: the server then leaves the policy header off that one response. */
const NO_WORKER_CSP_QUERY = 'nocsp';

export interface WorkerProbe {
  /** Did `new Worker(url, { type: 'module' })` run the script (did it say it booted)? */
  readonly loaded: boolean;
  readonly bootMs?: number;
  readonly error?: string;
  /** Whether the server sent the strict policy as a header on the Worker script. */
  readonly policyHeaderOnScript: boolean;
  readonly env?: WorkerEnv;
  readonly run?: WorkerRun;
}

export interface Gates {
  readonly scenariosPass: boolean;
  readonly engineCspViolations: number;
  readonly engineWasmCalls: number;
  readonly evalBlockedByPolicy: boolean;
  readonly subtleDefined: boolean;
  readonly algorithmsOk: boolean;
  /** Did this browser's own WebCrypto have Ed25519 and X25519? When not, the bench ran a stand-in for them. */
  readonly nativeCurves: boolean;
  readonly curveSelfTestOk: boolean;
  /**
   * The figure the budget is judged on: the worst p95 over every performance run that took place
   * (page cold, page warm, Worker), with the stand-in's cost taken out (equal to the measured one
   * with native curves). When the page's own thread stalls on WebCrypto, only the Worker's run counts.
   */
  readonly addGroup50P95Ms: number;
  /** Which runs the figure above is the worst of: `page-cold`, `page-warm`, `worker`. */
  readonly addGroup50Sources: readonly string[];
  /** The page's thread pays a timer tick per WebCrypto round trip (a platform artifact, see canon section 8). */
  readonly pageThreadStalls: boolean;
  /** The same, as measured, stand-in included. */
  readonly addGroup50MeasuredP95Ms: number;
  readonly addGroup50BudgetMs: number;
  readonly addGroup50WithinBudget: boolean;
  /** Informational: does not fail the run. */
  readonly moduleWorkerLoadsUnderPolicy: boolean;
  readonly pass: boolean;
  readonly failures: readonly string[];
}

export interface BenchResults {
  schema: 1;
  done: boolean;
  fatal?: string;
  startedAt: string;
  finishedAt?: string;
  policy: string;
  env?: EnvProbe;
  /** What the browser's own WebCrypto does, probed before any stand-in is installed. */
  crypto?: CryptoProbe;
  /** The same probe after the curve stand-in was installed (the same object when none was needed). */
  cryptoEffective?: CryptoProbe;
  curves?: CurveMode & { standInOps: number; standInBusyMs: number };
  /** Every WebCrypto call the page's engine made (the Worker's are counted in its own run). */
  subtle?: { calls: number; byMethod: Record<string, number> };
  /** WebCrypto round-trip latency on the page's thread, measured before any stand-in. */
  roundTrip?: RoundTripProbe;
  /** Phases the page did not run itself, and why (the Worker ran them where it could). */
  skipped: { phase: string; reason: string }[];
  perf: { cold?: PerfResult; warm?: PerfResult };
  lifecycle: ScenarioResult[];
  attacks: ScenarioResult[];
  worker?: { withPolicyHeader: WorkerProbe; withoutPolicyHeader: WorkerProbe };
  csp: {
    controls: ControlResult[];
    engineViolations: Violation[];
    allViolations: Violation[];
    engineWasmCalls: WasmCall[];
    resources: string[];
  };
  gates?: Gates;
}

declare global {
  interface Window {
    __results?: BenchResults;
    __progress?: string;
  }
}

function policyOfDocument(): string {
  const meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
  return meta?.getAttribute('content') ?? '(no policy meta tag)';
}

function workerScriptUrl(withPolicyHeader: boolean): string {
  const query = new URLSearchParams();
  if (!withPolicyHeader) query.set(NO_WORKER_CSP_QUERY, '1');
  if (curvesForced()) query.set(CURVES_QUERY, CURVES_FORCED);
  const text = query.toString();
  return text === '' ? workerUrl : `${workerUrl}?${text}`;
}

const curvesForced = (): boolean => new URLSearchParams(location.search).get(CURVES_QUERY) === CURVES_FORCED;

function runWorker(withPolicyHeader: boolean, request: RunRequest): Promise<WorkerProbe> {
  const url = workerScriptUrl(withPolicyHeader);
  const policyHeaderOnScript = withPolicyHeader;
  return new Promise((resolve) => {
    const started = performance.now();
    let booted: WorkerEnv | undefined;
    let bootMs: number | undefined;
    let worker: Worker;
    try {
      worker = new Worker(url, { type: 'module' });
    } catch (error) {
      resolve({ loaded: false, error: describeError(error), policyHeaderOnScript });
      return;
    }
    const timer = setTimeout(() => {
      worker.terminate();
      resolve({
        loaded: booted !== undefined,
        ...(bootMs === undefined ? {} : { bootMs }),
        error: `timed out after ${WORKER_TIMEOUT_MS} ms`,
        policyHeaderOnScript,
        ...(booted === undefined ? {} : { env: booted }),
      });
    }, WORKER_TIMEOUT_MS);
    worker.onerror = (event) => {
      clearTimeout(timer);
      worker.terminate();
      resolve({
        loaded: booted !== undefined,
        ...(bootMs === undefined ? {} : { bootMs }),
        error: `worker error event: ${event.message || '(no message)'} ${event.filename ?? ''}`,
        policyHeaderOnScript,
        ...(booted === undefined ? {} : { env: booted }),
      });
    };
    worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      const message = event.data;
      if (message.type === 'booted') {
        booted = message.env;
        bootMs = Math.round(performance.now() - started);
        progress(`worker booted in ${bootMs} ms (policy header on script: ${policyHeaderOnScript})`);
        worker.postMessage(request);
      } else if (message.type === 'progress') {
        progress(`worker (policy header ${policyHeaderOnScript}): ${message.line}`);
      } else if (message.type === 'done') {
        clearTimeout(timer);
        worker.terminate();
        resolve({
          loaded: true,
          bootMs: bootMs ?? 0,
          policyHeaderOnScript,
          env: message.run.env,
          run: message.run,
        });
      } else {
        clearTimeout(timer);
        worker.terminate();
        resolve({
          loaded: true,
          ...(bootMs === undefined ? {} : { bootMs }),
          error: message.error,
          policyHeaderOnScript,
          ...(booted === undefined ? {} : { env: booted }),
        });
      }
    };
  });
}

function evaluateGates(results: BenchResults): Gates {
  const failures: string[] = [];
  const workerRuns = [results.worker?.withPolicyHeader, results.worker?.withoutPolicyHeader]
    .flatMap((probe) => [probe?.run?.lifecycle, probe?.run?.lifecycleBig])
    .filter((scenario): scenario is ScenarioResult => scenario !== undefined);
  const scenarios = [...results.lifecycle, ...results.attacks, ...workerRuns];
  const failed = scenarios.filter((s) => !s.ok);
  for (const s of failed) failures.push(`scenario failed: ${s.name}`);
  for (const size of LIFECYCLE_SIZES) {
    if (!scenarios.some((s) => s.name === `lifecycle: group of ${size}`)) {
      failures.push(`the lifecycle in a group of ${size} did not run anywhere (page or Worker)`);
    }
  }
  const worker = results.worker?.withPolicyHeader;
  if (worker?.error !== undefined && worker.loaded) failures.push(`worker run failed: ${worker.error}`);

  const engineCspViolations = results.csp.engineViolations.length;
  if (engineCspViolations > 0) failures.push(`${engineCspViolations} CSP violation(s) during engine phases`);
  const engineWasmCalls = results.csp.engineWasmCalls.length;
  if (engineWasmCalls > 0) failures.push(`${engineWasmCalls} WebAssembly call(s) during engine phases`);

  const evalControl = results.csp.controls.find((c) => c.name.startsWith('eval('));
  const evalBlockedByPolicy = evalControl?.blocked === true;
  if (!evalBlockedByPolicy) failures.push('the CSP did not block eval: the run proves nothing about the policy');

  const subtleDefined = results.crypto?.subtleDefined === true;
  if (!subtleDefined) failures.push('crypto.subtle is not available');
  const effective = results.cryptoEffective ?? results.crypto;
  const algorithmsOk = (effective?.algorithms ?? []).every((a) => a.ok) && subtleDefined;
  if (subtleDefined && !algorithmsOk) failures.push('a WebCrypto algorithm of suite 1 failed its probe');
  const nativeCurves = results.curves?.nativeEd25519 === true && results.curves.nativeX25519 === true;
  const curveSelfTest = results.curves?.selfTest ?? [];
  const curveSelfTestOk = curveSelfTest.length > 0 && curveSelfTest.every((t) => t.ok);
  if (subtleDefined && !curveSelfTestOk) failures.push('the curve stand-in failed its known-answer tests');

  const labelled: [string, PerfResult | undefined][] = [
    ['page-cold', results.perf.cold],
    ['page-warm', results.perf.warm],
    ['worker', worker?.run?.perf],
  ];
  const taken = labelled.filter((entry): entry is [string, PerfResult] => entry[1] !== undefined);
  const addGroup50Sources = taken.map(([label]) => label);
  const worst = (pick: (perf: PerfResult) => number): number =>
    taken.length === 0 ? Number.POSITIVE_INFINITY : Math.max(...taken.map(([, perf]) => pick(perf)));
  const addGroup50MeasuredP95Ms = worst((perf) => perf.addGroup50.p95);
  const addGroup50P95Ms = worst((perf) => perf.adjusted.addGroup50.stats.p95);
  const addGroup50WithinBudget = addGroup50P95Ms <= ADD_BUDGET_MS;
  if (!addGroup50WithinBudget) {
    failures.push(`Add in a group of 50: p95 ${addGroup50P95Ms} ms > ${ADD_BUDGET_MS} ms (${addGroup50Sources.join(', ')})`);
  }
  const pageThreadStalls = results.roundTrip?.stalled === true;

  return {
    scenariosPass: failed.length === 0,
    engineCspViolations,
    engineWasmCalls,
    evalBlockedByPolicy,
    subtleDefined,
    algorithmsOk,
    nativeCurves,
    curveSelfTestOk,
    addGroup50P95Ms,
    addGroup50Sources,
    pageThreadStalls,
    addGroup50MeasuredP95Ms,
    addGroup50BudgetMs: ADD_BUDGET_MS,
    addGroup50WithinBudget,
    moduleWorkerLoadsUnderPolicy: worker?.loaded === true && worker.error === undefined,
    pass: failures.length === 0,
    failures,
  };
}

// --- The page: a plain table of what was found ------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className !== undefined) node.className = className;
  return node;
}

function row(table: HTMLTableElement, cells: readonly string[], className?: string): void {
  const tr = el('tr', undefined, className);
  for (const cell of cells) tr.append(el('td', cell));
  table.append(tr);
}

const ms = (value: number): string => `${value.toFixed(1)}`;

function render(results: BenchResults): void {
  const host = document.getElementById('report');
  if (host === null) return;
  host.replaceChildren();
  const gates = results.gates;
  host.append(
    el('h2', gates === undefined ? 'running' : gates.pass ? 'PASS' : 'FAIL', gates?.pass ? 'pass' : 'fail'),
  );
  if (gates !== undefined && gates.failures.length > 0) {
    const list = el('ul');
    for (const failure of gates.failures) list.append(el('li', failure, 'fail'));
    host.append(list);
  }
  const facts = el('table');
  row(facts, ['policy', results.policy]);
  row(facts, ['user agent', results.env?.userAgent ?? '?']);
  row(facts, ['secure context / crypto.subtle', `${results.env?.isSecureContext} / ${results.crypto?.subtleDefined}`]);
  row(facts, ['cross-origin isolated / SharedArrayBuffer', `${results.env?.crossOriginIsolated} / ${results.env?.sharedArrayBuffer.defined}`]);
  row(facts, ['timer resolution (ms)', String(results.env?.timerResolutionMs)]);
  row(facts, ['engine CSP violations / WASM calls', `${gates?.engineCspViolations ?? '?'} / ${gates?.engineWasmCalls ?? '?'}`]);
  const curves = results.curves;
  row(facts, [
    'Ed25519 + X25519',
    curves === undefined
      ? '?'
      : curves.mode === 'native'
        ? 'native WebCrypto'
        : `NOT in this browser: bench stand-in (${curves.standInOps} ops, ${curves.standInBusyMs} ms inside it)`,
  ]);
  const worker = results.worker?.withPolicyHeader;
  row(facts, ['module Worker under the policy', worker === undefined ? '?' : worker.loaded ? `loaded in ${worker.bootMs} ms` : `FAILED: ${worker.error}`]);
  const trip = (probe: RoundTripProbe | undefined): string =>
    probe === undefined ? '?' : `${probe.meanPerCallMs} ms per call${probe.stalled ? ' (STALLS: a timer tick each)' : ''}`;
  row(facts, ['WebCrypto round trip, page / Worker', `${trip(results.roundTrip)} / ${trip(worker?.run?.roundTrip)}`]);
  for (const skip of results.skipped) row(facts, [`page skipped ${skip.phase}`, skip.reason]);
  host.append(facts);

  const scenarios = el('table');
  row(scenarios, ['scenario', 'result', 'ms'], 'head');
  const inWorker = [worker?.run?.lifecycle, worker?.run?.lifecycleBig]
    .filter((s): s is ScenarioResult => s !== undefined)
    .map((s) => ({ ...s, name: `(Worker) ${s.name}` }));
  for (const s of [...results.lifecycle, ...results.attacks, ...inWorker]) {
    row(scenarios, [s.name, s.ok ? 'pass' : `FAIL ${s.error ?? ''}`, ms(s.ms)], s.ok ? 'ok' : 'fail');
  }
  host.append(el('h3', 'Scenarios'), scenarios);

  const perf = el('table');
  row(perf, ['probe (ms)', 'page cold median', 'p95', 'page warm median', 'p95', 'Worker median', 'p95'], 'head');
  const entries: [string, (p: PerfResult) => { median: number; p95: number }][] = [
    ['Add in a group of 50 (committer)', (p) => p.addGroup50],
    ['Add: one receiver processes', (p) => p.addProcessOneReceiver],
    ['Add: critical path (create + one receiver)', (p) => p.addCriticalPath],
    ['Welcome join (group of 51)', (p) => p.joinFromWelcome],
    ['self-update create', (p) => p.selfUpdateCreate],
    ['self-update process', (p) => p.selfUpdateProcess],
    ['encrypt 4 KB', (p) => p.encrypt4KB],
    ['decrypt 4 KB', (p) => p.decrypt4KB],
  ];
  const runs = [results.perf.cold, results.perf.warm, worker?.run?.perf];
  for (const [label, pick] of entries) {
    const cells = [label];
    for (const run of runs) {
      cells.push(run === undefined ? '-' : ms(pick(run).median), run === undefined ? '-' : ms(pick(run).p95));
    }
    row(perf, cells);
  }
  if (curves?.mode === 'polyfill') {
    const cells = ['Add in a group of 50, stand-in cost taken out'];
    for (const run of runs) {
      const adjusted = run?.adjusted.addGroup50;
      cells.push(adjusted === undefined ? '-' : ms(adjusted.stats.median), adjusted === undefined ? '-' : ms(adjusted.stats.p95));
    }
    row(perf, cells);
  }
  host.append(el('h3', `Performance (budget: Add in a group of 50 under ${ADD_BUDGET_MS} ms)`), perf);

  const controls = el('table');
  row(controls, ['CSP control', 'refused by the policy', 'detail'], 'head');
  for (const c of results.csp.controls) row(controls, [c.name, String(c.blocked), c.detail]);
  host.append(el('h3', 'CSP controls (expected to be refused)'), controls);
}

async function main(): Promise<void> {
  const results: BenchResults = {
    schema: 1,
    done: false,
    startedAt: new Date().toISOString(),
    policy: policyOfDocument(),
    skipped: [],
    perf: {},
    lifecycle: [],
    attacks: [],
    csp: { controls: [], engineViolations: [], allViolations: [], engineWasmCalls: [], resources: [] },
  };
  window.__results = results;
  const status = document.getElementById('status');
  setProgressSink((line) => {
    window.__progress = line;
    console.log(`[progress] ${line}`);
    if (status !== null) status.textContent = line;
  });

  // A page that is busy for minutes should still say what it is doing (the runner's console log keeps it).
  const heartbeat = setInterval(
    () => console.log(`[beat] ${window.__progress ?? ''} | webcrypto calls ${subtleStats.calls}, stand-in ops ${curveStats.ops}`),
    HEARTBEAT_MS,
  );
  try {
    setPhase('probe');
    results.env = probeEnv();
    results.crypto = await probeCrypto();
    console.log(`[env] ${JSON.stringify(results.env)}`);
    console.log(`[crypto] ${JSON.stringify(results.crypto)}`);

    // How long does one WebCrypto round trip take on this thread? The engine makes about a thousand per
    // Add, so a thread that pays a timer tick for each cannot be measured in a sensible time (Playwright's
    // Windows WebKit does; its Workers do not). Measured on the browser's own WebCrypto, before any stand-in.
    results.roundTrip = await probeRoundTrip('page');
    console.log(`[roundtrip] ${JSON.stringify(results.roundTrip)}`);
    const pageStalls = results.roundTrip.stalled;

    // Some WebKit builds (Playwright's Windows one) have no Ed25519 / X25519 in WebCrypto: a stand-in
    // goes in, ahead of the first engine call, and every figure below says so. Safari 17+ has both.
    const curves = await ensureCurves(curvesForced());
    results.curves = { ...curves, standInOps: 0, standInBusyMs: 0 };
    results.cryptoEffective = curves.mode === 'polyfill' ? await probeCrypto() : results.crypto;
    console.log(`[curves] ${JSON.stringify(curves)}`);

    const stallReason = `the page thread pays ${results.roundTrip.meanPerCallMs} ms per WebCrypto call (a timer tick), the Worker ran it`;
    setPhase('perf-cold');
    if (pageStalls) results.skipped.push({ phase: 'perf-cold', reason: stallReason });
    else results.perf.cold = await runPerf('cold');

    setPhase('lifecycle');
    for (const size of LIFECYCLE_SIZES) {
      if (pageStalls && size > STALLED_PAGE_MAX_GROUP) {
        results.skipped.push({ phase: `lifecycle: group of ${size}`, reason: stallReason });
      } else {
        results.lifecycle.push(await runLifecycle(size));
      }
    }

    setPhase('attacks');
    results.attacks = await runAttacks();

    setPhase('worker');
    results.worker = {
      withPolicyHeader: await runWorker(true, WORKER_FULL),
      withoutPolicyHeader: await runWorker(false, WORKER_LIGHT),
    };

    setPhase('perf-warm');
    if (pageStalls) results.skipped.push({ phase: 'perf-warm', reason: stallReason });
    else results.perf.warm = await runPerf('warm');

    results.csp.controls = await runCspControls();
    setPhase('done');
  } catch (error) {
    results.fatal = describeError(error);
    console.error(`[fatal] ${results.fatal}`);
  }

  try {
    await new Promise<void>((resolve) => setTimeout(resolve, 100)); // let late violation events land
    results.csp.engineViolations = violations.filter((v) => v.phase !== 'csp-control');
    results.csp.allViolations = [...violations];
    results.csp.engineWasmCalls = wasmCalls.filter((c) => c.phase !== 'csp-control');
    results.csp.resources = performance.getEntriesByType('resource').map((entry) => entry.name);
    if (results.curves !== undefined) {
      results.curves = { ...results.curves, standInOps: curveStats.ops, standInBusyMs: Math.round(curveStats.busyMs) };
    }
    results.subtle = { calls: subtleStats.calls, byMethod: { ...subtleStats.byMethod } };
    results.gates = evaluateGates(results);
    results.finishedAt = new Date().toISOString();
    render(results);
    console.log(`[gates] ${JSON.stringify(results.gates)}`);
    console.log(`__results__ ${JSON.stringify(results)}`);
  } catch (error) {
    results.fatal = `${results.fatal ?? ''} report: ${describeError(error)}`.trim();
  } finally {
    clearInterval(heartbeat);
    results.done = true; // last, and always: a runner must never wait for nothing
  }
}

void main();
