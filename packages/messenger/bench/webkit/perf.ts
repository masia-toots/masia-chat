import { createTsMlsEngine } from '@masia/messenger/mls';
import { buildBulkRoom, EMPTY_DELTA, must } from '../../src/mls/__tests__/support/fixtures.js';
import { TestWorld, type TestDevice } from '../../src/mls/__tests__/support/world.js';
import { expect } from 'vitest';
import { curveStats, subtleStats } from './curves.js';
import { progress, sampleMs, statsOf, timeIt, type Stats } from './util.js';

/**
 * The performance probes. The gate is the budget in canon section 8 and in the contract suite's
 * performance smoke: an Add in a group of 50 devices takes under 300 ms. It is measured the same
 * way as there (the committer's `engine.add`, one newcomer), five times from the same group state
 * with a fresh KeyPackage each time, and the samples are kept in order so a cold first run shows.
 *
 * Around it, what a phone also pays: the receiver's `processCommit` of that Add, the newcomer's
 * `joinFromWelcome`, a self-update (create and process), and 100 messages of 4 KB each way.
 */

export const GROUP_SIZE = 50;
export const ADD_BUDGET_MS = 300;
const ADD_SAMPLES = 5;
const SELF_UPDATE_SAMPLES = 5;
const MESSAGE_COUNT = 100;
const MESSAGE_BYTES = 4096;
/** `crypto.getRandomValues` fills at most this many bytes per call. */
const RANDOM_FILL_MAX = 65_536;

/**
 * Where the browser has no Ed25519 / X25519, the bench installs a slow pure-JS stand-in (see
 * curves.ts) and a measurement carries its cost. The adjusted figure takes the time spent inside the
 * stand-in out and puts back this much per operation, a generous allowance for a native curve
 * operation (a few hundredths of a millisecond in Chromium). With native curves nothing is taken
 * out and nothing is added: adjusted equals measured.
 */
export const NATIVE_CURVE_OP_ALLOWANCE_MS = 0.25;

interface CurvedSample {
  readonly ms: number;
  readonly ops: number;
  readonly busyMs: number;
  /** WebCrypto calls the engine made during the sample. */
  readonly calls: number;
}

export interface Adjusted {
  readonly stats: Stats;
  /** Median number of curve operations in one sample. */
  readonly opsMedian: number;
  /** Median milliseconds one sample spent inside the stand-in (0 with native curves). */
  readonly busyMedianMs: number;
  /** Median number of WebCrypto calls in one sample: what a phone's per-call latency is multiplied by. */
  readonly callsMedian: number;
}

async function timeCurved<T>(action: () => Promise<T>): Promise<{ sample: CurvedSample; value: T }> {
  const ops = curveStats.ops;
  const busy = curveStats.busyMs;
  const calls = subtleStats.calls;
  const { ms, value } = await timeIt(action);
  return { sample: { ms, ops: curveStats.ops - ops, busyMs: curveStats.busyMs - busy, calls: subtleStats.calls - calls }, value };
}

function adjust(samples: readonly CurvedSample[]): Adjusted {
  return {
    stats: statsOf(samples.map((s) => Math.max(0, s.ms - s.busyMs) + s.ops * NATIVE_CURVE_OP_ALLOWANCE_MS)),
    opsMedian: statsOf(samples.map((s) => s.ops)).median,
    busyMedianMs: statsOf(samples.map((s) => s.busyMs)).median,
    callsMedian: statsOf(samples.map((s) => s.calls)).median,
  };
}

async function sampleCurved(count: number, action: (index: number) => Promise<void>): Promise<{ stats: Stats; curved: Adjusted }> {
  const taken: CurvedSample[] = [];
  for (let i = 0; i < count; i += 1) taken.push((await timeCurved(() => action(i))).sample);
  return { stats: statsOf(taken.map((s) => s.ms)), curved: adjust(taken) };
}

