import { createContext, useContext, useId, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { CallBindingPort, CallIceAnswer } from '@masia/messenger/call';
import {
  AudioCallHost,
  useAudioCall,
  useAudioCallHost,
  useCallEntry,
  useCallView,
  type CallLayer,
  type CallSignallingState,
} from '@masia/messenger/call/react';
import type { PlaygroundRuntime } from '../client/runtime.js';
import type { RoomSnapshot } from '../client/room.js';
import { callIcon } from './call-icons.js';
import { callIceAnswer } from './call-ice.js';
import { createCallChannel, createPlaygroundCallPorts, type CallChannel } from './call-ports.js';
import { createCallBinding, isTwoPersonRoom, ringTargetsOf } from './call-room.js';
import { CALL_BUTTON_TEXT, CALL_ENTRY_HINTS, CALL_REFUSALS, callText } from './call-texts.js';
import type { Toaster } from './toaster.js';
import './call-frame.css';

// The 1:1 audio call in the page, from the messenger's own pieces: one engine for the tab
// (`useAudioCallHost`), the screen over everything (`AudioCallHost`), and «Call» in a chat's header
// (`useCallEntry`). This file only wires them to the playground's runtime and words.

/** Everything a call needs that lives as long as the signed-in tab. */
export interface CallSetup {
  readonly channel: CallChannel;
  readonly binding: CallBindingPort;
  readonly ice: CallIceAnswer;
  readonly selfDeviceId: string;
}

/** The setup for a runtime, given the page's URL (the relay is reached through the page's own `/relay` door). */
export function createCallSetup(
  runtime: Pick<PlaygroundRuntime, 'self' | 'relay' | 'callKey' | 'roomSnapshot'>,
  pageUrl: string,
): CallSetup {
  const relayUrl = new URL(runtime.relay.baseUrl, pageUrl).href;
  return {
    channel: createCallChannel({
      relayUrl,
      token: runtime.relay.token,
      ringTargets: (conversationId) =>
        Promise.resolve(ringTargetsOf(runtime.roomSnapshot(conversationId), runtime.self.userId)),
    }),
    binding: createCallBinding(runtime),
    // From the page's address alone: the relay's address as the page sees it is the page's own door.
    ice: callIceAnswer(pageUrl),
    selfDeviceId: runtime.self.deviceId,
  };
}

const CallSetupContext = createContext<CallSetup | null>(null);

/** The screen's layer: fixed over the page, click-through except where the screen is (`call-frame.css`). */
const CallLayerView: CallLayer = ({ children }) => <div className="demo-call-layer">{children}</div>;

export interface PlaygroundCallsProps {
  readonly runtime: PlaygroundRuntime;
  readonly children: ReactNode;
}

/** Mount once, around the shell: the tab's call engine, its screen, and the setup «Call» buttons read. */
export function PlaygroundCalls({ runtime, children }: PlaygroundCallsProps) {
  // Made once for the tab, never again: the channel and its socket hang off this object's identity, and `useMemo` is
  // only a hint React may drop. The runtime cannot change under it: the shell appears after the tab's one sign-in and
  // stays until a reload.
  const [setup] = useState(() => createCallSetup(runtime, window.location.href));
  const tab = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot);
  const snapshot = useAudioCallHost({
    // The playground has no account rules: whether a call can start is the channel's and the room's question.
    allowed: true,
    binding: setup.binding,
    createPorts: (binding) => createPlaygroundCallPorts(setup, binding),
    holdSignalling: setup.channel.hold,
  });
  const { engine } = useAudioCall();
  const view = useCallView(snapshot);

  // The verified person's name; before that, the name of the chat the call is in. Never an id the relay sent.
  const verified = snapshot?.verifiedPeer?.userId;
  const chat = view === null ? undefined : tab.chats.find((entry) => entry.conversationId === view.conversationId);
  const name = (verified === undefined ? undefined : runtime.nameOf(verified)) ?? chat?.peerName ?? null;

  return (
    <CallSetupContext.Provider value={setup}>
      {children}
      <AudioCallHost engine={engine} view={view} name={name} t={callText} icon={callIcon} layer={CallLayerView} />
    </CallSetupContext.Provider>
  );
}

/** A channel that is never open: what «Call» listens to outside `PlaygroundCalls` (it is then not offered anyway). */
const NO_SIGNALLING: CallSignallingState = { isOpen: () => false, onOpenChange: () => () => undefined };

export interface CallButtonProps {
  readonly conversationId: string;
  readonly room: RoomSnapshot | undefined;
  readonly selfUserId: string;
  readonly toaster: Toaster;
}

/** The handset beside «Call»: a little larger than the text it sits next to. */
const CALL_BUTTON_ICON_PX = 18;

/**
 * «Call» in a chat's header: only in a room of exactly two people. When it cannot be pressed (the relay's call channel
 * is not open, the engine is busy, the microphone is refused), the reason is written beside it (a disabled button's
 * tooltip is not shown everywhere).
 */
export function CallButton({ conversationId, room, selfUserId, toaster }: CallButtonProps) {
  const setup = useContext(CallSetupContext);
  const { engine, snapshot } = useAudioCall();
  const hintId = useId();
  const entry = useCallEntry(conversationId, {
    offered: setup !== null && isTwoPersonRoom(room, selfUserId),
    engine,
    snapshot,
    signalling: setup?.channel.signalling ?? NO_SIGNALLING,
    onRefused: (key) => toaster.push(CALL_REFUSALS[key]),
  });
  if (entry === null) return null;
  const hint = entry.hint === null ? null : CALL_ENTRY_HINTS[entry.hint];
  return (
    <>
      {hint !== null && (
        <span className="demo-chat__call-hint" id={hintId} data-testid="call-start-hint">
          {hint}
        </span>
      )}
      <button
        type="button"
        className="demo-chat__call"
        onClick={entry.start}
        disabled={entry.disabled}
        title={CALL_BUTTON_TEXT.title}
        aria-describedby={hint === null ? undefined : hintId}
        data-testid="call-start"
      >
        {callIcon('phone', CALL_BUTTON_ICON_PX)}
        <span>{CALL_BUTTON_TEXT.label}</span>
      </button>
    </>
  );
}
