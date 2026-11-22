import {
  browserMicrophone,
  createBrowserPeer,
  createRelayCallSocket,
  newCallRequestId,
  type CallBindingPort,
  type CallEnginePorts,
  type CallIceAnswer,
  type CallSocketPort,
  type RelayCallSocket,
  type RelayCallSocketOptions,
} from '@masia/messenger/call';
import { createAudioElementSpeaker } from '@masia/messenger/call/browser-speaker';
import type { CallHold, CallSignallingState } from '@masia/messenger/call/react';

// The call engine's ports in the playground. The `call:*` frames ride the relay's call channel: one
// event stream and one POST per signal, through the page's own `/relay` door. THIS FILE IS THE ONLY ONE
// THAT USES THE RELAY ADAPTER (`createRelayCallSocket`), so a change to the adapter is a change here and
// nowhere else.
//
// The relay passes a call's signals only between the two devices of a call a ring admitted. The engine's
// own order (ring, accept, then the SDP and the check) is exactly that, so nothing here asks for more.
// Once the audio flows the channel goes quiet; the relay keeps an answered call through hours of that, so
// the hang-up still passes, and the hang-up closes the call there. Past that quiet (or for a call that
// only rang, past minutes of it) the hang-up is dropped, and the other tab's engine ends the call as
// `lost` when the audio stops.
//
// The rest is the package's plain browser pieces: the peer connection, the microphone, the request id
// and the <audio> speaker.

/** The adapter, as `createCallChannel` calls it: the package's own, or a fake in tests. */
export type RelaySocketFactory = (options: RelayCallSocketOptions) => RelayCallSocket;

/**
 * How often the open state is read while a «Call» button listens. The adapter announces closes (`onClosed`) but
 * not opens, so the open is noticed by reading `isOpen()`; an open event in the adapter would remove this poll.
 */
export const OPEN_POLL_MS = 500;
/**
 * How long the socket stays after its last hold is let go. React's development mode mounts every effect twice in
 * a row; without this beat each mount would open a stream and the next would take the device's place.
 */
export const RELEASE_GRACE_MS = 2_000;

export interface CallChannel {
  /** `useAudioCallHost`'s `holdSignalling`: the first hold opens the socket, the last release closes it (after a beat). */
  readonly hold: CallHold;
  /** `useCallEntry`'s `signalling`: whether the stream is open, and its changes. */
  readonly signalling: CallSignallingState;
  /** The socket, between a hold and its release; throws outside one (the engine is made only inside one). */
  socket(): CallSocketPort;
}

export interface CallChannelDeps {
  /** The relay's absolute base URL, base path included (the page's `/relay` door). */
  readonly relayUrl: string;
  readonly token: () => Promise<string>;
  /** The devices to ring for a call placed in a room: the other person's own devices there. */
  readonly ringTargets: (conversationId: string) => Promise<readonly string[]>;
  /** Tests: a fake adapter. Default: the package's `createRelayCallSocket`. */
  readonly createSocket?: RelaySocketFactory;
}

export function createCallChannel(deps: CallChannelDeps): CallChannel {
  const createSocket = deps.createSocket ?? createRelayCallSocket;
  const listeners = new Set<(open: boolean) => void>();
  let socket: RelayCallSocket | null = null;
  let unclosed: () => void = () => undefined;
  let holds = 0;
  let closing: ReturnType<typeof setTimeout> | null = null;
  let watch: ReturnType<typeof setInterval> | null = null;
  let lastOpen = false;

  const isOpen = (): boolean => socket?.isOpen() === true;

  /** Tells the listeners when the open state differs from what they last heard. */
  function check(): void {
    const open = isOpen();
    if (open === lastOpen) return;
    lastOpen = open;
    for (const listener of [...listeners]) listener(open);
  }

  /** The open state is polled only while someone listens AND there is a socket to read. */
  function rewatch(): void {
    const wanted = listeners.size > 0 && socket !== null;
    if (wanted && watch === null) watch = setInterval(check, OPEN_POLL_MS);
    if (!wanted && watch !== null) {
      clearInterval(watch);
      watch = null;
    }
  }

  function open(): void {
    if (socket !== null) return;
    const created = createSocket({ baseUrl: deps.relayUrl, token: deps.token, ringTargets: deps.ringTargets });
    socket = created;
    unclosed = created.onClosed(check);
    rewatch();
    check();
  }

  function shut(): void {
    closing = null;
    const gone = socket;
    if (gone === null) return;
    socket = null;
    unclosed();
    unclosed = () => undefined;
    gone.close();
    rewatch();
    check();
  }

  return {
    hold() {
      holds += 1;
      if (closing !== null) {
        clearTimeout(closing);
        closing = null;
      }
      open();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        holds -= 1;
        if (holds === 0 && socket !== null) closing = setTimeout(shut, RELEASE_GRACE_MS);
      };
    },
    signalling: {
      isOpen,
      onOpenChange(listener) {
        // A new listener reads `isOpen()` itself first; the next change it hears may repeat that (harmless).
        listeners.add(listener);
        rewatch();
        return () => {
          listeners.delete(listener);
          rewatch();
        };
      },
    },
    socket() {
      if (socket === null) throw new Error('CALL_CHANNEL_NOT_HELD');
      return socket;
    },
  };
}

export interface PlaygroundCallPortsDeps {
  readonly channel: CallChannel;
  /** This tab's MLS device id: the one the binding speaks for. */
  readonly selfDeviceId: string;
  /** The ICE route (`callIceAnswer`), the same for every call of this page. */
  readonly ice: CallIceAnswer;
}

/** Every port of one engine (`useAudioCallHost`'s `createPorts`), with the binding it is given. */
export function createPlaygroundCallPorts(deps: PlaygroundCallPortsDeps, binding: CallBindingPort): CallEnginePorts {
  return {
    socket: deps.channel.socket(),
    iceServers: () => Promise.resolve(deps.ice),
    binding,
    microphone: browserMicrophone,
    createPeer: createBrowserPeer,
    speaker: createAudioElementSpeaker(),
    localDeviceId: () => deps.selfDeviceId,
    newRequestId: newCallRequestId,
  };
}
