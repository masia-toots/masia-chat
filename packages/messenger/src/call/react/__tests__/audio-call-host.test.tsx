// @vitest-environment jsdom
/**
 * `AudioCallHost` without any host around it but a stand-in engine: nothing drawn without an engine and a call; the
 * host's layer wraps the screen; the commands reach the engine; a plain end closes itself after `CALL_CLOSING_MS`, a
 * failure waits; the cues — connected, a plain end, a failed end — once each, only for a call this device took part in,
 * none while quiet; a folded call unfolds when the badge appears.
 */
import { act, createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupUi, click, q, renderUi, type RenderedUi } from '../../../test-support/fake-ui.js';
import type { CallEndReason } from '@masia/contracts/wire';
import type { AudioCallState } from '../../audio-call-machine.js';
import type { AudioCallEngine, AudioCallSnapshot } from '../../call-engine.js';
import { AudioCallHost, CALL_CLOSING_MS, useCallView, type AudioCallHostProps, type CallCues } from '../audio-call-host.js';

const ROOM = '6f1c2b1e-3a4d-4c5e-8f90-1a2b3c4d5e6f';
const CALL_ID = 'c0000000000000000000a1';
const PEER = { userId: '22222222-2222-4222-8222-222222222222', deviceId: 'dev-b' };
const incoming: AudioCallState = { name: 'incoming', callId: CALL_ID, conversationId: ROOM, callerUserId: PEER.userId, peerDeviceId: 'dev-b', ringUntil: '2026-11-15T10:00:45.000Z' };
const outgoing: AudioCallState = { name: 'outgoing', callId: CALL_ID, conversationId: ROOM, localDeviceId: 'dev-a', ringUntil: '2026-11-15T10:00:45.000Z' };
const verified: AudioCallState = { name: 'verified', callId: CALL_ID, conversationId: ROOM, role: 'caller', localDeviceId: 'dev-a', peerDeviceId: 'dev-b' };
const ended = (reason: CallEndReason): AudioCallState => ({ name: 'ended', callId: CALL_ID, conversationId: ROOM, reason });
const idle: AudioCallState = { name: 'idle' };

function snap(call: AudioCallState, over: Partial<AudioCallSnapshot> = {}): AudioCallSnapshot {
  return { call, muted: false, media: 'none', live: false, problem: null, others: [], verifiedPeer: null, controlOpen: false, ...over };
}
const live = (over: Partial<AudioCallSnapshot> = {}) => snap(verified, { media: 'connected', live: true, verifiedPeer: PEER, ...over });

const engine = {
  answer: vi.fn(async () => ({ ok: true }) as const),
  decline: vi.fn(),
  hangUp: vi.fn(),
  setMuted: vi.fn(),
  resumeSpeaker: vi.fn(async () => true),
  dismiss: vi.fn(),
} as unknown as AudioCallEngine & { [K in 'answer' | 'decline' | 'hangUp' | 'setMuted' | 'dismiss']: ReturnType<typeof vi.fn> };

const cues: CallCues & { [K in keyof CallCues]: ReturnType<typeof vi.fn> } = { connected: vi.fn(), ended: vi.fn(), failed: vi.fn() };

function Layer({ children }: { readonly children: ReactNode }) {
  return createElement('div', { 'data-testid': 'host-layer' }, children);
}

type Over = Partial<Omit<AudioCallHostProps, 'view'>>;
/** The host as an app mounts it: the snapshot read with `useCallView` in the component that keeps it mounted. */
function App({ snapshot, over }: { readonly snapshot: AudioCallSnapshot | null; readonly over: Over }) {
  const view = useCallView(snapshot);
  return createElement(AudioCallHost, {
    engine,
    view,
    name: 'Olia',
    t: (key: string) => key,
    icon: () => null,
    layer: Layer,
    cues,
    ...over,
  });
}

let tree: RenderedUi | null = null;
function show(snapshot: AudioCallSnapshot | null, over: Over = {}): void {
  const node = createElement(App, { snapshot, over });
  if (tree) tree.rerender(node);
  else tree = renderUi(node);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  for (const fn of [engine.answer, engine.decline, engine.hangUp, engine.setMuted, engine.dismiss, cues.connected, cues.ended, cues.failed]) fn.mockClear();
});
afterEach(() => {
  cleanupUi();
  tree = null;
  vi.useRealTimers();
});

