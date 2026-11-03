// @vitest-environment jsdom
/**
 * useMessenger against the contracts' fake transport: history through `fetch`, live events and the
 * link state through topics, commands through POSTs. These are the behaviours the hub's chat screen
 * depends on, asserted at the port, with no socket and no server.
 */
import { createFakeTransport, type FakeTransport } from '@masia/contracts/fakes';
import type { TransportResponse } from '@masia/contracts';
import { act } from 'react';
import { describe, expect, it } from 'vitest';
import {
  encodeConnectionState,
  encodeMsgServerEvent,
  historyPagePath,
  MESSENGER_COMMAND_PATH,
  MESSENGER_CONNECTION_TOPIC,
  MESSENGER_EVENT_TOPIC,
} from '../../protocol/codec.js';
import type { MsgClientEvent, MsgServerEvent } from '../../protocol/events.js';
import type { MessengerMessage } from '../../protocol/messages.js';
import { renderHook, settle, type RenderedHook } from '../../test-support/render-hook.js';
import { MESSENGER_HOOK_ERRORS, useMessenger, type UseMessengerReturn } from '../use-messenger.js';

const CONVERSATION = 'conv-1';
const OTHER_CONVERSATION = 'conv-2';
const ME = 'person-me';
const OTHER = 'person-other';

/** Stable across renders, as the hook requires of `historyPath`. */
const historyPath = (conversationId: string): string => `/history/${conversationId}`;

/** A host message type that carries a field the package does not know. */
interface HostMessage extends MessengerMessage {
  cards?: string[];
}

function json(body: unknown, status = 200): TransportResponse {
  return { status, headers: {}, body: new TextEncoder().encode(JSON.stringify(body)) };
}

const ACCEPTED: TransportResponse = { status: 202, headers: {}, body: new Uint8Array() };

function message(id: string, over: Partial<HostMessage> = {}): HostMessage {
  return {
    id,
    conversationId: CONVERSATION,
    senderId: OTHER,
    senderName: 'Other',
    text: `text of ${id}`,
    messageType: 'TEXT',
    mediaUrl: null,
    replyToId: null,
    replyToPreview: null,
    createdAt: '2026-01-01T00:00:05.000Z',
    editedAt: null,
    deletedAt: null,
    deliveryStatus: null,
    modified: null,
    ...over,
  };
}

function newEvent(
  id: string,
  over: Partial<Extract<MsgServerEvent, { type: 'msg:new' }>['payload']> = {},
): MsgServerEvent {
  return {
    type: 'msg:new',
    payload: {
      id,
      conversationId: CONVERSATION,
      senderId: OTHER,
      senderName: 'Other',
      text: `live ${id}`,
      messageType: 'TEXT',
      createdAt: '2026-01-01T00:01:00.000Z',
      ...over,
    },
  };
}

interface Harness {
  transport: FakeTransport;
  hook: RenderedHook<UseMessengerReturn<HostMessage>>;
  push(event: MsgServerEvent): Promise<void>;
  commands(): MsgClientEvent[];
}

interface SetupOptions {
  routes?: Record<string, TransportResponse>;
  history?: HostMessage[];
  conversationId?: () => string | null;
  withHistorySource?: boolean;
}

async function setup(options: SetupOptions = {}): Promise<Harness> {
  const transport = createFakeTransport({
    routes: {
      [historyPagePath(historyPath(CONVERSATION), null)]: json({
        messages: options.history ?? [],
        nextCursor: null,
      }),
      [MESSENGER_COMMAND_PATH]: ACCEPTED,
      ...options.routes,
    },
  });
  const conversationId = options.conversationId ?? (() => CONVERSATION);
  const hook = await renderHook(() =>
    useMessenger<HostMessage>({
      transport,
      conversationId: conversationId(),
      currentPersonId: ME,
      historyPath: options.withHistorySource === false ? null : historyPath,
    }),
  );
  await settle();
  return {
    transport,
    hook,
    async push(event) {
      await act(async () => {
        transport.publish(MESSENGER_EVENT_TOPIC, encodeMsgServerEvent(event));
      });
    },
    commands() {
      return transport.calls
        .filter((call) => call.path === MESSENGER_COMMAND_PATH)
        .map((call) => JSON.parse(String(call.init?.body)) as MsgClientEvent);
    },
  };
}

const ids = (messages: readonly MessengerMessage[]): string[] => messages.map((m) => m.id);

