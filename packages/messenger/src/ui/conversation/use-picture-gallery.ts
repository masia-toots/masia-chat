/**
 * The viewer's state for one conversation view: closed, or open on a page of the thread's pictures.
 *
 * A view owns exactly one (so a chat has ONE viewer, however many bubbles it draws) and hands `open` to
 * its bubbles. `open` is stable across renders — a bubble that is `memo` keeps its bail-out — and reads
 * the thread as it is at the moment of the tap. The pages are a snapshot taken then: a message that
 * lands while the viewer is open does not shift the picture under the reader's thumb.
 */
import { useCallback, useRef, useState } from 'react';
import { pageAround, type PictureBearer, type PictureGallery, type PictureTap } from './message-pictures.js';

export interface UsePictureGalleryReturn {
  /** The open viewer's pages and current page; `null` while it is closed. */
  readonly gallery: PictureGallery | null;
  /** A picture was tapped: open the viewer on it, paging over the whole thread. */
  readonly open: (messageId: string, urls: readonly string[], index: number) => void;
  /** The viewer moved to page `index`. */
  readonly page: (index: number) => void;
  readonly close: () => void;
}

export function usePictureGallery(
  messages: readonly PictureBearer[],
  /** The host's displayable src for a saved attachment, if it has one ready (`MediaReader.peek`). */
  peek: (id: string) => string | undefined,
): UsePictureGalleryReturn {
  const [gallery, setGallery] = useState<PictureGallery | null>(null);
  const messagesRef = useRef(messages);
  const peekRef = useRef(peek);
  messagesRef.current = messages;
  peekRef.current = peek;

  const open = useCallback((messageId: string, urls: readonly string[], index: number) => {
    const tap: PictureTap = { messageId, urls, index };
    setGallery(pageAround(messagesRef.current, peekRef.current, tap));
  }, []);
  const page = useCallback((index: number) => setGallery((g) => (g ? { ...g, index } : g)), []);
  const close = useCallback(() => setGallery(null), []);

  return { gallery, open, page, close };
}
