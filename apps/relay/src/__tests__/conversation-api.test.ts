import { MAX_ENVELOPE_BYTES, RelayErrorCode } from '@masia/relay';
import { buildPrivateMessageOfSize, MlsContentType } from '@masia/relay/testing';
import { expect, it } from 'vitest';
import { type Caller, b64, commitBody, databaseSuite, expectStatus, groupIdOf, sealed } from './support/harness.js';

const ROOM = 'room-1';

interface EnvelopeBody {
  seq: number;
  epoch: number;
  senderDeviceId: string;
  ciphertext: string;
}
interface EnvelopePage {
  rows: EnvelopeBody[];
  nextCursor: string | null;
}

function send(from: Caller, epoch: number, text: string) {
  return from.post(`/conversations/${ROOM}/envelopes`, {
    epoch,
    senderDeviceId: from.deviceId,
    // A real PrivateMessage header for this room and epoch, with `text` standing in for the sealed body.
    ciphertext: sealed(ROOM, epoch, text),
  });
}

databaseSuite('envelopes', (harness) => {
  it('stores ciphertext for a member at the current epoch (201) and serves it back unchanged', async () => {
    const alice = await harness().enrol('alice', 'alice-phone');
    const bob = await harness().enrol('bob', 'bob-phone');
    await harness().createRoom(ROOM, alice);
    expectStatus(await harness().addToRoom(ROOM, alice, bob), 201); // epoch 1

    const stored = await send(alice, 1, 'sealed-hello');
    expectStatus(stored, 201);
    expect(stored.json()).toEqual({ seq: 1 });
    expectStatus(await send(bob, 1, 'sealed-hi-back'), 201);

    const page = (await bob.get(`/conversations/${ROOM}/envelopes`)).json<EnvelopePage>();
    expect(page.rows).toMatchObject([
      { seq: 1, epoch: 1, senderDeviceId: 'alice-phone', ciphertext: sealed(ROOM, 1, 'sealed-hello') },
      { seq: 2, epoch: 1, senderDeviceId: 'bob-phone', ciphertext: sealed(ROOM, 1, 'sealed-hi-back') },
    ]);
    expect(page.nextCursor).toBeNull();
  });

  it('answers 409 with the current epoch when the envelope was encrypted for a stale epoch', async () => {
    const alice = await harness().enrol('alice', 'alice-phone');
    const bob = await harness().enrol('bob', 'bob-phone');
    await harness().createRoom(ROOM, alice);
    expectStatus(await harness().addToRoom(ROOM, alice, bob), 201); // epoch 1

    const stale = await send(alice, 0, 'sealed-for-the-old-group');
    expectStatus(stale, 409);
    expect(stale.json()).toMatchObject({ error: RelayErrorCode.EPOCH_CONFLICT, currentEpoch: 1 });
    const early = await send(alice, 2, 'sealed-for-a-future-group');
    expectStatus(early, 409);
    // Nothing was stored.
    expect((await alice.get(`/conversations/${ROOM}/envelopes`)).json<EnvelopePage>().rows).toEqual([]);
  });

  it('refuses a device that is not a member, for reading and for writing (403)', async () => {
    const alice = await harness().enrol('alice', 'alice-phone');
    const mallory = await harness().enrol('mallory', 'mallory-phone');
    await harness().createRoom(ROOM, alice);
    expectStatus(await send(alice, 0, 'sealed-secret'), 201);

    const read = await mallory.get(`/conversations/${ROOM}/envelopes`);
    expectStatus(read, 403);
    expect(read.json()).toMatchObject({ error: RelayErrorCode.NOT_A_MEMBER });
    expectStatus(await send(mallory, 0, 'sealed-spam'), 403);

    // A room that does not exist looks exactly like a room you are not in.
    const missing = await mallory.get('/conversations/no-such-room/envelopes');
    expectStatus(missing, 403);
    expect(missing.json()).toEqual(read.json());
  });

  it('stops serving a removed device, for reading and writing', async () => {
    const alice = await harness().enrol('alice', 'alice-phone');
    const bob = await harness().enrol('bob', 'bob-phone');
    await harness().createRoom(ROOM, alice);
    expectStatus(await harness().addToRoom(ROOM, alice, bob), 201);
    expectStatus(await bob.get(`/conversations/${ROOM}/envelopes`), 200);

    expectStatus(
      await alice.post(`/conversations/${ROOM}/handshakes`, commitBody({ room: ROOM, expectedEpoch: 1, sender: alice, removed: [bob] })),
      201,
    );
    expectStatus(await bob.get(`/conversations/${ROOM}/envelopes`), 403);
    expectStatus(await send(bob, 2, 'sealed-after-removal'), 403);
  });

  it('refuses a sender id that is not the token\'s device (403)', async () => {
    const alice = await harness().enrol('alice', 'alice-phone');
    const bob = await harness().enrol('bob', 'bob-phone');
    await harness().createRoom(ROOM, alice);
    expectStatus(await harness().addToRoom(ROOM, alice, bob), 201);

    const forged = await bob.post(`/conversations/${ROOM}/envelopes`, {
      epoch: 1,
      senderDeviceId: 'alice-phone',
      ciphertext: sealed(ROOM, 1, 'sealed-as-alice'),
    });
    expectStatus(forged, 403);
    expect(forged.json()).toMatchObject({ error: RelayErrorCode.DEVICE_MISMATCH });
  });

  it('gives a device that joined later only the envelopes from the epoch it joined in', async () => {
    const alice = await harness().enrol('alice', 'alice-phone');
    const carol = await harness().enrol('carol', 'carol-phone');
    await harness().createRoom(ROOM, alice);
    expectStatus(await send(alice, 0, 'sealed-before-carol'), 201);
    expectStatus(await harness().addToRoom(ROOM, alice, carol), 201); // carol joins in epoch 1
    expectStatus(await send(alice, 1, 'sealed-after-carol'), 201);

    const forCarol = (await carol.get(`/conversations/${ROOM}/envelopes`)).json<EnvelopePage>();
    expect(forCarol.rows.map((row) => row.ciphertext)).toEqual([sealed(ROOM, 1, 'sealed-after-carol')]);
    const forAlice = (await alice.get(`/conversations/${ROOM}/envelopes`)).json<EnvelopePage>();
    expect(forAlice.rows).toHaveLength(2);
  });

  it('pages with afterSeq and limit, and hands out the cursor only while more rows follow', async () => {
    const alice = await harness().enrol('alice', 'alice-phone');
    await harness().createRoom(ROOM, alice);
    for (const text of ['sealed-one', 'sealed-two', 'sealed-three']) expectStatus(await send(alice, 0, text), 201);

    const first = (await alice.get(`/conversations/${ROOM}/envelopes?limit=2`)).json<EnvelopePage>();
    expect(first.rows.map((row) => row.seq)).toEqual([1, 2]);
    expect(first.nextCursor).toBe('2');

    const second = (await alice.get(`/conversations/${ROOM}/envelopes?limit=2&afterSeq=${first.nextCursor}`)).json<EnvelopePage>();
    expect(second.rows.map((row) => row.seq)).toEqual([3]);
    expect(second.nextCursor).toBeNull();
  });

  it('numbers simultaneous envelopes without gaps or repeats', async () => {
    const alice = await harness().enrol('alice', 'alice-phone');
    await harness().createRoom(ROOM, alice);

    const replies = await Promise.all(Array.from({ length: 12 }, (_, index) => send(alice, 0, `sealed-${index}`)));
    replies.forEach((reply) => expectStatus(reply, 201));
    const seqs = replies.map((reply) => reply.json<{ seq: number }>().seq).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: 12 }, (_, index) => index + 1));
  });

  it('takes ciphertext of exactly the size limit and refuses one byte more (a schema alone cannot say "N bytes")', async () => {
    const alice = await harness().enrol('alice', 'alice-phone');
    await harness().createRoom(ROOM, alice);
    // A PrivateMessage of exactly `size` bytes, so only the size limit (not the header check) can refuse it.
    const envelope = (size: number) => ({
      epoch: 0,
      senderDeviceId: 'alice-phone',
      ciphertext: buildPrivateMessageOfSize(
        { groupId: groupIdOf(ROOM), epoch: 0, contentType: MlsContentType.APPLICATION },
        size,
      ).toString('base64'),
    });

    expectStatus(await alice.post(`/conversations/${ROOM}/envelopes`, envelope(MAX_ENVELOPE_BYTES)), 201);
    expectStatus(await alice.post(`/conversations/${ROOM}/envelopes`, envelope(MAX_ENVELOPE_BYTES + 1)), 400);
  });

  it.each([
    ['ciphertext that is not base64', { epoch: 0, senderDeviceId: 'alice-phone', ciphertext: 'not base64 !!' }],
    ['ciphertext over the size limit', { epoch: 0, senderDeviceId: 'alice-phone', ciphertext: Buffer.alloc(MAX_ENVELOPE_BYTES + 1).toString('base64') }],
    ['a negative epoch', { epoch: -1, senderDeviceId: 'alice-phone', ciphertext: b64('sealed') }],
    ['an epoch beyond the column', { epoch: 2 ** 40, senderDeviceId: 'alice-phone', ciphertext: b64('sealed') }],
    ['a plaintext field', { epoch: 0, senderDeviceId: 'alice-phone', ciphertext: b64('sealed'), text: 'hello' }],
  ])('rejects %s (400)', async (_label, body) => {
    const alice = await harness().enrol('alice', 'alice-phone');
    await harness().createRoom(ROOM, alice);
    expectStatus(await alice.post(`/conversations/${ROOM}/envelopes`, body), 400);
  });
});

