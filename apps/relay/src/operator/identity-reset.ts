import { DeviceRole, ID_REGEXP, IdentityRequestState, RelayError } from '@masia/relay';
import type { Database, Queryable } from '../db.js';
import { findDeviceList } from '../domain/device-lists.js';
import {
  DEVICE_COLUMNS,
  type DeviceRow,
  findOpenIdentityReset,
  IDENTITY_PINNING_ROLES,
  IDENTITY_RESET_REASON_MAX_LENGTH,
  type IdentityKeyReleased,
  identityKeyDigest,
  IdentityResetActor,
  type OpenIdentityReset,
  releaseIdentityKey,
} from '../domain/devices.js';
import {
  findIdentityRequestsOf,
  listsDevice,
  provesHolding,
  stateOf,
} from '../domain/identity-requests.js';

/**
 * The relay operator's identity-key reset (ADR-218 §6): the way out for a person who lost every device
 * that held their identity key. It runs on the relay's own machine against the relay's own database;
 * the machine login is the authentication, and nothing here is reachable over HTTP.
 *
 *   identity-reset <userId>                                  dry run: what the account has
 *   identity-reset <userId> --first-device <id> [--revoke <id,…>] [--reason <text>]
 *                                                            dry run of exactly that reset
 *   identity-reset <userId> --apply --confirm <userId> --first-device <id> [--revoke <id,…>] [--reason <text>]
 *
 * A DRY RUN BY DEFAULT, in a READ ONLY transaction: it cannot change anything. It prints the pin's
 * fingerprint, the chain, every device (role, listed, holder, follows the pin, rooms, key packages,
 * last seen), the stored identity requests, an open ticket, and exactly what `--apply` would do.
 *
 * `--apply` needs `--confirm` with the same user id and `--first-device` (a registered, unrevoked USER
 * device of that person: the only one that may pin the next key). `--revoke` names devices to revoke
 * past STILL_IN_ROOMS (lost, stolen, zombie) and then needs `--reason`. The apply prints the same plan,
 * then runs `releaseIdentityKey` in one transaction (actor OPERATOR), which checks every device again
 * under the account's identity lock. Surviving devices are not revoked: they rebind to the new pin.
 *
 * A device is named by its full id or by a unique prefix of at least `DEVICE_PREFIX_MIN_LENGTH`
 * characters among the account's own devices; the plan and the audit row always carry full ids.
 * Nothing printed is a secret: public-key fingerprints, ids, counts and times.
 */

/** The shortest device-id prefix the CLI resolves: enough to be unique on any one account. */
export const DEVICE_PREFIX_MIN_LENGTH = 8;

/** How many hex digits of a key's SHA-256 the output shows. */
const FINGERPRINT_HEX_LENGTH = 16;

export const IDENTITY_RESET_USAGE = [
  'usage: identity-reset <userId>                         dry run (changes nothing)',
  '       identity-reset <userId> --first-device <id> [--revoke <id,...>] [--reason <text>]',
  '                                                       dry run of exactly that reset',
  '       identity-reset <userId> --apply --confirm <userId> --first-device <id>',
  '                      [--revoke <id,...>] [--reason <text>]',
  `A device is its full id or a unique prefix of at least ${DEVICE_PREFIX_MIN_LENGTH} characters.`,
  `--revoke needs --reason (1 to ${IDENTITY_RESET_REASON_MAX_LENGTH} characters).`,
].join('\n');

/** What the command line asks for. Device references are still unresolved (`resolveDevice`). */
export interface IdentityResetArgs {
  readonly userId: string;
  readonly apply: boolean;
  readonly confirm: string | null;
  readonly firstDevice: string | null;
  readonly revoke: readonly string[];
  readonly reason: string | null;
  readonly help: boolean;
}

/** A command line the CLI refuses before it opens the database (exit 2). */
export class IdentityResetUsageError extends Error {}

const VALUE_FLAGS = ['--confirm', '--first-device', '--revoke', '--reason'] as const;
type ValueFlag = (typeof VALUE_FLAGS)[number];

function isValueFlag(flag: string): flag is ValueFlag {
  return (VALUE_FLAGS as readonly string[]).includes(flag);
}

function deviceRef(value: string, flag: string): string {
  if (!ID_REGEXP.test(value))
    throw new IdentityResetUsageError(`${flag}: "${value}" is not a device id.`);
  return value;
}

