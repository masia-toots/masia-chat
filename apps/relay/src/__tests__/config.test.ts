import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DATABASE_URL_ENV,
  DEFAULT_DEV_DATABASE_URL,
  DEFAULT_RELAY_BASE_PATH,
  DEFAULT_RELAY_HOST,
  DEFAULT_RELAY_PORT,
  isWildcardHost,
  OPERATOR_USER_ID_ENV,
  RELAY_BASE_PATH_ENV,
  RELAY_HOST_ENV,
  RELAY_PORT_ENV,
  resolveDatabaseUrl,
  resolveOperatorUserId,
  resolveRelayBasePath,
  resolveRelayHost,
  resolveRelayPort,
  resolveTokenExpectations,
  resolveTokenKeyring,
  TOKEN_AUDIENCE_ENV,
  TOKEN_ISSUER_ENV,
  TOKEN_PUBLIC_KEY_ENV,
} from '../config.js';
import { tokenKeyId } from '../token-keys.js';

/** The `RELAY_TOKEN_PUBLIC_KEY` form of a key: base64 of its SPKI DER. */
function spkiBase64(publicKey: KeyObject): string {
  return publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
}

describe('resolveRelayPort', () => {
  it('defaults to the relay port when the variable is unset or empty', () => {
    expect(resolveRelayPort({})).toBe(DEFAULT_RELAY_PORT);
    expect(resolveRelayPort({ [RELAY_PORT_ENV]: '' })).toBe(DEFAULT_RELAY_PORT);
  });

  it('takes the port from the variable', () => {
    expect(resolveRelayPort({ [RELAY_PORT_ENV]: '4510' })).toBe(4510);
  });

  it.each(['abc', '0', '70000', '34.5'])('refuses the invalid value "%s"', (value) => {
    expect(() => resolveRelayPort({ [RELAY_PORT_ENV]: value })).toThrow(RELAY_PORT_ENV);
  });
});

describe('resolveRelayHost', () => {
  it('defaults to loopback when the variable is unset or empty', () => {
    expect(resolveRelayHost({})).toBe(DEFAULT_RELAY_HOST);
    expect(resolveRelayHost({ [RELAY_HOST_ENV]: '' })).toBe(DEFAULT_RELAY_HOST);
    // The default must never be a wildcard: an unconfigured relay is reachable from its own machine only.
    expect(isWildcardHost(DEFAULT_RELAY_HOST)).toBe(false);
    expect(['localhost', '127.0.0.1', '::1']).toContain(DEFAULT_RELAY_HOST);
  });

  it.each(['127.0.0.1', '::1', '0.0.0.0', '::', 'localhost', 'relay-1.internal'])(
    'takes the address or name "%s" from the variable',
    (value) => {
      expect(resolveRelayHost({ [RELAY_HOST_ENV]: value })).toBe(value);
    },
  );

  it.each(['300.1.1.1', 'a b', 'host:3400', 'http://localhost', '-host', 'host-', '[::1]', ' 127.0.0.1'])(
    'refuses the invalid value "%s", naming the variable',
    (value) => {
      expect(() => resolveRelayHost({ [RELAY_HOST_ENV]: value })).toThrow(RELAY_HOST_ENV);
    },
  );

  it('flags only the two wildcard binds', () => {
    expect(isWildcardHost('0.0.0.0')).toBe(true);
    expect(isWildcardHost('::')).toBe(true);
    for (const host of ['127.0.0.1', '::1', 'localhost', '10.0.0.5']) {
      expect(isWildcardHost(host)).toBe(false);
    }
  });
});

describe('resolveRelayBasePath', () => {
  it('defaults to the origin root when the variable is unset or empty', () => {
    expect(DEFAULT_RELAY_BASE_PATH).toBe('');
    expect(resolveRelayBasePath({})).toBe('');
    expect(resolveRelayBasePath({ [RELAY_BASE_PATH_ENV]: '' })).toBe('');
  });

  it.each(['/relay', '/api/relay', '/r-1.v2_x~'])('takes the path "%s" as it is', (value) => {
    expect(resolveRelayBasePath({ [RELAY_BASE_PATH_ENV]: value })).toBe(value);
  });

  it.each([
    'relay', // no leading slash
    '/', // the root is spelled by leaving the variable empty
    '/relay/', // one spelling: no trailing slash
    '//relay',
    '/relay//x',
    '/re lay',
    '/relay?x=1',
    '/relay#x',
    '/..',
    '/relay/../x',
    '/.',
    '/relay%2Fx',
    'https://relay.example.com/relay',
  ])('refuses the invalid value "%s", naming the variable', (value) => {
    expect(() => resolveRelayBasePath({ [RELAY_BASE_PATH_ENV]: value })).toThrow(
      RELAY_BASE_PATH_ENV,
    );
  });
});

describe('resolveDatabaseUrl', () => {
  it('falls back to the dev database of its own, never the host application database', () => {
    expect(resolveDatabaseUrl({})).toBe(DEFAULT_DEV_DATABASE_URL);
    expect(new URL(DEFAULT_DEV_DATABASE_URL).pathname).toMatch(/relay/);
  });

  it('takes the URL from the variable', () => {
    expect(resolveDatabaseUrl({ [DATABASE_URL_ENV]: 'postgresql://u:p@db:5432/relay' })).toBe(
      'postgresql://u:p@db:5432/relay',
    );
  });

  it('refuses to fall back to the dev default in production', () => {
    expect(() => resolveDatabaseUrl({ NODE_ENV: 'production' })).toThrow(DATABASE_URL_ENV);
  });
});

