import type { RichAttachment } from '../ports/rich-attachment.js';

export const FAKE_ATTACHMENT_KIND = 'fake-sticker';

/** What the fake "draws" for a kind it owns. */
export interface FakeAttachmentNode {
  readonly kind: string;
  readonly payload: unknown;
}

/** In-memory `RichAttachment`: renders its own kinds as a descriptor, `null` for any other. */
export function createFakeRichAttachment(
  kinds: readonly string[] = [FAKE_ATTACHMENT_KIND],
): RichAttachment {
  return {
    kinds,
    render(kind, payload): FakeAttachmentNode | null {
      return kinds.includes(kind) ? { kind, payload } : null;
    },
  };
}
