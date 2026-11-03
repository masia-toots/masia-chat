/**
 * Host-defined message attachments the messenger can show but does not own (stickers, cards).
 *
 * Why: stickers belong to the host's world, not to the open messenger, so the messenger exposes a
 * render slot instead of a sticker engine. `kinds` lists what this host can draw; `render` returns
 * the node for a kind, or `null` for a kind the host does not know (the messenger then shows a
 * plain placeholder). The return type is `unknown` to keep this package free of UI-framework types.
 */
export interface RichAttachment {
  readonly kinds: readonly string[];
  render(kind: string, payload: unknown): unknown;
}
