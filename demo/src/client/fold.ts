import {
  applyE2eeReaction,
  canApplyE2eeChange,
  E2EE_PAYLOAD_VERSION,
  e2eePayloadToEvent,
  type E2eePayload,
  type E2eePayloadInput,
} from '@masia/messenger/protocol';
import { PENDING_MESSAGE_ID_PREFIX } from '@masia/messenger/hooks';
import type { MessengerMessage } from '@masia/messenger/protocol';
import type { HistoryItem } from './history.js';

// A room's decrypted history as the conversation screen's messages. Pure.
//
// Every payload goes through `e2eePayloadToEvent` (the package's one mapping to view-model events) and
// is folded the way the plaintext path folds server events: a text is a message; an edit or a delete
// changes its target only when the SAME member sent both (`canApplyE2eeChange`: the sender comes from
// the MLS tree, never from the payload); a reaction is anyone's. A message that could not be read is a
// line that says so, never dropped. Messages still on their way are shown as pending.

export interface FoldContext {
  readonly conversationId: string;
  /** The person behind a user id: the bubble's side and name. */
  personOf(userId: string): { readonly id: string; readonly name: string } | undefined;
  readonly self: { readonly id: string; readonly name: string };
  /** What an unreadable message says. */
  readonly unreadableText: string;
  /** What a sticker says here: the playground has no sticker catalog. */
  readonly stickerText: string;
}

export const UNREADABLE_ID_PREFIX = 'unreadable-';

function base(
  context: FoldContext,
  fields: Pick<
    MessengerMessage,
    'id' | 'senderId' | 'senderName' | 'text' | 'messageType' | 'createdAt'
  > &
    Partial<Pick<MessengerMessage, 'replyToId' | 'replyToPreview' | 'deliveryStatus'>>,
): MessengerMessage {
  return {
    conversationId: context.conversationId,
    mediaUrl: null,
    replyToId: null,
    replyToPreview: null,
    editedAt: null,
    deletedAt: null,
    deliveryStatus: null,
    modified: null,
    reactions: [],
    ...fields,
  };
}

function replyPreview(payload: E2eePayloadInput): MessengerMessage['replyToPreview'] {
  if ((payload.kind !== 'text' && payload.kind !== 'sticker') || !payload.replyTo?.quote) return null;
  return { text: payload.replyTo.quote, senderName: payload.replyTo.senderName ?? '' };
}

export function foldHistory(
  history: readonly HistoryItem[],
  queued: readonly E2eePayloadInput[],
  context: FoldContext,
): MessengerMessage[] {
  const messages: MessengerMessage[] = [];
  const byId = new Map<string, { message: MessengerMessage; senderUserId: string }>();

  for (const item of history) {
    const person = context.personOf(item.senderUserId);
    const senderId = person?.id ?? item.senderUserId;
    const senderName = person?.name ?? '';
    if (!item.payload) {
      messages.push(
        base(context, {
          id: `${UNREADABLE_ID_PREFIX}${item.seq}`,
          senderId,
          senderName,
          text: context.unreadableText,
          messageType: 'SYSTEM',
          createdAt: item.createdAt,
        }),
      );
      continue;
    }
    const event = e2eePayloadToEvent(item.payload, {
      conversationId: context.conversationId,
      senderId,
      senderName,
      createdAt: item.createdAt,
    });
    if (event.type === 'msg:new') {
      if (byId.has(event.payload.id)) continue; // a replayed id: the first one stands
      const message = base(context, {
        id: event.payload.id,
        senderId: event.payload.senderId,
        senderName: event.payload.senderName,
        text: event.payload.text,
        messageType: event.payload.messageType as MessengerMessage['messageType'],
        createdAt: event.payload.createdAt,
        replyToId: event.payload.replyToId ?? null,
        replyToPreview: replyPreview(item.payload),
        deliveryStatus: 'SENT',
      });
      if (item.payload.kind === 'sticker') {
        message.messageType = 'TEXT';
        message.text = context.stickerText;
      }
      if (item.payload.kind === 'notice') message.text = context.unreadableText;
      messages.push(message);
      byId.set(message.id, { message, senderUserId: item.senderUserId });
      continue;
    }
    if (event.type === 'e2ee:reaction') {
      const reacted = byId.get(event.payload.messageId);
      if (reacted) {
        reacted.message.reactions = applyE2eeReaction(reacted.message.reactions ?? [], event.payload);
      }
      continue;
    }
    const target = byId.get(event.payload.messageId);
    if (
      !target ||
      !canApplyE2eeChange({ senderId: item.senderUserId }, { senderId: target.senderUserId })
    ) {
      continue;
    }
    if (event.type === 'msg:edited') {
      target.message.text = event.payload.text;
      target.message.editedAt = event.payload.editedAt;
    } else {
      target.message.text = '';
      target.message.deletedAt = item.createdAt;
    }
  }

  for (const input of queued) {
    if (byId.has(input.id)) continue;
    const payload = { ...input, v: E2EE_PAYLOAD_VERSION } as E2eePayload;
    const event = e2eePayloadToEvent(payload, {
      conversationId: context.conversationId,
      senderId: context.self.id,
      senderName: context.self.name,
      createdAt: new Date().toISOString(),
    });
    if (event.type !== 'msg:new') continue; // a queued edit or delete shows once it is stored
    messages.push(
      base(context, {
        id: `${PENDING_MESSAGE_ID_PREFIX}${input.id}`,
        senderId: event.payload.senderId,
        senderName: event.payload.senderName,
        text: event.payload.text,
        messageType: event.payload.messageType as MessengerMessage['messageType'],
        createdAt: event.payload.createdAt,
        replyToId: event.payload.replyToId ?? null,
        replyToPreview: replyPreview(input),
        deliveryStatus: null,
      }),
    );
  }
  return messages;
}