describe('history', () => {
  it('loads the newest page through the transport and pages older messages in on loadMore', async () => {
    const newest = historyPagePath(historyPath(CONVERSATION), null);
    const older = historyPagePath(historyPath(CONVERSATION), 'cursor-1');
    const { hook, transport } = await setup({
      routes: {
        [newest]: json({ messages: [message('h2'), message('h3')], nextCursor: 'cursor-1' }),
        [older]: json({ messages: [message('h0'), message('h1')], nextCursor: null }),
      },
    });

    expect(ids(hook.current.messages)).toEqual(['h2', 'h3']);
    expect(hook.current.hasMore).toBe(true);
    expect(hook.current.loadingHistory).toBe(false);

    await act(async () => {
      hook.current.loadMore();
    });
    await settle();

    expect(ids(hook.current.messages)).toEqual(['h0', 'h1', 'h2', 'h3']);
    expect(hook.current.hasMore).toBe(false);
    expect(transport.calls.map((call) => call.path)).toEqual([newest, older]);
  });

  it('reports a failed load in lastError instead of throwing, and shows nothing', async () => {
    const { hook } = await setup({
      routes: { [historyPagePath(historyPath(CONVERSATION), null)]: json({}, 500) },
    });
    expect(hook.current.messages).toEqual([]);
    expect(hook.current.lastError).toBe(MESSENGER_HOOK_ERRORS.historyLoadFailed);
    expect(hook.current.loadingHistory).toBe(false);
  });

  it('asks for nothing when the host gives no history source', async () => {
    const { transport, hook } = await setup({ withHistorySource: false });
    expect(transport.calls).toEqual([]);
    expect(hook.current.messages).toEqual([]);
  });

  it('drops the old conversation and loads the new one when the conversation changes', async () => {
    let conversation = CONVERSATION;
    const { hook } = await setup({
      history: [message('first')],
      conversationId: () => conversation,
      routes: {
        [historyPagePath(historyPath(OTHER_CONVERSATION), null)]: json({
          messages: [message('second', { conversationId: OTHER_CONVERSATION })],
          nextCursor: null,
        }),
      },
    });
    expect(ids(hook.current.messages)).toEqual(['first']);

    conversation = OTHER_CONVERSATION;
    await hook.rerender();
    await settle();

    expect(ids(hook.current.messages)).toEqual(['second']);
  });
});

describe('live events', () => {
  it('appends a message from the open conversation once, using the filtered text when there is one', async () => {
    const { hook, push } = await setup();

    await push(newEvent('n1', { modified: { text: 'filtered', ruleName: 'rule' } }));
    await push(newEvent('n1'));
    await push(newEvent('elsewhere', { conversationId: OTHER_CONVERSATION }));

    expect(ids(hook.current.messages)).toEqual(['n1']);
    expect(hook.current.messages[0]?.text).toBe('filtered');
    expect(hook.current.messages[0]?.modified).toEqual({ text: 'filtered', ruleName: 'rule' });
  });

  it('shows who is typing, ignores me, and clears someone when their message arrives', async () => {
    const { hook, push } = await setup();
    const typing = (personId: string, isTyping: boolean): MsgServerEvent => ({
      type: 'msg:typing',
      payload: { conversationId: CONVERSATION, personId, personName: personId, isTyping },
    });

    await push(typing(OTHER, true));
    await push(typing(OTHER, true));
    await push(typing(ME, true));
    expect(hook.current.typingIndicators).toEqual([{ personId: OTHER, personName: OTHER }]);

    await push(newEvent('n1', { senderId: OTHER }));
    expect(hook.current.typingIndicators).toEqual([]);
  });

  it("marks my messages read up to the reader's mark, and no further", async () => {
    const { hook, push } = await setup({
      history: [
        message('mine-early', { senderId: ME, createdAt: '2026-01-01T00:00:01.000Z' }),
        message('mine-late', { senderId: ME, createdAt: '2026-01-01T00:00:09.000Z' }),
        message('theirs', { senderId: OTHER, createdAt: '2026-01-01T00:00:01.000Z' }),
      ],
    });

    await push({
      type: 'msg:read',
      payload: { conversationId: CONVERSATION, personId: OTHER, upTo: '2026-01-01T00:00:05.000Z' },
    });

    const status = Object.fromEntries(hook.current.messages.map((m) => [m.id, m.deliveryStatus]));
    expect(status).toEqual({ 'mine-early': 'READ', 'mine-late': null, theirs: null });
  });

  it('applies edit, delete and the authoritative reaction set to the right message and keeps host fields', async () => {
    const { hook, push } = await setup({
      history: [message('a', { cards: ['card'] }), message('b')],
    });

    await push({
      type: 'msg:edited',
      payload: { messageId: 'a', conversationId: CONVERSATION, text: 'edited', editedAt: 'T-edit' },
    });
    await push({ type: 'msg:deleted', payload: { messageId: 'b', conversationId: CONVERSATION } });
    await push({
      type: 'msg:reacted',
      payload: {
        messageId: 'a',
        conversationId: CONVERSATION,
        reactions: [{ personId: OTHER, reaction: '👍' }],
      },
    });

    const [a, b] = hook.current.messages;
    expect(a).toMatchObject({
      text: 'edited',
      editedAt: 'T-edit',
      reactions: [{ personId: OTHER, reaction: '👍' }],
      cards: ['card'],
    });
    expect(b?.text).toBe('');
    expect(b?.deletedAt).not.toBeNull();
  });

  it('follows the link state the transport announces', async () => {
    const { hook, transport } = await setup();
    expect(hook.current.connected).toBe(false);

    await act(async () => {
      transport.publish(MESSENGER_CONNECTION_TOPIC, encodeConnectionState(true));
    });
    expect(hook.current.connected).toBe(true);

    await act(async () => {
      transport.publish(MESSENGER_CONNECTION_TOPIC, encodeConnectionState(false));
    });
    expect(hook.current.connected).toBe(false);
  });

  it("keeps the server's own error text and ignores bytes it cannot read", async () => {
    const { hook, push, transport } = await setup();

    await act(async () => {
      transport.publish(MESSENGER_EVENT_TOPIC, new TextEncoder().encode('not json'));
      transport.publish(
        MESSENGER_EVENT_TOPIC,
        new TextEncoder().encode(JSON.stringify({ type: 'msg:from-the-future', payload: {} })),
      );
    });
    expect(hook.current.messages).toEqual([]);
    expect(hook.current.lastError).toBeNull();

    await push({ type: 'msg:error', payload: { code: 'RATE', message: 'slow down' } });
    expect(hook.current.lastError).toBe('slow down');
  });
});

