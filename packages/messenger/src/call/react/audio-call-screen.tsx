/**
 * AudioCallScreen — the person-to-person audio call, on screen. Pure render: it reads a `CallView` (`call-view.ts`, the
 * one reading of the engine's snapshot) and calls back; the host component (`AudioCallHost`) owns the engine, the
 * sounds and the timers. Words and icons are the host's (`t`, `icon`): nothing here imports a UI kit or an i18n library.
 *
 * Styling: `audio-call.css` draws what is the call's own (the person's initial, the timer, the badge, the red button,
 * the folded pill). It stands on a full-screen dialog frame the host's stylesheet provides — the `esc*` classes and
 * their `--esc-*` palette, listed in `docs/calls.md` § The call screen — so the call looks like the host's other
 * full-screen calls.
 *
 * Top → bottom: the initial · the stage («Incoming call», «Calling…», «Call») · the NAME (the verified person, else the
 * chat — never a user id the server sent) · «Verified · end-to-end encrypted» once verified, and only under a name
 * (under «encrypted chat» it would vouch for nobody) · the elapsed time once live · the problem · «Turn the sound on»
 * and why it is needed (the browser held the sound) · who else could listen · the host's extra row · the buttons · the
 * lock hint.
 *
 * Keyboard: on a ring and on a call focus lands on the dialog ITSELF, never on a button — a ring arrives while the
 * person types, and their next Enter or Space must not answer (that opens the microphone) or hang up; Enter and Space on
 * the dialog do nothing. Answer is one Tab away. On the end, focus is on «Close» (harmless). Tab stays inside; Escape
 * folds a call or closes the end, and never declines or hangs up (that is a decision, not a key). Folded, the pill is no
 * dialog: it takes no focus and holds no key, the page under it is the person's again. It does not hide what it floats
 * over either: it says how far down it reaches (`PILL_CLEAR_VAR`), so a page can start its content under it.
 */
