import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CALL_RELAY_PATH, type CallClientEvent } from '@masia/contracts/wire';
import type { CallBindingPort, RelayCallSocket, RelayCallSocketOptions } from '@masia/messenger/call';
import { ICE_LOOPBACK, ICE_NO_ROUTE } from './call-ice.js';
import { createCallChannel, createPlaygroundCallPorts, OPEN_POLL_MS, RELEASE_GRACE_MS } from './call-ports.js';

// The call channel and the engine's ports over a fake relay adapter: what the playground asks of the
// adapter (its options), when it opens and closes the one socket, and what «Call» hears about it. One
// case runs the package's real adapter against a relay with its call channel switched off.

const RELAY_URL = 'http://localhost:8080/relay';
const SELF_DEVICE = 'dev-self';
const HTTP_NOT_FOUND = 404;
/** Twice the adapter's default backoff ceiling (30 s): a retry, if there were one, would have come by then. */
const PAST_LONGEST_BACKOFF_MS = 60_000;

interface FakeSocket extends RelayCallSocket {
  readonly options: RelayCallSocketOptions;
  open: boolean;
  closed: boolean;
  readonly sent: CallClientEvent[];
  /** The adapter's own close announcement (a lost stream, a takeover). */
  drop(code: number): void;
}

function fakeAdapter() {
  const made: FakeSocket[] = [];
  const createSocket = (options: RelayCallSocketOptions): RelayCallSocket => {
    const closeListeners = new Set<(code: number) => void>();
    const socket: FakeSocket = {
      options,
      open: false,
      closed: false,
      sent: [],
      send(event) {
        if (!socket.open) return false;
        socket.sent.push(event);
        return true;
      },
      isOpen: () => socket.open,
      subscribe: () => () => undefined,
      onClosed(listener) {
        closeListeners.add(listener);
        return () => closeListeners.delete(listener);
      },
      close() {
        socket.closed = true;
        socket.open = false;
      },
      status: () => (socket.closed ? 'stopped' : socket.open ? 'open' : 'connecting'),
      drop(code) {
        socket.open = false;
        for (const listener of [...closeListeners]) listener(code);
      },
    };
    made.push(socket);
    return socket;
  };
  return { made, createSocket };
}

function channelWith(adapter = fakeAdapter()) {
  const token = vi.fn(async () => 't0k');
  const ringTargets = vi.fn(async (conversationId: string) => [`peer-of-${conversationId}`]);
  const channel = createCallChannel({ relayUrl: RELAY_URL, token, ringTargets, createSocket: adapter.createSocket });
  return { channel, adapter, token, ringTargets };
}

