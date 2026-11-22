/**
 * call-view — what the call screen shows, read from the engine's snapshot. Pure: no React, no clock of its own (the
 * caller passes `now`), no words (it names text keys of the screen, `CALL_SCREEN_TEXT_KEYS`).
 *
 * Two pieces:
 *   - `rememberCall` — what the snapshot no longer says but the screen needs: which side this device is on (the
 *     machine's `ended` state does not carry the role) and when the call first went live HERE (the elapsed time is
 *     measured on this device, from that moment; nothing is ever compared with another device's clock).
 *   - `callView` — the stage, the actions, the end words by side, the problem words, the badge.
 *
 * The engine's rules for a screen (`docs/calls.md`), kept here so the screen cannot break them:
 *   - "connected" only once `snapshot.live` (verified AND the media path up) — `verified` alone is `connecting`;
 *   - a person is named only from `snapshot.verifiedPeer`; before that the screen names the CHAT the ring is in;
 *   - busy, offline, blocked and ignored all reach the caller as `no-answer`, and get ONE wording.
 */
import type { CallEndReason, CallRole } from '@masia/contracts/wire';
import type { AudioCallState } from '../audio-call-machine.js';
import type { AudioCallProblem, AudioCallSnapshot } from '../call-engine.js';
import type { CallOtherDeviceKind } from '../call-binding-types.js';

export type CallSide = CallRole;

/** What the screen is showing: the outgoing call, the ring, the setup, the call itself, a reconnect, the closing beat. */
export type CallStage = 'calling' | 'ringing' | 'connecting' | 'live' | 'reconnecting' | 'ended';

export interface CallMemory {
  /** The machine's state name at the last snapshot — a new call is told from the old one by it. */
  readonly phase: AudioCallState['name'];
  readonly side: CallSide | null;
  /** This device's monotonic time (`performance.now()`) when the call first went live here; kept through reconnects. */
  readonly liveSince: number | null;
  /** The call's number on this device (0 before the first): the screen keeps its per-call state (folded, the closing
   *  beat, the sounds) under it, so one call's state never leaks into the next. */
  readonly serial: number;
}

const FORGOTTEN = { side: null, liveSince: null } as const;

function sideOf(call: AudioCallState): CallSide | null {
  switch (call.name) {
    case 'inviting':
    case 'outgoing':
      return 'caller';
    case 'incoming':
    case 'accepting':
      return 'callee';
    case 'connecting':
    case 'verified':
      return call.role;
    default:
      return null;
  }
}

/** Fold one snapshot into the memory. `now` is this device's monotonic clock. */
export function rememberCall(prev: CallMemory | null, snapshot: AudioCallSnapshot, now: number): CallMemory {
  const phase = snapshot.call.name;
  const serial = prev?.serial ?? 0;
  if (phase === 'idle') return { phase, ...FORGOTTEN, serial };
  // A new call: the first ever, one after `idle`, or one that followed an ended call without `idle` in between.
  const fresh = prev === null || prev.phase === 'idle' || (prev.phase === 'ended' && phase !== 'ended');
  const base = fresh ? FORGOTTEN : prev;
  return {
    phase,
    side: sideOf(snapshot.call) ?? base.side,
    liveSince: base.liveSince ?? (snapshot.live ? now : null),
    serial: fresh ? serial + 1 : serial,
  };
}

/** The words of the closing beat — text keys under `end.`. */
export type CallEndKey =
  | 'ended'
  | 'cancelled'
  | 'missed'
  | 'declined'
  | 'youDeclined'
  | 'noAnswer'
  | 'answeredElsewhere'
  | 'lost'
  | 'verifyFailed'
  | 'connectFailed'
  | 'rateLimited'
  | 'unavailable';

/** The words of a problem — text keys under `problem.`. */
export type CallProblemKey =
  | 'microphoneDenied'
  | 'microphoneUnavailable'
  | 'offline'
  | 'relayUnavailable'
  | 'cannotConnect'
  | 'cannotVerify';

/** The words of the closing beat, by side. */
type EndWords = { readonly caller: CallEndKey; readonly callee: CallEndKey; readonly plain: boolean };

const END: Record<CallEndReason, EndWords> = {
  hangup: { caller: 'ended', callee: 'ended', plain: true },
  cancelled: { caller: 'cancelled', callee: 'missed', plain: true },
  declined: { caller: 'declined', callee: 'youDeclined', plain: true },
  'no-answer': { caller: 'noAnswer', callee: 'missed', plain: true },
  'answered-elsewhere': { caller: 'ended', callee: 'answeredElsewhere', plain: true },
  lost: { caller: 'lost', callee: 'lost', plain: false },
  'verify-failed': { caller: 'verifyFailed', callee: 'verifyFailed', plain: false },
  'connect-failed': { caller: 'connectFailed', callee: 'connectFailed', plain: false },
  'rate-limited': { caller: 'rateLimited', callee: 'rateLimited', plain: false },
  unavailable: { caller: 'unavailable', callee: 'unavailable', plain: false },
};

/** Problem words. A blocked speaker is not words: it is the tap that unblocks it. */
const PROBLEM: Record<Exclude<AudioCallProblem, 'speaker-blocked'>, CallProblemKey> = {
  'microphone-denied': 'microphoneDenied',
  'microphone-unavailable': 'microphoneUnavailable',
  offline: 'offline',
  'relay-unavailable': 'relayUnavailable',
  'cannot-connect': 'cannotConnect',
  'cannot-verify': 'cannotVerify',
};

/** The badge's order: what a person most needs to know first (someone else, a parent, an assistant), then their own devices.
 *  A Record, so a kind added to CallOtherDeviceKind does not compile until it has its place. */
