/**
 * The CSS custom properties the messenger UI reads, and nothing else. A fixed list on purpose:
 * the host maps its own design system onto these names, so the list is the whole styling surface.
 */
export const THEME_TOKEN_NAMES = [
  '--msg-bg',
  '--msg-fg',
  '--msg-accent',
  '--msg-bubble-own',
  '--msg-bubble-other',
  '--msg-radius',
  '--msg-font',
  // Added with the UI core (ADR-161 К5a-2): what the moved screens actually paint with.
  /** The accent as a bare `r, g, b` triple, so a stylesheet can ask for any alpha: `rgba(var(--msg-accent-rgb), 0.3)`. */
  '--msg-accent-rgb',
  /** Text on a dark surface when it is lit (the live plate, a hovered control). */
  '--msg-accent-fg',
  /** Text on a SOLID accent fill (a count badge). */
  '--msg-accent-on',
  /** The monospace voice of the channel plates and door buttons. */
  '--msg-font-mono',
  /** Side of a contact's picture box (the plate is this wide and this tall). */
  '--msg-chip-size',
  /** The hairline round a raised surface (the other side's bubble, a reaction pill). */
  '--msg-frosted-border',
  /** Where your own bubble's gradient ends (it starts at `--msg-bubble-own`). */
  '--msg-bubble-own-deep',
  /** Text colour inside your own bubble. */
  '--msg-bubble-own-fg',
  /**
   * Added with the security-state UI (К5b): the colour of a caution that is not an error — a changed
   * key, a device still owing its first key update, a stalled room. A bare colour; a stylesheet
   * derives its tints with `color-mix`.
   */
  '--msg-warn',
] as const;
export type ThemeTokenName = (typeof THEME_TOKEN_NAMES)[number];

/**
 * A value for every theme token, as a CSS value string (a colour, a length, or a `var(--host-token)`
 * reference: the UI applies the set as inline custom properties on its own roots, so a reference is
 * resolved where the component sits, and a host whose accent changes by region keeps working).
 *
 * Why: the messenger must not import the host's UI package (that would drag the host's whole
 * visual world in with it). It takes colours, radius and font as plain input; the host decides
 * where the values come from, including dark mode.
 */
export type ThemeTokens = Readonly<Record<ThemeTokenName, string>>;