databaseSuite('reading the handshake log', (harness) => {
  it('serves the log to members, in order, from a given epoch', async () => {
    const alice = await harness().enrol('alice', 'alice-phone');
    const bob = await harness().enrol('bob', 'bob-phone');
    await harness().createRoom(ROOM, alice);
    expectStatus(await harness().addToRoom(ROOM, alice, bob), 201); // seq 1, built on epoch 0
    expectStatus(await alice.post(`/conversations/${ROOM}/handshakes`, commitBody({ room: ROOM, expectedEpoch: 1, sender: alice })), 201); // seq 2
    expectStatus(await alice.post(`/conversations/${ROOM}/handshakes`, commitBody({ room: ROOM, expectedEpoch: 2, sender: alice })), 201); // seq 3

    const all = (await alice.get(`/conversations/${ROOM}/handshakes`)).json<{ rows: Array<{ seq: number; epoch: number }> }>();
    expect(all.rows.map((row) => [row.seq, row.epoch])).toEqual([[1, 0], [2, 1], [3, 2]]);

    const fromTwo = (await alice.get(`/conversations/${ROOM}/handshakes?fromEpoch=2`)).json<{ rows: Array<{ seq: number }> }>();
    expect(fromTwo.rows.map((row) => row.seq)).toEqual([3]);
  });

  it('never shows a device the log from before the epoch that added it (except the commit that added it)', async () => {
    const alice = await harness().enrol('alice', 'alice-phone');
    const bob = await harness().enrol('bob', 'bob-phone');
    const carol = await harness().enrol('carol', 'carol-phone');
    await harness().createRoom(ROOM, alice);
    expectStatus(await harness().addToRoom(ROOM, alice, bob), 201); // seq 1, epoch label 0
    expectStatus(await alice.post(`/conversations/${ROOM}/handshakes`, commitBody({ room: ROOM, expectedEpoch: 1, sender: alice })), 201); // seq 2, label 1
    expectStatus(await harness().addToRoom(ROOM, alice, carol), 201); // seq 3, label 2; carol joins in epoch 3

    const forCarol = (await carol.get(`/conversations/${ROOM}/handshakes?fromEpoch=0`)).json<{ rows: Array<{ seq: number }> }>();
    expect(forCarol.rows.map((row) => row.seq)).toEqual([3]);
  });

  it('refuses a non-member (403)', async () => {
    const alice = await harness().enrol('alice', 'alice-phone');
    const mallory = await harness().enrol('mallory', 'mallory-phone');
    await harness().createRoom(ROOM, alice);
    const reply = await mallory.get(`/conversations/${ROOM}/handshakes`);
    expectStatus(reply, 403);
    expect(reply.json()).toMatchObject({ error: RelayErrorCode.NOT_A_MEMBER });
  });
});

