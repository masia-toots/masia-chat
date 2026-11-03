/**
 * A stored media blob: the id the message refers to and a URL it can be fetched from.
 *
 * Why: the message carries the id; where the bytes live (object storage, a CDN, a local cache) is
 * the host's business.
 */
export interface UploadedMedia {
  readonly url: string;
  readonly id: string;
}

/**
 * Uploads media and turns a media id back into something displayable.
 *
 * Why: the messenger must not know about the host's storage or its media encryption envelope.
 * It hands over bytes and gets an id; later it asks for the URL by id.
 */
export interface MediaUpload {
  upload(bytes: Uint8Array, mime: string): Promise<UploadedMedia>;
  /** Resolves the URL for `id`; rejects when the id is unknown. */
  resolve(id: string): Promise<string>;
  /**
   * The URL for `id` RIGHT NOW, or `undefined` when it is not known yet (it would need `resolve`).
   *
   * Why: a chat scrolled back and forth re-renders pictures it has already shown. Asking `resolve`
   * would put a placeholder on each for a tick; `peek` lets the first paint use what the host has
   * cached. It also lets a click open a document in a new tab without awaiting (a popup opened
   * after an await is blocked).
   */
  peek(id: string): string | undefined;
}

/**
 * The reading half of `MediaUpload`: what a screen that only DISPLAYS media needs. The UI asks for
 * this, so a host that does not support uploading from the UI is not forced to invent `upload`.
 */
export type MediaReader = Pick<MediaUpload, 'resolve' | 'peek'>;
