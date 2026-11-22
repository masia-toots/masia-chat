import type { CallEntryHint, CallRefusalKey, CallScreenText, CallScreenTextKey } from '@masia/messenger/call/react';

// The playground's words for a call, in English. Each table is a Record over the package's own key type,
// so a key the package adds does not compile here until it has its words.

/** A sentence that changes with a count: English has one form for 1 and one for everything else. */
export interface PluralText {
  readonly one: string;
  readonly other: string;
}

/** Every sentence of the call screen. `{{name}}` and `{{count}}` are filled from the screen's values. */
export const CALL_SCREEN_TEXTS: Readonly<Record<CallScreenTextKey, string | PluralText>> = {
  'stage.calling': 'Calling…',
  'stage.ringing': 'Incoming call',
  'stage.connecting': 'Connecting…',
  'stage.live': 'On a call',
  'stage.reconnecting': 'Connection lost, reconnecting…',
  'stage.ended': 'Call ended',
  'end.ended': 'Call ended',
  'end.cancelled': 'Call cancelled',
  'end.missed': 'Missed call',
  'end.declined': 'They declined the call',
  'end.youDeclined': 'You declined the call',
  'end.noAnswer': 'No answer',
  'end.answeredElsewhere': 'Answered on another device',
  'end.lost': 'The connection was lost',
  'end.verifyFailed': 'This call could not be verified, so it was ended. Nothing was played.',
  'end.connectFailed': 'The call could not connect',
  'end.rateLimited': 'Too many calls just now. Try again in a minute.',
  'end.unavailable': 'Calls are not available right now',
  'problem.microphoneDenied': 'The microphone is blocked. Allow it for this page and try again.',
  'problem.microphoneUnavailable': 'No microphone was found, or another app is using it.',
  'problem.offline': 'The call channel is not connected.',
  'problem.relayUnavailable':
    'This call needs a relay server for its audio, and the playground has none. Calls work between two tabs on this machine.',
  'problem.cannotConnect': 'The two browsers could not reach each other.',
  'problem.cannotVerify': 'The call could not be verified against the encrypted chat. Nothing was played.',
  'others.title': 'Others in this chat could also listen:',
  'others.other': { one: '{{count}} device of someone else', other: '{{count}} devices of someone else' },
  'others.guardian': { one: '{{count}} guardian device', other: '{{count}} guardian devices' },
  'others.assistant': { one: '{{count}} assistant device', other: '{{count}} assistant devices' },
  'others.theirs': { one: '{{count}} other device of theirs', other: '{{count}} other devices of theirs' },
  'others.mine': { one: '{{count}} other device of yours', other: '{{count}} other devices of yours' },
  unknownRoom: 'Encrypted chat',
  dialog: 'Call with {{name}}',
  answer: 'Answer',
  decline: 'Decline',
  cancel: 'Cancel',
  hangUp: 'Hang up',
  mute: 'Mute',
  minimise: 'Minimise the call',
  expand: 'Open the call',
  close: 'Close',
  verified: 'Verified through the encrypted chat',
  elapsed: 'Call time',
  'speaker.resume': 'Turn the sound on',
  'speaker.held': 'The browser held the sound back until you tap.',
  lockHint: 'Locking the screen or leaving the page ends the call.',
};

/** Why «Call» cannot be pressed now (`useCallEntry`'s hint). */
export const CALL_ENTRY_HINTS: Readonly<Record<CallEntryHint, string>> = {
  notReady: 'Calls are getting ready…',
  busy: 'You are already on a call.',
  offline: 'The call channel is not connected. Is it switched on in the relay?',
  microphoneDenied: 'The microphone is blocked for this page.',
  microphoneUnavailable: 'No microphone was found.',
};

/** Why a start was refused before any call began (`useCallEntry`'s `onRefused`). */
export const CALL_REFUSALS: Readonly<Record<CallRefusalKey, string>> = {
  disabled: 'Calls are off in this tab.',
  busy: 'You are already on a call.',
  offline: 'The call channel is not connected.',
  microphoneDenied: 'The microphone is blocked. Allow it for this page and try again.',
  microphoneUnavailable: 'No microphone was found, or another app is using it.',
  gone: 'This chat is gone.',
};

/** The words of the chat header's button. */
export const CALL_BUTTON_TEXT = { label: 'Call', title: 'Start an encrypted audio call' } as const;

const PLACEHOLDER = /\{\{(\w+)\}\}/g;
const plurals = new Intl.PluralRules('en');

/** Fills `{{name}}`-style placeholders; one with no value stays as written, so a missing value shows. */
export function fillText(text: string, vars?: Readonly<Record<string, string | number>>): string {
  return text.replace(PLACEHOLDER, (whole, name: string) => (vars?.[name] === undefined ? whole : String(vars[name])));
}

/** The call screen's `t`. */
export const callText: CallScreenText = (key, vars) => {
  const entry = CALL_SCREEN_TEXTS[key];
  if (typeof entry === 'string') return fillText(entry, vars);
  const count = Number(vars?.['count'] ?? 0);
  return fillText(plurals.select(count) === 'one' ? entry.one : entry.other, vars);
};
