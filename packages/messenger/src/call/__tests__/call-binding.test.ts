/**
 * The call's fingerprint binding inside the MLS Worker (internal ADR-211 decision 4, step Д2a): who the peer may be,
 * and who else could listen.
 *
 * `K` = the MLS exporter of the two people's 1:1 room (label `masia-call-fp`, context = the callId), derived in the
 * Worker for the epoch this device holds NOW. Here a keyring hands the binding a fixed `K` and the room's members at
 * one epoch, so every rule about the peer and the badge is checked on its own. The first host runs the same two
 * operations over its real room and its Worker port in its own suites (that `K` never crosses the port).
 */
import { describe, expect, it } from 'vitest';
import { computeCallTag, type CallTagRole } from '@masia/contracts/wire';
import type { CallBindingInput } from '../call-binding-types.js';
import { CallBindingError, callTag, callVerify, type CallKeyring } from '../call-binding.js';

const CONV = 'conv-1';
const CALL = 'c0000000000000000000a1';
const fp = (byte: string) => `sha-256 ${`${byte}:`.repeat(31)}${byte}`;
const FP_A = fp('AB');
const FP_B = fp('CD');

function input(over: Partial<CallBindingInput> = {}): CallBindingInput {
  return {
    conversationId: CONV,
    callId: CALL,
    callerDeviceId: 'dev-a',
    calleeDeviceId: 'dev-b',
    fingerprintCaller: FP_A,
    fingerprintCallee: FP_B,
    ...over,
  };
}

const as = (role: CallTagRole, over: Partial<CallBindingInput> = {}) => ({ ...input(over), role });

const ROLE = { USER: 'USER', GUARDIAN: 'GUARDIAN', ASSISTANT: 'ASSISTANT' } as const;
type Member = { userId: string; deviceId: string; role: (typeof ROLE)[keyof typeof ROLE] };
const ALICE_PHONE: Member = { userId: 'alice', deviceId: 'dev-a', role: ROLE.USER };
const BOB_PHONE: Member = { userId: 'bob', deviceId: 'dev-b', role: ROLE.USER };
/** A room's `K` at a fixed epoch, held by whichever members the test names. */
const ROOM_KEY = new Uint8Array(32).fill(7);
function roomOf(selfUserId: string, selfDeviceId: string, members: readonly Member[]): CallKeyring {
  return {
    selfUserId,
    selfDeviceId,
    // A copy per question: the binding wipes the key it was handed.
    key: async () => ({ key: ROOM_KEY.slice(), epoch: 4, members }),
  };
}
/** A tag as ANY member device holding `K` can compute it — naming whichever devices it likes. */
const forged = (role: CallTagRole, over: Partial<CallBindingInput> = {}) => {
  const b = input(over);
  return computeCallTag(ROOM_KEY, role, {
    callId: b.callId,
    callerDeviceId: b.callerDeviceId,
    calleeDeviceId: b.calleeDeviceId,
    fingerprintCaller: b.fingerprintCaller,
    fingerprintCallee: b.fingerprintCallee,
  });
};

/**
 * Review of step Д2a, finding 2: the tag proves "a member device of this room holds K", not "the person on the
 * screen". The Worker also requires the peer device to be the ONE other person's own device — role USER, not this
 * person, and a room that holds exactly one other person — and names that person in the verdict.
 */
