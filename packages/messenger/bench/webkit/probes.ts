import { phaseNow, setPhase, violations, wasmCalls, type Violation } from './instrument.js';
import { describeError, statsOf } from './util.js';

/**
 * What the engine stands on, asked of the browser itself: the secure-context and WebCrypto
 * facts, the algorithms suite 1 needs (probed the way `ts-mls` calls them), threads, and the
 * deliberate CSP controls.
 */

export interface AlgorithmProbe {
  readonly name: string;
  readonly ok: boolean;
  readonly ms: number;
  readonly error?: string;
}

export interface EnvProbe {
  readonly userAgent: string;
  readonly platform: string;
  readonly hardwareConcurrency: number | null;
  readonly deviceMemory: number | null;
  readonly isSecureContext: boolean;
  readonly crossOriginIsolated: boolean;
  readonly origin: string;
  readonly timerResolutionMs: number;
  readonly sharedArrayBuffer: { readonly defined: boolean; readonly constructible: boolean; readonly error?: string };
  readonly atomics: boolean;
  readonly webAssemblyDefined: boolean;
  readonly workerDefined: boolean;
}

export interface CryptoProbe {
  readonly subtleDefined: boolean;
  readonly getRandomValues: boolean;
  readonly algorithms: readonly AlgorithmProbe[];
}

const bytes = (length: number, fill = 7): Uint8Array<ArrayBuffer> => new Uint8Array(new ArrayBuffer(length)).fill(fill);
const TIMER_SAMPLES = 2000;

/** Smallest nonzero step of `performance.now()`: WebKit rounds to 1 ms, Chromium (not isolated) to 0.1 ms. */
function timerResolution(): number {
  let smallest = Number.POSITIVE_INFINITY;
  let last = performance.now();
  for (let i = 0; i < TIMER_SAMPLES * 100; i += 1) {
    const now = performance.now();
    if (now > last) smallest = Math.min(smallest, now - last);
    last = now;
    if (i > TIMER_SAMPLES && Number.isFinite(smallest)) break;
  }
  return Number.isFinite(smallest) ? Math.round(smallest * 1000) / 1000 : -1;
}

export function probeEnv(): EnvProbe {
  const nav = navigator as Navigator & { deviceMemory?: number };
  let sab: EnvProbe['sharedArrayBuffer'];
  if (typeof SharedArrayBuffer === 'undefined') {
    sab = { defined: false, constructible: false };
  } else {
    try {
      new SharedArrayBuffer(8);
      sab = { defined: true, constructible: true };
    } catch (error) {
      sab = { defined: true, constructible: false, error: describeError(error) };
    }
  }
  return {
    userAgent: nav.userAgent,
    platform: nav.platform,
    hardwareConcurrency: nav.hardwareConcurrency ?? null,
    deviceMemory: nav.deviceMemory ?? null,
    isSecureContext: globalThis.isSecureContext,
    crossOriginIsolated: globalThis.crossOriginIsolated,
    origin: globalThis.location.origin,
    timerResolutionMs: timerResolution(),
    sharedArrayBuffer: sab,
    atomics: typeof Atomics !== 'undefined',
    webAssemblyDefined: typeof WebAssembly !== 'undefined',
    workerDefined: typeof Worker !== 'undefined',
  };
}

async function algorithm(name: string, body: () => Promise<void>): Promise<AlgorithmProbe> {
  const started = performance.now();
  try {
    await body();
    return { name, ok: true, ms: performance.now() - started };
  } catch (error) {
    return { name, ok: false, ms: performance.now() - started, error: describeError(error) };
  }
}

