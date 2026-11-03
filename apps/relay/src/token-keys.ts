import { createHash, createPublicKey, type KeyObject } from 'node:crypto';
import { RELAY_TOKEN_KEY_ID_LENGTH } from '@masia/relay';

/**
 * The public keys the relay accepts access tokens from. The relay holds PUBLIC keys only: the host
 * API signs with the private half, which never reaches this process (security review 2026-10-10 §4).
 *
 * A token names its key in the JOSE `kid` header, so rotation needs no downtime: list the new key
 * next to the old one, switch the host's signing key, and drop the old key once the last token it
 * signed has expired (`RELAY_TOKEN_TTL_SECONDS`).
 */
export interface TokenKeyring {
  /** The key for a token's `kid`, or `undefined` for a `kid` the relay does not know (or none). */
  keyFor(kid: string | undefined): KeyObject | undefined;
  /** The ids of the keys held, in the order they were listed; for a start-up log line, never a secret. */
  readonly kids: readonly string[];
}

const SPKI = { type: 'spki', format: 'der' } as const;

/** The `kid` of a public key: see `RELAY_TOKEN_KEY_ID_LENGTH`. The host derives it the same way. */
export function tokenKeyId(publicKey: KeyObject): string {
  const spki = publicKey.export(SPKI);
  return createHash('sha256').update(spki).digest('hex').slice(0, RELAY_TOKEN_KEY_ID_LENGTH);
}

/** A keyring over already-imported Ed25519 public keys. Throws on a key of another type or a repeat. */
export function tokenKeyringOf(publicKeys: readonly KeyObject[]): TokenKeyring {
  if (publicKeys.length === 0) throw new Error('at least one public key is required');
  const byId = new Map<string, KeyObject>();
  for (const key of publicKeys) {
    if (key.type !== 'public' || key.asymmetricKeyType !== 'ed25519') {
      throw new Error('every key must be an Ed25519 public key');
    }
    const kid = tokenKeyId(key);
    if (byId.has(kid)) throw new Error(`the same public key is listed twice (kid ${kid})`);
    byId.set(kid, key);
  }
  return {
    keyFor: (kid) => (kid === undefined ? undefined : byId.get(kid)),
    kids: [...byId.keys()],
  };
}

/** One key in the environment variable: base64 text (the schemas' `BASE64_PATTERN` is for request bodies). */
const KEY_TEXT_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Parses the `RELAY_TOKEN_PUBLIC_KEY` value: one or more Ed25519 public keys, each the base64 text of
 * its SPKI DER encoding, separated by commas (current first, then any key being rotated away from).
 *
 * It is base64 of DER rather than PEM on purpose: one line, no newlines to lose in a compose file, a
 * vault or a shell. From an Ed25519 private key in PEM:
 * `openssl pkey -in private.pem -pubout -outform DER | base64 -w0`.
 *
 * Throws `Error` with a reason that never repeats the value.
 */
export function parseTokenKeyring(raw: string): TokenKeyring {
  const entries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  if (entries.length === 0) throw new Error('no public key listed');

  const keys = entries.map((entry, index) => {
    if (!KEY_TEXT_PATTERN.test(entry)) throw new Error(`key ${index + 1} is not base64`);
    try {
      return createPublicKey({ key: Buffer.from(entry, 'base64'), ...SPKI });
    } catch {
      throw new Error(`key ${index + 1} is not an SPKI public key`);
    }
  });
  return tokenKeyringOf(keys);
}