describe('call binding: the peer is the other person of the room, on a device of their own', () => {
  it('a verified peer is named: the user the group holds that device for', async () => {
    const alice = roomOf('alice', 'dev-a', [ALICE_PHONE, BOB_PHONE]);
    const bob = roomOf('bob', 'dev-b', [ALICE_PHONE, BOB_PHONE]);
    expect(await callVerify(alice, { ...as('caller'), receivedTag: await forged('callee') })).toMatchObject({
      ok: true,
      peerUserId: 'bob',
    });
    expect(await callVerify(bob, { ...as('callee'), receivedTag: await forged('caller') })).toMatchObject({
      ok: true,
      peerUserId: 'alice',
    });
  });

  it('the assistant\'s device on the other end is refused, with the right K', async () => {
    const members = [ALICE_PHONE, BOB_PHONE, { userId: 'assistant', deviceId: 'dev-masia', role: ROLE.ASSISTANT }];
    const alice = roomOf('alice', 'dev-a', members);
    const named = { calleeDeviceId: 'dev-masia' };
    await expect(callTag(alice, as('caller', named))).rejects.toBeInstanceOf(CallBindingError);
    expect(await callVerify(alice, { ...as('caller', named), receivedTag: await forged('callee', named) })).toMatchObject({
      ok: false,
      peerUserId: null,
    });
  });

  it('a guardian device on the other end is refused — it carries the child\'s user id, so a user check alone would pass', async () => {
    // A guardian device is enrolled on the minor's account: its leaf names the child, with role GUARDIAN.
    const members = [ALICE_PHONE, BOB_PHONE, { userId: 'bob', deviceId: 'dev-guardian', role: ROLE.GUARDIAN }];
    const alice = roomOf('alice', 'dev-a', members);
    const named = { calleeDeviceId: 'dev-guardian' };
    await expect(callTag(alice, as('caller', named))).rejects.toBeInstanceOf(CallBindingError);
    expect((await callVerify(alice, { ...as('caller', named), receivedTag: await forged('callee', named) })).ok).toBe(false);
  });

  it('my own other device on the other end is refused', async () => {
    const members = [ALICE_PHONE, BOB_PHONE, { userId: 'alice', deviceId: 'dev-a2', role: ROLE.USER }];
    const alice = roomOf('alice', 'dev-a', members);
    const named = { calleeDeviceId: 'dev-a2' };
    await expect(callTag(alice, as('caller', named))).rejects.toBeInstanceOf(CallBindingError);
    expect((await callVerify(alice, { ...as('caller', named), receivedTag: await forged('callee', named) })).ok).toBe(false);
  });

  it('a room that holds a third person is not a 1:1 room: refused even for the other person\'s real device', async () => {
    const members = [ALICE_PHONE, BOB_PHONE, { userId: 'carol', deviceId: 'dev-c', role: ROLE.USER }];
    const alice = roomOf('alice', 'dev-a', members);
    await expect(callTag(alice, as('caller'))).rejects.toBeInstanceOf(CallBindingError);
    const verdict = await callVerify(alice, { ...as('caller'), receivedTag: await forged('callee') });
    expect(verdict).toMatchObject({ ok: false, peerUserId: null });
    expect(verdict.others).toEqual([{ deviceId: 'dev-c', userId: 'carol', kind: 'other' }]);
  });

  it('the other person\'s second device may be the one that answered', async () => {
    const members = [ALICE_PHONE, BOB_PHONE, { userId: 'bob', deviceId: 'dev-b2', role: ROLE.USER }];
    const alice = roomOf('alice', 'dev-a', members);
    const named = { calleeDeviceId: 'dev-b2' };
    expect(await callVerify(alice, { ...as('caller', named), receivedTag: await forged('callee', named) })).toMatchObject({
      ok: true,
      peerUserId: 'bob',
      others: [{ deviceId: 'dev-b', userId: 'bob', kind: 'theirs' }],
    });
  });

  it('a peer device the group does not hold (yet) is no verdict, but no refusal of the tag either: catching up may add it', async () => {
    const alice = roomOf('alice', 'dev-a', [ALICE_PHONE, BOB_PHONE]);
    const named = { calleeDeviceId: 'dev-b-new' };
    await expect(callTag(alice, as('caller', named))).resolves.toMatchObject({ epoch: 4 });
    expect(await callVerify(alice, { ...as('caller', named), receivedTag: await forged('callee', named) })).toMatchObject({
      ok: false,
      peerUserId: null,
    });
  });
});

/**
 * ADR-211 decision 5: any OTHER member device of the room can derive `K` and sit in the middle, so the call badge
 * lists every member device of the room apart from the two that are talking, by kind — read from the same group,
 * at the same epoch, as the key that checked the tag.
 */
describe('call binding: who else could listen (the badge)', () => {
  // Bob is a minor here: his guardian's device holds a seat on HIS account (role GUARDIAN, his user id).
  const CROWD: readonly Member[] = [
    ALICE_PHONE,
    { userId: 'alice', deviceId: 'dev-a2', role: ROLE.USER },
    BOB_PHONE,
    { userId: 'bob', deviceId: 'dev-b-tablet', role: ROLE.USER },
    { userId: 'bob', deviceId: 'dev-guardian', role: ROLE.GUARDIAN },
    { userId: 'masia', deviceId: 'dev-masia', role: ROLE.ASSISTANT },
  ];
  const EXPECTED_FOR_ALICE = [
    { deviceId: 'dev-a2', userId: 'alice', kind: 'mine' },
    { deviceId: 'dev-b-tablet', userId: 'bob', kind: 'theirs' },
    { deviceId: 'dev-guardian', userId: 'bob', kind: 'guardian' },
    { deviceId: 'dev-masia', userId: 'masia', kind: 'assistant' },
  ];

  it('both answers carry every other member device, by kind, never the two that talk', async () => {
    const alice = roomOf('alice', 'dev-a', CROWD);
    const tag = await callTag(alice, as('caller'));
    expect(tag.others).toEqual(EXPECTED_FOR_ALICE);
    const verdict = await callVerify(alice, { ...as('caller'), receivedTag: 'A'.repeat(43) });
    expect(verdict.others).toEqual(EXPECTED_FOR_ALICE);
  });

  it('"mine" and "theirs" are from this device\'s side', async () => {
    const bob = roomOf('bob', 'dev-b', CROWD);
    const kinds = (await callTag(bob, as('callee'))).others.map((o) => [o.deviceId, o.kind]);
    expect(kinds).toEqual([
      ['dev-a2', 'theirs'],
      ['dev-b-tablet', 'mine'],
      ['dev-guardian', 'guardian'],
      ['dev-masia', 'assistant'],
    ]);
  });
});
