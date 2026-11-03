/**
 * A complete set of UI services built from the contracts' fakes plus small fake slots, and a
 * `renderUi` that mounts a screen inside them. Test-only (the package's own tests; never exported).
 *
 * Why: the UI core is proven against fakes, not against the Masia hub. If a screen only passes with
 * the hub's menu or icon set behind it, it depends on the hub, and this file is where that shows.
 *
 * Why no `@testing-library/react`: the package keeps its dev dependencies to what the host already
 * ships; a screen needs only `createRoot` + `act`.
 */
import { MantineProvider } from '@mantine/core';
import {
  createFakeI18nBundle,
  createFakeMediaUpload,
  createFakeThemeTokens,
} from '@masia/contracts/fakes';
import type { IconSet, MediaReader, RichAttachment } from '@masia/contracts';
import { act, createElement, useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import {
  MessengerUiProvider,
  type MessengerUiServices,
} from '../ui/provider/messenger-ui.js';
import type {
  HScrollSlotProps,
  LightboxSlotProps,
  MenuSlotProps,
  MessengerUiSlots,
  PersonChipSlotProps,
} from '../ui/provider/slots.js';

/** An icon set whose icons are React nodes a test can query: `<svg data-icon="copy" data-size="16">`. */
export function createFakeReactIconSet(): IconSet {
  return {
    render(name, size, className) {
      return createElement('svg', {
        'data-icon': name,
        'data-size': size === undefined ? undefined : String(size),
        className,
      });
    },
  };
}

/** A sticker renderer that draws a queryable button for the `sticker` kind and nothing for the rest. */
export function createFakeStickerAttachment(): RichAttachment {
  return {
    kinds: ['sticker'],
    render(kind, payload) {
      if (kind !== 'sticker') return null;
      const p = payload as { mediaUrl: string; isOwn: boolean; text: string };
      return createElement('button', {
        type: 'button',
        'data-fake-sticker': p.mediaUrl,
        'data-own': String(p.isOwn),
      });
    },
  };
}

/**
 * A menu with the DOM contract the screens' tests rely on (`data-cm`, `data-cm-tab`, `data-cm-row`,
 * `data-cm-section`), the way the host's real menu draws it: tabs show their own sections, a row
 * fires its handler and closes, Esc closes and hands focus back to the opener.
 */
export function FakeMenu(props: MenuSlotProps): ReactElement | null {
  const { open, onClose, anchorRef, label, sections, tabs, defaultTab, onTabChange, closeLabel, name } = props;
  const [tab, setTab] = useState<string | undefined>(defaultTab ?? tabs?.[0]?.id);
  useEffect(() => {
    if (open) setTab(defaultTab ?? tabs?.[0]?.id);
    // The tab is read on the open edge only, as the real menu reads it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      onClose();
      anchorRef.current?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose, anchorRef]);
  if (!open) return null;
  const shown = sections.filter((s) => !s.tab || s.tab === tab);
  return createElement(
    'div',
    { 'data-cm': name, role: tabs?.length ? 'dialog' : 'menu', 'aria-label': label },
    tabs?.length
      ? createElement(
          'div',
          { role: 'tablist' },
          tabs.map((t) =>
            createElement(
              'button',
              {
                key: t.id,
                type: 'button',
                role: 'tab',
                'data-cm-tab': t.id,
                'aria-selected': t.id === tab,
                onClick: () => {
                  setTab(t.id);
                  onTabChange?.(t.id);
                },
              },
              t.label,
            ),
          ),
        )
      : null,
    shown.map((s) =>
      createElement(
        'div',
        { key: s.id, 'data-cm-section': s.id },
        s.title ? createElement('h4', null, s.title) : null,
        s.rows.map((r) =>
          createElement(
            'button',
            {
              key: r.id,
              type: 'button',
              role: 'menuitem',
              'data-cm-row': r.id,
              'aria-current': r.current ? 'true' : undefined,
              onClick: () => {
                r.onSelect();
                onClose();
              },
            },
            r.icon,
            createElement('span', null, r.label),
            r.hint,
            r.badge,
          ),
        ),
        s.content,
      ),
    ),
    createElement('button', { type: 'button', 'data-cm-close': '', 'aria-label': closeLabel, onClick: onClose }),
  );
}

/** A scroller with the structure the screens style (`.hscroll > .hscroll__viewport`) and no arrows. */
export function FakeHScroll(props: HScrollSlotProps): ReactElement {
  const { children, className, viewportClassName, viewportRef, endMore, role, 'aria-label': ariaLabel } = props;
  return createElement(
    'div',
    { className: `hscroll${className ? ` ${className}` : ''}`, 'data-end-more': endMore ? 'true' : undefined },
    createElement(
      'div',
      {
        ref: viewportRef,
        className: `hscroll__viewport${viewportClassName ? ` ${viewportClassName}` : ''}`,
        role,
        'aria-label': ariaLabel,
      },
      children,
    ),
  );
}

export function FakeLightbox({ items, index, onClose }: LightboxSlotProps): ReactElement {
  return createElement(
    'div',
    { 'data-lightbox': '', 'data-index': String(index) },
    items.map((item, i) => createElement('img', { key: i, src: item.src, alt: item.alt })),
    createElement('button', { type: 'button', 'data-lightbox-close': '', onClick: onClose }),
  );
}

export function FakePersonChip({ name, kind, label }: PersonChipSlotProps): ReactElement {
  return createElement('span', { 'data-chip': kind, 'data-chip-name': name, title: label });
}

/** The fake slots, for a test that replaces just one of them: `{ ...FAKE_SLOTS, Composer }`. */
export const FAKE_SLOTS: MessengerUiSlots = {
  Menu: FakeMenu,
  HScroll: FakeHScroll,
  Lightbox: FakeLightbox,
  PersonChip: FakePersonChip,
};

/** The services, with `notices` collecting what the UI sent to the host's toast. */
export interface FakeUi {
  readonly services: MessengerUiServices;
  readonly notices: string[];
}

export function createFakeUi(over: Partial<MessengerUiServices> = {}): FakeUi {
  const notices: string[] = [];
  const services: MessengerUiServices = {
    theme: createFakeThemeTokens(),
    icons: createFakeReactIconSet(),
    i18n: createFakeI18nBundle(),
    media: createFakeMediaUpload(),
    attachments: createFakeStickerAttachment(),
    slots: FAKE_SLOTS,
    env: {
      bankWindow: { initial: 12, grow: (current, total) => Math.min(total, current + 12) },
      phoneQuery: '(max-width: 767px)',
      reactions: ['👍', '❤️', '😂'],
      notifyError: (message) => {
        notices.push(message);
      },
    },
    ...over,
  };
  return { services, notices };
}

/** jsdom has no `matchMedia`; Mantine's provider and the panels' phone check read it. */
export function ensureMatchMedia(matches = false): void {
  window.matchMedia = ((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

export interface RenderedUi {
  readonly container: HTMLElement;
  readonly ui: FakeUi;
  rerender(node: ReactNode): void;
  unmount(): void;
}

const mounted = new Set<RenderedUi>();

/** Unmounts every tree `renderUi` mounted; call it from `afterEach`. */
export function cleanupUi(): void {
  for (const tree of [...mounted]) tree.unmount();
  document.body.innerHTML = '';
}

/** Mounts `node` in a Mantine + messenger-UI tree attached to the document, and returns handles. */
export function renderUi(node: ReactNode, over: Partial<MessengerUiServices> = {}): RenderedUi {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  if (typeof window.matchMedia !== 'function') ensureMatchMedia();
  const ui = createFakeUi(over);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const wrap = (child: ReactNode): ReactElement =>
    createElement(
      MantineProvider,
      null,
      createElement(MessengerUiProvider, { services: ui.services }, child),
    );
  act(() => root.render(wrap(node)));
  const tree: RenderedUi = {
    container,
    ui,
    rerender(next) {
      act(() => root.render(wrap(next)));
    },
    unmount() {
      if (!mounted.delete(tree)) return;
      act(() => root.unmount());
      container.remove();
    },
  };
  mounted.add(tree);
  return tree;
}

/** Lets pending promises (media resolves, directory reads) and timers of 0 ms settle inside `act`. */
export async function flush(ms = 0): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  });
}

/**
 * A media reader a test steers: ids in `known` show at once (`peek`); the rest wait in `resolve`
 * until the test calls `release(id, src)`. The fake of the contracts cannot do this: it knows only
 * what was uploaded through it.
 */
export interface TestMedia extends MediaReader {
  readonly known: Map<string, string>;
  readonly resolveCalls: string[];
  release(id: string, src: string): void;
  fail(id: string): void;
}

export function createTestMedia(known: Readonly<Record<string, string>> = {}): TestMedia {
  const map = new Map(Object.entries(known));
  const waiting = new Map<string, { ok(src: string): void; fail(error: Error): void }>();
  const resolveCalls: string[] = [];
  return {
    known: map,
    resolveCalls,
    peek: (id) => map.get(id),
    resolve(id) {
      resolveCalls.push(id);
      return new Promise<string>((ok, fail) => waiting.set(id, { ok, fail }));
    },
    release(id, src) {
      map.set(id, src);
      waiting.get(id)?.ok(src);
    },
    fail(id) {
      waiting.get(id)?.fail(new Error(`test media: ${id} failed`));
    },
  };
}

// ── DOM helpers: the few gestures the screens' tests make ────────────────────

export function q<T extends Element = HTMLElement>(selector: string, within: ParentNode = document): T | null {
  return within.querySelector<T>(selector);
}

export function qa<T extends Element = HTMLElement>(selector: string, within: ParentNode = document): T[] {
  return [...within.querySelectorAll<T>(selector)];
}

export function click(element: Element | null): void {
  if (!element) throw new Error('click: no such element');
  act(() => (element as HTMLElement).click());
}

/** Sets a text box's value the way typing does, so React's `onChange` fires. */
export function typeInto(element: HTMLInputElement | HTMLTextAreaElement | null, value: string): void {
  if (!element) throw new Error('typeInto: no such element');
  const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setValue = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  act(() => {
    setValue?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

export function pressKey(element: Element | null, key: string, init: KeyboardEventInit = {}): void {
  if (!element) throw new Error('pressKey: no such element');
  act(() => {
    element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
  });
}

export function pressEscape(): void {
  act(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
}
