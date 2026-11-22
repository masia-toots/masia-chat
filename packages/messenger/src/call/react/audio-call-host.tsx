/**
 * AudioCallHost — the person-to-person audio call on screen, with everything the screen (`AudioCallScreen`, a pure
 * render) does not own. Mount it ONCE, high in the app, so a ring reaches the person on any page, and keep it mounted:
 * it renders nothing while there is no engine or no call, and keeps its per-call state (the fold, the sounds, where
 * focus was) across renders.
 *
 * What it owns:
 *   - the elapsed time, counted from when the call went live on this device;
 *   - the fold (per call: a new call opens unfolded; a folded call unfolds when something the person must see appears or
 *     changes — the badge of who else could listen, a problem, the blocked speaker);
 *   - «Answer» waiting for its own ring's answer only;
 *   - the closing beat (a plain end closes itself after `CALL_CLOSING_MS`, a failure waits to be read);
 *   - the focus (back where it was when the call is folded or over);
 *   - the cues: connected, a plain end, a failed end — only for a call this device took part in (placed it, or answered
 *     it: a ring that ended unanswered is its own sign, it stops), and none while `quiet`.
 *
 * What the host gives: the engine and the read view (`useAudioCall` → `useCallView`), the name to show, the words and
 * the icons, the layer the screen is drawn in, and whether to show the lock hint. The ring's sound, the room directory
 * and the push plumbing are the host's own.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react';
import type { AudioCallEngine, AudioCallSnapshot } from '../call-engine.js';
import { AudioCallScreen, inCallScreen, type CallIconRenderer, type CallScreenText } from './audio-call-screen.js';
import { callAttention, callView, needsAttention, rememberCall, type CallAttention, type CallMemory, type CallView } from './call-view.js';

/** How long a plain ending («Call ended», «No answer») stays before it closes itself. */
export const CALL_CLOSING_MS = 2_500;
/** The elapsed time's tick. */
const CLOCK_TICK_MS = 1_000;

/**
 * The snapshot read for the screen, with the memory it needs across snapshots (the side, the live moment, the call's
 * number). `rememberCall` is idempotent for one snapshot, so a repeated render cannot move it. Call it once, in the
 * component that keeps the host mounted.
 */
export function useCallView(snapshot: AudioCallSnapshot | null): CallView | null {
  const memory = useRef<CallMemory | null>(null);
  return useMemo(() => {
    if (!snapshot) return null;
    memory.current = rememberCall(memory.current, snapshot, performance.now());
    return callView(snapshot, memory.current);
  }, [snapshot]);
}

/** Milliseconds since the call went live here, ticking while it is up; null before (and after). */
function useElapsed(view: CallView | null): number | null {
  const since = view && (view.stage === 'live' || view.stage === 'reconnecting') ? view.liveSince : null;
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    if (since === null) return undefined;
    setNow(performance.now());
    const tick = window.setInterval(() => setNow(performance.now()), CLOCK_TICK_MS);
    return () => window.clearInterval(tick);
  }, [since]);
  return since === null ? null : Math.max(0, now - since);
}

/** The host's short sounds for a call's turns. */
export interface CallCues {
  /** The call went live. */
  readonly connected: () => void;
  /** A call this device took part in ended plainly (hung up, declined, cancelled). */
  readonly ended: () => void;
  /** A call this device took part in ended because something went wrong. */
  readonly failed: () => void;
}

interface CueMark {
  serial: number;
  /** This device took part: placed the call, or answered it (the actions went to mute / hang up). */
  joined: boolean;
  live: boolean;
  ended: boolean;
}

/** The connected / ended cues, once each per call. */
function useCallCues(view: CallView | null, quiet: boolean, cues: CallCues | undefined): void {
  const mark = useRef<CueMark | null>(null);
  const latest = useRef(cues);
  latest.current = cues;
  useEffect(() => {
    if (!view) return;
    if (mark.current?.serial !== view.serial) mark.current = { serial: view.serial, joined: false, live: false, ended: false };
    const m = mark.current;
    if (view.actions === 'call') m.joined = true;
    if (view.stage === 'live' && !m.live) {
      m.live = true;
      if (!quiet) latest.current?.connected();
    }
    if (view.stage === 'ended' && !m.ended) {
      m.ended = true;
      if (!quiet && m.joined) {
        if (view.autoClose) latest.current?.ended();
        else latest.current?.failed();
      }
    }
  }, [view, quiet]);
}

/** The layer the screen is drawn in: a full-screen stacking frame of the host's, above its pages. */
export type CallLayer = ComponentType<{ readonly children: ReactNode }>;

