import { describe, expect, it } from 'vitest';
import {
  KEY_PACKAGE_LIFETIME_SECONDS,
  KEY_PACKAGE_MIN_REMAINING_SECONDS,
  MAX_AAD_EXTRA_BYTES,
  MAX_ADDS_PER_COMMIT,
  MAX_REMOVES_PER_COMMIT,
  MS_PER_SECOND,
} from '../constants.js';
import { DeviceRole, MlsEngineErrorCode } from '../mls-engine.js';
import type { MemberDelta } from '../mls-engine.js';
import type { Adversary, KeyPackageForgery } from './support/adversary.js';
import { expectAnyEngineError, expectCode } from './support/expect-code.js';
import { buildRoom, EMPTY_DELTA, guardianDevice, must, pair, trio } from './support/fixtures.js';
import { expectRefusedEverywhere } from './support/refused.js';
import { Room } from './support/room.js';
import type { ContractSubject } from './support/subject.js';
import { TestWorld } from './support/world.js';

/**
 * ATTACK CONTRACT: every rule of the receive-side validator, hit by a message an honest engine can
 * never build. The attacker is a legitimate MEMBER (real keys, real signatures, a valid place in the
 * tree) or the relay in the middle; the victims are other honest members. A rule holds when
 *  1. every victim refuses with the rule's own code (not just "some error"),
 *  2. no victim's state moves, and
 *  3. the group is still alive afterwards: an honest commit goes through for all.
 *
 * Needs an `Adversary` for the engine's library; without one the suite is skipped.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const FAR_PAST_DAYS = 70;
const OUT_OF_WINDOW_DAYS = 31;
/** The last moment (after creation) a sender with a true clock still adds a fresh package. */
const LAST_SENDABLE_MS =
  (KEY_PACKAGE_LIFETIME_SECONDS - KEY_PACKAGE_MIN_REMAINING_SECONDS) * MS_PER_SECOND;
/** The worst sender clock the margin is sized for: a full margin behind the truth. */
const SENDER_CLOCK_LAG_MS = KEY_PACKAGE_MIN_REMAINING_SECONDS * MS_PER_SECOND;
const SUITE_BYTE = 7; // KeyPackage MLSMessage: version(2) wire_format(2) kp.version(2) kp.cipher_suite(2)
const WELCOME_SUITE_BYTE = 5; // Welcome MLSMessage: version(2) wire_format(2) cipher_suite(2)
const VERSION_BYTE = 1;

