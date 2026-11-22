/**
 * create-machine — the dependency-free reducer-FSM helper (ADR-063). It is the concrete realization of
 * ADR-060's "domain state machine" layer: a tiny reactive store whose state changes ONLY through a pure
 * `transition(state, event) → { state, actions }` reducer.
 *
 * TWO axes, cleanly split (ADR-063):
 *   • STORAGE / reactivity (axis A) — a plain subscriber `Set`, published the same way every `universe-*`
 *     store already does (no Zustand, no new dep). React binds via `useMachine` (`@masia/ui`).
 *   • TRANSITIONS (axis B) — the host-supplied PURE reducer. Illegal `(state, event)` pairs are NO-OPS
 *     (return the SAME state reference) → illegal transitions can't happen, the app never crashes.
 *
 * SIDE EFFECTS are intents, not inline calls: the reducer emits an ordered `actions` list; the host runs
 * them through an injected `run` port (the same engine/registry/ports shape as `game-engine`). This keeps
 * the reducer pure and unit-testable — "entering the sphere plays the seal sound" becomes an assertion.
 *
 * PURE (no React/DOM) so it runs headless in tests and on the server (ADR-060 Layer-3 DB bindings).
 */

/** What a `transition` returns: the next state + optional ordered side-effect intents. */
export interface TransitionResult<S, A = never> {
  /** The next state. Return the SAME reference as the input to signal a NO-OP (no notify). */
  readonly state: S;
  /** Ordered side-effect intents for the host to run (via the injected `run` port). */
  readonly actions?: readonly A[];
}

/** The machine definition the host supplies. */
export interface MachineDef<S, E, A = never> {
  /** The starting state. */
  readonly initial: S;
  /** PURE reducer: given the current state + an event, the next state (+ optional action intents).
   *  Must not mutate `state`; return the same reference for an ignored (illegal) transition. */
  readonly transition: (state: S, event: E) => TransitionResult<S, A>;
  /** Host-injected action runner (the "ports"). Omit for a pure value-machine (host pulls state). */
  readonly run?: (action: A, ctx: { readonly state: S; readonly prev: S; readonly event: E }) => void;
}

/** A live machine instance. Its public surface is state-in / events-out; the action type `A` is an
 *  internal concern of the reducer + the injected runner, so it does not appear here. */
export interface Machine<S, E> {
  /** The current state (synchronous read). */
  getState(): S;
  /** Dispatch an event: run the reducer, execute its actions, notify subscribers if the state changed.
   *  Returns the resulting state. */
  send(event: E): S;
  /** Subscribe to state changes; returns an unsubscribe fn. The listener fires only when the state
   *  reference actually changed (a no-op transition does not notify). */
  subscribe(listener: (state: S) => void): () => void;
}

/**
 * Build a machine from a definition. The machine owns the current state, dispatches events through the
 * pure reducer, runs the emitted actions via the injected `run` port, and publishes changes to React
 * (and any other) subscribers.
 */
export function createMachine<S, E, A = never>(def: MachineDef<S, E, A>): Machine<S, E> {
  let state: S = def.initial;
  const listeners = new Set<(state: S) => void>();

  function getState(): S {
    return state;
  }

  function send(event: E): S {
    const prev = state;
    const result = def.transition(prev, event);
    const next = result.state;
    state = next;
    // Run side-effect intents FIRST (so a subscriber re-render sees their results), but only if the host
    // provided a runner. Actions run even on a self-transition (an event can have an effect without a
    // state change — e.g. a hit that only plays a sound).
    if (result.actions && def.run) {
      for (const action of result.actions) def.run(action, { state: next, prev, event });
    }
    // Notify only on a genuine state change (reference inequality) — a no-op transition is silent.
    if (next !== prev) {
      for (const listener of listeners) listener(next);
    }
    return next;
  }

  function subscribe(listener: (state: S) => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  return { getState, send, subscribe };
}