export interface PerfResult {
  readonly label: string;
  readonly groupSize: number;
  /** Building the group of 50 (49 KeyPackages, one Add of 49, 49 joins): informational. */
  readonly setupMs: number;
  /** THE GATE: the committer's `engine.add` of one device in a group of 50. */
  readonly addGroup50: Stats;
  /** One member's `processCommit` of that same Add. */
  readonly addProcessOneReceiver: Stats;
  /** Create plus one member's processing, sample by sample (the K1 bench's "critical path", one receiver). */
  readonly addCriticalPath: Stats;
  /** The newcomer's `joinFromWelcome` into the group of 51. */
  readonly joinFromWelcome: Stats;
  readonly createKeyPackage: Stats;
  readonly selfUpdateCreate: Stats;
  readonly selfUpdateProcess: Stats;
  readonly encrypt4KB: Stats;
  readonly decrypt4KB: Stats;
  readonly messages: {
    readonly count: number;
    readonly bytes: number;
    readonly encryptTotalMs: number;
    readonly decryptTotalMs: number;
    /** WebCrypto calls over all of the encrypts / decrypts. */
    readonly encryptCalls: number;
    readonly decryptCalls: number;
  };
  readonly stateBytes: number;
  readonly stateEncodeMs: number;
  readonly stateDecodeMs: number;
  /** The same probes with the cost of the curve stand-in taken out; equal to the measured ones with native curves. */
  readonly adjusted: {
    readonly addGroup50: Adjusted;
    readonly addProcessOneReceiver: Adjusted;
    readonly addCriticalPath: Adjusted;
    readonly joinFromWelcome: Adjusted;
    readonly selfUpdateCreate: Adjusted;
    readonly selfUpdateProcess: Adjusted;
  };
}

function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let at = 0; at < length; at += RANDOM_FILL_MAX) {
    crypto.getRandomValues(out.subarray(at, Math.min(length, at + RANDOM_FILL_MAX)));
  }
  return out;
}

