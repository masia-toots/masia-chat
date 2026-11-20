/**
 * One message bubble: text, reply preview, pictures and documents, a sticker slot, reactions, the
 * edited mark and read ticks, and the per-message actions menu (react · reply · copy · edit · delete;
 * the rows come from `messageActionRows`, internal ADR-199 §2). On someone else's row the sender's
 * colour (internal ADR-199 §8) is ONE custom property, `--sender-color`, set on the row (the bubble and
 * the avatar beside it both inherit it): the sender name reads it, the 3 px left edge of the bubble is
 * drawn from it (never on a sticker, never on an own bubble), and the sender's picture — or an initial
 * on that colour — opens the first bubble of a run.
 *
 * Everything outside the bubble comes through the provider: words (`I18nBundle`), icons (`IconSet`),
 * media URLs (`MediaReader`), the sticker artwork (`RichAttachment`), the menu (a slot) and the
 * reaction emoji (`env.reactions`).
 */
import { useCallback, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { ActionIcon, Text } from '@mantine/core';
import type { RichAttachment } from '@masia/contracts';
import { isUnconfirmedMessage } from '../../hooks/messenger-outbox.js';
import type { MessengerMessage } from '../../protocol/messages.js';
import { useIcon, useMessengerUi, useT } from '../provider/messenger-ui.js';
import type { MenuSection, MentionCandidate, Participant } from '../provider/slots.js';
import { messageActionRows } from './message-actions.js';
import { attachmentIdsOf, documentLabelOf, picturesOf } from './message-pictures.js';
import { openMedia } from './open-media.js';
import { renderMessageText } from './render-mentions.js';
import { IMAGE_ONLY_PLACEHOLDER } from './reply-preview.js';
import { STICKER_ATTACHMENT_KIND, type StickerAttachmentPayload } from './sticker-attachment.js';
import { UnsentRow } from './unsent-row.js';
import { useMediaSrcs } from './use-media-srcs.js';
import './messenger-chat-view.css';

/** A message's time as the thread shows it — the one format, also for a host's own rows (`renderServiceRow`). */
export function formatMessageTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/**
 * The host draws the sticker; a host that does not know the kind gets a plain word instead.
 * A plain function, not a component, on purpose: the node the host returns keeps its own identity
 * across renders, so its state (a sound that plays once) survives a re-render of the bubble.
 */
function drawSticker(attachments: RichAttachment, payload: StickerAttachmentPayload, placeholder: string): ReactNode {
  if (attachments.kinds.includes(STICKER_ATTACHMENT_KIND)) {
    const drawn = attachments.render(STICKER_ATTACHMENT_KIND, payload) as ReactNode;
    if (drawn !== null && drawn !== undefined) return drawn;
  }
  return <span className="hub-msg-sticker-placeholder">{placeholder}</span>;
}

/** The custom property the sender's colour travels on (set on the row); the CSS reads it for the name, the edge and the initial. */
export const SENDER_COLOR_VAR = '--sender-color';

/** The sender's picture, or their initial on their colour. Decorative: the name row (or the header) says who. */
function SenderAvatar({ sender }: { sender: Participant }) {
  const initial = sender.name.trim().charAt(0).toUpperCase();
  return (
    <span className="hub-msg-avatar" aria-hidden>
      {sender.avatarUrl ? <img src={sender.avatarUrl} alt="" /> : initial}
    </span>
  );
}

function CheckMark({ status }: { status: string | null }) {
  if (status === 'READ') return <span className="hub-msg-check hub-msg-check--read">✓✓</span>;
  if (status === 'DELIVERED') return <span className="hub-msg-check hub-msg-check--double">✓✓</span>;
  return <span className="hub-msg-check">✓</span>;
}

export interface BubbleProps {
  message: MessengerMessage;
  isOwn: boolean;
  currentPersonId: string;
  showSenderName: boolean;
  /**
   * The first bubble of someone else's run (ADR-199 §8): draws the sender's picture or initial at the
   * left when `sender` is known. Later bubbles of the run keep the column empty so the text lines up.
   */
  showAvatar?: boolean;
  /** The sender as the host knows them (picture, colour); absent: no avatar column, theme colours. */
  sender?: Participant;
  isLastInGroup: boolean;
  onReact?: (id: string, emoji: string) => void;
  /** «Reply» was chosen: the view opens the reply intent on this message. Absent: no Reply row. */
  onReply?: (m: MessengerMessage) => void;
  onEdit?: (m: MessengerMessage) => void;
  onDelete?: (id: string) => void;
  /** The reply quote was tapped: the view scrolls to the parent (`replyToId`). Absent: the quote is static. */
  onReplyTap?: (parentId: string) => void;
  /**
   * A picture of this message was tapped: `urls` are all of THIS message's pictures as the bubble drew them,
   * `index` the tapped one. The view opens its one viewer on it and pages on over the rest of the thread.
   */
  onImageOpen: (urls: readonly string[], index: number) => void;
  /** Whose `@tag` is drawn as a chip in the text (ADR-199 §5); absent: the text is plain. */
  mentionCandidates?: readonly MentionCandidate[];
  /** I am online now (the host's socket state): the `@online` chip is «about me» only then (ADR-201). */
  viewerOnline?: boolean;
  /**
   * This message of mine never left (`MessengerMessage.sendFailed`) and the view can send it again:
   * the bubble says so and offers the retry (and, with `onDelete`, a Delete that lets it go). Absent:
   * a failed row still says so, without a retry.
   */
  onRetrySend?: (id: string) => void;
}

export function Bubble({
  message,
  isOwn,
  currentPersonId,
  showSenderName,
  showAvatar,
  sender,
  isLastInGroup,
  onReact,
  onReply,
  onEdit,
  onDelete,
  onReplyTap,
  onImageOpen,
  mentionCandidates,
  viewerOnline,
  onRetrySend,
}: BubbleProps) {
  const t = useT();
  const icon = useIcon();
  const { slots, env, media, attachments } = useMessengerUi();
  const Menu = slots.Menu;
  const side = isOwn ? 'own' : 'other';

  const reactionGroups = useMemo(() => {
    const map = new Map<string, { count: number; mine: boolean }>();
    for (const r of message.reactions ?? []) {
      const e = map.get(r.reaction) ?? { count: 0, mine: false };
      e.count += 1;
      if (r.personId === currentPersonId) e.mine = true;
      map.set(r.reaction, e);
    }
    return [...map.entries()];
  }, [message.reactions, currentPersonId]);

  const copy = useCallback(() => {
    void navigator.clipboard?.writeText(message.text ?? '').catch(() => undefined);
  }, [message.text]);

  const isSticker = message.messageType === 'STICKER';
  // Someone else's bubble carries its sender's colour; an own bubble never does (the theme colours it).
  const senderColor = !isOwn ? sender?.color : undefined;
  const rowStyle = senderColor ? ({ [SENDER_COLOR_VAR]: senderColor } as CSSProperties) : undefined;
  const avatarColumn = !isOwn && sender ? (showAvatar ? <SenderAvatar sender={sender} /> : <span className="hub-msg-avatar-gap" aria-hidden />) : null;

  const actionsRef = useRef<HTMLButtonElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const closeMenu = useCallback(() => setMenuOpen(false), []);

  // Persisted attachments (not the sticker): the host may serve them behind its own auth, so the
  // displayable URL comes from the media reader. A hook, so it sits above the deleted early return.
  const persistedIds = attachmentIdsOf(message);
  const persistedSrcs = useMediaSrcs(media, persistedIds);

  if (message.deletedAt) {
    return (
      <div className={`hub-msg-row hub-msg-row--${side}`} data-msg-id={message.id} style={rowStyle}>
        {avatarColumn}
        <div className={`hub-msg hub-msg--${side}${isLastInGroup ? ' hub-msg--tail' : ''} hub-msg--deleted`}>
          <span>{t('chat.deletedPreview')}</span>
        </div>
      </div>
    );
  }

  const stickerRaw = isSticker ? (message.mediaUrl ?? message.mediaUrls?.[0] ?? '') : '';
  // A row the server has not confirmed (on its way, or not sent) has no server id: its menu is Copy
  // only, no reactions. Discarding a "not sent" row is the Delete beside its Retry, not a menu row.
  const unconfirmed = isUnconfirmedMessage(message);
  const actionRows = messageActionRows(
    unconfirmed
      ? { message, isOwn, copy, t, icon }
      : { message, isOwn, onReply, onEdit, onDelete, copy, t, icon },
  );
  const react = unconfirmed ? undefined : onReact;
  const hasMenu = !!react || actionRows.length > 0;
  const menuSections: MenuSection[] = [];
  if (react) {
    menuSections.push({
      id: 'react',
      rows: [],
      content: (
        <div className="hub-react-bar" role="group" aria-label={t('chat.react')}>
          {env.reactions.map((e) => (
            <button
              key={e}
              type="button"
              className="hub-react-emoji"
              onClick={() => {
                react(message.id, e);
                closeMenu();
              }}
            >
              {e}
            </button>
          ))}
        </div>
      ),
    });
  }
  if (actionRows.length) menuSections.push({ id: 'actions', rows: actionRows });
  // The pictures this bubble draws — whichever row renders (inline base64 wins), documents excluded. The
  // viewer opens on one of them and pages on over the rest of the thread (`usePictureGallery`).
  const imageUrls = picturesOf(message, persistedSrcs);
  // A picture is a DOOR into the viewer: a button (keyboard, a name) that wraps the thumbnail and nothing else.
  // `at` counts the pictures drawn so far, so two identical srcs in one message still open their own place.
  let drawn = 0;
  const pictureDoor = (src: string, key: number): ReactNode => {
    const at = drawn++;
    return (
      <button
        key={key}
        type="button"
        className="hub-msg-image-open"
        aria-label={t('chat.openImage', { n: at + 1 })}
        onClick={() => onImageOpen(imageUrls, at)}
      >
        <img src={src} alt="" />
      </button>
    );
  };

  // The quote is a control only when the view can scroll to the parent (Enter and Space act as a tap).
  const parentId = message.replyToId;
  const tapReply = onReplyTap && parentId ? () => onReplyTap(parentId) : undefined;
  const replyControl = tapReply
    ? {
        role: 'button',
        tabIndex: 0,
        onClick: tapReply,
        onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          e.preventDefault();
          tapReply();
        },
      }
    : {};

  return (
    <div className={`hub-msg-row hub-msg-row--${side}`} data-msg-id={message.id} style={rowStyle}>
      {avatarColumn}
      <div
        className={`hub-msg hub-msg--${side}${isLastInGroup ? ' hub-msg--tail' : ''}${isSticker ? ' hub-msg--sticker' : ''}${senderColor && !isSticker ? ' hub-msg--edged' : ''}`}
      >
        {showSenderName && <div className="hub-msg-sender">{message.senderName}</div>}

        {message.replyToPreview && (
          <div className={`hub-msg-reply${tapReply ? ' hub-msg-reply--tap' : ''}`} {...replyControl}>
            <span className="hub-msg-reply-who">{message.replyToPreview.senderName}</span>
            <span className={`hub-msg-reply-text${message.replyToPreview.deleted ? ' hub-msg-reply-text--deleted' : ''}`}>
              {message.replyToPreview.deleted ? t('chat.replyDeleted') : message.replyToPreview.text}
            </span>
          </div>
        )}

        {isSticker && stickerRaw && drawSticker(attachments, { text: message.text, mediaUrl: stickerRaw, isOwn }, t('chat.sticker'))}

        {!isSticker && message.images && message.images.length > 0 && (
          <div className="hub-msg-images">
            {message.images.map((img, i) =>
              img.mimeType.startsWith('image/') ? (
                pictureDoor(img.dataUrl, i)
              ) : (
                <div key={i} className="hub-chat-doc-chip hub-chat-doc-chip--bubble">
                  <Text size="xs" fw={600} tt="uppercase">
                    {img.mimeType.includes('pdf') ? 'PDF' : 'DOCX'}
                  </Text>
                </div>
              ),
            )}
          </div>
        )}
        {!isSticker && (!message.images || message.images.length === 0) && persistedIds.length > 0 && (
          <div className="hub-msg-images">
            {persistedIds.map((id, i) => {
              const docLabel = documentLabelOf(id);
              return docLabel ? (
                // A document the host serves behind its own auth cannot be a plain link: the click
                // goes through the media reader, which knows how to fetch it.
                <a
                  key={i}
                  href={media.peek(id) ?? id}
                  target="_blank"
                  rel="noreferrer"
                  className="hub-chat-doc-chip hub-chat-doc-chip--bubble"
                  onClick={(e) => {
                    e.preventDefault();
                    openMedia(media, id);
                  }}
                >
                  <Text size="xs" fw={600} tt="uppercase">
                    {docLabel}
                  </Text>
                </a>
              ) : persistedSrcs[i] ? (
                pictureDoor(persistedSrcs[i] as string, i)
              ) : (
                // Still on its way — hold its place, never `<img src="">`.
                <span key={i} className="hub-msg-image-pending" aria-busy="true" />
              );
            })}
          </div>
        )}

        {!isSticker && message.text && message.text !== IMAGE_ONLY_PLACEHOLDER && (
          <div className="hub-msg-text">
            {renderMessageText(message.modified?.text ?? message.text, mentionCandidates, currentPersonId, viewerOnline)}
          </div>
        )}

        <div className="hub-msg-meta">
          {message.editedAt && <span className="hub-msg-edited">{t('chat.edited')}</span>}
          <span>{formatMessageTime(message.createdAt)}</span>
          {isOwn && !message.sendFailed && <CheckMark status={message.deliveryStatus} />}
        </div>

        {/* It never left: the words stay on screen; the person sends them again or lets them go. */}
        {message.sendFailed && (
          <UnsentRow messageId={message.id} onRetrySend={onRetrySend} onDelete={isOwn ? onDelete : undefined} />
        )}

        {reactionGroups.length > 0 && (
          <div className="hub-msg-reactions">
            {reactionGroups.map(([emoji, { count, mine }]) => (
              <button
                key={emoji}
                type="button"
                className={`hub-msg-react-pill${mine ? ' is-mine' : ''}`}
                onClick={() => onReact?.(message.id, emoji)}
              >
                {emoji}
                {count > 1 ? ` ${count}` : ''}
              </button>
            ))}
          </div>
        )}
      </div>

      {hasMenu && (
        <>
          <ActionIcon
            ref={actionsRef}
            className="hub-msg-actions"
            size="lg"
            variant="subtle"
            color="gray"
            aria-label={t('chat.messageActions')}
            aria-haspopup="true"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((o) => !o)}
          >
            {icon('more', 15)}
          </ActionIcon>
          <Menu
            open={menuOpen}
            onClose={closeMenu}
            anchorRef={actionsRef}
            label={t('chat.messageActions')}
            closeLabel={t('chat.messageActionsClose')}
            sections={menuSections}
            name="message"
          />
        </>
      )}
    </div>
  );
}
