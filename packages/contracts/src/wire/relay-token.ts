import { isWireId } from './vocabulary.js';

/**
 * The relay access token: what it must say, how a host builds its claims and how a relay reads them.
 * ONE home for both sides. Until 2026-10-10 the claim shape lived in the AGPL relay library and the
 * host kept a hand copy (held by a drift test), because a host must not import AGPL code to mint a
 * token (architecture review round 1, M14). Here it is Apache-2.0 and dependency-free: no JOSE, no
 * crypto. Signing and verifying the signature stay with each side's JWT library; the CLAIMS are this.
 *
 * The host mints the token; the relay only VERIFIES it. They share no secret: the host signs with an
 * Ed25519 private key the relay never sees, and the relay holds public keys only. A leaked relay
 * cannot mint an identity, and a token meant for another service cannot be replayed (`aud`).
 *
 * Claims: `{ iss, aud, sub: userId, did: deviceId, role?: 'FAMILY_ADMIN', adminOf?: userId[],
 * guardianOf?: userId[], reach?: userId[], iat, exp, jti }`, JOSE header `{ alg: 'EdDSA', kid }`.
 *
 * `iss` and `aud` are DEPLOYMENT CONFIG, never constants of this protocol: a host and its relay agree
 * on them (`RelayTokenExpectations`), and nothing in the open packages names a default. Until
 * 2026-10-10 the relay defaulted both to the reference host's own names.
 *
 * `did` is the device of the host SESSION the token was minted for, never a value the caller names
 * in a header: otherwise one signed-in account could mint tokens as any of its other devices.
 */

/** The only signature algorithm accepted (Ed25519). Pinning it closes the `alg: none` and HS256 key-confusion class. */
export const RELAY_TOKEN_ALGORITHM = 'EdDSA';

/**
 * The life of a token, in seconds: the host sets `exp = iat + RELAY_TOKEN_TTL_SECONDS`, and the relay
 * refuses a token that claims a longer life, so a host bug cannot quietly mint a long-lived one. A
 * revoked device keeps a valid token until it expires, which is why this is short (the relay also
 * checks the device row on every call).
 */
export const RELAY_TOKEN_TTL_SECONDS = 10 * 60;

/**
 * How far the relay's clock may disagree with the host's when it checks `iat` and `exp`. Without it
 * a host clock a second ahead makes every fresh token "issued in the future" on the relay. A client
 * renews a token at least this long before it runs out.
 */
export const RELAY_TOKEN_CLOCK_TOLERANCE_SECONDS = 30;

/** Claim names beyond the registered ones (`iss`, `aud`, `sub`, `iat`, `exp`, `jti`). */
export const RelayTokenClaim = {
  /** The install that holds the MLS leaves. */
  DEVICE: 'did',
  /** `Actor.FAMILY_ADMIN` or absent. */
  ROLE: 'role',
  /** The users a family admin administers, never the admin; see `administersUser`. */
  ADMIN_OF: 'adminOf',
  /** The minors a family admin is a guardian of; see `guardsUser`. */
  GUARDIAN_OF: 'guardianOf',
  /** The host's INTRODUCTIONS: users this caller may look up before sharing a room; see `introducedTo`. */
  REACH: 'reach',
} as const;

/** The registered claims a relay requires on every token. */
export const RELAY_TOKEN_REQUIRED_CLAIMS = ['iss', 'aud', 'sub', 'iat', 'exp'] as const;

/**
 * How a key is named in the JOSE `kid` header: the first this-many hex characters of the SHA-256 of
 * the public key's SPKI DER. Both sides derive it from the key itself, so rotating a key needs no
 * hand-kept name: list the new public key next to the old one on the relay, switch the host's
 * signing key, and drop the old public key once the last token it signed has expired.
 */
export const RELAY_TOKEN_KEY_ID_LENGTH = 16;

// --- Who is acting --------------------------------------------------------------------------------

/**
 * The only elevated actor: a family admin. It comes from the TOKEN, never from a request body, so a
 * client cannot claim it. The household is part of this protocol (a guardian is a parent who may
 * read a minor's rooms, and every member sees that), so "family admin" is a protocol word, not a
 * product's.
 *
 * The marker alone grants NOTHING: an admin is an admin of specific users (`adminOf`), see
 * `administersUser`.
 */