export function defineAttackContract(subject: ContractSubject): void {
  const newWorld = () => TestWorld.create(subject.factory);
  const adversaryOf = (): Promise<Adversary> => must(subject.adversary, 'adversary')();

  describe.skipIf(subject.adversary === undefined)(`${subject.name}: attacks`, () => {
    // --- The UpdatePath rule ------------------------------------------------------------------------
    describe('UpdatePath required (RFC 9420 §12.4; GHSA-gwp3-968w-m7gv; probe F8b)', () => {
      it('GHSA: a Remove-only commit without an UpdatePath is refused as PrivateMessage; as PublicMessage it is refused before that', async () => {
        const world = await newWorld();
        const adversary = await adversaryOf();
        const { room, devices } = await buildRoom(world, 3);
        const [alice, bob, carol] = trio(devices);
        for (const wire of ['private', 'public'] as const) {
          const commit = await adversary.removeWithoutPath(
            room.state(bob),
            room.leafIndexOf(bob, carol),
            wire,
          );
          await expectRefusedEverywhere(
            room,
            [alice, carol],
            commit,
            wire === 'private'
              ? MlsEngineErrorCode.PATH_REQUIRED
              : MlsEngineErrorCode.UNEXPECTED_MESSAGE_KIND, // commits are PrivateMessages
          );
        }
      });

      it('F8b: a GroupContextExtensions-only commit without an UpdatePath is refused', async () => {
        const world = await newWorld();
        const adversary = await adversaryOf();
        const { room, devices } = await buildRoom(world, 3);
        const [alice, bob, carol] = trio(devices);
        const commit = await adversary.groupContextExtensionsWithoutPath(room.state(bob));
        await expectRefusedEverywhere(
          room,
          [alice, carol],
          commit,
          MlsEngineErrorCode.PATH_REQUIRED,
        );
      });

      it('a GroupContextExtensions proposal is refused even with a path: the conversation id cannot be rewritten', async () => {
        const world = await newWorld();
        const adversary = await adversaryOf();
        const { room, devices } = await buildRoom(world, 3);
        const [alice, bob, carol] = trio(devices);
        const commit = await adversary.groupContextExtensionsWithPath(
          room.state(bob),
          room.leafIndexOf(bob, carol),
        );
        await expectRefusedEverywhere(
          room,
          [alice],
          commit,
          MlsEngineErrorCode.PROPOSAL_NOT_ALLOWED,
        );
      });
    });

    // --- Proposal shapes ----------------------------------------------------------------------------------
    describe('proposal shapes and senders (review §1, §2)', () => {
      it('a commit that names a proposal by reference is refused', async () => {
        const world = await newWorld();
        const adversary = await adversaryOf();
        const { room, devices } = await buildRoom(world, 3);
        const [alice, bob, carol] = trio(devices);
        const commit = await adversary.commitWithReference(room.state(bob));
        await expectRefusedEverywhere(
          room,
          [alice, carol],
          commit,
          MlsEngineErrorCode.PROPOSAL_BY_REFERENCE_FORBIDDEN,
        );
      });

      it('a proposal sent on its own is refused, as PrivateMessage and as PublicMessage', async () => {
        const world = await newWorld();
        const adversary = await adversaryOf();
        const { room, devices } = await buildRoom(world, 3);
        const [alice, bob, carol] = trio(devices);
        for (const wire of ['private', 'public'] as const) {
          const proposal = await adversary.standaloneProposal(
            room.state(bob),
            room.leafIndexOf(bob, carol),
            wire,
          );
          await expectRefusedEverywhere(
            room,
            [alice, carol],
            proposal,
            MlsEngineErrorCode.STANDALONE_PROPOSAL_FORBIDDEN,
          );
        }
      });

      it('PSK, ReInit and custom proposals are refused', async () => {
        const world = await newWorld();
        const adversary = await adversaryOf();
        const { room, devices } = await buildRoom(world, 3);
        const [alice, bob] = pair(devices);
        for (const kind of ['psk', 'reinit', 'custom'] as const) {
          const commit = await adversary.unsupportedProposal(room.state(bob), kind);
          await expectRefusedEverywhere(
            room,
            [alice],
            commit,
            MlsEngineErrorCode.PROPOSAL_NOT_ALLOWED,
          );
        }
      });

      it('ExternalInit inside a member commit is refused', async () => {
        const world = await newWorld();
        const adversary = await adversaryOf();
        const { room, devices } = await buildRoom(world, 3);
        const [alice, bob, carol] = trio(devices);
        const commit = await adversary.externalInitInMemberCommit(room.state(bob));
        await expectRefusedEverywhere(
          room,
          [alice, carol],
          commit,
          MlsEngineErrorCode.EXTERNAL_SENDER_FORBIDDEN,
        );
      });

      it('a real external commit (new_member_commit) is refused: nobody joins without being added', async () => {
        const world = await newWorld();
        const adversary = await adversaryOf();
        const { room, devices } = await buildRoom(world, 3);
        const [alice, bob, carol] = trio(devices);
        const eve = await world.device('eve', 'e9');
        const bundle = await world.engine.createKeyPackage(eve.keys);
        const commit = await adversary.externalCommit(room.state(bob), bundle);
        await expectRefusedEverywhere(
          room,
          [alice, carol],
          commit,
          MlsEngineErrorCode.EXTERNAL_SENDER_FORBIDDEN,
        );
      });

      it('proposals from an external sender or a new-member sender are refused', async () => {
        const world = await newWorld();
        const adversary = await adversaryOf();
        const { room, devices } = await buildRoom(world, 3);
        const [alice, bob] = pair(devices);
        for (const sender of ['external', 'new_member_proposal'] as const) {
          const proposal = await adversary.externalProposal(room.state(bob), sender);
          await expectRefusedEverywhere(
            room,
            [alice],
            proposal,
            MlsEngineErrorCode.EXTERNAL_SENDER_FORBIDDEN,
          );
        }
      });
    });

    // --- Leaves -----------------------------------------------------------------------------------------------------
    describe('leaves against the signed device lists (review §1)', () => {
      it('ROLE_CHANGED: a guardian cannot drop its badge in an Update, and nobody can claim one', async () => {
        const world = await newWorld();
        const adversary = await adversaryOf();
        const alice = await world.device('alice', 'a1');
        const guard = await guardianDevice(world, 'kid');
        const bob = await world.device('bob', 'b1');
        const room = await Room.create(world, alice);
        await room.add(alice, [guard]);
        await room.add(alice, [bob]);

        for (const role of [DeviceRole.USER, DeviceRole.ASSISTANT]) {
          const dropped = await adversary.selfUpdateAs(room.state(guard), { role });
          await expectRefusedEverywhere(
            room,
            [alice, bob],
            dropped,
            MlsEngineErrorCode.ROLE_CHANGED,
          );
        }
        const promoted = await adversary.selfUpdateAs(room.state(bob), {
          role: DeviceRole.GUARDIAN,
        });
        await expectRefusedEverywhere(
          room,
          [alice, guard],
          promoted,
          MlsEngineErrorCode.ROLE_CHANGED,
        );
      });

      it('IDENTITY_CHANGED: a leaf cannot become another device or another user', async () => {
        const world = await newWorld();
        const adversary = await adversaryOf();
        const { room, devices } = await buildRoom(world, 3);
        const [alice, bob] = pair(devices);
        const otherDevice = await adversary.selfUpdateAs(room.state(bob), { deviceId: 'b-other' });
        await expectRefusedEverywhere(
          room,
          [alice],
          otherDevice,
          MlsEngineErrorCode.IDENTITY_CHANGED,
        );
        const otherUser = await adversary.selfUpdateAs(room.state(bob), { userId: 'alice' });
        await expectRefusedEverywhere(
          room,
          [alice],
          otherUser,
          MlsEngineErrorCode.IDENTITY_CHANGED,
        );
      });

      it('LEAF_NOT_IN_SIGNED_LIST: an Update leaf signed by a key the owner never listed is refused', async () => {
        const world = await newWorld();
        const adversary = await adversaryOf();
        const { room, devices } = await buildRoom(world, 3);
        const [alice, bob, carol] = trio(devices);
        const commit = await adversary.selfUpdateWithUnlistedKey(room.state(bob));
        await expectRefusedEverywhere(
          room,
          [alice, carol],
          commit,
          MlsEngineErrorCode.LEAF_NOT_IN_SIGNED_LIST,
        );
      });

      it("LEAF_NOT_IN_SIGNED_LIST: a device taken off its owner's list can no longer commit", async () => {
        const world = await newWorld();
        const { engine } = world;
        const { room, devices } = await buildRoom(world, 3);
        const [alice, bob, carol] = trio(devices);
        const update = await engine.selfUpdate(room.state(bob));
        world.unlist('bob', 'b1'); // the host learned of a newer signed list without b1
        await expectRefusedEverywhere(
          room,
          [alice, carol],
          update.commit,
          MlsEngineErrorCode.LEAF_NOT_IN_SIGNED_LIST,
        );
      });

      it('LEAF_NOT_IN_SIGNED_LIST: adding a device that is on no list is refused by the sender and by every receiver', async () => {
        const world = await newWorld();
        const { engine } = world;
        const adversary = await adversaryOf();
        const { room, devices } = await buildRoom(world, 3);
        const [alice, bob, carol] = trio(devices);
        const ghost = await world.device('ghost', 'g1', DeviceRole.USER, { listed: false });
        const bundle = await engine.createKeyPackage(ghost.keys);

        await expectCode(
          () => engine.add({ state: room.state(bob), keyPackages: [bundle.keyPackage] }),
          MlsEngineErrorCode.LEAF_NOT_IN_SIGNED_LIST,
        );
        const forged = await adversary.forceAdd(room.state(bob), [bundle.keyPackage]);
        await expectRefusedEverywhere(
          room,
          [alice, carol],
          forged.commit,
          MlsEngineErrorCode.LEAF_NOT_IN_SIGNED_LIST,
          forged.memberDelta,
        );
      });

      it('LEAF_NOT_IN_SIGNED_LIST: a role the owner did not list is just as unlisted', async () => {
        const world = await newWorld();
        const { engine } = world;
        const { room, devices } = await buildRoom(world, 3);
        const bob = pair(devices)[1];
        // The KeyPackage says GUARDIAN; bob's real list entry says USER.
        const impostor = await world.device('kid', 'k-fake', DeviceRole.GUARDIAN, {
          listed: false,
        });
        world.list('kid', {
          deviceId: 'k-fake',
          role: DeviceRole.USER,
          signatureKey: impostor.keys.signingKey.publicKey,
        });
        const bundle = await engine.createKeyPackage(impostor.keys);
        await expectCode(
          () => engine.add({ state: room.state(bob), keyPackages: [bundle.keyPackage] }),
          MlsEngineErrorCode.LEAF_NOT_IN_SIGNED_LIST,
        );
      });

      it('DUPLICATE_DEVICE: a device is in a group once', async () => {
        const world = await newWorld();
        const { engine } = world;
        const adversary = await adversaryOf();
        const { room, devices } = await buildRoom(world, 3);
        const [alice, bob, carol] = trio(devices);
        const again = await engine.createKeyPackage(carol.keys);
        await expectCode(
          () => engine.add({ state: room.state(alice), keyPackages: [again.keyPackage] }),
          MlsEngineErrorCode.DUPLICATE_DEVICE,
        );
        const forged = await adversary.forceAdd(room.state(bob), [again.keyPackage]);
        await expectRefusedEverywhere(
          room,
          [alice, carol],
          forged.commit,
          MlsEngineErrorCode.DUPLICATE_DEVICE,
          forged.memberDelta,
        );
      });

      it('INVALID_REMOVE: a Remove must name somebody else, once', async () => {
        const world = await newWorld();
        const { engine } = world;
        const { room, devices } = await buildRoom(world, 3);
        const [alice, bob] = pair(devices);
        const state = room.state(alice);
        const bobLeaf = room.leafIndexOf(alice, bob);
        const aliceLeaf = room.leafIndexOf(alice, alice);
        await expectCode(
          () => engine.remove({ state, leafIndexes: [aliceLeaf] }),
          MlsEngineErrorCode.INVALID_REMOVE,
        );
        await expectCode(
          () => engine.remove({ state, leafIndexes: [bobLeaf, bobLeaf] }),
          MlsEngineErrorCode.INVALID_REMOVE,
        );
        await expectCode(
          () => engine.remove({ state, leafIndexes: [99] }),
          MlsEngineErrorCode.INVALID_REMOVE,
        );
      });

      it('INVALID_ARGUMENT / TOO_MANY_PROPOSALS: an empty commit request is a caller bug; an oversized one is capped per kind', async () => {
        const world = await newWorld();
        const { engine } = world;
        const { room, devices } = await buildRoom(world, 3);
        const alice = must(devices[0], 'alice');
        const state = room.state(alice);
        await expectCode(
          () => engine.remove({ state, leafIndexes: [] }),
          MlsEngineErrorCode.INVALID_ARGUMENT,
        );
        await expectCode(
          () => engine.add({ state, keyPackages: [] }),
          MlsEngineErrorCode.INVALID_ARGUMENT,
        );
        const dave = await world.device('dave', 'd1');
        const bundle = await engine.createKeyPackage(dave.keys);
        await expectCode(
          () =>
            engine.add({
              state,
              keyPackages: new Array<Uint8Array>(MAX_ADDS_PER_COMMIT + 1).fill(bundle.keyPackage),
            }),
          MlsEngineErrorCode.TOO_MANY_PROPOSALS,
        );
        await expectCode(
          () =>
            engine.remove({
              state,
              leafIndexes: Array.from({ length: MAX_REMOVES_PER_COMMIT + 1 }, (_, i) => i + 1),
            }),
          MlsEngineErrorCode.TOO_MANY_PROPOSALS,
        );
      });
    });

    // --- Guardian removal ----------------------------------------------------------------------------------------------
    describe('guardian removal is policy, enforced on receive (internal ADR-117 §4, review §7)', () => {
      async function guardianRoom() {
        const world = await newWorld();
        const mom = await world.device('mom', 'm1');
        const alice = await world.device('alice', 'a1');
        const bob = await world.device('bob', 'b1');
        const kid = await world.device('kid', 'kid1');
        const guard = await guardianDevice(world, 'kid');
        world.makeAdmin('mom', 'kid');
        const room = await Room.create(world, mom);
        for (const newcomer of [alice, bob, kid, guard]) await room.add(mom, [newcomer]);
        return { world, room, mom, alice, bob, kid, guard };
      }

      it('a member who does not administer the child cannot remove the guardian leaf: refused when sending', async () => {
        const { world, room, bob, guard } = await guardianRoom();
        await expectCode(
          () =>
            world.engine.remove({
              state: room.state(bob),
              leafIndexes: [room.leafIndexOf(bob, guard)],
            }),
          MlsEngineErrorCode.GUARDIAN_REMOVE_FORBIDDEN,
        );
      });

      it('and refused by every receiver when a modified client sends it anyway', async () => {
        const { world, room, mom, alice, bob, guard } = await guardianRoom();
        const adversary = await adversaryOf();
        const forged = await adversary.forceRemove(room.state(bob), [room.leafIndexOf(bob, guard)]);
        await expectRefusedEverywhere(
          room,
          [mom, alice, guard],
          forged.commit,
          MlsEngineErrorCode.GUARDIAN_REMOVE_FORBIDDEN,
          forged.memberDelta,
        );
        expect(
          world.engine.members(room.state(mom)).some((m) => m.role === DeviceRole.GUARDIAN),
        ).toBe(true);
      });

      it("the child's own user device does not administer the child", async () => {
        const { world, room, kid, guard } = await guardianRoom();
        await expectCode(
          () =>
            world.engine.remove({
              state: room.state(kid),
              leafIndexes: [room.leafIndexOf(kid, guard)],
            }),
          MlsEngineErrorCode.GUARDIAN_REMOVE_FORBIDDEN,
        );
      });

      it('a batch that includes the guardian leaf is refused as a whole', async () => {
        const { world, room, alice, bob, guard } = await guardianRoom();
        const adversary = await adversaryOf();
        await expectCode(
          () =>
            world.engine.remove({
              state: room.state(bob),
              leafIndexes: [room.leafIndexOf(bob, alice), room.leafIndexOf(bob, guard)],
            }),
          MlsEngineErrorCode.GUARDIAN_REMOVE_FORBIDDEN,
        );
        const forged = await adversary.forceRemove(room.state(bob), [
          room.leafIndexOf(bob, alice),
          room.leafIndexOf(bob, guard),
        ]);
        await expectRefusedEverywhere(
          room,
          [alice],
          forged.commit,
          MlsEngineErrorCode.GUARDIAN_REMOVE_FORBIDDEN,
          forged.memberDelta,
        );
      });

      it('the admin of the child may remove the guardian leaf', async () => {
        const { world, room, mom, alice, guard } = await guardianRoom();
        const outcome = await room.remove(mom, [guard]);
        expect(outcome.memberDelta.removed).toEqual(['guard1']);
        expect(world.engine.isActive(room.state(guard))).toBe(false);
        expect(world.engine.members(room.state(alice)).some((m) => m.deviceId === 'guard1')).toBe(
          false,
        );
        room.expectConverged();
      });

      it('an ordinary device is removable by any member: the protection is for the guardian leaf only', async () => {
        const { world, room, alice, bob } = await guardianRoom();
        await room.remove(bob, [alice]);
        expect(world.engine.members(room.state(bob)).some((m) => m.deviceId === 'a1')).toBe(false);
      });
    });

    // --- Guardian eviction by a guardian -------------------------------------------------------------------
    describe('a compromised guardian device is removable without an admin leaf (internal ADR-117 §4, the engine code review)', () => {
      /** The child, a friend and two guardian devices; no device of the child's admin is in the room. */
      async function childRoom() {
        const world = await newWorld();
        const kid = await world.device('kid', 'kid1');
        const bob = await world.device('bob', 'b1');
        const lost = await guardianDevice(world, 'kid', 'guard-lost');
        const keeper = await guardianDevice(world, 'kid', 'guard-keeper');
        world.makeAdmin('mom', 'kid'); // mom owns both guardian devices; none of her own devices is in the room
        world.registerGuardianDevice('kid', 'guard-lost', 'mom');
        world.registerGuardianDevice('kid', 'guard-keeper', 'mom');
        const room = await Room.create(world, kid);
        for (const newcomer of [bob, lost, keeper]) await room.add(kid, [newcomer]);
        return { world, room, kid, bob, lost, keeper };
      }

      it('the other guardian device of the child evicts it, and every member follows', async () => {
        const { world, room, kid, bob, lost, keeper } = await childRoom();
        const outcome = await room.remove(keeper, [lost]);
        expect(outcome.memberDelta.removed).toEqual(['guard-lost']);
        expect(world.engine.isActive(room.state(lost))).toBe(false);
        for (const member of [kid, bob, keeper]) {
          const left = world.engine.members(room.state(member)).map((m) => m.deviceId);
          expect(left).not.toContain('guard-lost');
          expect(left).toContain('guard-keeper');
        }
        room.expectConverged();
      });

      it('a friend still cannot: refused when sending, and by every receiver when a modified client sends it anyway', async () => {
        const { world, room, kid, bob, lost, keeper } = await childRoom();
        const adversary = await adversaryOf();
        await expectCode(
          () =>
            world.engine.remove({
              state: room.state(bob),
              leafIndexes: [room.leafIndexOf(bob, lost)],
            }),
          MlsEngineErrorCode.GUARDIAN_REMOVE_FORBIDDEN,
        );
        const forged = await adversary.forceRemove(room.state(bob), [room.leafIndexOf(bob, lost)]);
        await expectRefusedEverywhere(
          room,
          [kid, keeper, lost],
          forged.commit,
          MlsEngineErrorCode.GUARDIAN_REMOVE_FORBIDDEN,
          forged.memberDelta,
        );
      });

      it('nor can the child itself, a guardian device the policy cannot tie to an admin, or a guardian of another child', async () => {
        const { world, room, kid, lost } = await childRoom();
        const unplaced = await guardianDevice(world, 'kid', 'guard-unplaced'); // listed, owned by nobody
        world.makeAdmin('dad', 'other-kid');
        const foreign = await guardianDevice(world, 'other-kid', 'guard-foreign');
        world.registerGuardianDevice('other-kid', 'guard-foreign', 'dad');
        for (const newcomer of [unplaced, foreign]) await room.add(kid, [newcomer]);
        for (const actor of [kid, unplaced, foreign]) {
          await expectCode(
            () =>
              world.engine.remove({
                state: room.state(actor),
                leafIndexes: [room.leafIndexOf(actor, lost)],
              }),
            MlsEngineErrorCode.GUARDIAN_REMOVE_FORBIDDEN,
          );
        }
      });
    });

    // --- Who may add Masia -------------------------------------------------------------------------------------
    describe('Masia joins a room with a minor only by an admin of that minor (internal ADR-117 §3, the engine code review)', () => {
      const CONVERSATION = 'conv-1';

      async function childRoom() {
        const world = await newWorld();
        const mom = await world.device('mom', 'm1');
        const kid = await world.device('kid', 'k1');
        const stranger = await world.device('stranger', 's1');
        world.makeMinor('kid');
        world.makeAdmin('mom', 'kid');
        const room = await Room.create(world, mom, CONVERSATION);
        for (const newcomer of [kid, stranger]) await room.add(mom, [newcomer]);
        const masia = await world.device('masia', 'masia1', DeviceRole.ASSISTANT, {
          conversationId: CONVERSATION,
        });
        const bundle = await world.engine.createKeyPackage(masia.keys);
        return { world, room, mom, kid, stranger, masia, bundle };
      }

      it('the child adds Masia: refused when sending and by every receiver', async () => {
        const { world, room, mom, kid, stranger, bundle } = await childRoom();
        const adversary = await adversaryOf();
        await expectCode(
          () => world.engine.add({ state: room.state(kid), keyPackages: [bundle.keyPackage] }),
          MlsEngineErrorCode.ASSISTANT_ADD_FORBIDDEN,
        );
        const forged = await adversary.forceAdd(room.state(kid), [bundle.keyPackage]);
        await expectRefusedEverywhere(
          room,
          [mom, stranger],
          forged.commit,
          MlsEngineErrorCode.ASSISTANT_ADD_FORBIDDEN,
          forged.memberDelta,
        );
      });

      it("a stranger adult adds Masia to the child's room: refused when sending and by every receiver", async () => {
        const { world, room, mom, kid, stranger, bundle } = await childRoom();
        const adversary = await adversaryOf();
        await expectCode(
          () => world.engine.add({ state: room.state(stranger), keyPackages: [bundle.keyPackage] }),
          MlsEngineErrorCode.ASSISTANT_ADD_FORBIDDEN,
        );
        const forged = await adversary.forceAdd(room.state(stranger), [bundle.keyPackage]);
        await expectRefusedEverywhere(
          room,
          [mom, kid],
          forged.commit,
          MlsEngineErrorCode.ASSISTANT_ADD_FORBIDDEN,
          forged.memberDelta,
        );
      });

      it('the parent (an admin of the child) adds Masia, and Masia is a working member', async () => {
        const { world, room, mom, masia } = await childRoom();
        const outcome = await room.add(mom, [masia]);
        expect(outcome.memberDelta.added.map((a) => a.role)).toEqual([DeviceRole.ASSISTANT]);
        expect(world.engine.members(room.state(mom)).map((m) => m.role)).toContain(
          DeviceRole.ASSISTANT,
        );
        await room.send(masia, 'hello from the assistant');
        room.expectConverged();
      });

      it('in a room without a minor any member may add Masia', async () => {
        const world = await newWorld();
        const { room, devices } = await buildRoom(world, 3, CONVERSATION);
        const bob = pair(devices)[1];
        const masia = await world.device('masia', 'masia1', DeviceRole.ASSISTANT, {
          conversationId: CONVERSATION,
        });
        await room.add(bob, [masia]);
        room.expectConverged();
      });

      it('a Masia leaf belongs to ONE conversation: an entry for another conversation, or for none, is not on the list', async () => {
        const { world, room, mom, kid, stranger } = await childRoom();
        const adversary = await adversaryOf();
        const elsewhere = await world.device('masia', 'masia2', DeviceRole.ASSISTANT, {
          conversationId: 'conv-other',
        });
        const unbound = await world.device('masia', 'masia3', DeviceRole.ASSISTANT);
        for (const impostor of [elsewhere, unbound]) {
          const bundle = await world.engine.createKeyPackage(impostor.keys);
          await expectCode(
            () => world.engine.add({ state: room.state(mom), keyPackages: [bundle.keyPackage] }),
            MlsEngineErrorCode.LEAF_NOT_IN_SIGNED_LIST,
          );
          const forged = await adversary.forceAdd(room.state(mom), [bundle.keyPackage]);
          await expectRefusedEverywhere(
            room,
            [kid, stranger],
            forged.commit,
            MlsEngineErrorCode.LEAF_NOT_IN_SIGNED_LIST,
            forged.memberDelta,
          );
        }
      });
    });

    // --- The committer on its list, on every commit ------------------------------------------------------------
    describe("the committer is on its owner's signed list on EVERY commit (the engine code review)", () => {
      it('an Add-only commit from a device taken off the list is refused when sending and by every receiver', async () => {
        const world = await newWorld();
        const { engine } = world;
        const adversary = await adversaryOf();
        const { room, devices } = await buildRoom(world, 3);
        const [alice, bob, carol] = trio(devices);
        const dave = await world.device('dave', 'd1'); // listed: the only fault is the committer
        const bundle = await engine.createKeyPackage(dave.keys);
        world.unlist('bob', 'b1');
        await expectCode(
          () => engine.add({ state: room.state(bob), keyPackages: [bundle.keyPackage] }),
          MlsEngineErrorCode.LEAF_NOT_IN_SIGNED_LIST,
        );
        const forged = await adversary.forceAdd(room.state(bob), [bundle.keyPackage]);
        await expectRefusedEverywhere(
          room,
          [alice, carol],
          forged.commit,
          MlsEngineErrorCode.LEAF_NOT_IN_SIGNED_LIST,
          forged.memberDelta,
        );
      });

      it('a Remove-only commit from such a device is refused the same way', async () => {
        const world = await newWorld();
        const { engine } = world;
        const adversary = await adversaryOf();
        const { room, devices } = await buildRoom(world, 3);
        const [alice, bob, carol] = trio(devices);
        world.unlist('bob', 'b1');
        await expectCode(
          () =>
            engine.remove({
              state: room.state(bob),
              leafIndexes: [room.leafIndexOf(bob, carol)],
            }),
          MlsEngineErrorCode.LEAF_NOT_IN_SIGNED_LIST,
        );
        const forged = await adversary.forceRemove(room.state(bob), [room.leafIndexOf(bob, carol)]);
        await expectRefusedEverywhere(
          room,
          [alice, carol],
          forged.commit,
          MlsEngineErrorCode.LEAF_NOT_IN_SIGNED_LIST,
          forged.memberDelta,
        );
      });
    });

    // --- Signatures and keys on receive -----------------------------------------------------------------------
    describe('signatures and keys are verified on RECEIVE (RFC 9420 §10.1, §7.3; the engine code review)', () => {
      const forgeries: readonly [KeyPackageForgery, string][] = [
        ['key-package-signature', 'a KeyPackage whose signature does not verify'],
        ['leaf-signature', 'a KeyPackage whose leaf signature does not verify'],
        ['init-key-is-leaf-key', 'a KeyPackage whose init key is its leaf encryption key'],
      ];

      for (const [forgery, what] of forgeries) {
        it(`SIGNATURE_INVALID: an Add of ${what} is refused when sending and by every receiver`, async () => {
          const world = await newWorld();
          const { engine } = world;
          const adversary = await adversaryOf();
          const { room, devices } = await buildRoom(world, 3);
          const [alice, bob, carol] = trio(devices);
          const dave = await world.device('dave', 'd1');
          const bundle = await engine.createKeyPackage(dave.keys);
          const damaged = await adversary.forgeKeyPackage(bundle, forgery);
          await expectCode(
            () => engine.add({ state: room.state(bob), keyPackages: [damaged] }),
            MlsEngineErrorCode.SIGNATURE_INVALID,
          );
          // The library refuses to propose such a package, so the commit is assembled by hand.
          const forged = await adversary.sealedAdd(room.state(bob), [damaged]);
          await expectRefusedEverywhere(
            room,
            [alice, carol],
            forged.commit,
            MlsEngineErrorCode.SIGNATURE_INVALID,
            forged.memberDelta,
          );
        });
      }

      it('SIGNATURE_INVALID: an UpdatePath leaf whose signature does not verify is refused by every receiver', async () => {
        const world = await newWorld();
        const adversary = await adversaryOf();
        const { room, devices } = await buildRoom(world, 3);
        const [alice, bob, carol] = trio(devices);
        const commit = await adversary.selfUpdateWithBadPathSignature(room.state(bob));
        await expectRefusedEverywhere(
          room,
          [alice, carol],
          commit,
          MlsEngineErrorCode.SIGNATURE_INVALID,
        );
      });
    });

    // --- Removals are keyed by user and device ---------------------------------------------------------------
    describe('removals are keyed by user AND device (the engine code review)', () => {
      it('a served device id that two users share is never taken for either of them', async () => {
        const world = await newWorld();
        const { engine } = world;
        const alice = await world.device('alice', 'a1');
        const bob = await world.device('bob', 'x');
        const carol = await world.device('carol', 'x');
        const created = await engine.createGroup({
          conversationId: 'conv-1',
          selfLeaf: alice.keys,
        });
        const bobBundle = await engine.createKeyPackage(bob.keys);
        const addBob = await engine.add({
          state: created.state,
          keyPackages: [bobBundle.keyPackage],
        });
        const bobJoined = await engine.joinFromWelcome({
          welcome: addBob.welcome,
          keyPackagePrivate: bobBundle.keyPackagePrivate,
          expectedConversationId: 'conv-1',
          expectedGroupId: created.groupId,
          expectedEpoch: engine.epoch(addBob.state),
        });
        const carolBundle = await engine.createKeyPackage(carol.keys);
        const addCarol = await engine.add({
          state: addBob.state,
          keyPackages: [carolBundle.keyPackage],
        });
        const bobState = (
          await engine.processCommit({
            state: bobJoined.state,
            commit: addCarol.commit,
            servedMemberDelta: addCarol.memberDelta,
          })
        ).state;
        const carolLeaf = must(
          engine.members(addCarol.state).find((m) => m.userId === 'carol'),
          'carol',
        );
        const removal = await engine.remove({
          state: addCarol.state,
          leafIndexes: [carolLeaf.leafIndex],
        });
        expect(removal.memberDelta.removed).toEqual(['x']);
        // 'x' is bob's device as much as carol's: the relay's declaration does not say which was removed.
        for (const served of [removal.memberDelta.removed, ['carol:x'], ['bob:x'], []]) {
          await expectCode(
            () =>
              engine.processCommit({
                state: bobState,
                commit: removal.commit,
                servedMemberDelta: { added: [], removed: served },
              }),
            MlsEngineErrorCode.MEMBER_DELTA_MISMATCH,
          );
        }
      });
    });

    // --- Caller-supplied data is capped ---------------------------------------------------------------------
    describe('extra authenticated data is capped (the engine code review)', () => {
      it('data over the cap is refused by encrypt and by decrypt; data at the cap works', async () => {
        const world = await newWorld();
        const { engine } = world;
        const { room, devices } = await buildRoom(world, 2);
        const [alice, bob] = pair(devices);
        const text = new TextEncoder().encode('hi');
        const tooBig = new Uint8Array(MAX_AAD_EXTRA_BYTES + 1);
        const atCap = new Uint8Array(MAX_AAD_EXTRA_BYTES).fill(7);
        await expectCode(
          () => engine.encrypt(room.state(alice), text, tooBig),
          MlsEngineErrorCode.DECODE_TOO_LARGE,
        );
        const sealed = await engine.encrypt(room.state(alice), text, atCap);
        await expectCode(
          () => engine.decrypt(room.state(bob), sealed.ciphertext, tooBig),
          MlsEngineErrorCode.DECODE_TOO_LARGE,
        );
        const opened = await engine.decrypt(room.state(bob), sealed.ciphertext, atCap);
        expect(new TextDecoder().decode(opened.plaintext)).toBe('hi');
      });
    });

    // --- The relay's memberDelta ---------------------------------------------------------------------------------------
    describe("the relay's memberDelta is compared with the commit (review §4)", () => {
      it("a served delta that differs from the commit's own is refused, whatever the difference", async () => {
        const world = await newWorld();
        const { engine } = world;
        const { room, devices } = await buildRoom(world, 3);
        const [alice, bob] = pair(devices);
        const dave = await world.device('dave', 'd1');
        const bundle = await engine.createKeyPackage(dave.keys);
        const added = await engine.add({
          state: room.state(bob),
          keyPackages: [bundle.keyPackage],
        });
        const daveEntry = { deviceId: 'd1', userId: 'dave', role: DeviceRole.USER };
        const lies: [string, MemberDelta][] = [
          ['nothing declared', EMPTY_DELTA],
          ['the wrong role', { added: [{ ...daveEntry, role: DeviceRole.GUARDIAN }], removed: [] }],
          ['the wrong device', { added: [{ ...daveEntry, deviceId: 'd2' }], removed: [] }],
          ['the wrong user', { added: [{ ...daveEntry, userId: 'eve' }], removed: [] }],
          [
            'an extra add',
            {
              added: [daveEntry, { deviceId: 'x1', userId: 'dave', role: DeviceRole.USER }],
              removed: [],
            },
          ],
          ['an invented removal', { added: [daveEntry], removed: ['c1'] }],
          ['no shape at all', {} as MemberDelta],
          ['null', null as unknown as MemberDelta],
        ];
        for (const [, lie] of lies) {
          await expectCode(
            () =>
              engine.processCommit({
                state: room.state(alice),
                commit: added.commit,
                servedMemberDelta: lie,
              }),
            MlsEngineErrorCode.MEMBER_DELTA_MISMATCH,
          );
        }
        // The truth, with the extra fields a relay record carries, is accepted.
        const withRelayFields = { added: [{ ...daveEntry, keyPackageId: 'kp-1' }], removed: [] };
        const accepted = await engine.processCommit({
          state: room.state(alice),
          commit: added.commit,
          servedMemberDelta: withRelayFields,
        });
        expect(accepted.memberDelta).toEqual(added.memberDelta);
      });

      it('a removal the relay did not declare, or declared for someone else, is refused', async () => {
        const world = await newWorld();
        const { engine } = world;
        const { room, devices } = await buildRoom(world, 3);
        const [alice, bob, carol] = trio(devices);
        const removal = await engine.remove({
          state: room.state(bob),
          leafIndexes: [room.leafIndexOf(bob, carol)],
        });
        for (const lie of [
          EMPTY_DELTA,
          { added: [], removed: ['a1'] },
          { added: [], removed: ['c1', 'a1'] },
        ]) {
          await expectCode(
            () =>
              engine.processCommit({
                state: room.state(alice),
                commit: removal.commit,
                servedMemberDelta: lie,
              }),
            MlsEngineErrorCode.MEMBER_DELTA_MISMATCH,
          );
        }
      });

      it('a self-update that the relay presents as adding someone is refused', async () => {
        const world = await newWorld();
        const { engine } = world;
        const { room, devices } = await buildRoom(world, 3);
        const [alice, bob] = pair(devices);
        const update = await engine.selfUpdate(room.state(bob));
        const lie = {
          added: [{ deviceId: 'x1', userId: 'dave', role: DeviceRole.USER }],
          removed: [],
        };
        await expectCode(
          () =>
            engine.processCommit({
              state: room.state(alice),
              commit: update.commit,
              servedMemberDelta: lie,
            }),
          MlsEngineErrorCode.MEMBER_DELTA_MISMATCH,
        );
      });

      it('the order of the declared entries does not matter', async () => {
        const world = await newWorld();
        const { engine } = world;
        const { room, devices } = await buildRoom(world, 2);
        const [alice, bob] = pair(devices);
        const dave = await world.device('dave', 'd1');
        const erin = await world.device('erin', 'e1');
        const bundles = await Promise.all([dave, erin].map((d) => engine.createKeyPackage(d.keys)));
        const added = await engine.add({
          state: room.state(bob),
          keyPackages: bundles.map((b) => b.keyPackage),
        });
        const reversed = { added: [...added.memberDelta.added].reverse(), removed: [] };
        const accepted = await engine.processCommit({
          state: room.state(alice),
          commit: added.commit,
          servedMemberDelta: reversed,
        });
        expect(accepted.memberDelta.added).toHaveLength(2);
      });
    });

    // --- Welcome ------------------------------------------------------------------------------------------------------------
    describe('Welcome (RFC 9420 §12.4.3.1, review §1)', () => {
      it('WELCOME_TREE_MISMATCH: a tree with a flipped parent hash or swapped leaves is refused', async () => {
        const world = await newWorld();
        const { engine } = world;
        const adversary = await adversaryOf();
        const { room, devices } = await buildRoom(world, 4);
        const alice = must(devices[0], 'alice');
        const dave = await world.device('dave', 'd1');
        const bundle = await engine.createKeyPackage(dave.keys);

        // Control: the same Add with an untouched tree joins.
        const honest = await adversary.forceAdd(room.state(alice), [bundle.keyPackage]);
        const joined = await engine.joinFromWelcome({
          welcome: honest.welcome,
          keyPackagePrivate: bundle.keyPackagePrivate,
          expectedConversationId: 'conv-1',
          ...room.joinTarget(alice),
        });
        expect(engine.members(joined.state)).toHaveLength(5);

        for (const tamper of ['flip-parent-hash', 'swap-leaves'] as const) {
          const forged = await adversary.addWithTamperedWelcome(
            room.state(alice),
            [bundle.keyPackage],
            tamper,
          );
          await expectCode(
            () =>
              engine.joinFromWelcome({
                welcome: forged.welcome,
                keyPackagePrivate: bundle.keyPackagePrivate,
                expectedConversationId: 'conv-1',
                ...room.joinTarget(alice),
              }),
            MlsEngineErrorCode.WELCOME_TREE_MISMATCH,
          );
        }
      });

      it('DECODE_TOO_LARGE: a Welcome tree wider than MAX_GROUP_LEAVES is counted and refused before the library verifies it', async () => {
        // Verifying a tree's parent hashes is quadratic in its size, so the joiner counts the
        // leaves first (canon §9.3). The tree is correctly signed and encrypted: only its size is wrong.
        const world = await newWorld();
        const { engine } = world;
        const adversary = await adversaryOf();
        const { room, devices } = await buildRoom(world, 3);
        const alice = must(devices[0], 'alice');
        const dave = await world.device('dave', 'd1');
        const bundle = await engine.createKeyPackage(dave.keys);
        const forged = await adversary.addWithTamperedWelcome(
          room.state(alice),
          [bundle.keyPackage],
          'oversized-tree',
        );
        await expectCode(
          () =>
            engine.joinFromWelcome({
              welcome: forged.welcome,
              keyPackagePrivate: bundle.keyPackagePrivate,
              expectedConversationId: 'conv-1',
              ...room.joinTarget(alice),
            }),
          MlsEngineErrorCode.DECODE_TOO_LARGE,
        );
      });

      it('a tree in which the leaf of the GroupInfo signer was replaced fails the GroupInfo signature', async () => {
        const world = await newWorld();
        const { engine } = world;
        const adversary = await adversaryOf();
        const { room, devices } = await buildRoom(world, 4);
        const alice = must(devices[0], 'alice');
        const dave = await world.device('dave', 'd1');
        const bundle = await engine.createKeyPackage(dave.keys);
        const forged = await adversary.addWithTamperedWelcome(
          room.state(alice),
          [bundle.keyPackage],
          'swap-signer-leaf',
        );
        await expectCode(
          () =>
            engine.joinFromWelcome({
              welcome: forged.welcome,
              keyPackagePrivate: bundle.keyPackagePrivate,
              expectedConversationId: 'conv-1',
              ...room.joinTarget(alice),
            }),
          MlsEngineErrorCode.LIBRARY_REJECTED,
        );
      });

      it('LEAF_NOT_IN_SIGNED_LIST: a Welcome whose tree holds a device nobody listed is refused', async () => {
        const world = await newWorld();
        const { engine } = world;
        const adversary = await adversaryOf();
        const { room, devices } = await buildRoom(world, 3);
        const alice = must(devices[0], 'alice');
        const dave = await world.device('dave', 'd1');
        const ghost = await world.device('ghost', 'g1', DeviceRole.USER, { listed: false });
        const [daveBundle, ghostBundle] = await Promise.all(
          [dave, ghost].map((d) => engine.createKeyPackage(d.keys)),
        );
        const forged = await adversary.forceAdd(room.state(alice), [
          must(daveBundle, 'dave').keyPackage,
          must(ghostBundle, 'ghost').keyPackage,
        ]);
        await expectCode(
          () =>
            engine.joinFromWelcome({
              welcome: forged.welcome,
              keyPackagePrivate: must(daveBundle, 'dave').keyPackagePrivate,
              expectedConversationId: 'conv-1',
              ...room.joinTarget(alice),
            }),
          MlsEngineErrorCode.LEAF_NOT_IN_SIGNED_LIST,
        );
      });

      it('CONVERSATION_MISMATCH: a Welcome for another conversation is refused', async () => {
        const world = await newWorld();
        const { engine } = world;
        const alice = await world.device('alice', 'a1');
        const bob = await world.device('bob', 'b1');
        const room = await Room.create(world, alice, 'conv-other');
        const bundle = await engine.createKeyPackage(bob.keys);
        const added = await engine.add({
          state: room.state(alice),
          keyPackages: [bundle.keyPackage],
        });
        const join = (expectedConversationId: string) =>
          engine.joinFromWelcome({
            welcome: added.welcome,
            keyPackagePrivate: bundle.keyPackagePrivate,
            expectedConversationId,
            ...room.joinTarget(alice),
          });
        await expectCode(() => join('conv-1'), MlsEngineErrorCode.CONVERSATION_MISMATCH);
        // Not a conversation id at all: the caller's bug, not the Welcome's.
        await expectCode(() => join('not a valid id'), MlsEngineErrorCode.INVALID_ARGUMENT);
        expect(engine.conversationId((await join('conv-other')).state)).toBe('conv-other');
      });

      it('UNSUPPORTED_EXTENSION: a Welcome whose GroupInfo carries external_pub is refused', async () => {
        const world = await newWorld();
        const { engine } = world;
        const adversary = await adversaryOf();
        const { room, devices } = await buildRoom(world, 3);
        const alice = must(devices[0], 'alice');
        const dave = await world.device('dave', 'd1');
        const bundle = await engine.createKeyPackage(dave.keys);
        const forged = await adversary.addWithExternalPubInWelcome(room.state(alice), [
          bundle.keyPackage,
        ]);
        await expectCode(
          () =>
            engine.joinFromWelcome({
              welcome: forged.welcome,
              keyPackagePrivate: bundle.keyPackagePrivate,
              expectedConversationId: 'conv-1',
              ...room.joinTarget(alice),
            }),
          MlsEngineErrorCode.UNSUPPORTED_EXTENSION,
        );
      });

      it('GROUP_MISMATCH / EPOCH_MISMATCH: a Welcome is accepted only for the group and epoch the host expects', async () => {
        const world = await newWorld();
        const { engine } = world;
        const { room, devices } = await buildRoom(world, 3);
        const alice = must(devices[0], 'alice');
        const dave = await world.device('dave', 'd1');
        const bundle = await engine.createKeyPackage(dave.keys);
        const added = await engine.add({
          state: room.state(alice),
          keyPackages: [bundle.keyPackage],
        });
        const target = room.joinTarget(alice);
        const join = (overrides: Partial<typeof target> = {}) =>
          engine.joinFromWelcome({
            welcome: added.welcome,
            keyPackagePrivate: bundle.keyPackagePrivate,
            expectedConversationId: 'conv-1',
            ...target,
            ...overrides,
          });
        // Another group of the same conversation (a parallel group a member built), or none at all.
        await expectCode(
          () => join({ expectedGroupId: new Uint8Array(target.expectedGroupId.length) }),
          MlsEngineErrorCode.GROUP_MISMATCH,
        );
        // An expectation no group can meet is the caller's bug.
        await expectCode(
          () => join({ expectedGroupId: new Uint8Array() }),
          MlsEngineErrorCode.INVALID_ARGUMENT,
        );
        // An older or a newer epoch than the Add made.
        await expectCode(
          () => join({ expectedEpoch: target.expectedEpoch - 1n }),
          MlsEngineErrorCode.EPOCH_MISMATCH,
        );
        await expectCode(
          () => join({ expectedEpoch: target.expectedEpoch + 1n }),
          MlsEngineErrorCode.EPOCH_MISMATCH,
        );
        await expectCode(() => join({ expectedEpoch: -1n }), MlsEngineErrorCode.INVALID_ARGUMENT);
        // The right pair joins.
        const joined = await join();
        expect(engine.epoch(joined.state)).toBe(target.expectedEpoch);
      });

      it('a Welcome meant for another device cannot be opened', async () => {
        const world = await newWorld();
        const { engine } = world;
        const { room, devices } = await buildRoom(world, 2);
        const alice = must(devices[0], 'alice');
        const dave = await world.device('dave', 'd1');
        const erin = await world.device('erin', 'e1');
        const [daveBundle, erinBundle] = await Promise.all(
          [dave, erin].map((d) => engine.createKeyPackage(d.keys)),
        );
        const added = await engine.add({
          state: room.state(alice),
          keyPackages: [must(daveBundle, 'dave').keyPackage],
        });
        await expectAnyEngineError(() =>
          engine.joinFromWelcome({
            welcome: added.welcome,
            keyPackagePrivate: must(erinBundle, 'erin').keyPackagePrivate,
            expectedConversationId: 'conv-1',
            ...room.joinTarget(alice),
          }),
        );
      });
    });

    // --- Pinned parameters --------------------------------------------------------------------------------------------------
    describe('pinned suite and KeyPackage lifetime (review §1)', () => {
      it('SUITE_NOT_PINNED: another cipher suite or protocol version is refused before decoding', async () => {
        const world = await newWorld();
        const { engine } = world;
        const { room, devices } = await buildRoom(world, 2);
        const alice = must(devices[0], 'alice');
        const dave = await world.device('dave', 'd1');
        const bundle = await engine.createKeyPackage(dave.keys);

        const otherSuite = Uint8Array.from(bundle.keyPackage);
        otherSuite[SUITE_BYTE] = 2;
        await expectCode(
          () => engine.add({ state: room.state(alice), keyPackages: [otherSuite] }),
          MlsEngineErrorCode.SUITE_NOT_PINNED,
        );
        const otherVersion = Uint8Array.from(bundle.keyPackage);
        otherVersion[VERSION_BYTE] = 2;
        await expectCode(
          () => engine.add({ state: room.state(alice), keyPackages: [otherVersion] }),
          MlsEngineErrorCode.SUITE_NOT_PINNED,
        );

        const added = await engine.add({
          state: room.state(alice),
          keyPackages: [bundle.keyPackage],
        });
        const welcome = Uint8Array.from(added.welcome);
        welcome[WELCOME_SUITE_BYTE] = 2;
        await expectCode(
          () =>
            engine.joinFromWelcome({
              welcome,
              keyPackagePrivate: bundle.keyPackagePrivate,
              expectedConversationId: 'conv-1',
              ...room.joinTarget(alice),
            }),
          MlsEngineErrorCode.SUITE_NOT_PINNED,
        );
      });

      it('LIFETIME_OUT_OF_RANGE: an expired KeyPackage, or one valid for too long, is refused; the sender keeps a day of margin', async () => {
        const world = await newWorld();
        const { engine } = world;
        const { room, devices } = await buildRoom(world, 2);
        const alice = must(devices[0], 'alice');
        const dave = await world.device('dave', 'd1');
        const bundle = await engine.createKeyPackage(dave.keys);
        const created = world.nowMs;
        const add = () =>
          engine.add({ state: room.state(alice), keyPackages: [bundle.keyPackage] });

        world.nowMs = created + OUT_OF_WINDOW_DAYS * DAY_MS;
        await expectCode(add, MlsEngineErrorCode.LIFETIME_OUT_OF_RANGE);
        world.nowMs = created - FAR_PAST_DAYS * DAY_MS; // a package valid 100 days from the checker's clock
        await expectCode(add, MlsEngineErrorCode.LIFETIME_OUT_OF_RANGE);
        // Still valid for almost a day, but not for the whole margin: the sender does not offer it.
        world.nowMs = created + LAST_SENDABLE_MS + MS_PER_SECOND;
        await expectCode(add, MlsEngineErrorCode.LIFETIME_OUT_OF_RANGE);
        world.nowMs = created + LAST_SENDABLE_MS;
        expect((await add()).requiresNewcomerUpdate).toBe(true);
      });

      it('LIFETIME_OUT_OF_RANGE: a sender whose clock runs a day behind still never adds a package its receivers find expired', async () => {
        const world = await newWorld();
        const { engine } = world;
        const { room, devices } = await buildRoom(world, 3);
        const [alice, bob, carol] = trio(devices);
        const dave = await world.device('dave', 'd1');
        const bundle = await engine.createKeyPackage(dave.keys);
        const created = world.nowMs;
        const lagging = await subject.factory({
          ...world.context,
          now: () => world.nowMs - SENDER_CLOCK_LAG_MS,
        });
        const add = () =>
          lagging.add({ state: room.state(alice), keyPackages: [bundle.keyPackage] });
        // True time: the very second the package expires. The lagging sender believes it has a day
        // left, which is exactly its margin, so it adds it; a sender with a true clock would not.
        world.nowMs = created + KEY_PACKAGE_LIFETIME_SECONDS * MS_PER_SECOND;
        await expectCode(
          () => engine.add({ state: room.state(alice), keyPackages: [bundle.keyPackage] }),
          MlsEngineErrorCode.LIFETIME_OUT_OF_RANGE,
        );
        const added = await add();
        // Receivers judge it by the relay's acceptance time, the true now: inside the skew, accepted.
        for (const receiver of [bob, carol]) {
          const received = await engine.processCommit({
            state: room.state(receiver),
            commit: added.commit,
            servedMemberDelta: added.memberDelta,
            acceptedAtMs: world.nowMs,
          });
          expect(engine.epoch(received.state)).toBe(engine.epoch(room.state(receiver)) + 1n);
        }
        // One second later even the lagging sender refuses.
        world.nowMs += MS_PER_SECOND;
        await expectCode(add, MlsEngineErrorCode.LIFETIME_OUT_OF_RANGE);
      });

      it('LIFETIME_OUT_OF_RANGE: receivers judge the KeyPackage of an incoming Add by the relay-retention window, not by the sender window', async () => {
        const world = await newWorld();
        const { engine } = world;
        const adversary = await adversaryOf();
        const { room, devices } = await buildRoom(world, 3);
        const [alice, bob] = pair(devices);
        const dave = await world.device('dave', 'd1');
        const bundle = await engine.createKeyPackage(dave.keys);
        const forged = await adversary.forceAdd(room.state(bob), [bundle.keyPackage]);
        const receive = () =>
          engine.processCommit({
            state: room.state(alice),
            commit: forged.commit,
            servedMemberDelta: forged.memberDelta,
          });
        // 31 days on: past the package's own 30 days, inside the relay's backlog retention: accepted.
        world.nowMs += OUT_OF_WINDOW_DAYS * DAY_MS;
        expect(engine.epoch((await receive()).state)).toBe(engine.epoch(room.state(alice)) + 1n);
        // Far beyond the retention: nothing honest can still be waiting on this package.
        world.nowMs += FAR_PAST_DAYS * DAY_MS;
        await expectCode(receive, MlsEngineErrorCode.LIFETIME_OUT_OF_RANGE);
      });
    });

    // --- Epoch, group and message kind ------------------------------------------------------------------------------------
    describe('epoch, group and kind of message', () => {
      it('EPOCH_MISMATCH: a commit that was already applied is not applied again', async () => {
        const world = await newWorld();
        const { engine } = world;
        const { room, devices } = await buildRoom(world, 3);
        const [alice, bob] = pair(devices);
        const update = await engine.selfUpdate(room.state(bob));
        room.states.set(bob.deviceId, update.state);
        await room.deliver(update.commit, EMPTY_DELTA, [bob]);
        await expectCode(
          () =>
            engine.processCommit({
              state: room.state(alice),
              commit: update.commit,
              servedMemberDelta: EMPTY_DELTA,
            }),
          MlsEngineErrorCode.EPOCH_MISMATCH,
        );
      });

      it('GROUP_MISMATCH: a commit of another group is refused', async () => {
        const world = await newWorld();
        const other = await newWorld();
        const { room, devices } = await buildRoom(world, 2);
        const { room: otherRoom, devices: otherDevices } = await buildRoom(other, 2);
        const update = await other.engine.selfUpdate(
          otherRoom.state(must(otherDevices[1], 'other device')),
        );
        await expectCode(
          () =>
            world.engine.processCommit({
              state: room.state(must(devices[0], 'alice')),
              commit: update.commit,
              servedMemberDelta: EMPTY_DELTA,
            }),
          MlsEngineErrorCode.GROUP_MISMATCH,
        );
      });

      it('a device does not process its own commit', async () => {
        const world = await newWorld();
        const { engine } = world;
        const { room, devices } = await buildRoom(world, 2);
        const bob = pair(devices)[1];
        const update = await engine.selfUpdate(room.state(bob));
        await expectCode(
          () =>
            engine.processCommit({
              state: room.state(bob),
              commit: update.commit,
              servedMemberDelta: EMPTY_DELTA,
            }),
          MlsEngineErrorCode.UNEXPECTED_MESSAGE_KIND,
        );
        await expectCode(
          () =>
            engine.processCommit({
              state: update.state,
              commit: update.commit,
              servedMemberDelta: EMPTY_DELTA,
            }),
          MlsEngineErrorCode.EPOCH_MISMATCH,
        );
      });

      it('UNEXPECTED_MESSAGE_KIND: each entry point refuses the other kinds of message', async () => {
        const world = await newWorld();
        const { engine } = world;
        const { room, devices } = await buildRoom(world, 2);
        const [alice, bob] = pair(devices);
        const dave = await world.device('dave', 'd1');
        const bundle = await engine.createKeyPackage(dave.keys);
        const added = await engine.add({
          state: room.state(alice),
          keyPackages: [bundle.keyPackage],
        });
        const update = await engine.selfUpdate(room.state(bob));
        const chat = await engine.encrypt(room.state(alice), new TextEncoder().encode('hi'));
        const commit = (bytes: Uint8Array) =>
          engine.processCommit({
            state: room.state(bob),
            commit: bytes,
            servedMemberDelta: EMPTY_DELTA,
          });
        const join = (welcome: Uint8Array) =>
          engine.joinFromWelcome({
            welcome,
            keyPackagePrivate: bundle.keyPackagePrivate,
            expectedConversationId: 'conv-1',
            ...room.joinTarget(alice),
          });

        await expectCode(() => commit(added.welcome), MlsEngineErrorCode.UNEXPECTED_MESSAGE_KIND);
        await expectCode(
          () => commit(bundle.keyPackage),
          MlsEngineErrorCode.UNEXPECTED_MESSAGE_KIND,
        );
        await expectCode(() => commit(chat.ciphertext), MlsEngineErrorCode.UNEXPECTED_MESSAGE_KIND);
        await expectCode(() => join(update.commit), MlsEngineErrorCode.UNEXPECTED_MESSAGE_KIND);
        await expectCode(() => join(bundle.keyPackage), MlsEngineErrorCode.UNEXPECTED_MESSAGE_KIND);
        await expectCode(
          () => engine.decrypt(room.state(bob), update.commit),
          MlsEngineErrorCode.UNEXPECTED_MESSAGE_KIND,
        );
        await expectCode(
          () => engine.decrypt(room.state(bob), added.welcome),
          MlsEngineErrorCode.UNEXPECTED_MESSAGE_KIND,
        );
        await expectCode(
          () => engine.add({ state: room.state(alice), keyPackages: [added.welcome] }),
          MlsEngineErrorCode.UNEXPECTED_MESSAGE_KIND,
        );
      });
    });
  });
}