export interface AudioCallHostProps {
  /** The tab's engine (`useAudioCall().engine`); null: calls are off, nothing is drawn. */
  readonly engine: AudioCallEngine | null;
  /** The read snapshot (`useCallView(useAudioCall().snapshot)`); null: no call, nothing is drawn. */
  readonly view: CallView | null;
  /** The verified person's name, else the chat's; null → the screen says `unknownRoom`. Never a user id the server sent. */
  readonly name: string | null;
  readonly t: CallScreenText;
  readonly icon: CallIconRenderer;
  /** Wraps the screen (the host's full-screen layer). Absent: the screen is rendered as is. */
  readonly layer?: CallLayer;
  /** Say that locking the phone or leaving the app ends the call (true on a phone). Default false. */
  readonly lockHint?: boolean;
  /** No cues now (the person's quiet hours). Default false. */
  readonly quiet?: boolean;
  /** The cues; absent: none. */
  readonly cues?: CallCues;
  /** A row of the host's own on the full screen of a ring or a call (`AudioCallScreenProps.extra`). */
  readonly extra?: ReactNode;
}

export function AudioCallHost({ engine, view, name, t, icon, layer: Layer, lockHint = false, quiet = false, cues, extra }: AudioCallHostProps) {
  const elapsedMs = useElapsed(view);
  useCallCues(view, quiet, cues);

  // Folded per call: the call's number is what is folded, so the next call opens unfolded; a ring never folds.
  const [foldedSerial, setFoldedSerial] = useState<number | null>(null);
  const minimised = view !== null && view.actions !== 'ring' && foldedSerial === view.serial;

  // The pill cannot carry the badge, a problem's words or the tap that lets the sound through: when one of them appears
  // or changes on this call, the call unfolds once (`needsAttention`). What the person saw before folding stays folded.
  const attention = useRef<CallAttention | null>(null);
  useEffect(() => {
    if (!view) {
      attention.current = null;
      return;
    }
    const now = callAttention(view);
    const news = needsAttention(attention.current, now);
    attention.current = now;
    if (news && view.actions === 'call' && foldedSerial === view.serial) setFoldedSerial(null);
  }, [view, foldedSerial]);

  // The call being answered, by its number: an answer that never settles (a microphone prompt nobody answers) holds
  // only its own ring's «Answer», never the next call's. Decline never waits (the screen).
  const [answeringSerial, setAnsweringSerial] = useState<number | null>(null);
  const ringSerial = view?.actions === 'ring' ? view.serial : null;
  const onAnswer = useCallback(() => {
    if (!engine || ringSerial === null) return;
    setAnsweringSerial(ringSerial);
    // A refusal needs no words here: the microphone's and the network's show on the ring (`problem`), and a ring that
    // is gone has moved the screen on by itself.
    void engine.answer().finally(() => setAnsweringSerial((at) => (at === ringSerial ? null : at)));
  }, [engine, ringSerial]);

  // The closing beat of a plain end, per call.
  const closing = view?.actions === 'ended' && view.autoClose ? view.serial : null;
  useEffect(() => {
    if (!engine || closing === null) return undefined;
    const timer = window.setTimeout(() => engine.dismiss(), CALL_CLOSING_MS);
    return () => window.clearTimeout(timer);
  }, [engine, closing]);

  // Focus: remembered when the screen opens (before the screen takes it — a layout effect runs first),
  // given back when the call is folded or over — only if the call held it or it went with the call: a person who folded
  // the call and moved on keeps their place.
  const open = view !== null;
  const returnTo = useRef<HTMLElement | null>(null);
  const giveFocusBack = useCallback(() => {
    const target = returnTo.current;
    const at = document.activeElement;
    const lost = at === null || at === document.body || inCallScreen(at);
    if (lost && target?.isConnected) target.focus({ preventScroll: true });
  }, []);
  useLayoutEffect(() => {
    if (open) {
      const at = document.activeElement;
      returnTo.current = at instanceof HTMLElement && at !== document.body ? at : null;
      return;
    }
    giveFocusBack();
    returnTo.current = null;
  }, [open, giveFocusBack]);
  useEffect(() => {
    if (minimised) giveFocusBack();
  }, [minimised, giveFocusBack]);

  if (!engine || !view) return null;
  const screen = (
    <AudioCallScreen
      view={view}
      name={name}
      elapsedMs={elapsedMs}
      minimised={minimised}
      lockHint={lockHint}
      answering={ringSerial !== null && answeringSerial === ringSerial}
      onAnswer={onAnswer}
      onDecline={() => engine.decline()}
      onHangUp={() => engine.hangUp()}
      onMute={(muted) => engine.setMuted(muted)}
      onResumeSpeaker={() => void engine.resumeSpeaker()}
      onMinimise={() => setFoldedSerial(view.serial)}
      onExpand={() => setFoldedSerial(null)}
      onClose={() => engine.dismiss()}
      t={t}
      icon={icon}
      extra={extra}
    />
  );
  return Layer ? <Layer>{screen}</Layer> : screen;
}