describe('actions', () => {
  it('sends a text message as one command and shows nothing until the server echoes it', async () => {
    const { hook, commands, transport } = await setup();

    await act(async () => {
      hook.current.sendMessage('hello', { replyToId: 'r1' });
    });
    await settle();

    expect(commands()).toEqual([
      {
        type: 'msg:send',
        payload: { conversationId: CONVERSATION, text: 'hello', replyToId: 'r1' },
      },
    ]);
    expect(transport.calls.find((c) => c.path === MESSENGER_COMMAND_PATH)?.init?.method).toBe(
      'POST',
    );
    expect(hook.current.messages).toEqual([]);
  });

  it("shows my image message at once and swaps its pending id for the server's on msg:sent", async () => {
    const { hook, push } = await setup();
    const images = [{ dataUrl: 'data:image/png;base64,AA', mimeType: 'image/png' }];

    await act(async () => {
      hook.current.sendMessage('look', { images });
    });
    expect(hook.current.messages).toHaveLength(1);
    expect(hook.current.messages[0]).toMatchObject({ messageType: 'IMAGE', senderId: ME, images });
    expect(hook.current.messages[0]?.id.startsWith('pending-')).toBe(true);

    await push({
      type: 'msg:sent',
      payload: { messageId: 'server-1', conversationId: CONVERSATION, createdAt: 'T-server' },
    });
    expect(hook.current.messages[0]).toMatchObject({ id: 'server-1', createdAt: 'T-server' });

    // The echo that follows must not add a second copy.
    await push(newEvent('server-1', { senderId: ME, messageType: 'IMAGE' }));
    expect(ids(hook.current.messages)).toEqual(['server-1']);
  });

  it('reconciles the pending message in place when the echo arrives before msg:sent', async () => {
    const { hook, push } = await setup();

    await act(async () => {
      hook.current.sendMessage('look', {
        images: [{ dataUrl: 'data:image/png;base64,AA', mimeType: 'image/png' }],
      });
    });
    await push(newEvent('server-2', { senderId: ME, messageType: 'IMAGE' }));

    expect(ids(hook.current.messages)).toEqual(['server-2']);
  });

  it('sends a sticker by id only, and renders it at once from the preset names', async () => {
    const { hook, commands } = await setup();

    await act(async () => {
      hook.current.sendSticker('sticker-1', 'https://img/s.png', 'bounce', 'pop');
      hook.current.sendSticker('sticker-2', 'https://img/t.png', '');
      hook.current.sendSticker('', 'https://img/u.png', 'x');
    });
    await settle();

    expect(hook.current.messages.map((m) => [m.messageType, m.text, m.mediaUrl])).toEqual([
      ['STICKER', 'bounce|pop', 'https://img/s.png'],
      ['STICKER', 'none|none', 'https://img/t.png'],
    ]);
    expect(commands()).toEqual([
      {
        type: 'msg:send',
        payload: {
          conversationId: CONVERSATION,
          text: '',
          messageType: 'STICKER',
          stickerId: 'sticker-1',
        },
      },
      {
        type: 'msg:send',
        payload: {
          conversationId: CONVERSATION,
          text: '',
          messageType: 'STICKER',
          stickerId: 'sticker-2',
        },
      },
    ]);
  });

  it('toggles my reaction at once and tells the server', async () => {
    const { hook, commands } = await setup({ history: [message('m1')] });

    await act(async () => {
      hook.current.reactToMessage('m1', '👍');
    });
    expect(hook.current.messages[0]?.reactions).toEqual([{ personId: ME, reaction: '👍' }]);

    await act(async () => {
      hook.current.reactToMessage('m1', '👍');
    });
    expect(hook.current.messages[0]?.reactions).toEqual([]);

    await settle();
    expect(commands().map((c) => c.type)).toEqual(['msg:react', 'msg:react']);
  });

  it('trims an edit, applies it at once, and refuses a blank one', async () => {
    const { hook, commands } = await setup({ history: [message('m1')] });

    await act(async () => {
      hook.current.editMessage('m1', '  new text  ');
      hook.current.editMessage('m1', '   ');
    });
    await settle();

    expect(hook.current.messages[0]?.text).toBe('new text');
    expect(hook.current.messages[0]?.editedAt).not.toBeNull();
    expect(commands()).toEqual([
      {
        type: 'msg:edit',
        payload: { messageId: 'm1', conversationId: CONVERSATION, text: 'new text' },
      },
    ]);
  });

  it('marks a deleted message at once and sends typing and read marks', async () => {
    const { hook, commands } = await setup({ history: [message('m1')] });

    await act(async () => {
      hook.current.deleteMessage('m1');
      hook.current.sendTyping(true);
      hook.current.markRead('2026-01-01T00:02:00.000Z');
    });
    await settle();

    expect(hook.current.messages[0]).toMatchObject({ text: '' });
    expect(hook.current.messages[0]?.deletedAt).not.toBeNull();
    expect(commands().map((c) => c.type)).toEqual(['msg:delete', 'msg:typing', 'msg:read']);
  });

  it('reports a refused command in lastError', async () => {
    // No command route: the fake relay answers 404.
    const transport = createFakeTransport();
    const hook = await renderHook(() =>
      useMessenger({
        transport,
        conversationId: CONVERSATION,
        currentPersonId: ME,
        historyPath: null,
      }),
    );
    await settle();

    await act(async () => {
      hook.current.sendTyping(true);
    });
    await settle();

    expect(hook.current.lastError).toBe(MESSENGER_HOOK_ERRORS.commandFailed);
  });

  it('announces an encrypted message as a text-less msg:send and says whether the host took it', async () => {
    const { hook, commands } = await setup();

    let accepted: boolean | undefined;
    await act(async () => {
      accepted = await hook.current.announceE2eeEnvelope?.('payload-1');
    });

    expect(accepted).toBe(true);
    expect(commands()).toEqual([
      {
        type: 'msg:send',
        payload: { conversationId: CONVERSATION, text: '', e2eeEnvelopeId: 'payload-1' },
      },
    ]);
    expect(hook.current.lastError).toBeNull();
  });

  it('resolves false, never rejects, when the host refuses or cannot be reached (the caller keeps the announcement)', async () => {
    const refused = await setup({ routes: { [MESSENGER_COMMAND_PATH]: json({}, 503) } });
    let answer: boolean | undefined;
    await act(async () => {
      answer = await refused.hook.current.announceE2eeEnvelope?.('payload-1');
    });
    expect(answer).toBe(false);
    expect(refused.hook.current.lastError).toBe(MESSENGER_HOOK_ERRORS.commandFailed);

    const idle = await setup({ conversationId: () => null });
    await act(async () => {
      answer = await idle.hook.current.announceE2eeEnvelope?.('payload-1');
    });
    expect(answer).toBe(false);
    expect(idle.commands()).toEqual([]);
  });

  it('does nothing without an open conversation', async () => {
    const { hook, commands } = await setup({ conversationId: () => null });

    await act(async () => {
      hook.current.sendMessage('hello');
      hook.current.sendTyping(true);
      hook.current.markRead('T');
    });
    await settle();

    expect(commands()).toEqual([]);
  });
});
