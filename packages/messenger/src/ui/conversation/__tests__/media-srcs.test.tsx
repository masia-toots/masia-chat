// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestMedia } from '../../../test-support/fake-ui.js';
import { renderHook, settle } from '../../../test-support/render-hook.js';
import { openMedia } from '../open-media.js';
import { useMediaSrcs } from '../use-media-srcs.js';

afterEach(() => vi.restoreAllMocks());

describe('useMediaSrcs', () => {
  it('returns known ids at once and an empty string for the rest, then fills them in order', async () => {
    const media = createTestMedia({ a: 'blob:a' });
    const hook = await renderHook(() => useMediaSrcs(media, ['a', 'b']));
    expect(hook.current).toEqual(['blob:a', '']);
    expect(media.resolveCalls).toEqual(['b']);
    media.release('b', 'blob:b');
    await settle();
    expect(hook.current).toEqual(['blob:a', 'blob:b']);
    await hook.unmount();
  });

  it('keeps the placeholder for an id the host cannot resolve, without throwing', async () => {
    const media = createTestMedia();
    const hook = await renderHook(() => useMediaSrcs(media, ['gone']));
    media.fail('gone');
    await settle();
    expect(hook.current).toEqual(['']);
    await hook.unmount();
  });

  it('does not resolve again on a re-render with the same ids in a new array', async () => {
    const media = createTestMedia();
    const hook = await renderHook(() => useMediaSrcs(media, ['x']));
    await hook.rerender();
    await hook.rerender();
    expect(media.resolveCalls).toEqual(['x']);
    await hook.unmount();
  });

  it('ignores an answer that arrives after the screen is gone', async () => {
    const media = createTestMedia();
    const hook = await renderHook(() => useMediaSrcs(media, ['late']));
    await hook.unmount();
    media.release('late', 'blob:late');
    await settle();
    expect(media.resolveCalls).toEqual(['late']);
  });
});

describe('openMedia', () => {
  it('opens a known url directly with no opener', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    openMedia(createTestMedia({ doc: 'blob:doc' }), 'doc');
    expect(open).toHaveBeenCalledWith('blob:doc', '_blank', 'noopener,noreferrer');
  });

  it('opens the tab inside the click and points it once the url is resolved', async () => {
    const tab = { location: { href: '' }, close: vi.fn() } as unknown as Window;
    const open = vi.spyOn(window, 'open').mockReturnValue(tab);
    const media = createTestMedia();
    openMedia(media, 'doc');
    expect(open).toHaveBeenCalledWith('', '_blank');
    media.release('doc', 'blob:doc');
    await settle();
    expect(tab.location.href).toBe('blob:doc');
  });

  it('opens a fresh tab when the browser handed back no window to point', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const media = createTestMedia();
    openMedia(media, 'doc');
    media.release('doc', 'blob:doc');
    await settle();
    expect(open).toHaveBeenLastCalledWith('blob:doc', '_blank');
  });

  it('closes the empty tab when the host cannot resolve the id', async () => {
    const tab = { location: { href: '' }, close: vi.fn() } as unknown as Window;
    vi.spyOn(window, 'open').mockReturnValue(tab);
    const media = createTestMedia();
    openMedia(media, 'doc');
    media.fail('doc');
    await settle();
    expect(tab.close).toHaveBeenCalledTimes(1);
  });
});
