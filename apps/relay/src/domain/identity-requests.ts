import {
  DeviceRole,
  ED25519_SIGNATURE_BYTES,
  IDENTITY_REQUEST_DAILY_LIMIT,
  IDENTITY_REQUEST_LIMIT_WINDOW_MS,
  IDENTITY_REQUEST_OPEN_LIMIT,
  IDENTITY_REQUEST_TTL_MS,
  IdentityRequestPurpose,
  IdentityRequestState,
  PAIRING_COMMITMENT_BYTES,
  PAIRING_NONCE_BYTES,
  RelayError,
  RelayErrorCode,
  SEALED_IDENTITY_ENC_BYTES,
  SEALED_IDENTITY_MAX_BYTES,
  SEALED_IDENTITY_TTL_MS,
  TRANSFER_KEY_BYTES,
  verifyHolderProof,
  verifyIdentityRequestSignature,
  verifyPairingCommitment,
} from '@masia/relay';
import type { Principal } from '../auth.js';
import type { Database, Queryable } from '../db.js';
import { toBase64 } from '../dto.js';
import { findDeviceList, type StoredDeviceList } from './device-lists.js';
import { type DeviceRow, findDevice, findIdentityKey, revokeUnlessInRooms } from './devices.js';

/**
 * ADR-218 §1, §2, §4: a device asking for its person's identity key, and the holders that answer it.
 *
 * The relay is the mailbox and the referee, never a party: it stores what N signed, the two pairing
 * nonces and the key a holder SEALED to N's one-time transfer key, and serves the sealed key to N
 * alone. It checks every signature it can (the request under N's registered key, the reveal against
 * the commitment, every holder's proof under the pinned key) so nothing it stores is a forgery, but a
 * client trusts none of it: the number, the aad and its own pin are what protect the person.
 *
 * Who may do what (every route is the token's own account, `/users/me/…`):
 *  - N, a USER device of the account, creates (`pair` when it is not on the latest stored list,
 *    `backfill` when it is and holds no proof), reads, reveals and cancels its own request;
 *  - a HOLDER (`assertHolder`: an unrevoked USER device on the latest stored list whose holder proof
 *    verifies under the pinned key) challenges, approves and rejects. A pairing is approved by the
 *    holder that challenged it, a backfill by any holder;
 *  - any USER device of the account reads the account's requests (nothing in them is secret but the
 *    sealed key, which only N is served).
 *
 * The state is derived from the timestamps (`stateOf`), so it cannot disagree with them. Times come
 * from the injected clock. Requests are logged by nobody here; the HTTP log names ids only.
 *
 * Lock order (with devices.ts and device-lists.ts): the pin, then the list, then identity requests,
 * then device rows. A create takes the pin FOR UPDATE, which is what serializes the account's caps.
 */

/** One stored request, as the queries below return it. */
export interface IdentityRequestRow {
  readonly id: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly purpose: IdentityRequestPurpose;
  readonly transferKey: Buffer;
  readonly commitment: Buffer | null;
  readonly requestSignature: Buffer;
  readonly challengerDeviceId: string | null;
  readonly holderNonce: Buffer | null;
  readonly deviceNonce: Buffer | null;
  readonly listVersion: number | null;
  readonly sealedEnc: Buffer | null;
  readonly sealedCt: Buffer | null;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly approvedAt: Date | null;
  readonly rejectedAt: Date | null;
}

const REQUEST_COLUMNS = `id, user_id AS "userId", device_id AS "deviceId", purpose,
  transfer_key AS "transferKey", commitment, request_signature AS "requestSignature",
  challenger_device_id AS "challengerDeviceId", holder_nonce AS "holderNonce",
  device_nonce AS "deviceNonce", list_version AS "listVersion", sealed_enc AS "sealedEnc",
  sealed_ct AS "sealedCt", created_at AS "createdAt", expires_at AS "expiresAt",
  approved_at AS "approvedAt", rejected_at AS "rejectedAt"`;

/** The sealed key as it is served: HPKE `enc` and ciphertext. */
export interface SealedIdentity {
  readonly enc: Buffer;
  readonly ciphertext: Buffer;
}

/** A request as one reader sees it: the row, its state now, and the sealed key if it is theirs. */
export interface IdentityRequestView {
  readonly request: IdentityRequestRow;
  readonly state: IdentityRequestState;
  /** Non-null for N alone, from approval until its holder proof or `SEALED_IDENTITY_TTL_MS`. */
  readonly sealed: SealedIdentity | null;
}

