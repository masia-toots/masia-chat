// @vitest-environment jsdom
/**
 * The conversation view against the package's fakes: it works with its own slim composer, takes the
 * host's composer when one is supplied, replies to and edits a message through the composer (one
 * intent strip, internal ADR-199 §2–3), recalls the last own message on ArrowUp, quotes a parent from
 * the loaded list and scrolls to it, pages pictures in the host's gallery, carries the theme and the
 * sender-name width on its own root, and pages older history in whenever the top of the thread is in
 * sight, keeping the reader's place.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import {
  FAKE_SLOTS,
  cleanupUi,
  click,
  createFakeUi,
  createTestMedia,
  flush,
  pressKey,
  q,
  qa,
  renderUi,
  typeInto,
} from '../../../test-support/fake-ui.js';
import { makeMessage, makeMessenger } from '../../../test-support/fake-messenger.js';
import type { ReplySwipeSpec } from '../../provider/messenger-ui.js';
import type { ComposerSlotProps } from '../../provider/slots.js';
import { lastEditableOwn, MessengerChatView, REPLY_FLASH_MS } from '../messenger-chat-view.js';

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

  it('draws each sender\'s face once per run, in their colour, never on own rows — in a 1:1 as in a group (ADR-199 §8)', () => {
    const messages = [
      makeMessage({ id: 'a', senderId: 'ada', senderName: 'Ada' }),
      makeMessage({ id: 'b', senderId: 'ada', senderName: 'Ada' }),
      makeMessage({ id: 'c', senderId: 'me', senderName: 'Me' }),
      makeMessage({ id: 'd', senderId: 'bob', senderName: 'Bob', text: 'hi @ada and @bob' }),
    ];
    const participants = [
      { id: 'me', name: 'Me', color: '#22c55e', tag: 'me' },
      { id: 'ada', name: 'Ada', color: '#f97316', tag: 'ada', avatarUrl: 'https://x/ada.png' },
      { id: 'bob', name: 'Bob', color: '#a855f7' }, // no handle: a face and a colour, never a chip
    ];
    const tree = renderUi(view({ messenger: makeMessenger({ messages }), isGroup: true, participants }));
    expect(qa('.hub-msg-avatar')).toHaveLength(2);
    expect(qa('.hub-msg-avatar img').map((i) => i.getAttribute('src'))).toEqual(['https://x/ada.png']);
    expect(qa('.hub-msg-avatar-gap')).toHaveLength(1);
    expect(qa('.hub-msg-row').map((r) => r.style.getPropertyValue('--sender-color'))).toEqual(['#f97316', '#f97316', '', '#a855f7']);
    expect(qa('.hub-msg-mention').map((m) => m.textContent)).toEqual(['@ada']);

    tree.rerender(view({ messenger: makeMessenger({ messages: messages.slice(0, 3) }), isGroup: false, participants }));
    expect(qa('.hub-msg-avatar')).toHaveLength(1);
    expect(qa('.hub-msg-sender')).toHaveLength(0);
    expect(qa('.hub-msg--edged')).toHaveLength(2);
  });

  it('`broadcastTags` (a group of three or more, ADR-201): `@all` and `@online` are rows after the people and chips in the bubbles; `@online` reads «me» only while connected', () => {
    const messages = [makeMessage({ id: 'a', senderId: 'ada', senderName: 'Ada', text: '@all @online dinner at 7' })];
    const participants = [
      { id: 'me', name: 'Me', tag: 'me_tag' },
      { id: 'ada', name: 'Ada', tag: 'ada' },
    ];
    const tree = renderUi(view({ messenger: makeMessenger({ messages }), isGroup: true, participants, broadcastTags: true }));
    expect(qa('.hub-msg-mention').map((m) => [m.textContent, m.classList.contains('is-me')])).toEqual([
      ['@all', true],
      ['@online', true],
    ]);
    typeInto(q<HTMLTextAreaElement>('.msg-composer__input')!, '@');
    expect(qa('[role="option"] .msg-mention-popover__tag').map((n) => n.textContent)).toEqual(['@ada', '@all', '@online']);
    expect(qa('[role="option"] .msg-mention-popover__avatar--room')).toHaveLength(2);

    // offline: `@all` still names me, `@online` does not
    tree.rerender(
      view({ messenger: makeMessenger({ messages, connected: false }), isGroup: true, participants, broadcastTags: true }),
    );
    expect(qa('.hub-msg-mention').map((m) => [m.textContent, m.classList.contains('is-me')])).toEqual([
      ['@all', true],
      ['@online', false],
    ]);
  });

  it('without `broadcastTags` (a direct room, a group of two, the assistant chat) `@all` stays plain text and the composer offers no row', () => {
    const messages = [makeMessage({ id: 'a', senderId: 'ada', senderName: 'Ada', text: '@all @online hello' })];
    const participants = [
      { id: 'me', name: 'Me', tag: 'me_tag' },
      { id: 'ada', name: 'Ada', tag: 'ada' },
    ];
    renderUi(view({ messenger: makeMessenger({ messages }), isGroup: true, participants }));
    expect(qa('.hub-msg-mention')).toHaveLength(0);
    typeInto(q<HTMLTextAreaElement>('.msg-composer__input')!, '@');
    expect(qa('[role="option"] .msg-mention-popover__tag').map((n) => n.textContent)).toEqual(['@ada']);
  });

  it('a host-drawn service row: `renderServiceRow` draws a SYSTEM row its own way; what it declines stays a bubble', () => {
    const messages = [
      makeMessage({ id: 'a', senderId: 'ada', senderName: 'Ada', text: 'hi' }),
      makeMessage({ id: 'b', senderId: 'ada', senderName: 'Ada', text: 'Missed call', messageType: 'SYSTEM' }),
      makeMessage({ id: 'c', senderId: 'me', senderName: 'Me', text: 'Other notice', messageType: 'SYSTEM' }),
    ];
    const renderServiceRow = vi.fn(({ message, isOwn }: { message: { id: string }; isOwn: boolean }) =>
      message.id === 'b' ? <div className="host-row" data-own={String(isOwn)}>called</div> : undefined,
    );
    renderUi(view({ messenger: makeMessenger({ messages }), renderServiceRow }));
    expect(q('.host-row')!.textContent).toBe('called');
    expect(q('.host-row')!.getAttribute('data-own')).toBe('false');
    expect(qa('.hub-msg-row')).toHaveLength(2); // `a` and the declined `c`
    // asked about SYSTEM rows only, with whose row it is
    expect(renderServiceRow.mock.calls.map(([p]) => [p.message.id, p.isOwn])).toEqual([
      ['b', false],
      ['c', true],
    ]);
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

  it('opening a chat whose newest line is my reply still reads up to it: an unread before the reply clears (К3)', () => {
    const messenger = makeMessenger({
      messages: [
        makeMessage({ id: 'theirs', senderId: 'them', createdAt: '2026-11-18T13:14:07.145Z' }),
        makeMessage({ id: 'mine', senderId: 'me', createdAt: '2026-11-19T12:57:31.850Z' }),
      ],
    });
    renderUi(view({ messenger }));
    expect(messenger.markRead).toHaveBeenCalledWith('2026-11-19T12:57:31.850Z');
  });

  it('a line still on its way (or not sent) has no server time: the read names the newest one the server holds', () => {
    const messenger = makeMessenger({
      messages: [
        makeMessage({ id: 'theirs', senderId: 'them', createdAt: '2026-10-10T10:05:00.000Z' }),
        makeMessage({ id: 'pending-1', senderId: 'me', createdAt: '2026-10-10T10:06:00.000Z' }),
        makeMessage({ id: 'pending-2', senderId: 'me', createdAt: '2026-10-10T10:07:00.000Z', sendFailed: true }),
      ],
    });
    renderUi(view({ messenger }));
    expect(messenger.markRead).toHaveBeenCalledTimes(1);
    expect(messenger.markRead).toHaveBeenCalledWith('2026-10-10T10:05:00.000Z');
  });

  it('nothing on the server yet → no read mark', () => {
    const messenger = makeMessenger({ messages: [makeMessage({ id: 'pending-1', senderId: 'me' })] });
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

describe('MessengerChatView: a message of mine that never left', () => {
  const failed = () =>
    makeMessage({ id: 'pending-1-1', senderId: 'me', text: 'five minutes of words', sendFailed: true });

  it('says «not sent» with Retry and Delete, and each does what it says', () => {
    const messenger = makeMessenger({ messages: [failed()], retrySend: vi.fn() });
    renderUi(view({ messenger }));
    expect(q('.hub-msg-unsent-label')!.textContent).toBe('Not sent');
    expect(q('.hub-msg-check')).toBeNull();

    click(q('.hub-msg-unsent-retry'));
    expect(messenger.retrySend).toHaveBeenCalledWith('pending-1-1');
    click(q('.hub-msg-unsent-delete'));
    expect(messenger.deleteMessage).toHaveBeenCalledWith('pending-1-1');
  });

  it('offers only Copy in its menu: it has no server id to reply to, edit, react to or delete there', async () => {
    renderUi(view({ messenger: makeMessenger({ messages: [failed()], retrySend: vi.fn() }) }));
    click(q('.hub-msg-actions'));
    await flush();
    expect(qa('[data-cm-row]').map((r) => r.getAttribute('data-cm-row'))).toEqual(['copy']);
    expect(q('.hub-react-bar')).toBeNull();
  });
});

describe('MessengerChatView: a host line in place of the composer', () => {
  it('draws the host line where the composer would be, and no composer at all', () => {
    renderUi(view({ composerBlock: <p data-test-block="">not on this device</p> }));
    expect(q('[data-composer-blocked] [data-test-block]')!.textContent).toBe('not on this device');
    expect(q('.msg-composer__input')).toBeNull();
  });

  it('keeps the composer when the host gives none', () => {
    renderUi(view({ composerBlock: null }));
    expect(q('[data-composer-blocked]')).toBeNull();
    expect(q('.msg-composer__input')).toBeTruthy();
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
    expect(q('.hub-mchat-intent')!.getAttribute('data-intent')).toBe('edit');
    expect(q('.hub-mchat-intent')!.textContent).toContain('Editing message');
    expect(q('.hub-mchat-intent svg')!.getAttribute('data-icon')).toBe('mood');
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
    expect(q('.hub-mchat-intent')).toBeNull();
  });

  it('cancels from the banner without sending anything', async () => {
    const { messenger } = await startEditing();
    const cancel = q('.hub-mchat-intent button')!;
    expect(cancel.getAttribute('aria-label')).toBe('Cancel');
    click(cancel);
    expect(q('.hub-mchat-intent')).toBeNull();
    expect(messenger.editMessage).not.toHaveBeenCalled();
    expect(q<HTMLTextAreaElement>('.msg-composer__input')!.value).toBe('');
  });

  it('cancels on Esc from the composer', async () => {
    const { messenger } = await startEditing();
    pressKey(q('.msg-composer__input'), 'Escape');
    expect(q('.hub-mchat-intent')).toBeNull();
    expect(messenger.editMessage).not.toHaveBeenCalled();
  });
});

describe('MessengerChatView: replying to a message', () => {
  const theirs = () => makeMessage({ id: 'theirs', senderId: 'them', senderName: 'Ada', text: 'shall we?' });

  async function startReply(messenger = makeMessenger({ messages: [theirs()] })) {
    renderUi(view({ messenger, onStickers: () => undefined }));
    click(q('.hub-msg-actions'));
    await flush();
    click(q('[data-cm-row=reply]'));
    return messenger;
  }

  it('offers Reply first in the menu of any message, own or not', async () => {
    renderUi(view({ messenger: makeMessenger({ messages: [theirs(), makeMessage({ id: 'mine', senderId: 'me' })] }) }));
    click(qa('.hub-msg-actions')[0]!);
    await flush();
    expect(qa('[data-cm-row]').map((r) => r.getAttribute('data-cm-row'))).toEqual(['reply', 'copy']);
    pressKey(document.body, 'Escape');
    click(qa('.hub-msg-actions')[1]!);
    await flush();
    expect(qa('[data-cm-row]').map((r) => r.getAttribute('data-cm-row'))).toEqual(['reply', 'copy', 'edit', 'delete']);
  });

  it('shows who is being answered and keeps pictures, stickers and voice on', async () => {
    const seen: ComposerSlotProps[] = [];
    const messenger = makeMessenger({ messages: [theirs()] });
    renderUi(view({ messenger, onStickers: () => undefined }), {
      slots: { ...FAKE_SLOTS, Composer: (props) => { seen.push(props); return <textarea data-host-composer="" />; } },
    });
    click(q('.hub-msg-actions'));
    await flush();
    click(q('[data-cm-row=reply]'));
    const strip = q('.hub-mchat-intent')!;
    expect(strip.getAttribute('data-intent')).toBe('reply');
    expect(strip.textContent).toContain('Replying to Ada');
    expect(strip.textContent).toContain('shall we?');
    const props = seen.at(-1)!;
    expect(props.allowImages).toBe(true);
    expect(props.enableVoice).toBe(true);
    expect(props.onStickers).toBeDefined();
    expect(props.initialDraft).toBeUndefined();
  });

  it('sends the text with the parent id and leaves the intent', async () => {
    const messenger = await startReply();
    const box = q<HTMLTextAreaElement>('.msg-composer__input')!;
    typeInto(box, 'yes!');
    pressKey(box, 'Enter');
    expect(messenger.sendMessage).toHaveBeenCalledWith('yes!', { replyToId: 'theirs' });
    expect(q('.hub-mchat-intent')).toBeNull();
  });

  it('keeps the draft already typed when a reply is chosen', async () => {
    const messenger = makeMessenger({ messages: [theirs()] });
    renderUi(view({ messenger }));
    typeInto(q<HTMLTextAreaElement>('.msg-composer__input'), 'half a thought');
    click(q('.hub-msg-actions'));
    await flush();
    click(q('[data-cm-row=reply]'));
    expect(q<HTMLTextAreaElement>('.msg-composer__input')!.value).toBe('half a thought');
  });

  it('cancels from ✕ and from Esc without sending', async () => {
    const messenger = await startReply();
    click(q('.hub-mchat-intent button'));
    expect(q('.hub-mchat-intent')).toBeNull();
    click(q('.hub-msg-actions'));
    await flush();
    click(q('[data-cm-row=reply]'));
    pressKey(q('.msg-composer__input'), 'Escape');
    expect(q('.hub-mchat-intent')).toBeNull();
    expect(messenger.sendMessage).not.toHaveBeenCalled();
  });
});

describe('MessengerChatView: the reply quote', () => {
  const parent = () => makeMessage({ id: 'p', senderId: 'them', senderName: 'Ada', text: 'the question' });
  const child = (over: Partial<Parameters<typeof makeMessage>[0]> = {}) =>
    makeMessage({ id: 'c', senderId: 'me', text: 'the answer', replyToId: 'p', replyToPreview: null, ...over });

  it('quotes a parent from the loaded list when the server sent no preview', () => {
    renderUi(view({ messenger: makeMessenger({ messages: [parent(), child()] }) }));
    expect(q('.hub-msg-reply-who')!.textContent).toBe('Ada');
    expect(q('.hub-msg-reply-text')!.textContent).toBe('the question');
  });

  it('prefers the preview the server sent', () => {
    const messages = [parent(), child({ replyToPreview: { senderName: 'Server', text: 'joined text' } })];
    renderUi(view({ messenger: makeMessenger({ messages }) }));
    expect(q('.hub-msg-reply-who')!.textContent).toBe('Server');
    expect(q('.hub-msg-reply-text')!.textContent).toBe('joined text');
  });

  it('says «message deleted» for a deleted parent, never its old words', () => {
    const gone = makeMessage({ ...parent(), deletedAt: '2026-11-06T10:00:00.000Z' });
    renderUi(view({ messenger: makeMessenger({ messages: [gone, child()] }) }));
    expect(q('.hub-msg-reply-text')!.textContent).toBe('Message deleted');
    expect(q('.hub-msg-reply')!.textContent).not.toContain('the question');
  });

  it('draws no quote when the parent is not loaded', () => {
    renderUi(view({ messenger: makeMessenger({ messages: [child()] }) }));
    expect(q('.hub-msg-reply')).toBeNull();
  });

  it('scrolls to the parent on tap and flashes it for a moment', () => {
    vi.useFakeTimers();
    try {
      const scrollIntoView = vi.fn();
      Element.prototype.scrollIntoView = scrollIntoView;
      renderUi(view({ messenger: makeMessenger({ messages: [parent(), child()] }) }));
      click(q('.hub-msg-reply'));
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      const row = q('[data-msg-id="p"]')!;
      expect(row.classList.contains('hub-msg--flash')).toBe(true);
      act(() => void vi.advanceTimersByTime(REPLY_FLASH_MS));
      expect(row.classList.contains('hub-msg--flash')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('MessengerChatView: ArrowUp recalls the last own message', () => {
  const history = () => [
    makeMessage({ id: 'a', senderId: 'me', text: 'older of mine' }),
    makeMessage({ id: 'b', senderId: 'them', text: 'theirs' }),
    makeMessage({ id: 'c', senderId: 'me', text: 'latest of mine' }),
    makeMessage({ id: 'd', senderId: 'me', text: 'motion|sound', messageType: 'STICKER' }),
    makeMessage({ id: 'e', senderId: 'me', text: 'gone', deletedAt: '2026-11-06T10:00:00.000Z' }),
  ];

  it('picks the last own text message, skipping stickers and deleted ones', () => {
    expect(lastEditableOwn(history(), 'me')?.id).toBe('c');
    expect(lastEditableOwn(history(), 'them')?.id).toBe('b');
    expect(lastEditableOwn(history(), 'nobody')).toBeUndefined();
  });

  it('↑ in an empty box opens the edit of the latest own text and seeds it', () => {
    const messenger = makeMessenger({ messages: history() });
    renderUi(view({ messenger }));
    pressKey(q('.msg-composer__input'), 'ArrowUp');
    expect(q('.hub-mchat-intent')!.getAttribute('data-intent')).toBe('edit');
    const box = q<HTMLTextAreaElement>('.msg-composer__input')!;
    expect(box.value).toBe('latest of mine');
    expect(box.selectionStart).toBe('latest of mine'.length);
    typeInto(box, 'latest of mine, fixed');
    pressKey(box, 'Enter');
    expect(messenger.editMessage).toHaveBeenCalledWith('c', 'latest of mine, fixed');
  });

  it('↑ in a box with text leaves the draft alone', () => {
    renderUi(view({ messenger: makeMessenger({ messages: history() }) }));
    const box = q<HTMLTextAreaElement>('.msg-composer__input')!;
    typeInto(box, 'typing');
    pressKey(box, 'ArrowUp');
    expect(q('.hub-mchat-intent')).toBeNull();
    expect(box.value).toBe('typing');
  });

  it('↑ with nothing of mine to recall does nothing', () => {
    renderUi(view({ messenger: makeMessenger({ messages: [makeMessage({ senderId: 'them' })] }) }));
    pressKey(q('.msg-composer__input'), 'ArrowUp');
    expect(q('.hub-mchat-intent')).toBeNull();
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

  it('pages on over the pictures of the whole thread: a photo sent on its own is page 3 of 3, not 1 of 1', () => {
    const media = createTestMedia({ 'a.png': 'blob:a', 'b.png': 'blob:b', 'plan.pdf': 'blob:plan', 'c.png': 'blob:c', 'd.png': 'blob:d' });
    const messages = [
      makeMessage({ id: 'm1', mediaUrl: 'a.png', mediaUrls: ['a.png', 'b.png'] }),
      makeMessage({ id: 'm2', text: 'words only' }),
      makeMessage({ id: 'm3', mediaUrl: 'plan.pdf' }), // a document: no page of its own
      makeMessage({ id: 'm4', mediaUrl: 'c.png' }),
      makeMessage({ id: 'm5', mediaUrl: 'd.png', deletedAt: '2026-11-19T10:00:00Z' }), // taken back: its picture goes with it
    ];
    renderUi(view({ messenger: makeMessenger({ messages }) }), { media });
    const doors = qa<HTMLButtonElement>('.hub-msg-image-open');
    expect(doors).toHaveLength(3);

    click(doors[2]!);
    expect(qa('[data-lightbox]')).toHaveLength(1); // ONE viewer for the whole chat
    expect(qa('[data-lightbox] img').map((i) => i.getAttribute('src'))).toEqual(['blob:a', 'blob:b', 'blob:c']);
    expect(q('[data-lightbox]')!.getAttribute('data-index')).toBe('2');

    // every thumbnail opens the SAME three pages, on its own place
    click(q('[data-lightbox-close]'));
    click(doors[1]!);
    expect(qa('[data-lightbox] img')).toHaveLength(3);
    expect(q('[data-lightbox]')!.getAttribute('data-index')).toBe('1');
  });

  it('every thumbnail is a button named by its place in its message, so a keyboard and a screen reader reach it', () => {
    const media = createTestMedia({ 'a.png': 'blob:a', 'b.png': 'blob:b' });
    const messenger = makeMessenger({ messages: [makeMessage({ mediaUrl: 'a.png', mediaUrls: ['a.png', 'b.png'] })] });
    renderUi(view({ messenger }), { media });
    const doors = qa<HTMLButtonElement>('button.hub-msg-image-open');
    expect(doors.map((d) => d.getAttribute('aria-label'))).toEqual(['Open picture 1', 'Open picture 2']);
    expect(doors.every((d) => d.querySelector('img'))).toBe(true);
  });
});

/**
 * jsdom has no IntersectionObserver: this one records what it watches, and the test says when the
 * watched node is in sight. Like the browser's, a fresh one is told the state at once — by the test.
 */
