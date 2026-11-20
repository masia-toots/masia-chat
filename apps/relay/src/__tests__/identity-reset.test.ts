import { createHash } from 'node:crypto';
import {
  IDENTITY_RESET_TICKET_TTL_MS,
  IdentityRequestPurpose,
  IdentityRequestState,
  RelayError,
  RelayErrorCode,
} from '@masia/relay';
import { buildKeyPackage } from '@masia/relay/testing';
import type { QueryResultRow } from 'pg';
import { describe, expect, it } from 'vitest';
import type { Database, Queryable } from '../db.js';
import {
  IDENTITY_RESET_REASON_MAX_LENGTH,
  IdentityResetActor,
  releaseIdentityKey,
} from '../domain/devices.js';
import {
  DEVICE_PREFIX_MIN_LENGTH,
  describeDatabaseUrl,
  IdentityResetExit,
  IdentityResetUsageError,
  keyFingerprint,
  parseIdentityResetArgs,
  runIdentityResetCli,
} from '../operator/identity-reset.js';
import {
  type Caller,
  countRows,
  databaseSuite,
  expectStatus,
  holderProofOf,
  identityKeyPairOf,
  identityRequestDraft,
  keysOf,
  rebindSignatureOf,
  sealed,
} from './support/harness.js';

/**
 * ADR-218 §6 (К5a): the relay operator's identity-key reset. The CLI is a dry run unless `--apply`;
 * `--apply` releases the key in one transaction, keeps the surviving devices (id, signature key, key
 * packages, leaves), revokes what `--revoke` names past STILL_IN_ROOMS, and writes the audit row that
 * is also the ticket: only the first device may pin the next key, and the other devices rebind to it.
 */

const ROOM = 'room-1';
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** The key alice had before the reset (every row carries it), and the ones she makes after. */
const OLD_KEY = keysOf('any', 'alice').identityKeyPub;
const NEW_KEY = identityKeyPairOf('alice:after-reset').publicKey.toString('base64');
const NEWER_KEY = identityKeyPairOf('alice:after-second-reset').publicKey.toString('base64');

function sha256(base64: string): Buffer {
  return createHash('sha256').update(Buffer.from(base64, 'base64')).digest();
}

describe('the identity-reset command line', () => {
  it('is a dry run by default and reads both flag spellings', () => {
    expect(parseIdentityResetArgs(['alice'])).toMatchObject({
      userId: 'alice',
      apply: false,
      firstDevice: null,
      revoke: [],
      reason: null,
    });
    expect(
      parseIdentityResetArgs([
        'alice',
        '--apply',
        '--confirm=alice',
        '--first-device',
        'alice-phone',
        '--revoke',
        'alice-lost, alice-old',
        '--revoke=alice-zombie',
        '--reason',
        'identity key lost 2026-11-06',
      ]),
    ).toMatchObject({
      userId: 'alice',
      apply: true,
      confirm: 'alice',
      firstDevice: 'alice-phone',
      revoke: ['alice-lost', 'alice-old', 'alice-zombie'],
      reason: 'identity key lost 2026-11-06',
    });
  });

  it('refuses --apply without --confirm (the same id) or without --first-device, and the rest it can tell alone', () => {
    const refused: string[][] = [
      ['alice', '--apply', '--first-device', 'alice-phone'],
      ['alice', '--apply', '--confirm', 'bob', '--first-device', 'alice-phone'],
      ['alice', '--apply', '--confirm', 'alice'],
      ['alice', '--confirm', 'alice', '--first-device', 'alice-phone'],
      ['alice', '--revoke', 'alice-lost'],
      ['alice', '--reason', 'x'.repeat(IDENTITY_RESET_REASON_MAX_LENGTH + 1)],
      ['alice', '--reason', ''],
      ['alice', '--first-device', 'a', '--first-device', 'b'],
      ['alice', '--first-device'],
      ['alice', '--first-device', '--apply'],
      ['alice', '--force'],
      ['alice', 'bob'],
      [],
      ['not an id'],
    ];
    for (const argv of refused) {
      expect(() => parseIdentityResetArgs(argv), JSON.stringify(argv)).toThrow(
        IdentityResetUsageError,
      );
    }
    expect(
      parseIdentityResetArgs(['alice', '--reason', 'x'.repeat(IDENTITY_RESET_REASON_MAX_LENGTH)])
        .reason,
    ).toHaveLength(IDENTITY_RESET_REASON_MAX_LENGTH);
  });

  it('answers a refused command line with exit 2 and never opens the database', async () => {
    const out: string[] = [];
    const code = await runIdentityResetCli(['alice', '--apply', '--first-device', 'alice-phone'], {
      openDatabase: () => {
        throw new Error('the database must not be opened');
      },
      out: (line) => out.push(line),
      target: 'none',
    });
    expect(code).toBe(IdentityResetExit.USAGE);
    expect(out.join('\n')).toMatch(/--confirm/);
  });

  it('names the database without its credentials', () => {
    const shown = describeDatabaseUrl(
      'postgresql://masia_relay:hunter2@db.example:6543/masia_relay',
    );
    expect(shown).toBe('masia_relay @ db.example:6543');
    expect(shown).not.toMatch(/hunter2|masia_relay:/);
  });
});

