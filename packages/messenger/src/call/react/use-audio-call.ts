/**
 * The call engine in React. Two hooks:
 *
 *  - `useAudioCallHost(options)` — mount ONCE, high in the app. Off (`allowed` false, or no `binding` — this device has
 *    no encryption runtime, so a call could never be verified) it does nothing at all: no engine, no signalling hold,
 *    no microphone. On: one engine for the tab, built from the host's ports, with the host's signalling channel held for
 *    as long as the engine lives, and the screen kept awake while a call is up.
 *  - `useAudioCall()` — what the screen and the entry points read: the engine (its commands) and its snapshot, or nulls
 *    when off.
 *
 * The ring's sound is not here: whether and where a ring sounds (one tab of the browser, a muted room, quiet hours) is
 * the host's, read from the snapshot this hook returns. The engine's API, states and reasons: `docs/calls.md`.
 */
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { isAudioCallBusy } from '../audio-call-machine.js';
import { createAudioCallEngine, type AudioCallEngine, type AudioCallSnapshot, type CallBindingPort, type CallEnginePorts } from '../call-engine.js';

// The tab's one engine, readable from anywhere the screen needs it.
let engine: AudioCallEngine | null = null;
let unrelay: () => void = () => undefined;
const listeners = new Set<() => void>();

const emit = (): void => {
  for (const listener of [...listeners]) listener();
};

function setEngine(next: AudioCallEngine | null): void {
  unrelay();
  engine = next;
  unrelay = next ? next.subscribe(emit) : () => undefined;
  emit();
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const getEngine = (): AudioCallEngine | null => engine;
const getSnapshot = (): AudioCallSnapshot | null => engine?.getSnapshot() ?? null;

/** A hold the host takes; the function it returns lets go. */
export type CallHold = () => () => void;

export interface AudioCallHostOptions {
  /** Calls are allowed for this account. A call in progress outlives it turning false: it takes effect once the call is
   *  over. */
  readonly allowed: boolean;
  /**
   * The MLS worker's two call questions; null while this device has no encryption runtime (then nothing is created).
   * The engine is made for one pair of `callTag` / `callVerify` functions: a new object with the same two functions
   * keeps the engine, a new function makes a new one (a call in progress then ends — so keep them stable).
   */
  readonly binding: CallBindingPort | null;
  /**
   * Every port but the binding, for a new engine (the socket, the ICE route, the microphone, the peer connection, the
   * speaker, the ids); the binding to put in is given. Called once per engine; the latest function is used.
   */
  readonly createPorts: (binding: CallBindingPort) => CallEnginePorts;
  /**
   * Hold the signalling channel open (connect it, keep its heartbeat) for as long as an engine lives: taken before the
   * engine is made, released after it is disposed. The latest function is used.
   */
  readonly holdSignalling?: CallHold;
  /**
   * Keep the screen awake from the ring (either side) until the call is over: a phone put down on a table locks after
   * its auto-lock delay, and a locked page loses the microphone or is suspended. Best effort, the host's. The latest
   * function is used.
   */
  readonly holdScreen?: CallHold;
}

/**
 * Mount once. Off (`allowed` false, or no binding): nothing is created, opened or asked for. A call in progress holds
 * the engine: `allowed` blinking (a refetch) or being switched off never drops it — it takes effect once the call is
 * over. Returns the snapshot (null while off), for what the host decides from it (the ring's sound).
 */
export function useAudioCallHost(options: AudioCallHostOptions): AudioCallSnapshot | null {
  const { allowed, binding } = options;
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, () => null);
  const busy = snapshot !== null && isAudioCallBusy(snapshot.call);
  const enabled = allowed || busy;
  const latest = useRef(options);
  latest.current = options;
  const callTag = binding?.callTag;
  const callVerify = binding?.callVerify;

  useEffect(() => {
    const port = latest.current.binding;
    if (!enabled || !callTag || !callVerify || !port) return undefined;
    const release = latest.current.holdSignalling?.() ?? ((): void => undefined);
    const created = createAudioCallEngine(latest.current.createPorts(port));
    setEngine(created);
    return () => {
      if (engine === created) setEngine(null);
      created.dispose();
      release();
    };
  }, [enabled, callTag, callVerify]);

  useEffect(() => (busy ? latest.current.holdScreen?.() : undefined), [busy]);

  return snapshot;
}

/** The engine and what it shows; both null while calls are off. */
export function useAudioCall(): { readonly engine: AudioCallEngine | null; readonly snapshot: AudioCallSnapshot | null } {
  const current = useSyncExternalStore(subscribe, getEngine, () => null);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, () => null);
  return { engine: current, snapshot };
}
