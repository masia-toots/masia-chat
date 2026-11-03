/**
 * One message bubble: text, reply preview, pictures and documents, a sticker slot, reactions, the
 * edited mark and read ticks, and the per-message actions menu (react · copy · edit · delete).
 *
 * Everything outside the bubble comes through the provider: words (`I18nBundle`), icons (`IconSet`),
 * media URLs (`MediaReader`), the sticker artwork (`RichAttachment`), the menu (a slot) and the
 * reaction emoji (`env.reactions`).
 */
import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { ActionIcon, Text } from '@mantine/core';
import type { RichAttachment } from '@masia/contracts';
import type { MessengerMessage } from '../../protocol/messages.js';
import { useIcon, useMessengerUi, useT } from '../provider/messenger-ui.js';
import type { MenuRow, MenuSection } from '../provider/slots.js';
import { openMedia } from './open-media.js';
import { STICKER_ATTACHMENT_KIND, type StickerAttachmentPayload } from './sticker-attachment.js';
import { useMediaSrcs } from './use-media-srcs.js';
import './messenger-chat-view.css';

/** PDF/DOCX Phase 0 (2026-07-24): the same doc/image split as the assistant's bubble. */
function docLabelFor(url: string): string | null {
  const lower = url.toLowerCase();
  if (lower.endsWith('.pdf')) return 'PDF';
  if (lower.endsWith('.docx')) return 'DOCX';
  return null;
}

function formatTime(iso: string): string {
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
  isLastInGroup: boolean;
  onReact?: (id: string, emoji: string) => void;
  onEdit?: (m: MessengerMessage) => void;
  onDelete?: (id: string) => void;
  /** A picture of this message was tapped: page ALL its pictures, starting at `index`. */
  onImageOpen: (urls: readonly string[], index: number) => void;
}

export function Bubble({
  message,
  isOwn,
  currentPersonId,
  showSenderName,
  isLastInGroup,
  onReact,
  onEdit,
  onDelete,
  onImageOpen,
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

  const actionsRef = useRef<HTMLButtonElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const closeMenu = useCallback(() => setMenuOpen(false), []);

  // Persisted attachments (not the sticker): the host may serve them behind its own auth, so the
  // displayable URL comes from the media reader. A hook, so it sits above the deleted early return.
  const persistedIds = isSticker
    ? []
    : message.mediaUrls?.length
      ? message.mediaUrls
      : message.mediaUrl
        ? [message.mediaUrl]
        : [];
  const persistedSrcs = useMediaSrcs(media, persistedIds);

  if (message.deletedAt) {
    return (
      <div className={`hub-msg hub-msg--${side}${isLastInGroup ? ' hub-msg--tail' : ''} hub-msg--deleted`}>
        <span>{t('chat.deletedPreview')}</span>
      </div>
    );
  }

  const stickerRaw = isSticker ? (message.mediaUrl ?? message.mediaUrls?.[0] ?? '') : '';
  const canEdit = isOwn && !!onEdit && !!message.text?.trim() && !isSticker;
  const canDelete = isOwn && !!onDelete;
  const canCopy = !!message.text?.trim() && !isSticker;
  const hasMenu = !!onReact || canEdit || canDelete || canCopy;
  const menuSections: MenuSection[] = [];
  if (onReact) {
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
                onReact(message.id, e);
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
  const actionRows: MenuRow[] = [];
  if (canCopy) actionRows.push({ id: 'copy', label: t('chat.copy'), icon: icon('copy', 16), onSelect: copy });
  if (canEdit) {
    actionRows.push({ id: 'edit', label: t('chat.edit'), icon: icon('edit', 16), onSelect: () => onEdit?.(message) });
  }
  if (canDelete) {
    actionRows.push({
      id: 'delete',
      label: t('chat.delete'),
      icon: icon('trash', 16),
      destructive: true,
      onSelect: () => onDelete?.(message.id),
    });
  }
  if (actionRows.length) menuSections.push({ id: 'actions', rows: actionRows });
  // The pictures the gallery pages — whichever row renders (inline base64 wins), documents excluded.
  const imageUrls = message.images?.length
    ? message.images.filter((img) => img.mimeType.startsWith('image/')).map((img) => img.dataUrl)
    : persistedIds.flatMap((id, i) => (!docLabelFor(id) && persistedSrcs[i] ? [persistedSrcs[i] as string] : []));
  const openImage = (src: string): void => onImageOpen(imageUrls, Math.max(0, imageUrls.indexOf(src)));

  return (
    <div className={`hub-msg-row hub-msg-row--${side}`}>
      <div
        className={`hub-msg hub-msg--${side}${isLastInGroup ? ' hub-msg--tail' : ''}${isSticker ? ' hub-msg--sticker' : ''}`}
      >
        {showSenderName && <div className="hub-msg-sender">{message.senderName}</div>}

        {message.replyToPreview && (
          <div className="hub-msg-reply">
            <span className="hub-msg-reply-who">{message.replyToPreview.senderName}</span>
            <span className="hub-msg-reply-text">{message.replyToPreview.text}</span>
          </div>
        )}

        {isSticker && stickerRaw && drawSticker(attachments, { text: message.text, mediaUrl: stickerRaw, isOwn }, t('chat.sticker'))}

        {!isSticker && message.images && message.images.length > 0 && (
          <div className="hub-msg-images">
            {message.images.map((img, i) =>
              img.mimeType.startsWith('image/') ? (
                <img key={i} src={img.dataUrl} alt="" onClick={() => openImage(img.dataUrl)} />
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
              const docLabel = docLabelFor(id);
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
                <img key={i} src={persistedSrcs[i]} alt="" onClick={() => openImage(persistedSrcs[i] as string)} />
              ) : (
                // Still on its way — hold its place, never `<img src="">`.
                <span key={i} className="hub-msg-image-pending" aria-busy="true" />
              );
            })}
          </div>
        )}

        {!isSticker && message.text && message.text !== '(image)' && (
          <div className="hub-msg-text">{message.modified?.text ?? message.text}</div>
        )}

        <div className="hub-msg-meta">
          {message.editedAt && <span className="hub-msg-edited">{t('chat.edited')}</span>}
          <span>{formatTime(message.createdAt)}</span>
          {isOwn && <CheckMark status={message.deliveryStatus} />}
        </div>

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
