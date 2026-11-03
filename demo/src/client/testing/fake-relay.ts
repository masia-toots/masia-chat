import { RelayErrorCode, type DeviceListEntry } from '@masia/contracts/wire';
import { RelayHttpError, type ClaimedKeyPackage, type EnvelopeRow, type HandshakeRow, type RelayApi } from '../relay-api.js';

// A relay kept in memory, for the client's tests: the same answers the real one gives to the calls the
// client makes, none of its limits and none of its storage. It checks only what the client relies on:
//   - a room is opened once (CONVERSATION_EXISTS after that) and only members may read or post
//     (NOT_A_MEMBER, the same answer for a room that does not exist);
//   - a commit is built on the room's current epoch or answered EPOCH_CONFLICT, and a commit that adds
//     someone also stores the Welcome right after it and makes them a member;
//   - an envelope is sealed for the current epoch, and a `clientMsgId` posted twice is one envelope.
// The real relay is exercised by `smoke/two-people.ts` against the compose stack.

interface Room {
  epoch: number;
  members: Set<string>;
  handshakes: HandshakeRow[];
  envelopes: (EnvelopeRow & { clientMsgId: string })[];
  nextHandshakeSeq: number;
  nextEnvelopeSeq: number;
}

interface PooledKeyPackage {
  readonly deviceId: string;
  readonly keyPackageId: string;
  readonly bytes: Uint8Array;
  readonly lastResort: boolean;
}

interface Account {
  identityKey?: Uint8Array;
  deviceList?: { version: number; devices: readonly DeviceListEntry[]; signature: Uint8Array };
  keyPackages: PooledKeyPackage[];
}

export interface FakeRelay {
  /** The relay's client as seen by one signed-in device. */
  apiFor(who: { readonly userId: string; readonly deviceId: string }): RelayApi;
  /** What was asked of the relay, for a test that counts calls. */
  readonly calls: string[];
  /** Every ciphertext the relay holds, as a test of "the relay sees nothing readable". */
  stored(): { handshakes: Uint8Array[]; envelopes: Uint8Array[] };
}

const refuse = (status: number, code: string, details: Record<string, unknown> = {}): RelayHttpError =>
  new RelayHttpError(status, code, code, details);

