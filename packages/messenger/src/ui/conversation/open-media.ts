/**
 * Opens a stored media item (a PDF chip) in a new tab.
 *
 * Why the blank tab first: a popup opened after an await is blocked by the browser, so when the URL
 * is not known yet the tab is opened synchronously inside the click and pointed at the URL once the
 * host resolves it. A URL the host already has (`peek`) opens directly, without the opener.
 */
import type { MediaReader } from '@masia/contracts';

export function openMedia(media: MediaReader, id: string): void {
  const known = media.peek(id);
  if (known !== undefined) {
    window.open(known, '_blank', 'noopener,noreferrer');
    return;
  }
  const tab = window.open('', '_blank');
  media.resolve(id).then(
    (src) => {
      if (tab) tab.location.href = src;
      else window.open(src, '_blank');
    },
    // Nothing to show: do not leave an empty tab behind.
    () => tab?.close(),
  );
}
