// The names the page and the playground's server must agree on, in ONE place: the browser bundle and the
// Node server both import this file (it has no imports of its own, so it runs in either).

/** The header a signed-in tab sends to prove a call is its own. */
export const SESSION_HEADER = 'x-demo-session';

/** What the page calls the relay through; the server strips it and forwards the rest. */
export const RELAY_PREFIX = '/relay';

/** Longest display name the server accepts, in characters; the login form limits the box to the same number. */
export const DISPLAY_NAME_MAX = 40;

/** The server's own routes. */
export const DEMO_PATHS = {
  health: '/demo/health',
  relayHealth: '/demo/relay-health',
  contacts: '/demo/contacts.json',
  login: '/demo/login',
  token: '/demo/token',
  people: '/demo/people',
} as const;