import { useEffect, useId, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { formatElapsed, type CallView } from './call-view.js';
import './audio-call.css';

/**
 * Every sentence the call screen asks for, by key. The host translates each one (the first host mounts them under
 * `call.` in its messenger namespace). `dialog` takes `{{name}}`; the `others.*` kinds take `{{count}}` and are plurals.
 */
export const CALL_SCREEN_TEXT_KEYS = [
  'stage.calling',
  'stage.ringing',
  'stage.connecting',
  'stage.live',
  'stage.reconnecting',
  'stage.ended',
  'end.ended',
  'end.cancelled',
  'end.missed',
  'end.declined',
  'end.youDeclined',
  'end.noAnswer',
  'end.answeredElsewhere',
  'end.lost',
  'end.verifyFailed',
  'end.connectFailed',
  'end.rateLimited',
  'end.unavailable',
  'problem.microphoneDenied',
  'problem.microphoneUnavailable',
  'problem.offline',
  'problem.relayUnavailable',
  'problem.cannotConnect',
  'problem.cannotVerify',
  'others.title',
  'others.other',
  'others.guardian',
  'others.assistant',
  'others.theirs',
  'others.mine',
  'unknownRoom',
  'dialog',
  'answer',
  'decline',
  'cancel',
  'hangUp',
  'mute',
  'minimise',
  'expand',
  'close',
  'verified',
  'elapsed',
  'speaker.resume',
  'speaker.held',
  'lockHint',
] as const;
export type CallScreenTextKey = (typeof CALL_SCREEN_TEXT_KEYS)[number];

/** The host's words: a finished sentence for a key, `vars` filling its named placeholders. */
export type CallScreenText = (key: CallScreenTextKey, vars?: Readonly<Record<string, string | number>>) => string;

/** Every icon the call screen draws. */
export const CALL_ICON_NAMES = ['phone', 'close', 'speaker', 'mic', 'mic-off', 'chevron', 'lock', 'headphones'] as const;
export type CallIconName = (typeof CALL_ICON_NAMES)[number];

/** The one turn the screen asks of an icon: the red buttons draw the handset laid down, turned 135° clockwise. */
export type CallIconTurn = 135;

/**
 * Draws one icon at a size in px, turned by `rotate` degrees when given. The screen styles an icon as an `svg` child in
 * one place (the badge's title), so an SVG element is the expected node.
 */
export type CallIconRenderer = (name: CallIconName, size: number, rotate?: CallIconTurn) => ReactNode;

export interface AudioCallScreenProps {
  readonly view: CallView;
  /** The verified person's name, else the chat's; null → the screen says «encrypted chat». */
  readonly name: string | null;
  /** Milliseconds since the call first went live on this device; null before. */
  readonly elapsedMs: number | null;
  /** Folded to the pill (the host decides; a ring is never folded). */
  readonly minimised: boolean;
  /** Say that locking the phone or leaving the app ends the call (the host knows when it is on a phone). */
  readonly lockHint: boolean;
  /** An answer to THIS ring is on its way (the microphone prompt, the server): «Answer» waits. «Decline» never does — a
   *  prompt nobody answers must not leave the person unable to turn the call down. */
  readonly answering: boolean;
  readonly onAnswer: () => void;
  readonly onDecline: () => void;
  readonly onHangUp: () => void;
  readonly onMute: (muted: boolean) => void;
  readonly onResumeSpeaker: () => void;
  readonly onMinimise: () => void;
  readonly onExpand: () => void;
  readonly onClose: () => void;
  readonly t: CallScreenText;
  readonly icon: CallIconRenderer;
  /**
   * A row of the host's own, drawn on the full screen of a ring or a call, under the badge and above the buttons (for
   * example an assistant joining the call). Absent: nothing is drawn there.
   */
  readonly extra?: ReactNode;
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * How far down the folded pill reaches — its bottom edge plus a breath, in px from the viewport's top — on `:root`
 * while it is on screen, and gone with it. What sits at the top of the page can start no higher than this, so the pill
 * never covers a chat's head or its first row.
 */
export const PILL_CLEAR_VAR = '--acall-pill-clear';
const PILL_BREATH_PX = 8;

/**
 * Publish `PILL_CLEAR_VAR` for the pill in `ref` while `on`. Read from the layout box (`offsetTop`), not the drawn
 * one: the pill slides in from above, and a clearance measured mid-slide would be short by the slide. Measured again
 * whenever the pill's size changes (a stage word that wraps on a phone makes it taller).
 */
function usePillClearance(ref: RefObject<HTMLElement | null>, on: boolean): void {
  useLayoutEffect(() => {
    const pill = ref.current;
    if (!on || !pill) return undefined;
    const root = document.documentElement.style;
    const publish = (): void => root.setProperty(PILL_CLEAR_VAR, `${Math.ceil(pill.offsetTop + pill.offsetHeight) + PILL_BREATH_PX}px`);
    publish();
    const watch = typeof ResizeObserver === 'function' ? new ResizeObserver(publish) : null;
    watch?.observe(pill);
    return () => {
      watch?.disconnect();
      root.removeProperty(PILL_CLEAR_VAR);
    };
  }, [ref, on]);
}

/** Is `el` in the call screen or its pill? The host gives focus back only from here (or from nowhere). */
export function inCallScreen(el: Element | null): boolean {
  return el?.closest('.acall, .acall-pill') != null;
}

/** The first letter a person would read as the name's — a whole grapheme (an accented letter, an emoji), never half. */
function initialOf(name: string): string {
  const Segmenter = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  const first = Segmenter ? new Segmenter(undefined, { granularity: 'grapheme' }).segment(name)[Symbol.iterator]().next().value?.segment : [...name][0];
  return (first ?? '').toLocaleUpperCase();
}

/** Keep Tab inside `root`: from the last control to the first and back; from the dialog itself, to either end. */
function trapTab(event: KeyboardEvent<HTMLElement>, root: HTMLElement | null): void {
  if (!root || event.key !== 'Tab') return;
  const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)];
  if (items.length === 0) return;
  const first = items[0]!;
  const last = items[items.length - 1]!;
  const at = document.activeElement;
  const fromOutside = at === root || !root.contains(at);
  if (event.shiftKey && (at === first || fromOutside)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (at === last || fromOutside)) {
    event.preventDefault();
    first.focus();
  }
}

