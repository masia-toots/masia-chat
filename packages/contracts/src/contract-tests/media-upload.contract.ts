import { describe, expect, it } from 'vitest';
import type { MediaUpload } from '../ports/media-upload.js';
import { contractTitle, type ContractFactory } from './contract-support.js';

const CONTRACT_MIME = 'image/png';
const UNKNOWN_MEDIA_ID = 'contract-unknown-media-id';

/** Registers the behavioural contract every `MediaUpload` implementation must honour. */
export function describeMediaUploadContract<T extends MediaUpload>(
  name: string,
  factory: ContractFactory<T>,
): void {
  describe(contractTitle('MediaUpload', name), () => {
    it('answers an upload with a non-empty id and url', async () => {
      const media = await factory();
      const uploaded = await media.upload(Uint8Array.of(1, 2, 3), CONTRACT_MIME);
      expect(uploaded.id).not.toBe('');
      expect(uploaded.url).not.toBe('');
    });

    it('resolves an uploaded id back to the url it was given', async () => {
      const media = await factory();
      const uploaded = await media.upload(Uint8Array.of(1), CONTRACT_MIME);
      expect(await media.resolve(uploaded.id)).toBe(uploaded.url);
    });

    it('gives two uploads two different ids', async () => {
      const media = await factory();
      const first = await media.upload(Uint8Array.of(1), CONTRACT_MIME);
      const second = await media.upload(Uint8Array.of(1), CONTRACT_MIME);
      expect(second.id).not.toBe(first.id);
    });

    it('peeks the url of an id it has issued, without waiting', async () => {
      const media = await factory();
      const uploaded = await media.upload(Uint8Array.of(1), CONTRACT_MIME);
      expect(media.peek(uploaded.id)).toBe(uploaded.url);
    });

    it('peeks nothing for an id it never issued (it must not guess a url)', async () => {
      const media = await factory();
      expect(media.peek(UNKNOWN_MEDIA_ID)).toBeUndefined();
    });

    it('rejects, rather than guessing, for an id it never issued', async () => {
      const media = await factory();
      await expect(media.resolve(UNKNOWN_MEDIA_ID)).rejects.toThrow();
    });
  });
}
