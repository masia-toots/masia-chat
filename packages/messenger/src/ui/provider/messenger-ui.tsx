/**
 * The context every messenger screen reads its surroundings from.
 *
 * Why one provider: a screen needs the host's colours, icons, words, media, sticker renderer and a
 * handful of React components (a menu, a gallery). Threading each through props would make every
 * leaf component carry eight extra props; a single context holds them once, and the host mounts it
 * once (or once per entry point). The values are the ports of `@masia/contracts` plus the React-only
 * slots the contracts cannot carry (`slots.ts`).
 */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  type CSSProperties,
  type ReactNode,
} from 'react';
import {
  THEME_TOKEN_NAMES,
  type I18nBundle,
  type IconSet,
  type MediaReader,
  type MessengerIconName,
  type RichAttachment,
  type ThemeTokens,
} from '@masia/contracts';
import type { SeedContact } from '../../contacts/seed-contacts.js';
import type { SecurityStateSource } from './security-source.js';
import type { MessengerUiSlots } from './slots.js';

/** Host facts and behaviours that are neither a colour, a word nor a picture. */
export interface MessengerUiEnv {
  /**
   * The channel bank renders its recent plates in a window that grows as the row is scrolled.
   * The numbers are the host's UX call (a phone and a desk differ), so the host owns them.
   */
  readonly bankWindow: {
    readonly initial: number;
    /** The next window size, given the current one and how many plates exist in all. */
    grow(current: number, total: number): number;
  };
  /** A CSS media query that means "a phone": panels skip auto-focusing a text box there (it would raise the keyboard). */
  readonly phoneQuery: string;
  /** The emoji offered in a message's reaction bar. */
  readonly reactions: readonly string[];
  /** Shows a short failure message in the host's own toast. */
  notifyError(message: string): void;
  /**
   * Attributes the conversation's scroller must carry for the host (the Masia intercom finds the
   * scroller it clips its window to by one `data-*` attribute). Nothing the messenger reads itself.
   */
  readonly scrollerAttrs?: Readonly<Record<`data-${string}`, string>>;
}

/** What a host passes to `MessengerUiProvider`. */
export interface MessengerUiServices {
  readonly theme: ThemeTokens;
  readonly icons: IconSet;
  readonly i18n: I18nBundle;
  /** Turns a media id into a displayable URL. The UI only displays media here; it never uploads. */
  readonly media: MediaReader;
  /** Draws the host's own attachment kinds (stickers). */
  readonly attachments: RichAttachment;
  readonly slots: MessengerUiSlots;
  readonly env: MessengerUiEnv;
  /**
   * Where a room's security state comes from (К5b). Optional: without it the zone badge, the guardian
   * ribbon, the stall banner and the room's device rows draw nothing, because a room whose state is
   * unknown must not look secure. The single entry point the engine wiring fills (see `security-source.ts`).
   */
  readonly security?: SecurityStateSource;
  /**
   * People to suggest when the address book is empty (К10b): a host-config list of maintainers with
   * a mail and a GitHub link each, shown by the People tab instead of «find someone by @tag». Not
   * contacts (no chat behind them): see `contacts/seed-contacts.ts`. Optional: without it the empty
   * state is the host's own `contacts.noContacts` line.
   */
  readonly seedContacts?: readonly SeedContact[];
}

/** The services plus the one value derived from them every root needs. */
export interface MessengerUiValue extends MessengerUiServices {
  /** The theme tokens as inline custom properties; every screen root carries it (see `themeStyle`). */
  readonly themeStyle: CSSProperties;
}

/**
 * The theme as an inline style for a screen's root element.
 *
 * Why inline on each root and not a global `:root` rule: the tokens may be `var(--host-token)`
 * references, which the browser resolves where the style sits. A host whose accent changes by region
 * (the Masia header positions) keeps working, and a screen drawn inside a portal (a menu body) still
 * gets its own copy because its root carries the style.
 */
export function themeStyle(theme: ThemeTokens): CSSProperties {
  const style: Record<string, string> = {};
  for (const name of THEME_TOKEN_NAMES) style[name] = theme[name];
  return style as CSSProperties;
}

const MessengerUiContext = createContext<MessengerUiValue | null>(null);

export interface MessengerUiProviderProps {
  readonly services: MessengerUiServices;
  readonly children?: ReactNode;
}

export function MessengerUiProvider({ services, children }: MessengerUiProviderProps) {
  const value = useMemo<MessengerUiValue>(
    () => ({ ...services, themeStyle: themeStyle(services.theme) }),
    [services],
  );
  return <MessengerUiContext.Provider value={value}>{children}</MessengerUiContext.Provider>;
}

/** The surroundings of the screen being drawn; throws outside a provider so a missing mount is loud. */
export function useMessengerUi(): MessengerUiValue {
  const value = useContext(MessengerUiContext);
  if (!value) throw new Error('MessengerUiProvider is missing: mount it above the messenger screens');
  return value;
}

/**
 * Draws a named icon as a React node. The `IconSet` port returns `unknown` so the contracts stay
 * free of React; the messenger UI is React, so it takes that node as one.
 */
export function renderIcon(
  icons: IconSet,
  name: MessengerIconName,
  size?: number,
  className?: string,
): ReactNode {
  return icons.render(name, size, className) as ReactNode;
}

/**
 * The bundle's `t` as a stable function (it changes only when the bundle does, i.e. the language).
 * Why a wrapper and not `const { t } = i18n`: the port declares `t` as a method, so a host may rely on
 * `this`; calling through the bundle keeps that working.
 */
export function useT(): I18nBundle['t'] {
  const { i18n } = useMessengerUi();
  return useCallback((key, vars) => i18n.t(key, vars), [i18n]);
}

/** `renderIcon` bound to the provider's icon set, stable per set. */
export function useIcon(): (name: MessengerIconName, size?: number, className?: string) => ReactNode {
  const { icons } = useMessengerUi();
  return useCallback((name, size, className) => renderIcon(icons, name, size, className), [icons]);
}