/**
 * Parses and checks the command line. Everything that can be refused without the database is
 * refused here: an `--apply` without `--confirm` (the same user id) or without `--first-device`, a
 * `--revoke` without `--reason`, a reason that is too long, an unknown or repeated flag.
 */
export function parseIdentityResetArgs(argv: readonly string[]): IdentityResetArgs {
  const values = new Map<ValueFlag, string>();
  const revoke: string[] = [];
  const positional: string[] = [];
  let apply = false;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    if (arg === '--apply') {
      apply = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }
    if (arg.startsWith('--')) {
      const equals = arg.indexOf('=');
      const flag = equals === -1 ? arg : arg.slice(0, equals);
      if (!isValueFlag(flag)) throw new IdentityResetUsageError(`Unknown flag ${flag}.`);
      let value: string | undefined;
      if (equals === -1) {
        value = argv[index + 1];
        index += 1;
      } else {
        value = arg.slice(equals + 1);
      }
      if (value === undefined || value === '' || (equals === -1 && value.startsWith('--'))) {
        throw new IdentityResetUsageError(`${flag} needs a value.`);
      }
      if (flag === '--revoke') {
        for (const id of value.split(',')) {
          const trimmed = id.trim();
          if (trimmed !== '') revoke.push(deviceRef(trimmed, flag));
        }
        continue;
      }
      if (values.has(flag)) throw new IdentityResetUsageError(`${flag} is given twice.`);
      values.set(flag, value);
      continue;
    }
    positional.push(arg);
  }

  if (help) {
    return {
      userId: '',
      apply: false,
      confirm: null,
      firstDevice: null,
      revoke: [],
      reason: null,
      help,
    };
  }
  if (positional.length !== 1) {
    throw new IdentityResetUsageError('Name exactly one account: identity-reset <userId>.');
  }
  const userId = positional[0] ?? '';
  if (!ID_REGEXP.test(userId)) throw new IdentityResetUsageError(`"${userId}" is not a user id.`);

  const confirm = values.get('--confirm') ?? null;
  const firstDevice = values.get('--first-device') ?? null;
  const reason = values.get('--reason') ?? null;
  if (firstDevice !== null) deviceRef(firstDevice, '--first-device');
  if (reason !== null && reason.length > IDENTITY_RESET_REASON_MAX_LENGTH) {
    throw new IdentityResetUsageError(
      `--reason is at most ${IDENTITY_RESET_REASON_MAX_LENGTH} characters.`,
    );
  }
  if (revoke.length > 0 && reason === null) {
    throw new IdentityResetUsageError(
      '--revoke revokes devices past their rooms: give a --reason.',
    );
  }
  if (confirm !== null && !apply) {
    throw new IdentityResetUsageError('--confirm goes with --apply only.');
  }
  if (apply) {
    if (confirm === null) {
      throw new IdentityResetUsageError(
        '--apply needs --confirm <userId>, the same user id again.',
      );
    }
    if (confirm !== userId) {
      throw new IdentityResetUsageError('--confirm does not match the user id: nothing was done.');
    }
    if (firstDevice === null) {
      throw new IdentityResetUsageError(
        '--apply needs --first-device <id>: the device that pins the new key.',
      );
    }
  }
  return { userId, apply, confirm, firstDevice, revoke, reason, help };
}

/** One device of the account as the operator sees it. */
export interface ResetDeviceView {
  readonly device: DeviceRow;
  /** On the latest stored list as itself (USER devices; `listsDevice`). */
  readonly listed: boolean;
  /** Its holder proof verifies under the current pin (`provesHolding`). */
  readonly holder: boolean;
  /** The identity key its row carries is the current pin. */
  readonly followsPin: boolean;
  /** Rooms it is still a member of (not Removed). */
  readonly rooms: number;
  /** Key packages it has that were never handed out (the last-resort one included). */
  readonly keyPackages: number;
}

/** A stored identity request, as the operator sees it. */
export interface ResetRequestView {
  readonly id: string;
  readonly deviceId: string;
  readonly purpose: string;
  readonly state: IdentityRequestState;
  readonly createdAt: Date;
}

