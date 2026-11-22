/**
 * audio-call-machine — one device's view of a 1:1 audio call (ADR-211 decision 2, step Д1). The same ADR-063 shape as
 * `ask-call-machine`: a PURE value machine, a module singleton (one app, one call at a time), effects wired by the
 * host (the socket, the `RTCPeerConnection`, the ringtone, the MLS worker that computes the tag — step Д2).
 *
 * ## The states
 *
 *   `idle`       — no call.
 *   `inviting`   — «Call» pressed; `call:invite` is out, the server has not named the call yet.
 *   `outgoing`   — the server acked with a `callId`; the other side's devices may be ringing (or not — the caller
 *                  never learns why nobody answers, ADR-211 decision 8).
 *   `incoming`   — `call:ring` landed; this device rings.
 *   `accepting`  — «Answer» pressed here; waiting for the server to confirm THIS device won (another may have).
 *   `connecting` — accepted; media is being set up and the two tags are being exchanged. The remote audio is NOT
 *                  attached in this state, and our own microphone sends silence (ADR-211 decision 4).
 *   `verified`   — the peer's tag checked out; the remote audio may play and our microphone opens (unless muted).
 *   `ended`      — closed, with WHY. `idle` comes back only through `CLOSE`, sent by the host after the closing beat.
 *
 * Every server event names its `callId`; an event for another call never moves this one (addressed, always).
 */
import { createMachine, type Machine } from '../state-machine/create-machine.js';
import type { CallEndReason, CallRole } from '@masia/contracts/wire';

/** Why the call ended: the server's reasons; a local press ends with the same words (`hangup`, `declined`). */
export type AudioCallEndWhy = CallEndReason;

export type AudioCallState =
  | { readonly name: 'idle' }
  | {
      readonly name: 'inviting';
      readonly requestId: string;
      readonly conversationId: string;
      readonly localDeviceId: string;
    }
  | {
      readonly name: 'outgoing';
      readonly callId: string;
      readonly conversationId: string;
      readonly localDeviceId: string;
      readonly ringUntil: string;
    }
  | {
      readonly name: 'incoming';
      readonly callId: string;
      readonly conversationId: string;
      readonly callerUserId: string;
      readonly peerDeviceId: string;
      readonly ringUntil: string;
    }
  | {
      readonly name: 'accepting';
      readonly callId: string;
      readonly conversationId: string;
      readonly callerUserId: string;
      readonly peerDeviceId: string;
      readonly localDeviceId: string;
    }
  | {
      readonly name: 'connecting' | 'verified';
      readonly callId: string;
      readonly conversationId: string;
      readonly role: CallRole;
      readonly localDeviceId: string;
      readonly peerDeviceId: string;
    }
  | {
      readonly name: 'ended';
      /** null only when the invite never got a `callId` (hung up before the ack). */
      readonly callId: string | null;
      readonly conversationId: string;
      readonly reason: AudioCallEndWhy;
    };

export type AudioCallEvent =
  /** «Call» pressed — the host sends `call:invite` with the same `requestId`. */
  | { readonly type: 'INVITE'; readonly requestId: string; readonly conversationId: string; readonly localDeviceId: string }
  /** The server's `call:invite` ack — the call now has its id. An ack for a request this machine no longer waits
   *  for (hung up before it came) is ignored here; the HOST then sends `call:end hangup` for that `callId`. */
  | { readonly type: 'INVITE_ACK'; readonly requestId: string; readonly callId: string; readonly ringUntil: string }
  /** `call:ring` landed. */
  | {
      readonly type: 'RING';
      readonly callId: string;
      readonly conversationId: string;
      readonly callerUserId: string;
      readonly callerDeviceId: string;
      readonly ringUntil: string;
    }
  /** «Answer» pressed here — the host sends `call:accept`. */
  | { readonly type: 'ACCEPT'; readonly localDeviceId: string }
  /** The server's `call:accept` — to the caller, and to the callee device that won. */
  | { readonly type: 'ACCEPTED'; readonly callId: string; readonly callerDeviceId: string; readonly calleeDeviceId: string }
  /** «Decline» pressed here — the host sends `call:decline`. */
  | { readonly type: 'DECLINE' }
  /** The peer's tag checked out (host-side, constant time — `call-verify-tag.ts`). */
  | { readonly type: 'VERIFIED'; readonly callId: string }
  /** The peer's tag failed, was late, or was our own tag reflected — the host sends `call:end verify-failed`. */
  | { readonly type: 'VERIFY_FAILED'; readonly callId: string }
  /** «Hang up» pressed here — the host sends `call:end hangup` (when it has a `callId`). */
  | { readonly type: 'HANGUP' }
  /** The server's `call:end`. */
  | { readonly type: 'END'; readonly callId: string; readonly reason: CallEndReason }
  /** The host ends the call on what it knows ITSELF — the socket closed (`lost`), the media path failed
   *  (`connect-failed`), a local deadline passed (`no-answer`). From any live state, `inviting` included (where no
   *  `END` can reach: the call has no id yet). The host tells the server separately where it has a `callId`. */
  | { readonly type: 'ABORT'; readonly reason: AudioCallEndWhy }
  /** The closing beat is over; drop the screen. */
  | { readonly type: 'CLOSE' };

export const initialAudioCallState: AudioCallState = { name: 'idle' };

