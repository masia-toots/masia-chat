import type { MediaUpload } from '../ports/media-upload.js';

export const FAKE_MEDIA_URL_PREFIX = 'memory://media/';
const FAKE_MEDIA_ID_PREFIX = 'fake-media-';

/** In-memory `MediaUpload`: ids are sequential per instance, so two uploads never share one. */
export function createFakeMediaUpload(): MediaUpload {
  const urlsById = new Map<string, string>();

  return {
    async upload() {
      const id = `${FAKE_MEDIA_ID_PREFIX}${urlsById.size + 1}`;
      const url = `${FAKE_MEDIA_URL_PREFIX}${id}`;
      urlsById.set(id, url);
      return { url, id };
    },
    async resolve(id) {
      const url = urlsById.get(id);
      if (url === undefined) throw new Error(`fake media upload: unknown media id "${id}"`);
      return url;
    },
    peek(id) {
      return urlsById.get(id);
    },
  };
}
