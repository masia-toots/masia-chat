// @vitest-environment jsdom
/**
 * `useCallEntry` with the host's parts given in: not offered → null and nothing asked (no permission read, no
 * signalling listener); offered → pressable or disabled with the reason, live as the signalling channel changes; a
 * refused start reaches the host's `onRefused` with a key, a cancelled one says nothing.
 */
import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupUi, flush, renderUi, type RenderedUi } from '../../../test-support/fake-ui.js';
import type { AudioCallState } from '../../audio-call-machine.js';
import type { AudioCallEngine, AudioCallResult, AudioCallSnapshot } from '../../call-engine.js';
import { useCallEntry, type CallEntryControl, type CallEntryOptions, type CallSignallingState } from '../use-call-entry.js';

const ROOM = '6f1c2b1e-3a4d-4c5e-8f90-1a2b3c4d5e6f';
const idle: AudioCallState = { name: 'idle' };
const snap = (call: AudioCallState, over: Partial<AudioCallSnapshot> = {}): AudioCallSnapshot => ({
  call,
  muted: false,
  media: 'none',
  live: false,
  problem: null,
  others: [],
  verifiedPeer: null,
  controlOpen: false,
  ...over,
});

let open = true;
const openListeners = new Set<(up: boolean) => void>();
const signalling: CallSignallingState = {
  isOpen: () => open,
  onOpenChange: (listener) => {
    openListeners.add(listener);
    return () => {
      openListeners.delete(listener);
    };
  },
};
let result: AudioCallResult = { ok: true };
const engine = { call: vi.fn(async () => result) } as unknown as AudioCallEngine & { call: ReturnType<typeof vi.fn> };
const onRefused = vi.fn();
let queries = 0;

let seen: CallEntryControl | null = null;
function Probe({ options }: { readonly options: CallEntryOptions }) {
  seen = useCallEntry(ROOM, options);
  return null;
}
let tree: RenderedUi | null = null;
const base = (): CallEntryOptions => ({ offered: true, engine, snapshot: snap(idle), signalling, onRefused });
async function show(options: CallEntryOptions): Promise<void> {
  const node = createElement(Probe, { options });
  if (tree) tree.rerender(node);
  else tree = renderUi(node);
  await flush();
}

beforeEach(() => {
  open = true;
  openListeners.clear();
  result = { ok: true };
  queries = 0;
  engine.call.mockClear();
  onRefused.mockClear();
  Object.defineProperty(navigator, 'permissions', {
    configurable: true,
    value: {
      query: async () => {
        queries += 1;
        return { state: 'prompt', addEventListener: () => undefined, removeEventListener: () => undefined };
      },
    },
  });
});
afterEach(() => {
  cleanupUi();
  tree = null;
  seen = null;
});

describe('useCallEntry', () => {
  it('not offered: null, and nothing asked — no permission read, no signalling listener', async () => {
    await show({ ...base(), offered: false });
    expect(seen).toBeNull();
    expect(queries).toBe(0);
    expect(openListeners.size).toBe(0);
  });

  it('offered and ready: pressable, nothing to say; pressing places the call in this room', async () => {
    await show(base());
    expect(seen).toMatchObject({ disabled: false, hint: null });
    seen!.start();
    expect(engine.call).toHaveBeenCalledWith(ROOM);
  });

  it('no engine yet: disabled, not ready', async () => {
    await show({ ...base(), engine: null, snapshot: null });
    expect(seen).toMatchObject({ disabled: true, hint: 'notReady' });
  });

  it('the signalling channel going down disables it, live', async () => {
    await show(base());
    act(() => {
      open = false;
      for (const listener of openListeners) listener(false);
    });
    expect(seen).toMatchObject({ disabled: true, hint: 'offline' });
  });

  it('a refused start reaches the host with its key; a cancelled one says nothing', async () => {
    await show(base());
    result = { ok: false, reason: 'microphone-denied' };
    seen!.start();
    await flush();
    expect(onRefused).toHaveBeenCalledWith('microphoneDenied');
    result = { ok: false, reason: 'cancelled' };
    seen!.start();
    await flush();
    expect(onRefused).toHaveBeenCalledTimes(1);
  });

  it('one object while what it says holds', async () => {
    await show(base());
    const first = seen;
    await show({ ...base(), snapshot: snap(idle, { muted: true }) });
    expect(seen).toBe(first);
  });
});