class FakeObserver {
  static readonly live = new Set<FakeObserver>();
  readonly targets = new Set<Element>();
  constructor(private readonly callback: IntersectionObserverCallback) {
    FakeObserver.live.add(this);
  }
  observe(target: Element): void {
    this.targets.add(target);
  }
  unobserve(target: Element): void {
    this.targets.delete(target);
  }
  disconnect(): void {
    this.targets.clear();
    FakeObserver.live.delete(this);
  }
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
  report(isIntersecting: boolean): void {
    const entries = [...this.targets].map((target) => ({ target, isIntersecting }) as IntersectionObserverEntry);
    if (entries.length) this.callback(entries, this as unknown as IntersectionObserver);
  }
}

/** The observers watching the thread's top edge right now. */
const watchingTheTop = () =>
  [...FakeObserver.live].filter((o) => [...o.targets].some((t) => t.classList.contains('hub-mchat-history-edge')));

/** The top of the thread comes into sight (or leaves it). */
function topInSight(inSight = true): void {
  act(() => {
    for (const o of watchingTheTop()) o.report(inSight);
  });
}

/** Gives a node the box a browser would: its sizes and offset read from `box`, and written back to it. */
function layOut(el: HTMLElement, box: { scrollHeight: number; clientHeight: number; scrollTop: number }): void {
  for (const key of ['scrollHeight', 'clientHeight', 'scrollTop'] as const) {
    Object.defineProperty(el, key, {
      configurable: true,
      get: () => box[key],
      set: (v: number) => {
        box[key] = v;
      },
    });
  }
}