/** Everything the dry run reports about one account. */
export interface IdentityResetInspection {
  readonly userId: string;
  readonly pin: { readonly fingerprint: string; readonly pinnedAt: Date } | null;
  /** Version of the latest stored list; `null`: none. */
  readonly listVersion: number | null;
  /** Stored versions of the list (the chain the reset deletes). */
  readonly chainLength: number;
  /** Every device of the account, revoked ones too, oldest first. */
  readonly devices: readonly ResetDeviceView[];
  readonly requests: readonly ResetRequestView[];
  readonly openTicket: OpenIdentityReset | null;
  /** Resets already recorded for the account. */
  readonly earlierResets: number;
}

/** `sha256:<16 hex>` of a public key: what the output calls a key. */
export function keyFingerprint(identityKeyPub: Buffer): string {
  return `sha256:${identityKeyDigest(identityKeyPub).toString('hex').slice(0, FINGERPRINT_HEX_LENGTH)}`;
}

/** Refused by the database's state rather than by the command line (exit 1). */
export class IdentityResetRefusal extends Error {}

/** Reads what the dry run reports. Runs inside the caller's transaction (READ ONLY for a dry run). */
export async function inspectIdentityReset(
  q: Queryable,
  userId: string,
  now: number,
): Promise<IdentityResetInspection> {
  const table = await q.query<{ present: string | null }>(
    "SELECT to_regclass('identity_resets')::text AS present",
  );
  if (table.rows[0]?.present === null || table.rows[0]?.present === undefined) {
    throw new IdentityResetRefusal(
      'This relay database has no identity_resets table: apply the relay migrations (deploy) first.',
    );
  }
  const pinRows = await q.query<{ identityKeyPub: Buffer; pinnedAt: Date }>(
    'SELECT identity_key_pub AS "identityKeyPub", pinned_at AS "pinnedAt" FROM identity_keys WHERE user_id = $1',
    [userId],
  );
  const pinRow = pinRows.rows[0] ?? null;
  const pin = pinRow?.identityKeyPub ?? null;
  const list = await findDeviceList(q, userId);
  const chain = await q.query<{ n: string }>(
    'SELECT count(*) AS n FROM device_list_versions WHERE user_id = $1',
    [userId],
  );
  const deviceRows = await q.query<DeviceRow>(
    `SELECT ${DEVICE_COLUMNS} FROM devices WHERE user_id = $1 ORDER BY created_at, id`,
    [userId],
  );
  const ids = deviceRows.rows.map((row) => row.id);
  const rooms = await q.query<{ deviceId: string; n: string }>(
    `SELECT device_id AS "deviceId", count(*) AS n FROM room_members
     WHERE device_id = ANY($1::text[]) AND removed_at_epoch IS NULL GROUP BY device_id`,
    [ids],
  );
  const packages = await q.query<{ deviceId: string; n: string }>(
    `SELECT device_id AS "deviceId", count(*) AS n FROM key_packages
     WHERE device_id = ANY($1::text[]) AND consumed_at IS NULL GROUP BY device_id`,
    [ids],
  );
  const roomsOf = new Map(rooms.rows.map((row) => [row.deviceId, Number(row.n)]));
  const packagesOf = new Map(packages.rows.map((row) => [row.deviceId, Number(row.n)]));
  const devices: ResetDeviceView[] = [];
  for (const device of deviceRows.rows) {
    devices.push({
      device,
      listed: listsDevice(list, device),
      holder: await provesHolding(device, pin),
      followsPin: pin !== null && device.identityKeyPub.equals(pin),
      rooms: roomsOf.get(device.id) ?? 0,
      keyPackages: packagesOf.get(device.id) ?? 0,
    });
  }
  const requests = (await findIdentityRequestsOf(q, userId)).map((row) => ({
    id: row.id,
    deviceId: row.deviceId,
    purpose: row.purpose,
    state: stateOf(row, now),
    createdAt: row.createdAt,
  }));
  const resets = await q.query<{ n: string }>(
    'SELECT count(*) AS n FROM identity_resets WHERE user_id = $1',
    [userId],
  );
  return {
    userId,
    pin:
      pinRow === null
        ? null
        : { fingerprint: keyFingerprint(pinRow.identityKeyPub), pinnedAt: pinRow.pinnedAt },
    listVersion: list?.version ?? null,
    chainLength: Number(chain.rows[0]?.n ?? 0),
    devices,
    requests,
    openTicket: await findOpenIdentityReset(q, userId),
    earlierResets: Number(resets.rows[0]?.n ?? 0),
  };
}

