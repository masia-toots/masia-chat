import { describe, expect, it } from 'vitest';
import {
  AAD_ID_LENGTH_PREFIX_BYTES,
  GROUP_ID_BYTES,
  MAX_AAD_EXTRA_BYTES,
  MAX_CIPHERTEXT_BYTES,
  MAX_EXPORTER_LABEL_BYTES,
  MAX_EXPORTER_LENGTH,
  MAX_HANDSHAKE_BYTES,
  MAX_ID_BYTES,
  MAX_KEY_PACKAGE_BYTES,
  MAX_KEY_PACKAGE_PRIVATE_BYTES,
  MAX_PLAINTEXT_BYTES,
  MAX_STATE_BYTES,
  PRIVATE_MESSAGE_FRAMING_BUDGET_BYTES,
} from '../constants.js';
import type { GroupState, MlsEngine } from '../mls-engine.js';
import { MlsEngineErrorCode } from '../mls-error.js';
import {
  expectAnyEngineError,
  expectCode,
  refusedCleanly,
  thrownBy,
} from './support/expect-code.js';
import { buildBulkRoom, buildRoom, EMPTY_DELTA, must, pair } from './support/fixtures.js';
import { Room } from './support/room.js';
import type { ContractSubject } from './support/subject.js';
import { TestWorld } from './support/world.js';

/**
 * ROBUSTNESS CONTRACT: whatever bytes arrive, the engine answers with an `MlsEngineError` and
 * nothing else (security review 2026-10-10 §1: "size-capped, fuzzed decode"). Three parts:
 *  - every size cap refuses BEFORE a byte is decoded, and is exact (the cap itself is not too large);
 *  - seeded fuzz: random buffers, buffers with plausible headers, and valid messages that are
 *    bit-flipped, truncated or extended, through every entry point that takes bytes;
 *  - performance: an Add in a group of 50 devices stays interactive, and a receiver processes a
 *    self-update in a full group of 64 devices whose tree is already populated by earlier updates
 *    within a stated budget. Both are skipped when `MLS_SKIP_PERF=1` (a loaded CI runner measures
 *    the runner, not the engine); the budgets are the documented numbers, so the default is to run.
 */

const PLAINTEXT_FILL = 0x61;
const AAD_FILL = 0x07;
const FUZZ_CASES = 200;
const FUZZ_SEED = 0x6d6c7331; // "mls1": fixed so a failure reproduces
const FUZZ_MAX_RANDOM_LENGTH = 600;
const FUZZ_MUTATIONS = 120;
const FUZZ_SPLICE_HEADER_MAX = 64;
const FUZZ_TIMEOUT_MS = 120_000;
const PERF_GROUP_SIZE = 50;
const PERF_ADD_BUDGET_MS = 300;
const PERF_TIMEOUT_MS = 60_000;
/** The group size the review measured the commit path at (and the size of one user's device cap on the relay). */
const PERF_COMMIT_GROUP_SIZE = 64;
/** Every PERF_COMMITTER_STRIDE-th member self-updates, so their paths cover most of the tree before the timed commit. */
const PERF_COMMITTER_STRIDE = 4;
const PERF_COMMIT_BUDGET_MS = 150;
const PERF_COMMIT_TIMEOUT_MS = 120_000;
/** Set to `1` to skip the timing assertions on a machine whose clock measures other load. */
const SKIP_PERF = process.env['MLS_SKIP_PERF'] === '1';
const BYTE_RANGE = 256;
const BITS_PER_BYTE = 8;
const JOIN_SECRETS_ENTRY = 'joinFromWelcome(keyPackagePrivate)';

/** Plausible MLSMessage prefixes: version 1 + wire format (PublicMessage, PrivateMessage, Welcome, GroupInfo, KeyPackage). */
const WIRE_PREFIXES: readonly (readonly number[])[] = [
  [0, 1, 0, 1],
  [0, 1, 0, 2],
  [0, 1, 0, 3],
  [0, 1, 0, 4],
  [0, 1, 0, 5],
];

