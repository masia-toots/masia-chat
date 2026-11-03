import { RelayErrorCode } from '@masia/relay';
import { describe, expect, it } from 'vitest';
import { type Caller, commitBody, databaseSuite, expectStatus, sealed } from './support/harness.js';

const ROOM = 'room-1';
/** bob is added by the commit at epoch 0 (joins in 1) and removed by the commit at epoch 1. */
const REMOVED_AT_EPOCH = 2;

interface SequencedPage<Row> {
  rows: Row[];
  nextCursor: string | null;
  oldestAvailableSeq: number;
  removedAtEpoch: number | null;
}

interface HandshakeRow {
  seq: number;
  epoch: number;
  kind: string;
  memberDelta: { removed: string[] } | null;
}

databaseSuite(
  'a removed device (review round 1, 2026-10-10: it reads up to its removal, then REMOVED)',
  (harness) => {
    function send(from: Caller, epoch: number, text: string) {
      return from.post(`/conversations/${ROOM}/envelopes`, {
        epoch,
        senderDeviceId: from.deviceId,
        ciphertext: sealed(ROOM, epoch, text),
      });
    }

    /** alice and bob talk at epoch 1, alice removes bob, and alice goes on talking without him. */
    async function bobRemovedMidConversation(): Promise<{ alice: Caller; bob: Caller }> {
      const alice = await harness().enrol('alice', 'alice-phone');
      const bob = await harness().enrol('bob', 'bob-phone');
      await harness().createRoom(ROOM, alice);
      expectStatus(await harness().addToRoom(ROOM, alice, bob), 201);
      expectStatus(await send(bob, 1, 'bob, while a member'), 201); // seq 1
      expectStatus(await send(alice, 1, 'alice, while bob is a member'), 201); // seq 2
      const removal = await alice.post(
        `/conversations/${ROOM}/handshakes`,
        commitBody({ room: ROOM, expectedEpoch: 1, sender: alice, removed: [bob] }),
      );
      expectStatus(removal, 201);
      expectStatus(await send(alice, REMOVED_AT_EPOCH, 'alice, after bob left'), 201); // seq 3
      expectStatus(
        await alice.post(
          `/conversations/${ROOM}/handshakes`,
          commitBody({
            room: ROOM,
            expectedEpoch: REMOVED_AT_EPOCH,
            sender: alice,
            content: 'a later commit',
          }),
        ),
        201,
      );
      return { alice, bob };
    }

    it('still reads every envelope of the epochs it was a member in, and is told where its window ends', async () => {
      const { bob } = await bobRemovedMidConversation();
      const reply = await bob.get(`/conversations/${ROOM}/envelopes`);
      expectStatus(reply, 200);
      const page = reply.json<SequencedPage<{ seq: number; epoch: number }>>();
      expect(page.rows.map((row) => [row.seq, row.epoch])).toEqual([
        [1, 1],
        [2, 1],
      ]);
      expect(page.removedAtEpoch).toBe(REMOVED_AT_EPOCH);
    });

    it('reads the commit that removed it (so it can process its own removal), and no later handshake', async () => {
      const { bob } = await bobRemovedMidConversation();
      const reply = await bob.get(`/conversations/${ROOM}/handshakes`);
      expectStatus(reply, 200);
      const page = reply.json<SequencedPage<HandshakeRow>>();
      const last = page.rows[page.rows.length - 1];
      expect(last).toMatchObject({ kind: 'COMMIT', epoch: REMOVED_AT_EPOCH - 1 });
      expect(last?.memberDelta?.removed).toEqual(['bob-phone']);
      expect(page.rows.every((row) => row.epoch < REMOVED_AT_EPOCH)).toBe(true);
      expect(page.removedAtEpoch).toBe(REMOVED_AT_EPOCH);
    });

    it('gets 403 REMOVED (with removedAtEpoch) once it has read its window, instead of an empty page for ever', async () => {
      const { bob } = await bobRemovedMidConversation();
      const envelopes = await bob.get(`/conversations/${ROOM}/envelopes?afterSeq=2`);
      expectStatus(envelopes, 403);
      expect(envelopes.json()).toMatchObject({
        error: RelayErrorCode.REMOVED,
        removedAtEpoch: REMOVED_AT_EPOCH,
      });

      const all = (await bob.get(`/conversations/${ROOM}/handshakes`)).json<
        SequencedPage<HandshakeRow>
      >();
      const handshakes = await bob.get(
        `/conversations/${ROOM}/handshakes?afterSeq=${all.rows[all.rows.length - 1]?.seq}`,
      );
      expectStatus(handshakes, 403);
      expect(handshakes.json()).toMatchObject({
        error: RelayErrorCode.REMOVED,
        removedAtEpoch: REMOVED_AT_EPOCH,
      });
    });

    describe('may no longer write', () => {
      it('refuses its envelope and its commit with 403 REMOVED, a code distinct from a stranger', async () => {
        const { bob } = await bobRemovedMidConversation();
        const envelope = await send(bob, REMOVED_AT_EPOCH + 1, 'bob, after removal');
        expectStatus(envelope, 403);
        expect(envelope.json()).toMatchObject({
          error: RelayErrorCode.REMOVED,
          removedAtEpoch: REMOVED_AT_EPOCH,
        });
        const commit = await bob.post(
          `/conversations/${ROOM}/handshakes`,
          commitBody({ room: ROOM, expectedEpoch: REMOVED_AT_EPOCH + 1, sender: bob }),
        );
        expectStatus(commit, 403);
        expect(commit.json()).toMatchObject({ error: RelayErrorCode.REMOVED });
      });

      it('answers a device that was never a member with NOT_A_MEMBER, reads and writes alike', async () => {
        await bobRemovedMidConversation();
        const mallory = await harness().enrol('mallory', 'mallory-phone');
        for (const reply of [
          await mallory.get(`/conversations/${ROOM}/envelopes`),
          await mallory.get(`/conversations/${ROOM}/handshakes`),
          await send(mallory, REMOVED_AT_EPOCH + 1, 'mallory'),
        ]) {
          expectStatus(reply, 403);
          expect(reply.json()).toMatchObject({ error: RelayErrorCode.NOT_A_MEMBER });
        }
      });
    });
  },
);
