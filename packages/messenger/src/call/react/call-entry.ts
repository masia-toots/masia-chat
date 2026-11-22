/**
 * call-entry — can «Call» be pressed right now, and if not, the honest reason.
 *
 * Whether the row is offered at all is the host's (calls allowed for the account, a room the server would ring); this
 * is the rest. The reasons are checked in the order a person can do something about them least → most: this device
 * cannot hold a call yet, a call is already up here, no connection, the microphone is blocked for this site. A
 * microphone the last try did not find stays pressable — it may be plugged in by now — and says what happened.
 */
import type { AudioCallProblem, AudioCallRefusal } from '../call-engine.js';

/** What the browser says about the microphone permission; `unknown` where it cannot say (Safari, a WebView). */
export type MicrophonePermission = 'granted' | 'denied' | 'prompt' | 'unknown';

export interface CallEntryInput {
  /** The tab's call engine exists (calls on AND the encryption runtime ready). */
  readonly engine: boolean;
  /** A call is up on this device (`isAudioCallBusy`). */
  readonly busy: boolean;
  /** The signalling channel is up. */
  readonly online: boolean;
  readonly microphone: MicrophonePermission;
  /** The problem the engine left after the last refused `call()` (it stays while idle). */
  readonly lastProblem: AudioCallProblem | null;
}

/** Why the entry is disabled, or what the last try ran into: a text key of the host's (the first host: `call.hint.<key>`). */
export type CallEntryHint = 'notReady' | 'busy' | 'offline' | 'microphoneDenied' | 'microphoneUnavailable';

export interface CallEntryState {
  readonly disabled: boolean;
  readonly hintKey: CallEntryHint | null;
}

export function callEntryState(input: CallEntryInput): CallEntryState {
  if (!input.engine) return { disabled: true, hintKey: 'notReady' };
  if (input.busy) return { disabled: true, hintKey: 'busy' };
  if (!input.online) return { disabled: true, hintKey: 'offline' };
  if (input.microphone === 'denied') return { disabled: true, hintKey: 'microphoneDenied' };
  // The permission is not known to be blocked (granted since, or the browser cannot say): pressable, with what the
  // last try ran into — `granted` means the person has fixed it, so the old words would be stale.
  if (input.microphone !== 'granted') {
    if (input.lastProblem === 'microphone-denied') return { disabled: false, hintKey: 'microphoneDenied' };
  }
  if (input.lastProblem === 'microphone-unavailable') return { disabled: false, hintKey: 'microphoneUnavailable' };
  return { disabled: false, hintKey: null };
}

/** The words for a refused start: a text key of the host's (the first host: `call.refused.<key>`). */
export type CallRefusalKey = 'disabled' | 'busy' | 'offline' | 'microphoneDenied' | 'microphoneUnavailable' | 'gone';

const REFUSAL: Record<AudioCallRefusal, CallRefusalKey | null> = {
  disabled: 'disabled',
  busy: 'busy',
  offline: 'offline',
  'microphone-denied': 'microphoneDenied',
  'microphone-unavailable': 'microphoneUnavailable',
  'not-ringing': 'gone',
  gone: 'gone',
  // The start was stopped on purpose (hung up during the microphone prompt): nothing to tell.
  cancelled: null,
};

/** The words for a refused `call()` — a refusal never reaches the call screen (the call never started), so it is said
 *  where the person pressed; null when there is nothing to say. */
export function callRefusalKey(reason: AudioCallRefusal): CallRefusalKey | null {
  return REFUSAL[reason];
}
