/**
 * P2PChatBody — one conversation's body: the chat view plus the host's sticker picker.
 *
 * Why it takes a ready `messenger` (a `useMessenger` result) instead of building one: the host owns
 * how the conversation is reached (which transport, which history path, a fixture on a demo page),
 * and a body that built its own would have to know all of that. Why the picker is a render prop: the
 * sticker studio is the host's feature (its artwork, its saving), the body only owns WHEN it is open.
 */
import { useCallback, useState, type ReactNode } from 'react';
import { MessengerChatView, type MessengerChatViewProps } from './messenger-chat-view.js';

/** What the body tells the host's sticker picker. */
export interface StickerPickerState {
  /** The composer's sticker control was pressed and the picker has not been closed since. */
  readonly opened: boolean;
  close(): void;
}

export interface P2PChatBodyProps extends Omit<MessengerChatViewProps, 'onStickers'> {
  /**
   * Draws the host's sticker picker. It is rendered all the time (not only while open), because a
   * picker that animates out or keeps its own state must stay mounted; `opened` says when to show it.
   * Omitted: the conversation has no sticker control.
   */
  renderStickers?: (picker: StickerPickerState) => ReactNode;
}

export function P2PChatBody({ renderStickers, ...view }: P2PChatBodyProps) {
  const [opened, setOpened] = useState(false);
  const close = useCallback(() => setOpened(false), []);
  const open = useCallback(() => setOpened(true), []);

  return (
    <>
      <MessengerChatView {...view} onStickers={renderStickers ? open : undefined} />
      {renderStickers?.({ opened, close })}
    </>
  );
}