export function AudioCallScreen(props: AudioCallScreenProps) {
  const { view, name, elapsedMs, minimised, lockHint, answering, t, icon } = props;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const pillRef = useRef<HTMLDivElement | null>(null);
  const heldId = useId();

  const shownName = name ?? t('unknownRoom');
  const label = t('dialog', { name: shownName });
  const timed = elapsedMs !== null && (view.stage === 'live' || view.stage === 'reconnecting');
  const time = timed ? formatElapsed(elapsedMs) : null;
  const ended = view.actions === 'ended';
  const endWords = ended && view.endKey ? t(`end.${view.endKey}`) : null;
  const hangUpWord = view.stage === 'calling' ? t('cancel') : t('hangUp');
  // Mute is a toggle: one name, its state in aria-pressed and in the look.
  const muteWord = t('mute');

  const pill = minimised && !(ended && !view.autoClose);
  usePillClearance(pillRef, pill);

  // Focus whenever the set of buttons changes (ring → call → end) or the screen unfolds — not on every stage, so a person
  // on «mute» is not pulled away when the call connects. A ring or a call: the dialog itself (nothing a stray key
  // presses). The end: «Close». The pill takes no focus: it was folded to get out of the way (the host gives focus back).
  useEffect(() => {
    if (pill) return;
    (ended ? closeRef.current : rootRef.current)?.focus({ preventScroll: true });
  }, [view.actions, pill, ended]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    // The dialog itself holds focus on a ring and a call: Enter and Space there press nothing (nor scroll the page).
    if (event.target === rootRef.current && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      return;
    }
    if (event.key === 'Escape') {
      if (view.actions === 'call') props.onMinimise();
      else if (ended) props.onClose();
      return;
    }
    trapTab(event, rootRef.current);
  };

  const face = (
    <span className={`acall__face${view.stage === 'ringing' ? ' acall__face--ringing' : ''}`} aria-hidden="true">
      {name ? initialOf(name) : icon('phone', 28)}
    </span>
  );
  // The mark of every red button (hang up, decline, the pill's): the handset laid down — the same handset turned 135°,
  // the common sign of a call ending — so it never reads as the green «Answer».
  const endGlyph = icon('phone', 20, 135);

  if (pill) {
    // The running time only while the call is live; any other stage says its word (reconnecting is news, not a clock).
    const state = endWords ?? (view.stage === 'live' && time !== null ? time : t(`stage.${view.stage}`));
    // Not a dialog: no focus taken, no Tab held, no Escape — the page under it is the person's again. What it cannot
    // carry (the badge, a problem's words) unfolds the call when it appears (the host); the blocked speaker's control
    // it does carry, so the sound is never one unfold away.
    return (
      <div className="esc acall-pill" role="group" aria-label={label} data-testid="call-pill" data-stage={view.stage} ref={pillRef}>
        <button type="button" className="acall-pill__open" onClick={props.onExpand} aria-label={t('expand')} data-testid="call-expand">
          {face}
          <span className="acall-pill__words">
            <span className="acall-pill__name" title={shownName}>{shownName}</span>
            <span className="acall-pill__state">{state}</span>
          </span>
        </button>
        {ended ? (
          <button type="button" className="acall-pill__btn" onClick={props.onClose} aria-label={t('close')} data-testid="call-close">
            {icon('close', 20)}
          </button>
        ) : (
          <>
            {view.speakerBlocked && (
              <button
                type="button"
                className="acall-pill__btn acall-pill__btn--on"
                onClick={props.onResumeSpeaker}
                aria-label={t('speaker.resume')}
                title={t('speaker.held')}
                data-testid="call-speaker"
              >
                {icon('speaker', 20)}
              </button>
            )}
            <button
              type="button"
              className={`acall-pill__btn${view.muted ? ' acall-pill__btn--on' : ''}`}
              onClick={() => props.onMute(!view.muted)}
              aria-label={muteWord}
              aria-pressed={view.muted}
              data-testid="call-mute"
            >
              {icon(view.muted ? 'mic-off' : 'mic', 20)}
            </button>
            <button type="button" className="acall-pill__btn acall-pill__btn--end" onClick={props.onHangUp} aria-label={hangUpWord} data-testid="call-hangup">
              {endGlyph}
            </button>
          </>
        )}
      </div>
    );
  }

  let buttons: ReactNode;
  if (view.actions === 'ring') {
    buttons = (
      <div className="esc__answers acall__answers">
        <button type="button" className="esc__btn esc__btn--done" onClick={props.onAnswer} disabled={answering} data-testid="call-answer">
          {icon('phone', 20)}
          {t('answer')}
        </button>
        <button type="button" className="esc__btn acall__btn--end" onClick={props.onDecline} data-testid="call-decline">
          {endGlyph}
          {t('decline')}
        </button>
      </div>
    );
  } else if (view.actions === 'call') {
    buttons = (
      <div className="esc__answers acall__answers">
        <button
          type="button"
          className={`esc__btn esc__btn--snooze${view.muted ? ' acall__btn--on' : ''}`}
          onClick={() => props.onMute(!view.muted)}
          aria-pressed={view.muted}
          data-testid="call-mute"
        >
          {icon(view.muted ? 'mic-off' : 'mic', 20)}
          {muteWord}
        </button>
        <button type="button" className="esc__btn acall__btn--end" onClick={props.onHangUp} data-testid="call-hangup">
          {endGlyph}
          {hangUpWord}
        </button>
      </div>
    );
  } else {
    buttons = (
      <div className="esc__answers acall__answers">
        <button type="button" className="esc__btn esc__btn--quiet" onClick={props.onClose} ref={closeRef} data-testid="call-close">
          {t('close')}
        </button>
      </div>
    );
  }

  return (
    <div
      className={`esc acall${ended ? ' esc--settled' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      tabIndex={-1}
      data-testid="call-screen"
      data-stage={view.stage}
      onKeyDown={onKeyDown}
      ref={rootRef}
    >
      {view.actions === 'call' && (
        <button type="button" className="acall__fold" onClick={props.onMinimise} aria-label={t('minimise')} data-testid="call-minimise">
          {icon('chevron', 20)}
        </button>
      )}
      <div className="esc__body acall__body">
        {face}
        <p className="esc__caller" data-testid="call-stage">{t(`stage.${view.stage}`)}</p>
        <h1 className="acall__name" title={shownName} data-testid="call-name">{shownName}</h1>
        {/* Under a name only: «Verified» under «encrypted chat» would vouch for nobody. */}
        {view.verifiedUserId && name !== null && !ended && (
          <p className="acall__verified" data-testid="call-verified">
            {icon('lock', 14)}
            {t('verified')}
          </p>
        )}
        {/* One name that never ticks; the clock is the content — a name that changed every second would be read again by
            a screen reader resting on it. */}
        {time !== null && (
          <p className="acall__time" role="timer" aria-label={t('elapsed')} data-testid="call-time">{time}</p>
        )}
        {endWords && <p className="esc__closing" data-testid="call-closing">{endWords}</p>}
        {view.problemKey && <p className="acall__problem" role="alert" data-testid="call-problem">{t(`problem.${view.problemKey}`)}</p>}
        {/* What the button does, in words that hold for a click and a tap; why it is there, under it. */}
        {view.speakerBlocked && (
          <>
            <button type="button" className="esc__silent" onClick={props.onResumeSpeaker} aria-describedby={heldId} data-testid="call-speaker">
              {t('speaker.resume')}
            </button>
            <p className="acall__held" id={heldId} data-testid="call-speaker-why">
              {t('speaker.held')}
            </p>
          </>
        )}
        {/* The badge comes when verification fills it: its live region is there before it, or a screen reader would not
            say it (a region that appears together with its words is not announced). */}
        <div className="acall__others-live" aria-live="polite" data-testid="call-badge-live">
          {view.others.length > 0 && (
            <section className="acall__others" role="note" data-testid="call-badge">
              <p className="acall__others-title">
                {icon('headphones', 16)}
                {t('others.title')}
              </p>
              <ul className="acall__others-list">
                {view.others.map((entry) => (
                  <li key={entry.kind}>{t(`others.${entry.kind}`, { count: entry.count })}</li>
                ))}
              </ul>
            </section>
          )}
        </div>
        {!ended && props.extra}
        {buttons}
        {lockHint && !ended && <p className="esc__hint" data-testid="call-lock-hint">{t('lockHint')}</p>}
      </div>
    </div>
  );
}
