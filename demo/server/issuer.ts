import { createHash, createPublicKey, randomUUID, sign, type KeyObject } from 'node:crypto';
import {
  RELAY_TOKEN_ALGORITHM,
  RELAY_TOKEN_KEY_ID_LENGTH,
  RELAY_TOKEN_TTL_SECONDS,
  relayTokenClaims,
  type RelayTokenExpectations,
  type RelayTokenSubject,
} from '@masia/contracts/wire';

// The playground's token issuer: the part of a "host" that the relay needs, and nothing else. The claims
// are `@masia/contracts/wire`'s (`relayTokenClaims` refuses anything the relay would refuse); only the
// JOSE envelope (header, base64url, Ed25519 signature) is written here, with Node's own crypto, so the
// demo needs no JWT library.
//
// DEMO ONLY. A real host decides who may mint which identity; this one gives any visitor a fresh one.

export interface MintedToken {
  readonly token: string;
  /** Milliseconds since the Unix epoch. */
  readonly expiresAt: number;
}

export interface TokenIssuer {
  /** The `kid` the relay finds this key under (first hex characters of SHA-256 of the SPKI DER). */
  readonly kid: string;
  mint(subject: RelayTokenSubject): MintedToken;
}

const MS_PER_SECOND = 1000;

/** The relay's own rule for naming a key, so the header and the keyring agree without a hand-kept name. */
export function tokenKeyId(publicKey: KeyObject): string {
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(spki).digest('hex').slice(0, RELAY_TOKEN_KEY_ID_LENGTH);
}

const base64url = (input: string | Uint8Array): string => Buffer.from(input).toString('base64url');

export function createTokenIssuer(
  privateKey: KeyObject,
  expectations: RelayTokenExpectations,
  now: () => number = Date.now,
): TokenIssuer {
  if (privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('the token key must be an Ed25519 private key');
  }
  const kid = tokenKeyId(createPublicKey(privateKey));
  const header = base64url(JSON.stringify({ alg: RELAY_TOKEN_ALGORITHM, typ: 'JWT', kid }));
  return {
    kid,
    mint(subject) {
      const issuedAt = Math.floor(now() / MS_PER_SECOND);
      const claims = relayTokenClaims(subject, { ...expectations, issuedAt, jti: randomUUID() });
      const signingInput = `${header}.${base64url(JSON.stringify(claims))}`;
      const signature = sign(null, Buffer.from(signingInput), privateKey);
      return {
        token: `${signingInput}.${base64url(signature)}`,
        expiresAt: (issuedAt + RELAY_TOKEN_TTL_SECONDS) * MS_PER_SECOND,
      };
    },
  };
}
