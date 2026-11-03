import { describe, expect, it } from 'vitest';
import * as relay from '../index.js';
import {
  Actor,
  RELAY_TOKEN_ALGORITHM,
  RELAY_TOKEN_KEY_ID_LENGTH,
  RELAY_TOKEN_TTL_SECONDS,
  RelayTokenClaim,
} from '../index.js';

/** The registered JWT claims (RFC 7519 §4.1): ours must never shadow one of them. */
const REGISTERED_CLAIMS = ['iss', 'sub', 'aud', 'exp', 'nbf', 'iat', 'jti'];

describe('the relay token contract (from @masia/contracts/wire)', () => {
  it('ships no default issuer or audience: both are deployment config (review round 1, M14)', () => {
    const names = Object.keys(relay);
    expect(names).not.toContain('RELAY_TOKEN_ISSUER');
    expect(names).not.toContain('RELAY_TOKEN_AUDIENCE');
    expect(names).not.toContain('DEFAULT_MASIA_OPERATOR_USER_ID');
  });

  it('is signed with EdDSA only, never a shared-secret algorithm', () => {
    expect(RELAY_TOKEN_ALGORITHM).toBe('EdDSA');
  });

  it('lives at most ten minutes (security review 2026-10-10 §4)', () => {
    expect(RELAY_TOKEN_TTL_SECONDS).toBeGreaterThan(0);
    expect(RELAY_TOKEN_TTL_SECONDS).toBeLessThanOrEqual(10 * 60);
  });

  it('adds claims of its own, none of which shadows a registered one', () => {
    const names = Object.values(RelayTokenClaim);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(REGISTERED_CLAIMS).not.toContain(name);
  });

  it('keeps the role claim for the one elevated actor', () => {
    expect(RelayTokenClaim.ROLE).toBe('role');
    expect(Actor.FAMILY_ADMIN).toBe('FAMILY_ADMIN');
  });

  it('keeps the key id long enough to tell keys apart and short enough to read', () => {
    expect(RELAY_TOKEN_KEY_ID_LENGTH).toBeGreaterThanOrEqual(8);
    expect(RELAY_TOKEN_KEY_ID_LENGTH).toBeLessThanOrEqual(32);
  });
});
