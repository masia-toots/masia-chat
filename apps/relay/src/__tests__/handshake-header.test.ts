import { MAX_REBASES, RelayErrorCode } from '@masia/relay';
import {
  buildPrivateMessage,
  buildPublicMessage,
  buildWelcome,
  MlsContentType,
  MlsSenderType,
} from '@masia/relay/testing';
import { describe, expect, it } from 'vitest';
import {
  type Caller,
  commitBody,
  databaseSuite,
  expectStatus,
  groupIdOf,
  sealed,
} from './support/harness.js';

const ROOM = 'room-1';
/** The epoch the room is at in these tests, so that "one earlier" and "one later" both exist. */
const ROOM_EPOCH = 1;

const OTHER_GROUP = Buffer.from('some-other-group');
const GARBAGE = Buffer.from('this-is-not-an-mls-message-at-all');

/** `ProtocolVersion` and `WireFormat`, two bytes each, open every MLSMessage. */
const VERSION_AND_WIRE_FORMAT_BYTES = 4;

const asBase64 = (bytes: Buffer): string => bytes.toString('base64');

/** A well-formed PrivateMessage header for this room at `epoch`, unless the test bends one field. */
function privateMessage(options: {
  groupId?: Buffer;
  epoch?: bigint | number;
  contentType: number;
}): Buffer {
  return buildPrivateMessage({
    groupId: options.groupId ?? groupIdOf(ROOM),
    epoch: options.epoch ?? ROOM_EPOCH,
    contentType: options.contentType,
  });
}

interface Refusal {
  error: string;
  field: string;
}