/** Where a request is at `now` (epoch ms): the one derivation of `IdentityRequestState`. */
export function stateOf(row: IdentityRequestRow, now: number): IdentityRequestState {
  if (row.rejectedAt !== null) return IdentityRequestState.REJECTED;
  if (row.approvedAt !== null) return IdentityRequestState.APPROVED;
  if (row.expiresAt.getTime() <= now) return IdentityRequestState.EXPIRED;
  if (row.deviceNonce !== null) return IdentityRequestState.REVEALED;
  if (row.holderNonce !== null) return IdentityRequestState.CHALLENGED;
  return IdentityRequestState.OPEN;
}

/** The states a request can still move from (a holder may reject them, N may cancel them). */
const OPEN_STATES: ReadonlySet<IdentityRequestState> = new Set([
  IdentityRequestState.OPEN,
  IdentityRequestState.CHALLENGED,
  IdentityRequestState.REVEALED,
]);

function viewOf(row: IdentityRequestRow, viewerDeviceId: string, now: number): IdentityRequestView {
  const sealed =
    row.deviceId === viewerDeviceId &&
    row.sealedEnc !== null &&
    row.sealedCt !== null &&
    row.approvedAt !== null &&
    // Retention clears it too; this keeps a late sweep from serving it a minute longer.
    row.approvedAt.getTime() + SEALED_IDENTITY_TTL_MS > now
      ? { enc: row.sealedEnc, ciphertext: row.sealedCt }
      : null;
  return { request: row, state: stateOf(row, now), sealed };
}

/** Why a request is refused beyond its state, for `reason` in a 409 (a client can tell them apart). */
export const IdentityRequestRefusal = {
  /** `pair` from a device already on the latest stored list: it asks with `backfill`. */
  LISTED: 'LISTED',
  /** `backfill` from a device that already holds the key (its proof verifies). */
  HOLDER: 'HOLDER',
  /** An approve of a pairing by a holder that is not the one that challenged it. */
  NOT_THE_CHALLENGER: 'NOT_THE_CHALLENGER',
  /** A challenge of a `backfill` request: it has no number step. */
  NO_NUMBER_STEP: 'NO_NUMBER_STEP',
} as const;

/** Which cap a 429 IDENTITY_REQUEST_LIMIT hit, as `limit` in the answer. */
export const IdentityRequestLimit = {
  OPEN: 'OPEN',
  DAILY: 'DAILY',
} as const;

function wrongState(
  state: IdentityRequestState,
  message: string,
  details: Record<string, unknown> = {},
): RelayError {
  return new RelayError(RelayErrorCode.IDENTITY_REQUEST_STATE, message, { ...details, state });
}

function invalid(message: string): RelayError {
  return new RelayError(RelayErrorCode.VALIDATION_FAILED, message);
}

/** `bytes` must be exactly `length` long: the canonical bytes and the checks take nothing else. */
function exactly(bytes: Buffer, length: number, field: string): Buffer {
  if (bytes.length !== length) throw invalid(`${field} must be ${length} bytes.`);
  return bytes;
}

/** Every stored request of the account, oldest first (a rejected one too, until retention takes it). */
export async function findIdentityRequestsOf(
  q: Queryable,
  userId: string,
): Promise<IdentityRequestRow[]> {
  const { rows } = await q.query<IdentityRequestRow>(
    `SELECT ${REQUEST_COLUMNS} FROM identity_requests WHERE user_id = $1 ORDER BY created_at, id`,
    [userId],
  );
  return rows;
}

/**
 * Is `device` on `list` as itself: its id, its registered role and signature key? Every caller here
 * holds a USER device; the operator's report (operator/identity-reset.ts) asks it of any role.
 */
export function listsDevice(list: StoredDeviceList | null, device: DeviceRow): boolean {
  return (
    list !== null &&
    list.devices.some(
      (entry) =>
        entry.id === device.id &&
        entry.role === device.role &&
        Buffer.from(entry.signatureKey, 'base64').equals(device.signatureKeyPub),
    )
  );
}

/** Does `device`'s stored holder proof verify under `pin`? */
export async function provesHolding(device: DeviceRow, pin: Buffer | null): Promise<boolean> {
  if (pin === null || device.holderProof === null) return false;
  return verifyHolderProof(
    pin,
    { userId: device.userId, deviceId: device.id, signatureKey: device.signatureKeyPub },
    device.holderProof,
  );
}