describe('MessengerChatView: older history', () => {
  beforeEach(() => vi.stubGlobal('IntersectionObserver', FakeObserver));
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeObserver.live.clear();
  });

  const page1 = [makeMessage({ id: 'm3' }), makeMessage({ id: 'm4' })];
  const older = [makeMessage({ id: 'm1' }), makeMessage({ id: 'm2' })];

  it('asks for the page above once the top of the thread is in sight — with no scroll at all', () => {
    const loadMore = vi.fn();
    renderUi(view({ messenger: makeMessenger({ messages: page1, hasMore: true, loadMore }) }));
    expect(watchingTheTop()).toHaveLength(1);
    expect(loadMore).not.toHaveBeenCalled();
    topInSight();
    expect(loadMore).toHaveBeenCalledTimes(1);
    // still in sight while the page is on its way: no second request
    topInSight();
    expect(loadMore).toHaveBeenCalledTimes(1);
  });

  it('asks nothing while a page is loading, and asks again when the page that landed still leaves the top in sight', () => {
    const loadMore = vi.fn();
    const tree = renderUi(view({ messenger: makeMessenger({ messages: page1, hasMore: true, loadMore }) }));
    topInSight();
    tree.rerender(view({ messenger: makeMessenger({ messages: page1, hasMore: true, loadingHistory: true, loadMore }) }));
    expect(watchingTheTop()).toHaveLength(0);
    topInSight();
    expect(loadMore).toHaveBeenCalledTimes(1);
    // the page is in, the screen is still not full: the next one, by itself
    tree.rerender(view({ messenger: makeMessenger({ messages: [...older, ...page1], hasMore: true, loadMore }) }));
    topInSight();
    expect(loadMore).toHaveBeenCalledTimes(2);
  });

  it('stops when the server says there is nothing older', () => {
    const loadMore = vi.fn();
    const tree = renderUi(view({ messenger: makeMessenger({ messages: page1, hasMore: true, loadMore }) }));
    topInSight();
    tree.rerender(view({ messenger: makeMessenger({ messages: [...older, ...page1], hasMore: false, loadMore }) }));
    expect(watchingTheTop()).toHaveLength(0);
    topInSight();
    expect(loadMore).toHaveBeenCalledTimes(1);
  });

  it('does not ask from the same place again after a load that brought nothing, until the reader scrolls away and back', () => {
    const loadMore = vi.fn();
    const tree = renderUi(view({ messenger: makeMessenger({ messages: page1, hasMore: true, loadMore }) }));
    topInSight();
    tree.rerender(view({ messenger: makeMessenger({ messages: page1, hasMore: true, loadingHistory: true, loadMore }) }));
    // the fetch failed: the same thread, still more behind it
    tree.rerender(view({ messenger: makeMessenger({ messages: page1, hasMore: true, loadMore }) }));
    topInSight();
    expect(loadMore).toHaveBeenCalledTimes(1);
    topInSight(false);
    topInSight();
    expect(loadMore).toHaveBeenCalledTimes(2);
  });

  it('keeps the message the reader was at in place when older ones land above it, and not for one arriving below', () => {
    const loadMore = vi.fn();
    const tree = renderUi(view({ messenger: makeMessenger({ messages: page1, hasMore: true, loadMore }) }));
    const list = q<HTMLElement>('.hub-mchat-msgs')!;
    list.style.overflowY = 'auto';
    const box = { scrollHeight: 1000, clientHeight: 600, scrollTop: 40 };
    layOut(list, box);
    // she has scrolled up from the newest message, near the top
    act(() => {
      list.dispatchEvent(new Event('scroll'));
    });
    const first = q('.hub-mchat-inner')!.firstElementChild!;
    const place = { top: 150 };
    first.getBoundingClientRect = () => ({ top: place.top }) as DOMRect;

    topInSight();
    expect(loadMore).toHaveBeenCalledTimes(1);
    const loading = (messages: typeof page1) => makeMessenger({ messages, hasMore: true, loadingHistory: true, loadMore });
    tree.rerender(view({ messenger: loading(page1) }));
    const below = makeMessage({ id: 'm5' });
    tree.rerender(view({ messenger: loading([...page1, below]) }));
    expect(box.scrollTop).toBe(40);

    // the page lands above and pushes her message 500 px down; the list follows it by as much
    place.top = 650;
    tree.rerender(view({ messenger: makeMessenger({ messages: [...older, ...page1, below], hasMore: true, loadMore }) }));
    expect(q('.hub-mchat-inner')!.children[older.length]).toBe(first);
    expect(box.scrollTop).toBe(540);
  });
});