export function createFakeRelay(): FakeRelay {
  const accounts = new Map<string, Account>();
  const rooms = new Map<string, Room>();
  const calls: string[] = [];
  let packageCounter = 0;

  const account = (userId: string): Account => {
    let found = accounts.get(userId);
    if (found === undefined) {
      found = { keyPackages: [] };
      accounts.set(userId, found);
    }
    return found;
  };

  function memberRoom(conversationId: string, userId: string): Room {
    const room = rooms.get(conversationId);
    if (room === undefined || !room.members.has(userId)) throw refuse(403, RelayErrorCode.NOT_A_MEMBER);
    return room;
  }

  return {
    calls,
    stored: () => ({
      handshakes: [...rooms.values()].flatMap((room) => room.handshakes.map((row) => row.bytes)),
      envelopes: [...rooms.values()].flatMap((room) => room.envelopes.map((row) => row.ciphertext)),
    }),
    apiFor({ userId, deviceId }) {
      const note = (name: string) => calls.push(`${userId}:${name}`);
      return {
        async registerDevice(input) {
          note('registerDevice');
          const mine = account(userId);
          mine.identityKey ??= input.identityKeyPub;
        },

        async putDeviceList(input) {
          note('putDeviceList');
          account(userId).deviceList = { version: input.version, devices: input.devices, signature: input.signature };
        },

        async getDeviceList(target) {
          note('getDeviceList');
          const list = accounts.get(target)?.deviceList;
          return list === undefined ? null : { userId: target, ...list };
        },

        async identityKeyOf(target) {
          note('identityKeyOf');
          return accounts.get(target)?.identityKey ?? null;
        },

        async uploadKeyPackages(items) {
          note('uploadKeyPackages');
          for (const item of items) {
            packageCounter += 1;
            account(userId).keyPackages.push({
              deviceId,
              keyPackageId: `kp-${packageCounter}`,
              bytes: item.bytes,
              lastResort: item.lastResort,
            });
          }
        },

        async claimKeyPackages(target) {
          note('claimKeyPackages');
          const pool = account(target).keyPackages;
          const claimed: ClaimedKeyPackage[] = [];
          for (const device of new Set(pool.map((entry) => entry.deviceId))) {
            const ordinary = pool.findIndex((entry) => entry.deviceId === device && !entry.lastResort);
            const index = ordinary >= 0 ? ordinary : pool.findIndex((entry) => entry.deviceId === device);
            const entry = pool[index];
            if (entry === undefined) continue;
            // An ordinary package is handed out once; the last-resort one keeps being served.
            if (!entry.lastResort) pool.splice(index, 1);
            claimed.push({
              deviceId: entry.deviceId,
              keyPackageId: entry.keyPackageId,
              bytes: entry.bytes,
              lastResort: entry.lastResort,
            });
          }
          return claimed;
        },

        async openRoom(conversationId) {
          note('openRoom');
          if (rooms.has(conversationId)) throw refuse(409, RelayErrorCode.CONVERSATION_EXISTS);
          rooms.set(conversationId, {
            epoch: 0,
            members: new Set([userId]),
            handshakes: [],
            envelopes: [],
            nextHandshakeSeq: 1,
            nextEnvelopeSeq: 1,
          });
          return 0;
        },

        async postHandshake(conversationId, input) {
          note('postHandshake');
          const room = memberRoom(conversationId, userId);
          if (input.expectedEpoch !== room.epoch) {
            throw refuse(409, RelayErrorCode.EPOCH_CONFLICT, { currentEpoch: room.epoch });
          }
          const createdAt = new Date().toISOString();
          const seq = room.nextHandshakeSeq;
          room.handshakes.push({
            seq,
            epoch: input.expectedEpoch,
            kind: 'COMMIT',
            senderDeviceId: input.senderDeviceId,
            bytes: input.bytes,
            memberDelta: input.memberDelta,
            createdAt,
          });
          room.nextHandshakeSeq += 1;
          if (input.welcome !== undefined) {
            room.handshakes.push({
              seq: room.nextHandshakeSeq,
              epoch: input.expectedEpoch,
              kind: 'WELCOME',
              senderDeviceId: input.senderDeviceId,
              bytes: input.welcome,
              memberDelta: null,
              createdAt,
            });
            room.nextHandshakeSeq += 1;
          }
          for (const added of input.memberDelta.added) room.members.add(added.userId);
          room.epoch += 1;
          return { epoch: room.epoch, seq };
        },

        async listHandshakes(conversationId, query) {
          note('listHandshakes');
          const room = memberRoom(conversationId, userId);
          const rows = room.handshakes.filter((row) => row.seq > query.afterSeq && row.epoch >= query.fromEpoch);
          return { rows, oldestAvailableSeq: 1, removedAtEpoch: null };
        },

        async postEnvelope(conversationId, input) {
          note('postEnvelope');
          const room = memberRoom(conversationId, userId);
          const again = room.envelopes.find(
            (row) => row.clientMsgId === input.clientMsgId && row.senderDeviceId === input.senderDeviceId,
          );
          if (again !== undefined) return { seq: again.seq };
          if (input.epoch !== room.epoch) {
            throw refuse(409, RelayErrorCode.EPOCH_CONFLICT, { currentEpoch: room.epoch });
          }
          const seq = room.nextEnvelopeSeq;
          room.nextEnvelopeSeq += 1;
          room.envelopes.push({
            seq,
            epoch: input.epoch,
            senderDeviceId: input.senderDeviceId,
            ciphertext: input.ciphertext,
            createdAt: new Date().toISOString(),
            clientMsgId: input.clientMsgId,
          });
          return { seq };
        },

        async listEnvelopes(conversationId, query) {
          note('listEnvelopes');
          const room = memberRoom(conversationId, userId);
          return {
            rows: room.envelopes.filter((row) => row.seq > query.afterSeq),
            oldestAvailableSeq: 1,
            removedAtEpoch: null,
          };
        },
      };
    },
  };
}
