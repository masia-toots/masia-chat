import { describe, expect, it } from 'vitest';
import { E2EE_PAYLOAD_VERSION, type E2eePayload, type E2eePayloadInput } from '@masia/messenger/protocol';
import { PENDING_MESSAGE_ID_PREFIX } from '@masia/messenger/hooks';
import { foldHistory, UNREADABLE_ID_PREFIX, type FoldContext } from './fold.js';
import type { HistoryItem } from './history.js';

const people = new Map([
  ['u-ada', { id: 'person-ada', name: 'Ada' }],
  ['u-bo', { id: 'person-bo', name: 'Bo' }],
]);

const context: FoldContext = {
  conversationId: 'dm_u-ada_u-bo',
  personOf: (userId) => people.get(userId),
  self: { id: 'person-ada', name: 'Ada' },
  unreadableText: 'This message could not be read.',
  stickerText: '(sticker)',
};

let nextSeq = 0;
function line(senderUserId: string, payload: E2eePayload | undefined, unreadable?: string): HistoryItem {
  nextSeq += 1;
  return {
    seq: nextSeq,
    senderUserId,
    senderDeviceId: `${senderUserId}-d`,
    createdAt: `2026-10-10T12:00:${String(nextSeq).padStart(2, '0')}.000Z`,
    ...(payload === undefined ? {} : { payload }),
    ...(unreadable === undefined ? {} : { unreadable }),
  };
}
const withV = (input: E2eePayloadInput): E2eePayload => ({ ...input, v: E2EE_PAYLOAD_VERSION }) as E2eePayload;
const text = (id: string, body: string) => withV({ kind: 'text', id, body });

describe('foldHistory', () => {
  it('turns a text into a message on the sender\'s side, named from the people it knows', () => {
    const [message] = foldHistory([line('u-bo', text('m1', 'hi'))], [], context);
    expect(message).toMatchObject({
      id: 'm1',
      conversationId: context.conversationId,
      senderId: 'person-bo',
      senderName: 'Bo',
      text: 'hi',
      deliveryStatus: 'SENT',
      deletedAt: null,
      editedAt: null,
    });
  });

  it('lets the sender edit and delete their own message', () => {
    const edited = foldHistory(
      [line('u-bo', text('m1', 'hi')), line('u-bo', withV({ kind: 'edit', id: 'e1', targetId: 'm1', body: 'hello' }))],
      [],
      context,
    );
    expect(edited).toHaveLength(1);
    expect(edited[0]).toMatchObject({ text: 'hello' });
    expect(edited[0]?.editedAt).not.toBeNull();

    const deleted = foldHistory(
      [line('u-bo', text('m1', 'hi')), line('u-bo', withV({ kind: 'delete', id: 'd1', targetId: 'm1' }))],
      [],
      context,
    );
    expect(deleted[0]).toMatchObject({ text: '' });
    expect(deleted[0]?.deletedAt).not.toBeNull();
  });

  it('ignores an edit or a delete from anyone but the sender: the sender comes from the MLS tree', () => {
    const history = [
      line('u-bo', text('m1', 'mine')),
      line('u-ada', withV({ kind: 'edit', id: 'e1', targetId: 'm1', body: 'forged' })),
      line('u-ada', withV({ kind: 'delete', id: 'd1', targetId: 'm1' })),
    ];
    const [message] = foldHistory(history, [], context);
    expect(message).toMatchObject({ text: 'mine', editedAt: null, deletedAt: null });
  });

  it('ignores a change to a message it has not seen', () => {
    expect(foldHistory([line('u-bo', withV({ kind: 'delete', id: 'd1', targetId: 'nope' }))], [], context)).toEqual([]);
  });

  it('attaches a reaction from anyone to the message it names', () => {
    const [message] = foldHistory(
      [line('u-bo', text('m1', 'hi')), line('u-ada', withV({ kind: 'reaction', id: 'r1', targetId: 'm1', emoji: '👍' }))],
      [],
      context,
    );
    expect(message?.reactions).toHaveLength(1);
    expect(JSON.stringify(message?.reactions)).toContain('👍');
  });

  it('keeps the first of two messages that share an id', () => {
    const messages = foldHistory([line('u-bo', text('same', 'first')), line('u-bo', text('same', 'second'))], [], context);
    expect(messages.map((m) => m.text)).toEqual(['first']);
  });

  it('shows a message that could not be read as a line that says so, never drops it', () => {
    const [message] = foldHistory([line('u-bo', undefined, 'DECRYPT_FAILED')], [], context);
    expect(message?.id.startsWith(UNREADABLE_ID_PREFIX)).toBe(true);
    expect(message).toMatchObject({ text: context.unreadableText, messageType: 'SYSTEM', senderName: 'Bo' });
  });

  it('shows a sticker as the host\'s own words, since the playground has no catalog', () => {
    const [message] = foldHistory(
      [line('u-bo', withV({ kind: 'sticker', id: 's1', stickerId: 'wave' } as E2eePayloadInput))],
      [],
      context,
    );
    expect(message).toMatchObject({ text: context.stickerText, messageType: 'TEXT' });
  });

  it('shows a quote under a reply', () => {
    const [message] = foldHistory(
      [line('u-bo', withV({ kind: 'text', id: 'm2', body: 'yes', replyTo: { id: 'm1', quote: 'are you in?', senderName: 'Ada' } }))],
      [],
      context,
    );
    expect(message?.replyToId).toBe('m1');
    expect(message?.replyToPreview).toEqual({ text: 'are you in?', senderName: 'Ada' });
  });

  it('shows what is still on its way as pending, on this tab\'s side, after everything stored', () => {
    const messages = foldHistory(
      [line('u-bo', text('m1', 'hi'))],
      [{ kind: 'text', id: 'q1', body: 'typing…' }],
      context,
    );
    expect(messages.map((m) => m.id)).toEqual(['m1', `${PENDING_MESSAGE_ID_PREFIX}q1`]);
    expect(messages[1]).toMatchObject({ senderId: 'person-ada', senderName: 'Ada', deliveryStatus: null });
  });

  it('does not show a queued message twice once it is stored', () => {
    const messages = foldHistory(
      [line('u-ada', text('q1', 'sent'))],
      [{ kind: 'text', id: 'q1', body: 'sent' }],
      context,
    );
    expect(messages.map((m) => m.id)).toEqual(['q1']);
  });

  it('does not show a queued edit or delete until it is stored', () => {
    expect(foldHistory([], [{ kind: 'delete', id: 'q1', targetId: 'm1' }], context)).toEqual([]);
  });
});
