/**
 * Where the UI reads a room's security state from (step К5b): the ONE wiring entry point.
 *
 * A host (or the engine wiring of the next step) passes a `SecurityStateSource` as
 * `MessengerUiServices.security`. The screens read it through `useSecurityState(conversationId)`
 * (`../security/use-security-state.ts`); nothing else in the package knows who fills it.
 *
 * Why a get + subscribe pair and not a plain function: a room's state changes under a mounted
 * screen (a device is added, the epoch advances, a stall begins), and a function called during
 * render cannot say "call me again". The pair is exactly what `useSyncExternalStore` takes, so the
 * source may be a store, an event emitter, or the hook state of the engine wiring, without the
 * package importing any of them.
 */
import type { ConversationSecurityState } from '../../protocol/security-state.js';

export interface SecurityStateSource {
  /**
   * The current state of a room, or `undefined` when the client does not know it (no engine for the
   * room, not loaded yet). Unknown means NO badge, never a reassuring default.
   *
   * MUST return the same object while nothing changed (a snapshot, not a rebuild per call): the
   * screens compare by identity, and a fresh object each time would redraw them in a loop.
   */
  securityStateOf(conversationId: string): ConversationSecurityState | undefined;
  /** Calls `onChange` whenever `securityStateOf(conversationId)` may have changed; returns the unsubscribe. */
  subscribe(conversationId: string, onChange: () => void): () => void;
}