describe('AudioCallHost', () => {
  it('nothing without an engine or a call', () => {
    show(snap(incoming), { engine: null });
    expect(q('[data-testid=call-screen]')).toBeNull();
    show(snap(idle));
    expect(q('[data-testid=call-screen]')).toBeNull();
    expect(q('[data-testid=host-layer]')).toBeNull();
  });

  it('a ring, inside the host’s layer; the commands reach the engine', async () => {
    show(snap(incoming));
    expect(q('[data-testid=host-layer] [data-testid=call-screen]')).not.toBeNull();
    click(q('[data-testid=call-decline]'));
    expect(engine.decline).toHaveBeenCalledTimes(1);
    click(q('[data-testid=call-answer]'));
    expect(engine.answer).toHaveBeenCalledTimes(1);
    // The answer settles: «Answer» waits no more.
    await act(async () => {
      await Promise.resolve();
    });
    expect(q<HTMLButtonElement>('[data-testid=call-answer]')?.disabled).toBe(false);
  });

  it('no layer given: the screen is drawn as is', () => {
    show(snap(incoming), { layer: undefined });
    expect(q('[data-testid=host-layer]')).toBeNull();
    expect(q('[data-testid=call-screen]')).not.toBeNull();
  });

  it('a plain end closes itself after the closing beat; a failure waits for «Close»', () => {
    show(snap(outgoing));
    show(snap(ended('hangup')));
    vi.advanceTimersByTime(CALL_CLOSING_MS - 1);
    expect(engine.dismiss).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(engine.dismiss).toHaveBeenCalledTimes(1);

    show(snap(idle));
    show(snap(outgoing));
    show(snap(ended('connect-failed')));
    vi.advanceTimersByTime(CALL_CLOSING_MS * 4);
    expect(engine.dismiss).toHaveBeenCalledTimes(1);
  });

  it('the cues: connected, then a plain end — once each', () => {
    show(snap(outgoing));
    show(live());
    show(live({ muted: true }));
    expect(cues.connected).toHaveBeenCalledTimes(1);
    show(snap(ended('hangup')));
    expect(cues.ended).toHaveBeenCalledTimes(1);
    expect(cues.failed).not.toHaveBeenCalled();
  });

  it('a failed end sounds the failure', () => {
    show(snap(outgoing));
    show(snap(ended('lost')));
    expect(cues.failed).toHaveBeenCalledTimes(1);
    expect(cues.ended).not.toHaveBeenCalled();
  });

  it('a ring that ended unanswered sounds nothing (it stops, that is its sign)', () => {
    show(snap(incoming));
    show(snap(ended('cancelled')));
    expect(cues.ended).not.toHaveBeenCalled();
    expect(cues.failed).not.toHaveBeenCalled();
  });

  it('quiet: no cues at all', () => {
    show(snap(outgoing), { quiet: true });
    show(live(), { quiet: true });
    show(snap(ended('hangup')), { quiet: true });
    expect(cues.connected).not.toHaveBeenCalled();
    expect(cues.ended).not.toHaveBeenCalled();
  });

  it('folded, the call unfolds when the badge of who else could listen appears', () => {
    show(live());
    click(q('[data-testid=call-minimise]'));
    expect(q('[data-testid=call-pill]')).not.toBeNull();
    show(live({ others: [{ kind: 'other', deviceId: 'dev-x' }] as never }));
    expect(q('[data-testid=call-pill]')).toBeNull();
    expect(q('[data-testid=call-badge]')).not.toBeNull();
  });

  it('the lock hint and the extra row come from the host', () => {
    show(snap(incoming), { lockHint: true, extra: createElement('p', { 'data-testid': 'host-extra' }) });
    expect(q('[data-testid=call-lock-hint]')?.textContent).toBe('lockHint');
    expect(q('[data-testid=host-extra]')).not.toBeNull();
  });
});
