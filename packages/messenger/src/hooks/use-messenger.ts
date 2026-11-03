/**
 * `useMessenger`: the live state of ONE conversation — its messages, who is typing, the link state —
 * and the actions on it (send, edit, delete, react, read, page older history).
 *
 * Everything outside the process goes through the `Transport` port: history is a GET, server events
 * and the connection state are topics, commands are POSTs (the convention lives in `../protocol`).
 * The hook knows nothing about sockets, tokens, base URLs or the host's tenancy; `historyPath` is the
 * one place the host says where a conversation's history lives.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Transport, TransportResponse } from '@masia/contracts';
import {
  commandRequest,
  historyPagePath,
  MESSENGER_COMMAND_PATH,
  MESSENGER_CONNECTION_TOPIC,
  MESSENGER_EVENT_TOPIC,
  parseConnectionState,
  parseJsonBody,
  parseMsgServerEvent,
} from '../protocol/codec.js';
import type { MsgClientEvent } from '../protocol/events.js';
import type {
  MessageImagePayload,
  MessageType,
  MessengerMessage,
  TypingIndicator,
} from '../protocol/messages.js';

/** Ids of messages shown before the server confirmed them start with this; the server id replaces it. */
export const PENDING_MESSAGE_ID_PREFIX = 'pending-';

/** What `lastError` says when the hook itself (not the server) could not do something. */
export const MESSENGER_HOOK_ERRORS = {
  historyLoadFailed: 'HISTORY_LOAD_FAILED',
  commandFailed: 'COMMAND_FAILED',
} as const;

const HTTP_OK_MIN = 200;
const HTTP_OK_MAX_EXCLUSIVE = 300;

/** What a sticker's `text` carries on the optimistic message when a preset is missing. */
const NO_PRESET = 'none';

export interface UseMessengerOptions {
  transport: Transport;
  /** The open conversation; `null` = none (the hook stays idle but keeps the link subscription). */
  conversationId: string | null;
  /** The signed-in person: their echoes reconcile, their own typing is ignored. */
  currentPersonId: string | undefined;
  /**
   * The host's path to one conversation's message history (no query string), or `null` when there is
   * none yet (not signed in, no tenant chosen). Must be STABLE across renders — memoize it — because
   * a new function means «the history source changed» and reloads the open conversation.
   */
  historyPath: ((conversationId: string) => string) | null;
}

export interface UseMessengerReturn<M extends MessengerMessage = MessengerMessage> {
  /** Messages for the active conversation. */
  messages: M[];
  /** Whether the link to the server is up. */
  connected: boolean;
  /** People currently typing in the active conversation. */
  typingIndicators: TypingIndicator[];
  /** Send a message, optionally with attached images. */
  sendMessage: (
    text: string,
    opts?: { replyToId?: string; images?: MessageImagePayload[] },
  ) => void;
  /** Send a saved sticker by id into the active conversation (image/motion/sound for optimistic render only). */
  sendSticker: (
    stickerId: string,
    imageUrl: string,
    motionPreset: string,
    soundPreset?: string,
  ) => void;
  /** Notify others that this person is typing. */
  sendTyping: (isTyping: boolean) => void;
  /** Mark all messages up to a given timestamp as read. */
  markRead: (upTo: string) => void;
  /** Soft-delete a message by ID. Only works on own messages. */
  deleteMessage: (messageId: string) => void;
  /** Edit the text of one of your own messages. */
  editMessage: (messageId: string, text: string) => void;
  /** Toggle an emoji reaction on any message (add if absent, remove if already set by you). */
  reactToMessage: (messageId: string, reaction: string) => void;
  /**
   * End-to-end encrypted room: tell the host that the message with this payload id is now on the
   * relay (`msg:send` with `text: ''` and `e2eeEnvelopeId`), so it keeps a metadata row (unread counts,
   * a push without text). Never carries the text. Resolves `true` once the host accepted the command
   * (the caller may forget the announcement) and `false` when it did not (a dead link, a refusal: the
   * caller keeps it and asks again; it never rejects).
   */
  announceE2eeEnvelope?: (envelopeId: string) => Promise<boolean>;
  /** Load older messages (pagination). */
  loadMore: () => void;
  /** Whether there are more older messages. */
  hasMore: boolean;
  /** Whether history is currently loading. */
  loadingHistory: boolean;
  /** Last error: the server's message for a `msg:error`, else one of `MESSENGER_HOOK_ERRORS`. */
  lastError: string | null;
}

