/**
 * The rows of a message's `⋮` menu, built in ONE place (internal ADR-199 §2): Reply · Copy · Edit ·
 * Delete, in that order. The package's `Bubble` uses it, and a host that draws its own bubble imports
 * it from `@masia/messenger/ui`, so the two menus cannot drift apart.
 *
 * Who gets which row: Reply for any message that is not deleted, whenever the caller can take a
 * reply; Copy for a message with text that is not a sticker; Edit for an own text message that is
 * not a sticker; Delete for an own message. A row whose handler is absent is not built.
 */
import type { ReactNode } from 'react';
import type { I18nBundle, MessengerIconName } from '@masia/contracts';
import { isUnconfirmedMessage } from '../../hooks/messenger-outbox.js';
import type { MessengerMessage } from '../../protocol/messages.js';
import type { MenuRow } from '../provider/slots.js';

export interface MessageActionRowsInput {
  readonly message: MessengerMessage;
  readonly isOwn: boolean;
  /** Whether a reply can be taken here at all (default: whenever `onReply` is given). */
  readonly canReply?: boolean;
  onReply?(message: MessengerMessage): void;
  onEdit?(message: MessengerMessage): void;
  onDelete?(id: string): void;
  /** Puts the message text on the clipboard (the caller owns the clipboard access). */
  copy(): void;
  readonly t: I18nBundle['t'];
  readonly icon: (name: MessengerIconName, size?: number) => ReactNode;
}

/** The glyph size of every row icon. */
const ROW_ICON_SIZE = 16;

/**
 * Can this message be answered? Not a deleted one, and not a turn the server has not confirmed (no server id to point the reply
 * at). The `⋮` menu's Reply row and the swipe both ask THIS, so a finger can never reply to what the menu would refuse.
 */
export function canReplyTo(message: MessengerMessage): boolean {
  return !message.deletedAt && !isUnconfirmedMessage(message);
}

/** True when the message has words a person could quote, copy or edit. */
export function hasEditableText(message: MessengerMessage): boolean {
  return !!message.text?.trim() && message.messageType !== 'STICKER';
}

export function messageActionRows({
  message,
  isOwn,
  canReply = true,
  onReply,
  onEdit,
  onDelete,
  copy,
  t,
  icon,
}: MessageActionRowsInput): MenuRow[] {
  const rows: MenuRow[] = [];
  if (message.deletedAt) return rows;
  const textual = hasEditableText(message);
  if (onReply && canReply) {
    // The cockpit family's `back` is a return arrow: the one mark that says «answer this».
    rows.push({ id: 'reply', label: t('chat.reply'), icon: icon('back', ROW_ICON_SIZE), onSelect: () => onReply(message) });
  }
  if (textual) rows.push({ id: 'copy', label: t('chat.copy'), icon: icon('copy', ROW_ICON_SIZE), onSelect: copy });
  if (isOwn && onEdit && textual) {
    rows.push({ id: 'edit', label: t('chat.edit'), icon: icon('edit', ROW_ICON_SIZE), onSelect: () => onEdit(message) });
  }
  if (isOwn && onDelete) {
    rows.push({
      id: 'delete',
      label: t('chat.delete'),
      icon: icon('trash', ROW_ICON_SIZE),
      destructive: true,
      onSelect: () => onDelete(message.id),
    });
  }
  return rows;
}
