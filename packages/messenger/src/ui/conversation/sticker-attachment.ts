/**
 * The contract between a conversation and the host that draws its stickers.
 *
 * Why: a sticker is the host's artwork, motion and sound, not the messenger's. The conversation
 * only knows THAT a message is a sticker; it asks the host's `RichAttachment` to draw it, handing
 * over this payload. A host that does not list the kind (or returns nothing) gets a plain text
 * placeholder, so a conversation never shows an empty bubble.
 */

/** The `RichAttachment` kind the conversation asks for. */
export const STICKER_ATTACHMENT_KIND = 'sticker';

export interface StickerAttachmentPayload {
  /** The message text; in the current wire it carries the sticker's motion and sound presets. */
  readonly text: string;
  /** The sticker image exactly as the message carries it (the host resolves it to a URL). */
  readonly mediaUrl: string;
  /** Your own message: a received sticker may play its sound once, a sent one does not. */
  readonly isOwn: boolean;
}
