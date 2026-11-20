/**
 * `useMessenger`: the live state of ONE conversation — its messages, who is typing, the link state —
 * and the actions on it (send, edit, delete, react, read, page older history).
 *
 * Everything outside the process goes through the `Transport` port: history is a GET, server events
 * and the connection state are topics, commands are POSTs (the convention lives in `../protocol`).
 * The hook knows nothing about sockets, tokens, base URLs or the host's tenancy; `historyPath` is the
 * one place the host says where a conversation's history lives.
 *
 * My own sends live in the OUTBOX (`messenger-outbox.ts`) from the moment they are sent until the
 * server confirms them, not in this hook's state: a screen that unmounts or reloads must not take the
 * words with it. `messages` is the server's rows with those woven in.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
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
import { isBroadcastMention } from '../protocol/messages.js';
import type {
  BroadcastMention,
  MessageImagePayload,
  MessageType,
  MessengerMessage,
  TypingIndicator,
} from '../protocol/messages.js';
import {
  echoConfirms,
  failWaitingEntries,
  messengerOutboxAddress,
  OUTBOX_STATE,
  PENDING_MESSAGE_ID_PREFIX,
  settleOutboxWithHistory,
  sharedMessengerOutbox,
  withOutboxRows,
  type MessengerOutbox,
  type MessengerOutboxEntry,
} from './messenger-outbox.js';

export { PENDING_MESSAGE_ID_PREFIX };

const NO_ENTRIES: readonly MessengerOutboxEntry[] = Object.freeze([]);

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
  /**
   * Where my unconfirmed sends are kept (`createMessengerOutbox`). Absent: the page's shared one, over
   * the browser's storage. Must be stable across renders.
   */
  outbox?: MessengerOutbox;
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
  /**
   * Soft-delete a message by ID. Only works on own messages. A row of mine the server never confirmed
   * (`pending-…`, shown "not sent") is discarded here instead: there is nothing on the server to delete.
   */
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
   *
   * `opts.broadcast`: the message called the room with `@all` / `@online` (ADR-201) — the ONE bit the
   * metadata row carries, so the other members' push is raised to a mention while the text stays
   * ciphertext. The caller reads the tag on the sender's device; absent = the row calls nobody.
   */
  announceE2eeEnvelope?: (envelopeId: string, opts?: { broadcast?: BroadcastMention }) => Promise<boolean>;
  /**
   * Sends again a message of mine that never left (`MessengerMessage.sendFailed`), by the id of the
   * row that shows it, with the same command. Unknown id, or a row not marked failed: nothing happens.
   */
  retrySend: (messageId: string) => void;
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
  const outbox = options.outbox ?? sharedMessengerOutbox();

  /** The server's rows (history and live); my unconfirmed sends are woven in from the outbox below. */
  const [serverMessages, setMessages] = useState<M[]>([]);
  const [connected, setConnected] = useState(false);
  const [typingIndicators, setTypingIndicators] = useState<TypingIndicator[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);

  const unmountedRef = useRef(false);
  const cursorRef = useRef<string | null>(null);
  const conversationIdRef = useRef(conversationId);
  conversationIdRef.current = conversationId;
  const currentPersonIdRef = useRef(currentPersonId);
  currentPersonIdRef.current = currentPersonId;
  /** The outbox address of the open conversation, read where a closure must not go stale. */
  const addressOf = useCallback(
    (cid: string): string => messengerOutboxAddress(currentPersonIdRef.current, cid),
    [],
  );
  /**
   * Server ids of my messages already on screen through an echo (`msg:new` or `msg:sent`). The server
   * sends the sender both, in either order: the second must find its message here, not take the NEXT
   * unconfirmed entry for its own.
   */
  const echoedIdsRef = useRef(new Set<string>());

  const address = conversationId ? messengerOutboxAddress(currentPersonId, conversationId) : null;
  const outboxEntries = useSyncExternalStore(outbox.subscribe, () =>
    address ? outbox.read(address) : NO_ENTRIES,
  );
  const messages = useMemo(
    () => withOutboxRows(serverMessages, outboxEntries),
    [serverMessages, outboxEntries],
  );

  /** Counts the rows this hook made, so two sends in the same millisecond never share an id. */
  const pendingSeqRef = useRef(0);
  const nextPendingId = useCallback((): string => {
    pendingSeqRef.current += 1;
    return `${PENDING_MESSAGE_ID_PREFIX}${Date.now()}-${pendingSeqRef.current}`;
  }, []);

  // ── Load message history ──────────────────────────────────────────────────
  useEffect(() => {
    // My unconfirmed sends are NOT cleared here: they live in the outbox, per conversation, and come
    // back with it.
    echoedIdsRef.current.clear();
    setMessages([]);
    setHasMore(false);
    setTypingIndicators([]);
    setLoadingHistory(false);
    cursorRef.current = null;

    if (!conversationId || !historyPath) return;

    setLoadingHistory(true);
    const askedAt = Date.now();
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
        // What the page shows was delivered; what it should show and does not was lost.
        settleOutboxWithHistory(
          outbox,
          addressOf(conversationId),
          page.messages,
          currentPersonIdRef.current,
          askedAt,
        );
      })
      .catch(() => {
        if (unmountedRef.current || conversationIdRef.current !== conversationId) return;
        setLastError(MESSENGER_HOOK_ERRORS.historyLoadFailed);
      })
      .finally(() => {
        if (unmountedRef.current || conversationIdRef.current !== conversationId) return;
        setLoadingHistory(false);
      });
  }, [conversationId, historyPath, transport, outbox, addressOf]);

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
            replyToPreview: event.payload.replyToPreview ?? null,
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
            ...(isBroadcastMention(event.payload.broadcast) ? { broadcast: event.payload.broadcast } : {}),
          });
          const mine = newMsg.senderId === currentPersonId;
          // My own send echoed back by the server's sender self-broadcast: its outbox entry leaves and
          // the server's row takes its place, keeping what only this device has (the inline pictures).
          // The server sends the sender BOTH msg:new and msg:sent, in either order; whichever comes
          // first confirms the entry, the second finds the id in `echoedIdsRef`. A `failed` entry is a
          // DIFFERENT message that never left: it is never the one an echo confirms.
          let shown = newMsg;
          if (mine && !echoedIdsRef.current.has(newMsg.id)) {
            const address = addressOf(event.payload.conversationId);
            const entry = outbox
              .read(address)
              .find((e) => e.state !== OUTBOX_STATE.FAILED && echoConfirms(e, newMsg));
            if (entry) {
              outbox.remove(address, entry.id);
              shown = asHostMessage<M>({
                ...entry.row,
                ...newMsg,
                ...(entry.row.images ? { images: entry.row.images } : {}),
                deliveryStatus: entry.row.deliveryStatus,
                reactions: entry.row.reactions ?? [],
              });
            }
          }
          if (mine) echoedIdsRef.current.add(newMsg.id);
          setMessages((prev) => {
            const at = prev.findIndex((m) => m.id === shown.id);
            if (at === -1) return [...prev, shown];
            // Already present: a reconnection, or msg:sent put my row in first. The echo carries what
            // msg:sent does not (the words as stored, a filter's version of them, the pictures' URLs).
            if (!mine) return prev;
            const copy = [...prev];
            const held = copy[at]!;
            copy[at] = {
              ...held,
              text: newMsg.text,
              modified: newMsg.modified,
              mediaUrl: newMsg.mediaUrl ?? held.mediaUrl,
              mediaUrls: newMsg.mediaUrls ?? held.mediaUrls ?? null,
            };
            return copy;
          });
          setTypingIndicators((prev) => prev.filter((t) => t.personId !== event.payload.senderId));
          break;
        }

        case 'msg:sent': {
          // Confirmation that my message was persisted (its id only). Its echo may already have
          // confirmed it; otherwise the oldest entry still waiting is the one (the server answers in
          // the order it was sent), and the server's id replaces the pending one.
          if (event.payload.conversationId !== conversationIdRef.current) break;
          const { messageId } = event.payload;
          if (echoedIdsRef.current.has(messageId)) break;
          const address = addressOf(event.payload.conversationId);
          const entry = outbox.read(address).find((e) => e.state !== OUTBOX_STATE.FAILED);
          if (!entry) break;
          echoedIdsRef.current.add(messageId);
          outbox.remove(address, entry.id);
          const confirmed = asHostMessage<M>({
            ...entry.row,
            id: messageId,
            createdAt: event.payload.createdAt ?? entry.row.createdAt,
          });
          setMessages((prev) => (prev.some((m) => m.id === messageId) ? prev : [...prev, confirmed]));
          break;
        }

        case 'msg:read': {
          if (event.payload.conversationId !== conversationIdRef.current) break;
          // Update delivery status for messages read by this person. A receipt that changes nothing keeps
          // the SAME list: a new list makes the open view read again (every side reads, К3 2026-11-20), and
          // that read is the other side's receipt — two open chats would bounce reads forever.
          setMessages((prev) => {
            let changed = false;
            const next = prev.map((msg) => {
              if (
                msg.senderId === currentPersonId &&
                msg.deliveryStatus !== 'READ' &&
                msg.createdAt <= event.payload.upTo
              ) {
                changed = true;
                return { ...msg, deliveryStatus: 'READ' as const };
              }
              return msg;
            });
            return changed ? next : prev;
          });
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
      if (isConnected === null) return;
      setConnected(isConnected);
      // The link went down: an echo still owed for a send on it will never come over it. Every
      // waiting send of the open conversation says "not sent" now, with its retry.
      const cid = conversationIdRef.current;
      if (!isConnected && cid) failWaitingEntries(outbox, addressOf(cid));
    });

    return () => {
      unmountedRef.current = true;
      unsubscribeEvents();
      unsubscribeConnection();
    };
  }, [currentPersonId, transport, outbox, addressOf]);

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

  /**
   * Posts a send of MINE that is already in the outbox, and records the host's answer on its entry: a
   * refusal or a dead link makes it `failed` (the row says "not sent", `retrySend` posts it again); an
   * accepted command leaves it `unconfirmed` until the server's echo removes it. The answer is recorded
   * even when this screen is gone by then: the outbox outlives it, and so must the verdict.
   */
  const postSend = useCallback(
    (address: string, entry: MessengerOutboxEntry): void => {
      void postCommand(entry.command).then((ok) => {
        outbox.update(address, entry.id, (held) => ({
          ...held,
          handedOff: held.handedOff || ok,
          state:
            held.state === OUTBOX_STATE.SENDING
              ? ok
                ? OUTBOX_STATE.UNCONFIRMED
                : OUTBOX_STATE.FAILED
              : held.state,
        }));
      });
    },
    [outbox, postCommand],
  );

  /** Puts a new send of mine into the outbox (its row shows at once) and posts it. */
  const send = useCallback(
    (row: M, command: MsgClientEvent): void => {
      const address = addressOf(row.conversationId);
      const entry: MessengerOutboxEntry = {
        id: row.id,
        state: OUTBOX_STATE.SENDING,
        handedOff: false,
        row,
        command,
      };
      outbox.put(address, entry);
      postSend(address, entry);
    },
    [outbox, addressOf, postSend],
  );

  const retrySend = useCallback(
    (messageId: string): void => {
      const cid = conversationIdRef.current;
      if (!cid) return;
      const address = addressOf(cid);
      const held = outbox.read(address).find((entry) => entry.id === messageId);
      if (!held || held.state !== OUTBOX_STATE.FAILED) return;
      const again: MessengerOutboxEntry = { ...held, state: OUTBOX_STATE.SENDING };
      outbox.put(address, again);
      postSend(address, again);
    },
    [outbox, addressOf, postSend],
  );

  const sendMessage = useCallback(
    (text: string, opts?: { replyToId?: string; images?: MessageImagePayload[] }) => {
      if (!conversationIdRef.current) return;
      const images = opts?.images;

      // Every message of mine shows at once (an image from its inline base64) and stays in the outbox
      // until the server confirms it: msg:new (its self-broadcast) and msg:sent (id only) arrive in
      // either order, and whichever comes first swaps this `pending-` row for the server's, so it
      // converges on one message. A text used to show only once echoed, so a text the server dropped
      // without a word vanished with nothing on screen to say so.
      const row = asHostMessage<M>({
        id: nextPendingId(),
        conversationId: conversationIdRef.current,
        senderId: currentPersonId ?? '',
        senderName: '',
        text,
        messageType: images?.length ? 'IMAGE' : 'TEXT',
        mediaUrl: null,
        ...(images?.length ? { images } : {}), // inline base64 so it shows instantly; persisted copy loads on reload
        replyToId: opts?.replyToId ?? null,
        replyToPreview: null,
        createdAt: new Date().toISOString(),
        editedAt: null,
        deletedAt: null,
        deliveryStatus: 'SENT',
        modified: null,
      });

      send(row, {
        type: 'msg:send',
        payload: {
          conversationId: conversationIdRef.current,
          text,
          replyToId: opts?.replyToId,
          images: opts?.images,
        },
      });
    },
    [currentPersonId, nextPendingId, send],
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
        id: nextPendingId(),
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
      send(optimistic, {
        type: 'msg:send',
        payload: {
          conversationId: conversationIdRef.current,
          text: '', // server derives motion|sound from the sticker
          messageType: 'STICKER',
          stickerId,
        },
      });
    },
    [currentPersonId, nextPendingId, send],
  );

  const announceE2eeEnvelope = useCallback(
    (envelopeId: string, opts?: { broadcast?: BroadcastMention }): Promise<boolean> => {
      if (!conversationIdRef.current || !envelopeId) return Promise.resolve(false);
      return postCommand({
        type: 'msg:send',
        payload: {
          conversationId: conversationIdRef.current,
          text: '',
          e2eeEnvelopeId: envelopeId,
          ...(opts?.broadcast ? { broadcast: opts.broadcast } : {}),
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
      const cid = conversationIdRef.current;
      if (!cid) return;
      // A row the server never confirmed has no server copy: discarding it is local, and a delete
      // command for a `pending-` id would only earn an error.
      if (messageId.startsWith(PENDING_MESSAGE_ID_PREFIX)) {
        outbox.remove(addressOf(cid), messageId);
        return;
      }
      // Optimistic update — mark as deleted locally
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === messageId ? { ...msg, deletedAt: new Date().toISOString(), text: '' } : msg,
        ),
      );
      sendCommand({
        type: 'msg:delete',
        payload: { messageId, conversationId: cid },
      });
    },
    [sendCommand, outbox, addressOf],
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
    retrySend,
    loadMore,
    hasMore,
    loadingHistory,
    lastError,
  };
}
