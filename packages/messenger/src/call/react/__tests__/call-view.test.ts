/**
 * What the call screen shows, read from the engine's snapshot. Pure: the stage, which side this
 * device is on (the machine's `ended` state no longer says), when the call first went live HERE, the end words by side,
 * the problem words, the badge — and the rule `docs/calls.md` sets: "connected" only once `live`, a name only once verified.
 */
import { describe, expect, it } from 'vitest';
import type { AudioCallState } from '../../audio-call-machine.js';
import type { AudioCallSnapshot } from '../../call-engine.js';
import { callAttention, callView, needsAttention, rememberCall, type CallMemory, type CallView } from '../call-view.js';

const CALL_ID = 'c0000000000000000000a1';
const ROOM = '6f1c2b1e-3a4d-4c5e-8f90-1a2b3c4d5e6f';
const PEER = { userId: '22222222-2222-4222-8222-222222222222', deviceId: 'dev-b' };

function snap(call: AudioCallState, over: Partial<AudioCallSnapshot> = {}): AudioCallSnapshot {
  return {
    call,
    muted: false,
    media: 'none',
    live: false,
    problem: null,
    others: [],
    verifiedPeer: null,
    controlOpen: false,
    ...over,
  };
}

const inviting: AudioCallState = { name: 'inviting', requestId: 'r1', conversationId: ROOM, localDeviceId: 'dev-a' };
const outgoing: AudioCallState = { name: 'outgoing', callId: CALL_ID, conversationId: ROOM, localDeviceId: 'dev-a', ringUntil: '2026-11-15T10:00:45.000Z' };
const incoming: AudioCallState = {
  name: 'incoming',
  callId: CALL_ID,
  conversationId: ROOM,
  callerUserId: PEER.userId,
  peerDeviceId: 'dev-b',
  ringUntil: '2026-11-15T10:00:45.000Z',
};
const accepting: AudioCallState = { ...incoming, name: 'accepting', localDeviceId: 'dev-a' } as AudioCallState;
const connecting = (role: 'caller' | 'callee'): AudioCallState => ({
  name: 'connecting',
  callId: CALL_ID,
  conversationId: ROOM,
  role,
  localDeviceId: 'dev-a',
  peerDeviceId: 'dev-b',
});
const verified = (role: 'caller' | 'callee'): AudioCallState => ({ ...connecting(role), name: 'verified' }) as AudioCallState;
const ended = (reason: Extract<AudioCallState, { name: 'ended' }>['reason']): AudioCallState => ({
  name: 'ended',
  callId: CALL_ID,
  conversationId: ROOM,
  reason,
});

/** Walk the snapshots in order, as the host's store would, and return the last memory. */
function walk(steps: readonly AudioCallSnapshot[], clock: readonly number[] = steps.map((_, i) => i * 1000)): CallMemory | null {
  let memory: CallMemory | null = null;
  steps.forEach((s, i) => {
    memory = rememberCall(memory, s, clock[i] ?? 0);
  });
  return memory;
}

