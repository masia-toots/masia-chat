import { describe, expect, it } from 'vitest';
import {
  commandRequest,
  encodeConnectionState,
  encodeMsgServerEvent,
  HISTORY_PAGE_SIZE,
  historyPagePath,
  parseConnectionState,
  parseMsgServerEvent,
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
