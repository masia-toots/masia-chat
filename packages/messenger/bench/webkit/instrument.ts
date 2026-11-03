/**
 * Eyes on the page, installed BEFORE the engine is evaluated (import this file first).
 *
 *  - every `WebAssembly` entry point is counted, so "the engine loads no WASM" is something the
 *    bench measures instead of assumes (the CSP has no `wasm-unsafe-eval`; a WASM compile would
 *    also be a violation, but not every engine reports one);
 *  - every `securitypolicyviolation` event is recorded with the phase it happened in. The bench
 *    runs the engine under a strict CSP; a violation during an engine phase is a failure, while the
 *    deliberate probes of the `csp-control` phase are expected to be blocked.
 *
 * Works in a page and in a Worker (both have `globalThis.addEventListener`).
 */

export interface Violation {
  readonly phase: string;
  readonly directive: string;
  readonly blocked: string;
  readonly sample: string;
}

export interface WasmCall {
  readonly phase: string;
  readonly api: string;
}

export const violations: Violation[] = [];
export const wasmCalls: WasmCall[] = [];
let currentPhase = 'boot';

export function setPhase(phase: string): void {
  currentPhase = phase;
}

export function phaseNow(): string {
  return currentPhase;
}

interface ViolationLike {
  effectiveDirective?: string;
  violatedDirective?: string;
  blockedURI?: string;
  sample?: string;
}

globalThis.addEventListener('securitypolicyviolation', (event: Event) => {
  const e = event as unknown as ViolationLike;
  violations.push({
    phase: currentPhase,
    directive: e.effectiveDirective ?? e.violatedDirective ?? '?',
    blocked: e.blockedURI ?? '',
    sample: (e.sample ?? '').slice(0, 80),
  });
});

type AnyFn = (...args: unknown[]) => unknown;

function countWasm(): void {
  const wasm = (globalThis as { WebAssembly?: Record<string, unknown> }).WebAssembly;
  if (wasm === undefined) return;
  for (const api of ['compile', 'instantiate', 'compileStreaming', 'instantiateStreaming']) {
    const original = wasm[api];
    if (typeof original !== 'function') continue;
    wasm[api] = function patched(this: unknown, ...args: unknown[]) {
      wasmCalls.push({ phase: currentPhase, api: `WebAssembly.${api}` });
      return (original as AnyFn).apply(this, args);
    };
  }
  for (const api of ['Module', 'Instance']) {
    const original = wasm[api];
    if (typeof original !== 'function') continue;
    wasm[api] = new Proxy(original as new (...args: unknown[]) => object, {
      construct(target, args, newTarget) {
        wasmCalls.push({ phase: currentPhase, api: `new WebAssembly.${api}` });
        return Reflect.construct(target, args, newTarget) as object;
      },
    });
  }
}

countWasm();
