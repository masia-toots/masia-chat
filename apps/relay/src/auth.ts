import {
  DeviceRole,
  guardsUser,
  readRelayTokenClaims,
  RELAY_TOKEN_ALGORITHM,
  RELAY_TOKEN_CLOCK_TOLERANCE_SECONDS,
  RELAY_TOKEN_TTL_SECONDS,
  RelayError,
  RelayErrorCode,
  type RelayTokenExpectations,
  type RelayTokenPrincipal,
} from '@masia/relay';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { jwtVerify } from 'jose';
import type { Database } from './db.js';
import type { TokenKeyring } from './token-keys.js';

/**
 * Who is calling, as the host API vouches for it in the access token. Issuing the token is the host
 * API's job (step K4a); the relay only VERIFIES it, with public keys. A device — not a session — is
 * the anchor: `deviceId` is the install that holds the MLS leaves (ADR-117 §2).
 *
 * It IS an `AdminScope` (`actor` + `adminOf` + `guardianOf`): all come from the token and from
 * nowhere else, and every admin-only rule asks `administersUser` or `guardsUser`, never `actor` on
 * its own.
 *
 * `userId` is the account that holds the token. The device usually belongs to that account too; the
 * one exception is a GUARDIAN device, which belongs to the MINOR it guards and is driven by the
 * guardian's token (ADR-117 §4: the guardian leaf carries the child's user id).
 */
export type Principal = RelayTokenPrincipal;

/**
 * What a token must say about where it comes from and who it is for: relay config (config.ts,
 * REQUIRED, no default). The shape is the token contract's, `@masia/contracts/wire`.
 */
export type TokenExpectations = RelayTokenExpectations;

export interface VerifyOptions {
  readonly expect: TokenExpectations;
  /** Injected so tests can move time; the relay's clock otherwise. */
  readonly now?: () => number;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the `authenticate` hooks; read it through `principalOf`. */
    principal: Principal | null;
  }
}

function unauthenticated(): RelayError {
  // One message for every cause (missing, malformed, expired, wrong signature, wrong issuer or
  // audience, unknown key): the reason is useful to an attacker probing the keys and to nobody else.
  return new RelayError(RelayErrorCode.UNAUTHENTICATED, 'A valid bearer token is required.');
}

/**
 * Verifies an EdDSA (Ed25519) JWT minted by the host API:
 * `{ iss, aud, sub: userId, did: deviceId, role?: 'FAMILY_ADMIN', adminOf?: userId[],
 *    guardianOf?: userId[], iat, exp, jti }`
 * with the key named by its `kid` header taken from `keyring`.
 *
 * Two halves. The SIGNATURE and the time window are checked here with JOSE:
 * - the algorithm is pinned to EdDSA: there is no shared secret to confuse a key with, and
 *   `alg: none` and HS256 tokens are refused;
 * - `exp` and `iat` are compared with this relay's clock allowing
 *   `RELAY_TOKEN_CLOCK_TOLERANCE_SECONDS` of skew either way.
 *
 * The CLAIMS are read by the token contract's `readRelayTokenClaims` (`@masia/contracts/wire`, the
 * same module the host builds them with): `iss`/`aud` equal the configured pair (`aud` the plain
 * string), `exp - iat` at most `RELAY_TOKEN_TTL_SECONDS`, `sub`/`did` ids, no `role` other than
 * FAMILY_ADMIN, and well-formed user lists only on an admin token.
 *
 * `role: FAMILY_ADMIN` alone grants nothing: the admin's reach is `adminOf` (and, for guardian
 * devices, `guardianOf`), the users the host lists (security review 2026-10-10 §4: a bare marker
 * made the admin of family A an admin of every family on the relay).
 *
 * Every failure throws the same `UNAUTHENTICATED` error.
 */
