import { RelayErrorCode } from '@masia/relay';
import { buildWelcome } from '@masia/relay/testing';
import { describe, expect, it } from 'vitest';
import {
  type Caller,
  type Harness,
  commitBody,
  databaseSuite,
  expectStatus,
  keyPackageItem,
  UNCLAIMED_KEY_PACKAGE_ID,
  unclaimed,
} from './support/harness.js';

const ROOM = 'room-1';

interface DeclaredAdd {
  deviceId: string;
  userId: string;
  role: string;
  keyPackageId: string;
}

interface HandshakeRow {
  seq: number;
  epoch: number;
  kind: string;
  senderDeviceId: string;
  memberDelta: { added: DeclaredAdd[]; removed: string[] } | null;
}

/** What `by` is handed when it claims the key packages of `of`'s user: the package of `of`'s device. */
async function claimedPackage(harness: Harness, by: Caller, of: Caller): Promise<string> {
  // Introduced (`Harness.introduce`): this suite tests the Add rule, not the contact gate.
  const claimer = await harness.introduce(by, of.userId);
  const reply = await claimer.post('/key-packages/claim', { userId: of.userId });
  expectStatus(reply, 200);
  const row = reply
    .json<{ rows: Array<{ deviceId: string; keyPackageId: string }> }>()
    .rows.find((item) => item.deviceId === of.deviceId);
  if (row === undefined) throw new Error(`no key package was handed out for ${of.deviceId}`);
  return row.keyPackageId;
}

async function handshakeLog(from: Caller): Promise<HandshakeRow[]> {
  const reply = await from.get(`/conversations/${ROOM}/handshakes`);
  expectStatus(reply, 200);
  return reply.json<{ rows: HandshakeRow[] }>().rows;
}

function commitAdding(
  from: Caller,
  epoch: number,
  ...added: Array<{ member: Caller; keyPackageId: string }>
) {
  return from.post(
    `/conversations/${ROOM}/handshakes`,
    commitBody({ room: ROOM, expectedEpoch: epoch, sender: from, added }),
  );
}

