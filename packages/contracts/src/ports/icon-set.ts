/** Every icon the messenger UI draws. A closed list, so a host knows exactly what to supply. */
export const MESSENGER_ICON_NAMES = [
  'send',
  'attach',
  'devices',
  'lock',
  'lock-open',
  'warning',
  'masia',
  'guardian',
  'people',
  'groups',
  'back',
  'more',
  // Added with the UI core (ADR-161 К5a-2).
  'copy',
  'mood',
  'edit',
  'trash',
  'pin',
  'chat',
  'folder',
  'check',
  'close',
  'chevron',
  'users',
  'device-mobile',
  'device-web',
  'device-desktop',
  'logout',
] as const;
export type MessengerIconName = (typeof MESSENGER_ICON_NAMES)[number];

/**
 * Draws a named icon at a size.
 *
 * Why: icons are part of the host's look. Returning `unknown` keeps this package free of any UI
 * framework types; the messenger UI renders whatever node the host hands back (a React element in
 * the Masia hub, an SVG string elsewhere).
 */
export interface IconSet {
  /**
   * `size` is in the host's own units (logical pixels in the hub); omitted, the icon takes the size
   * its stylesheet gives it (the channel bank sizes its glyphs in `em`, from the button's font).
   * `className` rides the icon's own element, so a stylesheet can address one glyph.
   */
  render(name: MessengerIconName, size?: number, className?: string): unknown;
}