export async function verifyAccessToken(
  token: string,
  keyring: TokenKeyring,
  options: VerifyOptions,
): Promise<Principal> {
  const expected = options.expect;
  let payload;
  try {
    ({ payload } = await jwtVerify(
      token,
      (header) => {
        // A missing or unknown `kid` is refused: the relay never guesses which key to try.
        const key = keyring.keyFor(header.kid);
        if (key === undefined) throw new Error('unknown key');
        return key;
      },
      {
        algorithms: [RELAY_TOKEN_ALGORITHM],
        issuer: expected.issuer,
        audience: expected.audience,
        requiredClaims: ['sub', 'exp', 'iat'],
        clockTolerance: RELAY_TOKEN_CLOCK_TOLERANCE_SECONDS,
        // With a maximum age, `iat` is checked too: not further in the future than the tolerance.
        maxTokenAge: RELAY_TOKEN_TTL_SECONDS,
        ...(options.now === undefined ? {} : { currentDate: new Date(options.now()) }),
      },
    ));
  } catch {
    throw unauthenticated();
  }

  try {
    return readRelayTokenClaims(payload, expected);
  } catch {
    throw unauthenticated();
  }
}

const BEARER_PREFIX = 'Bearer ';

function bearerToken(header: string | undefined): string {
  if (header === undefined || !header.startsWith(BEARER_PREFIX)) throw unauthenticated();
  const token = header.slice(BEARER_PREFIX.length).trim();
  if (token === '') throw unauthenticated();
  return token;
}

/** The caller of an authenticated route. Throws if the route forgot its auth hook. */
export function principalOf(request: FastifyRequest): Principal {
  if (request.principal === null) throw unauthenticated();
  return request.principal;
}

/**
 * A body names the device that is acting (`senderDeviceId`); the token says which device really is.
 * They must agree: otherwise any device of a user could post as another and a leaf could be framed.
 */
export function assertActingAs(principal: Principal, deviceId: string): void {
  if (deviceId !== principal.deviceId) {
    throw new RelayError(
      RelayErrorCode.DEVICE_MISMATCH,
      'The sender device must be the device the token was issued to.',
    );
  }
}

export type AuthHook = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface AuthHooks {
  /** The token is valid. Enough for registering a device: it does not exist yet. */
  readonly authenticate: AuthHook;
  /**
   * The token is valid AND its device is registered, not revoked, and the token's to drive: a device
   * of the token's own user, or a GUARDIAN device of a minor the token lists in `guardianOf`. A
   * revoked device keeps a valid token until it expires; this is what cuts it off the moment it is
   * revoked.
   */
  readonly requireActiveDevice: AuthHook;
}

export interface AuthHookOptions {
  readonly keyring: TokenKeyring;
  readonly db: Database;
  readonly expect: TokenExpectations;
  readonly now?: () => number;
}

/** May the token's principal drive this device row? The rule `requireActiveDevice` applies. */
export function drivesDevice(
  principal: Principal,
  device: { readonly userId: string; readonly role: DeviceRole },
): boolean {
  if (device.userId === principal.userId) return true;
  return device.role === DeviceRole.GUARDIAN && guardsUser(principal, device.userId);
}

export function createAuthHooks(options: AuthHookOptions): AuthHooks {
  const authenticate: AuthHook = async (request) => {
    request.principal = await verifyAccessToken(
      bearerToken(request.headers.authorization),
      options.keyring,
      { expect: options.expect, now: options.now },
    );
  };

  const requireActiveDevice: AuthHook = async (request, reply) => {
    await authenticate(request, reply);
    const principal = principalOf(request);
    const { rows } = await options.db.query<{ revoked: boolean; userId: string; role: DeviceRole }>(
      'SELECT revoked_at IS NOT NULL AS revoked, user_id AS "userId", role FROM devices WHERE id = $1',
      [principal.deviceId],
    );
    const found = rows[0];
    // A device of another account answers exactly like a missing one: ids are not a directory.
    const device = found !== undefined && drivesDevice(principal, found) ? found : undefined;
    if (device === undefined) {
      throw new RelayError(
        RelayErrorCode.ACTOR_DEVICE_UNKNOWN,
        'This device is not registered for this user; register it first.',
      );
    }
    if (device.revoked) {
      throw new RelayError(RelayErrorCode.ACTOR_DEVICE_REVOKED, 'This device has been revoked.');
    }
  };

  return { authenticate, requireActiveDevice };
}
