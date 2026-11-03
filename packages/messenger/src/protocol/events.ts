/**
 * The `msg:*` events of the current host protocol: what a client sends (commands) and what the server
 * pushes (events). Plain JSON shapes; the codec (`./codec`) turns them into bytes for the `Transport`.
 */
import type { MessageImagePayload, MessageReaction, SendableMessageType } from './messages.js';

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
    createdAt: string;
    modified?: { text: string; ruleName: string | null } | undefined;
    /** See `MessengerMessage.e2eeEnvelopeId`. */
    e2eeEnvelopeId?: string;
    /** See `MessengerMessage.serviceMeta`. */
    serviceMeta?: unknown;
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

export type MsgServerEvent =
  | MsgNewEvent
  | MsgSentEvent
  | MsgReadEvent
  | MsgTypingEvent
  | MsgDeletedEvent
  | MsgEditedEvent
  | MsgReactedEvent
  | MsgErrorEvent;