databaseSuite('revoking a device that is in a room (ADR-117 §5a: Remove, then revoke)', (harness) => {
  it('says 409 STILL_IN_ROOMS while the device is a member, and 200 once MLS Remove was committed', async () => {
    const alice = await harness().enrol('alice', 'alice-phone');
    const phone = await harness().enrol('bob', 'bob-phone');
    const tablet = await harness().enrol('bob', 'bob-tablet');
    await harness().createRoom(ROOM, alice);
    expectStatus(await harness().addToRoom(ROOM, alice, phone), 201);
    expectStatus(await harness().addToRoom(ROOM, alice, tablet), 201); // epoch 2

    const early = await phone.post('/devices/bob-tablet/revoke');
    expectStatus(early, 409);
    expect(early.json()).toMatchObject({ error: RelayErrorCode.STILL_IN_ROOMS, rooms: 1 });

    expectStatus(
      await alice.post(`/conversations/${ROOM}/handshakes`, commitBody({ room: ROOM, expectedEpoch: 2, sender: alice, removed: [tablet] })),
      201,
    );
    expectStatus(await phone.post('/devices/bob-tablet/revoke'), 200);
  });

  it('holds for a family admin too', async () => {
    const alice = await harness().enrol('alice', 'alice-phone');
    const bob = await harness().enrol('bob', 'bob-phone');
    await harness().enrol('dad', 'dad-phone');
    await harness().createRoom(ROOM, alice);
    expectStatus(await harness().addToRoom(ROOM, alice, bob), 201);

    const admin = await harness().caller({ userId: 'dad', deviceId: 'dad-phone' }, { adminOf: ['bob'] });
    expectStatus(await admin.post('/devices/bob-phone/revoke'), 409);
  });

  it('cannot be raced: a device added while being revoked ends up either not added or not revoked', async () => {
    const alice = await harness().enrol('alice', 'alice-phone');
    const phone = await harness().enrol('bob', 'bob-phone');
    const tablet = await harness().enrol('bob', 'bob-tablet');
    await harness().createRoom(ROOM, alice);

    const [added, revoked] = await Promise.all([
      harness().addToRoom(ROOM, alice, phone),
      tablet.post('/devices/bob-phone/revoke'),
    ]);

    const { rows } = await harness().db.query<{ revoked: boolean; member: boolean }>(
      `SELECT d.revoked_at IS NOT NULL AS revoked,
              EXISTS (SELECT 1 FROM room_members m WHERE m.device_id = d.id AND m.removed_at_epoch IS NULL) AS member
       FROM devices d WHERE d.id = 'bob-phone'`,
    );
    // Never both: a revoked device inside a room is exactly the state the rule exists to prevent.
    expect(rows[0]?.revoked === true && rows[0]?.member === true).toBe(false);
    expect([added.status, revoked.status].some((status) => status === 201 || status === 200)).toBe(true);
  });
});