// ── selectors ───────────────────────────────────────────────────────────────────────────────────

/** The call's id, once the server named it. */
export function currentAudioCallId(s: AudioCallState): string | null {
  switch (s.name) {
    case 'idle':
    case 'inviting':
      return null;
    default:
      return s.callId;
  }
}

/** Is a call screen up? `ended` included — the closing word IS the screen's last second. */
export function isAudioCallUp(s: AudioCallState): boolean {
  return s.name !== 'idle';
}

/** Should this device ring? Only an unanswered incoming call. */
export function isAudioCallRinging(s: AudioCallState): boolean {
  return s.name === 'incoming';
}

/** May the remote audio be attached to anything? Only after the peer's tag checked out (ADR-211 decision 4). */
export function isAudioCallAudible(s: AudioCallState): boolean {
  return s.name === 'verified';
}

/** Is there a live call on this device (a new incoming ring would be a second call)? */
export function isAudioCallBusy(s: AudioCallState): boolean {
  return s.name !== 'idle' && s.name !== 'ended';
}

// ── reducer ─────────────────────────────────────────────────────────────────────────────────────

function ended(s: Exclude<AudioCallState, { name: 'idle' }>, reason: AudioCallEndWhy): AudioCallState {
  const callId = s.name === 'inviting' ? null : s.callId;
  return { name: 'ended', callId, conversationId: s.conversationId, reason };
}

export function audioCallNext(state: AudioCallState, event: AudioCallEvent): AudioCallState {
  switch (event.type) {
    case 'INVITE':
      if (isAudioCallBusy(state)) return state;
      return {
        name: 'inviting',
        requestId: event.requestId,
        conversationId: event.conversationId,
        localDeviceId: event.localDeviceId,
      };
    case 'INVITE_ACK':
      if (state.name !== 'inviting' || state.requestId !== event.requestId) return state;
      return {
        name: 'outgoing',
        callId: event.callId,
        conversationId: state.conversationId,
        localDeviceId: state.localDeviceId,
        ringUntil: event.ringUntil,
      };
    case 'RING':
      // One call at a time: a second ring while busy is IGNORED — and the host must not decline it either: to the
      // second caller it has to look like any unanswered call, or they learn this person is on a call. A
      // re-delivery of the call that just ended here does not ring again.
      if (isAudioCallBusy(state)) return state;
      if (state.name === 'ended' && state.callId === event.callId) return state;
      return {
        name: 'incoming',
        callId: event.callId,
        conversationId: event.conversationId,
        callerUserId: event.callerUserId,
        peerDeviceId: event.callerDeviceId,
        ringUntil: event.ringUntil,
      };
    case 'ACCEPT':
      if (state.name !== 'incoming') return state;
      return {
        name: 'accepting',
        callId: state.callId,
        conversationId: state.conversationId,
        callerUserId: state.callerUserId,
        peerDeviceId: state.peerDeviceId,
        localDeviceId: event.localDeviceId,
      };
    case 'ACCEPTED':
      if (state.name === 'outgoing' && state.callId === event.callId) {
        return {
          name: 'connecting',
          callId: state.callId,
          conversationId: state.conversationId,
          role: 'caller',
          localDeviceId: state.localDeviceId,
          peerDeviceId: event.calleeDeviceId,
        };
      }
      // The callee side: only the device that pressed «Answer» AND is the one the server names.
      if (state.name === 'accepting' && state.callId === event.callId && state.localDeviceId === event.calleeDeviceId) {
        return {
          name: 'connecting',
          callId: state.callId,
          conversationId: state.conversationId,
          role: 'callee',
          localDeviceId: state.localDeviceId,
          peerDeviceId: event.callerDeviceId,
        };
      }
      return state;
    case 'DECLINE':
      return state.name === 'incoming' ? ended(state, 'declined') : state;
    case 'VERIFIED':
      return state.name === 'connecting' && state.callId === event.callId ? { ...state, name: 'verified' } : state;
    case 'VERIFY_FAILED':
      return state.name === 'connecting' && state.callId === event.callId ? ended(state, 'verify-failed') : state;
    case 'HANGUP':
      if (state.name === 'idle' || state.name === 'ended' || state.name === 'incoming') return state;
      return ended(state, 'hangup');
    case 'END': {
      if (state.name === 'idle' || state.name === 'inviting' || state.name === 'ended') return state; // keep the FIRST reason
      if (state.callId !== event.callId) return state; // addressed, always
      return ended(state, event.reason);
    }
    case 'ABORT':
      return state.name === 'idle' || state.name === 'ended' ? state : ended(state, event.reason);
    case 'CLOSE':
      return state.name === 'ended' ? initialAudioCallState : state;
  }
}

export function audioCallTransition(state: AudioCallState, event: AudioCallEvent): { state: AudioCallState } {
  return { state: audioCallNext(state, event) };
}

export type AudioCallMachine = Machine<AudioCallState, AudioCallEvent>;

/** THE machine — a module singleton: one app, one call at a time. */
export const audioCall: AudioCallMachine = createMachine<AudioCallState, AudioCallEvent>({
  initial: initialAudioCallState,
  transition: audioCallTransition,
});

/** Factory — for tests that want an isolated machine. */
export function createAudioCallMachine(): AudioCallMachine {
  return createMachine<AudioCallState, AudioCallEvent>({ initial: initialAudioCallState, transition: audioCallTransition });
}
