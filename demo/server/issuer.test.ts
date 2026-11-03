import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  RELAY_TOKEN_ALGORITHM,
  RELAY_TOKEN_KEY_ID_LENGTH,
  RELAY_TOKEN_TTL_SECONDS,
  RelayTokenClaimsError,
  readRelayTokenClaims,
  type RelayTokenSubject,
} from '@masia/contracts/wire';
import { createTokenIssuer, tokenKeyId } from './issuer.js';

const EXPECTATIONS = { issuer: 'playground-web', audience: 'playground-relay' } as const;
const NOW_MS = Date.UTC(2026, 9, 10, 12, 0, 0);

const subject: RelayTokenSubject = {
  userId: 'u-alice',
  deviceId: 'd-alice',
  adminOf: [],
  guardianOf: [],
  reach: ['u-bob', 'u-carol'],
};

function decode(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
}

describe('the playground token issuer', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const issuer = createTokenIssuer(privateKey, EXPECTATIONS, () => NOW_MS);

  it('signs a token the relay\'s own check accepts: EdDSA, the key id, claims read by the wire vocabulary', () => {
    const { token } = issuer.mint(subject);
    const [header, payload, signature] = token.split('.') as [string, string, string];

    expect(decode(header)).toEqual({ alg: RELAY_TOKEN_ALGORITHM, typ: 'JWT', kid: issuer.kid });
    expect(verify(null, Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, 'base64url'))).toBe(
      true,
    );

    const principal = readRelayTokenClaims(decode(payload), EXPECTATIONS);
    expect(principal).toMatchObject({
      userId: 'u-alice',
      deviceId: 'd-alice',
      actor: null,
      adminOf: [],
      guardianOf: [],
      reach: ['u-bob', 'u-carol'],
    });
  });

  it('names the key the way the relay names its keyring: a prefix of the SPKI hash', () => {
    expect(issuer.kid).toBe(tokenKeyId(createPublicKey(privateKey)));
    expect(issuer.kid).toMatch(new RegExp(`^[0-9a-f]{${RELAY_TOKEN_KEY_ID_LENGTH}}$`));
    expect(tokenKeyId(generateKeyPairSync('ed25519').publicKey)).not.toBe(issuer.kid);
  });

  it('expires after the wire\'s lifetime and says when, in milliseconds', () => {
    const minted = issuer.mint(subject);
    const claims = decode(minted.token.split('.')[1] as string);
    expect(claims['iat']).toBe(NOW_MS / 1000);
    expect(claims['exp']).toBe(NOW_MS / 1000 + RELAY_TOKEN_TTL_SECONDS);
    expect(minted.expiresAt).toBe(NOW_MS + RELAY_TOKEN_TTL_SECONDS * 1000);
  });

  it('gives every token its own id', () => {
    const first = decode(issuer.mint(subject).token.split('.')[1] as string);
    const second = decode(issuer.mint(subject).token.split('.')[1] as string);
    expect(first['jti']).not.toBe(second['jti']);
  });

  it('a signature from another key does not verify', () => {
    const { token } = issuer.mint(subject);
    const [header, payload, signature] = token.split('.') as [string, string, string];
    const stranger = generateKeyPairSync('ed25519').publicKey;
    expect(verify(null, Buffer.from(`${header}.${payload}`), stranger, Buffer.from(signature, 'base64url'))).toBe(
      false,
    );
  });

  it('fails at minting, not at the relay, for a subject the wire would refuse', () => {
    expect(() => issuer.mint({ ...subject, userId: 'not a wire id' })).toThrow(RelayTokenClaimsError);
    expect(() => issuer.mint({ ...subject, reach: ['has space'] })).toThrow(RelayTokenClaimsError);
  });

  it('accepts only an Ed25519 private key', () => {
    expect(() => createTokenIssuer(publicKey, EXPECTATIONS)).toThrow(/Ed25519 private key/);
    const other = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
    expect(() => createTokenIssuer(other, EXPECTATIONS)).toThrow(/Ed25519 private key/);
  });
});
