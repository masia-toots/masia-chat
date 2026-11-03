import {
  administersUser,
  DeviceRole,
  guardsUser,
  introducedTo,
  RelayError,
  RelayErrorCode,
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
}

/** The one column list for `devices`, so every query returns the same camelCase shape. */
export const DEVICE_COLUMNS = `id, user_id AS "userId", role, name, platform,
  identity_key_pub AS "identityKeyPub", signature_key_pub AS "signatureKeyPub",
  created_at AS "createdAt", last_seen_at AS "lastSeenAt", revoked_at AS "revokedAt"`;

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
 * be a second person to the cryptography — which only the explicit reset (`resetIdentityKey`) may
 * introduce, never a registration. Insert-or-compare inside the caller's transaction: the primary key
 * arbitrates two first devices.
 *
 * The refusal carries the pinned key (`identityKeyPub`, base64: `IdentityKeyChangedBody`, TODO-507):
 * a second device cannot read it before it is registered, and the key is what it must register with.
 * Why the relay may say it: `userId` is the token's own user (`mayRegister` lets a USER device be
 * registered for no one else, and an ASSISTANT device only by the operator for itself), so it tells an
 * account its own key; and it is a public key that a correspondent reads from
 * `GET /users/:userId/devices` anyway.
 */
async function pinIdentityKey(tx: Queryable, userId: string, identityKeyPub: Buffer): Promise<void> {
  const inserted = await tx.query(
    `INSERT INTO identity_keys (user_id, identity_key_pub) VALUES ($1, $2)
     ON CONFLICT (user_id) DO NOTHING RETURNING user_id`,
    [userId, identityKeyPub],
  );
  if (inserted.rows.length > 0) return;
  const pinned = await findIdentityKey(tx, userId);
  if (pinned !== null && !pinned.equals(identityKeyPub)) {
    throw new RelayError(
      RelayErrorCode.IDENTITY_KEY_CHANGED,
      "This account's identity key is pinned; a USER or ASSISTANT device must carry the same key.",
      { identityKeyPub: toBase64(pinned) },
    );
  }
}

/**
 * The explicit identity-key reset: the «new person to the cryptography» flow (canon §3). Releases
 * the pin so the account's next USER or ASSISTANT device pins a fresh key; every correspondent then
 * sees a key change on the next list and must re-verify. Host-driven: only a token that ADMINISTERS
 * the user (`adminOf`, which the host fills from its family roster and never with the caller
 * themself) may ask, and only once every USER and ASSISTANT device of the account is revoked (409
 * IDENTITY_KEY_IN_USE otherwise), so a stolen session cannot swap the key under live devices. The
 * same rule serves the operator account: its own token names its own subject in `adminOf` (so a seat
 * can retire itself), but its calling device is itself an active ASSISTANT device, so only ANOTHER
 * admin's token can pass the guard. Refused callers and unknown users get the same 403
 * REVOKE_FORBIDDEN.
 *
 * A reset also starts a NEW CHAIN of the account's device list: every stored version is deleted in the
 * same transaction, so the next upload is version 1 again, signed by the new key. The old versions
 * were signed by a key that no longer belongs to the account, and a correspondent verifies a chain
 * under ONE key: serving them beside the new key's would make every first contact after the reset
 * fail its signature check, and the new key's list could not even start (the old chain's version
 * would be "current"). Deleting loses nothing a client can use; a correspondent that pinned the old
 * key learns of the change from the account's pinned key (`identityKeyPub`) and re-pins on purpose.
 * Resetting an account with no pin and no lists is a no-op.
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
    // Lock the pin first: a USER or ASSISTANT device registering meanwhile waits, then pins afresh.
    await tx.query('SELECT 1 FROM identity_keys WHERE user_id = $1 FOR UPDATE', [userId]);
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
    // Lock order everywhere: the pin, then the list (`putDeviceList` takes them the same way).
    await tx.query('DELETE FROM identity_keys WHERE user_id = $1', [userId]);
    await tx.query('DELETE FROM device_lists WHERE user_id = $1', [userId]);
    await tx.query('DELETE FROM device_list_versions WHERE user_id = $1', [userId]);
  });
}

/**
 * Registers the calling device, or refreshes its name/platform/last-seen.
 *
 * What may change on a re-registration: only the label (`name`, `platform`) and `lastSeenAt`.
 * Keys, role and owner are fixed for the life of the install — letting a stolen token swap the
 * keys of a device that already holds MLS leaves would be a silent take-over of those leaves.
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
      // rolls the insert back. A re-registration is judged by the immutability rule below instead.
      if (pinsIdentityKey(input.role)) {
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
    const identityChanged =
      existing.role !== input.role ||
      !existing.identityKeyPub.equals(input.identityKeyPub) ||
      !existing.signatureKeyPub.equals(input.signatureKeyPub);
    if (identityChanged) {
      throw new RelayError(
        RelayErrorCode.DEVICE_IDENTITY_IMMUTABLE,
        'The keys and role of a registered device cannot change; register a new device instead.',
      );
    }
    const updated = await tx.query<DeviceRow>(
      `UPDATE devices SET name = $2, platform = $3, last_seen_at = now()
       WHERE id = $1 RETURNING ${DEVICE_COLUMNS}`,
      [input.id, input.name, input.platform],
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

    const members = await tx.query<{ rooms: string }>(
      `SELECT count(*) AS rooms FROM room_members
       WHERE device_id = $1 AND removed_at_epoch IS NULL`,
      [targetDeviceId],
    );
    const rooms = Number(members.rows[0]?.rooms ?? 0);
    if (rooms > 0) {
      throw new RelayError(
        RelayErrorCode.STILL_IN_ROOMS,
        'The device is still a member of rooms; commit MLS Remove in each of them first.',
        { rooms },
      );
    }
    const revoked = await tx.query<DeviceRow>(
      `UPDATE devices SET revoked_at = now() WHERE id = $1 RETURNING ${DEVICE_COLUMNS}`,
      [targetDeviceId],
    );
    return revoked.rows[0] ?? target;
  });
}
