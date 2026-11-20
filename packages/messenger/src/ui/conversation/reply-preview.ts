/**
 * The client half of the reply preview (internal ADR-199 §1). The server fills `replyToPreview` for
 * history and `msg:new`; what it could not fill (the sender's own optimistic row, a host that has not
 * caught up) the conversation view derives here from the messages it has loaded. A parent that is not
 * loaded stays without a preview: the bubble then draws no quote rather than a wrong one.
 */
import type { MessengerMessage, ReplyToPreview } from '../../protocol/messages.js';

/** The placeholder text the hosts send for a picture-only message; it is not a quote. */
export const IMAGE_ONLY_PLACEHOLDER = '(image)';

/** The words a reply shows of `parent`: nothing of a deleted one, nothing of a sticker or a bare picture. */
export function replyPreviewOf(parent: MessengerMessage): ReplyToPreview {
  if (parent.deletedAt) return { text: '', senderName: parent.senderName, deleted: true };
  const quotable = parent.messageType !== 'STICKER' && parent.text !== IMAGE_ONLY_PLACEHOLDER;
  return { text: quotable ? (parent.modified?.text ?? parent.text) : '', senderName: parent.senderName };
}

/** The same list, with every reply whose preview the server left empty filled from a loaded parent. */
export function withReplyPreviews<M extends MessengerMessage>(messages: readonly M[]): M[] {
  let byId: Map<string, M> | null = null;
  return messages.map((message) => {
    if (!message.replyToId || message.replyToPreview !== null) return message;
    byId ??= new Map(messages.map((m) => [m.id, m]));
    const parent = byId.get(message.replyToId);
    return parent ? { ...message, replyToPreview: replyPreviewOf(parent) } : message;
  });
}