export async function runPerf(label: string): Promise<PerfResult> {
  progress(`perf ${label}: building a group of ${GROUP_SIZE}`);
  const world = await TestWorld.create(createTsMlsEngine);
  const { engine } = world;

  const built = await timeIt(() => buildBulkRoom(world, GROUP_SIZE, `conv-perf-${label}`));
  const { room, devices } = built.value;
  const creator = must(devices[0], 'creator');
  const receiver = must(devices[1], 'receiver');
  expect(engine.members(room.state(creator)).length).toBe(GROUP_SIZE);
  const creatorState = room.state(creator);
  const receiverState = room.state(receiver);

  // Newcomers and their KeyPackages are made outside the timed sections (and timed on their own).
  const newcomers: TestDevice[] = [];
  for (let i = 0; i < ADD_SAMPLES; i += 1) newcomers.push(await world.device(`late${i}`, `late${i}`));
  const bundles = [] as Awaited<ReturnType<typeof engine.createKeyPackage>>[];
  const createKeyPackage = await sampleMs(ADD_SAMPLES, async (i) => {
    bundles[i] = await engine.createKeyPackage(must(newcomers[i], 'newcomer').keys);
  });

  progress(`perf ${label}: Add in a group of ${GROUP_SIZE} x${ADD_SAMPLES}`);
  const adds = [] as Awaited<ReturnType<typeof engine.add>>[];
  const addCurved: CurvedSample[] = [];
  for (let i = 0; i < ADD_SAMPLES; i += 1) {
    const bundle = must(bundles[i], 'bundle');
    const { sample, value } = await timeCurved(() =>
      engine.add({ state: creatorState, keyPackages: [bundle.keyPackage] }),
    );
    expect(engine.members(value.state).length).toBe(GROUP_SIZE + 1);
    adds.push(value);
    addCurved.push(sample);
  }
  const addSamples = addCurved.map((s) => s.ms);

  progress(`perf ${label}: processing those Adds, joining from the Welcome`);
  const processCurved: CurvedSample[] = [];
  for (const added of adds) {
    const { sample, value } = await timeCurved(() =>
      engine.processCommit({
        state: receiverState,
        commit: added.commit,
        servedMemberDelta: added.memberDelta,
      }),
    );
    expect(engine.epoch(value.state)).toBe(engine.epoch(added.state));
    processCurved.push(sample);
  }
  const processSamples = processCurved.map((s) => s.ms);
  const criticalCurved = addCurved.map((s, i): CurvedSample => {
    const p = must(processCurved[i], 'process sample');
    return { ms: s.ms + p.ms, ops: s.ops + p.ops, busyMs: s.busyMs + p.busyMs, calls: s.calls + p.calls };
  });
  const join = await sampleCurved(ADD_SAMPLES, async (i) => {
    const added = must(adds[i], 'add');
    const joined = await engine.joinFromWelcome({
      welcome: added.welcome,
      keyPackagePrivate: must(bundles[i], 'bundle').keyPackagePrivate,
      expectedConversationId: `conv-perf-${label}`,
      expectedGroupId: room.groupId,
      expectedEpoch: engine.epoch(added.state),
    });
    expect(engine.members(joined.state).length).toBe(GROUP_SIZE + 1);
  });

  progress(`perf ${label}: self-update`);
  const updates = [] as Awaited<ReturnType<typeof engine.selfUpdate>>[];
  const updateCreate = await sampleCurved(SELF_UPDATE_SAMPLES, async (i) => {
    updates[i] = await engine.selfUpdate(creatorState);
  });
  const updateProcess = await sampleCurved(SELF_UPDATE_SAMPLES, async (i) => {
    await engine.processCommit({
      state: receiverState,
      commit: must(updates[i], 'update').commit,
      servedMemberDelta: EMPTY_DELTA,
    });
  });

  progress(`perf ${label}: ${MESSAGE_COUNT} messages of ${MESSAGE_BYTES} bytes`);
  const payload = randomBytes(MESSAGE_BYTES);
  const sealed: Uint8Array[] = [];
  const encryptSamples: number[] = [];
  let sender = creatorState;
  const callsBeforeEncrypt = subtleStats.calls;
  for (let i = 0; i < MESSAGE_COUNT; i += 1) {
    const { ms, value } = await timeIt(() => engine.encrypt(sender, payload));
    sender = value.state;
    sealed.push(value.ciphertext);
    encryptSamples.push(ms);
  }
  const encryptCalls = subtleStats.calls - callsBeforeEncrypt;
  const decryptSamples: number[] = [];
  const callsBeforeDecrypt = subtleStats.calls;
  let reader = receiverState;
  for (const [i, ciphertext] of sealed.entries()) {
    const { ms, value } = await timeIt(() => engine.decrypt(reader, ciphertext));
    reader = value.state;
    decryptSamples.push(ms);
    if (i === 0 || i === MESSAGE_COUNT - 1) expect(value.plaintext).toEqual(payload);
  }

  const decryptCalls = subtleStats.calls - callsBeforeDecrypt;
  const encoded = await timeIt(() => Promise.resolve(engine.encodeState(creatorState)));
  const decoded = await timeIt(() => Promise.resolve(engine.decodeState(encoded.value)));
  expect(engine.epoch(decoded.value)).toBe(engine.epoch(creatorState));

  const sum = (samples: readonly number[]) => samples.reduce((total, value) => total + value, 0);
  return {
    label,
    groupSize: GROUP_SIZE,
    setupMs: Math.round(built.ms),
    addGroup50: statsOf(addSamples),
    addProcessOneReceiver: statsOf(processSamples),
    addCriticalPath: statsOf(criticalCurved.map((s) => s.ms)),
    joinFromWelcome: join.stats,
    createKeyPackage,
    selfUpdateCreate: updateCreate.stats,
    selfUpdateProcess: updateProcess.stats,
    encrypt4KB: statsOf(encryptSamples),
    decrypt4KB: statsOf(decryptSamples),
    messages: {
      count: MESSAGE_COUNT,
      bytes: MESSAGE_BYTES,
      encryptTotalMs: Math.round(sum(encryptSamples)),
      decryptTotalMs: Math.round(sum(decryptSamples)),
      encryptCalls,
      decryptCalls,
    },
    stateBytes: encoded.value.length,
    stateEncodeMs: Math.round(encoded.ms * 100) / 100,
    stateDecodeMs: Math.round(decoded.ms * 100) / 100,
    adjusted: {
      addGroup50: adjust(addCurved),
      addProcessOneReceiver: adjust(processCurved),
      addCriticalPath: adjust(criticalCurved),
      joinFromWelcome: join.curved,
      selfUpdateCreate: updateCreate.curved,
      selfUpdateProcess: updateProcess.curved,
    },
  };
}
