/**
 * A `useMessenger` result a screen test can drive without a transport: plain data plus spies on
 * every action. Test-only.
 */
import { vi, type Mock } from 'vitest';
import type { UseMessengerReturn } from '../hooks/use-messenger.js';
import type { MessengerMessage } from '../protocol/messages.js';

let nextId = 1;

export function makeMessage(over: Partial<MessengerMessage> = {}): MessengerMessage {
  const id = over.id ?? `m${nextId++}`;
  return {
    id,
    conversationId: 'c1',
    senderId: 'them',
    senderName: 'Ada',
    text: 'hello',
    messageType: 'TEXT',
    mediaUrl: null,
    replyToId: null,
    replyToPreview: null,
    createdAt: '2026-10-10T10:00:00.000Z',
    editedAt: null,
    deletedAt: null,
    deliveryStatus: null,
    modified: null,
    reactions: [],
    ...over,
  };
}

type Actions = Pick<
  UseMessengerReturn,
  'sendMessage' | 'sendSticker' | 'sendTyping' | 'markRead' | 'deleteMessage' | 'editMessage' | 'reactToMessage' | 'loadMore'
>;

export type FakeMessenger = UseMessengerReturn & { [K in keyof Actions]: Mock<Actions[K]> };

export function makeMessenger(over: Partial<UseMessengerReturn> = {}): FakeMessenger {
  return {
    messages: [],
    connected: true,
    typingIndicators: [],
    sendMessage: vi.fn(),
    sendSticker: vi.fn(),
    sendTyping: vi.fn(),
    markRead: vi.fn(),
    deleteMessage: vi.fn(),
    editMessage: vi.fn(),
    reactToMessage: vi.fn(),
    loadMore: vi.fn(),
    hasMore: false,
    loadingHistory: false,
    lastError: null,
    ...over,
  } as FakeMessenger;
}
