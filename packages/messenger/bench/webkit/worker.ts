import './instrument.js';
import { CURVES_FORCED, CURVES_QUERY, ensureCurves } from './curves.js';
import { setPhase, violations, wasmCalls } from './instrument.js';
import { runLifecycle } from './lifecycle.js';
import { runPerf } from './perf.js';
import { probeRoundTrip, runCodeGenControls } from './probes.js';
import { describeError, setProgressSink } from './util.js';
import {
  isRunRequest,
  type RunRequest,
  type WorkerEnv,
  type WorkerMessage,
  type WorkerRun,
} from './worker-protocol.js';

/**
 * The module Worker the messenger plans to move MLS state into. It carries the same engine bundle as
 * the page and runs, inside the Worker: the cost of one WebCrypto round trip, a group of 5 through
 * the whole lifecycle (and a group of 50 when asked), the performance probes (when asked), and the
 * code-generation controls (does the policy reach into the Worker?).
 */

const post = (message: WorkerMessage): void => globalThis.postMessage(message);

function environment(): WorkerEnv {
  return {
    userAgent: navigator.userAgent,
    isSecureContext: globalThis.isSecureContext,
    crossOriginIsolated: globalThis.crossOriginIsolated,
    subtleDefined: globalThis.crypto?.subtle !== undefined,
    sharedArrayBufferDefined: typeof SharedArrayBuffer !== 'undefined',
    webAssemblyDefined: typeof WebAssembly !== 'undefined',
  };
}

const WORKER_GROUP_SIZE = 5;
const BIG_GROUP_SIZE = 50;

async function run(request: RunRequest): Promise<WorkerRun> {
  setPhase('worker-engine');
  setProgressSink((line) => post({ type: 'progress', line }));
  const forceCurves = new URL(globalThis.location.href).searchParams.get(CURVES_QUERY) === CURVES_FORCED;
  const roundTrip = await probeRoundTrip('worker'); // before any stand-in: this is the browser's own WebCrypto
  const curves = await ensureCurves(forceCurves);
  const lifecycle = await runLifecycle(WORKER_GROUP_SIZE);
  const lifecycleBig = request.bigLifecycle ? await runLifecycle(BIG_GROUP_SIZE) : undefined;
  const perf = request.perf ? await runPerf('worker') : undefined;
  const controls = await runCodeGenControls();
  return {
    env: environment(),
    curves,
    roundTrip,
    lifecycle,
    ...(lifecycleBig === undefined ? {} : { lifecycleBig }),
    ...(perf === undefined ? {} : { perf }),
    controls,
    engineViolations: violations.filter((v) => v.phase !== 'csp-control'),
    engineWasmCalls: wasmCalls.filter((c) => c.phase !== 'csp-control'),
  };
}

globalThis.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (!isRunRequest(event.data)) return;
  run(event.data).then(
    (result) => post({ type: 'done', run: result }),
    (error: unknown) => post({ type: 'error', error: describeError(error) }),
  );
});

post({ type: 'booted', env: environment() });
