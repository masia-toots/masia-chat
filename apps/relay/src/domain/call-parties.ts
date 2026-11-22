import { DeviceRole, MAX_DEVICES_PER_USER, RelayError, RelayErrorCode } from '@masia/relay';
import type { Principal } from '../auth.js';
import type { Queryable } from '../db.js';
import { assertCurrentMember, findMembership } from './rooms.js';

/**
 * Who may signal whom on the call channel (ADR-228), read from the relay's own records on every request: never from
 * the body, never cached. The rule, whole:
 *
 * - the sender is the token's device: registered, not revoked, a USER device of the token's own user (a guardian's
 *   device of a child and an assistant device never call);
 * - the sender is a current member of the room (`assertCurrentMember`: NOT_A_MEMBER, REMOVED);
 * - the room's current, unrevoked members are USER devices of exactly two people, the sender's person one of them;
 * - the target is one of those devices, of the OTHER person.
 *
 * Anything else is 403 CALL_NOT_ALLOWED, with one message for every cause: the sender can see its room's members
 * anyway, and nobody else gets this far.
 */

export interface CallDevice {
  readonly id: string;
  readonly userId: string;
}

function callNotAllowed(): RelayError {
  return new RelayError(
    RelayErrorCode.CALL_NOT_ALLOWED,
    'Calls go only between USER devices of the two people of a one-to-one room.',
  );
}

/** The most current members a one-to-one room can have: every device of both people. One more and it is not one. */
const ONE_TO_ONE_MEMBERS_MAX = 2 * MAX_DEVICES_PER_USER;

interface DeviceRow {
  readonly id: string;
  readonly userId: string;
  readonly role: DeviceRole;
  readonly revoked: boolean;
}

/** The token's device, if it may use the call channel at all: an active USER device of the token's own user. */
export async function requireCallingDevice(q: Queryable, principal: Principal): Promise<CallDevice> {
  const { rows } = await q.query<DeviceRow>(
    `SELECT id, user_id AS "userId", role, revoked_at IS NOT NULL AS revoked FROM devices WHERE id = $1`,
    [principal.deviceId],
  );
  const device = rows[0];
  if (device === undefined || device.revoked || device.role !== DeviceRole.USER || device.userId !== principal.userId) {
    throw callNotAllowed();
  }
  return { id: device.id, userId: device.userId };
}

/** Is `device` still an active USER device of the same person? What an open stream asks again and again. */
export async function stillCallingDevice(q: Queryable, device: CallDevice): Promise<boolean> {
  const { rows } = await q.query<{ ok: boolean }>(
    `SELECT revoked_at IS NULL AND role = $2 AND user_id = $3 AS ok FROM devices WHERE id = $1`,
    [device.id, DeviceRole.USER, device.userId],
  );
  return rows[0]?.ok === true;
}

/** The target of a signal from `sender` in `conversationId`, by the rule above; throws otherwise. */
export async function requireCallTarget(
  q: Queryable,
  conversationId: string,
  sender: CallDevice,
  toDeviceId: string,
): Promise<CallDevice> {
  assertCurrentMember(await findMembership(q, conversationId, sender.id));
  const { rows } = await q.query<{ id: string; userId: string; role: DeviceRole }>(
    `SELECT d.id, d.user_id AS "userId", d.role
     FROM room_members m JOIN devices d ON d.id = m.device_id
     WHERE m.conversation_id = $1 AND m.removed_at_epoch IS NULL AND d.revoked_at IS NULL
     LIMIT $2`,
    [conversationId, ONE_TO_ONE_MEMBERS_MAX + 1],
  );
  if (rows.length > ONE_TO_ONE_MEMBERS_MAX) throw callNotAllowed();
  if (rows.some((row) => row.role !== DeviceRole.USER)) throw callNotAllowed();
  const people = new Set(rows.map((row) => row.userId));
  if (people.size !== 2 || !people.has(sender.userId)) throw callNotAllowed();
  const target = rows.find((row) => row.id === toDeviceId);
  if (target === undefined || target.userId === sender.userId) throw callNotAllowed();
  return { id: target.id, userId: target.userId };
}
