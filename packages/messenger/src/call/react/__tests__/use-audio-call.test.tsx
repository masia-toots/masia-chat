// @vitest-environment jsdom
/**
 * `useAudioCallHost` — the tab's one engine, from the host's ports. Off (not allowed, or no binding) nothing is created,
 * held or asked for; on, one engine per binding pair, the host's signalling held around it, the screen held awake while
 * a call is up. The real engine runs over fake ports.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAudioCallMachine } from '../../audio-call-machine.js';
import type { CallBindingPort, CallEnginePorts } from '../../call-engine.js';
import { useAudioCall, useAudioCallHost, type AudioCallHostOptions } from '../use-audio-call.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const RING = {
  type: 'call:ring',
  payload: {
    callId: 'c0000000000000000000a1',
    conversationId: '6f1c2b1e-3a4d-4c5e-8f90-1a2b3c4d5e6f',
    callerUserId: '11111111-1111-4111-8111-111111111111',
    callerDeviceId: 'dev-a',
    ringUntil: new Date(Date.now() + 45_000).toISOString(),
  },
};
const END = { type: 'call:end', payload: { callId: RING.payload.callId, reason: 'cancelled' } };

const log: string[] = [];
let frames: ((raw: unknown) => void) | null = null;
const microphone = vi.fn(async () => new MediaStream());

function fakePorts(binding: CallBindingPort): CallEnginePorts {
  log.push('ports');
  return {
    socket: {
      send: () => true,
      isOpen: () => true,
      subscribe: (onFrame) => {
        frames = onFrame;
        return () => {
          log.push('unsubscribe');
          frames = null;
        };
      },
      onClosed: () => () => undefined,
    },
    iceServers: async () => ({ iceServers: [], iceTransportPolicy: 'all' }) as never,
    binding,
    microphone,
    createPeer: () => {
      throw new Error('no peer in this test');
    },
    speaker: { attach: async () => true, resume: async () => true, detach: () => undefined },
    localDeviceId: () => 'dev-b',
    newRequestId: () => 'r1',
    machine: createAudioCallMachine(),
  };
}

let root: Root;
let seen: ReturnType<typeof useAudioCall> = { engine: null, snapshot: null };
let options: AudioCallHostOptions;
const createPorts = vi.fn(fakePorts);
const holdSignalling = vi.fn(() => {
  log.push('hold');
  return () => log.push('release');
});
const holdScreen = vi.fn(() => {
  log.push('screen');
  return () => log.push('screen-release');
});

function Probe() {
  useAudioCallHost(options);
  seen = useAudioCall();
  return null;
}
const render = (): void => act(() => root.render(<Probe />));

const callTag = vi.fn();
const callVerify = vi.fn();

beforeEach(() => {
  log.length = 0;
  frames = null;
  for (const fn of [createPorts, holdSignalling, holdScreen, microphone]) fn.mockClear();
  options = { allowed: true, binding: { callTag, callVerify }, createPorts, holdSignalling, holdScreen };
  root = createRoot(document.createElement('div'));
});
afterEach(() => {
  act(() => root.unmount());
});

describe('useAudioCallHost', () => {
  it('not allowed, or no binding: nothing is created, held or asked for', () => {
    options = { ...options, allowed: false };
    render();
    options = { ...options, allowed: true, binding: null };
    render();
    expect(seen).toEqual({ engine: null, snapshot: null });
    expect(createPorts).not.toHaveBeenCalled();
    expect(holdSignalling).not.toHaveBeenCalled();
    expect(microphone).not.toHaveBeenCalled();
  });

  it('on: one engine over the host ports, the signalling held first; the binding it was given is the one passed in', () => {
    render();
    expect(seen.engine).not.toBeNull();
    expect(seen.snapshot?.call.name).toBe('idle');
    expect(log).toEqual(['hold', 'ports']);
    expect(createPorts).toHaveBeenCalledTimes(1);
    expect(createPorts.mock.calls[0]![0]).toBe(options.binding);
    expect(microphone).not.toHaveBeenCalled();
  });

  it('a new binding object with the same two functions keeps the engine; a new function makes a new one', () => {
    render();
    const first = seen.engine;
    options = { ...options, binding: { callTag, callVerify } };
    render();
    expect(seen.engine).toBe(first);
    expect(createPorts).toHaveBeenCalledTimes(1);
    options = { ...options, binding: { callTag: vi.fn(), callVerify } };
    render();
    expect(seen.engine).not.toBe(first);
    expect(createPorts).toHaveBeenCalledTimes(2);
    expect(log).toEqual(['hold', 'ports', 'unsubscribe', 'release', 'hold', 'ports']);
  });

  it('turning off disposes the engine, then lets the signalling go', () => {
    render();
    options = { ...options, allowed: false };
    render();
    expect(seen.engine).toBeNull();
    expect(log).toEqual(['hold', 'ports', 'unsubscribe', 'release']);
  });

  it('a call in progress outlives `allowed` going off; the engine goes once it is over', () => {
    render();
    act(() => frames?.(RING));
    const during = seen.engine;
    expect(seen.snapshot?.call.name).toBe('incoming');
    options = { ...options, allowed: false };
    render();
    expect(seen.engine).toBe(during);
    act(() => frames?.(END));
    expect(seen.engine).toBeNull();
    expect(log.filter((step) => step === 'release')).toHaveLength(1);
  });

  it('the screen is held awake from the ring to its end, once', () => {
    render();
    expect(holdScreen).not.toHaveBeenCalled();
    act(() => frames?.(RING));
    render();
    expect(holdScreen).toHaveBeenCalledTimes(1);
    act(() => frames?.(END));
    expect(log.filter((step) => step === 'screen-release')).toHaveLength(1);
  });

  it('returns the snapshot, for what the host decides from it (the ring sound)', () => {
    let returned: unknown = 'unset';
    function Returns() {
      returned = useAudioCallHost(options);
      return null;
    }
    act(() => root.render(<Returns />));
    act(() => frames?.(RING));
    expect((returned as { call: { name: string } } | null)?.call.name).toBe('incoming');
  });
});
