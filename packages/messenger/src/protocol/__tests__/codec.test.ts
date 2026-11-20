import { describe, expect, it } from 'vitest';
import {
  commandRequest,
  encodeConnectionState,
  encodeMsgServerEvent,
  HISTORY_PAGE_SIZE,
  historyPagePath,
  MESSENGER_EVENT_TOPIC,
  parseConnectionState,
  parseMsgServerEvent,
  UNREAD_EVENT_TOPIC,
} from '../codec.js';
import type { MsgServerEvent } from '../events.js';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('server events', () => {
  it('round-trips every kind it knows', () => {
    const event: MsgServerEvent = {
      type: 'msg:reacted',
      payload: {
        messageId: 'm1',
        conversationId: 'c1',
        reactions: [{ personId: 'p', reaction: '👍' }],
      },
    };
    expect(parseMsgServerEvent(encodeMsgServerEvent(event))).toEqual(event);
  });

  it('knows the person-level unread event (ADR-201) and files it under its own topic', () => {
    const event: MsgServerEvent = {
      type: 'unread:update',
      payload: { conversationId: 'c1', unreadCount: 12, unreadMentions: 2 },
    };
    expect(parseMsgServerEvent(encodeMsgServerEvent(event))).toEqual(event);
    expect(event.type.startsWith(UNREAD_EVENT_TOPIC)).toBe(true);
    // …and not under the conversation topic: a client with no room open must still receive it.
    expect(event.type.startsWith(MESSENGER_EVENT_TOPIC)).toBe(false);
  });

  it('drops what it cannot trust instead of throwing into the transport', () => {
    expect(parseMsgServerEvent(bytes('not json'))).toBeNull();
    expect(parseMsgServerEvent(bytes('null'))).toBeNull();
    expect(parseMsgServerEvent(bytes('{"payload":{}}'))).toBeNull();
    expect(parseMsgServerEvent(bytes('{"type":"msg:new"}'))).toBeNull();
    // A type from a newer server is not an error, it is simply not for this client.
    expect(parseMsgServerEvent(bytes('{"type":"msg:from-the-future","payload":{}}'))).toBeNull();
    // A foreign family of events on the same socket is not ours either.
    expect(parseMsgServerEvent(bytes('{"type":"chat:token","payload":{}}'))).toBeNull();
  });
});

describe('connection state', () => {
  it('round-trips, and says nothing for bytes that do not say', () => {
    expect(parseConnectionState(encodeConnectionState(true))).toBe(true);
    expect(parseConnectionState(encodeConnectionState(false))).toBe(false);
    expect(parseConnectionState(bytes('{"connected":"yes"}'))).toBeNull();
    expect(parseConnectionState(bytes('garbage'))).toBeNull();
  });
});

describe('requests', () => {
  it('turns a command into a POST with the event as its JSON body', () => {
    const request = commandRequest({
      type: 'msg:typing',
      payload: { conversationId: 'c1', isTyping: true },
    });
    expect(request.method).toBe('POST');
    expect(JSON.parse(String(request.body))).toEqual({
      type: 'msg:typing',
      payload: { conversationId: 'c1', isTyping: true },
    });
  });

  it('pages history with a fixed size and an escaped cursor', () => {
    expect(historyPagePath('/h/c1', null)).toBe(`/h/c1?limit=${HISTORY_PAGE_SIZE}`);
    expect(historyPagePath('/h/c1', 'a b&c')).toBe(
      `/h/c1?limit=${HISTORY_PAGE_SIZE}&cursor=a%20b%26c`,
    );
  });
});
