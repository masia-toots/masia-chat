/**
 * MessengerChatView — the messenger-native chat renderer (P2P), styled to the messenger mockup and
 * driven by `useMessenger`: them/me bubbles with tails, group sender labels, reply previews,
 * stickers (the host draws them), inline + persisted images (paged in the host's gallery), reactions
 * (pills + a picker), reply, edit, delete, typing indicators, read-receipt checkmarks, and load-more
 * history. The composer is the host's (the `Composer` slot) or the package's own slim one.
 *
 * The next send has ONE intent (internal ADR-199 §2): none, `reply` (quote a message) or `edit`
 * (replace an own one). `IntentStrip` shows it above the composer; ✕ and Esc cancel it. ArrowUp in
 * an empty composer recalls the last own text message into an edit (§3).
 */
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { Loader, Text } from '@mantine/core';
import { isUnconfirmedMessage } from '../../hooks/messenger-outbox.js';
import type { UseMessengerReturn } from '../../hooks/use-messenger.js';
import type { MessengerMessage } from '../../protocol/messages.js';
import { Composer as SlimComposer } from '../composer/composer.js';
import { useMessengerUi, useT } from '../provider/messenger-ui.js';
import type { Participant } from '../provider/slots.js';
import { SecurityStrip } from '../security/security-strip.js';
import { Bubble } from './bubble.js';
import { IntentStrip, type MessageIntent } from './intent-strip.js';
import { canReplyTo, hasEditableText } from './message-actions.js';
import { buildMentionCandidates } from './mention-candidates.js';
import { withReplyPreviews } from './reply-preview.js';
import { usePictureGallery } from './use-picture-gallery.js';
import './messenger-chat-view.css';

/** How long the parent bubble glows after its quote was tapped (matches `.hub-msg--flash` in the CSS). */
export const REPLY_FLASH_MS = 1200;
/** The class the flash rides; the stylesheet owns how it looks and respects reduced motion. */
const FLASH_CLASS = 'hub-msg--flash';

/** The last message of `messages` this person may still edit: own, with words, not a sticker, not deleted. */
export function lastEditableOwn(messages: readonly MessengerMessage[], personId: string): MessengerMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.senderId === personId && !m.deletedAt && hasEditableText(m)) return m;
  }
  return undefined;
}

/** The server time of the newest message the server holds (what `msg:read { upTo }` names), or null. */
function newestConfirmedAt(messages: readonly MessengerMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (!isUnconfirmedMessage(m)) return m.createdAt;
  }
  return null;
}

export interface MessengerChatViewProps {
  messenger: UseMessengerReturn;
  currentPersonId: string;
  isGroup: boolean;
  isPrivate?: boolean;
  /**
   * The open conversation's id, for the security strip (the guardian ribbon and the stall banner
   * under the host's header). Absent: no strip. The id is only a key into the provider's
   * `security` source; a room it knows nothing about draws nothing.
   */
  conversationId?: string;
  /** Opens the host's sticker picker; absent hides the composer's sticker control. */
  onStickers?: () => void;
  /**
   * Width, in characters, of the sender-name row of a group bubble. The host passes the longest name
   * it knows, so every bubble of a group chat has the same name-row width whoever sent it (the font
   * is monospace, so a character count is an exact width). Absent: the row sizes to its content.
   */
  senderNameCh?: number;
  /**
   * A host line drawn under the security strip and above the thread, outside the scroller (so nothing
   * scrolls it away): the host's own state of the room that the package has no vocabulary for (an
   * end-to-end room still being set up, a device waiting for approval). Absent or `null`: nothing.
   */
  banner?: ReactNode;
  /**
   * The host's line that stands IN PLACE of the composer when this person cannot write here from this
   * device (an end-to-end room on a device not yet added to the person's encrypted chats): said before
   * anything is typed, not after a send fails. The host owns the words and the way out it offers.
   * Absent or `null`: the composer.
   */
  composerBlock?: ReactNode;
  /**
   * The room's people as the host knows them (internal ADR-199 §8), me included — ONE list: the
   * sender's picture (or an initial) on the first bubble of a run and the colour of their name and
   * bubble edge; the ones WITH a `tag` are also the `@tag` completion in the composer (everyone but
   * me) and the chips in the bubbles (everyone). Absent: no avatars, theme colours, no mentions.
   */
  participants?: readonly Participant[];
  /**
   * The assistant may be called here with `@masia`: the host's fact (her mode in this room is not
   * silent and the room is not end-to-end encrypted). Absent or `false`: she is not offered.
   */
  masiaCanBeCalled?: boolean;
  /**
   * `@all` and `@online` call the whole room here (ADR-201 Decision 4): the host's fact — a group or family
   * room of three or more people (in a direct room and in the assistant's chat they are plain words). Adds the
   * two completion rows and the two chips; the host (and the server) decide what the tags do. Absent or `false`: neither.
   */
  broadcastTags?: boolean;
  /**
   * The host draws one of its own SYSTEM rows its own way (a missed call with a «call back» action): the view asks it
   * about each `SYSTEM` message, with whether the row is this person's. A node replaces the bubble; `undefined` keeps
   * the bubble. The host owns the vocabulary of its rows; the package only gives it the place. Absent: every row is a
   * bubble.
   */
  renderServiceRow?: (row: ServiceRowProps) => ReactNode | undefined;
}

