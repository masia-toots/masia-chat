// @vitest-environment jsdom
/**
 * `AudioCallScreen` with a host's words and icons and nothing else: every word comes through `t` by a key the screen
 * lists (`CALL_SCREEN_TEXT_KEYS`), every icon through `icon` by a listed name; the host's extra row sits on a ring and
 * a call, never on the end; the keys a person types do not answer, decline or hang up.
 */
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanupUi, click, pressKey, q, renderUi } from '../../../test-support/fake-ui.js';
import type { CallEndReason } from '@masia/contracts/wire';
import type { AudioCallState } from '../../audio-call-machine.js';
import type { AudioCallSnapshot } from '../../call-engine.js';
import {
  AudioCallScreen,
  CALL_ICON_NAMES,
  CALL_SCREEN_TEXT_KEYS,
  type AudioCallScreenProps,
  type CallIconName,
  type CallIconTurn,
  type CallScreenText,
} from '../audio-call-screen.js';
import { callView, rememberCall, type CallView } from '../call-view.js';

const ROOM = '6f1c2b1e-3a4d-4c5e-8f90-1a2b3c4d5e6f';
const CALL_ID = 'c0000000000000000000a1';
const PEER = { userId: '22222222-2222-4222-8222-222222222222', deviceId: 'dev-b' };

const incoming: AudioCallState = { name: 'incoming', callId: CALL_ID, conversationId: ROOM, callerUserId: PEER.userId, peerDeviceId: 'dev-b', ringUntil: '2026-11-15T10:00:45.000Z' };
const outgoing: AudioCallState = { name: 'outgoing', callId: CALL_ID, conversationId: ROOM, localDeviceId: 'dev-a', ringUntil: '2026-11-15T10:00:45.000Z' };
const verified: AudioCallState = { name: 'verified', callId: CALL_ID, conversationId: ROOM, role: 'caller', localDeviceId: 'dev-a', peerDeviceId: 'dev-b' };
const ended = (reason: CallEndReason): AudioCallState => ({ name: 'ended', callId: CALL_ID, conversationId: ROOM, reason });

function snap(call: AudioCallState, over: Partial<AudioCallSnapshot> = {}): AudioCallSnapshot {
  return { call, muted: false, media: 'none', live: false, problem: null, others: [], verifiedPeer: null, controlOpen: false, ...over };
}
/** The view of `steps`' last snapshot, read in order (the side and the live moment are remembered). */
function viewOf(...steps: AudioCallSnapshot[]): CallView {
  let memory = null as ReturnType<typeof rememberCall> | null;
  for (const step of steps) memory = rememberCall(memory, step, 0);
  const view = callView(steps[steps.length - 1]!, memory);
  if (!view) throw new Error('no view');
  return view;
}

const keysAsked = new Set<string>();
const iconsAsked = new Set<string>();
const t: CallScreenText = (key, vars) => {
  keysAsked.add(key);
  return vars ? `${key} ${JSON.stringify(vars)}` : key;
};
const icon = vi.fn((name: CallIconName, size: number, rotate?: CallIconTurn) => {
  iconsAsked.add(name);
  return createElement('svg', { 'data-glyph': name, 'data-size': size, 'data-rotate': rotate ?? '' });
});

function props(view: CallView, over: Partial<AudioCallScreenProps> = {}): AudioCallScreenProps {
  return {
    view,
    name: 'Olia',
    elapsedMs: null,
    minimised: false,
    lockHint: false,
    answering: false,
    onAnswer: vi.fn(),
    onDecline: vi.fn(),
    onHangUp: vi.fn(),
    onMute: vi.fn(),
    onResumeSpeaker: vi.fn(),
    onMinimise: vi.fn(),
    onExpand: vi.fn(),
    onClose: vi.fn(),
    t,
    icon,
    ...over,
  };
}
const show = (p: AudioCallScreenProps) => renderUi(createElement(AudioCallScreen, p));

afterEach(() => {
  cleanupUi();
  icon.mockClear();
});

