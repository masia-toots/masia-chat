/**
 * Everything the relay reads from its environment, in one place, so a deploy mistake fails at
 * start-up with a message instead of surfacing as a strange behaviour later.
 */
import { isIP } from 'node:net';
import { ID_PATTERN } from '@masia/relay';
import type { TokenExpectations } from './auth.js';
import { parseTokenKeyring, type TokenKeyring } from './token-keys.js';

/** The environment variable that sets the listening port. */
export const RELAY_PORT_ENV = 'RELAY_PORT';
export const DEFAULT_RELAY_PORT = 3400;

const PORT_MIN = 1;
const PORT_MAX = 65_535;

/**
 * The address the relay binds. The default is loopback (the same bind Fastify gave an unset host before
 * this variable existed), so a relay started with no configuration is reachable only from its own machine:
 * behind a reverse proxy or a tunnel on that machine, set `127.0.0.1` explicitly; inside a container the
 * port must be published from a wildcard bind, so set `0.0.0.0` there.
 */
export const RELAY_HOST_ENV = 'RELAY_HOST';
export const DEFAULT_RELAY_HOST = 'localhost';

/** A DNS-style name: letters, digits, dots and hyphens, not starting or ending with a dot or a hyphen. */
const HOSTNAME = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;
const DOTTED_NUMBER = /^[0-9.]+$/;

/** The addresses that bind every interface: the one value that exposes the relay beyond its machine. */
const WILDCARD_HOSTS: ReadonlySet<string> = new Set(['0.0.0.0', '::']);

/**
 * The URL path the relay is served under, for a deployment that shares one origin with other things
 * (the reference host serves it at `/relay`). Unset or empty: the relay answers at the origin root.
 * The proxy in front passes the path through UNCHANGED; the relay owns the prefix, so the same build
 * serves a bare origin in development and a shared one in production. A value is a path, not a URL:
 * `/relay`, never `https://host/relay` (the host and scheme belong to the proxy).
 */
export const RELAY_BASE_PATH_ENV = 'RELAY_BASE_PATH';
export const DEFAULT_RELAY_BASE_PATH = '';

/** One or more segments, each of unreserved URL characters; a leading slash and no trailing one. */
const BASE_PATH_SEGMENT = /^[A-Za-z0-9._~-]+$/;

/** The relay's own Postgres database (ADR-161): never the host application's. */
export const DATABASE_URL_ENV = 'RELAY_DATABASE_URL';

/**
 * The local development database: a Postgres on this machine, with a database of its own (never the
 * host application's). Throwaway credentials, safe to publish; production must set the variable
 * explicitly.
 */
export const DEFAULT_DEV_DATABASE_URL = 'postgresql://relay@localhost:5432/relay';

/**
 * The public key(s) the relay verifies access tokens with. The host API signs with the matching
 * Ed25519 private key (EdDSA, `iss`/`aud` pinned); the relay never holds a signing key.
 *
 * Format: each key is the base64 text of its SPKI DER encoding (one line, no PEM newlines to lose in a
 * compose file or a vault), and the variable is a comma-separated LIST: the current key first, then
 * any key being rotated away from. A token names its key in the `kid` header, so during a rotation
 * both are accepted; remove the old key once the last token it signed has expired
 * (`RELAY_TOKEN_TTL_SECONDS`). To get the value from an Ed25519 private key in PEM:
 * `openssl pkey -in private.pem -pubout -outform DER | base64 -w0`.
 */
export const TOKEN_PUBLIC_KEY_ENV = 'RELAY_TOKEN_PUBLIC_KEY';

/**
 * The `iss` and `aud` an access token must carry: REQUIRED, no default. They are the host's names
 * for itself and for this relay, so they are deployment config, never constants of the open relay
 * (architecture review round 1, M14: until 2026-10-10 they defaulted to the reference host's own
 * names). The host is given the same pair. Two relays whose tokens must not be interchangeable get
 * different audiences.
 */
export const TOKEN_ISSUER_ENV = 'RELAY_TOKEN_ISSUER';
export const TOKEN_AUDIENCE_ENV = 'RELAY_TOKEN_AUDIENCE';

/**
 * The OPERATOR principal: the account that owns every ASSISTANT device; only a token for it may
 * register one (ADR-117 amendment 2026-10-10). Optional and without a default: unset, the relay
 * registers no ASSISTANT device at all (a host without an assistant needs nothing here).
 */
export const OPERATOR_USER_ID_ENV = 'RELAY_OPERATOR_USER_ID';

const PRODUCTION = 'production';
const ID = new RegExp(ID_PATTERN);

/** An id-shaped variable, or `null` when it is unset or empty. Set but malformed throws. */
function idFromEnv(env: NodeJS.ProcessEnv, name: string): string | null {
  const raw = env[name];
  if (raw === undefined || raw === '') return null;
  if (!ID.test(raw)) throw new Error(`${name} must match ${ID_PATTERN}, got "${raw}"`);
  return raw;
}

function requiredIdFromEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = idFromEnv(env, name);
  if (value === null) throw new Error(`${name} must be set (it has no default)`);
  return value;
}

/**
 * Reads the listening port from the environment, falling back to the default.
 * A set-but-invalid value throws: silently listening elsewhere than configured hides a deploy bug.
 */
export function resolveRelayPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[RELAY_PORT_ENV];
  if (raw === undefined || raw === '') return DEFAULT_RELAY_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < PORT_MIN || port > PORT_MAX) {
    throw new Error(
      `${RELAY_PORT_ENV} must be an integer from ${PORT_MIN} to ${PORT_MAX}, got "${raw}"`,
    );
  }
  return port;
}

