/**
 * Displayable URLs for a list of media ids, in order.
 *
 * Why this and not `resolve` in the component: a conversation scrolled back and forth re-renders
 * pictures it has already shown. `peek` hands back what the host has cached, so the first paint of
 * a known picture needs no placeholder; only an unknown id waits for `resolve`. An entry is `''`
 * while its URL is on the way: render a placeholder for it, never `<img src="">` (that makes the
 * browser request the page itself).
 */
import { useEffect, useMemo, useState } from 'react';
import type { MediaReader } from '@masia/contracts';

export function useMediaSrcs(media: MediaReader, ids: readonly string[]): string[] {
  // `ids` is a fresh array on every render upstream; its CONTENT is what decides whether to fetch.
  const key = JSON.stringify(ids);
  const [loaded, setLoaded] = useState<Readonly<Record<string, string>>>({});

  useEffect(() => {
    let cancelled = false;
    for (const id of ids) {
      if (media.peek(id) !== undefined) continue;
      media.resolve(id).then(
        (src) => {
          if (!cancelled) setLoaded((prev) => (prev[id] === src ? prev : { ...prev, [id]: src }));
        },
        // An id the host cannot resolve keeps its placeholder; the failure is the host's to report.
        () => undefined,
      );
    }
    return () => {
      cancelled = true;
    };
    // `key` stands for the content of `ids`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [media, key]);

  return useMemo(
    () => ids.map((id) => media.peek(id) ?? loaded[id] ?? ''),
    // `key` stands for the content of `ids`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [media, key, loaded],
  );
}
