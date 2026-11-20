/**
 * The pictures of a conversation: what a message's pictures are (one rule for both chats), and how the
 * pictures of the whole loaded thread line up so the viewer pages from one message into the next.
 */
import { describe, expect, it } from 'vitest';
import {
  attachmentIdsOf,
  documentLabelOf,
  pageAround,
  picturesOf,
  type PictureBearer,
} from '../message-pictures.js';

const row = (id: string, over: Partial<PictureBearer> = {}): PictureBearer => ({ id, ...over });
const srcs = (g: { items: readonly { src: string }[] }) => g.items.map((i) => i.src);

describe('what a picture is', () => {
  it('tells a document from a picture by the name its object was saved with', () => {
    expect(documentLabelOf('/api/uploads/families/f/a1.PDF')).toBe('PDF');
    expect(documentLabelOf('contract.docx')).toBe('DOCX');
    expect(documentLabelOf('photo.png')).toBeNull();
    expect(documentLabelOf('blob:https://x/abcd')).toBeNull();
  });

  it('reads the saved attachments from the list, then the single url, and a sticker has none', () => {
    expect(attachmentIdsOf(row('a', { mediaUrls: ['x.png', 'y.png'], mediaUrl: 'x.png' }))).toEqual(['x.png', 'y.png']);
    expect(attachmentIdsOf(row('a', { mediaUrl: 'x.png' }))).toEqual(['x.png']);
    expect(attachmentIdsOf(row('a', { mediaUrls: [], mediaUrl: null }))).toEqual([]);
    expect(attachmentIdsOf(row('a', { messageType: 'STICKER', mediaUrl: 's.webp' }))).toEqual([]);
  });

  it('prefers the inline photos, drops documents, leaves out a picture still on its way, and shows none for a deleted message', () => {
    const inline = row('a', {
      images: [
        { dataUrl: 'data:image/png;base64,AA', mimeType: 'image/png' },
        { dataUrl: 'data:application/pdf;base64,BB', mimeType: 'application/pdf' },
      ],
      mediaUrl: 'saved.png',
    });
    expect(picturesOf(inline, ['blob:saved'])).toEqual(['data:image/png;base64,AA']);

    const saved = row('b', { mediaUrls: ['one.png', 'plan.pdf', 'two.png', 'late.png'] });
    expect(picturesOf(saved, ['blob:one', 'blob:plan', 'blob:two', ''])).toEqual(['blob:one', 'blob:two']);

    expect(picturesOf(row('c', { mediaUrl: 'one.png', deletedAt: '2026-11-19T10:00:00Z' }), ['blob:one'])).toEqual([]);
  });
});

describe('the pages of the viewer', () => {
  const known: Record<string, string> = { 'a1.png': 'blob:a1', 'a2.png': 'blob:a2', 'c1.png': 'blob:c1', 'doc.pdf': 'blob:doc' };
  const peek = (id: string) => known[id];
  const thread = [
    row('m1', { mediaUrls: ['a1.png', 'a2.png'] }),
    row('m2'), // words only
    row('m3', { mediaUrl: 'doc.pdf' }), // a document: not a page
    row('m4', { mediaUrl: 'c1.png' }),
  ];

  it('lays the pictures of every message in thread order, and opens on the tapped one', () => {
    const fromLast = pageAround(thread, peek, { messageId: 'm4', urls: ['blob:c1'], index: 0 });
    expect(srcs(fromLast)).toEqual(['blob:a1', 'blob:a2', 'blob:c1']);
    expect(fromLast.index).toBe(2);

    const fromSecond = pageAround(thread, peek, { messageId: 'm1', urls: ['blob:a1', 'blob:a2'], index: 1 });
    expect(fromSecond.index).toBe(1);
    expect(srcs(fromSecond)).toHaveLength(3);
  });

  it('a lone picture still has neighbours: it is page 3 of 3, not 1 of 1', () => {
    const g = pageAround(thread, peek, { messageId: 'm4', urls: ['blob:c1'], index: 0 });
    expect(g.items).toHaveLength(3);
  });

  it('takes the tapped message\'s own pictures as drawn, even when the host has let go of its cached copy', () => {
    const g = pageAround(thread, (id) => (id === 'c1.png' ? undefined : known[id]), { messageId: 'm4', urls: ['blob:c1'], index: 0 });
    expect(srcs(g)).toEqual(['blob:a1', 'blob:a2', 'blob:c1']);
    expect(g.index).toBe(2);
  });

  it('skips a neighbour no bubble has resolved yet, and a deleted message\'s picture', () => {
    const lazy = [
      row('m1', { mediaUrl: 'never.png' }),
      row('m2', { mediaUrl: 'a1.png', deletedAt: '2026-11-19T10:00:00Z' }),
      row('m3', { mediaUrl: 'c1.png' }),
    ];
    const g = pageAround(lazy, peek, { messageId: 'm3', urls: ['blob:c1'], index: 0 });
    expect(srcs(g)).toEqual(['blob:c1']);
    expect(g.index).toBe(0);
  });

  it('a tap on a message the list does not hold pages that message alone', () => {
    const g = pageAround(thread, peek, { messageId: 'gone', urls: ['blob:x', 'blob:y'], index: 1 });
    expect(srcs(g)).toEqual(['blob:x', 'blob:y']);
    expect(g.index).toBe(1);
  });

  it('never lands past the tapped message\'s own pictures, whatever index it is given', () => {
    const g = pageAround(thread, peek, { messageId: 'm1', urls: ['blob:a1', 'blob:a2'], index: 9 });
    expect(g.index).toBe(1);
  });
});