/** What the view tells the host about one of its SYSTEM rows (`renderServiceRow`). */
export interface ServiceRowProps {
  readonly message: MessengerMessage;
  /** The row is this person's (its sender is `currentPersonId`). */
  readonly isOwn: boolean;
}

/** Where the reader was when older history was asked for: the first message then, and where it stood. */
interface PrependAnchor {
  /** The box that scrolls (`scrollingBox`): the one whose offset puts the reader back. */
  readonly box: HTMLElement;
  /** That message's node and its top edge on screen then. Kept by its node, not by the thread's height,
   *  so a spinner, a message arriving at the bottom or the browser's own anchoring cannot skew it. */
  readonly row: Element;
  readonly at: number;
  /** Its id: the place is restored once a page lands above it. */
  readonly firstId: string | undefined;
}

const SCROLLING_OVERFLOW = /^(auto|scroll|overlay)$/;

/**
 * The box that actually moves when the thread is scrolled: the list itself, or — in a host whose
 * chain lets the list grow to its content — the nearest ancestor that scrolls (the page's own
 * scroller counts whatever its `overflow` says). The reader's place is kept on THAT box, or a prepend
 * would leave the top edge in sight and page the whole history in. When nothing scrolls yet (a first
 * page too short to fill the list) it is the list: the page that lands is what overflows it.
 */
function scrollingBox(list: HTMLElement): HTMLElement {
  const viewport = document.scrollingElement;
  for (let el: HTMLElement | null = list; el; el = el.parentElement) {
    if (el.scrollHeight <= el.clientHeight) continue;
    if (el === viewport || SCROLLING_OVERFLOW.test(getComputedStyle(el).overflowY)) return el;
  }
  return list;
}