interface HistoryPage<M extends MessengerMessage> {
  messages: M[];
  nextCursor: string | null;
}

function isOk(response: TransportResponse): boolean {
  return response.status >= HTTP_OK_MIN && response.status < HTTP_OK_MAX_EXCLUSIVE;
}

/** A history page from a response, or `null` when the response is not one. */
function parseHistoryPage<M extends MessengerMessage>(
  response: TransportResponse,
): HistoryPage<M> | null {
  if (!isOk(response)) return null;
  const body = parseJsonBody(response.body);
  if (typeof body !== 'object' || body === null) return null;
  const { messages, nextCursor } = body as { messages?: unknown; nextCursor?: unknown };
  if (!Array.isArray(messages)) return null;
  if (nextCursor !== null && typeof nextCursor !== 'string') return null;
  return { messages: messages as M[], nextCursor };
}

/**
 * Types a core message as the host's richer `M`. Sound by contract: `M` may only ADD optional fields
 * (see `MessengerMessage`), so a core message already is an `M`.
 */
function asHostMessage<M extends MessengerMessage>(core: MessengerMessage): M {
  return core as M;
}

export function useMessenger<M extends MessengerMessage = MessengerMessage>(
  options: UseMessengerOptions,
): UseMessengerReturn<M> {
  const { transport, conversationId, currentPersonId, historyPath } = options;

  const [messages, setMessages] = useState<M[]>([]);
  const [connected, setConnected] = useState(false);
  const [typingIndicators, setTypingIndicators] = useState<TypingIndicator[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);

  const unmountedRef = useRef(false);
  const cursorRef = useRef<string | null>(null);
  const conversationIdRef = useRef(conversationId);
  conversationIdRef.current = conversationId;

  // ── Load message history ──────────────────────────────────────────────────
  useEffect(() => {
    setMessages([]);
    setHasMore(false);
    setTypingIndicators([]);
    setLoadingHistory(false);
    cursorRef.current = null;

    if (!conversationId || !historyPath) return;

    setLoadingHistory(true);
    transport
      .fetch(historyPagePath(historyPath(conversationId), null), { method: 'GET' })
      .then((response) => {
        const page = parseHistoryPage<M>(response);
        if (unmountedRef.current || conversationIdRef.current !== conversationId) return;
        if (!page) {
          setLastError(MESSENGER_HOOK_ERRORS.historyLoadFailed);
          return;
        }
        setMessages(page.messages);
        cursorRef.current = page.nextCursor;
        setHasMore(page.nextCursor !== null);
      })
      .catch(() => {
        if (unmountedRef.current || conversationIdRef.current !== conversationId) return;
        setLastError(MESSENGER_HOOK_ERRORS.historyLoadFailed);
      })
      .finally(() => {
        if (unmountedRef.current || conversationIdRef.current !== conversationId) return;
        setLoadingHistory(false);
      });
  }, [conversationId, historyPath, transport]);

  // ── Subscribe to server events and the link state ─────────────────────────
  useEffect(() => {
    unmountedRef.current = false;

    const unsubscribeEvents = transport.subscribe(MESSENGER_EVENT_TOPIC, (bytes) => {
      if (unmountedRef.current) return;
      const event = parseMsgServerEvent(bytes);
      if (!event) return;

      switch (event.type) {
        case 'msg:new': {
          if (event.payload.conversationId !== conversationIdRef.current) break;
          const newMsg = asHostMessage<M>({
            id: event.payload.id,
            conversationId: event.payload.conversationId,
            senderId: event.payload.senderId,
            senderName: event.payload.senderName,
            text: event.payload.modified?.text ?? event.payload.text,
            // The server's `messageType` is a plain string: an absent one means TEXT, a kind this
            // client does not know is passed through (the renderer decides what to do with it).
            messageType: (event.payload.messageType || 'TEXT') as MessageType,
            mediaUrl: event.payload.mediaUrl ?? null,
            mediaUrls: event.payload.mediaUrls ?? null,
            replyToId: event.payload.replyToId ?? null,
            replyToPreview: null,
            createdAt: event.payload.createdAt,
            editedAt: null,
            deletedAt: null,
            deliveryStatus: null,
            modified: event.payload.modified
              ? {
                  text: event.payload.modified.text,
                  ruleName: event.payload.modified.ruleName ?? null,
                }
              : null,
            reactions: [],
            ...(event.payload.e2eeEnvelopeId
              ? { e2eeEnvelopeId: event.payload.e2eeEnvelopeId }
              : {}),
            ...(event.payload.serviceMeta !== undefined
              ? { serviceMeta: event.payload.serviceMeta }
              : {}),
          });
          setMessages((prev) => {
            // Already present (reconnection, or msg:sent already reconciled it).
            if (prev.some((m) => m.id === newMsg.id)) return prev;
            // Our own optimistic message (sticker/image) echoed back by the
            // server's sender self-broadcast. Reconcile the `pending-` placeholder
            // in place instead of appending a duplicate. The server sends BOTH
            // msg:new and msg:sent to the sender and either may arrive first, so
            // both this and the msg:sent handler must converge on one message.
            if (newMsg.senderId === currentPersonId) {
              const idx = prev.findIndex(
                (m) =>
                  m.id.startsWith(PENDING_MESSAGE_ID_PREFIX) &&
                  m.messageType === newMsg.messageType,
              );
              if (idx !== -1) {
                const copy = [...prev];
                copy[idx] = { ...copy[idx]!, id: newMsg.id, createdAt: newMsg.createdAt };
                return copy;
              }
            }
            return [...prev, newMsg];
          });
          setTypingIndicators((prev) => prev.filter((t) => t.personId !== event.payload.senderId));
          break;
        }

        case 'msg:sent': {
          // Confirmation that our message was persisted. Reconcile the optimistic
          // image message (pending- id) with the real server id so it isn't
          // duplicated on reload and delivery status can track correctly.
          if (event.payload.conversationId !== conversationIdRef.current) break;
          setMessages((prev) => {
            const idx = prev.findIndex((m) => m.id.startsWith(PENDING_MESSAGE_ID_PREFIX));
            if (idx === -1) return prev;
            const copy = [...prev];
            copy[idx] = {
              ...copy[idx]!,
              id: event.payload.messageId,
              createdAt: event.payload.createdAt ?? copy[idx]!.createdAt,
            };
            return copy;
          });
          break;
        }

        case 'msg:read': {
          if (event.payload.conversationId !== conversationIdRef.current) break;
          // Update delivery status for messages read by this person
          setMessages((prev) =>
            prev.map((msg) => {
              if (msg.senderId === currentPersonId && msg.createdAt <= event.payload.upTo) {
                return { ...msg, deliveryStatus: 'READ' as const };
              }
              return msg;
            }),
          );
          break;
        }

        case 'msg:typing': {
          if (event.payload.conversationId !== conversationIdRef.current) break;
          if (event.payload.personId === currentPersonId) break;

          if (event.payload.isTyping) {
            setTypingIndicators((prev) => {
              if (prev.some((t) => t.personId === event.payload.personId)) return prev;
              return [
                ...prev,
                { personId: event.payload.personId, personName: event.payload.personName },
              ];
            });
          } else {
            setTypingIndicators((prev) =>
              prev.filter((t) => t.personId !== event.payload.personId),
            );
          }
          break;
        }

        case 'msg:deleted': {
          if (event.payload.conversationId !== conversationIdRef.current) break;
          setMessages((prev) =>
            prev.map((msg) =>
              msg.id === event.payload.messageId
                ? { ...msg, deletedAt: new Date().toISOString(), text: '' }
                : msg,
            ),
          );
          break;
        }

        case 'msg:edited': {
          if (event.payload.conversationId !== conversationIdRef.current) break;
          setMessages((prev) =>
            prev.map((msg) =>
              msg.id === event.payload.messageId
                ? { ...msg, text: event.payload.text, editedAt: event.payload.editedAt }
                : msg,
            ),
          );
          break;
        }

        case 'msg:reacted': {
          if (event.payload.conversationId !== conversationIdRef.current) break;
          // Server sends the full authoritative reaction set — replace wholesale
          // (this also reconciles any optimistic local toggle).
          setMessages((prev) =>
            prev.map((msg) =>
              msg.id === event.payload.messageId
                ? { ...msg, reactions: event.payload.reactions }
                : msg,
            ),
          );
          break;
        }

        case 'msg:error': {
          setLastError(event.payload.message);
          break;
        }
      }
    });

    const unsubscribeConnection = transport.subscribe(MESSENGER_CONNECTION_TOPIC, (bytes) => {
      if (unmountedRef.current) return;
      const isConnected = parseConnectionState(bytes);
      if (isConnected !== null) setConnected(isConnected);
    });

    return () => {
      unmountedRef.current = true;
      unsubscribeEvents();
      unsubscribeConnection();
    };
  }, [currentPersonId, transport]);

  // ── Actions ───────────────────────────────────────────────────────────────

  /**
   * Sends a command and says whether the host accepted it. A refusal or a dead link surfaces in
   * `lastError`, never as an unhandled rejection.
   */
  const postCommand = useCallback(
    (event: MsgClientEvent): Promise<boolean> => {
      const failed = (): boolean => {
        if (!unmountedRef.current) setLastError(MESSENGER_HOOK_ERRORS.commandFailed);
        return false;
      };
      return transport
        .fetch(MESSENGER_COMMAND_PATH, commandRequest(event))
        .then((response) => (isOk(response) ? true : failed()))
        .catch(failed);
    },
    [transport],
  );
  const sendCommand = useCallback(
    (event: MsgClientEvent): void => {
      void postCommand(event);
    },
    [postCommand],
  );

  const sendMessage = useCallback(
    (text: string, opts?: { replyToId?: string; images?: MessageImagePayload[] }) => {
      if (!conversationIdRef.current) return;
      const images = opts?.images;

      // Optimistically render our own image message immediately, from the inline
      // base64, before the server has persisted it. The server sends the sender
      // BOTH msg:new (its self-broadcast) and msg:sent (id only), in either order;
      // the msg:new and msg:sent handlers above each reconcile this `pending-`
      // row in place, so it converges on one message. (Until 2026-10-10 this
      // comment said msg:new went only to the OTHER participants, which
      // contradicted the msg:new handler and the server.) Pure-text messages
      // keep their existing path.
      if (images?.length) {
        const optimistic = asHostMessage<M>({
          id: `${PENDING_MESSAGE_ID_PREFIX}${Date.now()}`,
          conversationId: conversationIdRef.current,
          senderId: currentPersonId ?? '',
          senderName: '',
          text,
          messageType: 'IMAGE',
          mediaUrl: null,
          images, // inline base64 so it shows instantly; persisted copy loads on reload
          replyToId: opts?.replyToId ?? null,
          replyToPreview: null,
          createdAt: new Date().toISOString(),
          editedAt: null,
          deletedAt: null,
          deliveryStatus: 'SENT',
          modified: null,
        });
        setMessages((prev) => [...prev, optimistic]);
      }

      sendCommand({
        type: 'msg:send',
        payload: {
          conversationId: conversationIdRef.current,
          text,
          replyToId: opts?.replyToId,
          images: opts?.images,
        },
      });
    },
    [currentPersonId, sendCommand],
  );

  /**
   * Send a saved sticker into the active conversation. Only the sticker ID goes
   * to the server (it resolves the image + presets); `imageUrl`/motion/sound are
   * used purely for the optimistic local render.
   */
  const sendSticker = useCallback(
    (stickerId: string, imageUrl: string, motionPreset: string, soundPreset?: string) => {
      if (!conversationIdRef.current || !stickerId) return;
      const encoded = `${motionPreset || NO_PRESET}|${soundPreset || NO_PRESET}`;
      const optimistic = asHostMessage<M>({
        id: `${PENDING_MESSAGE_ID_PREFIX}${Date.now()}`,
        conversationId: conversationIdRef.current,
        senderId: currentPersonId ?? '',
        senderName: '',
        text: encoded,
        messageType: 'STICKER',
        mediaUrl: imageUrl,
        replyToId: null,
        replyToPreview: null,
        createdAt: new Date().toISOString(),
        editedAt: null,
        deletedAt: null,
        deliveryStatus: 'SENT',
        modified: null,
        reactions: [],
      });
      setMessages((prev) => [...prev, optimistic]);
      sendCommand({
        type: 'msg:send',
        payload: {
          conversationId: conversationIdRef.current,
          text: '', // server derives motion|sound from the sticker
          messageType: 'STICKER',
          stickerId,
        },
      });
    },
    [currentPersonId, sendCommand],
  );

  const announceE2eeEnvelope = useCallback(
    (envelopeId: string): Promise<boolean> => {
      if (!conversationIdRef.current || !envelopeId) return Promise.resolve(false);
      return postCommand({
        type: 'msg:send',
        payload: {
          conversationId: conversationIdRef.current,
          text: '',
          e2eeEnvelopeId: envelopeId,
        },
      });
    },
    [postCommand],
  );

  const sendTyping = useCallback(
    (isTyping: boolean) => {
      if (!conversationIdRef.current) return;
      sendCommand({
        type: 'msg:typing',
        payload: { conversationId: conversationIdRef.current, isTyping },
      });
    },
    [sendCommand],
  );

  const markRead = useCallback(
    (upTo: string) => {
      if (!conversationIdRef.current) return;
      sendCommand({
        type: 'msg:read',
        payload: { conversationId: conversationIdRef.current, upTo },
      });
    },
    [sendCommand],
  );

  const deleteMessage = useCallback(
    (messageId: string) => {
      if (!conversationIdRef.current) return;
      // Optimistic update — mark as deleted locally
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === messageId ? { ...msg, deletedAt: new Date().toISOString(), text: '' } : msg,
        ),
      );
      sendCommand({
        type: 'msg:delete',
        payload: { messageId, conversationId: conversationIdRef.current },
      });
    },
    [sendCommand],
  );

  const editMessage = useCallback(
    (messageId: string, text: string) => {
      const trimmed = text.trim();
      if (!conversationIdRef.current || !trimmed) return;
      // Optimistic update — apply the new text + edited marker locally; the
      // server confirms via msg:edited (and broadcasts to other participants).
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === messageId
            ? { ...msg, text: trimmed, editedAt: new Date().toISOString() }
            : msg,
        ),
      );
      sendCommand({
        type: 'msg:edit',
        payload: { messageId, conversationId: conversationIdRef.current, text: trimmed },
      });
    },
    [sendCommand],
  );

  const reactToMessage = useCallback(
    (messageId: string, reaction: string) => {
      if (!conversationIdRef.current || !currentPersonId || !reaction) return;
      // Optimistic toggle: if I already set this emoji, drop it; otherwise add it.
      // The server replies with the authoritative set via msg:reacted to reconcile.
      setMessages((prev) =>
        prev.map((msg) => {
          if (msg.id !== messageId) return msg;
          const current = msg.reactions ?? [];
          const mine = current.some(
            (r) => r.personId === currentPersonId && r.reaction === reaction,
          );
          const next = mine
            ? current.filter((r) => !(r.personId === currentPersonId && r.reaction === reaction))
            : [...current, { personId: currentPersonId, reaction }];
          return { ...msg, reactions: next };
        }),
      );
      sendCommand({
        type: 'msg:react',
        payload: { messageId, conversationId: conversationIdRef.current, reaction },
      });
    },
    [currentPersonId, sendCommand],
  );

  const loadMore = useCallback(() => {
    const cid = conversationIdRef.current;
    const cursor = cursorRef.current;
    if (!cid || !cursor || !historyPath || loadingHistory) return;

    setLoadingHistory(true);
    transport
      .fetch(historyPagePath(historyPath(cid), cursor), { method: 'GET' })
      .then((response) => {
        if (unmountedRef.current || conversationIdRef.current !== cid) return;
        const page = parseHistoryPage<M>(response);
        if (!page) {
          setLastError(MESSENGER_HOOK_ERRORS.historyLoadFailed);
          return;
        }
        setMessages((prev) => [...page.messages, ...prev]);
        cursorRef.current = page.nextCursor;
        setHasMore(page.nextCursor !== null);
      })
      .catch(() => {
        if (unmountedRef.current || conversationIdRef.current !== cid) return;
        setLastError(MESSENGER_HOOK_ERRORS.historyLoadFailed);
      })
      .finally(() => {
        if (unmountedRef.current || conversationIdRef.current !== cid) return;
        setLoadingHistory(false);
      });
  }, [historyPath, loadingHistory, transport]);

  return {
    messages,
    connected,
    typingIndicators,
    sendMessage,
    sendSticker,
    sendTyping,
    markRead,
    deleteMessage,
    editMessage,
    reactToMessage,
    announceE2eeEnvelope,
    loadMore,
    hasMore,
    loadingHistory,
    lastError,
  };
}
