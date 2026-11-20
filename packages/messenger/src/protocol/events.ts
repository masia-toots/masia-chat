/**
 * The `msg:*` events of the current host protocol: what a client sends (commands) and what the server
 * pushes (events). Plain JSON shapes; the codec (`./codec`) turns them into bytes for the `Transport`.
 */
import type {
  BroadcastMention,
  MessageImagePayload,
  MessageReaction,
  ReplyToPreview,
  SendableMessageType,
} from './messages.js';

// ── Client → server (commands) ───────────────────────────────────────────────

export interface MsgSendEvent {
  type: 'msg:send';
  payload: {
    conversationId: string;
    text: string;
    messageType?: SendableMessageType;
    replyToId?: string;
    /** Images attached to the message (base64 data URIs). Persisted server-side. */
    images?: MessageImagePayload[];
    /**
     * For messageType 'STICKER': the id of a saved sticker. The server resolves
     * the image URL + motion/sound from the sticker record (the client must NOT
     * supply the image URL — that would let a user send an arbitrary image).
     */
    stickerId?: string;
    /**
     * End-to-end encrypted room: the payload id of a message that is now on the relay. `text` is `''`
     * then; the host stores a metadata row (unread counts, a push without text), never the text.
     */
    e2eeEnvelopeId?: string;
    /**
     * With `e2eeEnvelopeId`: the message called the room with `@all` / `@online` (ADR-201). The one bit the host
     * learns of an encrypted text — it raises the push to a mention; it never learns the text or an addressee.
     */
    broadcast?: BroadcastMention;
  };
}

export interface MsgTypingClientEvent {
  type: 'msg:typing';
  payload: {
    conversationId: string;
    isTyping: boolean;
  };
}

export interface MsgReadClientEvent {
  type: 'msg:read';
  payload: {
    conversationId: string;
    upTo: string;
  };
}

export interface MsgDeleteClientEvent {
  type: 'msg:delete';
  payload: {
    messageId: string;
    conversationId: string;
  };
}

export interface MsgEditClientEvent {
  type: 'msg:edit';
  payload: {
    messageId: string;
    conversationId: string;
    text: string;
  };
}

export interface MsgReactClientEvent {
  type: 'msg:react';
  payload: {
    messageId: string;
    conversationId: string;
    /** A single emoji; toggles (add if absent, remove if this person already set it). */
    reaction: string;
  };
}

export type MsgClientEvent =
  | MsgSendEvent
  | MsgTypingClientEvent
  | MsgReadClientEvent
  | MsgDeleteClientEvent
  | MsgEditClientEvent
  | MsgReactClientEvent;

// ── Server → client (events) ─────────────────────────────────────────────────

export interface MsgNewEvent {
  type: 'msg:new';
  payload: {
    id: string;
    conversationId: string;
    senderId: string;
    senderName: string;
    text: string;
    /** A plain string: the server may send a kind this client does not know. */
    messageType: string;
    mediaUrl?: string | null;
    /** All attached image URLs (multi-image). mediaUrl mirrors the first. */
    mediaUrls?: string[] | null;
    replyToId?: string | null;
    /** The parent's words, joined by the server when `replyToId` is set (see `ReplyToPreview`). */
    replyToPreview?: ReplyToPreview | null;
    createdAt: string;
    modified?: { text: string; ruleName: string | null } | undefined;
    /** See `MessengerMessage.e2eeEnvelopeId`. */
    e2eeEnvelopeId?: string;
    /** See `MessengerMessage.serviceMeta`. */
    serviceMeta?: unknown;
    /** See `MessengerMessage.broadcast`. */
    broadcast?: BroadcastMention;
  };
}

export interface MsgSentEvent {
  type: 'msg:sent';
  payload: {
    messageId: string;
    conversationId: string;
    createdAt: string;
  };
}

export interface MsgReadEvent {
  type: 'msg:read';
  payload: {
    conversationId: string;
    personId: string;
    upTo: string;
  };
}

export interface MsgTypingEvent {
  type: 'msg:typing';
  payload: {
    conversationId: string;
    personId: string;
    personName: string;
    isTyping: boolean;
  };
}

export interface MsgDeletedEvent {
  type: 'msg:deleted';
  payload: {
    messageId: string;
    conversationId: string;
  };
}

export interface MsgEditedEvent {
  type: 'msg:edited';
  payload: {
    messageId: string;
    conversationId: string;
    text: string;
    editedAt: string;
  };
}

export interface MsgReactedEvent {
  type: 'msg:reacted';
  payload: {
    messageId: string;
    conversationId: string;
    /** The full, authoritative reaction set for the message after the toggle. */
    reactions: MessageReaction[];
  };
}

export interface MsgErrorEvent {
  type: 'msg:error';
  payload: {
    code: string;
    message: string;
  };
}

/**
 * The host's ONE unread number for a room, pushed to every socket of the person it belongs to after a delivery
 * to them and after they read (ADR-201). A client never derives a count from `msg:new`: it seeds its store from
 * the inbox preview (`unreadCount` · `unreadMentions`) and replaces a room's numbers with each of these.
 *
 * It rides its own topic (`UNREAD_EVENT_TOPIC`), not `MESSENGER_EVENT_TOPIC`: it is about the person's whole
 * inbox, so it must reach a client that has no conversation open.
 */
export interface UnreadUpdateEvent {
  type: 'unread:update';
  payload: {
    conversationId: string;
    /** Messages the person has not read in this room (0 when fully read). */
    unreadCount: number;
    /**
     * The subset of `unreadCount` that calls the person by name: their own `@tag`, `@all`, `@online`, or an
     * encrypted row that carries a broadcast flag. Always `<= unreadCount`.
     */
    unreadMentions: number;
  };
}

export type MsgServerEvent =
  | MsgNewEvent
  | MsgSentEvent
  | MsgReadEvent
  | MsgTypingEvent
  | MsgDeletedEvent
  | MsgEditedEvent
  | MsgReactedEvent
  | MsgErrorEvent
  | UnreadUpdateEvent;