export const Actor = {
  FAMILY_ADMIN: 'FAMILY_ADMIN',
} as const;
export type Actor = (typeof Actor)[keyof typeof Actor];

/** What a token says about elevated rights: the marker plus the users it covers. */
export interface AdminScope {
  readonly actor: Actor | null;
  /**
   * User ids the actor administers (the `adminOf` claim). Meaningless without the marker. A host
   * never lists the admin themself, with one exception: the OPERATOR principal (the account that
   * owns every ASSISTANT device) is minted with `adminOf = [itself]`, so an assistant device can
   * retire itself.
   */
  readonly adminOf: readonly string[];
  /**
   * The MINORS the actor is a guardian of (the `guardianOf` claim): the accounts on which this admin
   * may enrol and drive a GUARDIAN device. Never the admin, never another adult. A subset of
   * `adminOf` in practice, kept as its own claim so that administering an adult never lets anyone
   * plant a silent guardian leaf in that adult's rooms.
   */
  readonly guardianOf: readonly string[];
}

/** The scope of a caller with no elevated rights, and of internal operations. */
export const NO_ADMIN_SCOPE: AdminScope = { actor: null, adminOf: [], guardianOf: [] };

/** Most users one admin token may cover, in `adminOf` and in `guardianOf` each. A family is a handful. */
export const MAX_ADMIN_OF_USERS = 64;

/**
 * Most users one token may be introduced to (the `reach` claim). Bounded so a token stays a header,
 * and so an introduction is a short list the host chose, never a directory.
 */
export const MAX_REACH_USERS = 64;

/**
 * Has the host introduced this caller to `userId` (the `reach` claim)? The relay's own notion of a
 * contact is a shared room; the FIRST Add between two people who share none needs the host, which
 * knows families and contacts, to vouch for it. A reach grant lets the caller read the target's
 * PUBLIC directory (devices, signed device list) and claim a key package, nothing more: it is no
 * admin right and works without the admin marker. It lives as long as the token
 * (`RELAY_TOKEN_TTL_SECONDS`), so the next token drops a person the host no longer introduces.
 */
export function introducedTo(scope: { readonly reach: readonly string[] }, userId: string): boolean {
  return scope.reach.includes(userId);
}

/**
 * Does this caller administer `userId`? The ONE rule behind every admin-only action (removing a
 * guardian leaf, registering a non-USER device, revoking another user's device). A relay serves many
 * households: the admin's reach is the user ids the host listed, never the marker on its own.
 */
export function administersUser(
  scope: Pick<AdminScope, 'actor' | 'adminOf'>,
  userId: string,
): boolean {
  return scope.actor === Actor.FAMILY_ADMIN && scope.adminOf.includes(userId);
}

/**
 * Is this caller a guardian of `userId`? The rule behind enrolling a GUARDIAN device on a minor's
 * account, and behind one guardian device of a minor removing another. Like `administersUser`, the
 * marker alone grants nothing.
 */
export function guardsUser(
  scope: Pick<AdminScope, 'actor' | 'guardianOf'>,
  userId: string,
): boolean {
  return scope.actor === Actor.FAMILY_ADMIN && scope.guardianOf.includes(userId);
}

// --- Building and reading the claims ----------------------------------------------------------------

/**
 * Where a token comes from and who it is for. Deployment config on both sides (the relay reads
 * `RELAY_TOKEN_ISSUER` / `RELAY_TOKEN_AUDIENCE`); a host and its relay must be given the same pair.
 */
export interface RelayTokenExpectations {
  readonly issuer: string;
  readonly audience: string;
}

/** Whom a token is for: the account, its device, and the users it may act for beyond itself. */
export interface RelayTokenSubject {
  readonly userId: string;
  readonly deviceId: string;
  /** Empty for a caller who administers nobody. */
  readonly adminOf: readonly string[];
  /** Empty for a caller who guards nobody. */
  readonly guardianOf: readonly string[];
  /** Users the host introduces the caller to (`introducedTo`); absent or empty for none. */
  readonly reach?: readonly string[];
}

