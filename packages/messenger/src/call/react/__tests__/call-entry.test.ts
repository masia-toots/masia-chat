/**
 * The way into a call — «Call» in a 1:1 encrypted chat: when it is offered at all is the host's (calls allowed, the
 * room qualifies); whether it can be pressed NOW, and the honest reason when not, is this.
 */
import { describe, expect, it } from 'vitest';
import { callEntryState, callRefusalKey, type CallEntryInput } from '../call-entry.js';

const READY: CallEntryInput = { engine: true, busy: false, online: true, microphone: 'prompt', lastProblem: null };

describe('callEntryState', () => {
  it('ready: pressable, nothing to say', () => {
    expect(callEntryState(READY)).toEqual({ disabled: false, hintKey: null });
    expect(callEntryState({ ...READY, microphone: 'granted' })).toEqual({ disabled: false, hintKey: null });
  });

  it.each([
    ['no engine yet (this device cannot verify a call)', { engine: false }, 'notReady'],
    ['a call is already up here', { busy: true }, 'busy'],
    ['no connection', { online: false }, 'offline'],
    ['the microphone is blocked for this site', { microphone: 'denied' }, 'microphoneDenied'],
  ] as const)('%s → disabled, says why', (_name, over, hintKey) => {
    expect(callEntryState({ ...READY, ...over })).toEqual({ disabled: true, hintKey });
  });

  it('the first reason that matters wins: not ready, then busy, then offline, then the microphone', () => {
    expect(callEntryState({ engine: false, busy: true, online: false, microphone: 'denied', lastProblem: null }).hintKey).toBe('notReady');
    expect(callEntryState({ ...READY, busy: true, online: false, microphone: 'denied' }).hintKey).toBe('busy');
    expect(callEntryState({ ...READY, online: false, microphone: 'denied' }).hintKey).toBe('offline');
  });

  it('the last try found no microphone: still pressable (it may be plugged in now), and it says what happened', () => {
    expect(callEntryState({ ...READY, lastProblem: 'microphone-unavailable' })).toEqual({ disabled: false, hintKey: 'microphoneUnavailable' });
  });

  it('the last try was refused the microphone but the browser cannot say it still is: pressable, with the hint', () => {
    expect(callEntryState({ ...READY, microphone: 'unknown', lastProblem: 'microphone-denied' })).toEqual({
      disabled: false,
      hintKey: 'microphoneDenied',
    });
  });
});

describe('callRefusalKey — what a refused call() says (a toast: the call never reached the screen)', () => {
  it.each([
    ['disabled', 'disabled'],
    ['busy', 'busy'],
    ['offline', 'offline'],
    ['microphone-denied', 'microphoneDenied'],
    ['microphone-unavailable', 'microphoneUnavailable'],
    ['not-ringing', 'gone'],
    ['gone', 'gone'],
  ] as const)('%s → call.refused.%s', (reason, key) => {
    expect(callRefusalKey(reason)).toBe(key);
  });

  it('cancelled says nothing — the start was stopped on purpose, there is nothing to tell', () => {
    expect(callRefusalKey('cancelled')).toBeNull();
  });
});