databaseSuite(
  'the MLSMessage header check (security review 2026-10-10 §4, "Relay design")',
  (harness) => {
    /** A room at epoch 1 with alice and bob in it. */
    async function roomAtEpochOne(): Promise<{ alice: Caller; bob: Caller }> {
      const alice = await harness().enrol('alice', 'alice-phone');
      const bob = await harness().enrol('bob', 'bob-phone');
      await harness().createRoom(ROOM, alice);
      expectStatus(await harness().addToRoom(ROOM, alice, bob), 201);
      expect(await harness().roomEpoch(ROOM)).toBe(ROOM_EPOCH);
      return { alice, bob };
    }

    const handshakeCount = async (): Promise<number> =>
      Number(
        (await harness().db.query<{ n: string }>('SELECT count(*) AS n FROM mls_handshakes'))
          .rows[0]?.n,
      );

    function postCommit(from: Caller, bytes: Buffer, extra: object = {}) {
      return from.post(`/conversations/${ROOM}/handshakes`, {
        ...commitBody({ room: ROOM, expectedEpoch: ROOM_EPOCH, sender: from }),
        bytes: asBase64(bytes),
        ...extra,
      });
    }

    function postEnvelope(from: Caller, bytes: Buffer, epoch = ROOM_EPOCH) {
      return from.post(`/conversations/${ROOM}/envelopes`, {
        epoch,
        senderDeviceId: from.deviceId,
        ciphertext: asBase64(bytes),
      });
    }

    /** The refusal: a 422 MLS_HEADER_MISMATCH that names the field, with nothing stored and the epoch unmoved. */
    async function expectRefused(
      reply: Awaited<ReturnType<typeof postCommit>>,
      field?: string,
    ): Promise<void> {
      expectStatus(reply, 422);
      const body = reply.json<Refusal>();
      expect(body.error).toBe(RelayErrorCode.MLS_HEADER_MISMATCH);
      if (field === undefined) expect(typeof body.field).toBe('string');
      else expect(body.field).toBe(field);
    }

    describe('a commit', () => {
      it('is accepted when it is a PrivateMessage of this room and epoch with the commit content type', async () => {
        const { alice } = await roomAtEpochOne();
        const reply = await postCommit(
          alice,
          privateMessage({ contentType: MlsContentType.COMMIT }),
        );
        expectStatus(reply, 201);
        expect(await harness().roomEpoch(ROOM)).toBe(ROOM_EPOCH + 1);
      });

      it('is accepted as a PublicMessage from a group MEMBER', async () => {
        const { alice } = await roomAtEpochOne();
        const bytes = buildPublicMessage({
          groupId: groupIdOf(ROOM),
          epoch: ROOM_EPOCH,
          contentType: MlsContentType.COMMIT,
          sender: { type: MlsSenderType.MEMBER, index: 0 },
        });
        expectStatus(await postCommit(alice, bytes), 201);
      });

      it.each([
        [
          'for another group',
          () => privateMessage({ groupId: OTHER_GROUP, contentType: MlsContentType.COMMIT }),
          'groupId',
        ],
        [
          'for an earlier epoch',
          () => privateMessage({ epoch: ROOM_EPOCH - 1, contentType: MlsContentType.COMMIT }),
          'epoch',
        ],
        [
          'for a later epoch',
          () => privateMessage({ epoch: ROOM_EPOCH + 1, contentType: MlsContentType.COMMIT }),
          'epoch',
        ],
        [
          'for the largest epoch a uint64 holds',
          () => privateMessage({ epoch: 2n ** 64n - 1n, contentType: MlsContentType.COMMIT }),
          'epoch',
        ],
        [
          'with the application content type',
          () => privateMessage({ contentType: MlsContentType.APPLICATION }),
          'contentType',
        ],
        [
          'with the proposal content type',
          () => privateMessage({ contentType: MlsContentType.PROPOSAL }),
          'contentType',
        ],
        ['that is a Welcome', () => buildWelcome(), 'wireFormat'],
      ])('is refused (422) when it is a message %s', async (_label, build, field) => {
        const { alice } = await roomAtEpochOne();
        const before = await handshakeCount();

        await expectRefused(await postCommit(alice, build()), field);
        expect(await harness().roomEpoch(ROOM)).toBe(ROOM_EPOCH);
        expect(await handshakeCount()).toBe(before);
      });

      it.each([
        ['an external sender', MlsSenderType.EXTERNAL],
        ['a new-member proposal sender', MlsSenderType.NEW_MEMBER_PROPOSAL],
        ['a new-member commit sender (an external join)', MlsSenderType.NEW_MEMBER_COMMIT],
      ])(
        'is refused (422) as a PublicMessage from %s: external joins are off in phase 1',
        async (_label, type) => {
          const { alice } = await roomAtEpochOne();
          const bytes = buildPublicMessage({
            groupId: groupIdOf(ROOM),
            epoch: ROOM_EPOCH,
            contentType: MlsContentType.COMMIT,
            sender: { type },
          });
          await expectRefused(await postCommit(alice, bytes), 'sender');
          expect(await harness().roomEpoch(ROOM)).toBe(ROOM_EPOCH);
        },
      );

      it('is refused (422) when the bytes are not an MLSMessage at all, or are cut short', async () => {
        const { alice } = await roomAtEpochOne();
        const whole = privateMessage({ contentType: MlsContentType.COMMIT });

        await expectRefused(await postCommit(alice, GARBAGE));
        // The relay reads the cleartext header only (version, wire format, group id, epoch, content
        // type); what comes after it is ciphertext it cannot judge. So a cut INSIDE the header is
        // refused, and the field it cut through is named.
        const epochStart = VERSION_AND_WIRE_FORMAT_BYTES + 1 + groupIdOf(ROOM).length;
        await expectRefused(await postCommit(alice, whole.subarray(0, 6)), 'groupId');
        await expectRefused(await postCommit(alice, whole.subarray(0, epochStart + 4)), 'epoch');
        await expectRefused(
          await postCommit(alice, whole.subarray(0, epochStart + 8)),
          'contentType',
        );
        expect(await harness().roomEpoch(ROOM)).toBe(ROOM_EPOCH);
      });

      it('does not stall the room: after any number of refused commits an honest one still wins', async () => {
        const { alice, bob } = await roomAtEpochOne();
        // Refusals that are NOT epoch conflicts do not count toward the rebase limit either.
        for (let attempt = 0; attempt <= MAX_REBASES + 1; attempt += 1) {
          await expectRefused(await postCommit(bob, GARBAGE));
        }
        const honest = await postCommit(
          alice,
          privateMessage({ contentType: MlsContentType.COMMIT }),
        );
        expectStatus(honest, 201);
        expect(honest.json()).toMatchObject({ epoch: ROOM_EPOCH + 1 });
      });

      it('is refused (422) when the Welcome beside it is not a Welcome, and nothing of the commit is kept', async () => {
        const { alice } = await roomAtEpochOne();
        const before = await handshakeCount();

        const notAWelcome = await postCommit(
          alice,
          privateMessage({ contentType: MlsContentType.COMMIT }),
          {
            welcome: asBase64(privateMessage({ contentType: MlsContentType.COMMIT })),
          },
        );
        await expectRefused(notAWelcome, 'wireFormat');
        await expectRefused(
          await postCommit(alice, privateMessage({ contentType: MlsContentType.COMMIT }), {
            welcome: asBase64(GARBAGE),
          }),
        );
        expect(await harness().roomEpoch(ROOM)).toBe(ROOM_EPOCH);
        expect(await handshakeCount()).toBe(before);
      });
    });

    describe('a proposal', () => {
      it.each([
        ['a well-formed proposal', () => privateMessage({ contentType: MlsContentType.PROPOSAL })],
        ['garbage', () => GARBAGE],
      ])(
        'is refused by its kind (422 HANDSHAKE_KIND_UNSUPPORTED) before its bytes are read: %s',
        async (_label, build) => {
          const { alice } = await roomAtEpochOne();
          const before = await handshakeCount();

          const reply = await postCommit(alice, build(), { kind: 'PROPOSAL' });
          expectStatus(reply, 422);
          expect(reply.json()).toMatchObject({ error: RelayErrorCode.HANDSHAKE_KIND_UNSUPPORTED });
          expect(await handshakeCount()).toBe(before);
        },
      );
    });

    describe('an envelope', () => {
      it('is accepted when it is a PrivateMessage of this room and epoch with the application content type', async () => {
        const { alice } = await roomAtEpochOne();
        expectStatus(
          await postEnvelope(alice, Buffer.from(sealed(ROOM, ROOM_EPOCH, 'hello'), 'base64')),
          201,
        );
      });

      it.each([
        [
          'for another group',
          () => privateMessage({ groupId: OTHER_GROUP, contentType: MlsContentType.APPLICATION }),
          'groupId',
        ],
        [
          'for another epoch than the one it is posted for',
          () => privateMessage({ epoch: ROOM_EPOCH - 1, contentType: MlsContentType.APPLICATION }),
          'epoch',
        ],
        [
          'that is a commit',
          () => privateMessage({ contentType: MlsContentType.COMMIT }),
          'contentType',
        ],
        [
          'that is a proposal',
          () => privateMessage({ contentType: MlsContentType.PROPOSAL }),
          'contentType',
        ],
        ['that is a Welcome', () => buildWelcome(), 'wireFormat'],
        [
          'that is a PublicMessage (it would put the text in the clear)',
          () =>
            buildPublicMessage({
              groupId: groupIdOf(ROOM),
              epoch: ROOM_EPOCH,
              contentType: MlsContentType.APPLICATION,
            }),
          'wireFormat',
        ],
      ])('is refused (422) when it is a message %s', async (_label, build, field) => {
        const { alice } = await roomAtEpochOne();
        await expectRefused(await postEnvelope(alice, build()), field);
        const count = await harness().db.query<{ n: string }>(
          'SELECT count(*) AS n FROM envelopes',
        );
        expect(Number(count.rows[0]?.n)).toBe(0);
      });

      it('is refused (422) when it is plain text rather than an MLSMessage: the relay stores only ciphertext', async () => {
        const { alice } = await roomAtEpochOne();
        await expectRefused(
          await postEnvelope(alice, Buffer.from('hello, this is a plain text message')),
        );
      });
    });

    describe('the order of refusals (a refusal must not become an oracle)', () => {
      it('answers a non-member 403 before it reads the header, so a stranger learns nothing about the group', async () => {
        await roomAtEpochOne();
        const mallory = await harness().enrol('mallory', 'mallory-phone');

        const commit = await postCommit(mallory, GARBAGE);
        expectStatus(commit, 403);
        expect(commit.json()).toMatchObject({ error: RelayErrorCode.NOT_A_MEMBER });
        const envelope = await postEnvelope(mallory, GARBAGE);
        expectStatus(envelope, 403);
        expect(JSON.stringify(commit.json())).not.toContain(groupIdOf(ROOM).toString('base64'));
      });

      it('answers a stale epoch 409 before it reads the header, so an honest slow client is told to rebase', async () => {
        const { alice } = await roomAtEpochOne();
        const stale = await alice.post(`/conversations/${ROOM}/handshakes`, {
          // Not the commit alice already made at that epoch: that one would be a retry, answered 200.
          ...commitBody({
            room: ROOM,
            expectedEpoch: ROOM_EPOCH - 1,
            sender: alice,
            content: 'a-rival-commit',
          }),
        });
        expectStatus(stale, 409);
        expect(stale.json()).toMatchObject({
          error: RelayErrorCode.EPOCH_CONFLICT,
          currentEpoch: ROOM_EPOCH,
        });

        // Garbage for a stale epoch is a conflict too: the header is only read for a message that
        // claims to be built on the room's real state.
        const staleGarbage = await alice.post(`/conversations/${ROOM}/handshakes`, {
          ...commitBody({ room: ROOM, expectedEpoch: ROOM_EPOCH - 1, sender: alice }),
          bytes: asBase64(GARBAGE),
        });
        expectStatus(staleGarbage, 409);
      });

      it('reads the header before the member delta, so a bad header is not reported as a bad delta', async () => {
        const { alice } = await roomAtEpochOne();
        const bob = await harness().enrol('carol', 'carol-phone');
        const reply = await alice.post(`/conversations/${ROOM}/handshakes`, {
          ...commitBody({
            room: ROOM,
            expectedEpoch: ROOM_EPOCH,
            sender: alice,
            added: [{ member: bob, keyPackageId: '00000000-0000-4000-8000-00000000dead' }],
          }),
          bytes: asBase64(GARBAGE),
        });
        await expectRefused(reply);
      });
    });
  },
);