describe('AudioCallScreen — the host’s words and icons', () => {
  it('a ring: the stage, the name, answer and decline — in the host’s words', () => {
    show(props(viewOf(snap(incoming))));
    expect(q('[data-testid=call-stage]')?.textContent).toBe('stage.ringing');
    expect(q('[data-testid=call-name]')?.textContent).toBe('Olia');
    expect(q('[data-testid=call-answer]')?.textContent).toBe('answer');
    expect(q('[data-testid=call-decline]')?.textContent).toBe('decline');
    expect(q('[data-testid=call-screen]')?.getAttribute('aria-label')).toBe('dialog {"name":"Olia"}');
  });

  it('no name: the screen says the host’s `unknownRoom`, draws the handset for the initial and vouches for nobody', () => {
    show(props(viewOf(snap(verified, { live: true, media: 'connected', verifiedPeer: PEER })), { name: null }));
    expect(q('[data-testid=call-name]')?.textContent).toBe('unknownRoom');
    expect(q('.acall__face [data-glyph=phone]')?.getAttribute('data-size')).toBe('28');
    expect(q('[data-testid=call-verified]')).toBeNull();
  });

  it('every red button draws the handset laid down (turned 135°); answer draws it upright', () => {
    show(props(viewOf(snap(incoming))));
    expect(q('[data-testid=call-decline] svg')?.getAttribute('data-rotate')).toBe('135');
    expect(q('[data-testid=call-answer] svg')?.getAttribute('data-rotate')).toBe('');
  });

  it('the host’s extra row: on a ring and a call, above the buttons — never on the end', () => {
    const extra = createElement('p', { 'data-testid': 'host-extra' }, 'extra');
    const ring = show(props(viewOf(snap(incoming)), { extra }));
    const row = q('[data-testid=host-extra]');
    expect(row).not.toBeNull();
    expect(row?.nextElementSibling?.classList.contains('esc__answers')).toBe(true);
    ring.rerender(createElement(AudioCallScreen, props(viewOf(snap(outgoing)), { extra })));
    expect(q('[data-testid=host-extra]')).not.toBeNull();
    ring.rerender(createElement(AudioCallScreen, props(viewOf(snap(outgoing), snap(ended('hangup'))), { extra })));
    expect(q('[data-testid=host-extra]')).toBeNull();
  });

  it('no extra: nothing is drawn in its place', () => {
    show(props(viewOf(snap(incoming))));
    expect(q('.esc__answers')?.previousElementSibling?.getAttribute('data-testid')).toBe('call-badge-live');
  });

  it('Enter and Space on the dialog press nothing; Escape folds a call and never hangs up', () => {
    const p = props(viewOf(snap(outgoing)));
    show(p);
    const dialog = q('[data-testid=call-screen]');
    pressKey(dialog, 'Enter');
    pressKey(dialog, ' ');
    pressKey(dialog, 'Escape');
    expect(p.onHangUp).not.toHaveBeenCalled();
    expect(p.onMinimise).toHaveBeenCalledTimes(1);
  });

  it('the commands reach the host', () => {
    const p = props(viewOf(snap(incoming)));
    show(p);
    click(q('[data-testid=call-answer]'));
    click(q('[data-testid=call-decline]'));
    expect(p.onAnswer).toHaveBeenCalledTimes(1);
    expect(p.onDecline).toHaveBeenCalledTimes(1);
  });

  it('every word it asks for is a listed key, and every icon a listed name — across every frame it can draw', () => {
    keysAsked.clear();
    iconsAsked.clear();
    const reasons: CallEndReason[] = ['hangup', 'cancelled', 'declined', 'no-answer', 'answered-elsewhere', 'lost', 'verify-failed', 'connect-failed', 'rate-limited', 'unavailable'];
    const problems = ['microphone-denied', 'microphone-unavailable', 'offline', 'relay-unavailable', 'cannot-connect', 'cannot-verify', 'speaker-blocked'] as const;
    const others = (['mine', 'theirs', 'guardian', 'assistant', 'other'] as const).map((kind, i) => ({ kind, deviceId: `d${i}` }));
    const live = snap(verified, { live: true, media: 'connected', verifiedPeer: PEER, others: others as never });
    const frames: Array<[CallView, Partial<AudioCallScreenProps>]> = [
      [viewOf(snap(incoming)), { lockHint: true }],
      [viewOf(snap(outgoing)), {}],
      [viewOf(snap(outgoing), snap(verified)), {}],
      [viewOf(live), { elapsedMs: 61_000 }],
      [viewOf(live, snap(verified, { media: 'connecting', verifiedPeer: PEER })), { elapsedMs: 61_000 }],
      [viewOf(live), { minimised: true, elapsedMs: 5_000 }],
      [viewOf(snap(verified, { live: true, media: 'connected', muted: true, problem: 'speaker-blocked' })), { minimised: true }],
      ...problems.map((problem): [CallView, Partial<AudioCallScreenProps>] => [viewOf(snap(outgoing, { problem })), {}]),
      ...reasons.flatMap((reason): Array<[CallView, Partial<AudioCallScreenProps>]> => [
        [viewOf(snap(outgoing), snap(ended(reason))), {}],
        [viewOf(snap(incoming), snap(ended(reason))), {}],
        [viewOf(snap(outgoing), snap(ended(reason))), { minimised: true }],
      ]),
      [viewOf(snap(outgoing), snap(ended('lost'))), { minimised: true, name: null }],
    ];
    for (const [view, over] of frames) {
      const shown = show(props(view, over));
      shown.unmount();
    }
    const listed = new Set<string>(CALL_SCREEN_TEXT_KEYS);
    expect([...keysAsked].filter((key) => !listed.has(key))).toEqual([]);
    expect([...listed].filter((key) => !keysAsked.has(key))).toEqual([]);
    expect([...iconsAsked].filter((name) => !(CALL_ICON_NAMES as readonly string[]).includes(name))).toEqual([]);
    expect(CALL_ICON_NAMES.filter((name) => !iconsAsked.has(name))).toEqual([]);
  });
});
