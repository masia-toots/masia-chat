import { DeviceRole, MAX_REBASES, REBASE_WINDOW_MS, RelayErrorCode } from '@masia/relay';
import { buildWelcome } from '@masia/relay/testing';
import { describe, expect, it } from 'vitest';
import {
  b64,
  commitBody,
  databaseSuite,
  expectStatus,
  groupIdOf,
  keysOf,
  signedList,
  UNCLAIMED_KEY_PACKAGE_ID,
  unclaimed,
} from './support/harness.js';

const ROOM = 'room-1';

interface Receipt {
  epoch: number;
  seq: number;
}

databaseSuite('the epoch serializer (ADR-117 §2)', (harness) => {
  it('lets exactly one of two simultaneous commits on the same epoch win; the other gets 409 and the current epoch', async () => {
    const alice = await harness().enrol('alice', 'alice-phone');
    const bob = await harness().enrol('bob', 'bob-phone');
    await harness().createRoom(ROOM, alice);
    expectStatus(await harness().addToRoom(ROOM, alice, bob), 201); // the room is now at epoch 1

    // One race can slip through by luck, so the same race is run several times: every round must
    // have exactly one winner, and the epoch must advance by exactly one. Never more rounds than
    // the rebase limit, so a device that happens to lose every round still gets 409, not 429.
    for (let round = 0; round < MAX_REBASES; round += 1) {
      const epoch = await harness().roomEpoch(ROOM);
      const replies = await Promise.all([
        alice.post(
          `/conversations/${ROOM}/handshakes`,
          commitBody({ room: ROOM, expectedEpoch: epoch, sender: alice }),
        ),
        bob.post(
          `/conversations/${ROOM}/handshakes`,
          commitBody({ room: ROOM, expectedEpoch: epoch, sender: bob }),
        ),
      ]);

      expect(replies.map((reply) => reply.status).sort(), `round ${round}`).toEqual([201, 409]);
      const loser = replies.find((reply) => reply.status === 409);
      expect(loser?.json()).toMatchObject({
        error: RelayErrorCode.EPOCH_CONFLICT,
        currentEpoch: epoch + 1,
      });
      expect(await harness().roomEpoch(ROOM)).toBe(epoch + 1);
    }
  });

  it('lets only one of many simultaneous commits on the same epoch win', async () => {
    const alice = await harness().enrol('alice', 'alice-phone');
    await harness().createRoom(ROOM, alice);

    // Six DIFFERENT commits (an identical one would be a retry, answered with the original receipt).
    const replies = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        alice.post(
          `/conversations/${ROOM}/handshakes`,
          commitBody({ room: ROOM, expectedEpoch: 0, sender: alice, content: `commit-${index}` }),
        ),
      ),
    );
    const winners = replies.filter((reply) => reply.status === 201);
    // Same sender, same epoch: one commit wins and the rest lose the race. (A 429 can follow once the
    // sender has lost more than the rebase limit; both are refusals to reuse a spent epoch.)
    expect(winners).toHaveLength(1);
    expect(
      replies
        .filter((reply) => reply.status !== 201)
        .every((reply) => [409, 429].includes(reply.status)),
    ).toBe(true);
    expect(await harness().roomEpoch(ROOM)).toBe(1);
  });

  it('numbers handshakes 1, 2, 3 … in the order they were accepted, and advances the epoch', async () => {
    const alice = await harness().enrol('alice', 'alice-phone');
    const bob = await harness().enrol('bob', 'bob-phone');
    await harness().createRoom(ROOM, alice);

    const first = await harness().addToRoom(ROOM, alice, bob);
    expectStatus(first, 201);
    expect(first.json<Receipt>()).toEqual({ epoch: 1, seq: 1 });

    const second = await alice.post(
      `/conversations/${ROOM}/handshakes`,
      commitBody({ room: ROOM, expectedEpoch: 1, sender: alice }),
    );
    expectStatus(second, 201);
    expect(second.json<Receipt>()).toEqual({ epoch: 2, seq: 2 });
  });

  it('files a Welcome beside its commit, in the same transaction and in order', async () => {
    const alice = await harness().enrol('alice', 'alice-phone');
    const bob = await harness().enrol('bob', 'bob-phone');
    await harness().createRoom(ROOM, alice);

    const added = await harness().claimFor(alice, bob);
    const reply = await alice.post(`/conversations/${ROOM}/handshakes`, {
      ...commitBody({ room: ROOM, expectedEpoch: 0, sender: alice, added }),
      welcome: buildWelcome().toString('base64'),
    });
    expectStatus(reply, 201);
    expect(reply.json<Receipt>()).toEqual({ epoch: 1, seq: 1 });

    const log = (await bob.get(`/conversations/${ROOM}/handshakes`)).json<{
      rows: Array<{ seq: number; epoch: number; kind: string }>;
    }>();
    expect(log.rows.map((row) => [row.seq, row.kind, row.epoch])).toEqual([
      [1, 'COMMIT', 0],
      [2, 'WELCOME', 0],
    ]);
  });

  it('has no GroupInfo any more: the field is an unknown one (400), nothing is stored, and the kind does not exist', async () => {
    // External joins are out of scope in phase 1 (security review 2026-10-10 §2), so a GroupInfo that
    // every member could read has nowhere to live. An unknown field is refused, not dropped.
    const alice = await harness().enrol('alice', 'alice-phone');
    await harness().createRoom(ROOM, alice);

    const reply = await alice.post(`/conversations/${ROOM}/handshakes`, {
      ...commitBody({ room: ROOM, expectedEpoch: 0, sender: alice }),
      groupInfo: b64('group-info'),
    });
    expectStatus(reply, 400);
    expect(reply.json()).toMatchObject({ error: RelayErrorCode.VALIDATION_FAILED });
    expect(await harness().roomEpoch(ROOM)).toBe(0);
    expect((await harness().db.query('SELECT 1 FROM mls_handshakes')).rows).toHaveLength(0);

    // The database cannot hold one either: the enum value was removed.
    await expect(
      harness().db.query(
        `INSERT INTO mls_handshakes (conversation_id, epoch, seq, kind, sender_device_id, bytes)
         VALUES ($1, 0, 1, 'GROUP_INFO', 'alice-phone', $2)`,
        [ROOM, Buffer.from('x')],
      ),
    ).rejects.toThrow(/handshake_kind/);
  });

  it('refuses a standalone PROPOSAL with its own code (422), and stores nothing: proposals travel inside commits', async () => {
    const alice = await harness().enrol('alice', 'alice-phone');
    await harness().createRoom(ROOM, alice);

    const reply = await alice.post(`/conversations/${ROOM}/handshakes`, {
      ...commitBody({ room: ROOM, expectedEpoch: 0, sender: alice }),
      kind: 'PROPOSAL',
    });
    expectStatus(reply, 422);
    expect(reply.json()).toMatchObject({
      error: RelayErrorCode.HANDSHAKE_KIND_UNSUPPORTED,
      kind: 'PROPOSAL',
    });
    expect(await harness().roomEpoch(ROOM)).toBe(0);
    expect((await harness().db.query('SELECT 1 FROM mls_handshakes')).rows).toHaveLength(0);
  });

  describe('retries are answered, not refused (review round 1, 2026-10-10: idempotent posts)', () => {
    it('answers the same commit from the same device at the same epoch with the original receipt (200), once it was stored', async () => {
      const alice = await harness().enrol('alice', 'alice-phone');
      const bob = await harness().enrol('bob', 'bob-phone');
      await harness().createRoom(ROOM, alice);
      expectStatus(await harness().addToRoom(ROOM, alice, bob), 201);

      const commit = commitBody({
        room: ROOM,
        expectedEpoch: 1,
        sender: alice,
        content: 'the-commit',
      });
      const first = await alice.post(`/conversations/${ROOM}/handshakes`, commit);
      expectStatus(first, 201);
      const retry = await alice.post(`/conversations/${ROOM}/handshakes`, commit);
      expectStatus(retry, 200);
      expect(retry.json()).toEqual(first.json());
      expect(await harness().roomEpoch(ROOM)).toBe(2);
      expect((await harness().db.query('SELECT 1 FROM mls_handshakes')).rows).toHaveLength(2);
    });

    it('still answers 409 for a different commit at a spent epoch, and for the same bytes from another device', async () => {
      const alice = await harness().enrol('alice', 'alice-phone');
      const bob = await harness().enrol('bob', 'bob-phone');
      await harness().createRoom(ROOM, alice);
      expectStatus(await harness().addToRoom(ROOM, alice, bob), 201); // the commit at epoch 0 is alice's

      const different = await alice.post(
        `/conversations/${ROOM}/handshakes`,
        commitBody({ room: ROOM, expectedEpoch: 0, sender: alice, content: 'another-commit' }),
      );
      expectStatus(different, 409);
      const stored = (
        await harness().db.query<{ bytes: Buffer }>('SELECT bytes FROM mls_handshakes')
      ).rows[0];
      const sameBytesOtherDevice = await bob.post(`/conversations/${ROOM}/handshakes`, {
        ...commitBody({ room: ROOM, expectedEpoch: 0, sender: bob }),
        bytes: stored?.bytes.toString('base64'),
      });
      expectStatus(sameBytesOtherDevice, 409);
    });

    it('answers six simultaneous copies of one commit with one 201 and the same receipt for the rest (200)', async () => {
      const alice = await harness().enrol('alice', 'alice-phone');
      await harness().createRoom(ROOM, alice);
      const commit = commitBody({ room: ROOM, expectedEpoch: 0, sender: alice });

      const replies = await Promise.all(
        Array.from({ length: 6 }, () => alice.post(`/conversations/${ROOM}/handshakes`, commit)),
      );
      expect(replies.map((reply) => reply.status).sort()).toEqual([200, 200, 200, 200, 200, 201]);
      expect(new Set(replies.map((reply) => JSON.stringify(reply.json())))).toEqual(
        new Set([JSON.stringify({ epoch: 1, seq: 1 })]),
      );
      expect(await harness().roomEpoch(ROOM)).toBe(1);
    });

    it('answers a repeated group opening by the same device with 200, and anyone else with 409', async () => {
      const alice = await harness().enrol('alice', 'alice-phone');
      const bob = await harness().enrol('bob', 'bob-phone');
      await harness().createRoom(ROOM, alice);
      const sameBody = { groupId: groupIdOf(ROOM).toString('base64'), treeHash: b64('tree-hash') };

      const retry = await alice.post(`/conversations/${ROOM}/e2ee`, sameBody);
      expectStatus(retry, 200);
      expect(retry.json()).toEqual({ epoch: 0 });
      expectStatus(await bob.post(`/conversations/${ROOM}/e2ee`, sameBody), 409);
      expect((await harness().db.query('SELECT 1 FROM room_members')).rows).toHaveLength(1);
    });
  });

  describe('membership rules', () => {
    it('refuses to add a REVOKED device (422)', async () => {
      const alice = await harness().enrol('alice', 'alice-phone');
      await harness().createRoom(ROOM, alice);
      const phone = await harness().enrol('carol', 'carol-phone');
      const tablet = await harness().enrol('carol', 'carol-tablet');
      expectStatus(await tablet.post('/devices/carol-phone/revoke'), 200);

      const reply = await harness().addToRoom(ROOM, alice, phone);
      expectStatus(reply, 422);
      expect(reply.json()).toMatchObject({ error: RelayErrorCode.DEVICE_REVOKED });
      expect(await harness().roomEpoch(ROOM)).toBe(0);
    });

    it("refuses to add a device that is not on its owner's signed list (422)", async () => {
      const alice = await harness().enrol('alice', 'alice-phone');
      await harness().createRoom(ROOM, alice);
      const unlisted = await harness().registerUnlisted('dave', 'dave-phone');

      const reply = await harness().addToRoom(ROOM, alice, unlisted);
      expectStatus(reply, 422);
      expect(reply.json()).toMatchObject({ error: RelayErrorCode.DEVICE_NOT_IN_SIGNED_LIST });
    });

    it('refuses to add a device the relay has never heard of (422): a ghost leaf', async () => {
      const alice = await harness().enrol('alice', 'alice-phone');
      await harness().createRoom(ROOM, alice);
      const ghost = await harness().caller({ userId: 'ghost', deviceId: 'ghost-phone' });

      const reply = await harness().addToRoom(ROOM, alice, ghost);
      expectStatus(reply, 422);
      expect(reply.json()).toMatchObject({ error: RelayErrorCode.DEVICE_NOT_IN_SIGNED_LIST });
    });

    it('refuses to add a device whose key differs from the one on the signed list (422)', async () => {
      const alice = await harness().enrol('alice', 'alice-phone');
      await harness().createRoom(ROOM, alice);
      const erin = await harness().enrol('erin', 'erin-phone');
      // Erin's next list names her phone with a different signature key than the one registered.
      expectStatus(
        await erin.post(
          '/users/me/device-list',
          signedList('erin', 2, [
            {
              id: 'erin-phone',
              role: DeviceRole.USER,
              signatureKey: keysOf('some-other-device').signatureKeyPub,
            },
          ]),
        ),
        201,
      );

      const reply = await harness().addToRoom(ROOM, alice, erin);
      expectStatus(reply, 422);
      expect(reply.json()).toMatchObject({ error: RelayErrorCode.DEVICE_NOT_IN_SIGNED_LIST });
    });

    it('refuses to add a device under a user or role it does not have (422)', async () => {
      const alice = await harness().enrol('alice', 'alice-phone');
      await harness().createRoom(ROOM, alice);
      await harness().enrol('bob', 'bob-phone');

      const reply = await alice.post(`/conversations/${ROOM}/handshakes`, {
        ...commitBody({ room: ROOM, expectedEpoch: 0, sender: alice }),
        memberDelta: {
          added: [
            {
              deviceId: 'bob-phone',
              userId: 'bob',
              role: DeviceRole.GUARDIAN,
              keyPackageId: UNCLAIMED_KEY_PACKAGE_ID,
            },
          ],
          removed: [],
        },
      });
      expectStatus(reply, 422);
    });

    it('refuses to add a device twice, to remove a stranger, and to add and remove the same device (422)', async () => {
      const alice = await harness().enrol('alice', 'alice-phone');
      const bob = await harness().enrol('bob', 'bob-phone');
      const carol = await harness().enrol('carol', 'carol-phone');
      await harness().createRoom(ROOM, alice);
      expectStatus(await harness().addToRoom(ROOM, alice, bob), 201);

      const addAgain = await harness().addToRoom(ROOM, alice, bob);
      expectStatus(addAgain, 422);
      expect(addAgain.json()).toMatchObject({ error: RelayErrorCode.ALREADY_MEMBER });

      const removeStranger = await alice.post(
        `/conversations/${ROOM}/handshakes`,
        commitBody({ room: ROOM, expectedEpoch: 1, sender: alice, removed: [carol] }),
      );
      expectStatus(removeStranger, 422);
      expect(removeStranger.json()).toMatchObject({
        error: RelayErrorCode.REMOVE_TARGET_NOT_MEMBER,
      });

      const contradictory = await alice.post(
        `/conversations/${ROOM}/handshakes`,
        commitBody({
          room: ROOM,
          expectedEpoch: 1,
          sender: alice,
          added: unclaimed(carol),
          removed: [carol],
        }),
      );
      expectStatus(contradictory, 422);
      expect(contradictory.json()).toMatchObject({ error: RelayErrorCode.INVALID_MEMBER_DELTA });
    });

    it('lets only a FAMILY_ADMIN of the child remove a GUARDIAN device (403 for the child)', async () => {
      const kid = await harness().enrol('kid', 'kid-phone');
      // The guardian leaf carries the CHILD's user id; mum's token drives it (guardianOf: [kid]).
      const mum = await harness().enrol('kid', 'mum-guardian', DeviceRole.GUARDIAN, {
        guardian: 'mum',
      });
      const dad = await harness().enrol('dad', 'dad-phone');
      await harness().createRoom(ROOM, kid);
      expectStatus(await harness().addToRoom(ROOM, kid, mum), 201); // adding a guardian needs no admin claim
      expectStatus(await harness().addToRoom(ROOM, kid, dad), 201); // the room is now at epoch 2

      const removeByChild = await kid.post(
        `/conversations/${ROOM}/handshakes`,
        commitBody({ room: ROOM, expectedEpoch: 2, sender: kid, removed: [mum] }),
      );
      expectStatus(removeByChild, 403);
      expect(removeByChild.json()).toMatchObject({
        error: RelayErrorCode.GUARDIAN_REMOVE_FORBIDDEN,
      });
      expect(await harness().roomEpoch(ROOM)).toBe(2);
      expectStatus(await mum.get(`/conversations/${ROOM}/envelopes`), 200); // still a member

      const adminDad = await harness().caller(
        { userId: 'dad', deviceId: 'dad-phone' },
        { adminOf: ['kid'] },
      );
      const removeByAdmin = await adminDad.post(
        `/conversations/${ROOM}/handshakes`,
        commitBody({ room: ROOM, expectedEpoch: 2, sender: adminDad, removed: [mum] }),
      );
      expectStatus(removeByAdmin, 201);
      expect(removeByAdmin.json<Receipt>().epoch).toBe(3);
      const gone = await mum.get(`/conversations/${ROOM}/envelopes`); // no longer a member
      expectStatus(gone, 403);
      expect(gone.json()).toMatchObject({ error: RelayErrorCode.REMOVED, removedAtEpoch: 3 });
    });

    describe("another guardian of the same child (the engine's mayRemoveGuardian)", () => {
      async function twoGuardians() {
        const kid = await harness().enrol('kid', 'kid-phone');
        const mum = await harness().enrol('kid', 'mum-guardian', DeviceRole.GUARDIAN, {
          guardian: 'mum',
        });
        const dad = await harness().enrol('kid', 'dad-guardian', DeviceRole.GUARDIAN, {
          guardian: 'dad',
        });
        await harness().createRoom(ROOM, kid);
        expectStatus(await harness().addToRoom(ROOM, kid, mum, dad), 201); // epoch 1
        return { kid, mum, dad };
      }

      it('lets a guardian device of the child remove another guardian device of the same child (201)', async () => {
        const { mum, dad } = await twoGuardians();
        const reply = await dad.post(
          `/conversations/${ROOM}/handshakes`,
          commitBody({ room: ROOM, expectedEpoch: 1, sender: dad, removed: [mum] }),
        );
        expectStatus(reply, 201);
      });

      it('refuses a guardian device whose token does not guard that child (403)', async () => {
        const { mum, dad } = await twoGuardians();
        // Dad's device is the child's guardian device, but this token lists another child.
        const wrongToken = await harness().caller(
          { userId: 'kid', deviceId: dad.deviceId, role: DeviceRole.GUARDIAN, tokenUserId: 'dad' },
          { guardianOf: ['some-other-kid'] },
        );
        const reply = await wrongToken.post(
          `/conversations/${ROOM}/handshakes`,
          commitBody({ room: ROOM, expectedEpoch: 1, sender: wrongToken, removed: [mum] }),
        );
        // The token cannot even drive the device: it guards someone else.
        expectStatus(reply, 403);
        expect(await harness().roomEpoch(ROOM)).toBe(1);
      });

      it('refuses a guardian device of ANOTHER child (403 GUARDIAN_REMOVE_FORBIDDEN)', async () => {
        const { kid, mum } = await twoGuardians();
        const other = await harness().enrol('kid-2', 'aunt-guardian', DeviceRole.GUARDIAN, {
          guardian: 'aunt',
        });
        expectStatus(await harness().addToRoom(ROOM, kid, other), 201); // epoch 2
        const reply = await other.post(
          `/conversations/${ROOM}/handshakes`,
          commitBody({ room: ROOM, expectedEpoch: 2, sender: other, removed: [mum] }),
        );
        expectStatus(reply, 403);
        expect(reply.json()).toMatchObject({ error: RelayErrorCode.GUARDIAN_REMOVE_FORBIDDEN });
      });
    });

    describe("the admin's reach is adminOf, not the FAMILY_ADMIN marker (security review 2026-10-10 §4)", () => {
      // Two families share a room (a group chat across households). Dad A is the admin of family A.
      async function twoFamilies() {
        const kidB = await harness().enrol('kid-b', 'kid-b-phone');
        const guardianB = await harness().enrol('kid-b', 'mum-b-guardian', DeviceRole.GUARDIAN, {
          guardian: 'mum-b',
        });
        const dadA = await harness().enrol('dad-a', 'dad-a-phone');
        await harness().createRoom(ROOM, kidB);
        expectStatus(await harness().addToRoom(ROOM, kidB, guardianB), 201);
        expectStatus(await harness().addToRoom(ROOM, kidB, dadA), 201); // epoch 2
        return { kidB, guardianB, dadA };
      }

      type Families = Awaited<ReturnType<typeof twoFamilies>>;

      /** Dad A, holding a token with this `adminOf`, tries to remove family B's guardian. */
      async function removeGuardianAs(families: Families, adminOf: readonly string[]) {
        const { guardianB, dadA } = families;
        const admin = await harness().caller(
          { userId: dadA.userId, deviceId: dadA.deviceId },
          { adminOf },
        );
        return admin.post(
          `/conversations/${ROOM}/handshakes`,
          commitBody({ room: ROOM, expectedEpoch: 2, sender: admin, removed: [guardianB] }),
        );
      }

      it("refuses the admin of family A who removes family B's guardian (403), with the very answer a non-admin gets", async () => {
        const { kidB, guardianB } = await twoFamilies();
        const nonAdmin = await kidB.post(
          `/conversations/${ROOM}/handshakes`,
          commitBody({ room: ROOM, expectedEpoch: 2, sender: kidB, removed: [guardianB] }),
        );
        const dadAAsAdmin = await harness().caller(
          { userId: 'dad-a', deviceId: 'dad-a-phone' },
          { adminOf: ['dad-a', 'kid-a'] },
        );
        const crossFamily = await dadAAsAdmin.post(
          `/conversations/${ROOM}/handshakes`,
          commitBody({ room: ROOM, expectedEpoch: 2, sender: dadAAsAdmin, removed: [guardianB] }),
        );

        expectStatus(crossFamily, 403);
        expect(crossFamily.json()).toMatchObject({
          error: RelayErrorCode.GUARDIAN_REMOVE_FORBIDDEN,
        });
        expect(crossFamily.json()).toEqual(nonAdmin.json());
        expect(await harness().roomEpoch(ROOM)).toBe(2);
      });

      it("lets the admin whose adminOf lists the child family B's guardian guards remove it (201)", async () => {
        const reply = await removeGuardianAs(await twoFamilies(), ['kid-b']);
        expectStatus(reply, 201);
        expect(reply.json<Receipt>().epoch).toBe(3);
      });

      it('gives the bare marker (an admin of nobody) no reach at all (403)', async () => {
        expectStatus(await removeGuardianAs(await twoFamilies(), []), 403);
      });

      it("gives no reach over a child's guardian to an admin of the guardian adult only (403)", async () => {
        expectStatus(await removeGuardianAs(await twoFamilies(), ['mum-b']), 403);
      });
    });

    it('does not let a body claim to be the family admin (400)', async () => {
      const kid = await harness().enrol('kid', 'kid-phone');
      await harness().createRoom(ROOM, kid);
      const reply = await kid.post(`/conversations/${ROOM}/handshakes`, {
        ...commitBody({ room: ROOM, expectedEpoch: 0, sender: kid }),
        actor: 'FAMILY_ADMIN',
      });
      expectStatus(reply, 400);
    });

    it('does not let a body carry an adminOf either (400)', async () => {
      const kid = await harness().enrol('kid', 'kid-phone');
      await harness().createRoom(ROOM, kid);
      const reply = await kid.post(`/conversations/${ROOM}/handshakes`, {
        ...commitBody({ room: ROOM, expectedEpoch: 0, sender: kid }),
        adminOf: ['mum'],
      });
      expectStatus(reply, 400);
    });
  });

  it("refuses a sender id that is not the token's device (403): a device cannot post as another", async () => {
    const alice = await harness().enrol('alice', 'alice-phone');
    const bob = await harness().enrol('bob', 'bob-phone');
    await harness().createRoom(ROOM, alice);
    expectStatus(await harness().addToRoom(ROOM, alice, bob), 201);

    const reply = await bob.post(
      `/conversations/${ROOM}/handshakes`,
      commitBody({ room: ROOM, expectedEpoch: 1, sender: alice }), // names alice-phone, signed with bob's token
    );
    expectStatus(reply, 403);
    expect(reply.json()).toMatchObject({ error: RelayErrorCode.DEVICE_MISMATCH });
  });

  it('refuses a commit from a device that is not in the room, and does not say whether the room exists (403)', async () => {
    const alice = await harness().enrol('alice', 'alice-phone');
    const mallory = await harness().enrol('mallory', 'mallory-phone');
    await harness().createRoom(ROOM, alice);

    const intruder = await mallory.post(
      `/conversations/${ROOM}/handshakes`,
      commitBody({ room: ROOM, expectedEpoch: 0, sender: mallory }),
    );
    const elsewhere = await mallory.post(
      '/conversations/no-such-room/handshakes',
      commitBody({ room: 'no-such-room', expectedEpoch: 0, sender: mallory }),
    );
    expectStatus(intruder, 403);
    expectStatus(elsewhere, 403);
    expect(elsewhere.json()).toEqual(intruder.json());
  });

  it('does not tell a stranger which epoch a room is in, even when its epoch is wrong', async () => {
    const alice = await harness().enrol('alice', 'alice-phone');
    const mallory = await harness().enrol('mallory', 'mallory-phone');
    await harness().createRoom(ROOM, alice);

    const reply = await mallory.post(
      `/conversations/${ROOM}/handshakes`,
      commitBody({ room: ROOM, expectedEpoch: 99, sender: mallory }),
    );
    expectStatus(reply, 403);
    expect(JSON.stringify(reply.json())).not.toContain('currentEpoch');
  });

  it('requires a tree hash on a commit (400), and answers a proposal kind with its own refusal first (422)', async () => {
    const alice = await harness().enrol('alice', 'alice-phone');
    await harness().createRoom(ROOM, alice);
    // `undefined` is dropped when the body is serialized, which is how a field goes missing.
    const withoutTreeHash = {
      ...commitBody({ room: ROOM, expectedEpoch: 0, sender: alice }),
      newTreeHash: undefined,
    };

    expectStatus(await alice.post(`/conversations/${ROOM}/handshakes`, withoutTreeHash), 400);
    const proposal = await alice.post(`/conversations/${ROOM}/handshakes`, {
      ...withoutTreeHash,
      kind: 'PROPOSAL',
    });
    expectStatus(proposal, 422);
    expect(proposal.json()).toMatchObject({ error: RelayErrorCode.HANDSHAKE_KIND_UNSUPPORTED });
  });

  describe('the rebase limit', () => {
    it(`answers 429 REBASE_LIMIT after ${MAX_REBASES} lost races in a row, and only for conflicts`, async () => {
      const alice = await harness().enrol('alice', 'alice-phone');
      await harness().createRoom(ROOM, alice);
      const staleCommit = () =>
        alice.post(
          `/conversations/${ROOM}/handshakes`,
          commitBody({ room: ROOM, expectedEpoch: 99, sender: alice }),
        );

      for (let lost = 1; lost <= MAX_REBASES; lost += 1) {
        const reply = await staleCommit();
        expectStatus(reply, 409);
        expect(reply.json()).toMatchObject({
          error: RelayErrorCode.EPOCH_CONFLICT,
          currentEpoch: 0,
        });
      }
      const limited = await staleCommit();
      expectStatus(limited, 429);
      expect(limited.json()).toMatchObject({ error: RelayErrorCode.REBASE_LIMIT, currentEpoch: 0 });

      // The limit is about racing, not a ban: a commit that is built on the right epoch still lands.
      expectStatus(
        await alice.post(
          `/conversations/${ROOM}/handshakes`,
          commitBody({ room: ROOM, expectedEpoch: 0, sender: alice }),
        ),
        201,
      );
    });

    it('resets the count when a commit succeeds, and forgets it after the window', async () => {
      const alice = await harness().enrol('alice', 'alice-phone');
      await harness().createRoom(ROOM, alice);
      const stale = () =>
        alice.post(
          `/conversations/${ROOM}/handshakes`,
          commitBody({ room: ROOM, expectedEpoch: 99, sender: alice }),
        );

      for (let lost = 1; lost < MAX_REBASES; lost += 1) expectStatus(await stale(), 409);
      expectStatus(
        await alice.post(
          `/conversations/${ROOM}/handshakes`,
          commitBody({ room: ROOM, expectedEpoch: 0, sender: alice }),
        ),
        201,
      );
      // A success wiped the run: it takes a whole new run to reach the limit.
      for (let lost = 1; lost <= MAX_REBASES; lost += 1) expectStatus(await stale(), 409);
      expectStatus(await stale(), 429);

      harness().clock.advance(REBASE_WINDOW_MS + 1);
      expectStatus(await stale(), 409);
    });

    it('counts per device: one device losing does not limit another', async () => {
      const alice = await harness().enrol('alice', 'alice-phone');
      const bob = await harness().enrol('bob', 'bob-phone');
      await harness().createRoom(ROOM, alice);
      expectStatus(await harness().addToRoom(ROOM, alice, bob), 201);

      for (let lost = 0; lost <= MAX_REBASES; lost += 1) {
        await alice.post(
          `/conversations/${ROOM}/handshakes`,
          commitBody({ room: ROOM, expectedEpoch: 99, sender: alice }),
        );
      }
      expectStatus(
        await bob.post(
          `/conversations/${ROOM}/handshakes`,
          commitBody({ room: ROOM, expectedEpoch: 99, sender: bob }),
        ),
        409,
      );
    });
  });

  it('refuses to open a group twice, and a group id that is already taken (409)', async () => {
    const alice = await harness().enrol('alice', 'alice-phone');
    await harness().createRoom(ROOM, alice);

    const again = await alice.post(`/conversations/${ROOM}/e2ee`, {
      groupId: b64('another-group-id'),
      treeHash: b64('tree-hash'),
    });
    expectStatus(again, 409);
    expect(again.json()).toMatchObject({ error: RelayErrorCode.CONVERSATION_EXISTS });

    const sameGroup = await alice.post('/conversations/room-2/e2ee', {
      groupId: b64(`group-${ROOM}`),
      treeHash: b64('tree-hash'),
    });
    expectStatus(sameGroup, 409);
  });

  it('refuses to open a group for a creator that is not on its signed list (422)', async () => {
    const unlisted = await harness().registerUnlisted('dave', 'dave-phone');
    const reply = await unlisted.post(`/conversations/${ROOM}/e2ee`, {
      groupId: b64('group-id-1'),
      treeHash: b64('tree-hash'),
    });
    expectStatus(reply, 422);
    // The refusal rolled the whole creation back: there is no half-made room.
    const { rows } = await harness().db.query('SELECT 1 FROM conversation_e2ee');
    expect(rows).toHaveLength(0);
  });
});