databaseSuite(
  'the declared member delta (security review 2026-10-10 §4, "Lying memberDelta")',
  (harness) => {
    async function roomWithAlice(): Promise<Caller> {
      const alice = await harness().enrol('alice', 'alice-phone');
      await harness().createRoom(ROOM, alice);
      return alice;
    }

    describe('is stored with the handshake and served back, so every member can check it against the commit', () => {
      it('serves the delta exactly as declared on the COMMIT row, and null on the WELCOME row beside it', async () => {
        const alice = await roomWithAlice();
        const bob = await harness().enrol('bob', 'bob-phone');
        const added = await harness().claimFor(alice, bob);

        const reply = await alice.post(`/conversations/${ROOM}/handshakes`, {
          ...commitBody({ room: ROOM, expectedEpoch: 0, sender: alice, added }),
          welcome: buildWelcome().toString('base64'),
        });
        expectStatus(reply, 201);

        const rows = await handshakeLog(bob);
        expect(rows.map((row) => [row.seq, row.kind])).toEqual([
          [1, 'COMMIT'],
          [2, 'WELCOME'],
        ]);
        expect(rows[0]?.memberDelta).toEqual({
          added: [
            {
              deviceId: 'bob-phone',
              userId: 'bob',
              role: 'USER',
              keyPackageId: added[0]?.keyPackageId,
            },
          ],
          removed: [],
        });
        expect(rows[1]?.memberDelta).toBeNull();
      });

      it('serves the removals of a later commit, and an add and a remove together', async () => {
        const alice = await roomWithAlice();
        const bob = await harness().enrol('bob', 'bob-phone');
        const carol = await harness().enrol('carol', 'carol-phone');
        expectStatus(await harness().addToRoom(ROOM, alice, bob), 201);

        const swap = await alice.post(
          `/conversations/${ROOM}/handshakes`,
          commitBody({
            room: ROOM,
            expectedEpoch: 1,
            sender: alice,
            added: await harness().claimFor(alice, carol),
            removed: [bob],
          }),
        );
        expectStatus(swap, 201);

        const second = (await handshakeLog(alice))[1];
        expect(second?.kind).toBe('COMMIT');
        expect(second?.memberDelta?.removed).toEqual(['bob-phone']);
        expect(second?.memberDelta?.added.map((item) => item.deviceId)).toEqual(['carol-phone']);
      });

      it('keeps it in the database next to the opaque bytes (member_delta_json), and nothing for a Welcome', async () => {
        const alice = await roomWithAlice();
        const bob = await harness().enrol('bob', 'bob-phone');
        const added = await harness().claimFor(alice, bob);
        expectStatus(
          await alice.post(`/conversations/${ROOM}/handshakes`, {
            ...commitBody({ room: ROOM, expectedEpoch: 0, sender: alice, added }),
            welcome: buildWelcome().toString('base64'),
          }),
          201,
        );

        const { rows } = await harness().db.query<{ kind: string; delta: unknown }>(
          'SELECT kind::text AS kind, member_delta_json AS delta FROM mls_handshakes ORDER BY seq',
        );
        expect(rows).toEqual([
          {
            kind: 'COMMIT',
            delta: {
              added: [
                {
                  deviceId: 'bob-phone',
                  userId: 'bob',
                  role: 'USER',
                  keyPackageId: added[0]?.keyPackageId,
                },
              ],
              removed: [],
            },
          },
          { kind: 'WELCOME', delta: null },
        ]);
      });

      it.each([
        ['no keyPackageId', { deviceId: 'bob-phone', userId: 'bob', role: 'USER' }],
        [
          'a keyPackageId that is not a uuid',
          { deviceId: 'bob-phone', userId: 'bob', role: 'USER', keyPackageId: 'not-a-uuid' },
        ],
        [
          'a field the relay does not know',
          {
            deviceId: 'bob-phone',
            userId: 'bob',
            role: 'USER',
            keyPackageId: UNCLAIMED_KEY_PACKAGE_ID,
            extra: 1,
          },
        ],
      ])('refuses an Add with %s (400)', async (_label, add) => {
        const alice = await roomWithAlice();
        await harness().enrol('bob', 'bob-phone');
        const reply = await alice.post(`/conversations/${ROOM}/handshakes`, {
          ...commitBody({ room: ROOM, expectedEpoch: 0, sender: alice }),
          memberDelta: { added: [add], removed: [] },
        });
        expectStatus(reply, 400);
        expect(await harness().roomEpoch(ROOM)).toBe(0);
      });
    });

    describe('an Add must name a key package the COMMITTER claimed for that device', () => {
      it('accepts an ORDINARY package the committer claimed', async () => {
        const alice = await roomWithAlice();
        const bob = await harness().enrol('bob', 'bob-phone');
        expectStatus(
          await bob.post('/key-packages', [
            keyPackageItem(harness().clock, false, 'ordinary'),
            keyPackageItem(harness().clock, true, 'last-resort'),
          ]),
          201,
        );

        const keyPackageId = await claimedPackage(harness(), alice, bob);
        const { rows } = await harness().db.query<{ lastResort: boolean }>(
          'SELECT last_resort AS "lastResort" FROM key_packages WHERE id = $1',
          [keyPackageId],
        );
        expect(rows[0]?.lastResort).toBe(false); // the claim really was of an ordinary package

        expectStatus(await commitAdding(alice, 0, { member: bob, keyPackageId }), 201);
      });

      it('accepts a LAST-RESORT package the committer claimed (it is never consumed, but each claim is recorded)', async () => {
        const alice = await roomWithAlice();
        const bob = await harness().enrol('bob', 'bob-phone');
        expectStatus(
          await bob.post('/key-packages', [keyPackageItem(harness().clock, true, 'last-resort')]),
          201,
        );

        const keyPackageId = await claimedPackage(harness(), alice, bob);
        const { rows } = await harness().db.query<{ lastResort: boolean }>(
          'SELECT last_resort AS "lastResort" FROM key_packages WHERE id = $1',
          [keyPackageId],
        );
        expect(rows[0]?.lastResort).toBe(true);

        expectStatus(await commitAdding(alice, 0, { member: bob, keyPackageId }), 201);
      });

      it('accepts the id spelled in upper case (the relay mints lower case; a client may not)', async () => {
        const alice = await roomWithAlice();
        const bob = await harness().enrol('bob', 'bob-phone');
        const [added] = await harness().claimFor(alice, bob);
        expectStatus(
          await commitAdding(alice, 0, {
            member: bob,
            keyPackageId: (added?.keyPackageId ?? '').toUpperCase(),
          }),
          201,
        );
      });

      it('refuses a made-up package id, names the device, and changes nothing', async () => {
        const alice = await roomWithAlice();
        const bob = await harness().enrol('bob', 'bob-phone');

        const reply = await alice.post(
          `/conversations/${ROOM}/handshakes`,
          commitBody({ room: ROOM, expectedEpoch: 0, sender: alice, added: unclaimed(bob) }),
        );
        expectStatus(reply, 422);
        expect(reply.json()).toMatchObject({
          error: RelayErrorCode.KEY_PACKAGE_NOT_CLAIMED_BY_COMMITTER,
          deviceId: 'bob-phone',
        });
        expect(await harness().roomEpoch(ROOM)).toBe(0);
        expect(await handshakeLog(alice)).toEqual([]);
        expectStatus(await bob.get(`/conversations/${ROOM}/envelopes`), 403); // bob did not become a member
      });

      it('refuses a package that exists but that nobody claimed', async () => {
        const alice = await roomWithAlice();
        const bob = await harness().enrol('bob', 'bob-phone');
        expectStatus(
          await bob.post('/key-packages', [
            keyPackageItem(harness().clock, false, 'ordinary'),
            keyPackageItem(harness().clock, true, 'last-resort'),
          ]),
          201,
        );
        const { rows } = await harness().db.query<{ id: string }>(
          'SELECT id::text AS id FROM key_packages WHERE device_id = $1 AND NOT last_resort',
          ['bob-phone'],
        );
        const keyPackageId = rows[0]?.id ?? '';

        const reply = await commitAdding(alice, 0, { member: bob, keyPackageId });
        expectStatus(reply, 422);
        expect(reply.json()).toMatchObject({
          error: RelayErrorCode.KEY_PACKAGE_NOT_CLAIMED_BY_COMMITTER,
        });
      });

      it('refuses a package that ANOTHER device claimed, while the device that claimed it may use it', async () => {
        const alice = await roomWithAlice();
        const carol = await harness().enrol('carol', 'carol-phone');
        const bob = await harness().enrol('bob', 'bob-phone');
        expectStatus(
          await bob.post('/key-packages', [keyPackageItem(harness().clock, true, 'last-resort')]),
          201,
        );
        expectStatus(await harness().addToRoom(ROOM, alice, carol), 201); // epoch 1: alice and carol are members
        const carolsClaim = await claimedPackage(harness(), carol, bob);

        const byAlice = await commitAdding(alice, 1, { member: bob, keyPackageId: carolsClaim });
        expectStatus(byAlice, 422);
        expect(byAlice.json()).toMatchObject({
          error: RelayErrorCode.KEY_PACKAGE_NOT_CLAIMED_BY_COMMITTER,
        });
        expect(await harness().roomEpoch(ROOM)).toBe(1);

        expectStatus(await commitAdding(carol, 1, { member: bob, keyPackageId: carolsClaim }), 201);
      });

      it('refuses a package that belongs to a different device than the one being added', async () => {
        const alice = await roomWithAlice();
        const bob = await harness().enrol('bob', 'bob-phone');
        const carol = await harness().enrol('carol', 'carol-phone');
        const [forBob, forCarol] = await harness().claimFor(alice, bob, carol);

        // Alice did claim carol's package, but it is not bob's: it cannot be the Add of bob's leaf.
        const reply = await commitAdding(alice, 0, {
          member: bob,
          keyPackageId: forCarol?.keyPackageId ?? '',
        });
        expectStatus(reply, 422);
        expect(reply.json()).toMatchObject({
          error: RelayErrorCode.KEY_PACKAGE_NOT_CLAIMED_BY_COMMITTER,
          deviceId: 'bob-phone',
        });

        expectStatus(
          await commitAdding(alice, 0, { member: bob, keyPackageId: forBob?.keyPackageId ?? '' }),
          201,
        );
      });

      it('answers a made-up package and a package of another device alike (a package id is not a directory to probe)', async () => {
        const alice = await roomWithAlice();
        const bob = await harness().enrol('bob', 'bob-phone');
        const carol = await harness().enrol('carol', 'carol-phone');
        const [, forCarol] = await harness().claimFor(alice, bob, carol);

        const made = await commitAdding(alice, 0, {
          member: bob,
          keyPackageId: UNCLAIMED_KEY_PACKAGE_ID,
        });
        const foreign = await commitAdding(alice, 0, {
          member: bob,
          keyPackageId: forCarol?.keyPackageId ?? '',
        });
        expect(made.json()).toEqual(foreign.json());
      });

      it('is all or nothing: one Add without a claim refuses the whole commit', async () => {
        const alice = await roomWithAlice();
        const bob = await harness().enrol('bob', 'bob-phone');
        const carol = await harness().enrol('carol', 'carol-phone');
        const claimedForBob = await harness().claimFor(alice, bob);

        const reply = await commitAdding(alice, 0, ...claimedForBob, ...unclaimed(carol));
        expectStatus(reply, 422);
        expect(reply.json()).toMatchObject({ deviceId: 'carol-phone' });
        expect(await harness().roomEpoch(ROOM)).toBe(0);
        expect(await handshakeLog(alice)).toEqual([]);
        expectStatus(await bob.get(`/conversations/${ROOM}/envelopes`), 403); // not even the claimed one got in
      });

      it('does not apply to the creator of a group, who is added by opening it, nor to removals', async () => {
        const alice = await roomWithAlice(); // createRoom claimed nothing
        const bob = await harness().enrol('bob', 'bob-phone');
        expectStatus(await harness().addToRoom(ROOM, alice, bob), 201);

        const removal = await alice.post(
          `/conversations/${ROOM}/handshakes`,
          commitBody({ room: ROOM, expectedEpoch: 1, sender: alice, removed: [bob] }),
        );
        expectStatus(removal, 201);
      });
    });

    describe('the older rules still answer first, so their answers are not shadowed by the claim rule', () => {
      it('REVOKED device with a package nobody claimed: DEVICE_REVOKED', async () => {
        const alice = await roomWithAlice();
        const phone = await harness().enrol('carol', 'carol-phone');
        const tablet = await harness().enrol('carol', 'carol-tablet');
        expectStatus(await tablet.post('/devices/carol-phone/revoke'), 200);

        const reply = await commitAdding(alice, 0, ...unclaimed(phone));
        expectStatus(reply, 422);
        expect(reply.json()).toMatchObject({ error: RelayErrorCode.DEVICE_REVOKED });
      });

      it('device that is not on its signed list: DEVICE_NOT_IN_SIGNED_LIST', async () => {
        const alice = await roomWithAlice();
        const unlisted = await harness().registerUnlisted('dave', 'dave-phone');

        const reply = await commitAdding(alice, 0, ...unclaimed(unlisted));
        expectStatus(reply, 422);
        expect(reply.json()).toMatchObject({ error: RelayErrorCode.DEVICE_NOT_IN_SIGNED_LIST });
      });

      it('device that is already a member: ALREADY_MEMBER', async () => {
        const alice = await roomWithAlice();
        const bob = await harness().enrol('bob', 'bob-phone');
        expectStatus(await harness().addToRoom(ROOM, alice, bob), 201);

        const reply = await commitAdding(alice, 1, ...unclaimed(bob));
        expectStatus(reply, 422);
        expect(reply.json()).toMatchObject({ error: RelayErrorCode.ALREADY_MEMBER });
      });

      it('a device named twice: INVALID_MEMBER_DELTA', async () => {
        const alice = await roomWithAlice();
        const bob = await harness().enrol('bob', 'bob-phone');

        const reply = await commitAdding(alice, 0, ...unclaimed(bob, bob));
        expectStatus(reply, 422);
        expect(reply.json()).toMatchObject({ error: RelayErrorCode.INVALID_MEMBER_DELTA });
      });
    });
  },
);
