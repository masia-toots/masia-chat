import { describe, expect, it } from 'vitest';
import { MAX_EXPORTER_LENGTH } from '../constants.js';
import { DeviceRole, MlsEngineErrorCode } from '../mls-engine.js';
import { expectAnyEngineError, expectCode } from './support/expect-code.js';
import { buildRoom, EMPTY_DELTA, must, pair, quint, trio } from './support/fixtures.js';
import { Room } from './support/room.js';
import type { ContractSubject } from './support/subject.js';
import { TestWorld } from './support/world.js';

/**
 * LIFECYCLE CONTRACT: what an `MlsEngine` does when everybody is honest. Written against the
 * interface only (`mls-engine.ts`), so a second engine runs the very same tests.
 */

const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

export function defineLifecycleContract(subject: ContractSubject): void {
  const newWorld = () => TestWorld.create(subject.factory);

  describe(`${subject.name}: lifecycle`, () => {
    it('a group of two: create, add, join, talk, self-update, remove', async () => {
      const world = await newWorld();
      const { engine } = world;
      const alice = await world.device('alice', 'a1');
      const bob = await world.device('bob', 'b1');

      const room = await Room.create(world, alice);
      expect(engine.members(room.state(alice))).toHaveLength(1);
      expect(engine.epoch(room.state(alice))).toBe(0n);
      expect(engine.conversationId(room.state(alice))).toBe('conv-1');
      expect(engine.groupId(room.state(alice))).toEqual(room.groupId);

      const added = await room.add(alice, [bob], { selfUpdate: false });
      expect(added.memberDelta).toEqual({
        added: [{ deviceId: 'b1', userId: 'bob', role: 'USER' }],
        removed: [],
      });
      expect(engine.needsSelfUpdate(room.state(bob))).toBe(true);
      expect(engine.needsSelfUpdate(room.state(alice))).toBe(false);
      expect(engine.epoch(room.state(alice))).toBe(1n);
      room.expectConverged();

      await room.send(alice, 'hi bob');
      await room.send(bob, 'hi alice');

      await room.selfUpdate(bob);
      expect(engine.needsSelfUpdate(room.state(bob))).toBe(false);
      room.expectConverged();
      await room.selfUpdate(alice);
      room.expectConverged();
      await room.send(bob, 'after both updates');

      const removed = await room.remove(alice, [bob]);
      expect(removed.memberDelta).toEqual({ added: [], removed: ['b1'] });
      expect(engine.members(room.state(alice)).map((m) => m.deviceId)).toEqual(['a1']);
      expect(engine.isActive(room.state(bob))).toBe(false);
      expect(engine.isActive(room.state(alice))).toBe(true);
    });

    it('a group of five devices over four users stays converged through adds, updates and a double remove', async () => {
      const world = await newWorld();
      const { engine } = world;
      const { room, devices } = await buildRoom(world, 5);
      const [a1, b1, c1, a2, b2] = quint(devices);
      room.expectConverged();
      expect(engine.members(room.state(a1))).toHaveLength(5);

      for (const sender of devices) await room.send(sender, `hello from ${sender.deviceId}`);
      await room.selfUpdate(c1);
      await room.selfUpdate(a2);
      room.expectConverged();

      const removal = await room.remove(b1, [a2, b2]);
      expect([...removal.memberDelta.removed].sort()).toEqual(['a2', 'b2']);
      room.expectConverged();
      expect(
        engine
          .members(room.state(a1))
          .map((m) => m.deviceId)
          .sort(),
      ).toEqual(['a1', 'b1', 'c1']);
      await room.send(c1, 'only three of us now');

      // A member that was removed cannot read what is said after it.
      const sealed = await engine.encrypt(room.state(a1), encode('secret from the new epoch'));
      await expectCode(
        () => engine.decrypt(room.state(b2), sealed.ciphertext),
        MlsEngineErrorCode.EPOCH_MISMATCH,
      );
    });

    it('Add reports that the newcomer must self-update, and the join says so too', async () => {
      const world = await newWorld();
      const { engine } = world;
      const alice = await world.device('alice', 'a1');
      const bob = await world.device('bob', 'b1');
      const room = await Room.create(world, alice);

      const bundle = await engine.createKeyPackage(bob.keys);
      const added = await engine.add({
        state: room.state(alice),
        keyPackages: [bundle.keyPackage],
      });
      expect(added.requiresNewcomerUpdate).toBe(true);

      const joined = await engine.joinFromWelcome({
        welcome: added.welcome,
        keyPackagePrivate: bundle.keyPackagePrivate,
        expectedConversationId: 'conv-1',
        ...room.joinTarget(alice),
      });
      expect(joined.requiresSelfUpdate).toBe(true);
      expect(joined.epochAuthenticator).toEqual(engine.epochAuthenticator(added.state));
      expect(engine.self(joined.state)).toMatchObject({
        userId: 'bob',
        deviceId: 'b1',
        role: DeviceRole.USER,
      });
      expect(
        engine
          .members(joined.state)
          .map((m) => m.deviceId)
          .sort(),
      ).toEqual(['a1', 'b1']);
    });

    it('treeHash is 32 bytes, moves with the epoch and agrees between members of one epoch', async () => {
      const world = await newWorld();
      const { engine } = world;
      const alice = await world.device('alice', 'a1');
      const bob = await world.device('bob', 'b1');
      const room = await Room.create(world, alice);

      const atCreate = engine.treeHash(room.state(alice));
      expect(atCreate).toHaveLength(32);
      // A copy, not the engine's own bytes: mutating the answer must not reach the state.
      atCreate.fill(0);
      expect(engine.treeHash(room.state(alice)).some((byte) => byte !== 0)).toBe(true);

      const before = engine.treeHash(room.state(alice));
      await room.add(alice, [bob], { selfUpdate: false });
      const after = engine.treeHash(room.state(alice));
      expect(after).not.toEqual(before);
      expect(engine.treeHash(room.state(bob))).toEqual(after);
    });

    it('welcomeAddressedTo says which KeyPackage a Welcome was made for, and nothing else', async () => {
      const world = await newWorld();
      const { engine } = world;
      const alice = await world.device('alice', 'a1');
      const bob = await world.device('bob', 'b1');
      const room = await Room.create(world, alice);

      const intended = await engine.createKeyPackage(bob.keys);
      const spare = await engine.createKeyPackage(bob.keys);
      const added = await engine.add({
        state: room.state(alice),
        keyPackages: [intended.keyPackage],
      });

      expect(await engine.welcomeAddressedTo(added.welcome, intended.keyPackagePrivate)).toBe(true);
      expect(await engine.welcomeAddressedTo(added.welcome, spare.keyPackagePrivate)).toBe(false);
      // Not a Welcome (a commit) and not secrets: errors, never a quiet false.
      await expectAnyEngineError(() =>
        engine.welcomeAddressedTo(added.commit, intended.keyPackagePrivate),
      );
      await expectAnyEngineError(() => engine.welcomeAddressedTo(added.welcome, new Uint8Array(8)));
    });

    it('the committer and the receivers all derive the same epoch authenticator', async () => {
      const world = await newWorld();
      const { engine } = world;
      const { room, devices } = await buildRoom(world, 3);
      const [a, b, c] = trio(devices);
      const update = await engine.selfUpdate(room.state(a));
      const forB = await engine.processCommit({
        state: room.state(b),
        commit: update.commit,
        servedMemberDelta: EMPTY_DELTA,
      });
      const forC = await engine.processCommit({
        state: room.state(c),
        commit: update.commit,
        servedMemberDelta: EMPTY_DELTA,
      });
      const mine = engine.epochAuthenticator(update.state);
      expect(forB.epochAuthenticator).toEqual(mine);
      expect(forC.epochAuthenticator).toEqual(mine);
      expect(forB.memberDelta).toEqual(EMPTY_DELTA);
      expect(forB.removedFromGroup).toBe(false);
    });

    it('a removal tells the removed device so, and nobody else', async () => {
      const world = await newWorld();
      const { engine } = world;
      const { room, devices } = await buildRoom(world, 3);
      const [a, b, c] = trio(devices);
      const removal = await engine.remove({
        state: room.state(a),
        leafIndexes: [room.leafIndexOf(a, c)],
      });
      const input = { commit: removal.commit, servedMemberDelta: removal.memberDelta };

      const forC = await engine.processCommit({ state: room.state(c), ...input });
      expect(forC.removedFromGroup).toBe(true);
      expect(forC.epochAuthenticator).toBeNull();
      expect(engine.isActive(forC.state)).toBe(false);

      const forB = await engine.processCommit({ state: room.state(b), ...input });
      expect(forB.removedFromGroup).toBe(false);
      expect(forB.epochAuthenticator).toEqual(engine.epochAuthenticator(removal.state));
    });

    it('a removed device can neither send nor commit nor process, but keeps what it already had', async () => {
      const world = await newWorld();
      const { engine } = world;
      const { room, devices } = await buildRoom(world, 3);
      const [a, b, c] = trio(devices);
      const earlier = await engine.encrypt(room.state(a), encode('before the removal'));
      room.states.set(a.deviceId, earlier.state);

      await room.remove(b, [c]);
      const removed = room.state(c);
      expect(engine.isActive(removed)).toBe(false);
      await expectCode(() => engine.encrypt(removed, encode('x')), MlsEngineErrorCode.NOT_ACTIVE);
      await expectCode(() => engine.selfUpdate(removed), MlsEngineErrorCode.NOT_ACTIVE);
      await expectCode(() => engine.exporter(removed, 'label', 16), MlsEngineErrorCode.NOT_ACTIVE);
      const later = await engine.selfUpdate(room.state(b));
      await expectCode(
        () =>
          engine.processCommit({
            state: removed,
            commit: later.commit,
            servedMemberDelta: EMPTY_DELTA,
          }),
        MlsEngineErrorCode.NOT_ACTIVE,
      );
      // The message sent in the epoch before the removal is still readable by the device that was in it.
      const opened = await engine.decrypt(removed, earlier.ciphertext);
      expect(decode(opened.plaintext)).toBe('before the removal');
    });

    it('a message from an earlier epoch and a message out of order still open', async () => {
      const world = await newWorld();
      const { engine } = world;
      const { room, devices } = await buildRoom(world, 3);
      const [a, b, c] = trio(devices);

      // Three messages from a, read in the order 3, 1, 2.
      const sealed: Uint8Array[] = [];
      for (const text of ['one', 'two', 'three']) {
        const result = await engine.encrypt(room.state(a), encode(text));
        room.states.set(a.deviceId, result.state);
        sealed.push(result.ciphertext);
      }
      let state = room.state(b);
      const texts: string[] = [];
      for (const index of [2, 0, 1]) {
        const opened = await engine.decrypt(state, must(sealed[index], 'ciphertext'));
        state = opened.state;
        texts.push(decode(opened.plaintext));
      }
      expect(texts).toEqual(['three', 'one', 'two']);

      // c writes, then the epoch moves on and c leaves; b still reads c's message and sees who wrote it.
      const late = await engine.encrypt(room.state(c), encode('written in the old epoch'));
      room.states.set(c.deviceId, late.state);
      await room.remove(a, [c]);
      const opened = await engine.decrypt(room.state(b), late.ciphertext);
      expect(decode(opened.plaintext)).toBe('written in the old epoch');
      expect(opened.sender).toMatchObject({ userId: 'carol', deviceId: 'c1' });
    });

    it('application data: the aad is authenticated, handed back, and a replay is refused', async () => {
      const world = await newWorld();
      const { engine } = world;
      const { room, devices } = await buildRoom(world, 2);
      const [a, b] = pair(devices);
      const sealed = await engine.encrypt(room.state(a), encode('hello'), encode('counter-1'));

      await expectCode(
        () => engine.decrypt(room.state(b), sealed.ciphertext, encode('counter-2')),
        MlsEngineErrorCode.AAD_MISMATCH,
      );
      const withoutExpectation = await engine.decrypt(room.state(b), sealed.ciphertext);
      expect(withoutExpectation.aad).toEqual(encode('counter-1'));
      const withExpectation = await engine.decrypt(
        room.state(b),
        sealed.ciphertext,
        encode('counter-1'),
      );
      expect(decode(withExpectation.plaintext)).toBe('hello');

      // The same ciphertext on the state that already read it: the key is spent.
      await expectAnyEngineError(() => engine.decrypt(withExpectation.state, sealed.ciphertext));
      // A state is a value: the one from before the read still reads it (nothing was mutated).
      const again = await engine.decrypt(room.state(b), sealed.ciphertext);
      expect(decode(again.plaintext)).toBe('hello');
    });

    it('the exporter agrees inside an epoch and differs by label, context, length and epoch', async () => {
      const world = await newWorld();
      const { engine } = world;
      const { room, devices } = await buildRoom(world, 3);
      const [a, b] = pair(devices);
      const stateA = room.state(a);
      const secretA = await engine.exporter(stateA, 'masia test', 32);
      expect(secretA).toHaveLength(32);
      expect(await engine.exporter(room.state(b), 'masia test', 32)).toEqual(secretA);
      expect(await engine.exporter(stateA, 'masia other', 32)).not.toEqual(secretA);
      expect(await engine.exporter(stateA, 'masia test', 32, encode('ctx'))).not.toEqual(secretA);
      expect(await engine.exporter(stateA, 'masia test', 16)).toHaveLength(16);
      await room.selfUpdate(b);
      expect(await engine.exporter(room.state(a), 'masia test', 32)).not.toEqual(secretA);
      await expectCode(
        () => engine.exporter(stateA, 'masia test', MAX_EXPORTER_LENGTH + 1),
        MlsEngineErrorCode.INVALID_ARGUMENT,
      );
    });

    it('a state is a value: processing a commit leaves the state it was given untouched', async () => {
      const world = await newWorld();
      const { engine } = world;
      const { room, devices } = await buildRoom(world, 3);
      const [a, b] = pair(devices);
      const update = await engine.selfUpdate(room.state(a));
      const before = room.state(b);
      const input = { state: before, commit: update.commit, servedMemberDelta: EMPTY_DELTA };

      const first = await engine.processCommit(input);
      const second = await engine.processCommit(input);
      expect(engine.epoch(before)).toBe(engine.epoch(update.state) - 1n);
      expect(engine.epoch(first.state)).toBe(engine.epoch(update.state));
      expect(second.epochAuthenticator).toEqual(first.epochAuthenticator);
    });

    it('a state survives encode/decode at any point, including a pending self-update', async () => {
      const world = await newWorld();
      const { engine } = world;
      const alice = await world.device('alice', 'a1');
      const bob = await world.device('bob', 'b1');
      const carol = await world.device('carol', 'c1');
      const room = await Room.create(world, alice);
      await room.add(alice, [bob], { selfUpdate: false });

      const restoredBob = engine.decodeState(engine.encodeState(room.state(bob)));
      expect(engine.needsSelfUpdate(restoredBob)).toBe(true);
      room.states.set(bob.deviceId, restoredBob);
      await room.selfUpdate(bob);
      expect(engine.needsSelfUpdate(room.state(bob))).toBe(false);

      await room.add(bob, [carol]);
      for (const device of room.activeDevices()) {
        const bytes = engine.encodeState(room.state(device));
        const restored = engine.decodeState(bytes);
        expect(engine.epoch(restored)).toBe(engine.epoch(room.state(device)));
        expect(engine.self(restored)).toEqual(engine.self(room.state(device)));
        expect(engine.encodeState(restored)).toEqual(bytes);
        room.states.set(device.deviceId, restored);
      }
      await room.send(alice, 'after a restore');
      await room.send(carol, 'and another');
      await room.selfUpdate(alice);
      room.expectConverged();
    });

    it('members() and self() read the tree, never relay metadata', async () => {
      const world = await newWorld();
      const { engine } = world;
      const alice = await world.device('alice', 'a1');
      const kid = await world.device('kid', 'guard1', DeviceRole.GUARDIAN);
      const room = await Room.create(world, alice);
      await room.add(alice, [kid]);
      const members = engine
        .members(room.state(alice))
        .map(({ userId, deviceId, role }) => ({ userId, deviceId, role }))
        .sort((x, y) => x.deviceId.localeCompare(y.deviceId));
      expect(members).toEqual([
        { userId: 'alice', deviceId: 'a1', role: 'USER' },
        { userId: 'kid', deviceId: 'guard1', role: 'GUARDIAN' },
      ]);
      expect(engine.self(room.state(kid))).toMatchObject({ deviceId: 'guard1', role: 'GUARDIAN' });
      expect(new Set(engine.members(room.state(alice)).map((m) => m.leafIndex)).size).toBe(2);
    });

    it('refuses what it did not make, and bad input to the constructors', async () => {
      const world = await newWorld();
      const { engine } = world;
      const alice = await world.device('alice', 'a1');
      const other = await world.device('bob', 'b1');

      const foreign = { kind: 'mls-group-state' } as const;
      expect(() => engine.members(foreign)).toThrow(
        expect.objectContaining({ code: MlsEngineErrorCode.INVALID_STATE }),
      );
      await expectCode(
        () => engine.encrypt(foreign, encode('x')),
        MlsEngineErrorCode.INVALID_STATE,
      );

      await expectCode(
        () =>
          engine.createKeyPackage({
            ...alice.keys,
            identity: { ...alice.keys.identity, userId: 'not a valid id' },
          }),
        MlsEngineErrorCode.CREDENTIAL_INVALID,
      );
      await expectCode(
        () =>
          engine.createKeyPackage({
            ...alice.keys,
            identity: { ...alice.keys.identity, role: 'ROOT' as DeviceRole },
          }),
        MlsEngineErrorCode.CREDENTIAL_INVALID,
      );
      // A private key that is not the partner of the public one never produces a KeyPackage.
      const crossed = {
        publicKey: other.keys.signingKey.publicKey,
        privateKey: alice.keys.signingKey.privateKey,
      };
      await expectCode(
        () => engine.createKeyPackage({ ...alice.keys, signingKey: crossed }),
        MlsEngineErrorCode.SIGNATURE_INVALID,
      );

      await expectCode(
        () => engine.createGroup({ conversationId: 'not a valid id', selfLeaf: alice.keys }),
        MlsEngineErrorCode.INVALID_ARGUMENT,
      );
      const ghost = await world.device('ghost', 'g1', DeviceRole.USER, { listed: false });
      await expectCode(
        () => engine.createGroup({ conversationId: 'conv-1', selfLeaf: ghost.keys }),
        MlsEngineErrorCode.LEAF_NOT_IN_SIGNED_LIST,
      );
    });

    it('offers no way to join from outside: no external-join API, no GroupInfo export', async () => {
      const world = await newWorld();
      const surface = new Set<string>(Object.keys(world.engine));
      for (
        let proto: object | null = Object.getPrototypeOf(world.engine) as object | null;
        proto !== null && proto !== Object.prototype;
        proto = Object.getPrototypeOf(proto) as object | null
      ) {
        for (const name of Object.getOwnPropertyNames(proto)) surface.add(name);
      }
      const forbidden = [...surface].filter((name) =>
        /external|groupinfo|psk|reinit|branch/i.test(name),
      );
      expect(forbidden).toEqual([]);
    });

    it.skipIf(subject.adversary === undefined)(
      'PublicMessage commits are refused: commits are PrivateMessages, so the relay sees no sender',
      async () => {
        const adversary = await must(subject.adversary, 'adversary')();
        const world = await newWorld();
        const { engine } = world;
        const { room, devices } = await buildRoom(world, 3);
        const [a, b, c] = trio(devices);
        const commit = await adversary.publicSelfUpdate(room.state(a));
        for (const receiver of [b, c]) {
          const before = room.state(receiver);
          await expectCode(
            () =>
              engine.processCommit({
                state: before,
                commit,
                servedMemberDelta: EMPTY_DELTA,
              }),
            MlsEngineErrorCode.UNEXPECTED_MESSAGE_KIND,
          );
          expect(engine.epoch(room.state(receiver))).toBe(engine.epoch(before));
        }
        // The same self-update, sent the way an honest engine sends it, goes through.
        await room.selfUpdate(a);
        room.expectConverged();
      },
    );
  });
}