describe('rememberCall — the side and the first live moment', () => {
  it('the caller side is known from the start, and survives into `ended`', () => {
    const steps = [snap(inviting), snap(outgoing), snap(ended('no-answer'))];
    expect(walk(steps)?.side).toBe('caller');
  });

  it('the callee side likewise', () => {
    expect(walk([snap(incoming), snap(ended('cancelled'))])?.side).toBe('callee');
  });

  it('records when the call first went live here, and keeps it through a reconnect', () => {
    const steps = [
      snap(connecting('caller')),
      snap(verified('caller'), { media: 'connected', live: true }),
      snap(verified('caller'), { media: 'connecting', live: false }),
      snap(verified('caller'), { media: 'connected', live: true }),
    ];
    expect(walk(steps, [0, 5_000, 9_000, 12_000])?.liveSince).toBe(5_000);
  });

  it('a new call after an ended one starts clean (no side, no live moment carried over)', () => {
    const memory = walk(
      [snap(verified('caller'), { media: 'connected', live: true }), snap(ended('hangup')), snap(incoming)],
      [0, 1_000, 2_000],
    );
    expect(memory?.side).toBe('callee');
    expect(memory?.liveSince).toBeNull();
  });

  it('idle forgets everything but the count of calls', () => {
    expect(walk([snap(outgoing), snap({ name: 'idle' })])).toEqual({ phase: 'idle', side: null, liveSince: null, serial: 1 });
  });

  it('every call gets the next number — after idle, after an ended one without idle — and keeps it to its end', () => {
    expect(walk([snap({ name: 'idle' })])?.serial).toBe(0);
    expect(walk([snap(inviting), snap(outgoing), snap(connecting('caller')), snap(ended('hangup'))])?.serial).toBe(1);
    expect(walk([snap(outgoing), snap({ name: 'idle' }), snap({ name: 'idle' }), snap(incoming)])?.serial).toBe(2);
    expect(walk([snap(outgoing), snap(ended('no-answer')), snap(incoming), snap(accepting)])?.serial).toBe(2);
  });

  it('the view carries the number, so the screen can keep per-call state (folded, closing, sounds)', () => {
    const memory = walk([snap(outgoing), snap(ended('no-answer')), snap(incoming)]);
    expect(callView(snap(incoming), memory)?.serial).toBe(2);
  });
});

describe('callView — the stage', () => {
  it('idle shows nothing', () => {
    expect(callView(snap({ name: 'idle' }), null)).toBeNull();
  });

  it.each([
    ['inviting', inviting, 'calling'],
    ['outgoing', outgoing, 'calling'],
    ['incoming', incoming, 'ringing'],
    ['accepting', accepting, 'connecting'],
    ['connecting', connecting('callee'), 'connecting'],
  ] as const)('%s → %s', (_name, state, stage) => {
    const s = snap(state);
    expect(callView(s, rememberCall(null, s, 0))?.stage).toBe(stage);
  });

  it('🔴 verified is NOT connected until `live` (the engine rule: neither `verified` nor `media` alone is enough)', () => {
    const notYet = snap(verified('caller'), { media: 'connected', live: false });
    expect(callView(notYet, rememberCall(null, notYet, 0))?.stage).toBe('connecting');
    const live = snap(verified('caller'), { media: 'connected', live: true });
    expect(callView(live, rememberCall(null, live, 0))?.stage).toBe('live');
  });

  it('a verified call that was live and lost its media path is reconnecting, not connecting', () => {
    const steps = [snap(verified('caller'), { media: 'connected', live: true }), snap(verified('caller'), { media: 'connecting' })];
    const memory = walk(steps);
    expect(callView(steps[1]!, memory)?.stage).toBe('reconnecting');
  });

  it('the ring offers answer/decline, a call mute/hang-up, an ended call a close', () => {
    expect(callView(snap(incoming), rememberCall(null, snap(incoming), 0))?.actions).toBe('ring');
    expect(callView(snap(outgoing), rememberCall(null, snap(outgoing), 0))?.actions).toBe('call');
    const s = snap(ended('hangup'));
    expect(callView(s, walk([snap(outgoing), s]))?.actions).toBe('ended');
  });
});

describe('callView — who is named', () => {
  it('🔴 before verification nobody is named: the ring is a claim the server made', () => {
    const s = snap(incoming);
    expect(callView(s, rememberCall(null, s, 0))?.verifiedUserId).toBeNull();
  });

  it('once verified, the person the MLS worker verified — never the ring’s `callerUserId`', () => {
    const s = snap(verified('callee'), { live: true, media: 'connected', verifiedPeer: PEER });
    expect(callView(s, rememberCall(null, s, 0))?.verifiedUserId).toBe(PEER.userId);
  });

  it('the verified person stays named on the ended screen', () => {
    const s = snap(ended('hangup'), { verifiedPeer: PEER });
    expect(callView(s, walk([snap(verified('caller'), { verifiedPeer: PEER, live: true }), s]))?.verifiedUserId).toBe(PEER.userId);
  });
});