/**
 * The device a reference names among the account's devices: the exact id, else the one device whose
 * id starts with it (at least `DEVICE_PREFIX_MIN_LENGTH` characters). A string says why there is none.
 */
export function resolveDevice(
  devices: readonly ResetDeviceView[],
  ref: string,
): ResetDeviceView | string {
  const exact = devices.find((view) => view.device.id === ref);
  if (exact !== undefined) return exact;
  if (ref.length < DEVICE_PREFIX_MIN_LENGTH) {
    return `"${ref}" is no device id of this account (a prefix needs ${DEVICE_PREFIX_MIN_LENGTH}+ characters).`;
  }
  const matches = devices.filter((view) => view.device.id.startsWith(ref));
  if (matches.length === 1 && matches[0] !== undefined) return matches[0];
  return matches.length === 0
    ? `"${ref}" is no device of this account.`
    : `"${ref}" names ${matches.length} devices of this account: give more of the id.`;
}

/** What `--apply` would do with these arguments, or why it cannot. */
export interface IdentityResetPlan {
  readonly firstDevice: ResetDeviceView | null;
  readonly revoke: readonly ResetDeviceView[];
  /** USER and ASSISTANT devices that stay: they rebind to the new pin. */
  readonly survivors: readonly ResetDeviceView[];
  readonly problems: readonly string[];
}

export function planIdentityReset(
  inspection: IdentityResetInspection,
  args: IdentityResetArgs,
): IdentityResetPlan {
  const problems: string[] = [];
  let firstDevice: ResetDeviceView | null = null;
  if (args.firstDevice !== null) {
    const resolved = resolveDevice(inspection.devices, args.firstDevice);
    if (typeof resolved === 'string') {
      problems.push(`--first-device: ${resolved}`);
    } else if (resolved.device.role !== DeviceRole.USER) {
      problems.push(
        `--first-device: ${resolved.device.id} is a ${resolved.device.role} device, not USER.`,
      );
    } else if (resolved.device.revokedAt !== null) {
      problems.push(`--first-device: ${resolved.device.id} is revoked.`);
    } else {
      firstDevice = resolved;
    }
  }
  const revoke: ResetDeviceView[] = [];
  for (const ref of args.revoke) {
    const resolved = resolveDevice(inspection.devices, ref);
    if (typeof resolved === 'string') {
      problems.push(`--revoke: ${resolved}`);
    } else if (resolved.device.revokedAt !== null) {
      problems.push(`--revoke: ${resolved.device.id} is already revoked; leave it out.`);
    } else if (firstDevice !== null && resolved.device.id === firstDevice.device.id) {
      problems.push(`--revoke: ${resolved.device.id} is the first device.`);
    } else if (!revoke.some((view) => view.device.id === resolved.device.id)) {
      revoke.push(resolved);
    }
  }
  const leaving = new Set(revoke.map((view) => view.device.id));
  const survivors = inspection.devices.filter(
    (view) =>
      view.device.revokedAt === null &&
      IDENTITY_PINNING_ROLES.includes(view.device.role) &&
      view.device.id !== firstDevice?.device.id &&
      !leaving.has(view.device.id),
  );
  return { firstDevice, revoke, survivors, problems };
}

function when(date: Date | null): string {
  return date === null ? '-' : `${date.toISOString().slice(0, 16).replace('T', ' ')}Z`;
}

function yesNo(value: boolean): string {
  return value ? 'yes' : 'no';
}

