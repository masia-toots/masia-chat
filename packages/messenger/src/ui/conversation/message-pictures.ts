/**
 * The pictures of a conversation — ONE rule for both chats (the messenger's bubble and the assistant's
 * bubble), so a picture means the same thing wherever it is tapped, and the viewer pages the same list.
 *
 * Two things live here and nowhere else: what counts as a message's PICTURES (a document is not one;
 * an inline photo wins over its saved copy; a sticker has none; a deleted message shows none), and how
 * the pictures of the WHOLE loaded thread line up so the viewer can page from one message to the next
 * (`pageAround`). The rows of both chats carry the same fields, so the rule reads them structurally —
 * the package never imports the host's message type.
 */
import type { LightboxItem } from '../provider/slots.js';

/** What the rule reads of a message; the messenger's row and the assistant's row both have these. */
export interface PictureBearer {
  readonly id: string;
  readonly messageType?: string | null;
  readonly deletedAt?: string | null;
  /** Inline photos: the optimistic render, and what a vision turn was sent with. */
  readonly images?: readonly { readonly dataUrl: string; readonly mimeType: string }[] | null;
  /** The saved attachments (`mediaUrl` mirrors the first). Pictures and documents share this list. */
  readonly mediaUrl?: string | null;
  readonly mediaUrls?: readonly string[] | null;
}

/** A document is told from a picture by the extension its saved object was named with (`<uuid>.pdf`). */
export function documentLabelOf(id: string): 'PDF' | 'DOCX' | null {
  const lower = id.toLowerCase();
  if (lower.endsWith('.pdf')) return 'PDF';
  if (lower.endsWith('.docx')) return 'DOCX';
  return null;
}

/** The ids of a message's SAVED attachments, pictures and documents alike (a sticker has none: it is drawn by the host). */
export function attachmentIdsOf(message: PictureBearer): readonly string[] {
  if (message.messageType === 'STICKER') return [];
  if (message.mediaUrls?.length) return message.mediaUrls;
  return message.mediaUrl ? [message.mediaUrl] : [];
}

/**
 * The pictures of one message, as displayable srcs, in order. `srcs` lines up with `attachmentIdsOf`
 * (what `useMediaSrcs` and `useUploadSrcs` return): `''` is a picture still on its way, and it is left
 * out until it arrives. Inline photos win over the saved copies; documents are never pictures.
 */
export function picturesOf(message: PictureBearer, srcs: readonly string[]): string[] {
  if (message.deletedAt) return [];
  if (message.images?.length) {
    return message.images.filter((img) => img.mimeType.startsWith('image/')).map((img) => img.dataUrl);
  }
  return attachmentIdsOf(message).flatMap((id, i) => (!documentLabelOf(id) && srcs[i] ? [srcs[i] as string] : []));
}

/** What the viewer is opened on: every picture of the loaded thread, and the one that was tapped. */
export interface PictureGallery {
  /** Not `readonly`: the viewer slot takes a plain array. Never mutated after `pageAround` returns it. */
  readonly items: LightboxItem[];
  readonly index: number;
}

/** Where the person tapped: the message, that message's own pictures as its bubble drew them, and which one. */
export interface PictureTap {
  readonly messageId: string;
  readonly urls: readonly string[];
  readonly index: number;
}

/**
 * The viewer's pages: the pictures of every message of `messages` in thread order, opened on the tapped
 * one. The tapped message contributes the pictures its own bubble drew (they are what is on screen, even
 * if the host has since let go of a cached copy); every other message contributes what the host has
 * ready now (`peek`) — a picture no bubble has resolved yet is simply not a page. A tap on a message the
 * list does not hold pages that message alone.
 */
export function pageAround(
  messages: readonly PictureBearer[],
  peek: (id: string) => string | undefined,
  tap: PictureTap,
): PictureGallery {
  const items: LightboxItem[] = [];
  let index: number | null = null;
  for (const message of messages) {
    const own = message.id === tap.messageId;
    const urls = own ? tap.urls : picturesOf(message, attachmentIdsOf(message).map((id) => peek(id) ?? ''));
    if (own) index = items.length + Math.min(Math.max(tap.index, 0), Math.max(urls.length - 1, 0));
    for (const src of urls) items.push({ src, alt: '' });
  }
  if (index === null) return { items: tap.urls.map((src) => ({ src, alt: '' })), index: Math.max(tap.index, 0) };
  return { items, index };
}