/**
 * Reads the bind address from the environment, falling back to loopback. A set-but-invalid value
 * throws, and the message never echoes more than the variable name and the offending text (an address
 * is not a secret, but a deploy typo should be visible).
 */
export function resolveRelayHost(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env[RELAY_HOST_ENV];
  if (raw === undefined || raw === '') return DEFAULT_RELAY_HOST;
  // Digits and dots that are not an IP address (`300.1.1.1`) are a typo, not a host name.
  const isName = HOSTNAME.test(raw) && !DOTTED_NUMBER.test(raw);
  if (isIP(raw) === 0 && !isName) {
    throw new Error(`${RELAY_HOST_ENV} must be an IP address or a host name, got "${raw}"`);
  }
  return raw;
}

/** True when the bind address listens on every interface (`0.0.0.0` or `::`). */
export function isWildcardHost(host: string): boolean {
  return WILDCARD_HOSTS.has(host);
}

/**
 * Reads the URL prefix from the environment: `''` (the origin root) or a path such as `/relay`.
 * A set-but-invalid value throws: a prefix the proxy and the relay disagree on is a 404 for every
 * client, and the way to find that out should not be a user report. One spelling only: a leading
 * slash, no trailing one, no empty or dot segments.
 */
export function resolveRelayBasePath(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env[RELAY_BASE_PATH_ENV];
  if (raw === undefined || raw === '') return DEFAULT_RELAY_BASE_PATH;
  const segments = raw.startsWith('/') ? raw.slice(1).split('/') : [];
  const valid =
    segments.length > 0 &&
    segments.every((s) => BASE_PATH_SEGMENT.test(s) && s !== '.' && s !== '..');
  if (!valid) {
    throw new Error(
      `${RELAY_BASE_PATH_ENV} must be empty or a path like "/relay" (leading slash, no trailing slash, ` +
        `segments of letters, digits and "._~-"), got "${raw}"`,
    );
  }
  return raw;
}

/**
 * Origins OTHER than the relay's own that may call it from a browser (cors.ts), comma-separated, each an
 * exact origin: `scheme://host` or `scheme://host:port`, no path, no wildcard. An app shell whose pages are
 * served from its own scheme needs this; the reference host names its iOS app's `capacitor://` origin here.
 * Unset or empty: same-origin clients only (as before this variable existed).
 */
export const RELAY_ALLOWED_ORIGINS_ENV = 'RELAY_ALLOWED_ORIGINS';

/** `scheme://host[:port]`: a scheme, `://`, a DNS-style host, an optional port. Nothing after it. */
const EXACT_ORIGIN =
  /^[a-z][a-z0-9+.-]*:\/\/[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::[0-9]{1,5})?$/;

/**
 * Reads the allowed origins. A set-but-invalid entry throws: a typo here is an app that silently cannot
 * reach the relay, and `*` would hand the token-bearing API to every page on the web.
 */
export function resolveRelayAllowedOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env[RELAY_ALLOWED_ORIGINS_ENV];
  if (raw === undefined || raw.trim() === '') return [];
  const origins = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  const bad = origins.find((origin) => !EXACT_ORIGIN.test(origin));
  if (bad !== undefined) {
    throw new Error(
      `${RELAY_ALLOWED_ORIGINS_ENV} must be comma-separated exact origins like "capacitor://localhost" ` +
        `(scheme://host[:port], no path, no wildcard), got "${bad}"`,
    );
  }
  return [...new Set(origins)];
}

/**
 * The relay database URL. In production the variable is REQUIRED: falling back to the development
 * default there would point a live relay at whatever answers on localhost.
 */
export function resolveDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env[DATABASE_URL_ENV];
  if (raw !== undefined && raw !== '') return raw;
  if (env['NODE_ENV'] === PRODUCTION) {
    throw new Error(`${DATABASE_URL_ENV} must be set when NODE_ENV=${PRODUCTION}`);
  }
  return DEFAULT_DEV_DATABASE_URL;
}

/**
 * The token public keys have no default: a default key would be a published trust anchor. Unset or
 * malformed fails at start-up; the message names the variable and the reason, never the value.
 */
export function resolveTokenKeyring(env: NodeJS.ProcessEnv = process.env): TokenKeyring {
  const raw = env[TOKEN_PUBLIC_KEY_ENV];
  if (raw === undefined || raw.trim() === '') {
    throw new Error(
      `${TOKEN_PUBLIC_KEY_ENV} must be set to one or more base64 SPKI Ed25519 public keys, comma-separated`,
    );
  }
  try {
    return parseTokenKeyring(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unreadable';
    throw new Error(`${TOKEN_PUBLIC_KEY_ENV} is invalid: ${reason}`);
  }
}

/** The `iss`/`aud` pair access tokens are checked against. Both required; equal is refused. */
export function resolveTokenExpectations(env: NodeJS.ProcessEnv = process.env): TokenExpectations {
  const issuer = requiredIdFromEnv(env, TOKEN_ISSUER_ENV);
  const audience = requiredIdFromEnv(env, TOKEN_AUDIENCE_ENV);
  if (issuer === audience) {
    throw new Error(`${TOKEN_ISSUER_ENV} and ${TOKEN_AUDIENCE_ENV} must differ`);
  }
  return { issuer, audience };
}

/** The operator principal, or `null`: then no ASSISTANT device can be registered. */
export function resolveOperatorUserId(env: NodeJS.ProcessEnv = process.env): string | null {
  return idFromEnv(env, OPERATOR_USER_ID_ENV);
}