/** A small seeded generator (mulberry32): the test must be repeatable, so no `Math.random`. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Fuzzer {
  private readonly next: () => number;

  constructor(seed: number) {
    this.next = seededRandom(seed);
  }

  int(below: number): number {
    return Math.floor(this.next() * below);
  }

  bytes(length: number): Uint8Array {
    return Uint8Array.from({ length }, () => this.int(BYTE_RANGE));
  }

  /** Pure noise of random length. */
  noise(): Uint8Array {
    return this.bytes(this.int(FUZZ_MAX_RANDOM_LENGTH));
  }

  /** A believable MLSMessage header followed by noise. */
  withPrefix(): Uint8Array {
    const prefix = WIRE_PREFIXES[this.int(WIRE_PREFIXES.length)] ?? [];
    return Uint8Array.from([...prefix, ...this.noise()]);
  }

  /** The first bytes of a real message (so group id and epoch are right) followed by noise. */
  splice(valid: Uint8Array): Uint8Array {
    const keep = this.int(Math.min(valid.length, FUZZ_SPLICE_HEADER_MAX));
    return Uint8Array.from([...valid.subarray(0, keep), ...this.noise()]);
  }

  flip(valid: Uint8Array): Uint8Array {
    const out = Uint8Array.from(valid);
    const at = this.int(out.length);
    out[at] = (out[at] ?? 0) ^ (1 << this.int(BITS_PER_BYTE));
    return out;
  }

  truncate(valid: Uint8Array): Uint8Array {
    return valid.slice(0, this.int(valid.length));
  }

  extend(valid: Uint8Array): Uint8Array {
    return Uint8Array.from([...valid, ...this.bytes(1 + this.int(BITS_PER_BYTE))]);
  }
}

interface EntryPoint {
  readonly name: string;
  /** Hands `bytes` to the engine in the position this entry point reads bytes from. */
  readonly feed: (bytes: Uint8Array) => Promise<unknown>;
}

/** Everything one fuzz run needs: valid messages of each kind, and the entry points that take them. */
async function fuzzFixture(engine: MlsEngine, world: TestWorld) {
  const { room, devices } = await buildRoom(world, 3);
  const [alice, bob] = pair(devices);
  const dave = await world.device('dave', 'd1');
  const bundle = await engine.createKeyPackage(dave.keys);
  const added = await engine.add({ state: room.state(alice), keyPackages: [bundle.keyPackage] });
  const update = await engine.selfUpdate(room.state(bob));
  const sealed = await engine.encrypt(room.state(alice), new TextEncoder().encode('fuzz'));
  const state = room.state(alice);
  const target = room.joinTarget(alice);

  const processCommit: EntryPoint = {
    name: 'processCommit',
    feed: (commit) => engine.processCommit({ state, commit, servedMemberDelta: EMPTY_DELTA }),
  };
  const joinWelcome: EntryPoint = {
    name: 'joinFromWelcome(welcome)',
    feed: (welcome) =>
      engine.joinFromWelcome({
        welcome,
        keyPackagePrivate: bundle.keyPackagePrivate,
        expectedConversationId: 'conv-1',
        ...target,
      }),
  };
  const joinSecrets: EntryPoint = {
    name: JOIN_SECRETS_ENTRY,
    feed: (keyPackagePrivate) =>
      engine.joinFromWelcome({
        welcome: added.welcome,
        keyPackagePrivate,
        expectedConversationId: 'conv-1',
        ...target,
      }),
  };
  const decrypt: EntryPoint = {
    name: 'decrypt',
    feed: (ciphertext) => engine.decrypt(state, ciphertext),
  };
  const decodeState: EntryPoint = {
    name: 'decodeState',
    feed: (bytes) => Promise.resolve(engine.decodeState(bytes)),
  };
  const add: EntryPoint = {
    name: 'add(keyPackage)',
    feed: (keyPackage) => engine.add({ state, keyPackages: [keyPackage] }),
  };

  return {
    room,
    bob,
    entryPoints: [processCommit, joinWelcome, joinSecrets, decrypt, decodeState, add] as const,
    /** Entry point and a valid message for it, for the mutation fuzz (state has its own test: a flipped key still parses). */
    mutable: [
      [processCommit, update.commit],
      [joinWelcome, added.welcome],
      [joinSecrets, bundle.keyPackagePrivate],
      [decrypt, sealed.ciphertext],
      [add, bundle.keyPackage],
    ] as const,
    realHeaders: [update.commit, added.welcome, sealed.ciphertext, bundle.keyPackage] as const,
    stateBytes: engine.encodeState(state),
    welcome: added.welcome,
    keyPackagePrivate: bundle.keyPackagePrivate,
    target,
  };
}