/**
 * The calling device, which must be a USER device of the token's own account. GUARDIAN and ASSISTANT
 * devices never hold a person's key, and a guardian's token drives a CHILD's device, not its own.
 */
async function callerDevice(q: Queryable, principal: Principal): Promise<DeviceRow> {
  const device = await findDevice(q, principal.deviceId);
  if (device === null || device.userId !== principal.userId || device.role !== DeviceRole.USER) {
    throw new RelayError(
      RelayErrorCode.ROLE_FORBIDDEN,
      "Identity requests are for a person's own USER devices.",
    );
  }
  if (device.revokedAt !== null) {
    throw new RelayError(RelayErrorCode.ACTOR_DEVICE_REVOKED, 'This device has been revoked.');
  }
  return device;
}

/**
 * THE holder check (ADR-218 §2, §5): the caller is an unrevoked USER device of the account, on the
 * latest stored list as itself, with a holder proof that verifies under the pinned key. An unapproved
 * ghost (a stolen session's new device) is none of these, so it cannot challenge, approve or reject.
 */
async function assertHolder(q: Queryable, principal: Principal): Promise<DeviceRow> {
  const device = await callerDevice(q, principal);
  const holds =
    listsDevice(await findDeviceList(q, device.userId), device) &&
    (await provesHolding(device, await findIdentityKey(q, device.userId)));
  if (!holds) {
    throw new RelayError(
      RelayErrorCode.NOT_A_HOLDER,
      "Only a listed device that holds the person's identity key may do this.",
    );
  }
  return device;
}

/** The account's request `id`, locked for the change about to be made; 404 for any other account's. */
async function lockRequest(tx: Queryable, userId: string, id: string): Promise<IdentityRequestRow> {
  const { rows } = await tx.query<IdentityRequestRow>(
    `SELECT ${REQUEST_COLUMNS} FROM identity_requests WHERE id = $1 AND user_id = $2 FOR UPDATE`,
    [id, userId],
  );
  const row = rows[0];
  if (row === undefined) {
    throw new RelayError(RelayErrorCode.NOT_FOUND, 'No such identity request.');
  }
  return row;
}

async function updated(
  tx: Queryable,
  sql: string,
  params: readonly unknown[],
): Promise<IdentityRequestRow> {
  const { rows } = await tx.query<IdentityRequestRow>(
    `${sql} RETURNING ${REQUEST_COLUMNS}`,
    params,
  );
  const row = rows[0];
  if (row === undefined) {
    // Unreachable: the row is locked by this transaction and requests are deleted only by retention.
    throw new RelayError(RelayErrorCode.INTERNAL, 'The identity request vanished.');
  }
  return row;
}

export interface CreateIdentityRequestInput {
  readonly purpose: IdentityRequestPurpose;
  readonly transferKey: Buffer;
  /** `pair` only. */
  readonly commitment: Buffer | null;
  readonly signature: Buffer;
}

export interface ApproveIdentityRequestInput {
  readonly listVersion: number;
  readonly sealed: SealedIdentity;
}

export interface IdentityRequestDirectory {
  /** N asks (201). The calling device is N. */
  create(principal: Principal, input: CreateIdentityRequestInput): Promise<IdentityRequestView>;
  /** Every request of the account, oldest first, as the caller sees them. */
  list(principal: Principal): Promise<IdentityRequestView[]>;
  get(principal: Principal, id: string): Promise<IdentityRequestView>;
  /** N withdraws its own request: it expires now. Idempotent on an expired one. */
  cancel(principal: Principal, id: string): Promise<void>;
  /** A holder draws the number step's first half (`r_B`). Set once. */
  challenge(principal: Principal, id: string, nonce: Buffer): Promise<IdentityRequestView>;
  /** N reveals `r_N`; the relay checks it opens the commitment. */
  reveal(principal: Principal, id: string, nonce: Buffer): Promise<IdentityRequestView>;
  /** The holder hands over the sealed key. */
  approve(
    principal: Principal,
    id: string,
    input: ApproveIdentityRequestInput,
  ): Promise<IdentityRequestView>;
  /** A holder says «Це не я»: the request is rejected and N is revoked when it is in no room. */
  reject(principal: Principal, id: string): Promise<IdentityRequestView>;
}

