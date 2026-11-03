import {
  THEME_TOKEN_NAMES,
  type MediaReader,
  type MessengerLang,
  type RichAttachment,
  type ThemeTokens,
} from '@masia/contracts';
import { createFakeI18nBundle } from '@masia/contracts/fakes';
import type { SeedContact } from '@masia/messenger/contacts';
import type { MessengerUiEnv, MessengerUiServices } from '@masia/messenger/ui';
import type { PlaygroundRuntime } from '../client/runtime.js';
import { createIconSet } from './icons.js';
import { createSecuritySource } from './security-source.js';
import { demoSlots } from './slots.js';
import type { Toaster } from './toaster.js';

// Everything the messenger's UI core asks its host for (`MessengerUiServices`), in the smallest honest
// form. The theme is a table of CSS variable references, so the page's stylesheet (light and dark) is
// the single place a colour is chosen; the words are the English bundle the contracts ship for tests,
// the media and attachment ports are empty because the playground sends text only.

/** `--msg-bg` is drawn from `--demo-bg`, and so on for every token the messenger reads. */
export const DEMO_THEME_PREFIX = '--demo-';

export function demoThemeTokens(): ThemeTokens {
  return Object.fromEntries(
    THEME_TOKEN_NAMES.map((name) => [name, `var(${DEMO_THEME_PREFIX}${name.slice('--msg-'.length)})`]),
  ) as unknown as ThemeTokens;
}

/** No media: the playground has nothing to resolve, and says so when asked. */
export const NO_MEDIA: MediaReader = {
  resolve: () => Promise.reject(new Error('NO_MEDIA')),
  peek: () => undefined,
};

/** No stickers or cards: every kind is unknown, so the messenger shows its plain placeholder. */
export const NO_ATTACHMENTS: RichAttachment = { kinds: [], render: () => null };

export const DEMO_REACTIONS = ['👍', '❤️', '😂', '😮', '🙏'] as const;
export const PHONE_QUERY = '(max-width: 640px)';
const BANK_WINDOW_INITIAL = 12;
const BANK_WINDOW_STEP = 12;

export function demoEnv(toaster: Toaster): MessengerUiEnv {
  return {
    bankWindow: {
      initial: BANK_WINDOW_INITIAL,
      grow: (current, total) => Math.min(total, current + BANK_WINDOW_STEP),
    },
    phoneQuery: PHONE_QUERY,
    reactions: DEMO_REACTIONS,
    notifyError: (message) => toaster.push(message),
  };
}

export interface ServicesInput {
  readonly runtime: PlaygroundRuntime;
  readonly toaster: Toaster;
  readonly lang: MessengerLang;
  readonly seeds: readonly SeedContact[];
}

export function createServices({ runtime, toaster, lang, seeds }: ServicesInput): MessengerUiServices {
  return {
    theme: demoThemeTokens(),
    icons: createIconSet(),
    i18n: createFakeI18nBundle(lang),
    media: NO_MEDIA,
    attachments: NO_ATTACHMENTS,
    slots: demoSlots,
    env: demoEnv(toaster),
    security: createSecuritySource(runtime),
    seedContacts: seeds,
  };
}