export function MessengerChatView({
  messenger,
  currentPersonId,
  isGroup,
  isPrivate,
  conversationId,
  onStickers,
  senderNameCh,
  banner,
  composerBlock,
  participants,
  masiaCanBeCalled,
  broadcastTags,
  renderServiceRow,
}: MessengerChatViewProps) {
  const t = useT();
  const { slots, env, themeStyle, media } = useMessengerUi();
  const Composer = slots.Composer ?? SlimComposer;
  const Lightbox = slots.Lightbox;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const historyEdgeRef = useRef<HTMLDivElement | null>(null);
  const threadRef = useRef<HTMLDivElement | null>(null);
  const didInitialScrollRef = useRef(false);
  const nearBottomRef = useRef(true);
  const prevCountRef = useRef(0);
  const prependAnchorRef = useRef<PrependAnchor | null>(null);
  // The first message when older history was last asked for; cleared once the top leaves sight.
  const askedFromRef = useRef<{ firstId: string | undefined } | null>(null);
  const justPrependedRef = useRef(false);
  const [intent, setIntent] = useState<MessageIntent | null>(null);
  const cancelIntent = useCallback(() => setIntent(null), []);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const masiaName = t('chat.masiaName');
  const mentionAllLabel = t('chat.mentionAll');
  const mentionOnlineLabel = t('chat.mentionOnline');
  const mentions = useMemo(
    () =>
      buildMentionCandidates(
        participants,
        currentPersonId,
        masiaCanBeCalled ? masiaName : undefined,
        broadcastTags ? { all: mentionAllLabel, online: mentionOnlineLabel } : undefined,
      ),
    [participants, currentPersonId, masiaCanBeCalled, masiaName, broadcastTags, mentionAllLabel, mentionOnlineLabel],
  );
  // Who sent a bubble, by id — the picture and the colour come from here (ADR-199 §8).
  const participantById = useMemo(
    () => new Map((participants ?? []).map((p) => [p.id, p] as const)),
    [participants],
  );

  const {
    messages: loaded,
    connected,
    typingIndicators,
    sendMessage,
    sendTyping,
    markRead,
    deleteMessage,
    editMessage,
    reactToMessage,
    retrySend,
    loadMore,
    hasMore,
    loadingHistory,
  } = messenger;
  // A reply whose preview the server left empty (the sender's own row) is quoted from the loaded list.
  const messages = useMemo(() => withReplyPreviews(loaded), [loaded]);
  // The host's viewer (it pages, swipes and zooms), over every picture of the loaded thread: a tap on one
  // opens it there, and next/previous walk on into the neighbouring messages' pictures.
  const { gallery, open: openGallery, page: pageGallery, close: closeGallery } = usePictureGallery(messages, media.peek);

  // A message pulled to the right is answered (canon shell §6c): the host's thumb machinery reports the swipe, this view says which row
  // is which message and what a reply means (the same intent the `⋮` menu's Reply row sets, so a finger and a menu cannot differ).
  // The press is delegated on the scroller — one listener for the whole thread, whatever its length — and reads the latest list.
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const attachReplySwipe = env.attachReplySwipe;
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || !attachReplySwipe) return undefined;
    const messageOf = (row: HTMLElement): MessengerMessage | undefined => {
      const id = row.getAttribute('data-msg-id');
      return id ? messagesRef.current.find((m) => m.id === id) : undefined;
    };
    return attachReplySwipe(scroller, () => ({
      rowSelector: '.hub-msg-row[data-msg-id]',
      canReply: (row) => {
        const m = messageOf(row);
        return !!m && canReplyTo(m);
      },
      reply: (row) => {
        const m = messageOf(row);
        if (m) setIntent({ mode: 'reply', message: m });
      },
    }));
  }, [attachReplySwipe]);

  // Initial jump to bottom (instant, pre-paint), once per conversation.
  useLayoutEffect(() => {
    if (didInitialScrollRef.current || messages.length === 0) return;
    const sc = scrollRef.current;
    if (!sc) return;
    sc.scrollTop = sc.scrollHeight;
    didInitialScrollRef.current = true;
    prevCountRef.current = messages.length;
  }, [messages.length]);

  // Restore the reader's place once older history is in: however far the old first message was pushed
  // down by what landed above it, the box scrolls by that much, so it stays where it was read (and
  // by nothing when the browser already held it there). Only a real prepend (the first message changed)
  // moves it; a message arriving at the bottom meanwhile does not.
  const firstMessageId = messages[0]?.id;
  useLayoutEffect(() => {
    const anchor = prependAnchorRef.current;
    if (!anchor || firstMessageId === anchor.firstId) return;
    prependAnchorRef.current = null;
    justPrependedRef.current = true;
    if (anchor.row.isConnected) anchor.box.scrollTop += anchor.row.getBoundingClientRect().top - anchor.at;
  }, [firstMessageId]);

  // OLDER HISTORY LOADS WHEN THE TOP OF THE THREAD IS ON SCREEN — watched, not inferred from a `scroll`
  // event on the list (founder 2026-11-06: a member who joined a family chat saw «no history» — the
  // first page ended at her join and the older pages never came). A scroll listener on the list fires
  // only when THAT element moves: not when a host lets an ancestor scroll instead, not when the first
  // page is too short to scroll, not when the reader is already at the top and pulls further. The
  // observer has no root, so it sees the edge through whatever scrolls; it is rebuilt after every page
  // and every change of what is shown, and a fresh observer reports at once — so a page that still
  // leaves the edge in sight asks for the next one, until the screen is full or nothing older is left.
  useEffect(() => {
    const edge = historyEdgeRef.current;
    if (!edge || !hasMore || loadingHistory || typeof IntersectionObserver !== 'function') return;
    const observer = new IntersectionObserver((entries) => {
      if (!entries[entries.length - 1]?.isIntersecting) {
        askedFromRef.current = null;
        return;
      }
      // Asked from this very place already and nothing landed (the fetch failed, or the page came back
      // empty): wait until the reader scrolls away and back, or a failing server would be asked again
      // as fast as it answers.
      if (askedFromRef.current && askedFromRef.current.firstId === firstMessageId) return;
      askedFromRef.current = { firstId: firstMessageId };
      // One request per observer: the next one is built when this page has landed.
      observer.disconnect();
      const list = scrollRef.current;
      const row = threadRef.current?.firstElementChild;
      if (list && row) {
        const at = row.getBoundingClientRect().top;
        prependAnchorRef.current = { box: scrollingBox(list), row, at, firstId: firstMessageId };
      }
      loadMore();
    });
    observer.observe(edge);
    return () => observer.disconnect();
  }, [hasMore, loadingHistory, loadMore, firstMessageId, messages.length]);

  // Follow new messages to the bottom (only when already near bottom / own send).
  useEffect(() => {
    const wasPrepend = justPrependedRef.current;
    justPrependedRef.current = false;
    const grew = messages.length > prevCountRef.current;
    const last = messages[messages.length - 1];
    const ownLast = last ? last.senderId === currentPersonId : false;
    if (!wasPrepend && didInitialScrollRef.current && grew && (nearBottomRef.current || ownLast)) {
      const sc = scrollRef.current;
      // `scrollTo` is missing in some embedded webviews; a plain assignment is the same jump.
      if (sc) {
        if (typeof sc.scrollTo === 'function') sc.scrollTo({ top: sc.scrollHeight, behavior: 'smooth' });
        else sc.scrollTop = sc.scrollHeight;
      }
    }
    prevCountRef.current = messages.length;
  }, [messages, currentPersonId]);

  // Mark read up to the newest message the server holds, WHOEVER wrote it (a row still on its way has no
  // server time). Not only when it is someone else's: once I have replied, my line is the newest, and a
  // message before it that a read missed would otherwise stay unread on the server for good — a «1» on the
  // contact that opening the chat never clears (К3, 2026-11-20).
  useEffect(() => {
    const upTo = newestConfirmedAt(messages);
    if (upTo) markRead(upTo);
  }, [messages, markRead]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  }, []);

  const handleSend = useCallback(
    (text: string, images?: { dataUrl: string; mimeType: string }[]) => {
      if (intent?.mode === 'edit') {
        editMessage(intent.message.id, text);
        setIntent(null);
        return;
      }
      const opts = {
        ...(intent?.mode === 'reply' ? { replyToId: intent.message.id } : {}),
        ...(images?.length ? { images } : {}),
      };
      sendMessage(text, Object.keys(opts).length ? opts : undefined);
      setIntent(null);
    },
    [intent, editMessage, sendMessage],
  );

  // ArrowUp in an empty composer: the last own text message becomes the edit intent (nothing → nothing).
  const recallLast = useCallback(() => {
    const last = lastEditableOwn(messages, currentPersonId);
    if (last) setIntent({ mode: 'edit', message: last });
  }, [messages, currentPersonId]);

  // Esc anywhere in the composer drops the intent (the key bubbles up from the host's own input too).
  const handleComposerKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      // a handled Esc (the mention popover closing, ADR-199 §5) is not ours: the second Esc cancels the intent
      if (e.key !== 'Escape' || e.defaultPrevented || !intent) return;
      e.preventDefault();
      setIntent(null);
    },
    [intent],
  );

  // A tapped quote: bring the parent into view and let it glow for a moment.
  const scrollToMessage = useCallback((id: string) => {
    const sc = scrollRef.current;
    const row = sc?.querySelector<HTMLElement>(`[data-msg-id="${id}"]`);
    if (!row) return;
    if (typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    sc?.querySelectorAll(`.${FLASH_CLASS}`).forEach((el) => el.classList.remove(FLASH_CLASS));
    row.classList.add(FLASH_CLASS);
    flashTimerRef.current = setTimeout(() => row.classList.remove(FLASH_CLASS), REPLY_FLASH_MS);
  }, []);
  useEffect(() => () => {
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
  }, []);

  const isEditing = intent?.mode === 'edit';

  // A page the server thinned to nothing still has older ones behind it: that is a thread to page, not
  // an empty chat.
  const isEmpty = !loadingHistory && !hasMore && messages.length === 0;
  // The theme rides this root (the tokens may be `var(--host-token)` references the browser resolves
  // right here), and so does the one number the bubbles read.
  const rootStyle: CSSProperties = {
    ...themeStyle,
    ...(senderNameCh === undefined ? null : ({ '--msg-sender-name-ch': String(senderNameCh) } as CSSProperties)),
  };

  return (
    // `data-chat-pane`: «this is a chat pane» — the composer finds it (`closest`) and lets a file be dropped on the whole pane, not
    // only on the field (hub `chat-file-drop.tsx` owns the attribute; this package cannot import the hub, so the literal is repeated).
    <div className="hub-mchat" style={rootStyle} data-chat-pane="">
      {/* under the host's header, above the thread: nobody can scroll the guardian ribbon away */}
      <SecurityStrip conversationId={conversationId} />
      {banner}
      {/* the host's plate cuts its window where THIS scrolls (`env.scrollerAttrs`, one contract) */}
      <div
        className={`hub-mchat-msgs${isEmpty ? ' is-empty' : ''}`}
        ref={scrollRef}
        onScroll={handleScroll}
        {...env.scrollerAttrs}
      >
        {!isEmpty && <div className="hub-mchat-history-edge" ref={historyEdgeRef} aria-hidden />}

        {loadingHistory && (
          <div className="hub-mchat-loading">
            <Loader size="xs" />
          </div>
        )}

        {isEmpty && (
          <div className="hub-mchat-empty">
            <div className="hub-mchat-empty-art" aria-hidden>
              {isPrivate ? '🔒' : '✨'}
            </div>
            <Text size="sm" c="dimmed">
              {isPrivate ? t('chat.privateEmpty') : t('chat.startChat')}
            </Text>
          </div>
        )}

        {!isEmpty && (
          <div className="hub-mchat-inner" ref={threadRef}>
            {messages.map((msg, idx) => {
              const next = messages[idx + 1];
              const prev = messages[idx - 1];
              const isLastInGroup = !next || next.senderId !== msg.senderId;
              const isFirstInGroup = !prev || prev.senderId !== msg.senderId;
              const isOwn = msg.senderId === currentPersonId;
              if (renderServiceRow && msg.messageType === 'SYSTEM') {
                const row = renderServiceRow({ message: msg, isOwn });
                if (row !== undefined) return <Fragment key={msg.id}>{row}</Fragment>;
              }
              return (
                <Bubble
                  key={msg.id}
                  message={msg}
                  isOwn={isOwn}
                  currentPersonId={currentPersonId}
                  showSenderName={isGroup && isFirstInGroup && !isOwn}
                  showAvatar={isFirstInGroup && !isOwn}
                  sender={participantById.get(msg.senderId)}
                  isLastInGroup={isLastInGroup}
                  onReact={reactToMessage}
                  onReply={(m) => setIntent({ mode: 'reply', message: m })}
                  onEdit={(m) => setIntent({ mode: 'edit', message: m })}
                  onDelete={deleteMessage}
                  onReplyTap={scrollToMessage}
                  onImageOpen={(urls, index) => openGallery(msg.id, urls, index)}
                  mentionCandidates={mentions.all.length ? mentions.all : undefined}
                  viewerOnline={connected}
                  onRetrySend={retrySend}
                />
              );
            })}

            {typingIndicators.length > 0 && (
              <div className="hub-msg-row hub-msg-row--other">
                <div className="hub-msg hub-msg--other hub-msg--typing">
                  <span className="hub-typing-dot" />
                  <span className="hub-typing-dot" />
                  <span className="hub-typing-dot" />
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {composerBlock ? (
        // Nothing can be sent from here: the host says why where the composer would be.
        <div className="hub-mchat-compose hub-mchat-compose--blocked" data-composer-blocked="">
          {composerBlock}
        </div>
      ) : (
        <>
          {intent && <IntentStrip intent={intent} onCancel={cancelIntent} />}

          {/* An edit re-mounts the composer to seed the old text; a reply keeps the draft being typed. */}
          <div className="hub-mchat-compose" onKeyDown={handleComposerKeyDown}>
            <Composer
              key={isEditing ? `edit-${intent.message.id}` : 'compose'}
              onSend={handleSend}
              disabled={!connected}
              onTyping={sendTyping}
              allowImages={!isEditing}
              onStickers={isEditing ? undefined : onStickers}
              enableVoice={!isEditing}
              initialDraft={isEditing ? intent.message.text : undefined}
              onRecallLast={recallLast}
              mentionCandidates={mentions.forComposer.length ? mentions.forComposer : undefined}
            />
          </div>
        </>
      )}

      {gallery && (
        <Lightbox
          items={gallery.items}
          index={gallery.index}
          onIndexChange={pageGallery}
          onClose={closeGallery}
        />
      )}
    </div>
  );
}
