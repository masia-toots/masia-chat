import { RelayErrorCode } from '@masia/relay';
import { expect, it } from 'vitest';
import { type Caller, countRows, databaseSuite, expectStatus, sealed } from './support/harness.js';

const ROOM = 'room-1';
const EPOCH = 1;

databaseSuite('a resent envelope (review round 1, 2026-10-10: clientMsgId)', (harness) => {
  async function roomWithAliceAndBob(): Promise<{ alice: Caller; bob: Caller }> {
    const alice = await harness().enrol('alice', 'alice-phone');
    const bob = await harness().enrol('bob', 'bob-phone');
    await harness().createRoom(ROOM, alice);
    expectStatus(await harness().addToRoom(ROOM, alice, bob), 201);
    return { alice, bob };
  }

  function send(from: Caller, text: string, clientMsgId?: string) {
    return from.post(`/conversations/${ROOM}/envelopes`, {
      epoch: EPOCH,
      senderDeviceId: from.deviceId,
      ciphertext: sealed(ROOM, EPOCH, text),
      ...(clientMsgId === undefined ? {} : { clientMsgId }),
    });
  }

  const envelopeCount = () => countRows('SELECT count(*) AS n FROM envelopes', harness().db);

  it('is answered with its ORIGINAL seq (200) and stored once', async () => {
    const { alice } = await roomWithAliceAndBob();
    const first = await send(alice, 'hello', 'msg-1');
    expectStatus(first, 201);
    expectStatus(await send(alice, 'in between', 'msg-2'), 201);

    const retry = await send(alice, 'hello', 'msg-1');
    expectStatus(retry, 200);
    expect(retry.json()).toEqual(first.json());
    expect(await envelopeCount()).toBe(2);
  });

  it('answers simultaneous copies with one 201 and the same seq for every copy', async () => {
    const { alice } = await roomWithAliceAndBob();
    const replies = await Promise.all(
      Array.from({ length: 5 }, () => send(alice, 'hello', 'msg-1')),
    );
    expect(replies.map((reply) => reply.status).sort()).toEqual([200, 200, 200, 200, 201]);
    expect(new Set(replies.map((reply) => reply.json<{ seq: number }>().seq))).toEqual(
      new Set([1]),
    );
    expect(await envelopeCount()).toBe(1);
  });

  it('refuses a DIFFERENT message under a used clientMsgId (409 CLIENT_MSG_ID_REUSED, with the seq it names)', async () => {
    const { alice } = await roomWithAliceAndBob();
    expectStatus(await send(alice, 'hello', 'msg-1'), 201);
    const reused = await send(alice, 'something else', 'msg-1');
    expectStatus(reused, 409);
    expect(reused.json()).toMatchObject({ error: RelayErrorCode.CLIENT_MSG_ID_REUSED, seq: 1 });
    expect(await envelopeCount()).toBe(1);
  });

  it("scopes the id to its sender: another device's same id is a different message", async () => {
    const { alice, bob } = await roomWithAliceAndBob();
    expectStatus(await send(alice, 'hello', 'msg-1'), 201);
    const bobs = await send(bob, 'hello', 'msg-1');
    expectStatus(bobs, 201);
    expect(bobs.json()).toEqual({ seq: 2 });
  });

  it('stores every copy of a message sent without an id, as before (the id is optional)', async () => {
    const { alice } = await roomWithAliceAndBob();
    expectStatus(await send(alice, 'hello'), 201);
    expectStatus(await send(alice, 'hello'), 201);
    expect(await envelopeCount()).toBe(2);
  });

  it('refuses an id outside the id alphabet (400)', async () => {
    const { alice } = await roomWithAliceAndBob();
    expectStatus(await send(alice, 'hello', 'not an id!'), 400);
  });
});
