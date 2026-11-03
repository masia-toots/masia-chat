import {
  type AdminScope,
  administersUser,
  DeviceRole,
  findListedDevice,
  guardsUser,
  RelayError,
  RelayErrorCode,
} from '@masia/relay';
import type { Queryable } from '../db.js';
import { findDeviceList } from './device-lists.js';
import { DEVICE_COLUMNS, type DeviceRow } from './devices.js';

/**
 * Who a commit adds to and removes from a room, AS DECLARED BY THE COMMITTER.
 *
 * The relay cannot read a commit, so this is metadata the client sends beside it. That is safe to
 * act on because of what it can and cannot do: it decides who the RELAY will serve ciphertext to,
 * nothing more. A lying committer cannot make anyone decrypt a message (MLS decides that), and
 * every client re-derives the roster from the MLS tree and checks it against the signed device
 * lists (ADR-117 §2a). The guards below make the declared delta as hard to abuse as the relay can.
 */
export interface AddedMember {
  readonly deviceId: string;
  readonly userId: string;
  readonly role: DeviceRole;
}

export interface MemberDelta {
  readonly added: readonly AddedMember[];
  readonly removed: readonly string[];
}

/**
 * An add as a COMMITTER declares it beside a commit: it names the key package it used,
 * and that package must have been claimed by the committing device (`assertAddsClaimedBy`).
 */
export interface DeclaredAddedMember extends AddedMember {
  readonly keyPackageId: string;
}

/**
 * What a commit DECLARES, exactly as stored in `mls_handshakes.member_delta_json` and
 * served back by GET /handshakes. The relay cannot read the commit, so every member compares this
 * with the delta it computes from the decrypted commit and treats a difference as an attack
 * (security review 2026-10-10 §4, "Lying memberDelta").
 */
export interface DeclaredMemberDelta extends MemberDelta {
  readonly added: readonly DeclaredAddedMember[];
}

export const EMPTY_DECLARED_MEMBER_DELTA: DeclaredMemberDelta = { added: [], removed: [] };

function invalidDelta(message: string): RelayError {
  return new RelayError(RelayErrorCode.INVALID_MEMBER_DELTA, message);
}

function notInSignedList(message: string): RelayError {
  return new RelayError(RelayErrorCode.DEVICE_NOT_IN_SIGNED_LIST, message);
}