const BADGE_RANK: Record<CallOtherDeviceKind, number> = { other: 0, guardian: 1, assistant: 2, theirs: 3, mine: 4 };

const isKnownKind = (kind: string): kind is CallOtherDeviceKind => Object.prototype.hasOwnProperty.call(BADGE_RANK, kind);

export interface CallBadgeEntry {
  readonly kind: CallOtherDeviceKind;
  readonly count: number;
}

export interface CallView {
  readonly stage: CallStage;
  /** The side this device is on; `caller` when it was never known (a call the engine found already ended). */
  readonly side: CallSide;
  readonly callId: string | null;
  readonly conversationId: string;
  /** The buttons: answer/decline on the ring, mute/hang up during the call, close once it ended. */
  readonly actions: 'ring' | 'call' | 'ended';
  readonly muted: boolean;
  /** Key under `end.` — only on `ended`. */
  readonly endKey: CallEndKey | null;
  /** Key under `problem.`, or null. */
  readonly problemKey: CallProblemKey | null;
  /** The browser would not play the other side: offer the tap that calls `resumeSpeaker()`. */
  readonly speakerBlocked: boolean;
  /** The person the call was verified with (`verifiedPeer.userId`), else null — then the chat names the call. */
  readonly verifiedUserId: string | null;
  /** Who else could listen, by kind. Empty: draw no badge. */
  readonly others: readonly CallBadgeEntry[];
  /** When the call first went live on this device (monotonic ms), for the elapsed time; null before. */
  readonly liveSince: number | null;
  /** The ended screen closes itself (a plain ending) or waits for «Close» (something went wrong — words to read). */
  readonly autoClose: boolean;
  /** The call's number on this device (`CallMemory.serial`). */
  readonly serial: number;
}

function stageOf(snapshot: AudioCallSnapshot, memory: CallMemory | null): CallStage | null {
  switch (snapshot.call.name) {
    case 'idle':
      return null;
    case 'inviting':
    case 'outgoing':
      return 'calling';
    case 'incoming':
      return 'ringing';
    case 'accepting':
    case 'connecting':
      return 'connecting';
    case 'verified':
      if (snapshot.live) return 'live';
      return memory?.liveSince != null ? 'reconnecting' : 'connecting';
    case 'ended':
      return 'ended';
  }
}

/** Every other device counts — the badge is the one surface that must always show them: a kind this build does not
 *  know (a newer runtime's) counts as someone else's, the most cautious reading, never as nothing. */
function badge(others: AudioCallSnapshot['others']): CallBadgeEntry[] {
  const counts = new Map<CallOtherDeviceKind, number>();
  for (const device of others) {
    const kind = isKnownKind(device.kind) ? device.kind : 'other';
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return [...counts].sort(([a], [b]) => BADGE_RANK[a] - BADGE_RANK[b]).map(([kind, count]) => ({ kind, count }));
}

/** What to show for this snapshot; null when nothing is up (`idle`). */
export function callView(snapshot: AudioCallSnapshot, memory: CallMemory | null): CallView | null {
  const stage = stageOf(snapshot, memory);
  const call = snapshot.call;
  if (stage === null || call.name === 'idle') return null;
  const side: CallSide = sideOf(call) ?? memory?.side ?? 'caller';
  const end = call.name === 'ended' ? END[call.reason] : null;
  const problem = snapshot.problem;
  const problemKey = problem && problem !== 'speaker-blocked' ? PROBLEM[problem] : null;
  return {
    stage,
    side,
    callId: 'callId' in call ? call.callId : null,
    conversationId: call.conversationId,
    actions: stage === 'ended' ? 'ended' : stage === 'ringing' ? 'ring' : 'call',
    muted: snapshot.muted,
    endKey: end ? end[side] : null,
    problemKey,
    speakerBlocked: problem === 'speaker-blocked' && stage !== 'ended',
    verifiedUserId: snapshot.verifiedPeer?.userId ?? null,
    others: badge(snapshot.others),
    liveSince: memory?.liveSince ?? null,
    autoClose: end !== null && end.plain && problemKey === null,
    serial: memory?.serial ?? 0,
  };
}

/**
 * What the folded pill cannot show in full and the person must see: who else could listen (the badge "always
 * shows"), a problem, the blocked speaker. Kept per call (`serial`).
 */
export interface CallAttention {
  readonly serial: number;
  /** The badge as one comparable string (`kind:count`, in the badge order); '' when nobody else. */
  readonly others: string;
  readonly problemKey: CallProblemKey | null;
  readonly speakerBlocked: boolean;
}

export function callAttention(view: CallView): CallAttention {
  return {
    serial: view.serial,
    others: view.others.map((entry) => `${entry.kind}:${entry.count}`).join(','),
    problemKey: view.problemKey,
    speakerBlocked: view.speakerBlocked,
  };
}

/**
 * Did something the person must see appear or change on this call since `before`? The badge when it first lists
 * someone or what it lists changes; a problem when it appears or turns into another; the blocked speaker when it turns
 * on. What stays the same is not news: a person who folds a call with the badge on screen has seen it. A new call
 * (another `serial`) starts from nothing.
 */
export function needsAttention(before: CallAttention | null, now: CallAttention): boolean {
  const seen = before !== null && before.serial === now.serial ? before : null;
  if (now.others !== '' && now.others !== (seen?.others ?? '')) return true;
  if (now.problemKey !== null && now.problemKey !== (seen?.problemKey ?? null)) return true;
  return now.speakerBlocked && !(seen?.speakerBlocked ?? false);
}

/** The elapsed time the way a call shows it: `m:ss`, `h:mm:ss` past the hour. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
