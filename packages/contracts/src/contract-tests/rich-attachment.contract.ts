import { describe, expect, it } from 'vitest';
import type { RichAttachment } from '../ports/rich-attachment.js';
import { contractTitle, type ContractFactory } from './contract-support.js';

const UNDECLARED_KIND = 'contract-undeclared-kind';
const CONTRACT_PAYLOAD = {};

/** Registers the behavioural contract every `RichAttachment` implementation must honour. */
export function describeRichAttachmentContract<T extends RichAttachment>(
  name: string,
  factory: ContractFactory<T>,
): void {
  describe(contractTitle('RichAttachment', name), () => {
    it('declares only non-empty, distinct kinds', async () => {
      const attachments = await factory();
      expect(attachments.kinds.every((kind) => kind !== '')).toBe(true);
      expect(new Set(attachments.kinds).size).toBe(attachments.kinds.length);
    });

    it('draws something for every kind it declares', async () => {
      const attachments = await factory();
      for (const kind of attachments.kinds) {
        expect(attachments.render(kind, CONTRACT_PAYLOAD)).not.toBeNull();
      }
    });

    it('answers null for a kind it did not declare, so the messenger can show a placeholder', async () => {
      const attachments = await factory();
      expect(attachments.kinds).not.toContain(UNDECLARED_KIND);
      expect(attachments.render(UNDECLARED_KIND, CONTRACT_PAYLOAD)).toBeNull();
    });
  });
}
