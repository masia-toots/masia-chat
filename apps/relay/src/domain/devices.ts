import { createHash } from 'node:crypto';
import {
  administersUser,
  DeviceRole,
  guardsUser,
  IDENTITY_RESET_TICKET_TTL_MS,
  introducedTo,
  RelayError,
  RelayErrorCode,
  verifyHolderProof,
  verifyIdentityRebindSignature,
} from '@masia/relay';
import type { Principal } from '../auth.js';
import type { Database, Queryable } from '../db.js';
import { toBase64 } from '../dto.js';
import { LookupCharge, type LookupLimiter } from './lookup-limits.js';

/**
 * The ADR-117 §2 device: a first-class record per install. A session token is never the anchor
 * (tokens rotate; MLS leaves must not), so everything here keys on `Device.id`.
 */
export interface DeviceRow {
  readonly id: string;
  readonly userId: string;
  readonly role: DeviceRole;
  readonly name: string | null;
  readonly platform: string | null;
  readonly identityKeyPub: Buffer;
  readonly signatureKeyPub: Buffer;
  readonly createdAt: Date;
  readonly lastSeenAt: Date | null;
  readonly revokedAt: Date | null;
  /** ADR-218 §5: the device's proof that it holds the identity key, as stored (`putHolderProof`). */
  readonly holderProof: Buffer | null;
}

/** The one column list for `devices`, so every query returns the same camelCase shape. */
export const DEVICE_COLUMNS = `id, user_id AS "userId", role, name, platform,
  identity_key_pub AS "identityKeyPub", signature_key_pub AS "signatureKeyPub",
  created_at AS "createdAt", last_seen_at AS "lastSeenAt", revoked_at AS "revokedAt",
  holder_proof AS "holderProof"`;

export async function findDevice(q: Queryable, id: string): Promise<DeviceRow | null> {
  const { rows } = await q.query<DeviceRow>(`SELECT ${DEVICE_COLUMNS} FROM devices WHERE id = $1`, [
    id,
  ]);
  return rows[0] ?? null;
}

/** Devices a peer may still target: not revoked, oldest first (a stable order for clients). */
export async function listActiveDevices(q: Queryable, userId: string): Promise<DeviceRow[]> {
  const { rows } = await q.query<DeviceRow>(
    `SELECT ${DEVICE_COLUMNS} FROM devices
     WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at, id`,
    [userId],
  );
  return rows;
}

/**
 * Does `viewerDeviceId` share a room with any device of `targetUserId`, now or in the past? The
 * relay's only notion of "contact": two parties that were ever in one room already know each other's
 * devices from the group's own tree.
 */
