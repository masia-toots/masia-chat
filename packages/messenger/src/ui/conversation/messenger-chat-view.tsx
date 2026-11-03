/**
 * MessengerChatView — the messenger-native chat renderer (P2P), styled to the messenger mockup and
 * driven by `useMessenger`: them/me bubbles with tails, group sender labels, reply previews,
 * stickers (the host draws them), inline + persisted images (paged in the host's gallery), reactions
 * (pills + a picker), edit, delete, typing indicators, read-receipt checkmarks, and load-more
 * history. The composer is the host's (the `Composer` slot) or the package's own slim one.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { Loader, Text } from '@mantine/core';
import type { UseMessengerReturn } from '../../hooks/use-messenger.js';
import { Composer as SlimComposer } from '../composer/composer.js';
import { useIcon, useMessengerUi, useT } from '../provider/messenger-ui.js';
import type { LightboxItem } from '../provider/slots.js';
import { SecurityStrip } from '../security/security-strip.js';
import { Bubble } from './bubble.js';
import './messenger-chat-view.css';

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
}: MessengerChatViewProps) {
  const t = useT();
  const icon = useIcon();
  const { slots, env, themeStyle } = useMessengerUi();
  const Composer = slots.Composer ?? SlimComposer;
  const Lightbox = slots.Lightbox;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const didInitialScrollRef = useRef(false);
  const nearBottomRef = useRef(true);
  const prevCountRef = useRef(0);
  const prependAnchorRef = useRef<{ height: number; top: number } | null>(null);
  const justPrependedRef = useRef(false);
  // The host's gallery, over every picture of the tapped message (it pages, swipes and zooms).
  const [gallery, setGallery] = useState<{ items: LightboxItem[]; index: number } | null>(null);
  const openGallery = useCallback(
    (urls: readonly string[], index: number) => setGallery({ items: urls.map((src) => ({ src, alt: '' })), index }),
    [],
  );
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);

  const {
    messages,
    connected,
    typingIndicators,
    sendMessage,
    sendTyping,
    markRead,
    deleteMessage,
    editMessage,
    reactToMessage,
    loadMore,
    hasMore,
    loadingHistory,
  } = messenger;

  // Initial jump to bottom (instant, pre-paint), once per conversation.
  useLayoutEffect(() => {
    if (didInitialScrollRef.current || messages.length === 0) return;
    const sc = scrollRef.current;
    if (!sc) return;
    sc.scrollTop = sc.scrollHeight;
    didInitialScrollRef.current = true;
    prevCountRef.current = messages.length;
  }, [messages.length]);

  // Restore position after older history prepends.
  useLayoutEffect(() => {
    const anchor = prependAnchorRef.current;
    if (!anchor) return;
    prependAnchorRef.current = null;
    const sc = scrollRef.current;
    if (sc) sc.scrollTop = sc.scrollHeight - anchor.height + anchor.top;
    justPrependedRef.current = true;
  }, [messages.length]);

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

  // Mark read when the last message is from someone else.
  useEffect(() => {
    if (!messages.length) return;
    const last = messages[messages.length - 1];
    if (last && last.senderId !== currentPersonId) markRead(last.createdAt);
  }, [messages, currentPersonId, markRead]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (!hasMore || loadingHistory) return;
    if (el.scrollTop < 50) {
      prependAnchorRef.current = { height: el.scrollHeight, top: el.scrollTop };
      loadMore();
    }
  }, [hasMore, loadingHistory, loadMore]);

  const handleSend = useCallback(
    (text: string, images?: { dataUrl: string; mimeType: string }[]) => {
      if (editing) {
        editMessage(editing.id, text);
        setEditing(null);
        return;
      }
      sendMessage(text, images?.length ? { images } : undefined);
    },
    [editing, editMessage, sendMessage],
  );

  const isEmpty = !loadingHistory && messages.length === 0;
  // The theme rides this root (the tokens may be `var(--host-token)` references the browser resolves
  // right here), and so does the one number the bubbles read.
  const rootStyle: CSSProperties = {
    ...themeStyle,
    ...(senderNameCh === undefined ? null : ({ '--msg-sender-name-ch': String(senderNameCh) } as CSSProperties)),
  };

  return (
    <div className="hub-mchat" style={rootStyle}>
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
          <div className="hub-mchat-inner">
            {messages.map((msg, idx) => {
              const next = messages[idx + 1];
              const prev = messages[idx - 1];
              const isLastInGroup = !next || next.senderId !== msg.senderId;
              const isFirstInGroup = !prev || prev.senderId !== msg.senderId;
              const isOwn = msg.senderId === currentPersonId;
              return (
                <Bubble
                  key={msg.id}
                  message={msg}
                  isOwn={isOwn}
                  currentPersonId={currentPersonId}
                  showSenderName={isGroup && isFirstInGroup && !isOwn}
                  isLastInGroup={isLastInGroup}
                  onReact={reactToMessage}
                  onEdit={(m) => setEditing({ id: m.id, text: m.text ?? '' })}
                  onDelete={deleteMessage}
                  onImageOpen={openGallery}
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

      {editing && (
        <div className="hub-mchat-editing">
          <span>
            {icon('mood', 13)} {t('chat.editingMessage')}
          </span>
          <button type="button" onClick={() => setEditing(null)} aria-label={t('common.cancel')}>
            ✕
          </button>
        </div>
      )}

      <Composer
        key={editing ? `edit-${editing.id}` : 'compose'}
        onSend={handleSend}
        disabled={!connected}
        onTyping={sendTyping}
        allowImages={!editing}
        onStickers={editing ? undefined : onStickers}
        enableVoice={!editing}
        initialDraft={editing ? editing.text : undefined}
      />

      {gallery && (
        <Lightbox
          items={gallery.items}
          index={gallery.index}
          onIndexChange={(index) => setGallery((g) => (g ? { ...g, index } : g))}
          onClose={() => setGallery(null)}
        />
      )}
    </div>
  );
}
