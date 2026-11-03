import { describe, expect, it } from 'vitest';
import {
  applyE2eeReaction,
  canApplyE2eeChange,
  decodeE2eePayload,
  E2EE_PAYLOAD_ERRORS,
  E2EE_PAYLOAD_MAX_BYTES,
  E2EE_PAYLOAD_VERSION,
  E2EE_TEXT_MAX_CHARS,
  e2eePayloadToEvent,
  encodeE2eePayload,
  type E2eePayloadInput,
} from '../e2ee-payload.js';

/**
 * The payload inside the ciphertext (canon section 10). Three promises: what a sender builds, a reader
 * reads back exactly; what a hostile or broken sender sends never throws past `decodeE2eePayload`
 * (it is a typed error, shown as "unreadable"); and the decoded payload lands on the existing `msg:*`
 * events, so the screens need nothing new.
 */

const encoder = new TextEncoder();
const bytesOf = (value: unknown): Uint8Array => encoder.encode(JSON.stringify(value));

const CONTEXT = {
  conversationId: 'conv-1',
  senderId: 'person-a',
  senderName: 'Alice',
  createdAt: '2026-10-10T10:00:00.000Z',
} as const;

const SAMPLES: readonly E2eePayloadInput[] = [
  { kind: 'text', id: 'm1', body: 'Привіт 👋' },
  {
    kind: 'text',
    id: 'm2',
    body: 'a reply',
    replyTo: { id: 'm1', quote: 'Привіт', senderName: 'Bob' },
  },
  { kind: 'edit', id: 'm3', targetId: 'm1', body: 'Привіт!' },
  { kind: 'delete', id: 'm4', targetId: 'm2' },
  {
    kind: 'sticker',
    id: 'm5',
    stickerId: 'st_1',
    motion: 'bounce',
    sound: 'pop',
  },
  { kind: 'sticker', id: 'm6', stickerId: 'st_2' },
  { kind: 'reaction', id: 'm7', targetId: 'm1', emoji: '👍🏽' },
  { kind: 'reaction', id: 'm8', targetId: 'm1', emoji: '👨‍👩‍👧', removed: true },
  { kind: 'notice', id: 'm9', key: 'messenger:e2ee.masiaJoined' },
];

describe('the payload round-trips', () => {
  it.each(SAMPLES)('$kind $id reads back exactly as it was built', (input) => {
    const encoded = encodeE2eePayload(input);
    if (!encoded.ok) throw new Error(encoded.error.code);
    const decoded = decodeE2eePayload(encoded.value);
    expect(decoded).toEqual({ ok: true, value: { v: E2EE_PAYLOAD_VERSION, ...input } });
  });

  it('refuses to build what a reader would refuse (an over-long text, a javascript: sticker)', () => {
    const long = encodeE2eePayload({
      kind: 'text',
      id: 'm',
      body: 'x'.repeat(E2EE_TEXT_MAX_CHARS + 1),
    });
    expect(long).toEqual({
      ok: false,
      error: { code: E2EE_PAYLOAD_ERRORS.INVALID_FIELD, field: 'body' },
    });
    const path = encodeE2eePayload({ kind: 'sticker', id: 'm', stickerId: '/\\evil.com/x' });
    expect(path.ok).toBe(false);
  });

  it('a sticker carries a catalog id only: a sender’s image URL never survives decoding (sec-M4)', () => {
    for (const imageUrl of ['https://tracker.example/x.png', '/\\evil.com/x', '/\t/evil.com/x']) {
      const decoded = decodeE2eePayload(
        bytesOf({ v: 1, kind: 'sticker', id: 'm', stickerId: 'st_1', imageUrl }),
      );
      expect(decoded).toEqual({ ok: true, value: { v: 1, kind: 'sticker', id: 'm', stickerId: 'st_1' } });
    }
  });

  it('refuses to build a payload over the byte cap even when every field is within its own', () => {
    // A control character is one UTF-16 unit but six bytes once JSON escapes it (\u0001).
    const escaped = '\u0001'.repeat(E2EE_TEXT_MAX_CHARS);
    expect(encodeE2eePayload({ kind: 'text', id: 'm', body: escaped })).toEqual({
      ok: false,
      error: { code: E2EE_PAYLOAD_ERRORS.TOO_LARGE },
    });
    // The longest text of three-byte characters fits.
    expect(
      encodeE2eePayload({ kind: 'text', id: 'm', body: '中'.repeat(E2EE_TEXT_MAX_CHARS) }).ok,
    ).toBe(true);
  });
});

