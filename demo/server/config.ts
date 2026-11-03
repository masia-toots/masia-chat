import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RelayTokenExpectations } from '@masia/contracts/wire';

// The playground server reads its settings from the environment, the way the relay does. The token
// issuer/audience use the relay's own variable names on purpose: the compose file gives the pair to both
// services from ONE anchor, so they cannot disagree.

export const DEMO_PORT_ENV = 'DEMO_PORT';
export const DEMO_HOST_ENV = 'DEMO_HOST';
export const DEMO_RELAY_URL_ENV = 'DEMO_RELAY_URL';
export const DEMO_KEY_FILE_ENV = 'DEMO_TOKEN_PRIVATE_KEY_FILE';
export const DEMO_CONTACTS_FILE_ENV = 'DEMO_CONTACTS_FILE';
export const DEMO_DIST_ENV = 'DEMO_DIST';
export const TOKEN_ISSUER_ENV = 'RELAY_TOKEN_ISSUER';
export const TOKEN_AUDIENCE_ENV = 'RELAY_TOKEN_AUDIENCE';

export const DEFAULT_PORT = 8080;
/**
 * Loopback unless the operator says otherwise: this server mints a relay token for ANYONE who asks
 * (that is the point of a playground), so it must not listen on a network by accident. The compose file
 * sets DEMO_HOST inside the container and publishes the port on the host's loopback only.
 */
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_RELAY_URL = 'http://127.0.0.1:3400';

export interface DemoConfig {
  readonly port: number;
  readonly host: string;
  readonly relayUrl: URL;
  readonly privateKeyFile: string;
  readonly expectations: RelayTokenExpectations;
  readonly contactsFile: string;
  readonly distDir: string;
}

const DEMO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === '') throw new Error(`${name} must be set`);
  return value.trim();
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): DemoConfig {
  const rawPort = env[DEMO_PORT_ENV];
  const port = rawPort === undefined || rawPort === '' ? DEFAULT_PORT : Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`${DEMO_PORT_ENV} must be a port number, got "${String(rawPort)}"`);
  }
  const relayUrl = new URL(env[DEMO_RELAY_URL_ENV] || DEFAULT_RELAY_URL);
  const issuer = required(env, TOKEN_ISSUER_ENV);
  const audience = required(env, TOKEN_AUDIENCE_ENV);
  return {
    port,
    host: env[DEMO_HOST_ENV] || DEFAULT_HOST,
    relayUrl,
    privateKeyFile: required(env, DEMO_KEY_FILE_ENV),
    expectations: { issuer, audience },
    contactsFile: env[DEMO_CONTACTS_FILE_ENV] || join(DEMO_ROOT, 'contacts.json'),
    distDir: env[DEMO_DIST_ENV] || join(DEMO_ROOT, 'dist'),
  };
}