/** The dry run's report, as lines. */
export function formatInspection(inspection: IdentityResetInspection): string[] {
  const lines: string[] = [];
  const pin = inspection.pin;
  lines.push(`account   ${inspection.userId}`);
  lines.push(
    pin === null ? 'pin       none' : `pin       ${pin.fingerprint} · pinned ${when(pin.pinnedAt)}`,
  );
  lines.push(
    `list      ${inspection.listVersion === null ? 'none' : `version ${inspection.listVersion}`} · ` +
      `${inspection.chainLength} stored version(s)`,
  );
  const ticket = inspection.openTicket;
  lines.push(
    `ticket    ${
      ticket === null
        ? 'none open'
        : ticket.expired
          ? `EXPIRED (opened ${when(ticket.createdAt)}): nobody may pin until a new reset`
          : `OPEN since ${when(ticket.createdAt)}: only ${ticket.firstDeviceId} may pin`
    }` + ` · ${inspection.earlierResets} reset(s) recorded`,
  );
  lines.push('');
  lines.push(`devices (${inspection.devices.length})`);
  for (const view of inspection.devices) {
    const { device } = view;
    const state = device.revokedAt === null ? 'active' : `revoked ${when(device.revokedAt)}`;
    const label = [device.name, device.platform].filter((part) => part !== null).join(' · ');
    lines.push(`  ${device.id}  ${device.role}  ${state}${label === '' ? '' : `  (${label})`}`);
    lines.push(
      `      listed ${device.role === DeviceRole.USER ? yesNo(view.listed) : '-'} · holder ${yesNo(view.holder)}` +
        ` · follows pin ${yesNo(view.followsPin)} · rooms ${view.rooms} · key packages ${view.keyPackages}` +
        ` · last seen ${when(device.lastSeenAt)}`,
    );
  }
  lines.push('');
  const open = inspection.requests.filter(
    (request) => request.state !== IdentityRequestState.REJECTED,
  );
  lines.push(
    `identity requests (${inspection.requests.length} stored, ${open.length} not rejected)`,
  );
  for (const request of inspection.requests) {
    lines.push(
      `  ${request.id}  ${request.purpose}  ${request.state}  device ${request.deviceId}  ${when(request.createdAt)}`,
    );
  }
  return lines;
}

/** What `--apply` would do (or did), as lines. */
export function formatPlan(
  inspection: IdentityResetInspection,
  plan: IdentityResetPlan,
  args: IdentityResetArgs,
): string[] {
  const lines: string[] = [];
  if (plan.problems.length > 0) {
    lines.push('REFUSED: --apply would not run:');
    for (const problem of plan.problems) lines.push(`  - ${problem}`);
    return lines;
  }
  const first = plan.firstDevice;
  if (first === null) {
    const candidates = inspection.devices.filter(
      (view) => view.device.role === DeviceRole.USER && view.device.revokedAt === null,
    );
    lines.push(
      'No --first-device given, so there is no plan yet. The device that pins the new key is',
    );
    lines.push('one of these unrevoked USER devices:');
    for (const view of candidates) lines.push(`  ${view.device.id}  rooms ${view.rooms}`);
    if (candidates.length === 0) lines.push('  (none: the person registers a device first)');
    return lines;
  }
  const notRejected = inspection.requests.filter(
    (request) => request.state !== IdentityRequestState.REJECTED,
  ).length;
  const proofs = inspection.devices.filter((view) => view.device.holderProof !== null).length;
  lines.push('--apply does, in ONE transaction:');
  lines.push(
    `  1. delete the pin (${inspection.pin?.fingerprint ?? 'none pinned'}), the list and its ` +
      `${inspection.chainLength} stored version(s): the new key starts a new chain at version 1`,
  );
  lines.push(
    `  2. delete ${notRejected} identity request(s) that are not rejected, with their sealed keys`,
  );
  lines.push(`  3. clear ${proofs} holder proof(s)`);
  if (plan.revoke.length === 0) {
    lines.push('  4. revoke no device');
  } else {
    for (const view of plan.revoke) {
      lines.push(
        `  4. revoke ${view.device.id} past STILL_IN_ROOMS (in ${view.rooms} room(s)) and delete its ` +
          `${view.keyPackages} unconsumed key package(s)`,
      );
    }
  }
  lines.push(
    `  5. ${inspection.openTicket === null ? '' : `close the open ticket ${inspection.openTicket.id} as superseded; `}` +
      `write the audit row (OPERATOR${args.reason === null ? '' : `, reason "${args.reason}"`}): ` +
      `the ticket for ${first.device.id}`,
  );
  lines.push(
    `Then only ${first.device.id} may pin the next key (409 IDENTITY_RESET_PENDING for any other).`,
  );
  lines.push(
    plan.survivors.length === 0
      ? 'No other device survives.'
      : `Kept, and rebound to the new pin on their next registration: ${plan.survivors.map((view) => view.device.id).join(', ')}.`,
  );
  return lines;
}

