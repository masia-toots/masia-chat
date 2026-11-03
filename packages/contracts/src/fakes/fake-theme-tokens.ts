import type { ThemeTokens } from '../ports/theme-tokens.js';

/** A complete, plain token set. Radius is in `rem` so it scales with text, not with a screen. */
export const FAKE_THEME_TOKENS: ThemeTokens = {
  '--msg-bg': '#ffffff',
  '--msg-fg': '#111111',
  '--msg-accent': '#2f6fed',
  '--msg-bubble-own': '#dbe8ff',
  '--msg-bubble-other': '#f1f1f1',
  '--msg-radius': '0.75rem',
  '--msg-font': 'system-ui, sans-serif',
  '--msg-accent-rgb': '47, 111, 237',
  '--msg-accent-fg': '#e8f0ff',
  '--msg-accent-on': '#0a1a3d',
  '--msg-font-mono': 'ui-monospace, monospace',
  '--msg-chip-size': '2.5rem',
  '--msg-frosted-border': '#d9d9d9',
  '--msg-bubble-own-deep': '#c3d6fa',
  '--msg-bubble-own-fg': '#111111',
  '--msg-warn': '#b26a00',
};

/** A fake `ThemeTokens` value, with any token overridden for a test. */
export function createFakeThemeTokens(overrides: Partial<ThemeTokens> = {}): ThemeTokens {
  return { ...FAKE_THEME_TOKENS, ...overrides };
}