databaseSuite('the operator identity-key reset (ADR-218 §6)', (harness) => {
  /** The relay's tables a reset may touch: count and a digest of every row, to prove "nothing changed". */
  const WATCHED_TABLES = [
    'identity_keys',
    'device_lists',
    'device_list_versions',
    'devices',
    'identity_requests',
    'identity_resets',
    'key_packages',
    'room_members',
    'envelopes',
  ] as const;

  async function snapshot(): Promise<Record<string, string>> {
    const digests: Record<string, string> = {};
    for (const table of WATCHED_TABLES) {
      const { rows } = await harness().db.query<{ digest: string }>(
        `SELECT count(*) || ':' || md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS digest
         FROM ${table} t`,
      );
      digests[table] = rows[0]?.digest ?? '';
    }
    return digests;
  }

  interface CliRun {
    readonly code: number;
    readonly output: string;
    /** Every statement the CLI sent, one list per transaction. */
    readonly transactions: string[][];
  }

  /** Runs the CLI against the test database; its `close` leaves the harness's pool open. */
  async function cli(...argv: string[]): Promise<CliRun> {
    const db = harness().db;
    const out: string[] = [];
    const transactions: string[][] = [];
    const recorded: Database = {
      query<Row extends QueryResultRow>(sql: string, params?: readonly unknown[]) {
        return db.query<Row>(sql, params);
      },
      transaction(work) {
        return db.transaction((tx) => {
          const statements: string[] = [];
          transactions.push(statements);
          const recording: Queryable = {
            query<Row extends QueryResultRow>(sql: string, params?: readonly unknown[]) {
              statements.push(sql.trim());
              return tx.query<Row>(sql, params);
            },
          };
          return work(recording);
        });
      },
      close: async () => undefined,
    };
    const code = await runIdentityResetCli(argv, {
      openDatabase: () => recorded,
      out: (line) => out.push(line),
      target: 'masia_relay_test @ test',
      now: harness().clock.now,
    });
    return { code, output: out.join('\n'), transactions };
  }

  function register(
    device: Caller,
    identityKeyPub: string,
    signatureKeyPub: string = keysOf(device.deviceId).signatureKeyPub,
    rebindSignature?: string,
  ) {
    return device.post('/devices', {
      id: device.deviceId,
      name: device.deviceId,
      identityKeyPub,
      signatureKeyPub,
      ...(rebindSignature === undefined ? {} : { rebindSignature }),
    });
  }

  /**
   * The device a ticket names pins `identityKeyPub` as the hub does: the unsigned register is asked
   * for proof (409 IDENTITY_REBIND_PROOF_REQUIRED, naming the reset), then it signs and sends again.
   */
  async function rebind(device: Caller, identityKeyPub: string) {
    const asked = await register(device, identityKeyPub);
    expectStatus(asked, 409);
    const { error, resetId } = asked.json() as { error: string; resetId: string };
    expect(error).toBe(RelayErrorCode.IDENTITY_REBIND_PROOF_REQUIRED);
    const signature = rebindSignatureOf(device.userId, device.deviceId, identityKeyPub, resetId);
    return register(device, identityKeyPub, undefined, signature);
  }

  function send(from: Caller, text: string) {
    return from.post(`/conversations/${ROOM}/envelopes`, {
      epoch: 1,
      senderDeviceId: from.deviceId,
      ciphertext: sealed(ROOM, 1, text),
    });
  }

  async function pinOf(userId: string): Promise<string | null> {
    const { rows } = await harness().db.query<{ key: Buffer }>(
      'SELECT identity_key_pub AS key FROM identity_keys WHERE user_id = $1',
      [userId],
    );
    return rows[0]?.key.toString('base64') ?? null;
  }

  async function rowKeyOf(deviceId: string): Promise<string | undefined> {
    const { rows } = await harness().db.query<{ key: Buffer }>(
      'SELECT identity_key_pub AS key FROM devices WHERE id = $1',
      [deviceId],
    );
    return rows[0]?.key.toString('base64');
  }

  interface ResetRow {
    actor: string;
    actorDeviceId: string | null;
    reason: string | null;
    firstDeviceId: string | null;
    revokedDeviceIds: string[];
    releasedKeySha256: Buffer | null;
    listVersionsDeleted: number;
    requestsDeleted: number;
    holderProofsCleared: number;
    keyPackagesDeleted: number;
    pinnedAt: Date | null;
    supersededAt: Date | null;
  }

  async function resets(userId: string): Promise<ResetRow[]> {
    const { rows } = await harness().db.query<ResetRow>(
      `SELECT actor, actor_device_id AS "actorDeviceId", reason, first_device_id AS "firstDeviceId",
         revoked_device_ids AS "revokedDeviceIds", released_key_sha256 AS "releasedKeySha256",
         list_versions_deleted AS "listVersionsDeleted", requests_deleted AS "requestsDeleted",
         holder_proofs_cleared AS "holderProofsCleared", key_packages_deleted AS "keyPackagesDeleted",
         pinned_at AS "pinnedAt", superseded_at AS "supersededAt"
       FROM identity_resets WHERE user_id = $1 ORDER BY created_at, id`,
      [userId],
    );
    return rows;
  }

  /**
   * Alice as Г3 found her: a phone that holds the key, a laptop and a lost device, all three in a room
   * with Bob, an unlisted tablet asking to be paired, and two unused key packages on the lost device.
   */
  async function aliceInARoom() {
    const h = harness();
    const phone = await h.enrol('alice', 'alice-phone');
    expectStatus(
      await phone.put('/devices/me/holder-proof', {
        holderProof: holderProofOf('alice', 'alice-phone'),
      }),
      200,
    );
    const laptop = await h.enrol('alice', 'alice-laptop');
    const lost = await h.enrol('alice', 'alice-lost');
    const bob = await h.enrol('bob', 'bob-phone');
    await h.createRoom(ROOM, phone);
    expectStatus(await h.addToRoom(ROOM, phone, laptop, lost, bob), 201);
    expectStatus(await send(bob, 'sealed-before-the-reset'), 201);

    const notAfter = new Date(h.clock.now() + 30 * MS_PER_DAY);
    for (const seed of ['lost-1', 'lost-2']) {
      await h.db.query(
        'INSERT INTO key_packages (device_id, bytes, last_resort, not_after) VALUES ($1, $2, false, $3)',
        ['alice-lost', buildKeyPackage({ nowSeconds: h.clock.seconds(), seed }), notAfter],
      );
    }
    const tablet = await h.registerUnlisted('alice', 'alice-tablet');
    const draft = await identityRequestDraft(tablet, IdentityRequestPurpose.PAIR);
    expectStatus(await tablet.post('/users/me/identity-requests', draft.body), 201);
    return { phone, laptop, lost, bob, tablet };
  }

  describe('the dry run', () => {
    it('reports the account and what --apply would do, in a READ ONLY transaction, and changes nothing', async () => {
      await aliceInARoom();
      const before = await snapshot();

      const run = await cli(
        'alice',
        '--first-device',
        'alice-phone',
        '--revoke',
        'alice-lost',
        '--reason',
        'lost on a train',
      );

      expect(run.code, run.output).toBe(IdentityResetExit.OK);
      expect(await snapshot()).toEqual(before);
      expect(run.transactions).toHaveLength(1);
      expect(run.transactions[0]?.[0]).toBe('SET TRANSACTION READ ONLY');
      for (const statement of run.transactions[0]?.slice(1) ?? []) {
        expect(statement).toMatch(/^SELECT\b/);
      }

      expect(run.output).toContain('DRY RUN: nothing is changed');
      expect(run.output).toContain(keyFingerprint(Buffer.from(OLD_KEY, 'base64')));
      expect(run.output).toMatch(/list {6}version 3 · 3 stored version\(s\)/);
      expect(run.output).toMatch(
        /alice-phone {2}USER {2}active[\s\S]*?holder yes · follows pin yes · rooms 1/,
      );
      expect(run.output).toMatch(/alice-lost {2}USER[\s\S]*?rooms 1 · key packages [1-9]/);
      expect(run.output).toMatch(/alice-tablet {2}USER[\s\S]*?listed no · holder no/);
      expect(run.output).toContain(`${IdentityRequestPurpose.PAIR}  ${IdentityRequestState.OPEN}`);
      expect(run.output).toMatch(/revoke alice-lost past STILL_IN_ROOMS/);
      expect(run.output).toMatch(/only alice-phone may pin the next key/i);
      expect(run.output).toMatch(/rebound to the new pin[^\n]*alice-laptop/);
      expect(run.output).toContain('To apply: the same command with --apply --confirm alice');
    });

    it('without --first-device lists who could be the first device, and still changes nothing', async () => {
      await aliceInARoom();
      const before = await snapshot();
      const run = await cli('alice');
      expect(run.code).toBe(IdentityResetExit.OK);
      expect(run.output).toMatch(/one of these unrevoked USER devices/);
      expect(await snapshot()).toEqual(before);
    });
  });

  describe('--apply refusals: nothing is changed', () => {
    it('refuses a device that is not an unrevoked USER device of THIS account, an ambiguous or short prefix', async () => {
      const { phone } = await aliceInARoom();
      await harness().enrol('alice', 'alice-phablet');
      expectStatus(await phone.post('/devices/alice-tablet/revoke'), 200);
      const before = await snapshot();

      const apply = (...rest: string[]) => cli('alice', '--apply', '--confirm', 'alice', ...rest);
      const cases: Array<[string[], RegExp]> = [
        [['--first-device', 'bob-phone'], /no device of this account/],
        [['--first-device', 'alice-tablet'], /alice-tablet is revoked/],
        [['--first-device', 'alice-ph'], /names 2 devices/],
        [
          ['--first-device', 'alice-phone'.slice(0, DEVICE_PREFIX_MIN_LENGTH - 1)],
          new RegExp(`needs ${DEVICE_PREFIX_MIN_LENGTH}\\+ characters`),
        ],
        [
          ['--first-device', 'alice-phone', '--revoke', 'alice-phone', '--reason', 'r'],
          /is the first device/,
        ],
        [
          ['--first-device', 'alice-phone', '--revoke', 'bob-phone', '--reason', 'r'],
          /no device of this account/,
        ],
        [
          ['--first-device', 'alice-phone', '--revoke', 'alice-tablet', '--reason', 'r'],
          /already revoked/,
        ],
      ];
      for (const [rest, why] of cases) {
        const run = await apply(...rest);
        expect(run.code, run.output).toBe(IdentityResetExit.REFUSED);
        expect(run.output).toMatch(why);
        expect(run.transactions, 'only the READ ONLY inspection ran').toHaveLength(1);
      }
      expect(await snapshot()).toEqual(before);
    });

    it('refuses --apply without --confirm or --first-device before it opens the database', async () => {
      await aliceInARoom();
      const before = await snapshot();
      for (const argv of [
        ['alice', '--apply', '--first-device', 'alice-phone'],
        ['alice', '--apply', '--confirm', 'alice'],
        ['alice', '--apply', '--confirm', 'bob', '--first-device', 'alice-phone'],
      ]) {
        const run = await cli(...argv);
        expect(run.code).toBe(IdentityResetExit.USAGE);
        expect(run.transactions).toEqual([]);
      }
      expect(await snapshot()).toEqual(before);
    });

    it('the shared release refuses a first device or a revoke of another account (422) and rolls back', async () => {
      await aliceInARoom();
      const before = await snapshot();
      for (const release of [
        { firstDeviceId: 'bob-phone', revokeDeviceIds: [] },
        { firstDeviceId: 'alice-phone', revokeDeviceIds: ['bob-phone'] },
        { firstDeviceId: 'alice-phone', revokeDeviceIds: ['no-such-device'] },
      ]) {
        const attempt = harness().db.transaction((tx) =>
          releaseIdentityKey(tx, {
            userId: 'alice',
            actor: IdentityResetActor.OPERATOR,
            actorDeviceId: null,
            reason: 'test',
            ...release,
          }),
        );
        await expect(attempt).rejects.toBeInstanceOf(RelayError);
        await expect(attempt).rejects.toMatchObject({ code: RelayErrorCode.VALIDATION_FAILED });
      }
      expect(await snapshot()).toEqual(before);
    });
  });

  describe('--apply', () => {
    it('releases the key, revokes --revoke past its rooms with the reason, and keeps the survivors whole', async () => {
      const { phone, laptop, lost } = await aliceInARoom();
      // Without the operator, the lost device cannot be revoked: it is still in a room.
      const blocked = await phone.post('/devices/alice-lost/revoke');
      expectStatus(blocked, 409);
      expect(blocked.json()).toMatchObject({ error: RelayErrorCode.STILL_IN_ROOMS });

      const db = harness().db;
      const lostPackages = await countRows(
        "SELECT count(*) AS n FROM key_packages WHERE device_id = 'alice-lost' AND consumed_at IS NULL",
        db,
      );
      expect(lostPackages).toBeGreaterThanOrEqual(2);
      const kept = async () => ({
        members: (
          await db.query(
            `SELECT conversation_id, device_id, added_at_epoch, removed_at_epoch FROM room_members
             WHERE device_id IN ('alice-phone', 'alice-laptop') ORDER BY device_id`,
          )
        ).rows,
        envelopes: await countRows('SELECT count(*) AS n FROM envelopes', db),
        packages: await countRows(
          "SELECT count(*) AS n FROM key_packages WHERE device_id IN ('alice-phone', 'alice-laptop')",
          db,
        ),
        devices: (
          await db.query(
            `SELECT id, role, signature_key_pub, identity_key_pub, revoked_at FROM devices
             WHERE id IN ('alice-phone', 'alice-laptop') ORDER BY id`,
          )
        ).rows,
      });
      const survivorsBefore = await kept();

      const run = await cli(
        'alice',
        '--apply',
        '--confirm',
        'alice',
        '--first-device',
        'alice-phone'.slice(0, DEVICE_PREFIX_MIN_LENGTH), // a unique prefix is enough
        '--revoke',
        'alice-lost',
        '--reason',
        'lost on a train',
      );
      expect(run.code, run.output).toBe(IdentityResetExit.OK);
      expect(run.output).toMatch(/APPLIED: identity_resets [0-9a-f-]{36}/);
      expect(run.transactions).toHaveLength(2);
      expect(run.transactions[0]?.[0]).toBe('SET TRANSACTION READ ONLY');

      // The pin, the chain, the open request and every holder proof are gone.
      expect(await pinOf('alice')).toBeNull();
      expect(
        await countRows("SELECT count(*) AS n FROM device_lists WHERE user_id = 'alice'", db),
      ).toBe(0);
      expect(
        await countRows(
          "SELECT count(*) AS n FROM device_list_versions WHERE user_id = 'alice'",
          db,
        ),
      ).toBe(0);
      expect(
        await countRows("SELECT count(*) AS n FROM identity_requests WHERE user_id = 'alice'", db),
      ).toBe(0);
      expect(
        await countRows(
          "SELECT count(*) AS n FROM devices WHERE user_id = 'alice' AND holder_proof IS NOT NULL",
          db,
        ),
      ).toBe(0);

      // The lost device is revoked past its room, and nobody can claim its packages any more.
      expect(
        await countRows(
          "SELECT count(*) AS n FROM devices WHERE id = 'alice-lost' AND revoked_at IS NOT NULL",
          db,
        ),
      ).toBe(1);
      expect(
        await countRows(
          "SELECT count(*) AS n FROM key_packages WHERE device_id = 'alice-lost' AND consumed_at IS NULL",
          db,
        ),
      ).toBe(0);
      expectStatus(await send(lost, 'from-a-revoked-device'), 403);

      // The survivors keep their id, keys, packages, leaves and the room's history.
      expect(await kept()).toEqual(survivorsBefore);
      expectStatus(await send(laptop, 'sealed-after-the-reset'), 201);
      // Bob's account is untouched.
      expect(await pinOf('bob')).not.toBeNull();

      // The audit row, which is also the ticket.
      const [row] = await resets('alice');
      expect(row).toMatchObject({
        actor: IdentityResetActor.OPERATOR,
        actorDeviceId: null,
        reason: 'lost on a train',
        firstDeviceId: 'alice-phone',
        revokedDeviceIds: ['alice-lost'],
        listVersionsDeleted: 3,
        requestsDeleted: 1,
        holderProofsCleared: 1,
        keyPackagesDeleted: lostPackages,
        pinnedAt: null,
        supersededAt: null,
      });
      expect(row?.releasedKeySha256).toEqual(sha256(OLD_KEY));
    });
  });

  describe('the ticket and the rebind (registerDevice)', () => {
    async function resetWithPhoneFirst() {
      const devices = await aliceInARoom();
      const run = await cli(
        'alice',
        '--apply',
        '--confirm',
        'alice',
        '--first-device',
        'alice-phone',
      );
      expect(run.code, run.output).toBe(IdentityResetExit.OK);
      return devices;
    }

    it('lets only the first device pin the next key: any other device, new or registered, gets 409 IDENTITY_RESET_PENDING', async () => {
      const { phone, laptop } = await resetWithPhoneFirst();
      const fresh = await harness().caller({ userId: 'alice', deviceId: 'alice-new' });

      const newDevice = await register(fresh, NEW_KEY);
      expectStatus(newDevice, 409);
      expect(newDevice.json()).toMatchObject({ error: RelayErrorCode.IDENTITY_RESET_PENDING });
      expect(
        await countRows("SELECT count(*) AS n FROM devices WHERE id = 'alice-new'", harness().db),
      ).toBe(0);

      const survivor = await register(laptop, NEW_KEY);
      expectStatus(survivor, 409);
      expect(survivor.json()).toMatchObject({ error: RelayErrorCode.IDENTITY_RESET_PENDING });
      expect(await pinOf('alice')).toBeNull();

      // A plain refresh (the key the row already carries) is not a pin: it passes, and pins nothing.
      expectStatus(await register(laptop, OLD_KEY), 200);
      expectStatus(await register(phone, OLD_KEY), 200);
      expect(await pinOf('alice')).toBeNull();

      // The first device pins its new key, and that closes the ticket.
      expectStatus(await rebind(phone, NEW_KEY), 200);
      expect(await pinOf('alice')).toBe(NEW_KEY);
      expect(await rowKeyOf('alice-phone')).toBe(NEW_KEY);
      const [ticket] = await resets('alice');
      expect(ticket?.pinnedAt).not.toBeNull();

      // Now a new device joins under the pin, as before any reset.
      expectStatus(await register(fresh, NEW_KEY), 201);
    });

    it('rebinds a survivor to the pin with the same signature key; another signature key is DEVICE_IDENTITY_IMMUTABLE', async () => {
      const { phone, laptop } = await resetWithPhoneFirst();
      // Before the pin moves, the first device cannot change its MLS key either.
      const swapped = await register(phone, NEW_KEY, keysOf('someone-else').signatureKeyPub);
      expectStatus(swapped, 409);
      expect(swapped.json()).toMatchObject({ error: RelayErrorCode.DEVICE_IDENTITY_IMMUTABLE });
      expectStatus(await rebind(phone, NEW_KEY), 200);

      const otherSigKey = await register(laptop, NEW_KEY, keysOf('someone-else').signatureKeyPub);
      expectStatus(otherSigKey, 409);
      expect(otherSigKey.json()).toMatchObject({ error: RelayErrorCode.DEVICE_IDENTITY_IMMUTABLE });
      expect(await rowKeyOf('alice-laptop')).toBe(OLD_KEY);

      expectStatus(await register(laptop, NEW_KEY), 200);
      expect(await rowKeyOf('alice-laptop')).toBe(NEW_KEY);
      // Rebound once, it is an ordinary device again: its key is fixed.
      const again = await register(laptop, NEWER_KEY);
      expectStatus(again, 409);
      expect(again.json()).toMatchObject({ error: RelayErrorCode.DEVICE_IDENTITY_IMMUTABLE });
    });

    it('a survivor offering any key but the pin is told the pin (409 IDENTITY_KEY_CHANGED)', async () => {
      const { phone, laptop } = await resetWithPhoneFirst();
      expectStatus(await rebind(phone, NEW_KEY), 200);

      const wrong = await register(laptop, NEWER_KEY);
      expectStatus(wrong, 409);
      expect(wrong.json()).toMatchObject({
        error: RelayErrorCode.IDENTITY_KEY_CHANGED,
        identityKeyPub: NEW_KEY,
      });
      expect(await rowKeyOf('alice-laptop')).toBe(OLD_KEY);
    });

    it('never lets the ticketed device pin the key the reset released', async () => {
      const { phone, laptop } = await resetWithPhoneFirst();
      expectStatus(await rebind(phone, NEW_KEY), 200); // the phone pins NEW; the laptop still carries OLD

      const second = await cli(
        'alice',
        '--apply',
        '--confirm',
        'alice',
        '--first-device',
        'alice-laptop',
      );
      expect(second.code, second.output).toBe(IdentityResetExit.OK);

      const released = await register(laptop, NEW_KEY);
      expectStatus(released, 409);
      expect(released.json()).toMatchObject({ error: RelayErrorCode.DEVICE_IDENTITY_IMMUTABLE });
      expect(await pinOf('alice')).toBeNull();

      expectStatus(await rebind(laptop, NEWER_KEY), 200);
      expect(await pinOf('alice')).toBe(NEWER_KEY);
      // The phone rebinds to the newest pin.
      expectStatus(await register(phone, NEWER_KEY), 200);
      expect(await rowKeyOf('alice-phone')).toBe(NEWER_KEY);
    });

    it('a second operator reset supersedes the open ticket: then only ITS first device may pin', async () => {
      const { phone, laptop } = await resetWithPhoneFirst();
      const second = await cli(
        'alice',
        '--apply',
        '--confirm',
        'alice',
        '--first-device',
        'alice-laptop',
      );
      expect(second.code, second.output).toBe(IdentityResetExit.OK);
      expect(second.output).toMatch(/close the open ticket [0-9a-f-]{36} as superseded/);

      const rows = await resets('alice');
      const first = rows.find((row) => row.firstDeviceId === 'alice-phone');
      const latest = rows.find((row) => row.firstDeviceId === 'alice-laptop');
      expect(first?.supersededAt).not.toBeNull();
      expect(latest).toMatchObject({
        firstDeviceId: 'alice-laptop',
        supersededAt: null,
        pinnedAt: null,
      });

      const old = await register(phone, NEW_KEY);
      expectStatus(old, 409);
      expect(old.json()).toMatchObject({ error: RelayErrorCode.IDENTITY_RESET_PENDING });
      expectStatus(await rebind(laptop, NEW_KEY), 200);
    });

    it('pins only with the named device key signing the new key and this reset; anything else is 409 IDENTITY_REBIND_PROOF_REQUIRED naming the reset', async () => {
      const { phone, laptop } = await resetWithPhoneFirst();
      const [ticket] = await resets('alice');
      const { rows } = await harness().db.query<{ id: string }>(
        "SELECT id FROM identity_resets WHERE user_id = 'alice' AND superseded_at IS NULL",
      );
      const resetId = rows[0]?.id ?? '';
      expect(ticket?.firstDeviceId).toBe('alice-phone');

      const refusals = [
        // No signature: a stolen token alone names the device, it does not prove it.
        undefined,
        // Another device's key (the laptop's own) over the same statement.
        rebindSignatureOf('alice', 'alice-phone', NEW_KEY, resetId, 'alice-laptop'),
        // The phone's key, but over another key than the one offered.
        rebindSignatureOf('alice', 'alice-phone', NEWER_KEY, resetId),
        // The phone's key over an old reset's id.
        rebindSignatureOf('alice', 'alice-phone', NEW_KEY, '00000000-0000-4000-8000-000000000000'),
      ];
      for (const signature of refusals) {
        const refused = await register(phone, NEW_KEY, undefined, signature);
        expectStatus(refused, 409);
        expect(refused.json()).toMatchObject({
          error: RelayErrorCode.IDENTITY_REBIND_PROOF_REQUIRED,
          resetId,
        });
      }
      expect(await pinOf('alice')).toBeNull();
      expect((await resets('alice'))[0]?.pinnedAt).toBeNull();

      // A signature is no pass for another device: the laptop is not the ticket's.
      const notNamed = await register(
        laptop,
        NEW_KEY,
        undefined,
        rebindSignatureOf('alice', 'alice-laptop', NEW_KEY, resetId),
      );
      expectStatus(notNamed, 409);
      expect(notNamed.json()).toMatchObject({ error: RelayErrorCode.IDENTITY_RESET_PENDING });

      const signed = rebindSignatureOf('alice', 'alice-phone', NEW_KEY, resetId);
      expectStatus(await register(phone, NEW_KEY, undefined, signed), 200);
      expect(await pinOf('alice')).toBe(NEW_KEY);
    });

    it(`a ticket older than ${IDENTITY_RESET_TICKET_TTL_MS / MS_PER_DAY} day counts as superseded: nobody pins, the named device included, until the operator resets again`, async () => {
      const { phone } = await resetWithPhoneFirst();
      const { rows } = await harness().db.query<{ id: string }>(
        "SELECT id FROM identity_resets WHERE user_id = 'alice' AND superseded_at IS NULL",
      );
      const resetId = rows[0]?.id ?? '';
      // A day and a minute ago, by the database's own clock (it judges the age).
      await harness().db.query(
        `UPDATE identity_resets SET created_at = now() - make_interval(secs => $1::double precision / 1000)
         WHERE id = $2`,
        [IDENTITY_RESET_TICKET_TTL_MS + 60_000, resetId],
      );

      const late = await register(
        phone,
        NEW_KEY,
        undefined,
        rebindSignatureOf('alice', 'alice-phone', NEW_KEY, resetId),
      );
      expectStatus(late, 409);
      expect(late.json()).toMatchObject({ error: RelayErrorCode.IDENTITY_RESET_PENDING });
      // An expired ticket never reopens first-come pinning for a new device either.
      const fresh = await harness().caller({ userId: 'alice', deviceId: 'alice-new' });
      const newcomer = await register(fresh, NEW_KEY);
      expectStatus(newcomer, 409);
      expect(newcomer.json()).toMatchObject({ error: RelayErrorCode.IDENTITY_RESET_PENDING });
      expect(await pinOf('alice')).toBeNull();

      // The dry run says so, and a new reset (with the device in hand) lets the phone pin.
      const dry = await cli('alice');
      expect(dry.code, dry.output).toBe(IdentityResetExit.OK);
      expect(dry.output).toMatch(/EXPIRED/);
      const again = await cli(
        'alice',
        '--apply',
        '--confirm',
        'alice',
        '--first-device',
        'alice-phone',
      );
      expect(again.code, again.output).toBe(IdentityResetExit.OK);
      expectStatus(await rebind(phone, NEW_KEY), 200);
      expect(await pinOf('alice')).toBe(NEW_KEY);
    });
  });

  describe('the family-admin reset shares the release', () => {
    it('writes its audit row with the admin device, and supersedes an open operator ticket', async () => {
      await harness().enrol('alice', 'alice-phone');
      const run = await cli(
        'alice',
        '--apply',
        '--confirm',
        'alice',
        '--first-device',
        'alice-phone',
      );
      expect(run.code, run.output).toBe(IdentityResetExit.OK);

      await harness().enrol('mum', 'mum-phone');
      const mum = await harness().caller(
        { userId: 'mum', deviceId: 'mum-phone' },
        { adminOf: ['alice'] },
      );
      expectStatus(await mum.post('/devices/alice-phone/revoke'), 200);
      expect((await mum.del('/users/alice/identity-key')).status).toBe(204);

      const rows = await resets('alice');
      const operator = rows.find((row) => row.actor === IdentityResetActor.OPERATOR);
      const admin = rows.find((row) => row.actor === IdentityResetActor.FAMILY_ADMIN);
      expect(operator?.supersededAt).not.toBeNull();
      expect(admin).toMatchObject({
        actor: IdentityResetActor.FAMILY_ADMIN,
        actorDeviceId: 'mum-phone',
        firstDeviceId: null,
        reason: null,
        revokedDeviceIds: [],
        // The operator reset had already released the pin.
        releasedKeySha256: null,
      });

      // No ticket is open any more: a new device starts the account again.
      const fresh = await harness().caller({ userId: 'alice', deviceId: 'alice-new' });
      expectStatus(await register(fresh, NEW_KEY), 201);
    });
  });

  describe('the table keeps its rules', () => {
    async function insertReset(values: {
      actor?: string;
      firstDeviceId?: string | null;
      reason?: string | null;
      revoked?: string[];
    }) {
      return harness().db.query(
        `INSERT INTO identity_resets (user_id, actor, first_device_id, reason, revoked_device_ids,
           list_versions_deleted, requests_deleted, holder_proofs_cleared, key_packages_deleted)
         VALUES ('alice', $1, $2, $3, $4::text[], 0, 0, 0, 0)`,
        [
          values.actor ?? IdentityResetActor.OPERATOR,
          values.firstDeviceId === undefined ? 'alice-phone' : values.firstDeviceId,
          values.reason ?? null,
          values.revoked ?? [],
        ],
      );
    }

    it('holds at most one open ticket per account', async () => {
      await harness().enrol('alice', 'alice-phone');
      await insertReset({});
      await expect(insertReset({})).rejects.toMatchObject({ code: '23505' });
      // A closed one does not count.
      await harness().db.query(
        "UPDATE identity_resets SET pinned_at = now() WHERE user_id = 'alice'",
      );
      await insertReset({});
    });

    it('bounds the reason exactly as the code does, and requires it for a revoke', async () => {
      await harness().enrol('alice', 'alice-phone');
      const admin = { actor: IdentityResetActor.FAMILY_ADMIN, firstDeviceId: null };
      await insertReset({ ...admin, reason: 'x'.repeat(IDENTITY_RESET_REASON_MAX_LENGTH) });
      await expect(
        insertReset({ ...admin, reason: 'x'.repeat(IDENTITY_RESET_REASON_MAX_LENGTH + 1) }),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(insertReset({ ...admin, reason: '' })).rejects.toMatchObject({ code: '23514' });
      await expect(insertReset({ ...admin, revoked: ['alice-phone'] })).rejects.toMatchObject({
        code: '23514',
      });
      // The operator always names a first device, the family admin never.
      await expect(insertReset({ firstDeviceId: null })).rejects.toMatchObject({ code: '23514' });
      await expect(insertReset({ ...admin, firstDeviceId: 'alice-phone' })).rejects.toMatchObject({
        code: '23514',
      });
    });
  });
});
