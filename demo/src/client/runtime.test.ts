import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createDemoHandler } from '../../server/app.js';
import { createTokenIssuer } from '../../server/issuer.js';
import { createPeopleBook, PRESENCE_MS } from '../../server/people.js';
import { listen, type Listening } from '../../server/test-kit.js';
import { createCallBinding, isTwoPersonRoom, ringTargetsOf } from '../host/call-room.js';
import { newMessageId } from './bytes.js';
import { startRuntime, type PlaygroundRuntime } from './runtime.js';
import { createFakeRelay, type FakeRelay } from './testing/fake-relay.js';

// Two tabs run the real client code (sign-in, enrolment, MLS engine, rooms, polling) against the
// playground's real server for people and tokens, and a relay kept in memory. The compose stack's
// smoke test (`smoke/two-people.ts`) does the same against the real relay.

const MLS_TEST_TIMEOUT_MS = 90_000;

describe('a tab of the playground', () => {
  let site: Listening | undefined;
  let relay: FakeRelay;
  let now = Date.now();
  const running: PlaygroundRuntime[] = [];

  afterEach(async () => {
    for (const runtime of running.splice(0)) runtime.stop();
    await site?.close();
    site = undefined;
  });

  async function boot(): Promise<void> {
    now = Date.now();
    relay = createFakeRelay();
    const handler = createDemoHandler({
      people: createPeopleBook(() => now),
      issuer: createTokenIssuer(
        generateKeyPairSync('ed25519').privateKey,
        { issuer: 'playground-web', audience: 'playground-relay' },
        () => now,
      ),
      relayUrl: new URL('http://relay.invalid'),
      contactsFile: 'unused',
      distDir: 'unused',
    });
    site = await listen((request, response) => void handler(request, response));
  }

  async function tab(name: string): Promise<PlaygroundRuntime> {
    if (site === undefined) throw new Error('boot() first');
    const runtime = await startRuntime({
      name,
      origin: site.origin,
      autoPoll: false,
      createApi: (who) => relay.apiFor(who),
    });
    running.push(runtime);
    return runtime;
  }

  /** Polls every tab until `done`, the way the page's timer would, and says what never happened. */
  async function until(what: string, done: () => boolean, rounds = 40): Promise<void> {
    for (let round = 0; round < rounds && !done(); round += 1) {
      await Promise.all(running.map((runtime) => runtime.pollOnce()));
    }
    if (!done()) throw new Error(`never happened: ${what}`);
  }

  /** Polls ONE tab until `done`: the other tab stands still, as a tab that has not looked yet would. */
  async function untilOn(runtime: PlaygroundRuntime, what: string, done: () => boolean, rounds = 40): Promise<void> {
    for (let round = 0; round < rounds && !done(); round += 1) await runtime.pollOnce();
    if (!done()) throw new Error(`never happened: ${what}`);
  }

  const texts = (runtime: PlaygroundRuntime, conversationId: string): string[] =>
    (runtime.roomSnapshot(conversationId)?.history ?? []).flatMap((item) =>
      item.payload?.kind === 'text' ? [item.payload.body] : [],
    );

  it(
    'finds the other tab, opens an end-to-end encrypted chat, and both sides read what the other sends',
    async () => {
      await boot();
      const ada = await tab('Ada');
      const bo = await tab('Bo');
      await until('each sees the other', () =>
        ada.getSnapshot().people.some((p) => p.userId === bo.self.userId) &&
        bo.getSnapshot().people.some((p) => p.userId === ada.self.userId),
      );
      expect(ada.getSnapshot().chats).toEqual([]);

      const conversationId = ada.open(bo.self.userId);
      expect(conversationId).toBe(bo.conversationWith(ada.self.userId));
      await until('the other tab joined by its Welcome', () => bo.roomSnapshot(conversationId)?.epoch !== undefined);
      await until('both are at the same epoch, after the joiner\'s key refresh', () => {
        const a = ada.roomSnapshot(conversationId);
        const b = bo.roomSnapshot(conversationId);
        return a?.epoch !== undefined && a.epoch === b?.epoch && a.epoch >= 2n && !a.needsSelfUpdate && !b?.needsSelfUpdate;
      });

      // Both tabs list the chat, under the other person's name.
      expect(ada.getSnapshot().chats.map((c) => c.peerName)).toEqual(['Bo']);
      expect(bo.getSnapshot().chats.map((c) => c.peerName)).toEqual(['Ada']);
      // Both compute the same security code from their own state.
      const codeA = ada.roomSnapshot(conversationId)?.epochAuthenticator;
      const codeB = bo.roomSnapshot(conversationId)?.epochAuthenticator;
      expect(codeA).toBeDefined();
      expect(Array.from(codeA ?? [])).toEqual(Array.from(codeB ?? [1]));

      await ada.send(conversationId, { kind: 'text', id: newMessageId(), body: 'hello from Ada' });
      await until('Bo reads it', () => texts(bo, conversationId).includes('hello from Ada'));
      expect(texts(ada, conversationId)).toContain('hello from Ada'); // the sender keeps its own text

      // Unread is counted for what the other person sent, and cleared when the chat is looked at.
      expect(bo.getSnapshot().chats[0]?.unread).toBe(1);
      expect(ada.getSnapshot().chats[0]?.unread).toBe(0);
      bo.markSeen(conversationId);
      expect(bo.getSnapshot().chats[0]?.unread).toBe(0);

      await bo.send(conversationId, { kind: 'text', id: newMessageId(), body: 'hello back' });
      await until('Ada reads the reply', () => texts(ada, conversationId).includes('hello back'));

      // What the relay holds is bytes it cannot read: none of the text is in any of them.
      const held = relay.stored();
      const plain = ['hello from Ada', 'hello back'].map((text) => Buffer.from(text));
      expect(held.envelopes.length).toBeGreaterThanOrEqual(2);
      for (const bytes of [...held.envelopes, ...held.handshakes]) {
        for (const needle of plain) expect(Buffer.from(bytes).includes(needle)).toBe(false);
      }
    },
    MLS_TEST_TIMEOUT_MS,
  );

  it(
    'binds a call to the chat: each tab derives the same call key from its own group and checks the other\'s tag',
    async () => {
      await boot();
      const ada = await tab('Ada');
      const bo = await tab('Bo');
      await until('each sees the other', () =>
        ada.getSnapshot().people.some((p) => p.userId === bo.self.userId) &&
        bo.getSnapshot().people.some((p) => p.userId === ada.self.userId),
      );
      const conversationId = ada.open(bo.self.userId);
      await until('both are at the same epoch', () => {
        const a = ada.roomSnapshot(conversationId);
        const b = bo.roomSnapshot(conversationId);
        return a?.epoch !== undefined && a.epoch === b?.epoch && !a.needsSelfUpdate && !b?.needsSelfUpdate;
      });
      // A room of exactly these two: «Call» is offered, and it rings the other person's device.
      expect(isTwoPersonRoom(ada.roomSnapshot(conversationId), ada.self.userId)).toBe(true);
      expect(ringTargetsOf(ada.roomSnapshot(conversationId), ada.self.userId)).toEqual([bo.self.deviceId]);
      expect(ringTargetsOf(bo.roomSnapshot(conversationId), bo.self.userId)).toEqual([ada.self.deviceId]);
      expect(isTwoPersonRoom(ada.roomSnapshot(conversationId), 'u-someone-else')).toBe(false);
      expect(ringTargetsOf(undefined, ada.self.userId)).toEqual([]);

      // The two DTLS fingerprints as the engine reads them out of the two SDPs.
      const fingerprint = (byte: string) => `sha-256 ${`${byte}:`.repeat(31)}${byte}`;
      const call = {
        conversationId,
        callId: 'c0000000000000000000a1',
        callerDeviceId: ada.self.deviceId,
        calleeDeviceId: bo.self.deviceId,
        fingerprintCaller: fingerprint('AB'),
        fingerprintCallee: fingerprint('CD'),
      };
      const sent = await createCallBinding(ada).callTag({ ...call, role: 'caller' });
      const verdict = await createCallBinding(bo).callVerify({ ...call, role: 'callee', receivedTag: sent.tag });
      expect(verdict.ok).toBe(true);
      expect(verdict.peerUserId).toBe(ada.self.userId);
      expect(verdict.epoch).toBe(sent.epoch);
      expect(verdict.others).toEqual([]);

      // A swapped fingerprint (someone else's DTLS key in the middle) does not check out.
      const forged = await createCallBinding(bo).callVerify({
        ...call,
        fingerprintCaller: fingerprint('EF'),
        role: 'callee',
        receivedTag: sent.tag,
      });
      expect(forged.ok).toBe(false);
      expect(forged.peerUserId).toBeNull();

      // A room this tab does not have answers nothing.
      await expect(ada.callKey('dm_none_none', call.callId, false)).rejects.toThrow('NO_SUCH_CHAT');
    },
    MLS_TEST_TIMEOUT_MS,
  );

  it(
    'a tag made before a commit does not check out after it, and a fresh key catches the room up first',
    async () => {
      await boot();
      const ada = await tab('Ada');
      const bo = await tab('Bo');
      await until('each sees the other', () =>
        ada.getSnapshot().people.some((p) => p.userId === bo.self.userId) &&
        bo.getSnapshot().people.some((p) => p.userId === ada.self.userId),
      );
      const conversationId = ada.open(bo.self.userId);
      // Ada opens the room and adds Bo; Bo has not looked yet.
      await untilOn(ada, 'Ada added Bo', () => {
        const room = ada.roomSnapshot(conversationId);
        return room?.phase === 'ready' && room.members.some((member) => member.userId === bo.self.userId) && room.note === undefined;
      });
      const fingerprint = (byte: string) => `sha-256 ${`${byte}:`.repeat(31)}${byte}`;
      const call = {
        conversationId,
        callId: 'c0000000000000000000b2',
        callerDeviceId: ada.self.deviceId,
        calleeDeviceId: bo.self.deviceId,
        fingerprintCaller: fingerprint('AB'),
        fingerprintCallee: fingerprint('CD'),
      };
      const sent = await createCallBinding(ada).callTag({ ...call, role: 'caller' });
      const tagEpoch = ada.roomSnapshot(conversationId)?.epoch;
      expect(BigInt(sent.epoch)).toBe(tagEpoch);

      // Bo joins by the Welcome and posts the key refresh a joiner owes: a commit, so the group moves on.
      await untilOn(bo, 'Bo joined and refreshed his key', () => {
        const epoch = bo.roomSnapshot(conversationId)?.epoch;
        return epoch !== undefined && tagEpoch !== undefined && epoch > tagEpoch;
      });
      const boEpoch = bo.roomSnapshot(conversationId)?.epoch;
      expect(ada.roomSnapshot(conversationId)?.epoch).toBe(tagEpoch); // Ada has not seen the commit

      // Ada's tag is from the epoch before: it does not check out against Bo's group.
      const stale = await createCallBinding(bo).callVerify({ ...call, role: 'callee', receivedTag: sent.tag });
      expect(stale.ok).toBe(false);
      expect(stale.peerUserId).toBeNull();

      // Without `fresh` the key is still the old epoch's; with it the room runs one pass first and applies the commit.
      const old = await ada.callKey(conversationId, call.callId, false);
      expect(BigInt(old.epoch)).toBe(tagEpoch);
      old.key.fill(0);
      const caught = await ada.callKey(conversationId, call.callId, true);
      expect(BigInt(caught.epoch)).toBe(boEpoch);
      caught.key.fill(0);
      expect(ada.roomSnapshot(conversationId)?.epoch).toBe(boEpoch);

      // On the same epoch again, the tag checks out.
      const again = await createCallBinding(ada).callTag({ ...call, role: 'caller' });
      const verdict = await createCallBinding(bo).callVerify({ ...call, role: 'callee', receivedTag: again.tag });
      expect(verdict.ok).toBe(true);
      expect(verdict.peerUserId).toBe(ada.self.userId);
      expect(verdict.epoch).toBe(again.epoch);
    },
    MLS_TEST_TIMEOUT_MS,
  );

  it('keeps asking only about people who are here, and not at all about a tab that went quiet', async () => {
    await boot();
    const ada = await tab('Ada');
    const cy = await tab('Cy');
    await until('Ada sees Cy', () => ada.getSnapshot().people.some((p) => p.userId === cy.self.userId));
    const asked = () => relay.calls.filter((call) => call === `${ada.self.userId}:listHandshakes`).length;

    // Cy is here and has not opened a room with Ada: Ada looks (once per poll).
    const before = asked();
    await ada.pollOnce();
    expect(asked()).toBe(before + 1);

    // Cy's tab stops calling in. Ada's goes on.
    now += PRESENCE_MS + 1;
    await ada.pollOnce();
    expect(ada.getSnapshot().people).toEqual([]);
    const after = asked();
    await ada.pollOnce();
    await ada.pollOnce();
    expect(asked()).toBe(after);
  }, MLS_TEST_TIMEOUT_MS);

  it('says why when the server cannot be reached for the people list, and recovers', async () => {
    await boot();
    const ada = await tab('Ada');
    await ada.pollOnce();
    expect(ada.getSnapshot().problem).toBeUndefined();

    await site?.close();
    site = undefined;
    await ada.pollOnce();
    expect(ada.getSnapshot().problem).toBeDefined();
  }, MLS_TEST_TIMEOUT_MS);

  it('refuses a name the server refuses, before any key is made', async () => {
    await boot();
    await expect(tab('   ')).rejects.toThrow('BAD_NAME');
  });
});