/** The claim set, exactly as it is signed. */
export interface RelayTokenClaims {
  readonly iss: string;
  readonly aud: string;
  readonly sub: string;
  readonly did: string;
  readonly iat: number;
  readonly exp: number;
  readonly jti: string;
  readonly role?: Actor;
  readonly adminOf?: readonly string[];
  readonly guardianOf?: readonly string[];
  readonly reach?: readonly string[];
}

/** What a relay knows about its caller once the claims are read: the principal. */
export interface RelayTokenPrincipal extends AdminScope {
  readonly userId: string;
  readonly deviceId: string;
  /** The users the host introduced this caller to (`introducedTo`); empty when none. */
  readonly reach: readonly string[];
}

/** Why a claim set was refused. Stable, for tests and logs; a relay answers every one the same way. */
export const RelayTokenClaimsErrorReason = {
  BAD_EXPECTATIONS: 'BAD_EXPECTATIONS',
  WRONG_ISSUER: 'WRONG_ISSUER',
  WRONG_AUDIENCE: 'WRONG_AUDIENCE',
  BAD_LIFETIME: 'BAD_LIFETIME',
  BAD_SUBJECT: 'BAD_SUBJECT',
  BAD_DEVICE: 'BAD_DEVICE',
  BAD_ROLE: 'BAD_ROLE',
  BAD_USER_LIST: 'BAD_USER_LIST',
} as const;
export type RelayTokenClaimsErrorReason =
  (typeof RelayTokenClaimsErrorReason)[keyof typeof RelayTokenClaimsErrorReason];

/** The one error `relayTokenClaims` and `readRelayTokenClaims` throw. Its message names no value. */
export class RelayTokenClaimsError extends Error {
  readonly reason: RelayTokenClaimsErrorReason;

  constructor(reason: RelayTokenClaimsErrorReason) {
    super(`Relay token claims refused (${reason}).`);
    this.name = 'RelayTokenClaimsError';
    this.reason = reason;
  }
}

function assertExpectations(expect: RelayTokenExpectations): void {
  if (
    typeof expect.issuer !== 'string' ||
    typeof expect.audience !== 'string' ||
    expect.issuer.trim() === '' ||
    expect.audience.trim() === ''
  ) {
    throw new RelayTokenClaimsError(RelayTokenClaimsErrorReason.BAD_EXPECTATIONS);
  }
}

function assertUserList(users: readonly string[], max: number = MAX_ADMIN_OF_USERS): void {
  if (users.length > max || !users.every(isWireId)) {
    throw new RelayTokenClaimsError(RelayTokenClaimsErrorReason.BAD_USER_LIST);
  }
}

/**
 * The claims a host signs for `subject`: `exp = iat + RELAY_TOKEN_TTL_SECONDS`, and `role` +
 * `adminOf` (+ `guardianOf` when not empty) only for a caller who administers someone. Refuses (with
 * `RelayTokenClaimsError`) anything a relay would refuse, so a host bug fails at minting, not at
 * the relay. `issuedAt` is in seconds since the Unix epoch; `jti` is the caller's random id.
 */
export function relayTokenClaims(
  subject: RelayTokenSubject,
  options: RelayTokenExpectations & { readonly issuedAt: number; readonly jti: string },
): RelayTokenClaims {
  assertExpectations(options);
  if (!isWireId(subject.userId)) {
    throw new RelayTokenClaimsError(RelayTokenClaimsErrorReason.BAD_SUBJECT);
  }
  if (!isWireId(subject.deviceId)) {
    throw new RelayTokenClaimsError(RelayTokenClaimsErrorReason.BAD_DEVICE);
  }
  if (!Number.isSafeInteger(options.issuedAt) || options.issuedAt < 0) {
    throw new RelayTokenClaimsError(RelayTokenClaimsErrorReason.BAD_LIFETIME);
  }
  assertUserList(subject.adminOf);
  assertUserList(subject.guardianOf);
  const reach = (subject.reach ?? []).filter((user) => user !== subject.userId);
  assertUserList(reach, MAX_REACH_USERS);
  const isAdmin = subject.adminOf.length > 0 || subject.guardianOf.length > 0;
  return {
    iss: options.issuer,
    aud: options.audience,
    sub: subject.userId,
    did: subject.deviceId,
    iat: options.issuedAt,
    exp: options.issuedAt + RELAY_TOKEN_TTL_SECONDS,
    jti: options.jti,
    ...(isAdmin
      ? {
          role: Actor.FAMILY_ADMIN,
          adminOf: [...subject.adminOf],
          ...(subject.guardianOf.length > 0 ? { guardianOf: [...subject.guardianOf] } : {}),
        }
      : {}),
    ...(reach.length > 0 ? { reach: [...new Set(reach)] } : {}),
  };
}