describe('callView — how it ended, by side', () => {
  const endFor = (side: 'caller' | 'callee', reason: Parameters<typeof ended>[0]) => {
    const start = side === 'caller' ? snap(outgoing) : snap(incoming);
    const s = snap(ended(reason));
    return callView(s, walk([start, s]));
  };

  it.each([
    ['hangup', 'caller', 'ended'],
    ['hangup', 'callee', 'ended'],
    ['cancelled', 'caller', 'cancelled'],
    ['cancelled', 'callee', 'missed'],
    ['declined', 'caller', 'declined'],
    ['declined', 'callee', 'youDeclined'],
    ['no-answer', 'caller', 'noAnswer'],
    ['no-answer', 'callee', 'missed'],
    ['answered-elsewhere', 'callee', 'answeredElsewhere'],
    ['lost', 'caller', 'lost'],
    ['verify-failed', 'callee', 'verifyFailed'],
    ['connect-failed', 'caller', 'connectFailed'],
    ['rate-limited', 'caller', 'rateLimited'],
    ['unavailable', 'caller', 'unavailable'],
  ] as const)('%s, %s → end.%s', (reason, side, key) => {
    expect(endFor(side, reason)?.endKey).toBe(key);
  });

  it('🔴 busy, offline, blocked and ignored all reach the caller as ONE wording', () => {
    // The engine cannot tell them apart (they all arrive as `no-answer`); the words must not try.
    expect(endFor('caller', 'no-answer')?.endKey).toBe('noAnswer');
  });

  it('a plain ending closes itself; a failure waits to be read', () => {
    expect(endFor('caller', 'hangup')?.autoClose).toBe(true);
    expect(endFor('callee', 'no-answer')?.autoClose).toBe(true);
    expect(endFor('caller', 'verify-failed')?.autoClose).toBe(false);
    expect(endFor('caller', 'connect-failed')?.autoClose).toBe(false);
    expect(endFor('caller', 'rate-limited')?.autoClose).toBe(false);
  });

  it('an ending with a problem also waits to be read', () => {
    const s = snap(ended('hangup'), { problem: 'offline' });
    expect(callView(s, walk([snap(outgoing), s]))?.autoClose).toBe(false);
  });
});

describe('callView — problems and the speaker', () => {
  it.each([
    ['microphone-denied', 'microphoneDenied'],
    ['microphone-unavailable', 'microphoneUnavailable'],
    ['offline', 'offline'],
    ['relay-unavailable', 'relayUnavailable'],
    ['cannot-connect', 'cannotConnect'],
    ['cannot-verify', 'cannotVerify'],
  ] as const)('%s → problem.%s', (problem, key) => {
    const s = snap(incoming, { problem });
    expect(callView(s, rememberCall(null, s, 0))?.problemKey).toBe(key);
  });

  it('a blocked speaker is not a problem line: it is the tap that unblocks it', () => {
    const s = snap(verified('caller'), { live: true, media: 'connected', problem: 'speaker-blocked' });
    const view = callView(s, rememberCall(null, s, 0));
    expect(view?.speakerBlocked).toBe(true);
    expect(view?.problemKey).toBeNull();
  });
});

