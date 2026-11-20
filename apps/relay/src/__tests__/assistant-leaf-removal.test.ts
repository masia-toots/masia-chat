import { DeviceRole, RelayErrorCode } from '@masia/relay';
import { expect, it } from 'vitest';
import {
  type Caller,
  commitBody,
  databaseSuite,
  expectStatus,
  OPERATOR,
  sealed,
} from './support/harness.js';

/**
 * How the assistant's leaf leaves a room once she is switched off there (TODO-1330, ADR-212
 * Amendment 2026-11-15). Her own device cannot do it (an MLS committer cannot remove itself, and the
 * relay takes no standalone proposal) and the server is not a member, so a person's device commits
 * the Remove. These pin the relay's half of that:
 *  - any current member may remove an ASSISTANT leaf, a child's device included: unlike a GUARDIAN
 *    leaf, it needs no admin or guardian claim, and nobody else leaves with her;
 *  - a device outside the room may not;
 *  - two members racing land ONE Remove: the loser is told to rebase (409), and on the new epoch
 *    that she is no longer a member (422 REMOVE_TARGET_NOT_MEMBER), which the hub reads as «gone»;
 *  - she cannot leave on her own: her proposal is refused and she stays a member;
 *  - from the Remove on, nothing written after it is served to her.
 */

const ROOM = 'room-1';
const ASSISTANT_DEVICE = 'assistant-room-1';

interface Receipt {
  epoch: number;
}

interface EnvelopePage {
  rows: Array<{ seq: number; epoch: number }>;
  removedAtEpoch: number | null;
}

databaseSuite('the assistant leaves a room by a member’s Remove (TODO-1330)', (harness) => {
  function send(from: Caller, epoch: number, text: string) {
    return from.post(`/conversations/${ROOM}/envelopes`, {
      epoch,
      senderDeviceId: from.deviceId,
      ciphertext: sealed(ROOM, epoch, text),
    });
  }

  /** `by` commits the Remove of the assistant's leaf on `epoch` (bytes of its own, as a real commit's are). */
  function removeAssistant(by: Caller, epoch: number, assistant: Caller) {
    return by.post(
      `/conversations/${ROOM}/handshakes`,
      commitBody({
        room: ROOM,
        expectedEpoch: epoch,
        sender: by,
        removed: [assistant],
        content: `remove by ${by.deviceId}`,
      }),
    );
  }

  /**
   * A child's room at epoch 1: the child's tablet, a guardian device of the child (driven by an
   * adult's token), another adult's phone, and the assistant's device bound to this room.
   */
  async function roomWithAssistant() {
    const kid = await harness().enrol('kid', 'kid-tablet');
    const guardian = await harness().enrol('kid', 'mum-guardian', DeviceRole.GUARDIAN, {
      guardian: 'mum',
    });
    const dad = await harness().enrol('dad', 'dad-phone');
    const assistant = await harness().enrol(OPERATOR, ASSISTANT_DEVICE, DeviceRole.ASSISTANT, {
      conversationId: ROOM,
    });
    await harness().createRoom(ROOM, kid);
    expectStatus(await harness().addToRoom(ROOM, kid, guardian, dad, assistant), 201);
    expect(await harness().roomEpoch(ROOM)).toBe(1);
    return { kid, guardian, dad, assistant };
  }

  it.each([
    ['the child’s device', 'kid'],
    ['another adult’s device, which guards and administers nobody', 'dad'],
    ['a guardian device', 'guardian'],
  ] as const)(
    '%s may commit the Remove of her leaf; she alone leaves, and nothing written after it is served to her',
    async (_label, who) => {
      const room = await roomWithAssistant();
      expectStatus(await send(room.kid, 1, 'before the switch-off'), 201); // seq 1

      const removal = await removeAssistant(room[who], 1, room.assistant);
      expectStatus(removal, 201);
      expect(removal.json<Receipt>().epoch).toBe(2);
      expectStatus(await send(room.dad, 2, 'after her leaf is gone'), 201); // seq 2

      // Her window ends at the Remove: the message before it, never the one after.
      const window = await room.assistant.get(`/conversations/${ROOM}/envelopes`);
      expectStatus(window, 200);
      expect(window.json<EnvelopePage>().rows.map((row) => row.seq)).toEqual([1]);
      expect(window.json<EnvelopePage>().removedAtEpoch).toBe(2);
      const after = await room.assistant.get(`/conversations/${ROOM}/envelopes?afterSeq=1`);
      expectStatus(after, 403);
      expect(after.json()).toMatchObject({ error: RelayErrorCode.REMOVED, removedAtEpoch: 2 });

      // Every person's device is still in, and reads the later message.
      for (const member of [room.kid, room.guardian, room.dad]) {
        const page = await member.get(`/conversations/${ROOM}/envelopes`);
        expectStatus(page, 200);
        expect(page.json<EnvelopePage>().rows.map((row) => row.seq)).toEqual([1, 2]);
        expect(page.json<EnvelopePage>().removedAtEpoch).toBeNull();
      }
    },
  );

  it('refuses a device outside the room (403 NOT_A_MEMBER), and the room does not move', async () => {
    const room = await roomWithAssistant();
    const stranger = await harness().enrol('mallory', 'mallory-phone');

    const reply = await removeAssistant(stranger, 1, room.assistant);
    expectStatus(reply, 403);
    expect(reply.json()).toMatchObject({ error: RelayErrorCode.NOT_A_MEMBER });
    expect(await harness().roomEpoch(ROOM)).toBe(1);
    expectStatus(await room.assistant.get(`/conversations/${ROOM}/envelopes`), 200);
  });

  it('lands one Remove when two members race: the loser rebases (409), then learns she is gone (422)', async () => {
    const room = await roomWithAssistant();

    expectStatus(await removeAssistant(room.kid, 1, room.assistant), 201);
    const late = await removeAssistant(room.dad, 1, room.assistant);
    expectStatus(late, 409);
    expect(late.json()).toMatchObject({ error: RelayErrorCode.EPOCH_CONFLICT, currentEpoch: 2 });

    const rebased = await removeAssistant(room.dad, 2, room.assistant);
    expectStatus(rebased, 422);
    expect(rebased.json()).toMatchObject({ error: RelayErrorCode.REMOVE_TARGET_NOT_MEMBER });
    expect(await harness().roomEpoch(ROOM)).toBe(2);

    const { rows } = await harness().db.query<{ sender: string }>(
      `SELECT sender_device_id AS sender FROM mls_handshakes
       WHERE kind = 'COMMIT' AND member_delta_json -> 'removed' ? $1`,
      [ASSISTANT_DEVICE],
    );
    expect(rows).toEqual([{ sender: 'kid-tablet' }]);
  });

  it('does not let her leave on her own: her proposal is refused (422) and she stays a member', async () => {
    const room = await roomWithAssistant();

    const proposal = await room.assistant.post(`/conversations/${ROOM}/handshakes`, {
      ...commitBody({ room: ROOM, expectedEpoch: 1, sender: room.assistant }),
      kind: 'PROPOSAL',
    });
    expectStatus(proposal, 422);
    expect(proposal.json()).toMatchObject({
      error: RelayErrorCode.HANDSHAKE_KIND_UNSUPPORTED,
      kind: 'PROPOSAL',
    });
    expect(await harness().roomEpoch(ROOM)).toBe(1);
    const still = await room.assistant.get(`/conversations/${ROOM}/envelopes`);
    expectStatus(still, 200);
    expect(still.json<EnvelopePage>().removedAtEpoch).toBeNull();
  });
});