/** The WebCrypto calls suite 1 (`MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519`) makes, one by one. */
export async function probeCrypto(): Promise<CryptoProbe> {
  const subtle = globalThis.crypto?.subtle as SubtleCrypto | undefined;
  const base = {
    subtleDefined: subtle !== undefined,
    getRandomValues: typeof globalThis.crypto?.getRandomValues === 'function',
  };
  if (subtle === undefined) return { ...base, algorithms: [] };
  const algorithms: AlgorithmProbe[] = [];
  algorithms.push(
    await algorithm('SHA-256 digest', async () => {
      const out = new Uint8Array(await subtle.digest('SHA-256', bytes(32)));
      if (out.length !== 32) throw new Error('digest length');
    }),
    await algorithm('HMAC-SHA-256 (importKey raw, sign): the KDF building block', async () => {
      const key = await subtle.importKey('raw', bytes(32), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const mac = new Uint8Array(await subtle.sign('HMAC', key, bytes(16)));
      if (mac.length !== 32) throw new Error('mac length');
    }),
    await algorithm('AES-128-GCM (encrypt + decrypt round trip, 16-byte tag)', async () => {
      const key = await subtle.importKey('raw', bytes(16), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
      const params = { name: 'AES-GCM', iv: bytes(12), additionalData: bytes(5), tagLength: 128 };
      const sealed = await subtle.encrypt(params, key, bytes(40));
      const opened = new Uint8Array(await subtle.decrypt(params, key, sealed));
      if (opened.length !== 40) throw new Error('plaintext length');
    }),
    await algorithm('Ed25519 (generateKey, export raw + pkcs8, import pkcs8, sign, verify true and false)', async () => {
      const pair = (await subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as CryptoKeyPair;
      const raw = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
      const pkcs8 = new Uint8Array(await subtle.exportKey('pkcs8', pair.privateKey));
      const priv = await subtle.importKey('pkcs8', pkcs8, 'Ed25519', false, ['sign']);
      const pub = await subtle.importKey('raw', raw, 'Ed25519', false, ['verify']);
      const message = bytes(33);
      const signature = await subtle.sign('Ed25519', priv, message);
      if (!(await subtle.verify('Ed25519', pub, signature, message))) throw new Error('good signature rejected');
      const damaged = new Uint8Array(signature);
      damaged[0] = (damaged[0] ?? 0) ^ 1;
      if (await subtle.verify('Ed25519', pub, damaged, message)) throw new Error('bad signature accepted');
    }),
    await algorithm('X25519 (generateKey, export raw + jwk, import raw + jwk, deriveBits agree on both sides)', async () => {
      const a = (await subtle.generateKey('X25519', true, ['deriveBits'])) as CryptoKeyPair;
      const b = (await subtle.generateKey('X25519', true, ['deriveBits'])) as CryptoKeyPair;
      const bRaw = new Uint8Array(await subtle.exportKey('raw', b.publicKey));
      const aRaw = new Uint8Array(await subtle.exportKey('raw', a.publicKey));
      const bPub = await subtle.importKey('raw', bRaw, 'X25519', true, []);
      const aPub = await subtle.importKey('raw', aRaw, 'X25519', true, []);
      const jwk = await subtle.exportKey('jwk', a.privateKey);
      const aPriv = await subtle.importKey('jwk', jwk, 'X25519', true, ['deriveBits']);
      const ab = new Uint8Array(await subtle.deriveBits({ name: 'X25519', public: bPub }, aPriv, 256));
      const ba = new Uint8Array(await subtle.deriveBits({ name: 'X25519', public: aPub }, b.privateKey, 256));
      if (ab.length !== 32 || ab.some((byte, i) => byte !== ba[i])) throw new Error('shared secrets differ');
    }),
  );
  return { ...base, algorithms };
}

/**
 * What one WebCrypto round trip costs on this thread, in the shape the engine uses it: a native call, then a
 * promise-only continuation, then the next native call. The engine makes about 1100 of these for one Add in a
 * group of 50 (see perf.ts), so this per-call latency is the number that decides the budget on a phone.
 */
export interface RoundTripProbe {
  readonly where: 'page' | 'worker';
  readonly iterations: number;
  /** Median milliseconds per iteration: three native calls (HMAC import, sign, digest) and a promise-only await. */
  readonly medianIterationMs: number;
  readonly p95IterationMs: number;
  /** Median per native call (iteration / 3). */
  readonly medianPerCallMs: number;
  /** The whole loop's time over all of its calls: robust against a coarse timer (WebKit rounds to 1 ms). */
  readonly meanPerCallMs: number;
  /** True when a single call costs about a timer tick: the thread is stalling, not computing (see canon). */
  readonly stalled: boolean;
}

const ROUND_TRIP_ITERATIONS = 40;
const CALLS_PER_ITERATION = 3;
/** A real WebCrypto call is a few hundredths of a millisecond to a fraction of one; a timer tick is 10+ ms. */
const STALL_PER_CALL_MS = 2;

export async function probeRoundTrip(where: 'page' | 'worker'): Promise<RoundTripProbe> {
  const subtle = globalThis.crypto.subtle;
  const data = bytes(64);
  const samples: number[] = [];
  const loopStarted = performance.now();
  for (let i = 0; i < ROUND_TRIP_ITERATIONS; i += 1) {
    const started = performance.now();
    const key = await subtle.importKey('raw', bytes(32), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    await Promise.resolve();
    await subtle.sign('HMAC', key, data);
    await subtle.digest('SHA-256', data);
    samples.push(performance.now() - started);
  }
  const loopMs = performance.now() - loopStarted;
  const stats = statsOf(samples);
  const thousandth = (value: number): number => Math.round(value * 1000) / 1000;
  const medianPerCallMs = thousandth(stats.median / CALLS_PER_ITERATION);
  return {
    where,
    iterations: ROUND_TRIP_ITERATIONS,
    medianIterationMs: stats.median,
    p95IterationMs: stats.p95,
    medianPerCallMs,
    meanPerCallMs: thousandth(loopMs / (ROUND_TRIP_ITERATIONS * CALLS_PER_ITERATION)),
    stalled: medianPerCallMs > STALL_PER_CALL_MS,
  };
}

// --- CSP controls ----------------------------------------------------------------------------------

export interface ControlResult {
  readonly name: string;
  /** True when the browser refused it (the policy is in force for this kind of thing). */
  readonly blocked: boolean;
  readonly detail: string;
  readonly violationEvents: number;
}

/** The smallest valid WebAssembly module: magic number and version. */
const EMPTY_WASM = Uint8Array.of(0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00);

async function control(
  name: string,
  attempt: () => Promise<string> | string,
): Promise<ControlResult> {
  const before = violations.length;
  let threw = false;
  let detail: string;
  try {
    detail = `allowed: ${await attempt()}`;
  } catch (error) {
    threw = true;
    detail = describeError(error).split(' @ ')[0] ?? '';
  }
  // A violation event is queued as a task; give it a turn before counting.
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
  const violationEvents = violations.length - before;
  // Some refusals throw (eval), some only report (a string timer): either is "the policy held".
  return { name, blocked: threw || violationEvents > 0, detail, violationEvents };
}

/**
 * The controls that need no DOM, so a Worker can run them too: code from strings and WebAssembly
 * compilation, both of which the strict policy refuses.
 */
export async function runCodeGenControls(): Promise<ControlResult[]> {
  const previous = phaseNow();
  setPhase('csp-control');
  const results = [
    await control('eval("1 + 1")', () => String(globalThis.eval('1 + 1'))),
    await control('new Function("return 1")', () => String(new Function('return 1')())),
    await control('setTimeout("string")', () => {
      (globalThis.setTimeout as unknown as (code: string, ms: number) => number)('void 0', 0);
      return 'scheduled';
    }),
    await control('WebAssembly.compile (no wasm-unsafe-eval)', async () => {
      await WebAssembly.compile(EMPTY_WASM);
      return 'compiled';
    }),
    await control('new WebAssembly.Module (no wasm-unsafe-eval)', () => {
      new WebAssembly.Module(EMPTY_WASM);
      return 'compiled';
    }),
  ];
  setPhase(previous);
  return results;
}

/**
 * Things the strict policy (`default-src 'self'; script-src 'self'`) must refuse. If the browser lets
 * `eval` through, the whole run proves nothing about the policy, so the runner treats that as a failure.
 * Run in the `csp-control` phase: their violations are expected and are kept apart from the engine's.
 */
export async function runCspControls(): Promise<ControlResult[]> {
  const results = await runCodeGenControls();
  const previous = phaseNow();
  setPhase('csp-control');
  results.push(
    await control('inline <script> element', () => {
      const script = document.createElement('script');
      (globalThis as { __inlineRan?: boolean }).__inlineRan = false;
      script.textContent = 'globalThis.__inlineRan = true';
      document.head.appendChild(script);
      script.remove();
      if ((globalThis as { __inlineRan?: boolean }).__inlineRan === true) return 'ran';
      throw new Error('inline script did not run');
    }),
    await control('classic Worker from a blob: URL', async () => {
      const url = URL.createObjectURL(new Blob(['postMessage(1)'], { type: 'text/javascript' }));
      try {
        await new Promise<void>((resolve, reject) => {
          const worker = new Worker(url);
          worker.onmessage = () => {
            worker.terminate();
            resolve();
          };
          worker.onerror = (event) => {
            worker.terminate();
            reject(new Error(`worker error: ${event.message}`));
          };
        });
        return 'blob worker ran';
      } finally {
        URL.revokeObjectURL(url);
      }
    }),
    await control('fetch of a cross-origin URL (connect-src falls back to default-src)', async () => {
      await fetch('https://example.invalid/ping', { mode: 'no-cors' });
      return 'sent';
    }),
  );
  setPhase(previous);
  return results;
}

export function snapshotViolations(): { all: readonly Violation[]; engine: readonly Violation[] } {
  return { all: [...violations], engine: violations.filter((v) => v.phase !== 'csp-control') };
}

export function snapshotWasm(): { all: readonly { phase: string; api: string }[]; engine: readonly { phase: string; api: string }[] } {
  return { all: [...wasmCalls], engine: wasmCalls.filter((c) => c.phase !== 'csp-control') };
}