export interface IdentityRequestDirectoryOptions {
  /** The relay's clock (epoch ms); tests move it. */
  readonly now?: () => number;
}

export function createIdentityRequestDirectory(
  db: Database,
  options: IdentityRequestDirectoryOptions = {},
): IdentityRequestDirectory {
  const clock = options.now ?? Date.now;

  return {
    async create(principal, input) {
      const pair = input.purpose === IdentityRequestPurpose.PAIR;
      if (pair !== (input.commitment !== null)) {
        throw invalid('A pair request carries a commitment; a backfill request carries none.');
      }
      const transferKey = exactly(input.transferKey, TRANSFER_KEY_BYTES, 'transferKey');
      const commitment =
        input.commitment === null
          ? null
          : exactly(input.commitment, PAIRING_COMMITMENT_BYTES, 'commitment');
      const signature = exactly(input.signature, ED25519_SIGNATURE_BYTES, 'signature');

      return db.transaction(async (tx) => {
        // The pin first, FOR UPDATE: two creates of one account queue here, so the caps below count
        // committed rows; a reset (which locks the pin too) waits for this one or is seen by it.
        const pinned = await tx.query<{ identityKeyPub: Buffer }>(
          'SELECT identity_key_pub AS "identityKeyPub" FROM identity_keys WHERE user_id = $1 FOR UPDATE',
          [principal.userId],
        );
        const device = await callerDevice(tx, principal);
        const pin = pinned.rows[0]?.identityKeyPub ?? null;
        if (pin === null) {
          throw new RelayError(
            RelayErrorCode.IDENTITY_RESET_PENDING,
            "This account's identity key was reset; the first device pins the new one before anyone asks.",
          );
        }
        if (!pin.equals(device.identityKeyPub)) {
          throw new RelayError(
            RelayErrorCode.IDENTITY_KEY_CHANGED,
            'This device registered under another identity key; register again under the pinned one.',
            { identityKeyPub: toBase64(pin) },
          );
        }
        const signed = await verifyIdentityRequestSignature(
          device.signatureKeyPub,
          {
            userId: device.userId,
            deviceId: device.id,
            purpose: input.purpose,
            transferKey,
            ...(commitment === null ? {} : { commitment }),
          },
          signature,
        );
        if (!signed) {
          throw new RelayError(
            RelayErrorCode.IDENTITY_REQUEST_SIGNATURE_INVALID,
            "The request is not signed by this device's registered signature key.",
          );
        }

        const listed = listsDevice(await findDeviceList(tx, device.userId), device);
        if (pair && listed) {
          throw new RelayError(
            RelayErrorCode.IDENTITY_REQUEST_STATE,
            'This device is already on the list; ask with purpose backfill.',
            { reason: IdentityRequestRefusal.LISTED },
          );
        }
        if (!pair && !listed) {
          throw new RelayError(
            RelayErrorCode.DEVICE_NOT_IN_SIGNED_LIST,
            'Only a device on the latest list may ask for a backfill; ask with purpose pair.',
          );
        }
        if (!pair && (await provesHolding(device, pin))) {
          throw new RelayError(
            RelayErrorCode.IDENTITY_REQUEST_STATE,
            'This device already holds the key.',
            { reason: IdentityRequestRefusal.HOLDER },
          );
        }

        const now = clock();
        const at = new Date(now);
        // One open request per device: a new one replaces the old (which expires now).
        await tx.query(
          `UPDATE identity_requests SET expires_at = $2
           WHERE device_id = $1 AND approved_at IS NULL AND rejected_at IS NULL AND expires_at > $2`,
          [device.id, at],
        );
        const counts = await tx.query<{ open: string; recent: string }>(
          `SELECT
             count(*) FILTER (WHERE approved_at IS NULL AND rejected_at IS NULL AND expires_at > $2) AS open,
             count(*) FILTER (WHERE created_at > $3) AS recent
           FROM identity_requests WHERE user_id = $1`,
          [device.userId, at, new Date(now - IDENTITY_REQUEST_LIMIT_WINDOW_MS)],
        );
        const open = Number(counts.rows[0]?.open ?? 0);
        const recent = Number(counts.rows[0]?.recent ?? 0);
        if (open >= IDENTITY_REQUEST_OPEN_LIMIT) {
          throw new RelayError(
            RelayErrorCode.IDENTITY_REQUEST_LIMIT,
            'This account has as many open identity requests as it may have.',
            { limit: IdentityRequestLimit.OPEN, max: IDENTITY_REQUEST_OPEN_LIMIT },
          );
        }
        if (recent >= IDENTITY_REQUEST_DAILY_LIMIT) {
          throw new RelayError(
            RelayErrorCode.IDENTITY_REQUEST_LIMIT,
            'This account has made as many identity requests today as it may make.',
            { limit: IdentityRequestLimit.DAILY, max: IDENTITY_REQUEST_DAILY_LIMIT },
          );
        }

        const inserted = await tx.query<IdentityRequestRow>(
          `INSERT INTO identity_requests
             (user_id, device_id, purpose, transfer_key, commitment, request_signature, created_at, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING ${REQUEST_COLUMNS}`,
          [
            device.userId,
            device.id,
            input.purpose,
            transferKey,
            commitment,
            signature,
            at,
            new Date(now + IDENTITY_REQUEST_TTL_MS),
          ],
        );
        const row = inserted.rows[0];
        if (row === undefined) throw new RelayError(RelayErrorCode.INTERNAL, 'Insert failed.');
        return viewOf(row, device.id, now);
      });
    },

    async list(principal) {
      const device = await callerDevice(db, principal);
      const rows = await findIdentityRequestsOf(db, device.userId);
      const now = clock();
      return rows.map((row) => viewOf(row, device.id, now));
    },

    async get(principal, id) {
      const device = await callerDevice(db, principal);
      const { rows } = await db.query<IdentityRequestRow>(
        `SELECT ${REQUEST_COLUMNS} FROM identity_requests WHERE id = $1 AND user_id = $2`,
        [id, device.userId],
      );
      const row = rows[0];
      if (row === undefined) {
        throw new RelayError(RelayErrorCode.NOT_FOUND, 'No such identity request.');
      }
      return viewOf(row, device.id, clock());
    },

    async cancel(principal, id) {
      const device = await callerDevice(db, principal);
      await db.transaction(async (tx) => {
        const row = await lockRequest(tx, device.userId, id);
        if (row.deviceId !== device.id) {
          throw new RelayError(
            RelayErrorCode.DEVICE_MISMATCH,
            'Only the device that asked may cancel its request.',
          );
        }
        const now = clock();
        const state = stateOf(row, now);
        if (state === IdentityRequestState.EXPIRED) return;
        if (!OPEN_STATES.has(state)) {
          throw wrongState(state, 'An approved or rejected request cannot be cancelled.');
        }
        await tx.query('UPDATE identity_requests SET expires_at = $2 WHERE id = $1', [
          id,
          new Date(now),
        ]);
      });
    },

    async challenge(principal, id, nonce) {
      const holderNonce = exactly(nonce, PAIRING_NONCE_BYTES, 'nonce');
      const holder = await assertHolder(db, principal);
      return db.transaction(async (tx) => {
        const row = await lockRequest(tx, holder.userId, id);
        const now = clock();
        const state = stateOf(row, now);
        if (row.purpose !== IdentityRequestPurpose.PAIR) {
          throw wrongState(state, 'A backfill request has no number step.', {
            reason: IdentityRequestRefusal.NO_NUMBER_STEP,
          });
        }
        // Set once: a second challenge (another holder, or a replay) finds CHALLENGED and is refused,
        // so nobody can swap `r_B` under a number the person is already looking at.
        if (state !== IdentityRequestState.OPEN) {
          throw wrongState(state, 'Only an open request can be challenged, and only once.');
        }
        const next = await updated(
          tx,
          `UPDATE identity_requests
           SET holder_nonce = $2, challenger_device_id = $3, challenged_at = $4 WHERE id = $1`,
          [id, holderNonce, holder.id, new Date(now)],
        );
        return viewOf(next, holder.id, now);
      });
    },

    async reveal(principal, id, nonce) {
      const deviceNonce = exactly(nonce, PAIRING_NONCE_BYTES, 'nonce');
      const device = await callerDevice(db, principal);
      return db.transaction(async (tx) => {
        const row = await lockRequest(tx, device.userId, id);
        if (row.deviceId !== device.id) {
          throw new RelayError(
            RelayErrorCode.DEVICE_MISMATCH,
            'Only the device that asked may reveal its nonce.',
          );
        }
        const now = clock();
        const state = stateOf(row, now);
        if (state !== IdentityRequestState.CHALLENGED || row.commitment === null) {
          throw wrongState(state, 'A nonce is revealed once, after the challenge.');
        }
        // Hygiene (ADR-218 §2 step 3): the challenger checks the commitment itself; the relay refuses
        // a reveal that does not open it, so no holder is ever shown a number N did not commit to.
        const opens = await verifyPairingCommitment(
          {
            userId: device.userId,
            deviceId: device.id,
            signatureKey: device.signatureKeyPub,
            transferKey: row.transferKey,
            deviceNonce,
          },
          row.commitment,
        );
        if (!opens) {
          throw new RelayError(
            RelayErrorCode.IDENTITY_REQUEST_SIGNATURE_INVALID,
            'The nonce does not open the commitment of this request.',
          );
        }
        const next = await updated(
          tx,
          'UPDATE identity_requests SET device_nonce = $2, revealed_at = $3 WHERE id = $1',
          [id, deviceNonce, new Date(now)],
        );
        return viewOf(next, device.id, now);
      });
    },

    async approve(principal, id, input) {
      const enc = exactly(input.sealed.enc, SEALED_IDENTITY_ENC_BYTES, 'sealed.enc');
      const ciphertext = input.sealed.ciphertext;
      if (ciphertext.length === 0 || ciphertext.length > SEALED_IDENTITY_MAX_BYTES) {
        throw invalid(`sealed.ciphertext must be 1 to ${SEALED_IDENTITY_MAX_BYTES} bytes.`);
      }
      const holder = await assertHolder(db, principal);
      return db.transaction(async (tx) => {
        const row = await lockRequest(tx, holder.userId, id);
        const now = clock();
        const state = stateOf(row, now);
        if (row.purpose === IdentityRequestPurpose.PAIR) {
          if (state !== IdentityRequestState.REVEALED) {
            throw wrongState(state, 'A pairing is approved after the number step.');
          }
          if (row.challengerDeviceId !== holder.id) {
            throw wrongState(state, 'A pairing is approved by the holder that challenged it.', {
              reason: IdentityRequestRefusal.NOT_THE_CHALLENGER,
              challengerDeviceId: row.challengerDeviceId,
            });
          }
        } else if (state !== IdentityRequestState.OPEN) {
          throw wrongState(state, 'Only an open backfill request can be approved.');
        }
        const asking = await findDevice(tx, row.deviceId);
        if (asking === null || asking.revokedAt !== null) {
          throw new RelayError(
            RelayErrorCode.DEVICE_REVOKED,
            'The device that asked has been revoked.',
          );
        }
        const next = await updated(
          tx,
          `UPDATE identity_requests
           SET list_version = $2, sealed_enc = $3, sealed_ct = $4, approved_at = $5 WHERE id = $1`,
          [id, input.listVersion, enc, ciphertext, new Date(now)],
        );
        return viewOf(next, holder.id, now);
      });
    },

    async reject(principal, id) {
      const holder = await assertHolder(db, principal);
      return db.transaction(async (tx) => {
        const row = await lockRequest(tx, holder.userId, id);
        const now = clock();
        const state = stateOf(row, now);
        if (!OPEN_STATES.has(state)) {
          throw wrongState(state, 'Only an open request can be rejected.');
        }
        const next = await updated(
          tx,
          `UPDATE identity_requests SET rejected_at = $2, sealed_enc = NULL, sealed_ct = NULL
           WHERE id = $1`,
          [id, new Date(now)],
        );
        // «Це не я» revokes the device that asked (ADR-218 §2 step 5): another device of the same
        // person, so the ordinary revoke rule allows it, and in no room (an unlisted device cannot have
        // been added to one). One that IS in a room keeps going until its Remove: the request is
        // rejected either way, and the room rule removes an unlisted leaf.
        const { rows } = await tx.query<{ revokedAt: Date | null; userId: string }>(
          'SELECT revoked_at AS "revokedAt", user_id AS "userId" FROM devices WHERE id = $1 FOR UPDATE',
          [row.deviceId],
        );
        const asking = rows[0];
        if (
          asking !== undefined &&
          asking.revokedAt === null &&
          asking.userId === holder.userId &&
          row.deviceId !== holder.id
        ) {
          await revokeUnlessInRooms(tx, row.deviceId);
        }
        return viewOf(next, holder.id, now);
      });
    },
  };
}
