/**
 * useCallEntry — the way into a call from a chat: «Call» in a chat's menu, «Call back» on a missed call. One hook for
 * every entry point, so they can never disagree about when a call can be placed.
 *
 * Null — nothing offered — unless the host offers it (calls allowed for the account AND a room the server would ring).
 * Null asks for nothing: no microphone permission read, no signalling listener. Offered, it says whether it can be
 * pressed now and, when not, why (`callEntryState`), live as the signalling channel and the microphone permission
 * change. Reading the permission's state never prompts; only `start()` does — through the engine, which asks for the
 * microphone first.
 *
 * A refused start never reaches the call screen (the call never began), so the host says it where the person pressed
 * (`onRefused`).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isAudioCallBusy } from '../audio-call-machine.js';
import type { AudioCallEngine, AudioCallSnapshot } from '../call-engine.js';
import { callEntryState, callRefusalKey, type CallEntryHint, type CallRefusalKey, type MicrophonePermission } from './call-entry.js';

export interface CallEntryControl {
  readonly disabled: boolean;
  /** Why it is disabled, or what the last try ran into (a text key of the host's); null: nothing to say. */
  readonly hint: CallEntryHint | null;
  /** Place the call in this room. */
  readonly start: () => void;
}

/** Whether the signalling channel the call frames ride is up, and its changes. */
export interface CallSignallingState {
  isOpen(): boolean;
  /** Returns unsubscribe. */
  onOpenChange(listener: (open: boolean) => void): () => void;
}

export interface CallEntryOptions {
  /** Offer the entry at all: calls allowed for the account AND the room is one the server would ring. */
  readonly offered: boolean;
  /** `useAudioCall().engine`. */
  readonly engine: AudioCallEngine | null;
  /** `useAudioCall().snapshot`. */
  readonly snapshot: AudioCallSnapshot | null;
  /** The signalling channel; listened to only while offered. The latest one is used. */
  readonly signalling: CallSignallingState;
  /** A start was refused, with words to say (a text key of the host's). The latest function is used. */
  readonly onRefused: (key: CallRefusalKey) => void;
}

function asPermission(state: PermissionState): MicrophonePermission {
  return state === 'granted' || state === 'denied' || state === 'prompt' ? state : 'unknown';
}

/** The microphone permission for this site, live; `unknown` where the browser cannot say (Safari, a WebView). */
function useMicrophonePermission(active: boolean): MicrophonePermission {
  const [permission, setPermission] = useState<MicrophonePermission>('unknown');
  useEffect(() => {
    const permissions = typeof navigator === 'undefined' ? undefined : navigator.permissions;
    if (!active || typeof permissions?.query !== 'function') return undefined;
    let status: PermissionStatus | null = null;
    let gone = false;
    const read = (): void => {
      if (status) setPermission(asPermission(status.state));
    };
    permissions.query({ name: 'microphone' as PermissionName }).then(
      (answer) => {
        if (gone) return;
        status = answer;
        read();
        answer.addEventListener('change', read);
      },
      () => undefined, // a browser that does not know the name: stays `unknown`
    );
    return () => {
      gone = true;
      status?.removeEventListener('change', read);
    };
  }, [active]);
  return permission;
}

/** Whether the signalling channel is up, live — listened to only while `active`. */
function useSignallingUp(active: boolean, signalling: CallSignallingState): boolean {
  const latest = useRef(signalling);
  latest.current = signalling;
  const [up, setUp] = useState(() => signalling.isOpen());
  useEffect(() => {
    if (!active) return undefined;
    setUp(latest.current.isOpen());
    return latest.current.onOpenChange(setUp);
  }, [active]);
  return up;
}

export function useCallEntry(conversationId: string | null | undefined, options: CallEntryOptions): CallEntryControl | null {
  const { offered: active, engine, snapshot } = options;
  const microphone = useMicrophonePermission(active);
  const online = useSignallingUp(active, options.signalling);
  const refused = useRef(options.onRefused);
  refused.current = options.onRefused;

  const start = useCallback(() => {
    if (!engine || !conversationId) return;
    void engine.call(conversationId).then((result) => {
      if (result.ok) return;
      const key = callRefusalKey(result.reason);
      if (key) refused.current(key);
    });
  }, [engine, conversationId]);

  const { disabled, hintKey } = callEntryState({
    engine: engine !== null,
    busy: snapshot !== null && isAudioCallBusy(snapshot.call),
    online,
    microphone,
    lastProblem: snapshot?.problem ?? null,
  });
  // One object while what it says holds: the menu and the thread's rows re-render when it changes, not on every snapshot.
  return useMemo(() => (active ? { disabled, hint: hintKey, start } : null), [active, disabled, hintKey, start]);
}