export function defineRobustnessContract(subject: ContractSubject): void {
  const newWorld = () => TestWorld.create(subject.factory);

  describe(`${subject.name}: robustness`, () => {
    describe('size caps are checked first, and are exact', () => {
      const over = (cap: number) => new Uint8Array(cap + 1);
      const at = (cap: number) => new Uint8Array(cap);

      async function setup() {
        const world = await newWorld();
        const { room, devices } = await buildRoom(world, 2);
        const [alice] = pair(devices);
        const dave = await world.device('dave', 'd1');
        const bundle = await world.engine.createKeyPackage(dave.keys);
        return {
          engine: world.engine,
          state: room.state(alice),
          bundle,
          target: room.joinTarget(alice),
        };
      }

      it('processCommit and joinFromWelcome refuse an oversized handshake message', async () => {
        const { engine, state, bundle, target } = await setup();
        await expectCode(
          () =>
            engine.processCommit({
              state,
              commit: over(MAX_HANDSHAKE_BYTES),
              servedMemberDelta: EMPTY_DELTA,
            }),
          MlsEngineErrorCode.DECODE_TOO_LARGE,
        );
        await expectCode(
          () =>
            engine.joinFromWelcome({
              welcome: over(MAX_HANDSHAKE_BYTES),
              keyPackagePrivate: bundle.keyPackagePrivate,
              expectedConversationId: 'conv-1',
              ...target,
            }),
          MlsEngineErrorCode.DECODE_TOO_LARGE,
        );
      });

      it('joinFromWelcome refuses oversized KeyPackage secrets', async () => {
        const { engine, target } = await setup();
        await expectCode(
          () =>
            engine.joinFromWelcome({
              welcome: new Uint8Array(),
              keyPackagePrivate: over(MAX_KEY_PACKAGE_PRIVATE_BYTES),
              expectedConversationId: 'conv-1',
              ...target,
            }),
          MlsEngineErrorCode.DECODE_TOO_LARGE,
        );
      });

      it('add refuses an oversized KeyPackage', async () => {
        const { engine, state } = await setup();
        await expectCode(
          () => engine.add({ state, keyPackages: [over(MAX_KEY_PACKAGE_BYTES)] }),
          MlsEngineErrorCode.DECODE_TOO_LARGE,
        );
      });

      it('decrypt refuses an oversized ciphertext, encrypt an oversized plaintext', async () => {
        const { engine, state } = await setup();
        await expectCode(
          () => engine.decrypt(state, over(MAX_CIPHERTEXT_BYTES)),
          MlsEngineErrorCode.DECODE_TOO_LARGE,
        );
        await expectCode(
          () => engine.encrypt(state, over(MAX_PLAINTEXT_BYTES)),
          MlsEngineErrorCode.DECODE_TOO_LARGE,
        );
      });

      it('a plaintext at the cap fits the relay envelope, with the longest conversation id and the largest extra AAD', async () => {
        const world = await newWorld();
        const { engine } = world;
        const alice = await world.device('alice', 'a1');
        const bob = await world.device('bob', 'b1');
        const longestId = 'c'.repeat(MAX_ID_BYTES);
        const room = await Room.create(world, alice, longestId);
        await room.add(alice, [bob]);
        const plaintext = new Uint8Array(MAX_PLAINTEXT_BYTES).fill(PLAINTEXT_FILL);
        for (const aad of [new Uint8Array(), new Uint8Array(MAX_AAD_EXTRA_BYTES).fill(AAD_FILL)]) {
          const sealed = await engine.encrypt(room.state(alice), plaintext, aad);
          room.states.set(alice.deviceId, sealed.state);
          expect(sealed.ciphertext.length).toBeLessThanOrEqual(MAX_CIPHERTEXT_BYTES);
          // What the cap budgets for, measured: everything around the plaintext, the group id and
          // the framed authenticated data.
          const framedAad = AAD_ID_LENGTH_PREFIX_BYTES + MAX_ID_BYTES + aad.length;
          const framing = sealed.ciphertext.length - plaintext.length - framedAad - GROUP_ID_BYTES;
          expect(framing).toBeLessThanOrEqual(PRIVATE_MESSAGE_FRAMING_BUDGET_BYTES);
          const opened = await engine.decrypt(room.state(bob), sealed.ciphertext, aad);
          room.states.set(bob.deviceId, opened.state);
          expect(opened.plaintext).toEqual(plaintext);
          expect(opened.aad).toEqual(aad);
        }
      });

      it('decodeState refuses an oversized state', async () => {
        const { engine } = await setup();
        await expectCode(
          () => engine.decodeState(over(MAX_STATE_BYTES)),
          MlsEngineErrorCode.DECODE_TOO_LARGE,
        );
      });

      it('the exporter bounds its label and its length (caller arguments: INVALID_ARGUMENT)', async () => {
        const { engine, state } = await setup();
        await expectCode(
          () => engine.exporter(state, 'x'.repeat(MAX_EXPORTER_LABEL_BYTES + 1), 32),
          MlsEngineErrorCode.INVALID_ARGUMENT,
        );
        await expectCode(
          () => engine.exporter(state, 'label', 0),
          MlsEngineErrorCode.INVALID_ARGUMENT,
        );
        await expectCode(
          () => engine.exporter(state, 'label', MAX_EXPORTER_LENGTH + 1),
          MlsEngineErrorCode.INVALID_ARGUMENT,
        );
        expect(await engine.exporter(state, 'label', MAX_EXPORTER_LENGTH)).toHaveLength(
          MAX_EXPORTER_LENGTH,
        );
      });

      it('an input of exactly the cap is read (and refused for what it is), not refused for its size', async () => {
        const { engine, state } = await setup();
        const notTooLarge = async (action: () => unknown) => {
          const thrown = (await thrownBy(action)) as { code?: unknown } | undefined;
          expect(thrown?.code).not.toBe(MlsEngineErrorCode.DECODE_TOO_LARGE);
          await expectAnyEngineError(action);
        };
        await notTooLarge(() =>
          engine.processCommit({
            state,
            commit: at(MAX_HANDSHAKE_BYTES),
            servedMemberDelta: EMPTY_DELTA,
          }),
        );
        await notTooLarge(() => engine.decrypt(state, at(MAX_CIPHERTEXT_BYTES)));
        await notTooLarge(() => engine.add({ state, keyPackages: [at(MAX_KEY_PACKAGE_BYTES)] }));
        await notTooLarge(() => engine.decodeState(at(MAX_STATE_BYTES)));
      });
    });

    describe('only MlsEngineError escapes (seeded fuzz)', () => {
      it(
        `${FUZZ_CASES} random buffers, ${FUZZ_CASES} with a plausible header, ${FUZZ_CASES} spliced onto a real header: all refused`,
        async () => {
          const world = await newWorld();
          const f = await fuzzFixture(world.engine, world);
          const fuzz = new Fuzzer(FUZZ_SEED);
          for (let i = 0; i < FUZZ_CASES; i += 1) {
            const header = must(f.realHeaders[i % f.realHeaders.length], 'header');
            for (const bytes of [fuzz.noise(), fuzz.withPrefix(), fuzz.splice(header)]) {
              for (const entry of f.entryPoints) {
                const refused = await refusedCleanly(() => entry.feed(bytes));
                expect(refused, `${entry.name} accepted ${bytes.length} random bytes`).toBe(true);
              }
            }
          }
          // None of that touched the state it was thrown at.
          await f.room.selfUpdate(f.bob);
          f.room.expectConverged();
        },
        FUZZ_TIMEOUT_MS,
      );

      it(
        'valid messages, bit-flipped, truncated or extended, are refused',
        async () => {
          const world = await newWorld();
          const { engine } = world;
          const f = await fuzzFixture(engine, world);
          const fuzz = new Fuzzer(FUZZ_SEED + 1);
          for (const [entry, valid] of f.mutable) {
            for (let i = 0; i < FUZZ_MUTATIONS; i += 1) {
              for (const mutated of [fuzz.flip(valid), fuzz.truncate(valid), fuzz.extend(valid)]) {
                let accepted: unknown;
                const refused = await refusedCleanly(async () => {
                  accepted = await entry.feed(mutated);
                });
                if (refused) continue;
                // The one honest way to accept a changed byte: a private key whose changed bit does not change the
                // key (X25519 clamps three bits of the first byte and two of the last). It must then work as before.
                expect(entry.name, `${entry.name} accepted a mutated message`).toBe(
                  JOIN_SECRETS_ENTRY,
                );
                const joined = accepted as { state: GroupState };
                expect(engine.members(joined.state)).toHaveLength(4);
                await engine.selfUpdate(joined.state);
              }
            }
          }
          // The unmutated originals still work: nothing above poisoned shared state.
          const joined = await engine.joinFromWelcome({
            welcome: f.welcome,
            keyPackagePrivate: f.keyPackagePrivate,
            expectedConversationId: 'conv-1',
            ...f.target,
          });
          expect(engine.members(joined.state)).toHaveLength(4);
        },
        FUZZ_TIMEOUT_MS,
      );

      it(
        'a mutated serialized state is either refused, or a state that itself fails cleanly',
        async () => {
          const world = await newWorld();
          const { engine } = world;
          const f = await fuzzFixture(engine, world);
          const fuzz = new Fuzzer(FUZZ_SEED + 2);
          for (let i = 0; i < FUZZ_MUTATIONS; i += 1) {
            for (const mutated of [
              fuzz.flip(f.stateBytes),
              fuzz.truncate(f.stateBytes),
              fuzz.extend(f.stateBytes),
            ]) {
              let decoded: GroupState | undefined;
              const refused = await refusedCleanly(() => {
                decoded = engine.decodeState(mutated);
              });
              if (refused || decoded === undefined) continue;
              // A flip inside a key can leave a state that still parses. Using it may fail, but only as MlsEngineError.
              const survivor = decoded;
              await refusedCleanly(() => engine.members(survivor));
              await refusedCleanly(() => engine.encrypt(survivor, new TextEncoder().encode('x')));
              await refusedCleanly(() => engine.selfUpdate(survivor));
            }
          }
        },
        FUZZ_TIMEOUT_MS,
      );

      it('inputs that are not byte arrays at all are refused cleanly', async () => {
        const world = await newWorld();
        const f = await fuzzFixture(world.engine, world);
        const notBytes: unknown[] = [undefined, null, 0, 'text', {}, [1, 2, 3], new ArrayBuffer(8)];
        for (const junk of notBytes) {
          for (const entry of f.entryPoints) {
            const refused = await refusedCleanly(() => entry.feed(junk as Uint8Array));
            expect(refused, `${entry.name} accepted ${typeof junk}`).toBe(true);
          }
        }
      });
    });

    describe('performance', () => {
      it.skipIf(SKIP_PERF)(
        `an Add in a group of ${PERF_GROUP_SIZE} devices takes under ${PERF_ADD_BUDGET_MS} ms`,
        async () => {
          const world = await newWorld();
          const { engine } = world;
          const { room, devices } = await buildBulkRoom(world, PERF_GROUP_SIZE);
          const creator = must(devices[0], 'creator');
          const newcomer = await world.device('late', 'late1');
          const bundle = await engine.createKeyPackage(newcomer.keys);

          const started = performance.now();
          const added = await engine.add({
            state: room.state(creator),
            keyPackages: [bundle.keyPackage],
          });
          const elapsed = performance.now() - started;

          expect(engine.members(added.state)).toHaveLength(PERF_GROUP_SIZE + 1);
          expect(elapsed).toBeLessThan(PERF_ADD_BUDGET_MS);
        },
        PERF_TIMEOUT_MS,
      );

      it.skipIf(SKIP_PERF)(
        `a receiver processes a self-update in a populated group of ${PERF_COMMIT_GROUP_SIZE} devices in under ${PERF_COMMIT_BUDGET_MS} ms`,
        async () => {
          const world = await newWorld();
          const { engine } = world;
          const { room, devices } = await buildBulkRoom(world, PERF_COMMIT_GROUP_SIZE);
          // A bulk Add leaves every parent node blank; real groups fill them as members update.
          // Every PERF_COMMITTER_STRIDE-th member updates in turn; only the receiver and the members
          // still to commit process each commit (the others are not measured).
          const receiver = must(devices[1], 'receiver');
          const committers = devices.filter(
            (_, i) => i % PERF_COMMITTER_STRIDE === PERF_COMMITTER_STRIDE - 2,
          );
          const timings: number[] = [];
          for (const [i, committer] of committers.entries()) {
            const update = await engine.selfUpdate(room.state(committer));
            room.states.set(committer.deviceId, update.state);
            for (const later of committers.slice(i + 1)) {
              const caught = await engine.processCommit({
                state: room.state(later),
                commit: update.commit,
                servedMemberDelta: EMPTY_DELTA,
              });
              room.states.set(later.deviceId, caught.state);
            }
            const started = performance.now();
            const processed = await engine.processCommit({
              state: room.state(receiver),
              commit: update.commit,
              servedMemberDelta: EMPTY_DELTA,
            });
            timings.push(performance.now() - started);
            room.states.set(receiver.deviceId, processed.state);
          }

          const slowest = Math.max(...timings);
          const last = must(timings.at(-1), 'the timed commit');
          console.info(
            `processCommit at ${PERF_COMMIT_GROUP_SIZE} devices: last ${last.toFixed(1)} ms, slowest ${slowest.toFixed(1)} ms over ${timings.length} commits [${timings.map((t) => t.toFixed(0)).join(' ')}]`,
          );
          expect(engine.epoch(room.state(receiver))).toBe(
            engine.epoch(room.state(must(committers.at(-1), 'last committer'))),
          );
          expect(slowest).toBeLessThan(PERF_COMMIT_BUDGET_MS);
        },
        PERF_COMMIT_TIMEOUT_MS,
      );
    });
  });
}