describe('resolveTokenKeyring', () => {
  const first = generateKeyPairSync('ed25519').publicKey;
  const second = generateKeyPairSync('ed25519').publicKey;

  it('has no default: a default key would be a published trust anchor', () => {
    expect(() => resolveTokenKeyring({})).toThrow(TOKEN_PUBLIC_KEY_ENV);
    expect(() => resolveTokenKeyring({ [TOKEN_PUBLIC_KEY_ENV]: '   ' })).toThrow(
      TOKEN_PUBLIC_KEY_ENV,
    );
  });

  it('reads one base64 SPKI public key', () => {
    const keyring = resolveTokenKeyring({ [TOKEN_PUBLIC_KEY_ENV]: spkiBase64(first) });
    expect(keyring.kids).toEqual([tokenKeyId(first)]);
  });

  it('reads a comma-separated list for a rotation, current key first', () => {
    const keyring = resolveTokenKeyring({
      [TOKEN_PUBLIC_KEY_ENV]: ` ${spkiBase64(first)} , ${spkiBase64(second)} `,
    });
    expect(keyring.kids).toEqual([tokenKeyId(first), tokenKeyId(second)]);
  });

  it('refuses a value that is not a public key, naming the variable and never the value', () => {
    const secretLooking = 'not-a-key-but-looks-private-0123456789';
    for (const value of [secretLooking, 'AAAA', spkiBase64(first).slice(0, 40)]) {
      let message = '';
      try {
        resolveTokenKeyring({ [TOKEN_PUBLIC_KEY_ENV]: value });
      } catch (error) {
        message = error instanceof Error ? error.message : '';
      }
      expect(message).toContain(TOKEN_PUBLIC_KEY_ENV);
      expect(message).not.toContain(value);
    }
  });

  it('refuses a private key, a PEM block and a key of another algorithm', () => {
    const privatePkcs8 = generateKeyPairSync('ed25519').privateKey.export({
      type: 'pkcs8',
      format: 'der',
    });
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey;
    expect(() =>
      resolveTokenKeyring({ [TOKEN_PUBLIC_KEY_ENV]: privatePkcs8.toString('base64') }),
    ).toThrow(TOKEN_PUBLIC_KEY_ENV);
    expect(() =>
      resolveTokenKeyring({
        [TOKEN_PUBLIC_KEY_ENV]: first.export({ type: 'spki', format: 'pem' }).toString(),
      }),
    ).toThrow(TOKEN_PUBLIC_KEY_ENV);
    expect(() => resolveTokenKeyring({ [TOKEN_PUBLIC_KEY_ENV]: spkiBase64(rsa) })).toThrow(
      TOKEN_PUBLIC_KEY_ENV,
    );
  });

  it('refuses the same key listed twice', () => {
    expect(() =>
      resolveTokenKeyring({ [TOKEN_PUBLIC_KEY_ENV]: `${spkiBase64(first)},${spkiBase64(first)}` }),
    ).toThrow(TOKEN_PUBLIC_KEY_ENV);
  });
});

describe('resolveTokenExpectations', () => {
  it('has no default: unset or empty fails at start-up, naming the variable (review round 1, M14)', () => {
    expect(() => resolveTokenExpectations({})).toThrow(TOKEN_ISSUER_ENV);
    expect(() =>
      resolveTokenExpectations({ [TOKEN_ISSUER_ENV]: 'host-api', [TOKEN_AUDIENCE_ENV]: '' }),
    ).toThrow(TOKEN_AUDIENCE_ENV);
  });

  it('refuses an issuer equal to the audience', () => {
    expect(() =>
      resolveTokenExpectations({ [TOKEN_ISSUER_ENV]: 'same', [TOKEN_AUDIENCE_ENV]: 'same' }),
    ).toThrow(TOKEN_AUDIENCE_ENV);
  });

  it('takes both from the environment', () => {
    expect(
      resolveTokenExpectations({
        [TOKEN_ISSUER_ENV]: 'staging-api',
        [TOKEN_AUDIENCE_ENV]: 'staging-relay',
      }),
    ).toEqual({
      issuer: 'staging-api',
      audience: 'staging-relay',
    });
  });

  it('refuses a value outside the id alphabet, naming the variable', () => {
    expect(() =>
      resolveTokenExpectations({ [TOKEN_ISSUER_ENV]: 'host api', [TOKEN_AUDIENCE_ENV]: 'relay' }),
    ).toThrow(TOKEN_ISSUER_ENV);
  });
});

describe('resolveOperatorUserId', () => {
  it('is optional with no default: unset means no operator (no ASSISTANT device can register)', () => {
    expect(resolveOperatorUserId({})).toBeNull();
    expect(resolveOperatorUserId({ [OPERATOR_USER_ID_ENV]: '' })).toBeNull();
    expect(resolveOperatorUserId({ [OPERATOR_USER_ID_ENV]: 'operator-2' })).toBe('operator-2');
  });

  it('refuses a value outside the id alphabet', () => {
    expect(() => resolveOperatorUserId({ [OPERATOR_USER_ID_ENV]: 'a/b' })).toThrow(
      OPERATOR_USER_ID_ENV,
    );
  });
});
