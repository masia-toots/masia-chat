// @vitest-environment jsdom
/**
 * The conversation view against the package's fakes: it works with its own slim composer, takes the
 * host's composer when one is supplied, edits a message through the composer, pages pictures in the
 * host's gallery, and carries the theme and the sender-name width on its own root.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FAKE_SLOTS,
  cleanupUi,
  click,
  createTestMedia,
  flush,
  pressKey,
  q,
  qa,
  renderUi,
  typeInto,
} from '../../../test-support/fake-ui.js';
import { makeMessage, makeMessenger } from '../../../test-support/fake-messenger.js';
import type { ComposerSlotProps } from '../../provider/slots.js';
import { MessengerChatView } from '../messenger-chat-view.js';

afterEach(cleanupUi);

const view = (over: Partial<Parameters<typeof MessengerChatView>[0]> = {}) => (
  <MessengerChatView messenger={makeMessenger()} currentPersonId="me" isGroup={false} {...over} />
);

describe('MessengerChatView: states', () => {
  it('invites the first message, or says the chat is private', () => {
    const tree = renderUi(view());
    expect(q('.hub-mchat-empty')!.textContent).toContain('Say hello');
    expect(q('.hub-mchat-msgs')!.classList.contains('is-empty')).toBe(true);
    tree.rerender(view({ isPrivate: true }));
    expect(q('.hub-mchat-empty')!.textContent).toContain('Private chat');
  });

  it('shows a spinner while history loads, and not the empty invitation', () => {
    renderUi(view({ messenger: makeMessenger({ loadingHistory: true }) }));
    expect(q('.hub-mchat-loading')).toBeTruthy();
    expect(q('.hub-mchat-empty')).toBeNull();
  });

  it('names the sender once per run in a group chat and never for your own messages', () => {
    const messages = [
      makeMessage({ id: 'a', senderId: 'ada', senderName: 'Ada' }),
      makeMessage({ id: 'b', senderId: 'ada', senderName: 'Ada' }),
      makeMessage({ id: 'c', senderId: 'me', senderName: 'Me' }),
      makeMessage({ id: 'd', senderId: 'bob', senderName: 'Bob' }),
    ];
    renderUi(view({ messenger: makeMessenger({ messages }), isGroup: true }));
    expect(qa('.hub-msg-sender').map((n) => n.textContent)).toEqual(['Ada', 'Bob']);
    expect(qa('.hub-msg--tail')).toHaveLength(3);
  });

  it('shows the typing dots when someone types', () => {
    const messenger = makeMessenger({
      messages: [makeMessage()],
      typingIndicators: [{ personId: 'them', personName: 'Ada' }],
    });
    renderUi(view({ messenger }));
    expect(qa('.hub-typing-dot')).toHaveLength(3);
  });

  it('marks the conversation read when the last message is from someone else', () => {
    const messenger = makeMessenger({ messages: [makeMessage({ senderId: 'them', createdAt: '2026-10-10T10:05:00.000Z' })] });
    renderUi(view({ messenger }));
    expect(messenger.markRead).toHaveBeenCalledWith('2026-10-10T10:05:00.000Z');
  });

  it('does not mark it read when the last message is your own', () => {
    const messenger = makeMessenger({ messages: [makeMessage({ senderId: 'me' })] });
    renderUi(view({ messenger }));
    expect(messenger.markRead).not.toHaveBeenCalled();
  });
});

describe('MessengerChatView: the root carries what the host decides', () => {
  it('sets the theme tokens inline on the root, so a portaled child can read them from its own', () => {
    renderUi(view());
    const root = q('.hub-mchat')!;
    expect(root.style.getPropertyValue('--msg-accent-rgb')).toBe('47, 111, 237');
    expect(root.style.getPropertyValue('--msg-bubble-own-deep')).toBe('#c3d6fa');
  });

  it('turns the sender-name width into one custom property, and leaves it unset when none is given', () => {
    const tree = renderUi(view({ senderNameCh: 11 }));
    expect(q('.hub-mchat')!.style.getPropertyValue('--msg-sender-name-ch')).toBe('11');
    tree.rerender(view());
    expect(q('.hub-mchat')!.style.getPropertyValue('--msg-sender-name-ch')).toBe('');
  });

  it('puts the host attributes on the scroller the host clips its window to', () => {
    renderUi(view(), {
      env: {
        bankWindow: { initial: 1, grow: (c) => c },
        phoneQuery: '(max-width: 1px)',
        reactions: [],
        notifyError: () => undefined,
        scrollerAttrs: { 'data-host-window': '' },
      },
    });
    expect(q('.hub-mchat-msgs')!.hasAttribute('data-host-window')).toBe(true);
  });
});

describe('MessengerChatView: the slim composer', () => {
  it('sends the typed text on Enter and clears the box; Shift+Enter does not send', () => {
    const messenger = makeMessenger();
    renderUi(view({ messenger }));
    const box = q<HTMLTextAreaElement>('.msg-composer__input')!;
    typeInto(box, 'hi there');
    pressKey(box, 'Enter', { shiftKey: true });
    expect(messenger.sendMessage).not.toHaveBeenCalled();
    pressKey(box, 'Enter');
    expect(messenger.sendMessage).toHaveBeenCalledWith('hi there', undefined);
    expect(box.value).toBe('');
  });

  it('locks the input while the link is down', () => {
    renderUi(view({ messenger: makeMessenger({ connected: false }) }));
    expect(q<HTMLTextAreaElement>('.msg-composer__input')!.disabled).toBe(true);
  });

  it('tells the other side when typing starts and stops', () => {
    const messenger = makeMessenger();
    renderUi(view({ messenger }));
    const box = q<HTMLTextAreaElement>('.msg-composer__input')!;
    typeInto(box, 'h');
    typeInto(box, 'hi');
    expect(messenger.sendTyping.mock.calls).toEqual([[true]]);
    pressKey(box, 'Enter');
    expect(messenger.sendTyping.mock.calls).toEqual([[true], [false]]);
  });
});

describe('MessengerChatView: the host composer', () => {
  it('uses the composer the host supplied, with the link state and the sticker control wired', () => {
    const seen: ComposerSlotProps[] = [];
    const HostComposer = (props: ComposerSlotProps) => {
      seen.push(props);
      return <div data-host-composer="" />;
    };
    const onStickers = vi.fn();
    renderUi(view({ messenger: makeMessenger({ connected: false }), onStickers }), {
      slots: {
        ...FAKE_SLOTS,
        Composer: HostComposer,
      },
    });
    expect(q('[data-host-composer]')).toBeTruthy();
    expect(q('.msg-composer')).toBeNull();
    const props = seen.at(-1)!;
    expect(props.disabled).toBe(true);
    expect(props.allowImages).toBe(true);
    expect(props.enableVoice).toBe(true);
    expect(props.onStickers).toBe(onStickers);
    expect(props.initialDraft).toBeUndefined();
  });
});

describe('MessengerChatView: editing a message', () => {
  async function startEditing(messenger = makeMessenger({ messages: [makeMessage({ id: 'mine', senderId: 'me', text: 'first draft' })] })) {
    const tree = renderUi(view({ messenger, onStickers: () => undefined }));
    click(q('.hub-msg-actions'));
    await flush();
    click(q('[data-cm-row=edit]'));
    return { tree, messenger };
  }

  it('shows the banner, seeds the composer with the old text and turns pictures and stickers off', async () => {
    const seen: ComposerSlotProps[] = [];
    const messenger = makeMessenger({ messages: [makeMessage({ id: 'mine', senderId: 'me', text: 'first draft' })] });
    renderUi(view({ messenger, onStickers: () => undefined }), {
      slots: {
        ...FAKE_SLOTS,
        Composer: (props) => {
          seen.push(props);
          return <textarea data-host-composer="" defaultValue={props.initialDraft} />;
        },
      },
    });
    click(q('.hub-msg-actions'));
    await flush();
    click(q('[data-cm-row=edit]'));
    expect(q('.hub-mchat-editing')!.textContent).toContain('Editing message');
    expect(q('.hub-mchat-editing svg')!.getAttribute('data-icon')).toBe('mood');
    const props = seen.at(-1)!;
    expect(props.initialDraft).toBe('first draft');
    expect(props.allowImages).toBe(false);
    expect(props.enableVoice).toBe(false);
    expect(props.onStickers).toBeUndefined();
    expect(q<HTMLTextAreaElement>('[data-host-composer]')!.value).toBe('first draft');
  });

  it('sends the edit instead of a new message and leaves the editing state', async () => {
    const { messenger } = await startEditing();
    const box = q<HTMLTextAreaElement>('.msg-composer__input')!;
    expect(box.value).toBe('first draft');
    typeInto(box, 'second draft');
    pressKey(box, 'Enter');
    expect(messenger.editMessage).toHaveBeenCalledWith('mine', 'second draft');
    expect(messenger.sendMessage).not.toHaveBeenCalled();
    expect(q('.hub-mchat-editing')).toBeNull();
  });

  it('cancels from the banner without sending anything', async () => {
    const { messenger } = await startEditing();
    const cancel = q('.hub-mchat-editing button')!;
    expect(cancel.getAttribute('aria-label')).toBe('Cancel');
    click(cancel);
    expect(q('.hub-mchat-editing')).toBeNull();
    expect(messenger.editMessage).not.toHaveBeenCalled();
    expect(q<HTMLTextAreaElement>('.msg-composer__input')!.value).toBe('');
  });
});

describe('MessengerChatView: the gallery', () => {
  it('pages every picture of the tapped message in the host gallery and closes it', async () => {
    const media = createTestMedia({ 'a.png': 'blob:a', 'b.png': 'blob:b' });
    const messenger = makeMessenger({ messages: [makeMessage({ mediaUrl: 'a.png', mediaUrls: ['a.png', 'b.png'] })] });
    renderUi(view({ messenger }), { media });
    expect(q('[data-lightbox]')).toBeNull();
    click(qa('.hub-msg-images img')[1]!);
    const box = q('[data-lightbox]')!;
    expect(box.getAttribute('data-index')).toBe('1');
    expect(qa('[data-lightbox] img').map((i) => i.getAttribute('src'))).toEqual(['blob:a', 'blob:b']);
    click(q('[data-lightbox-close]'));
    expect(q('[data-lightbox]')).toBeNull();
  });
});

describe('MessengerChatView: older history', () => {
  it('asks for more when the list is scrolled to the top and there is more', () => {
    const messenger = makeMessenger({ messages: [makeMessage()], hasMore: true });
    renderUi(view({ messenger }));
    const scroller = q('.hub-mchat-msgs')!;
    scroller.scrollTop = 0;
    scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    expect(messenger.loadMore).toHaveBeenCalledTimes(1);
  });

  it('does not ask when there is nothing older', () => {
    const messenger = makeMessenger({ messages: [makeMessage()], hasMore: false });
    renderUi(view({ messenger }));
    q('.hub-mchat-msgs')!.dispatchEvent(new Event('scroll', { bubbles: true }));
    expect(messenger.loadMore).not.toHaveBeenCalled();
  });
});
