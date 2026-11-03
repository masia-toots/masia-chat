import { useCallback, useMemo, useSyncExternalStore } from 'react';
import type { UseMessengerReturn } from '@masia/messenger/hooks';
import {
  E2EE_QUOTE_MAX_CHARS,
  E2EE_TEXT_MAX_CHARS,
  type E2eePayloadInput,
} from '@masia/messenger/protocol';
import { newMessageId } from './bytes.js';
import { foldHistory } from './fold.js';
import type { PlaygroundRuntime } from './runtime.js';

// One room as the conversation screen's `UseMessengerReturn`: the screen draws the thread, the bubbles
// and the composer without knowing the messages came out of ciphertext. Sending builds a payload
// (text, edit, delete, reaction) and hands it to the room, which seals and posts it.
//
// What the playground does not have, and says so here: typing indicators and read marks (those are
// metadata a server socket would carry), pictures and stickers (media are not end-to-end encrypted in
// this design, and the playground has no media store), and older-history paging (a tab keeps every
// message it has read in memory; there is nothing older to fetch).

const EMPTY: readonly never[] = [];

export const PLAYGROUND_TEXT = {
  unreadable: 'This message could not be decrypted on this device.',
  sticker: '[sticker]',
  tooLong: `A message can be at most ${E2EE_TEXT_MAX_CHARS} characters.`,
  noPictures: 'Pictures are not part of the playground: media would not be end-to-end encrypted.',
  notSent: 'The message could not be sent.',
} as const;

export interface RoomMessengerOptions {
  /** Shows a short failure line in the host's toast. */
  notifyError(message: string): void;
}

const noop = (): void => undefined;

export function useRoomMessenger(
  runtime: PlaygroundRuntime,
  conversationId: string,
  options: RoomMessengerOptions,
): UseMessengerReturn {
  const view = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot);
  const room = view.chats.find((chat) => chat.conversationId === conversationId)?.room;
  const history = room?.history ?? EMPTY;
  const queued = room?.queued ?? EMPTY;
  const self = view.self;
  const { notifyError } = options;

  const messages = useMemo(
    () =>
      foldHistory(history, queued, {
        conversationId,
        personOf: (userId) => {
          const name = runtime.nameOf(userId);
          return name === undefined ? undefined : { id: userId, name };
        },
        self: { id: self.userId, name: self.displayName },
        unreadableText: PLAYGROUND_TEXT.unreadable,
        stickerText: PLAYGROUND_TEXT.sticker,
      }),
    // `view.people` is here because a name can arrive after the message that carries it.
    [history, queued, conversationId, runtime, self.userId, self.displayName, view.people],
  );

  const send = useCallback(
    (payload: E2eePayloadInput) => {
      runtime.send(conversationId, payload).catch(() => notifyError(PLAYGROUND_TEXT.notSent));
    },
    [runtime, conversationId, notifyError],
  );

  const sendMessage = useCallback<UseMessengerReturn['sendMessage']>(
    (text, opts) => {
      if (opts?.images && opts.images.length > 0) {
        notifyError(PLAYGROUND_TEXT.noPictures);
        return;
      }
      const body = text.trim();
      if (body === '') return;
      if (body.length > E2EE_TEXT_MAX_CHARS) {
        notifyError(PLAYGROUND_TEXT.tooLong);
        return;
      }
      const target = opts?.replyToId ? messages.find((m) => m.id === opts.replyToId) : undefined;
      send({
        kind: 'text',
        id: newMessageId(),
        body,
        ...(opts?.replyToId
          ? {
              replyTo: {
                id: opts.replyToId,
                ...(target
                  ? { quote: target.text.slice(0, E2EE_QUOTE_MAX_CHARS), senderName: target.senderName }
                  : {}),
              },
            }
          : {}),
      });
    },
    [messages, send, notifyError],
  );

  const editMessage = useCallback<UseMessengerReturn['editMessage']>(
    (messageId, text) => send({ kind: 'edit', id: newMessageId(), targetId: messageId, body: text }),
    [send],
  );

  const deleteMessage = useCallback<UseMessengerReturn['deleteMessage']>(
    (messageId) => send({ kind: 'delete', id: newMessageId(), targetId: messageId }),
    [send],
  );

  // A toggle: the same emoji from the same person again takes it back.
  const reactToMessage = useCallback<UseMessengerReturn['reactToMessage']>(
    (messageId, reaction) => {
      const mine = messages
        .find((m) => m.id === messageId)
        ?.reactions?.some((r) => r.personId === self.userId && r.reaction === reaction);
      send({
        kind: 'reaction',
        id: newMessageId(),
        targetId: messageId,
        emoji: reaction,
        ...(mine ? { removed: true as const } : {}),
      });
    },
    [messages, self.userId, send],
  );

  const sendSticker = useCallback<UseMessengerReturn['sendSticker']>(() => {
    notifyError(PLAYGROUND_TEXT.noPictures);
  }, [notifyError]);

  return useMemo<UseMessengerReturn>(
    () => ({
      messages,
      connected: view.problem === undefined,
      typingIndicators: [],
      sendMessage,
      sendSticker,
      sendTyping: noop,
      markRead: noop,
      deleteMessage,
      editMessage,
      reactToMessage,
      loadMore: noop,
      hasMore: false,
      loadingHistory: false,
      lastError: view.problem ?? null,
    }),
    [messages, view.problem, sendMessage, sendSticker, deleteMessage, editMessage, reactToMessage],
  );
}
