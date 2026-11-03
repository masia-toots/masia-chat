/**
 * The message shapes on the messenger's wire, as the current host protocol speaks them.
 *
 * Why here and not in the host: the hooks and screens in this package read and write exactly these
 * fields, so the package owns their definition and the host re-exports it (one home, ADR-161).
 */

/**
 * The kinds of message the current wire carries. `TASK_CARD`, `KNOWLEDGE_CARD` and `SERVICE` are
 * posted by the host (in Masia, by the assistant); the messenger passes them through untouched and
 * renders only the kinds it knows.
 */
export type MessageType =
  | 'TEXT'
  | 'IMAGE'
  | 'VOICE'
  | 'FILE'
  | 'TASK_CARD'
  | 'KNOWLEDGE_CARD'
  | 'STICKER'
  | 'SYSTEM'
  | 'SERVICE';

/** The kinds a client may SEND; the others are only ever posted by the host. */
export type SendableMessageType = Extract<
  MessageType,
  'TEXT' | 'IMAGE' | 'VOICE' | 'FILE' | 'STICKER'
>;

export type DeliveryStatus = 'SENT' | 'DELIVERED' | 'READ';

/** An inline image: a base64 data URI, sent with a message and shown before the upload finishes. */
export interface MessageImagePayload {
  /** Base64 data URI (e.g. "data:image/png;base64,iVBOR..."). */
  dataUrl: string;
  mimeType: string;
}

/** One person's emoji on one message. */
export interface MessageReaction {
  personId: string;
  reaction: string;
}

/**
 * A single message, as the history endpoint returns it and the live events build it: every field
 * this package reads or writes.
 *
 * A host whose server sends more (Masia adds sources, task links, cards, service metadata) extends
 * this interface with OPTIONAL fields and passes its type to the hooks as the type argument. The
 * hooks never drop the extras: history rows are kept whole, and live updates spread the row they
 * change.
 */
export interface MessengerMessage {
  id: string;
  conversationId: string;
  senderId: string;
  senderName: string;
  text: string;
  messageType: MessageType;
  mediaUrl: string | null;
  /** All persisted image URLs (multi-image). `mediaUrl` mirrors the first; survives reload. */
  mediaUrls?: string[] | null;
  /**
   * Inline base64 images attached to this message (vision input / optimistic render).
   * Echoed back over the wire on send; persisted copies are served via `mediaUrls`/`mediaUrl`.
   */
  images?: MessageImagePayload[];
  replyToId: string | null;
  replyToPreview: { text: string; senderName: string } | null;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
  deliveryStatus: DeliveryStatus | null;
  modified: { text: string; ruleName: string | null } | null;
  /**
   * Emoji reactions on this message. One row per person+emoji; aggregate by `reaction` for display.
   * The server may send extra fields (id, createdAt) — only `personId` + `reaction` are read.
   */
  reactions?: MessageReaction[];
  /**
   * In an end-to-end encrypted room: the id of the encrypted message this row stands for (the payload
   * id inside the ciphertext, canon section 10). The host keeps the row as metadata only (no text);
   * the client shows the decrypted message, never this row.
   */
  e2eeEnvelopeId?: string | null;
  /**
   * Host-defined structured data of a SYSTEM/SERVICE row (for example a notice code the client words).
   * Passed through untouched; the host's own message type narrows it.
   */
  serviceMeta?: unknown;
}

/** People currently typing in the active conversation. */
export interface TypingIndicator {
  personId: string;
  personName: string;
}
