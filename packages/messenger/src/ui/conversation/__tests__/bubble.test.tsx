// @vitest-environment jsdom
/**
 * One message bubble, proven against the package's fakes (a fake menu, icon set, sticker renderer and
 * media reader), never against the Masia hub: if a behaviour only holds with the hub behind it, the
 * bubble depends on the hub.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeStickerAttachment, cleanupUi, click, createTestMedia, flush, pressEscape, q, qa, renderUi } from '../../../test-support/fake-ui.js';
import { makeMessage } from '../../../test-support/fake-messenger.js';
import { Bubble, type BubbleProps } from '../bubble.js';

afterEach(() => {
  cleanupUi();
  vi.restoreAllMocks();
});

function bubble(over: Partial<BubbleProps> = {}): JSX.Element {
  return (
    <Bubble
      message={makeMessage({ text: 'hello', senderId: 'me' })}
      isOwn
      currentPersonId="me"
      showSenderName={false}
      isLastInGroup
      onImageOpen={() => undefined}
      {...over}
    />
  );
}

describe('Bubble: content', () => {
  it('shows the text, the time and the own-side classes with the tail on the last of a run', () => {
    renderUi(bubble());
    const box = q('.hub-msg')!;
    expect(box.classList.contains('hub-msg--own')).toBe(true);
    expect(box.classList.contains('hub-msg--tail')).toBe(true);
    expect(q('.hub-msg-text')!.textContent).toBe('hello');
    expect(q('.hub-msg-meta')!.textContent).toMatch(/\d/);
  });

  it('shows the sender name only when asked, and the reply preview when there is one', () => {
    const message = makeMessage({ senderName: 'Ada', replyToPreview: { senderName: 'Grace', text: 'earlier' } });
    renderUi(bubble({ message, isOwn: false, showSenderName: true }));
    expect(q('.hub-msg-sender')!.textContent).toBe('Ada');
    expect(q('.hub-msg-reply-who')!.textContent).toBe('Grace');
    expect(q('.hub-msg-reply-text')!.textContent).toBe('earlier');
  });

  it('marks an edited message and draws read ticks on an own message only', () => {
    const message = makeMessage({ senderId: 'me', editedAt: '2026-10-10T11:00:00.000Z', deliveryStatus: 'READ' });
    renderUi(bubble({ message }));
    expect(q('.hub-msg-edited')!.textContent).toBe('edited');
    expect(q('.hub-msg-check--read')).toBeTruthy();
  });

  it('shows a deleted message as the fixed line, with no actions', () => {
    renderUi(bubble({ message: makeMessage({ deletedAt: '2026-10-10T11:00:00.000Z' }), onReact: () => undefined }));
    expect(q('.hub-msg--deleted')!.textContent).toBe('Message deleted');
    expect(q('.hub-msg-actions')).toBeNull();
  });

  it('prefers the edited-by-rule text when the server modified it', () => {
    renderUi(bubble({ message: makeMessage({ text: 'raw', modified: { text: 'shown', ruleName: null } }) }));
    expect(q('.hub-msg-text')!.textContent).toBe('shown');
  });
});

describe('Bubble: reactions', () => {
  it('groups reactions into pills with a count and marks the ones you set', () => {
    const message = makeMessage({
      reactions: [
        { personId: 'me', reaction: '👍' },
        { personId: 'them', reaction: '👍' },
        { personId: 'them', reaction: '❤️' },
      ],
    });
    const onReact = vi.fn();
    renderUi(bubble({ message, onReact }));
    const pills = qa('.hub-msg-react-pill');
    expect(pills.map((p) => p.textContent)).toEqual(['👍 2', '❤️']);
    expect(pills[0]!.classList.contains('is-mine')).toBe(true);
    expect(pills[1]!.classList.contains('is-mine')).toBe(false);
    click(pills[1]!);
    expect(onReact).toHaveBeenCalledWith(message.id, '❤️');
  });
});

describe('Bubble: the actions menu', () => {
  const trigger = (): HTMLElement => q('.hub-msg-actions')!;

  it('draws the icons the icon set was asked for, at the sizes the design uses', async () => {
    renderUi(bubble({ onEdit: () => undefined, onDelete: () => undefined }));
    expect(trigger().querySelector('svg')!.getAttribute('data-icon')).toBe('more');
    expect(trigger().querySelector('svg')!.getAttribute('data-size')).toBe('15');
    click(trigger());
    await flush();
    const sizes = qa('[data-cm=message] svg').map((s) => `${s.getAttribute('data-icon')}:${s.getAttribute('data-size')}`);
    expect(sizes).toEqual(['copy:16', 'edit:16', 'trash:16']);
  });

  it('copy writes the text once, closes the menu, and Esc hands focus back to the trigger', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderUi(bubble({ message: makeMessage({ text: 'привіт' }) }));
    expect(q('[data-cm=message]')).toBeNull();
    expect(trigger().getAttribute('aria-expanded')).toBe('false');

    click(trigger());
    await flush();
    expect(q('[data-cm=message]')).toBeTruthy();
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    click(q('[data-cm-row=copy]'));
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith('привіт');
    expect(q('[data-cm=message]')).toBeNull();

    click(trigger());
    await flush();
    pressEscape();
    expect(q('[data-cm=message]')).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it('edit, delete and a reaction each call their own handler once', async () => {
    const message = makeMessage({ senderId: 'me' });
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    const onReact = vi.fn();
    renderUi(bubble({ message, onEdit, onDelete, onReact }));

    click(trigger());
    await flush();
    click(q('[data-cm-row=edit]'));
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onEdit).toHaveBeenCalledWith(message);

    click(trigger());
    await flush();
    click(q('[data-cm-row=delete]'));
    expect(onDelete).toHaveBeenCalledWith(message.id);

    click(trigger());
    await flush();
    expect(qa('.hub-react-emoji').map((e) => e.textContent)).toEqual(['👍', '❤️', '😂']);
    click(q('.hub-react-emoji'));
    expect(onReact).toHaveBeenCalledWith(message.id, '👍');
    expect(q('[data-cm=message]')).toBeNull();
  });

  it('offers edit and delete on your own messages only, and no menu when nothing applies', () => {
    renderUi(bubble({ isOwn: false, message: makeMessage({ text: '' }), onEdit: () => undefined, onDelete: () => undefined }));
    expect(q('.hub-msg-actions')).toBeNull();
  });
});

describe('Bubble: stickers', () => {
  const sticker = makeMessage({ messageType: 'STICKER', text: 'bounce|pop', mediaUrl: '/stickers/1.png' });

  it('asks the host to draw the sticker with the raw url, the text and who sent it', () => {
    renderUi(bubble({ message: sticker, isOwn: false }));
    const drawn = q('[data-fake-sticker]')!;
    expect(drawn.getAttribute('data-fake-sticker')).toBe('/stickers/1.png');
    expect(drawn.getAttribute('data-own')).toBe('false');
    expect(q('.hub-msg')!.classList.contains('hub-msg--sticker')).toBe(true);
    expect(q('.hub-msg-text')).toBeNull();
  });

  it('shows a plain word when the host does not draw stickers', () => {
    renderUi(bubble({ message: sticker }), { attachments: { kinds: [], render: () => null } });
    expect(q('.hub-msg-sticker-placeholder')!.textContent).toBe('Sticker');
  });

  it('shows the word when the host knows the kind but returns nothing for this one', () => {
    renderUi(bubble({ message: sticker }), { attachments: { kinds: ['sticker'], render: () => null } });
    expect(q('.hub-msg-sticker-placeholder')).toBeTruthy();
  });

  it('draws nothing for a sticker with no image', () => {
    renderUi(bubble({ message: makeMessage({ messageType: 'STICKER', mediaUrl: null }) }));
    expect(q('[data-fake-sticker]')).toBeNull();
    expect(q('.hub-msg-sticker-placeholder')).toBeNull();
  });

  it('keeps the node the host drew across re-renders, so its own state is not reset', () => {
    const attachments = createFakeStickerAttachment();
    const tree = renderUi(bubble({ message: sticker }), { attachments });
    const before = q('[data-fake-sticker]');
    tree.rerender(bubble({ message: sticker }));
    expect(q('[data-fake-sticker]')).toBe(before);
  });
});

describe('Bubble: pictures and documents', () => {
  it('holds the place of a picture still on its way, then shows it and pages it on tap', async () => {
    const media = createTestMedia();
    const onImageOpen = vi.fn();
    renderUi(bubble({ message: makeMessage({ mediaUrl: 'a.png', mediaUrls: ['a.png', 'b.png'] }), onImageOpen }), { media });
    expect(qa('.hub-msg-image-pending')).toHaveLength(2);
    expect(q('.hub-msg-images img')).toBeNull();

    media.release('a.png', 'blob:a');
    media.release('b.png', 'blob:b');
    await flush();
    expect(qa('.hub-msg-image-pending')).toHaveLength(0);
    const images = qa<HTMLImageElement>('.hub-msg-images img');
    expect(images.map((i) => i.getAttribute('src'))).toEqual(['blob:a', 'blob:b']);

    click(images[1]!);
    expect(onImageOpen).toHaveBeenCalledWith(['blob:a', 'blob:b'], 1);
  });

  it('shows the pictures the host already knows with no placeholder at all', () => {
    const media = createTestMedia({ 'a.png': 'blob:a' });
    renderUi(bubble({ message: makeMessage({ mediaUrl: 'a.png' }) }), { media });
    expect(q('.hub-msg-image-pending')).toBeNull();
    expect(q('.hub-msg-images img')!.getAttribute('src')).toBe('blob:a');
  });

  it('shows inline pictures ahead of stored ones and pages only the images, not the documents', () => {
    const onImageOpen = vi.fn();
    const message = makeMessage({
      images: [
        { dataUrl: 'data:image/png;base64,AAA', mimeType: 'image/png' },
        { dataUrl: 'data:application/pdf;base64,BBB', mimeType: 'application/pdf' },
      ],
      mediaUrl: 'ignored.png',
    });
    renderUi(bubble({ message, onImageOpen }));
    expect(qa('.hub-msg-images img')).toHaveLength(1);
    expect(q('.hub-chat-doc-chip')!.textContent).toBe('PDF');
    click(q('.hub-msg-images img'));
    expect(onImageOpen).toHaveBeenCalledWith(['data:image/png;base64,AAA'], 0);
  });

  it('opens a stored document the host knows straight away, without an opener', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const media = createTestMedia({ 'plan.pdf': 'blob:plan' });
    renderUi(bubble({ message: makeMessage({ mediaUrl: 'plan.pdf' }) }), { media });
    const chip = q<HTMLAnchorElement>('a.hub-chat-doc-chip')!;
    expect(chip.textContent).toBe('PDF');
    expect(chip.getAttribute('href')).toBe('blob:plan');
    click(chip);
    expect(open).toHaveBeenCalledWith('blob:plan', '_blank', 'noopener,noreferrer');
  });

  it('opens a document the host must fetch in a tab opened inside the click, pointed once it arrives', async () => {
    const tab = { location: { href: '' }, close: vi.fn() } as unknown as Window;
    const open = vi.spyOn(window, 'open').mockReturnValue(tab);
    const media = createTestMedia();
    renderUi(bubble({ message: makeMessage({ mediaUrl: 'plan.docx' }) }), { media });
    const chip = q<HTMLAnchorElement>('a.hub-chat-doc-chip')!;
    expect(chip.textContent).toBe('DOCX');
    click(chip);
    expect(open).toHaveBeenCalledWith('', '_blank');
    media.release('plan.docx', 'blob:docx');
    await flush();
    expect(tab.location.href).toBe('blob:docx');
  });
});