export async function sharesRoomWith(
  q: Queryable,
  viewerDeviceId: string,
  targetUserId: string,
): Promise<boolean> {
  const { rows } = await q.query<{ shared: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM room_members mine
       JOIN room_members theirs ON theirs.conversation_id = mine.conversation_id
       JOIN devices d ON d.id = theirs.device_id
       WHERE mine.device_id = $1 AND d.user_id = $2
     ) AS shared`,
    [viewerDeviceId, targetUserId],
  );
  return rows[0]?.shared ?? false;
}

/**
 * How much of ANOTHER user's directory a caller may see: `FULL` rows (labels, timestamps) or the
 * `PUBLIC` part only (id, role, keys). The signed device list and a key-package claim have no
 * smaller form, so for them any reach is "may read".
 */
export const LookupReach = {
  FULL: 'FULL',
  PUBLIC: 'PUBLIC',
} as const;
export type LookupReach = (typeof LookupReach)[keyof typeof LookupReach];

/** What the contact gate lets a caller see of a target, and what the lookup costs it (`LookupCharge`). */
export interface LookupAccess {
  readonly reach: LookupReach;
  readonly charge: LookupCharge;
}

/**
 * THE contact gate (security review round 2, M5): the ONE predicate every read of another user's
 * directory asks — `GET /users/:userId/devices`, `GET /users/:userId/device-list` and
 * `POST /key-packages/claim`. Without it any registered device could walk user ids and learn who
 * exists, which devices they hold and that a child account exists with a GUARDIAN leaf on it.
 *
 *  - yourself, or a user your token administers (`adminOf`: the host names them, at most
 *    `MAX_ADMIN_OF_USERS`) → FULL, free of charge: nothing here can be walked;
 *  - a contact (`sharesRoomWith`: the calling device shares or shared a room with one of the
 *    target's devices) → PUBLIC, free of charge: the caller already knows these devices from the
 *    group's own tree, and an open client re-reads them every minute;
 *  - the operator principal (`RELAY_OPERATOR_USER_ID`) → PUBLIC to every device: it is the system
 *    account that owns every ASSISTANT device, not a person, and its signed list is exactly what a
 *    member verifies before adding the assistant to a room it was never in. Charged to the caller
 *    only: everybody reads it, so a shared target budget would be one user's lever on all the rest;
 *  - an introduction (`introducedTo`: the token's `reach` claim — the host, which knows families and
 *    contacts, vouches for a FIRST Add between two people who share no room yet) → PUBLIC,
 *    charged to the caller and the target. It lives as long as the token and grants no admin right;
 *  - anyone else → 403 NOT_A_CONTACT, the same answer for a user who exists and one who does not.
 */
export async function lookupAccess(
  q: Queryable,
  principal: Principal,
  targetUserId: string,
  operatorUserId: string | null,
): Promise<LookupAccess> {
  if (targetUserId === principal.userId || administersUser(principal, targetUserId)) {
    return { reach: LookupReach.FULL, charge: LookupCharge.NONE };
  }
  if (await sharesRoomWith(q, principal.deviceId, targetUserId)) {
    return { reach: LookupReach.PUBLIC, charge: LookupCharge.NONE };
  }
  if (operatorUserId !== null && targetUserId === operatorUserId) {
    return { reach: LookupReach.PUBLIC, charge: LookupCharge.ACTOR };
  }
  if (introducedTo(principal, targetUserId)) {
    return { reach: LookupReach.PUBLIC, charge: LookupCharge.ACTOR_AND_TARGET };
  }
  throw new RelayError(
    RelayErrorCode.NOT_A_CONTACT,
    'This device shares no room with that user; ask the host for an introduction first.',
  );
}

/** The gate alone, for a caller that keeps its own budgets (the key-package claim). */
export async function lookupReach(
  q: Queryable,
  principal: Principal,
  targetUserId: string,
  operatorUserId: string | null,
): Promise<LookupReach> {
  return (await lookupAccess(q, principal, targetUserId, operatorUserId)).reach;
}

/**
 * Admits a read of another user's directory: the contact gate, then the lookup budget it prices
 * (`lookupAccess`). The gate comes first because what a lookup costs depends on who is asking: a
 * contact's is free, a stranger's is refused and charged to the stranger alone (a walk through the
 * user-id space still stops after one budget: 429 ACTOR_RATE_LIMITED replaces the 403 once spent).
 * Returns how much of the target's directory the caller may see.
 */
export async function admitLookup(
  q: Queryable,
  limiter: LookupLimiter,
  principal: Principal,
  targetUserId: string,
  operatorUserId: string | null,
): Promise<LookupReach> {
  let access: LookupAccess;
  try {
    access = await lookupAccess(q, principal, targetUserId, operatorUserId);
  } catch (error) {
    if (error instanceof RelayError && error.code === RelayErrorCode.NOT_A_CONTACT) {
      limiter.charge(principal.userId, targetUserId, LookupCharge.ACTOR);
    }
    throw error;
  }
  limiter.charge(principal.userId, targetUserId, access.charge);
  return access.reach;
}

export interface RegisterDeviceInput {
  readonly id: string;
  /**
   * The account the device will belong to. The token's own user, except for a GUARDIAN device,
   * which belongs to the minor it guards (ADR-117 §4: the guardian leaf carries the child's id).
   */
  readonly userId: string;
  readonly role: DeviceRole;
  readonly name: string | null;
  readonly platform: string | null;
  readonly identityKeyPub: Buffer;
  readonly signatureKeyPub: Buffer;
  /**
   * Only for the device an operator reset names, pinning its new key (ADR-218 §6): its registered device
   * key's signature over `identityRebindBytes` (the account, itself, the new key, the reset). Ignored
   * everywhere else.
   */
  readonly rebindSignature?: Buffer | null;
}

/** Relay configuration the registration rule needs. */
export interface RegistrationPolicy {
  /** The account that owns every ASSISTANT device (config.ts, `RELAY_OPERATOR_USER_ID`); `null`: none. */
  readonly operatorUserId: string | null;
}

/**
 * May `principal` register a device of `role` for `account`? One rule per role, all from the
 * token, never the body (ADR-117 §3, §4; review round 1, 2026-10-10):
 *  - USER: the token's own account.
 *  - GUARDIAN: an account that is NOT the token's own and that the token lists in `guardianOf` (the
 *    minors the guardian administers). A guardian leaf is a statement about a child's rooms; a
 *    plain device printing that badge, or an admin printing it for a stranger, is refused.
 *  - ASSISTANT: only the operator principal, for its own account; none when no operator is
 *    configured. No family admin can enrol an assistant.
 */
export function mayRegister(
  principal: Principal,
  role: DeviceRole,
  account: string,
  policy: RegistrationPolicy,
): boolean {
  switch (role) {
    case DeviceRole.USER:
      return account === principal.userId;
    case DeviceRole.GUARDIAN:
      return account !== principal.userId && guardsUser(principal, account);
    case DeviceRole.ASSISTANT:
      return (
        policy.operatorUserId !== null &&
        principal.userId === policy.operatorUserId &&
        account === principal.userId
      );
    default:
      return false;
  }
}

/** The identity key pinned for a person (`identity_keys`), or `null` when none is pinned. */
export async function findIdentityKey(q: Queryable, userId: string): Promise<Buffer | null> {
  const { rows } = await q.query<{ identityKeyPub: Buffer }>(
    'SELECT identity_key_pub AS "identityKeyPub" FROM identity_keys WHERE user_id = $1',
    [userId],
  );
  return rows[0]?.identityKeyPub ?? null;
}

/** The advisory-lock namespace of an account's identity key: one lock per account (`lockIdentityKey`). */
const IDENTITY_LOCK_PREFIX = 'relay:identity-key:';

/**
 * Takes the account's identity lock for the rest of the transaction, then its pin FOR UPDATE, and
 * returns the pin (`null`: none). Everything that MOVES a pin holds this lock first: the registration
 * of a USER or ASSISTANT device (which may pin, or follow, the key) and every release
 * (`releaseIdentityKey`). A row lock alone cannot serialize them: once a reset has deleted the pin
 * there is no row left to lock, so a registration that found no ticket a moment before the reset
 * committed could pin a key past it. A transaction-scoped advisory lock keyed by the account closes
 * that gap; COMMIT or ROLLBACK releases it. Lock order everywhere: this lock, the pin, the list,
 * identity requests, device rows.
 */
export async function lockIdentityKey(tx: Queryable, userId: string): Promise<Buffer | null> {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `${IDENTITY_LOCK_PREFIX}${userId}`,
  ]);
  const { rows } = await tx.query<{ identityKeyPub: Buffer }>(
    'SELECT identity_key_pub AS "identityKeyPub" FROM identity_keys WHERE user_id = $1 FOR UPDATE',
    [userId],
  );
  return rows[0]?.identityKeyPub ?? null;
}

/** Who released an account's identity key (`identity_resets.actor`, ADR-218 §6). */
export const IdentityResetActor = {
  /** The operator CLI, run on the relay's own machine (`apps/relay/scripts/identity-reset.ts`). */
  OPERATOR: 'OPERATOR',
  /** A family admin, through `DELETE /users/:userId/identity-key` (`resetIdentityKey`). */
  FAMILY_ADMIN: 'FAMILY_ADMIN',
} as const;
export type IdentityResetActor = (typeof IdentityResetActor)[keyof typeof IdentityResetActor];

/**
 * The longest note an `identity_resets` row keeps. The migration `identity_resets` holds the same
 * number as a CHECK (`identity_resets_reason_check`); a test proves the two agree.
 */
export const IDENTITY_RESET_REASON_MAX_LENGTH = 200;

/**
 * An account's open operator ticket (ADR-218 §6): while it is open, only `firstDeviceId` may pin the
 * account's next identity key. Closed when that device pins (`pinned_at`) or a later reset replaces
 * it (`superseded_at`); at most one is open per account (a partial unique index).
 *
 * A ticket lives `IDENTITY_RESET_TICKET_TTL_MS` from the reset. Past it, it counts as superseded:
 * `expired` is true, and NOBODY pins (409 IDENTITY_RESET_PENDING), the named device included, until
 * the operator resets again (which supersedes it in the row). Expiry never reopens the account to
 * whichever device registers first.
 */
export interface OpenIdentityReset {
  readonly id: string;
  readonly firstDeviceId: string;
  /** SHA-256 of the key the reset released (`null`: nothing was pinned); it is never pinned again. */
  readonly releasedKeySha256: Buffer | null;
  readonly createdAt: Date;
  /** Older than `IDENTITY_RESET_TICKET_TTL_MS` (by the database clock): it pins nothing any more. */
  readonly expired: boolean;
}

export async function findOpenIdentityReset(
  q: Queryable,
  userId: string,
): Promise<OpenIdentityReset | null> {
  const { rows } = await q.query<OpenIdentityReset>(
    `SELECT id, first_device_id AS "firstDeviceId", released_key_sha256 AS "releasedKeySha256",
       created_at AS "createdAt",
       created_at <= now() - make_interval(secs => $2::double precision / 1000) AS "expired"
     FROM identity_resets
     WHERE user_id = $1 AND first_device_id IS NOT NULL AND pinned_at IS NULL AND superseded_at IS NULL`,
    [userId, IDENTITY_RESET_TICKET_TTL_MS],
  );
  return rows[0] ?? null;
}

/** SHA-256 of a public key: how an `identity_resets` row names the key it released. */
export function identityKeyDigest(identityKeyPub: Buffer): Buffer {
  return createHash('sha256').update(identityKeyPub).digest();
}

/**
 * The roles whose `identityKeyPub` IS the account's identity key, the one key that signs its device
 * list (canon §3): a person's USER devices, and the operator's ASSISTANT devices (the operator key
 * plays the part of a person's identity key; ADR-117 amendment (о), TODO-518). A GUARDIAN device sits
 * on the child it guards and carries no key of the child's: it neither pins nor is counted.
 */
export const IDENTITY_PINNING_ROLES: readonly DeviceRole[] = [
  DeviceRole.USER,
  DeviceRole.ASSISTANT,
];

/** Does a device of `role` pin, or have to match, its account's identity key? */
export function pinsIdentityKey(role: DeviceRole): boolean {
  return IDENTITY_PINNING_ROLES.includes(role);
}

/**
 * ONE identity key per account (canon §3, TODO-504 (c), TODO-518): the first USER or ASSISTANT device
 * pins it; a later device of either role with another key is 409 IDENTITY_KEY_CHANGED. The key signs
 * the account's device list, and every correspondent pins ONE key per account, so a second key would
 * be a second person to the cryptography — which only an explicit reset (`releaseIdentityKey`) may
 * introduce, never a registration. Insert-or-compare inside the caller's transaction, which holds
 * `lockIdentityKey`.
 */
async function pinIdentityKey(
  tx: Queryable,
  userId: string,
  identityKeyPub: Buffer,
): Promise<void> {
  const inserted = await tx.query(
    `INSERT INTO identity_keys (user_id, identity_key_pub) VALUES ($1, $2)
     ON CONFLICT (user_id) DO NOTHING RETURNING user_id`,
    [userId, identityKeyPub],
  );
  if (inserted.rows.length > 0) return;
  const pinned = await findIdentityKey(tx, userId);
  if (pinned !== null && !pinned.equals(identityKeyPub)) throw identityKeyChanged(pinned);
}

/**
 * 409 IDENTITY_KEY_CHANGED, carrying the pinned key (`identityKeyPub`, base64:
 * `IdentityKeyChangedBody`, TODO-507): a second device cannot read it before it is registered, and the
 * key is what it must register with. Why the relay may say it: the account is the token's own
 * (`mayRegister` lets a USER device be registered for no one else, and an ASSISTANT device only by the
 * operator for itself), so it tells an account its own key; and it is a public key that a
 * correspondent reads from `GET /users/:userId/devices` anyway.
 */
function identityKeyChanged(pinned: Buffer): RelayError {
  return new RelayError(
    RelayErrorCode.IDENTITY_KEY_CHANGED,
    "This account's identity key is pinned; a USER or ASSISTANT device must carry the same key.",
    { identityKeyPub: toBase64(pinned) },
  );
}

/**
 * 409 IDENTITY_RESET_PENDING: an operator ticket is open and names another device, or it is past its
 * lifetime and pins nothing until the operator resets again (ADR-218 §6).
 */
function identityResetPending(): RelayError {
  return new RelayError(
    RelayErrorCode.IDENTITY_RESET_PENDING,
    "This account's identity key was reset; the device the reset names pins the new key first.",
  );
}

/**
 * 409 IDENTITY_REBIND_PROOF_REQUIRED: the ticketed device offered its new key without its device key's
 * signature over it and the reset, or with one that does not verify. Carries the reset's id to sign
 * (`IdentityRebindProofRequiredBody`); the id is no secret, the signature is the proof.
 */
function identityRebindProofRequired(resetId: string): RelayError {
  return new RelayError(
    RelayErrorCode.IDENTITY_REBIND_PROOF_REQUIRED,
    'The device this reset names pins its new key with its device signature over the key and the reset.',
    { resetId },
  );
}

/** What one release of an account's identity key asks for (`releaseIdentityKey`). */
export interface IdentityKeyRelease {
  readonly userId: string;
  readonly actor: IdentityResetActor;
  /** FAMILY_ADMIN: the admin's device. OPERATOR: `null`. */
  readonly actorDeviceId: string | null;
  /** At most `IDENTITY_RESET_REASON_MAX_LENGTH` characters; required when `revokeDeviceIds` is not empty. */
  readonly reason: string | null;
  /** OPERATOR: the registered, unrevoked USER device of the account that alone pins the next key. */
  readonly firstDeviceId: string | null;
  /** Unrevoked devices of the account to revoke past STILL_IN_ROOMS (lost, stolen, zombie). */
  readonly revokeDeviceIds: readonly string[];
}

/** What a release did: the audit row's id and its counts (the same numbers the row keeps). */
export interface IdentityKeyReleased {
  readonly resetId: string;
  /** SHA-256 of the released key; `null` when nothing was pinned. */
  readonly releasedKeySha256: Buffer | null;
  readonly listVersionsDeleted: number;
  readonly requestsDeleted: number;
  readonly holderProofsCleared: number;
  readonly revokedDeviceIds: readonly string[];
  readonly keyPackagesDeleted: number;
  /** The open ticket this release closed as superseded, if there was one. */
  readonly supersededResetId: string | null;
}

/** 422 VALIDATION_FAILED for a release that names the wrong devices: nothing has been changed. */
function badRelease(message: string): RelayError {
  return new RelayError(RelayErrorCode.VALIDATION_FAILED, message);
}

/**
 * THE identity-key release (ADR-218 §6), shared by the family-admin route (`resetIdentityKey`) and
 * the operator CLI (`apps/relay/src/operator/identity-reset.ts`). Runs inside the caller's
 * transaction, after the caller's own guard, and takes `lockIdentityKey` itself (a second take in
 * the same transaction is free). In order:
 *  1. the identity lock and the pin;
 *  2. the pin, the device list and every stored version are deleted: the next upload starts a NEW
 *     CHAIN at version 1, signed by the new key (a correspondent verifies a chain under ONE key, so the
 *     old versions would fail every first contact after the reset, and the new list could not start);
 *  3. open identity requests go, with their sealed keys: they were made under the released key. A
 *     rejected request stays: it is the «someone tried» notice, and retention takes it;
 *  4. every holder proof of the account is cleared (made under the released key);
 *  5. `revokeDeviceIds` are revoked, past STILL_IN_ROOMS: their leaves are Removed by the members'
 *     reconcile rule, because they are not on the new list. Their unconsumed key packages go, so no
 *     one can Add them again;
 *  6. an open ticket is closed as superseded, and the audit row is written: permanent, and for the
 *     operator it is the new ticket (`firstDeviceId`).
 * Surviving devices are NOT revoked: their id, signature key, key packages and leaves stay valid, and
 * they rejoin by being listed again (`registerDevice` lets their rows follow the new pin).
 *
 * Refuses (422, nothing changed) a first device that is not a registered, unrevoked USER device of the
 * account, a device to revoke that is not an unrevoked device of the account, the first device among
 * those to revoke, and a revoke without a reason.
 */
export async function releaseIdentityKey(
  tx: Queryable,
  release: IdentityKeyRelease,
): Promise<IdentityKeyReleased> {
  const { userId } = release;
  const operator = release.actor === IdentityResetActor.OPERATOR;
  if (operator !== (release.firstDeviceId !== null)) {
    throw badRelease('The operator names a first device; a family admin names none.');
  }
  const revoke = [...new Set(release.revokeDeviceIds)].sort();
  const reason = release.reason;
  if (
    reason !== null &&
    (reason.length === 0 || reason.length > IDENTITY_RESET_REASON_MAX_LENGTH)
  ) {
    throw badRelease(`A reason is 1 to ${IDENTITY_RESET_REASON_MAX_LENGTH} characters.`);
  }
  if (revoke.length > 0 && reason === null) {
    throw badRelease('Revoking devices past their rooms needs a reason.');
  }
  if (release.firstDeviceId !== null && revoke.includes(release.firstDeviceId)) {
    throw badRelease('The first device cannot be revoked by the reset that names it.');
  }

  // 1. The lock and the pin.
  const pin = await lockIdentityKey(tx, userId);

  // 2. The pin and the chain.
  await tx.query('DELETE FROM identity_keys WHERE user_id = $1', [userId]);
  await tx.query('DELETE FROM device_lists WHERE user_id = $1', [userId]);
  const versions = await tx.query('DELETE FROM device_list_versions WHERE user_id = $1', [userId]);

  // 3. Open identity requests and their sealed keys.
  const requests = await tx.query(
    'DELETE FROM identity_requests WHERE user_id = $1 AND rejected_at IS NULL',
    [userId],
  );

  // 4. Device rows, last in the lock order: the named ones first (FOR UPDATE, in id order, so a
  // commit adding one waits for this or is seen by it), checked before anything is revoked.
  const named = [...revoke, ...(release.firstDeviceId === null ? [] : [release.firstDeviceId])];
  const locked = await tx.query<DeviceRow>(
    `SELECT ${DEVICE_COLUMNS} FROM devices WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE`,
    [named],
  );
  const byId = new Map(locked.rows.map((row) => [row.id, row]));
  if (release.firstDeviceId !== null) {
    const first = byId.get(release.firstDeviceId);
    if (
      first === undefined ||
      first.userId !== userId ||
      first.role !== DeviceRole.USER ||
      first.revokedAt !== null
    ) {
      throw badRelease(
        'The first device must be a registered, unrevoked USER device of the account.',
      );
    }
  }
  for (const id of revoke) {
    const device = byId.get(id);
    if (device === undefined || device.userId !== userId || device.revokedAt !== null) {
      throw badRelease(`Device ${id} is not an unrevoked device of the account.`);
    }
  }
  const proofs = await tx.query(
    'UPDATE devices SET holder_proof = NULL WHERE user_id = $1 AND holder_proof IS NOT NULL',
    [userId],
  );

  // 5. The devices to revoke, past STILL_IN_ROOMS, and their unconsumed key packages.
  if (revoke.length > 0) {
    await tx.query('UPDATE devices SET revoked_at = now() WHERE id = ANY($1::text[])', [revoke]);
  }
  const packages =
    revoke.length > 0
      ? await tx.query(
          'DELETE FROM key_packages WHERE device_id = ANY($1::text[]) AND consumed_at IS NULL',
          [revoke],
        )
      : { rowCount: 0 };

  // 6. The ticket it replaces, and the audit row.
  const superseded = await tx.query<{ id: string }>(
    `UPDATE identity_resets SET superseded_at = now()
     WHERE user_id = $1 AND first_device_id IS NOT NULL AND pinned_at IS NULL AND superseded_at IS NULL
     RETURNING id`,
    [userId],
  );
  const released: Omit<IdentityKeyReleased, 'resetId' | 'supersededResetId'> = {
    releasedKeySha256: pin === null ? null : identityKeyDigest(pin),
    listVersionsDeleted: versions.rowCount ?? 0,
    requestsDeleted: requests.rowCount ?? 0,
    holderProofsCleared: proofs.rowCount ?? 0,
    revokedDeviceIds: revoke,
    keyPackagesDeleted: packages.rowCount ?? 0,
  };
  const audit = await tx.query<{ id: string }>(
    `INSERT INTO identity_resets (user_id, actor, actor_device_id, reason, first_device_id,
       revoked_device_ids, released_key_sha256, list_versions_deleted, requests_deleted,
       holder_proofs_cleared, key_packages_deleted)
     VALUES ($1, $2, $3, $4, $5, $6::text[], $7, $8, $9, $10, $11)
     RETURNING id`,
    [
      userId,
      release.actor,
      release.actorDeviceId,
      reason,
      release.firstDeviceId,
      revoke,
      released.releasedKeySha256,
      released.listVersionsDeleted,
      released.requestsDeleted,
      released.holderProofsCleared,
      released.keyPackagesDeleted,
    ],
  );
  const resetId = audit.rows[0]?.id;
  if (resetId === undefined) {
    throw new RelayError(RelayErrorCode.INTERNAL, 'The reset wrote no audit row.');
  }
  return { ...released, resetId, supersededResetId: superseded.rows[0]?.id ?? null };
}

/**
 * The family admin's identity-key reset: the «new person to the cryptography» flow (canon §3).
 * Releases the pin (`releaseIdentityKey`, actor FAMILY_ADMIN, no ticket) so the account's next USER
 * or ASSISTANT device pins a fresh key; every correspondent then sees a key change on the next list
 * and must re-verify. Host-driven: only a token that ADMINISTERS the user (`adminOf`, which the host
 * fills from its family roster and never with the caller themself) may ask, and only once every USER
 * and ASSISTANT device of the account is revoked (409 IDENTITY_KEY_IN_USE otherwise), so a stolen
 * session cannot swap the key under live devices. The same rule serves the operator account: its own
 * token names its own subject in `adminOf` (so a seat can retire itself), but its calling device is
 * itself an active ASSISTANT device, so only ANOTHER admin's token can pass the guard. Refused callers
 * and unknown users get the same 403 REVOKE_FORBIDDEN.
 *
 * The operator's reset (ADR-218 §6) is the other caller of the same release: it keeps the surviving
 * devices and opens a ticket instead. A family admin's reset closes an open ticket as superseded.
 * Resetting an account with no pin and no lists still writes its audit row and changes nothing else.
 */
export async function resetIdentityKey(
  db: Database,
  principal: Principal,
  userId: string,
): Promise<void> {
  if (!administersUser(principal, userId)) {
    throw new RelayError(
      RelayErrorCode.REVOKE_FORBIDDEN,
      "You may not reset this person's identity key.",
    );
  }
  await db.transaction(async (tx) => {
    // The lock first: a USER or ASSISTANT device registering meanwhile waits, then pins afresh.
    await lockIdentityKey(tx, userId);
    const active = await tx.query<{ devices: string }>(
      `SELECT count(*) AS devices FROM devices
       WHERE user_id = $1 AND role = ANY($2::device_role[]) AND revoked_at IS NULL`,
      [userId, IDENTITY_PINNING_ROLES],
    );
    const devices = Number(active.rows[0]?.devices ?? 0);
    if (devices > 0) {
      throw new RelayError(
        RelayErrorCode.IDENTITY_KEY_IN_USE,
        'The account still has active USER or ASSISTANT devices; revoke them first.',
        { devices },
      );
    }
    await releaseIdentityKey(tx, {
      userId,
      actor: IdentityResetActor.FAMILY_ADMIN,
      actorDeviceId: principal.deviceId,
      reason: null,
      firstDeviceId: null,
      revokeDeviceIds: [],
    });
  });
}

/** Why a holder proof is refused, as `reason` in the answer: a client can tell the two apart. */
export const HolderProofRefusal = {
  /** The account has no pinned identity key to verify the proof under (a reset is under way). */
  NO_PINNED_KEY: 'NO_PINNED_KEY',
  /** The proof does not verify under the pinned key for this device's holder statement. */
  BAD_SIGNATURE: 'BAD_SIGNATURE',
} as const;
export type HolderProofRefusal = (typeof HolderProofRefusal)[keyof typeof HolderProofRefusal];

/**
 * ADR-218 §5: the calling device says it holds its person's identity key, with a proof only a holder
 * can make: the identity key's signature over the device's holder statement (`holderStatementBytes`:
 * owner, device id and the REGISTERED signature key). The relay verifies it under the account's pinned
 * key (422 HOLDER_PROOF_INVALID otherwise), stores it, and serves it in the FULL device view only.
 * Only a person's own USER device may post one (403 ROLE_FORBIDDEN): GUARDIAN and ASSISTANT devices
 * never hold a person's key. Posting again replaces the proof (it is deterministic, so it is the same).
 *
 * The proof also settles the device's own identity requests: a sealed key still waiting for it is
 * deleted (it has been opened; ADR-218 §2 step 4), and a request still open is expired (a holder asks
 * for nothing). Lock order: the pin, then the requests, then the device row (`resetIdentityKey`).
 */
export async function putHolderProof(
  db: Database,
  principal: Principal,
  proof: Buffer,
  now: Date,
): Promise<DeviceRow> {
  return db.transaction(async (tx) => {
    const pin = await tx.query<{ identityKeyPub: Buffer }>(
      'SELECT identity_key_pub AS "identityKeyPub" FROM identity_keys WHERE user_id = $1 FOR SHARE',
      [principal.userId],
    );
    // Keys, role and owner of a row never change (`registerDevice`), so an unlocked read is enough to
    // verify against; whether the row is still unrevoked is decided by the UPDATE below.
    const device = await findDevice(tx, principal.deviceId);
    if (device === null || device.userId !== principal.userId || device.role !== DeviceRole.USER) {
      throw new RelayError(
        RelayErrorCode.ROLE_FORBIDDEN,
        "Only a person's own USER device holds their identity key.",
      );
    }
    const identityKey = pin.rows[0]?.identityKeyPub ?? null;
    if (identityKey === null) {
      throw new RelayError(
        RelayErrorCode.HOLDER_PROOF_INVALID,
        'This account has no pinned identity key to verify the proof under.',
        { reason: HolderProofRefusal.NO_PINNED_KEY },
      );
    }
    const statement = {
      userId: device.userId,
      deviceId: device.id,
      signatureKey: device.signatureKeyPub,
    };
    if (!(await verifyHolderProof(identityKey, statement, proof))) {
      throw new RelayError(
        RelayErrorCode.HOLDER_PROOF_INVALID,
        "The proof does not verify under this account's pinned identity key.",
        { reason: HolderProofRefusal.BAD_SIGNATURE },
      );
    }
    await tx.query(
      `UPDATE identity_requests SET sealed_enc = NULL, sealed_ct = NULL
       WHERE device_id = $1 AND sealed_ct IS NOT NULL`,
      [device.id],
    );
    await tx.query(
      `UPDATE identity_requests SET expires_at = $2
       WHERE device_id = $1 AND approved_at IS NULL AND rejected_at IS NULL AND expires_at > $2`,
      [device.id, now],
    );
    const stored = await tx.query<DeviceRow>(
      `UPDATE devices SET holder_proof = $2 WHERE id = $1 AND revoked_at IS NULL
       RETURNING ${DEVICE_COLUMNS}`,
      [device.id, proof],
    );
    const row = stored.rows[0];
    if (row === undefined) {
      throw new RelayError(RelayErrorCode.ACTOR_DEVICE_REVOKED, 'This device has been revoked.');
    }
    return row;
  });
}

/**
 * Registers the calling device, or refreshes its name/platform/last-seen.
 *
 * What may change on a re-registration: the label (`name`, `platform`) and `lastSeenAt`, and — only
 * after an identity-key reset — the identity key the row carries (ADR-218 §6). Signature key, role
 * and owner are fixed for the life of the install: letting a stolen token swap the MLS key of a
 * device that already holds leaves would be a silent take-over of those leaves (409
 * DEVICE_IDENTITY_IMMUTABLE).
 *
 * The identity key of a USER or ASSISTANT device is its ACCOUNT's (`pinIdentityKey`), and an operator
 * reset (`releaseIdentityKey`) moves it under the surviving devices. So, under the account's identity
 * lock (`lockIdentityKey`):
 *  - **The ticket.** While an operator ticket is open (`findOpenIdentityReset`), only the device it
 *    names may pin; any other device, new or registered, that offers a key gets 409
 *    IDENTITY_RESET_PENDING. This closes the race in which a stolen session registers first after the
 *    reset. A registered device re-offering the key its row already carries is a plain refresh: it
 *    pins nothing (the first device's old key above all is not pinned again).
 *    A ticket past `IDENTITY_RESET_TICKET_TTL_MS` pins nothing for anyone, the named device included
 *    (IDENTITY_RESET_PENDING), until the operator resets again.
 *  - **Rebind.** A registered device whose signature key and role are unchanged may change the
 *    identity key its row carries in two cases only: it is the ticketed device, which pins its new key
 *    (never the one the reset released) and closes the ticket; or its row still carries a released key
 *    (the row is not the pin) and it offers the pin, which it then follows. Offering any other key in
 *    the second case is 409 IDENTITY_KEY_CHANGED with the pin, as for a new device.
 *    The ticketed device pins only with `rebindSignature`: its registered device key's signature over
 *    `identityRebindBytes` (account, device, new key, reset id). A session that merely names the device
 *    id (the public signature key is no secret) gets 409 IDENTITY_REBIND_PROOF_REQUIRED with the reset id.
 *  - **Everything else** that changes the identity key is DEVICE_IDENTITY_IMMUTABLE, as before: only
 *    an operator reset moves a pin.
 */
export async function registerDevice(
  db: Database,
  principal: Principal,
  input: RegisterDeviceInput,
  policy: RegistrationPolicy,
): Promise<{ device: DeviceRow; created: boolean }> {
  if (input.id !== principal.deviceId) {
    throw new RelayError(
      RelayErrorCode.DEVICE_MISMATCH,
      'A device can only register itself: the id must be the one in the token.',
    );
  }
  if (!mayRegister(principal, input.role, input.userId, policy)) {
    throw new RelayError(
      RelayErrorCode.ROLE_FORBIDDEN,
      `This token may not register a ${input.role} device for that account.`,
    );
  }

  return db.transaction(async (tx) => {
    // A GUARDIAN device neither pins nor follows a key, so it takes no identity lock.
    const pinning = pinsIdentityKey(input.role);
    const pin = pinning ? await lockIdentityKey(tx, input.userId) : null;
    const ticket = pinning ? await findOpenIdentityReset(tx, input.userId) : null;

    // Insert first and look afterwards: two concurrent first registrations of the same id are
    // then arbitrated by the primary key instead of by a read-then-write race.
    const inserted = await tx.query<DeviceRow>(
      `INSERT INTO devices (id, user_id, role, name, platform, identity_key_pub, signature_key_pub, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())
       ON CONFLICT (id) DO NOTHING
       RETURNING ${DEVICE_COLUMNS}`,
      [
        input.id,
        input.userId,
        input.role,
        input.name,
        input.platform,
        input.identityKeyPub,
        input.signatureKeyPub,
      ],
    );
    const created = inserted.rows[0];
    if (created !== undefined) {
      // A NEW USER or ASSISTANT device pins (or must match) its account's identity key; a refusal
      // rolls the insert back. A ticket names a registered device, so a new one is never it. A
      // re-registration is judged by the rules below instead.
      if (pinning) {
        if (ticket !== null) throw identityResetPending();
        await pinIdentityKey(tx, input.userId, input.identityKeyPub);
      }
      return { device: created, created: true };
    }

    const { rows } = await tx.query<DeviceRow>(
      `SELECT ${DEVICE_COLUMNS} FROM devices WHERE id = $1 FOR UPDATE`,
      [input.id],
    );
    const existing = rows[0];
    if (existing === undefined) {
      // Unreachable while devices are never deleted; fail loudly rather than invent a result.
      throw new RelayError(RelayErrorCode.INTERNAL, 'Device vanished during registration.');
    }
    if (existing.userId !== input.userId) {
      throw new RelayError(
        RelayErrorCode.DEVICE_OWNED_BY_OTHER,
        'This device id is registered to another user.',
      );
    }
    if (existing.revokedAt !== null) {
      throw new RelayError(RelayErrorCode.ACTOR_DEVICE_REVOKED, 'This device has been revoked.');
    }
    const immutable = () =>
      new RelayError(
        RelayErrorCode.DEVICE_IDENTITY_IMMUTABLE,
        'The keys and role of a registered device cannot change; register a new device instead.',
      );
    if (existing.role !== input.role || !existing.signatureKeyPub.equals(input.signatureKeyPub)) {
      throw immutable();
    }
    if (!existing.identityKeyPub.equals(input.identityKeyPub)) {
      // Another identity key on a registered device: only a rebind after a reset (ADR-218 §6).
      if (!pinning) throw immutable();
      if (ticket !== null) {
        if (ticket.expired || ticket.firstDeviceId !== existing.id) throw identityResetPending();
        // A reset is for a NEW key: the one it released is never pinned again.
        if (
          ticket.releasedKeySha256 !== null &&
          ticket.releasedKeySha256.equals(identityKeyDigest(input.identityKeyPub))
        ) {
          throw immutable();
        }
        // The id in the token is not the device: the device is whoever holds its signature key.
        const proven =
          input.rebindSignature != null &&
          (await verifyIdentityRebindSignature(
            existing.signatureKeyPub,
            {
              userId: input.userId,
              deviceId: existing.id,
              identityKey: input.identityKeyPub,
              resetId: ticket.id,
            },
            input.rebindSignature,
          ));
        if (!proven) throw identityRebindProofRequired(ticket.id);
        await pinIdentityKey(tx, input.userId, input.identityKeyPub);
        await tx.query('UPDATE identity_resets SET pinned_at = now() WHERE id = $1', [ticket.id]);
      } else if (pin !== null && !existing.identityKeyPub.equals(pin)) {
        // A survivor of a reset: its row carries a released key. It follows the pin, nothing else.
        if (!input.identityKeyPub.equals(pin)) throw identityKeyChanged(pin);
      } else {
        throw immutable();
      }
    }
    const updated = await tx.query<DeviceRow>(
      `UPDATE devices SET name = $2, platform = $3, identity_key_pub = $4, last_seen_at = now()
       WHERE id = $1 RETURNING ${DEVICE_COLUMNS}`,
      [input.id, input.name, input.platform, input.identityKeyPub],
    );
    return { device: updated.rows[0] ?? existing, created: false };
  });
}

/**
 * Revokes a device so it can no longer act, fetch, or be added to a room.
 *
 * ADR-117 §5a: revoking a token does NOT remove an MLS leaf, so "sign out of that device" is
 * Remove first, revoke second. The client commits the Remove; the relay holds the line by refusing
 * to revoke a device that is still a member of any room (409 STILL_IN_ROOMS). Allowed for another
 * device of the same user, or for a family admin OF THE DEVICE'S USER (`adminOf`, not the bare marker).
 */
export async function revokeDevice(
  db: Database,
  principal: Principal,
  targetDeviceId: string,
): Promise<DeviceRow> {
  const refused = () =>
    new RelayError(RelayErrorCode.REVOKE_FORBIDDEN, 'You may not revoke this device.');

  return db.transaction(async (tx) => {
    // FOR UPDATE: a commit that is adding this very device to a room holds FOR SHARE on it (see
    // member-delta.ts), so one of the two waits for the other and the room check below sees the
    // committed truth. Without the lock a device could be revoked and added in the same instant.
    const { rows } = await tx.query<DeviceRow>(
      `SELECT ${DEVICE_COLUMNS} FROM devices WHERE id = $1 FOR UPDATE`,
      [targetDeviceId],
    );
    const target = rows[0];
    // Same refusal for "no such device" and "not yours", for admins too: whether an admin may act
    // depends on WHOSE device it is, which a missing device does not have, so a distinct "not
    // found" for admins would be a probe for device ids (ids are not a directory).
    if (target === undefined) throw refused();
    const isAnotherDeviceOfSameUser =
      target.userId === principal.userId && target.id !== principal.deviceId;
    // The admin's reach is `adminOf` (the same rule as everywhere), self-revoke included: an
    // admin may revoke their own current device only if they administer their own user.
    if (!isAnotherDeviceOfSameUser && !administersUser(principal, target.userId)) throw refused();
    if (target.revokedAt !== null) return target;

    const outcome = await revokeUnlessInRooms(tx, targetDeviceId);
    if (outcome.rooms > 0) {
      throw new RelayError(
        RelayErrorCode.STILL_IN_ROOMS,
        'The device is still a member of rooms; commit MLS Remove in each of them first.',
        { rooms: outcome.rooms },
      );
    }
    return outcome.device ?? target;
  });
}

/** What `revokeUnlessInRooms` did: the revoked row, or the rooms that kept the device active. */
export interface RevokeOutcome {
  /** The row after the revoke; `null` when the device was kept (`rooms` > 0) or is unknown. */
  readonly device: DeviceRow | null;
  /** Rooms the device is still a member of; 0 when it was revoked. */
  readonly rooms: number;
}

/**
 * THE revoke rule's write half (ADR-117 §5a: Remove first, revoke second): revokes `deviceId` unless it
 * is still a member of a room. The caller has already decided it MAY revoke, and holds the device row
 * FOR UPDATE, so a commit adding the device (FOR SHARE, member-delta.ts) waits for it or is seen by it.
 * Shared by `revokeDevice` and the reject of an identity request (ADR-218 §2 step 5).
 */
export async function revokeUnlessInRooms(tx: Queryable, deviceId: string): Promise<RevokeOutcome> {
  const members = await tx.query<{ rooms: string }>(
    `SELECT count(*) AS rooms FROM room_members
     WHERE device_id = $1 AND removed_at_epoch IS NULL`,
    [deviceId],
  );
  const rooms = Number(members.rows[0]?.rooms ?? 0);
  if (rooms > 0) return { device: null, rooms };
  const revoked = await tx.query<DeviceRow>(
    `UPDATE devices SET revoked_at = now() WHERE id = $1 RETURNING ${DEVICE_COLUMNS}`,
    [deviceId],
  );
  return { device: revoked.rows[0] ?? null, rooms: 0 };
}