describe('callView — who else could listen', () => {
  it('counts the other devices by kind, the most telling first', () => {
    const s = snap(verified('caller'), {
      live: true,
      others: [
        { deviceId: 'd1', userId: 'u-me', kind: 'mine' },
        { deviceId: 'd2', userId: 'u-me', kind: 'mine' },
        { deviceId: 'd3', userId: 'assistant', kind: 'assistant' },
        { deviceId: 'd4', userId: 'u-parent', kind: 'guardian' },
      ],
    });
    expect(callView(s, rememberCall(null, s, 0))?.others).toEqual([
      { kind: 'guardian', count: 1 },
      { kind: 'assistant', count: 1 },
      { kind: 'mine', count: 2 },
    ]);
  });

  it('nobody else: an empty badge (the screen then draws none)', () => {
    const s = snap(verified('caller'), { live: true });
    expect(callView(s, rememberCall(null, s, 0))?.others).toEqual([]);
  });

  it('a kind this build does not know still shows — as someone else’s device, never dropped', () => {
    const s = snap(verified('caller'), {
      live: true,
      others: [
        { deviceId: 'd1', userId: 'u-x', kind: 'observer' as never }, // a kind added after this build
        { deviceId: 'd2', userId: 'u-y', kind: 'other' },
        { deviceId: 'd3', userId: 'u-me', kind: 'mine' },
      ],
    });
    expect(callView(s, rememberCall(null, s, 0))?.others).toEqual([
      { kind: 'other', count: 2 },
      { kind: 'mine', count: 1 },
    ]);
  });
});

describe('needsAttention — what a folded call unfolds for', () => {
  const view = (over: Partial<CallView> = {}): CallView => ({
    stage: 'live',
    side: 'caller',
    callId: CALL_ID,
    conversationId: ROOM,
    actions: 'call',
    muted: false,
    endKey: null,
    problemKey: null,
    speakerBlocked: false,
    verifiedUserId: PEER.userId,
    others: [],
    liveSince: 0,
    autoClose: false,
    serial: 1,
    ...over,
  });
  const at = (over: Partial<CallView> = {}) => callAttention(view(over));

  it('nothing to see: no', () => {
    expect(needsAttention(null, at())).toBe(false);
    expect(needsAttention(at(), at({ muted: true, stage: 'reconnecting' }))).toBe(false);
  });

  it('the badge: when it first has someone, and whenever who it lists changes — not while it stays the same', () => {
    const guardian = [{ kind: 'guardian', count: 1 }] as const;
    expect(needsAttention(at(), at({ others: guardian }))).toBe(true);
    expect(needsAttention(null, at({ others: guardian }))).toBe(true);
    expect(needsAttention(at({ others: guardian }), at({ others: guardian }))).toBe(false);
    expect(needsAttention(at({ others: guardian }), at({ others: [{ kind: 'guardian', count: 2 }] }))).toBe(true);
    expect(needsAttention(at({ others: guardian }), at({ others: [] }))).toBe(false);
  });

  it('a problem when it appears or turns into another; the blocked speaker when it turns on', () => {
    expect(needsAttention(at(), at({ problemKey: 'offline' }))).toBe(true);
    expect(needsAttention(at({ problemKey: 'offline' }), at({ problemKey: 'offline' }))).toBe(false);
    expect(needsAttention(at({ problemKey: 'offline' }), at({ problemKey: 'relayUnavailable' }))).toBe(true);
    expect(needsAttention(at({ problemKey: 'offline' }), at())).toBe(false);
    expect(needsAttention(at(), at({ speakerBlocked: true }))).toBe(true);
    expect(needsAttention(at({ speakerBlocked: true }), at({ speakerBlocked: true }))).toBe(false);
  });

  it('what the PREVIOUS call showed counts for nothing: a new call starts from scratch', () => {
    const before = at({ serial: 1, others: [{ kind: 'mine', count: 1 }], problemKey: 'offline', speakerBlocked: true });
    expect(needsAttention(before, at({ serial: 2, others: [{ kind: 'mine', count: 1 }] }))).toBe(true);
    expect(needsAttention(before, at({ serial: 2, problemKey: 'offline' }))).toBe(true);
    expect(needsAttention(before, at({ serial: 2, speakerBlocked: true }))).toBe(true);
  });
});