describe('MessengerChatView: the reply swipe (a row pulled right is answered)', () => {
  const theirs = () => makeMessage({ id: 'theirs', senderId: 'them', senderName: 'Ada', text: 'shall we?' });

  /** The host's gesture, stood in by a spy: the view hands it the scroller and a spec; the test plays the host. */
  function mountWithHost(messages: ReturnType<typeof makeMessage>[]) {
    const detach = vi.fn();
    let spec: (() => ReplySwipeSpec) | undefined;
    let root: HTMLElement | undefined;
    const attachReplySwipe = vi.fn((r: HTMLElement, read: () => ReplySwipeSpec) => {
      root = r;
      spec = read;
      return detach;
    });
    const env = { ...createFakeUi().services.env, attachReplySwipe };
    const tree = renderUi(view({ messenger: makeMessenger({ messages }) }), { env });
    return { tree, attachReplySwipe, detach, root: () => root, spec: () => spec!() };
  }
  const rowOf = (id: string) => q<HTMLElement>(`[data-msg-id="${id}"]`)!;

  it('⭐ attaches ONE listener to the thread’s scroller, for the rows of messages', () => {
    const host = mountWithHost([theirs()]);
    expect(host.attachReplySwipe).toHaveBeenCalledTimes(1);
    expect(host.root()).toBe(q('.hub-mchat-msgs'));
    expect(rowOf('theirs').matches(host.spec().rowSelector)).toBe(true);
  });

  it('⭐ a swiped row opens the SAME reply intent as the menu’s Reply row (who is being answered)', () => {
    const host = mountWithHost([theirs()]);
    act(() => host.spec().reply(rowOf('theirs')));
    const strip = q('.hub-mchat-intent')!;
    expect(strip.getAttribute('data-intent')).toBe('reply');
    expect(strip.textContent).toContain('Replying to Ada');
    expect(strip.textContent).toContain('shall we?');
  });

  it('a deleted message and a turn that never left cannot be answered; a normal one, own or not, can', () => {
    const host = mountWithHost([
      theirs(),
      makeMessage({ id: 'mine', senderId: 'me', text: 'ok' }),
      makeMessage({ id: 'gone', senderId: 'them', deletedAt: '2026-11-06T10:00:00.000Z' }),
      makeMessage({ id: 'pending-9', senderId: 'me', text: 'on its way' }),
      makeMessage({ id: 'failed', senderId: 'me', text: 'not sent', sendFailed: true }),
    ]);
    const can = (id: string) => host.spec().canReply(rowOf(id));
    expect(can('theirs')).toBe(true);
    expect(can('mine')).toBe(true);
    // a deleted message is drawn as a placeholder row that still carries the id, but is not answerable
    expect(can('gone')).toBe(false);
    expect(can('pending-9')).toBe(false);
    expect(can('failed')).toBe(false);
  });

  it('the spec reads the LATEST list: a message that arrives after the attach can be answered', () => {
    const host = mountWithHost([theirs()]);
    host.tree.rerender(view({ messenger: makeMessenger({ messages: [theirs(), makeMessage({ id: 'later', senderId: 'them', text: 'new' })] }) }));
    expect(host.attachReplySwipe).toHaveBeenCalledTimes(1);
    expect(host.spec().canReply(rowOf('later'))).toBe(true);
  });

  it('lets go of the host’s gesture when the view goes away', () => {
    const host = mountWithHost([theirs()]);
    host.tree.unmount();
    expect(host.detach).toHaveBeenCalledTimes(1);
  });

  it('a host without the gesture draws no swipe and nothing breaks (the menu’s Reply is the way)', () => {
    renderUi(view({ messenger: makeMessenger({ messages: [theirs()] }) }));
    expect(q('.hub-msg-row')).toBeTruthy();
  });
});