function hasDuplicates(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

/**
 * Who is making the change: the rights the token carries, and the device the commit comes from
 * (`null` for the relay's own change, the creator joining a new group, which removes nobody).
 */
export interface Remover {
  readonly scope: AdminScope;
  readonly device: { readonly userId: string; readonly role: DeviceRole } | null;
}

/**
 * May `remover` take a GUARDIAN leaf of `minorUserId` out of a room? The relay's copy of the
 * engine's `mayRemoveGuardian`, so the two cannot disagree about who wins:
 *  - a family admin OF THAT MINOR (`adminOf`), from any device; or
 *  - another GUARDIAN device of the same minor, driven by a token that guards the minor
 *    (`guardianOf`): one guardian replacing or retiring another guardian leaf of the same child.
 * A child, another adult, or an admin of a different family gets the same refusal.
 */
export function mayRemoveGuardian(remover: Remover, minorUserId: string): boolean {
  if (administersUser(remover.scope, minorUserId)) return true;
  const device = remover.device;
  return (
    device !== null &&
    device.role === DeviceRole.GUARDIAN &&
    device.userId === minorUserId &&
    guardsUser(remover.scope, minorUserId)
  );
}

/**
 * Throws if the declared delta must not be applied. Runs inside the serializer's transaction, with
 * the conversation row locked, so what it reads about the room cannot change under it.
 *
 *  - REMOVING a GUARDIAN device needs `mayRemoveGuardian` (ADR-117 §4: a child's device cannot
 *    take the parent's leaf out of the room). The claims and the user lists come from the token,
 *    never the body; an admin of family A is refused for family B's guardian, with the very answer
 *    a non-admin gets.
 *  - ADDING a device needs three things to be true of the device the committer names:
 *      · it is not revoked;
 *      · it is on its owner's CURRENT signed device list, with the same role and signature key
 *        (§2a: the relay enforces the list it holds; clients verify the signature on it);
 *      · it is not already a member.
 */
export async function assertMemberDeltaAllowed(
  tx: Queryable,
  options: { conversationId: string; delta: MemberDelta; remover: Remover },
): Promise<void> {
  const { conversationId, delta, remover } = options;
  const addedIds = delta.added.map((member) => member.deviceId);

  if (hasDuplicates(addedIds) || hasDuplicates([...delta.removed])) {
    throw invalidDelta('A device appears twice in the member delta.');
  }
  if (delta.removed.some((deviceId) => addedIds.includes(deviceId))) {
    throw invalidDelta('A device cannot be added and removed in the same commit.');
  }

  await assertRemovalsAllowed(tx, conversationId, delta.removed, remover);
  await assertAdditionsAllowed(tx, conversationId, delta.added);
}

async function assertRemovalsAllowed(
  tx: Queryable,
  conversationId: string,
  removed: readonly string[],
  remover: Remover,
): Promise<void> {
  if (removed.length === 0) return;
  const { rows } = await tx.query<{ deviceId: string; userId: string; role: DeviceRole }>(
    `SELECT rm.device_id AS "deviceId", d.user_id AS "userId", d.role
     FROM room_members rm JOIN devices d ON d.id = rm.device_id
     WHERE rm.conversation_id = $1 AND rm.device_id = ANY($2::text[]) AND rm.removed_at_epoch IS NULL`,
    [conversationId, [...removed]],
  );
  const memberById = new Map(rows.map((row) => [row.deviceId, row]));

  for (const deviceId of removed) {
    const member = memberById.get(deviceId);
    if (member === undefined) {
      throw new RelayError(
        RelayErrorCode.REMOVE_TARGET_NOT_MEMBER,
        'A device to remove is not a current member of the room.',
      );
    }
    // A guardian device belongs to the minor it guards. Same refusal for every "no", so the answer
    // does not say whether the caller is an admin of someone else.
    if (member.role === DeviceRole.GUARDIAN && !mayRemoveGuardian(remover, member.userId)) {
      throw new RelayError(
        RelayErrorCode.GUARDIAN_REMOVE_FORBIDDEN,
        "Only the child's family admin, or another guardian of the child, may remove a guardian device.",
      );
    }
  }
}

async function assertAdditionsAllowed(
  tx: Queryable,
  conversationId: string,
  added: readonly AddedMember[],
): Promise<void> {
  if (added.length === 0) return;

  // FOR SHARE: a concurrent revoke takes FOR UPDATE on the same rows (see revokeDevice), so
  // "is it revoked?" cannot be answered "no" here and "yes" a moment later with the add already in.
  const devices = await tx.query<DeviceRow>(
    `SELECT ${DEVICE_COLUMNS} FROM devices WHERE id = ANY($1::text[]) FOR SHARE`,
    [added.map((member) => member.deviceId)],
  );
  const deviceById = new Map(devices.rows.map((device) => [device.id, device]));

  const members = await tx.query<{ deviceId: string }>(
    `SELECT device_id AS "deviceId" FROM room_members
     WHERE conversation_id = $1 AND device_id = ANY($2::text[]) AND removed_at_epoch IS NULL`,
    [conversationId, added.map((member) => member.deviceId)],
  );
  const alreadyMembers = new Set(members.rows.map((row) => row.deviceId));

  for (const member of added) {
    const device = deviceById.get(member.deviceId);
    if (device === undefined) throw notInSignedList('A device to add is unknown to the relay.');
    if (device.revokedAt !== null) {
      throw new RelayError(
        RelayErrorCode.DEVICE_REVOKED,
        'A revoked device cannot be added to a room.',
      );
    }
    if (device.userId !== member.userId || device.role !== member.role) {
      throw notInSignedList(
        'A device to add does not belong to the user or role the commit names.',
      );
    }

    // The list is read per added device's owner. Reads are cheap and a commit adds a handful.
    const list = await findDeviceList(tx, device.userId);
    const listed = list === null ? undefined : findListedDevice(list.devices, device.id);
    if (
      listed === undefined ||
      listed.role !== device.role ||
      listed.signatureKey !== device.signatureKeyPub.toString('base64')
    ) {
      throw notInSignedList("A device to add is not on its owner's current signed device list.");
    }

    if (alreadyMembers.has(device.id)) {
      throw new RelayError(
        RelayErrorCode.ALREADY_MEMBER,
        'A device to add is already in the room.',
      );
    }
  }
}

/**
 * Every added device must come with a key package THE COMMITTING DEVICE claimed for it.
 *
 * Why: without this a member could declare an Add for any device that passes `assertAdditionsAllowed`
 * (registered, listed, not revoked) whether or not anybody invited it, and the relay would then
 * serve that device the room's ciphertext. A real Add needs the added device's key package, and the
 * only way to get one is `POST /key-packages/claim`, which records `(package, claimer)`. So the
 * declared package must (a) exist, (b) belong to the device being added and (c) have a claim row by
 * the committer. That holds for a consumed ordinary package and for a last-resort package alike
 * (a last-resort one is never consumed, but each claim of it is recorded).
 *
 * It does NOT prove the commit really contains that Add, only the clients can: it narrows the lie
 * from "add anyone" to "add a device I legitimately claimed", and clients still compare the stored
 * delta with the decrypted commit.
 */
export async function assertAddsClaimedBy(
  tx: Queryable,
  options: { committerDeviceId: string; added: readonly DeclaredAddedMember[] },
): Promise<void> {
  const { committerDeviceId, added } = options;
  if (added.length === 0) return;

  const { rows } = await tx.query<{
    keyPackageId: string;
    deviceId: string;
    claimedByCommitter: boolean;
  }>(
    `SELECT kp.id::text AS "keyPackageId", kp.device_id AS "deviceId",
            EXISTS (
              SELECT 1 FROM key_package_claims c
              WHERE c.key_package_id = kp.id AND c.claimer_device_id = $2
            ) AS "claimedByCommitter"
     FROM key_packages kp WHERE kp.id = ANY($1::uuid[])`,
    [added.map((member) => member.keyPackageId), committerDeviceId],
  );
  // Postgres prints a uuid in lower case; the body may spell it in upper case.
  const packageById = new Map(rows.map((row) => [row.keyPackageId, row]));

  for (const member of added) {
    const keyPackage = packageById.get(member.keyPackageId.toLowerCase());
    if (
      keyPackage === undefined ||
      keyPackage.deviceId !== member.deviceId ||
      !keyPackage.claimedByCommitter
    ) {
      // One answer for "no such package", "not that device's" and "not claimed by you": a package
      // id is not a directory to probe.
      throw new RelayError(
        RelayErrorCode.KEY_PACKAGE_NOT_CLAIMED_BY_COMMITTER,
        'A device to add must come with a key package that the committing device claimed for it.',
        { deviceId: member.deviceId },
      );
    }
  }
}

/**
 * Records the delta in the server's view of the room. `newEpoch` is the epoch AFTER the commit:
 * a device added by it joins in that epoch, a device removed by it leaves in that epoch.
 */
export async function applyMemberDelta(
  tx: Queryable,
  options: { conversationId: string; delta: MemberDelta; newEpoch: number },
): Promise<void> {
  const { conversationId, delta, newEpoch } = options;

  if (delta.removed.length > 0) {
    await tx.query(
      `UPDATE room_members SET removed_at_epoch = $3
       WHERE conversation_id = $1 AND device_id = ANY($2::text[]) AND removed_at_epoch IS NULL`,
      [conversationId, [...delta.removed], newEpoch],
    );
  }
  for (const member of delta.added) {
    // ON CONFLICT: a device that left earlier and is invited back reuses its row.
    await tx.query(
      `INSERT INTO room_members (conversation_id, device_id, added_at_epoch)
       VALUES ($1, $2, $3)
       ON CONFLICT (conversation_id, device_id)
       DO UPDATE SET added_at_epoch = EXCLUDED.added_at_epoch, removed_at_epoch = NULL`,
      [conversationId, member.deviceId, newEpoch],
    );
  }
}