describe('the playground\'s call channel', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens nothing until the engine holds it, then one socket with the relay\'s URL, the token and the ring targets', async () => {
    const { channel, adapter, token, ringTargets } = channelWith();
    expect(adapter.made).toEqual([]);
    expect(() => channel.socket()).toThrow('CALL_CHANNEL_NOT_HELD');

    const release = channel.hold();
    expect(adapter.made).toHaveLength(1);
    const options = adapter.made[0]?.options;
    expect(options?.baseUrl).toBe(RELAY_URL);
    expect(await options?.token()).toBe('t0k');
    expect(token).toHaveBeenCalledTimes(1);
    expect(await options?.ringTargets('dm_a_b')).toEqual(['peer-of-dm_a_b']);
    expect(ringTargets).toHaveBeenCalledWith('dm_a_b');
    expect(channel.socket()).toBe(adapter.made[0]);
    release();
  });

  it('keeps one socket across a hold let go and taken again at once (React\'s double mount), and closes it after the last release', () => {
    const { channel, adapter } = channelWith();
    const first = channel.hold();
    first();
    const second = channel.hold();
    vi.advanceTimersByTime(RELEASE_GRACE_MS * 2);
    expect(adapter.made).toHaveLength(1);
    expect(adapter.made[0]?.closed).toBe(false);

    second();
    second(); // a release is counted once
    vi.advanceTimersByTime(RELEASE_GRACE_MS - 1);
    expect(adapter.made[0]?.closed).toBe(false);
    vi.advanceTimersByTime(1);
    expect(adapter.made[0]?.closed).toBe(true);
    expect(() => channel.socket()).toThrow('CALL_CHANNEL_NOT_HELD');

    // Held again later: a new socket.
    const third = channel.hold();
    expect(adapter.made).toHaveLength(2);
    third();
  });

  it('tells «Call» when the stream opens and when it closes', () => {
    const { channel, adapter } = channelWith();
    const heard: boolean[] = [];
    const stop = channel.signalling.onOpenChange((open) => heard.push(open));
    const release = channel.hold();
    const socket = adapter.made[0] as FakeSocket;
    expect(channel.signalling.isOpen()).toBe(false);

    socket.open = true; // the adapter got its `ready` event
    vi.advanceTimersByTime(OPEN_POLL_MS);
    expect(channel.signalling.isOpen()).toBe(true);
    expect(heard).toEqual([true]);

    socket.drop(1006); // announced by the adapter: heard at once, not at the next poll
    expect(heard).toEqual([true, false]);

    socket.open = true;
    vi.advanceTimersByTime(OPEN_POLL_MS);
    release();
    vi.advanceTimersByTime(RELEASE_GRACE_MS);
    expect(heard).toEqual([true, false, true, false]);

    stop();
    expect(vi.getTimerCount()).toBe(0); // nobody listens, no socket: nothing keeps polling
  });

  it('with the package\'s adapter and the relay\'s call channel off: one refused stream, never open, never retried', async () => {
    // A relay without the switch has no such route: its answer is a plain 404, which stops the adapter for good.
    const fetchStub = vi.fn(async (_url: string, _init: { readonly headers: Record<string, string> }) => ({
      ok: false,
      status: HTTP_NOT_FOUND,
      headers: { get: () => null },
      body: null,
    }));
    vi.stubGlobal('fetch', fetchStub);
    try {
      const channel = createCallChannel({ relayUrl: RELAY_URL, token: async () => 't0k', ringTargets: async () => [] });
      const heard: boolean[] = [];
      const stop = channel.signalling.onOpenChange((open) => heard.push(open));
      const release = channel.hold();
      await vi.advanceTimersByTimeAsync(OPEN_POLL_MS);

      expect(fetchStub).toHaveBeenCalledTimes(1);
      const [url, init] = fetchStub.mock.calls[0] ?? [];
      expect(url).toBe(`${RELAY_URL}${CALL_RELAY_PATH.STREAM}`);
      expect(init?.headers.authorization).toBe('Bearer t0k');
      expect(channel.signalling.isOpen()).toBe(false);
      expect(heard).toEqual([]);

      // Well past the adapter's longest backoff: still the one request («Call» stays off with its hint).
      await vi.advanceTimersByTimeAsync(PAST_LONGEST_BACKOFF_MS);
      expect(fetchStub).toHaveBeenCalledTimes(1);
      expect(heard).toEqual([]);

      release();
      await vi.advanceTimersByTimeAsync(RELEASE_GRACE_MS);
      stop();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('the engine\'s ports in the playground', () => {
  const binding: CallBindingPort = {
    callTag: async () => ({ tag: 't', epoch: 1, others: [] }),
    callVerify: async () => ({ ok: true, peerUserId: 'u', epoch: 1, others: [] }),
  };

  it('puts the held socket, the page\'s ICE route, the given binding and this tab\'s device together', async () => {
    const { channel, adapter } = channelWith();
    const release = channel.hold();
    const ports = createPlaygroundCallPorts({ channel, selfDeviceId: SELF_DEVICE, ice: ICE_LOOPBACK }, binding);
    expect(ports.socket).toBe(adapter.made[0]);
    expect(await ports.iceServers('c0000000000000000000a1')).toEqual(ICE_LOOPBACK);
    expect(ports.binding).toBe(binding);
    expect(ports.localDeviceId()).toBe(SELF_DEVICE);
    expect(ports.newRequestId()).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(ports.newRequestId()).not.toBe(ports.newRequestId());
    release();
  });

  it('answers every call with the same route, never asking a server', async () => {
    const { channel } = channelWith();
    const release = channel.hold();
    const ports = createPlaygroundCallPorts({ channel, selfDeviceId: SELF_DEVICE, ice: ICE_NO_ROUTE }, binding);
    expect(await ports.iceServers('c0000000000000000000a1')).toEqual(ICE_NO_ROUTE);
    expect(await ports.iceServers('c0000000000000000000b2')).toEqual(ICE_NO_ROUTE);
    release();
  });
});