describe('a hostile or broken payload is a typed error, never a throw', () => {
  const cases: ReadonlyArray<[string, Uint8Array, string]> = [
    ['empty bytes', new Uint8Array(0), E2EE_PAYLOAD_ERRORS.MALFORMED],
    ['invalid UTF-8', Uint8Array.of(0xff, 0xfe, 0x7b), E2EE_PAYLOAD_ERRORS.MALFORMED],
    ['not JSON', encoder.encode('hello'), E2EE_PAYLOAD_ERRORS.MALFORMED],
    ['a JSON array', bytesOf([1, 2]), E2EE_PAYLOAD_ERRORS.MALFORMED],
    ['JSON null', bytesOf(null), E2EE_PAYLOAD_ERRORS.MALFORMED],
    [
      'a future version',
      bytesOf({ v: 2, kind: 'text', id: 'm', body: 'x' }),
      E2EE_PAYLOAD_ERRORS.VERSION_UNSUPPORTED,
    ],
    [
      'a version that is not a number',
      bytesOf({ v: '1', kind: 'text', id: 'm', body: 'x' }),
      E2EE_PAYLOAD_ERRORS.INVALID_FIELD,
    ],
    ['an unknown kind', bytesOf({ v: 1, kind: 'poll', id: 'm' }), E2EE_PAYLOAD_ERRORS.UNKNOWN_KIND],
    [
      'a reaction that is a sentence',
      bytesOf({ v: 1, kind: 'reaction', id: 'm', targetId: 't', emoji: 'nice one' }),
      E2EE_PAYLOAD_ERRORS.INVALID_FIELD,
    ],
    [
      'a reaction over the cap',
      bytesOf({ v: 1, kind: 'reaction', id: 'm', targetId: 't', emoji: '😀'.repeat(17) }),
      E2EE_PAYLOAD_ERRORS.INVALID_FIELD,
    ],
    [
      'a reaction without a target',
      bytesOf({ v: 1, kind: 'reaction', id: 'm', emoji: '👍' }),
      E2EE_PAYLOAD_ERRORS.INVALID_FIELD,
    ],
    [
      'a reaction with removed: false',
      bytesOf({ v: 1, kind: 'reaction', id: 'm', targetId: 't', emoji: '👍', removed: false }),
      E2EE_PAYLOAD_ERRORS.INVALID_FIELD,
    ],
    [
      'a notice that is text, not a key',
      bytesOf({ v: 1, kind: 'notice', id: 'm', key: 'Masia joined' }),
      E2EE_PAYLOAD_ERRORS.INVALID_FIELD,
    ],
    [
      'a bad id',
      bytesOf({ v: 1, kind: 'text', id: '../x', body: 'x' }),
      E2EE_PAYLOAD_ERRORS.INVALID_FIELD,
    ],
    [
      'a text without a body',
      bytesOf({ v: 1, kind: 'text', id: 'm' }),
      E2EE_PAYLOAD_ERRORS.INVALID_FIELD,
    ],
    [
      'an edit without a target',
      bytesOf({ v: 1, kind: 'edit', id: 'm', body: 'x' }),
      E2EE_PAYLOAD_ERRORS.INVALID_FIELD,
    ],
    [
      'a reply to nothing',
      bytesOf({ v: 1, kind: 'text', id: 'm', body: 'x', replyTo: { quote: 'q' } }),
      E2EE_PAYLOAD_ERRORS.INVALID_FIELD,
    ],
    [
      'a sticker whose id is a URL',
      bytesOf({ v: 1, kind: 'sticker', id: 'm', stickerId: '//evil.example/x' }),
      E2EE_PAYLOAD_ERRORS.INVALID_FIELD,
    ],
    [
      'a sticker without a catalog id',
      bytesOf({ v: 1, kind: 'sticker', id: 'm', imageUrl: '/api/uploads/x.png' }),
      E2EE_PAYLOAD_ERRORS.INVALID_FIELD,
    ],
    [
      'an oversized payload',
      new Uint8Array(E2EE_PAYLOAD_MAX_BYTES + 1).fill(0x20),
      E2EE_PAYLOAD_ERRORS.TOO_LARGE,
    ],
  ];

  it.each(cases)('%s', (_name, bytes, code) => {
    const result = decodeE2eePayload(bytes);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(code);
  });

  it('a __proto__ key cannot pollute anything and the extra field is dropped', () => {
    const raw = encoder.encode(
      '{"v":1,"kind":"text","id":"m","body":"x","__proto__":{"polluted":true},"extra":1}',
    );
    const result = decodeE2eePayload(raw);
    expect(result).toEqual({ ok: true, value: { v: 1, kind: 'text', id: 'm', body: 'x' } });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('fuzz: 3 000 random and mutated inputs never throw and always answer ok or a known code', () => {
    let seed = 0x9e3779b9;
    const random = (): number => {
      // xorshift32: deterministic, so a failure is reproducible
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) / 0x100000000;
    };
    const codes = new Set<string>(Object.values(E2EE_PAYLOAD_ERRORS));
    const valid = SAMPLES.map((input) => {
      const encoded = encodeE2eePayload(input);
      if (!encoded.ok) throw new Error('sample does not encode');
      return encoded.value;
    });
    const ROUNDS = 3000;
    const MAX_RANDOM_LENGTH = 300;
    for (let round = 0; round < ROUNDS; round += 1) {
      let bytes: Uint8Array;
      if (round % 2 === 0) {
        // pure noise
        bytes = new Uint8Array(Math.floor(random() * MAX_RANDOM_LENGTH));
        for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(random() * 256);
      } else {
        // a valid payload with a few bytes flipped, cut or duplicated
        const base = valid[round % valid.length] ?? new Uint8Array(0);
        bytes = Uint8Array.from(base);
        const flips = 1 + Math.floor(random() * 4);
        for (let f = 0; f < flips; f += 1) {
          const at = Math.floor(random() * bytes.length);
          bytes[at] = Math.floor(random() * 256);
        }
        if (random() < 0.3) bytes = bytes.subarray(0, Math.floor(random() * bytes.length));
      }
      let result: ReturnType<typeof decodeE2eePayload> | undefined;
      expect(() => {
        result = decodeE2eePayload(bytes);
      }).not.toThrow();
      if (result && !result.ok) expect(codes.has(result.error.code)).toBe(true);
    }
  });
});

describe('reactions and notices', () => {
  it('reaction → e2ee:reaction from the MLS sender; folding puts and takes back one row per person+emoji', () => {
    const put = e2eePayloadToEvent(
      { v: 1, kind: 'reaction', id: 'r1', targetId: 'm1', emoji: '👍' },
      CONTEXT,
    );
    expect(put).toEqual({
      type: 'e2ee:reaction',
      payload: {
        messageId: 'm1',
        conversationId: 'conv-1',
        senderId: 'person-a',
        reaction: '👍',
        removed: false,
      },
    });
    if (put.type !== 'e2ee:reaction') throw new Error('kind');
    const once = applyE2eeReaction([], put.payload);
    const twice = applyE2eeReaction(once, put.payload);
    expect(twice).toEqual([{ personId: 'person-a', reaction: '👍' }]);
    const other = applyE2eeReaction(twice, { ...put.payload, senderId: 'person-b' });
    expect(other).toHaveLength(2);
    expect(applyE2eeReaction(other, { ...put.payload, removed: true })).toEqual([
      { personId: 'person-b', reaction: '👍' },
    ]);
  });

  it('notice → a SYSTEM msg:new whose text is the key (the host translates it)', () => {
    const event = e2eePayloadToEvent(
      { v: 1, kind: 'notice', id: 'n1', key: 'messenger:e2ee.masiaJoined' },
      CONTEXT,
    );
    expect(event.type).toBe('msg:new');
    if (event.type !== 'msg:new') throw new Error('kind');
    expect(event.payload).toMatchObject({
      id: 'n1',
      messageType: 'SYSTEM',
      text: 'messenger:e2ee.masiaJoined',
    });
  });
});

describe('a decoded payload is an existing msg:* event', () => {
  it('text with a reply → msg:new TEXT with replyToId; the sender comes from the context, not the payload', () => {
    const event = e2eePayloadToEvent(
      { v: 1, kind: 'text', id: 'm2', body: 'hi', replyTo: { id: 'm1' } },
      CONTEXT,
    );
    expect(event).toEqual({
      type: 'msg:new',
      payload: {
        id: 'm2',
        conversationId: 'conv-1',
        senderId: 'person-a',
        senderName: 'Alice',
        text: 'hi',
        messageType: 'TEXT',
        replyToId: 'm1',
        createdAt: CONTEXT.createdAt,
      },
    });
  });

  it('sticker → msg:new STICKER in the wire form the screens already draw ("motion|sound")', () => {
    const event = e2eePayloadToEvent(
      { v: 1, kind: 'sticker', id: 's1', stickerId: 'st', motion: 'spin' },
      { ...CONTEXT, stickerImageOf: (id) => (id === 'st' ? '/api/uploads/st.png' : undefined) },
    );
    expect(event.type).toBe('msg:new');
    if (event.type === 'msg:new') {
      expect(event.payload.messageType).toBe('STICKER');
      expect(event.payload.text).toBe('spin|none');
      expect(event.payload.mediaUrl).toBe('/api/uploads/st.png');
    }
    // An id the reader's catalog does not know: no image at all (the host draws a placeholder).
    const unknown = e2eePayloadToEvent(
      { v: 1, kind: 'sticker', id: 's2', stickerId: 'other' },
      { ...CONTEXT, stickerImageOf: () => undefined },
    );
    expect(unknown.type === 'msg:new' && unknown.payload.mediaUrl).toBeFalsy();
  });

  it('edit → msg:edited at the relay time; delete → msg:deleted', () => {
    expect(
      e2eePayloadToEvent({ v: 1, kind: 'edit', id: 'e', targetId: 'm1', body: 'new' }, CONTEXT),
    ).toEqual({
      type: 'msg:edited',
      payload: {
        messageId: 'm1',
        conversationId: 'conv-1',
        text: 'new',
        editedAt: CONTEXT.createdAt,
      },
    });
    expect(e2eePayloadToEvent({ v: 1, kind: 'delete', id: 'd', targetId: 'm1' }, CONTEXT)).toEqual({
      type: 'msg:deleted',
      payload: { messageId: 'm1', conversationId: 'conv-1' },
    });
  });

  it('only the sender of a message may edit or delete it', () => {
    expect(canApplyE2eeChange({ senderId: 'a' }, { senderId: 'a' })).toBe(true);
    expect(canApplyE2eeChange({ senderId: 'b' }, { senderId: 'a' })).toBe(false);
    expect(canApplyE2eeChange({ senderId: 'a' }, undefined)).toBe(false);
  });
});