/** The result of an apply, as lines. */
export function formatReleased(released: IdentityKeyReleased): string[] {
  return [
    `APPLIED: identity_resets ${released.resetId}`,
    `  released ${released.releasedKeySha256 === null ? 'no pin' : `the pin sha256:${released.releasedKeySha256.toString('hex').slice(0, FINGERPRINT_HEX_LENGTH)}`}` +
      ` · ${released.listVersionsDeleted} list version(s) · ${released.requestsDeleted} request(s)` +
      ` · ${released.holderProofsCleared} holder proof(s) cleared`,
    `  revoked ${released.revokedDeviceIds.length === 0 ? 'none' : released.revokedDeviceIds.join(', ')}` +
      ` · ${released.keyPackagesDeleted} key package(s) deleted` +
      ` · superseded ${released.supersededResetId ?? 'none'}`,
  ];
}

/** Where the CLI writes, and what it opens: injected so a test runs it against the test database. */
export interface IdentityResetCliDeps {
  /** Opened only after the command line is accepted. */
  readonly openDatabase: () => Database;
  readonly out: (line: string) => void;
  /** Where the database is, without credentials (`describeDatabaseUrl`). */
  readonly target: string;
  readonly now?: () => number;
}

/** `masia_relay @ 127.0.0.1:5432`: a database URL without its user or password. */
export function describeDatabaseUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname.replace(/^\//, '') || '(default)'} @ ${parsed.hostname}:${parsed.port || '5432'}`;
  } catch {
    return '(unparsable database URL)';
  }
}

/** Exit codes: 0 done, 1 refused by the database's state, 2 refused by the command line. */
export const IdentityResetExit = { OK: 0, REFUSED: 1, USAGE: 2 } as const;

async function inspectReadOnly(
  db: Database,
  userId: string,
  now: number,
): Promise<IdentityResetInspection> {
  return db.transaction(async (tx) => {
    // The dry run's guarantee is the database's, not this code's: a READ ONLY transaction refuses
    // every write.
    await tx.query('SET TRANSACTION READ ONLY');
    return inspectIdentityReset(tx, userId, now);
  });
}

/** The CLI: parse, inspect (READ ONLY), print the plan, and only with `--apply` release the key. */
export async function runIdentityResetCli(
  argv: readonly string[],
  deps: IdentityResetCliDeps,
): Promise<number> {
  const { out } = deps;
  let args: IdentityResetArgs;
  try {
    args = parseIdentityResetArgs(argv);
  } catch (error) {
    if (!(error instanceof IdentityResetUsageError)) throw error;
    out(`identity-reset: ${error.message}`);
    out(IDENTITY_RESET_USAGE);
    return IdentityResetExit.USAGE;
  }
  if (args.help) {
    out(IDENTITY_RESET_USAGE);
    return IdentityResetExit.OK;
  }

  const db = deps.openDatabase();
  const now = deps.now ?? Date.now;
  try {
    out(
      `Identity-key reset (ADR-218 §6) · ${args.apply ? 'APPLY' : 'DRY RUN: nothing is changed'}`,
    );
    out(`database  ${deps.target}`);
    const inspection = await inspectReadOnly(db, args.userId, now());
    for (const line of formatInspection(inspection)) out(line);
    out('');
    const plan = planIdentityReset(inspection, args);
    for (const line of formatPlan(inspection, plan, args)) out(line);
    if (plan.problems.length > 0) return IdentityResetExit.REFUSED;
    if (!args.apply || plan.firstDevice === null) {
      if (plan.firstDevice !== null) {
        out('');
        out(`To apply: the same command with --apply --confirm ${args.userId}`);
      }
      return IdentityResetExit.OK;
    }

    const firstDeviceId = plan.firstDevice.device.id;
    const released = await db.transaction((tx) =>
      releaseIdentityKey(tx, {
        userId: args.userId,
        actor: IdentityResetActor.OPERATOR,
        actorDeviceId: null,
        reason: args.reason,
        firstDeviceId,
        revokeDeviceIds: plan.revoke.map((view) => view.device.id),
      }),
    );
    out('');
    for (const line of formatReleased(released)) out(line);
    return IdentityResetExit.OK;
  } catch (error) {
    if (error instanceof IdentityResetRefusal || error instanceof RelayError) {
      out(`REFUSED: ${error.message} Nothing was changed.`);
      return IdentityResetExit.REFUSED;
    }
    throw error;
  } finally {
    await db.close();
  }
}