/**
 * A user-list claim (`adminOf`, `guardianOf`). Absent means none. Anything else that is not
 * understood (not an array of ids, too many, or present without the admin role) is refused: a token
 * with a malformed grant must not quietly become a token with a narrower one.
 */
function readUserList(
  value: unknown,
  isAdmin: boolean,
  max: number = MAX_ADMIN_OF_USERS,
): readonly string[] {
  if (value === undefined) return [];
  if (!isAdmin || !Array.isArray(value) || value.length > max) {
    throw new RelayTokenClaimsError(RelayTokenClaimsErrorReason.BAD_USER_LIST);
  }
  const users: string[] = [];
  for (const item of value as unknown[]) {
    if (!isWireId(item)) throw new RelayTokenClaimsError(RelayTokenClaimsErrorReason.BAD_USER_LIST);
    users.push(item);
  }
  return users;
}

/**
 * Reads the claims of a token whose SIGNATURE and time window the caller has already checked (a
 * relay runs its JWT library first: algorithm pinned, `kid` from its keyring, `exp`/`iat` against
 * its clock with `RELAY_TOKEN_CLOCK_TOLERANCE_SECONDS`). This is the rest:
 *
 * - `iss` and `aud` must equal the configured ones; `aud` must be the plain string, not a list that
 *   merely contains it;
 * - `iat` and `exp` are numbers and `exp - iat` is at most `RELAY_TOKEN_TTL_SECONDS`;
 * - `sub` and `did` are ids;
 * - a `role` other than FAMILY_ADMIN is refused rather than ignored;
 * - `adminOf` / `guardianOf` as `readUserList` says;
 * - `reach` the same way, but on ANY token (an introduction is no admin right), at most
 *   `MAX_REACH_USERS`.
 *
 * Throws `RelayTokenClaimsError` and nothing else.
 */
export function readRelayTokenClaims(
  payload: Readonly<Record<string, unknown>>,
  expect: RelayTokenExpectations,
): RelayTokenPrincipal {
  assertExpectations(expect);
  if (payload['iss'] !== expect.issuer) {
    throw new RelayTokenClaimsError(RelayTokenClaimsErrorReason.WRONG_ISSUER);
  }
  if (payload['aud'] !== expect.audience) {
    throw new RelayTokenClaimsError(RelayTokenClaimsErrorReason.WRONG_AUDIENCE);
  }
  const iat = payload['iat'];
  const exp = payload['exp'];
  if (typeof iat !== 'number' || typeof exp !== 'number' || exp - iat > RELAY_TOKEN_TTL_SECONDS) {
    throw new RelayTokenClaimsError(RelayTokenClaimsErrorReason.BAD_LIFETIME);
  }
  const sub = payload['sub'];
  const did = payload[RelayTokenClaim.DEVICE];
  if (!isWireId(sub)) throw new RelayTokenClaimsError(RelayTokenClaimsErrorReason.BAD_SUBJECT);
  if (!isWireId(did)) throw new RelayTokenClaimsError(RelayTokenClaimsErrorReason.BAD_DEVICE);
  const role = payload[RelayTokenClaim.ROLE];
  if (role !== undefined && role !== Actor.FAMILY_ADMIN) {
    throw new RelayTokenClaimsError(RelayTokenClaimsErrorReason.BAD_ROLE);
  }
  const isAdmin = role === Actor.FAMILY_ADMIN;
  return {
    userId: sub,
    deviceId: did,
    actor: isAdmin ? Actor.FAMILY_ADMIN : null,
    adminOf: readUserList(payload[RelayTokenClaim.ADMIN_OF], isAdmin),
    guardianOf: readUserList(payload[RelayTokenClaim.GUARDIAN_OF], isAdmin),
    reach: readUserList(payload[RelayTokenClaim.REACH], true, MAX_REACH_USERS),
  };
}
