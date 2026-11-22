/**
 * The call channel's state (ADR-228): who holds an open stream, which calls a ring has admitted (between which two
 * devices), and the budgets that keep one device or one person from flooding another. Pure and in memory: no
 * database, no socket, no timer. The HTTP layer (`apps/relay`, `routes/calls.ts`) owns the streams, the checks of who
 * may signal whom, and the clocks that close a stream.
 *
 * Why in memory: a signal is instant and never stored (the relay is a pipe, not a mailbox), so the only state is the
 * open streams themselves, the admitted calls and the counters, and all of it may be lost on restart (clients
 * reconnect; the package's adapter ends the calls whose stream it lost). Every map stops at a constant but the two
 * ring windows, which count only rings that passed the route's database checks: one entry per person and per pair of
 * people who share a one-to-one room, emptied once per window. The price is the one the other limiters pay
 * (`ttl-counter.ts`): ONE relay process. Two processes behind one address would each see half the streams and half
 * the counts; scaling out needs a shared registry, a decision for that day.
 */

import {
  CALL_LIMITS,
  CALL_STREAM_EVENT,
  type CallStreamEventName,
  type CallStreamSignal,
  callRelayCap,
  callRelayKindOf,
  type RelayCallSignal,
} from '@masia/contracts/wire';
import {
  CALL_ACCEPTED_IDLE_MS,
  CALL_ADMITTED_MAX,
  CALL_ADMITTED_PER_USER_MAX,
  CALL_CONTROL_PER_END_MAX,
  CALL_FRAME_BUDGETS_MAX,
  CALL_RING_PAIR_LIMIT,
  CALL_RING_USER_LIMIT,
  CALL_RING_VERDICTS_MAX,
  CALL_RING_WINDOW_MS,
  CALL_STREAM_BUFFER_MAX_BYTES,
  CALL_STREAMS_MAX,
  CALL_STREAMS_PER_USER_MAX,
  CALL_TALLIES_MAX,
  CALL_TALLY_IDLE_MS,
} from './protocol.js';
import { createTtlCounter } from './ttl-counter.js';

const MS_PER_SECOND = 1000;

/** One server-sent event: a name and one line of JSON (JSON text never holds a raw line break). */
export function sseEvent(event: CallStreamEventName, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** A comment line: keeps proxies and the socket's idle timer from closing a quiet stream; a client ignores it. */
export const SSE_KEEP_ALIVE = ': keep-alive\n\n';

/** The relay's end of one open stream. */
export interface CallStreamSink {
  /** Bytes written to the stream and not yet taken by its reader. */
  readonly bufferedBytes: number;
  /** Writes one already formatted frame. */
  write(frame: string): void;
  /**
   * The channel lets go of this stream: another stream of the same device took its place (`replaced`: the sink writes
   * the `replaced` event and ends), or the relay is shutting down (`closing`).
   */
  end(reason: 'replaced' | 'closing'): void;
}

/** A device and the person it speaks for. */
export interface CallChannelDevice {
  readonly deviceId: string;
  readonly userId: string;
}

export type CallStreamOpening =
  | { readonly ok: true; readonly release: () => void }
  | { readonly ok: false; readonly scope: 'user' | 'relay' };

export type CallAdmission = { readonly ok: true } | { readonly ok: false; readonly retryAfterMs: number };

export type CallRingVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly scope: 'user' | 'pair'; readonly resetsAt: number };

export interface CallChannel {
  /**
   * Registers the stream of `device`. A stream the same device already holds is ended as `replaced` (one stream per
   * device: the newest wins) and does not count against the caps; otherwise a full person or a full relay refuses.
   * `release` unregisters it (idempotent; a no-op once a newer stream replaced it).
   */
  openStream(device: CallChannelDevice, sink: CallStreamSink): CallStreamOpening;
  /**
   * One frame of the sender's budget (`CALL_LIMITS.socketFramesBurst`, then `socketFramesPerSecond`). The sender is the
   * token's user and device, both signed claims, so the route spends it before any database read; keyed on the pair, a
   * token of another account that names this device spends a budget of its own, never the device's.
   */
  admit(sender: CallChannelDevice): CallAdmission;
  /**
   * Counts a ring of call `callId` from `senderUserId` to `targetUserId` against the per-person and per-pair caps. A
   * call counts once whatever number of devices it rings. An allowed call is remembered for its ring time, so its
   * other devices' rings are not counted again; a refused one is not, and stays refused because its next ring is
   * judged (and counted) again against a cap that is already spent.
   */
  countRing(senderUserId: string, targetUserId: string, callId: string): CallRingVerdict;
  /**
   * Decides whether one signal from device `from` to device `toDeviceId` passes; false means drop it (the HTTP route
   * still answers 202).
   *
   * A `call:ring` ADMITS its call between the two devices (or refreshes it); call it only for a ring `countRing`
   * allowed. It is dropped when the ringing person already holds `CALL_ADMITTED_PER_USER_MAX` admitted calls, or the
   * relay `CALL_ADMITTED_MAX`. Any other signal passes only inside an admitted call of the same id between the same
   * two devices, in either direction: a call id nobody rang buys nothing, so inventing ids cannot dodge the per-call
   * caps. Then the signal counts against the sending device's per-call cap.
   *
   * An admitted call still ringing is forgotten after `CALL_TALLY_IDLE_MS` without a signal. Once the rung device's
   * `call:accept` and then the ringing device's `call:accepted` have passed, it is connected and kept for
   * `CALL_ACCEPTED_IDLE_MS` without one. A `call:end` either way passes and closes it: nothing more of that call passes
   * between the two devices, and the place in the person's share is free again.
   */
  countSignal(from: CallChannelDevice, toDeviceId: string, signal: RelayCallSignal): boolean;
  /**
   * Hands `event` to the target device's stream. False when there is none or its reader has fallen behind
   * (`CALL_STREAM_BUFFER_MAX_BYTES`): the signal is gone. A caller of the HTTP route never learns which.
   */
  deliver(toDeviceId: string, event: CallStreamSignal): boolean;
  /** Ends every stream (`closing`): the relay is shutting down. */
  closeAll(): void;
  /** Streams open now. */
  readonly streams: number;
  /** What the budgets hold now; each has a hard ceiling (`protocol.ts`). For tests and health. */
  readonly held: {
    readonly frameBudgets: number;
    readonly admittedCalls: number;
    readonly tallies: number;
    readonly ringVerdicts: number;
  };
}

export interface CallChannelOptions {
  /** Injected so tests can move time without sleeping. */
  readonly now?: () => number;
}

interface StreamEntry {
  readonly userId: string;
  readonly sink: CallStreamSink;
}

interface Bucket {
  readonly tokens: number;
  readonly at: number;
}

type TallyKind = 'sdp' | 'candidate' | 'verify' | 'control';

interface Tally {
  readonly firstAt: number;
  lastAt: number;
  readonly counts: Record<TallyKind, number>;
}

interface AdmittedCall {
  /** When a signal of the call last passed. */
  readonly lastAt: number;
  /** The person whose ring admitted it: their share of the admitted calls. */
  readonly userId: string;
  /** The rung device's `call:accept` has passed: the ringing device's `call:accepted` now connects the call. */
  readonly answered: boolean;
}

/** Admitted calls that share one idle life, kept oldest first (`touch`) and so swept from the front. */
interface CallTier {
  readonly calls: Map<string, AdmittedCall>;
  readonly idleMs: number;
}

/**
 * How long a call's allowed ring verdict is remembered: its ring time. The caller starts that clock before its first
 * ring and sends no ring after it, so every ring of the call falls inside; one that comes later anyway is judged
 * (and counted) again: stricter, never looser.
 */
const RING_VERDICT_TTL_MS = CALL_LIMITS.ringTimeoutMs;
/** A bucket left alone this long is full again, so forgetting it changes nothing. */
const BUCKET_REFILL_MS = (CALL_LIMITS.socketFramesBurst / CALL_LIMITS.socketFramesPerSecond) * MS_PER_SECOND;

/** Moves `key` to the end of `map`, the newest place: the maps below are kept oldest first. */
function touch<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  map.set(key, value);
}

/** Drops the entry at the front of `map`: the oldest. */
function dropOldest<V>(map: Map<string, V>): void {
  const oldest = map.keys().next();
  if (oldest.done !== true) map.delete(oldest.value);
}

/**
 * Drops the entries at the front of `map` (the oldest) for which `expired` holds, and stops at the first that is still
 * live: each entry is dropped once, so the cost is spread over the calls. A clock that steps back can leave an
 * expired entry behind a live one for a while; every read checks the time again, and the ceilings hold regardless.
 */
function sweepFront<V>(map: Map<string, V>, expired: (value: V) => boolean, dropped?: (value: V) => void): void {
  for (const [key, value] of map) {
    if (!expired(value)) return;
    map.delete(key);
    dropped?.(value);
  }
}

function addCount(counts: Map<string, number>, key: string, delta: number): void {
  const next = (counts.get(key) ?? 0) + delta;
  if (next <= 0) counts.delete(key);
  else counts.set(key, next);
}

export function createCallChannel(options: CallChannelOptions = {}): CallChannel {
  const now = options.now ?? Date.now;
  const streams = new Map<string, StreamEntry>();
  const streamsPerUser = new Map<string, number>();
  // The maps below are kept oldest first (`touch`) and swept from the front, lazily, with no timer to keep the process
  // alive; each has a hard ceiling, so one-off keys (an attacker's cheapest move) cannot grow it for ever.
  /** `user:device`, both from the token → that sender's frame budget. */
  const buckets = new Map<string, Bucket>();
  /**
   * `callId:ringingDevice:rungDevice` → the call a ring admitted between those two devices: ringing, then connected
   * once both ends have said so, and kept through the long quiet stretches of a call in progress.
   */
  const ringing: CallTier = { calls: new Map(), idleMs: CALL_TALLY_IDLE_MS };
  const connected: CallTier = { calls: new Map(), idleMs: CALL_ACCEPTED_IDLE_MS };
  const tiers = [ringing, connected] as const;
  /** Person → admitted calls their rings hold now, ringing or connected (`CALL_ADMITTED_PER_USER_MAX`). */
  const admittedPerUser = new Map<string, number>();
  /** `device:callId` → what that device has sent for that call. */
  const tallies = new Map<string, Tally>();
  /** `sender:target:callId` → when the call's allowed ring stops being remembered (allowed rings only). */
  const ringVerdicts = new Map<string, number>();
  // No constant caps these two: they count only rings that passed the route's database checks, so they hold one entry
  // per person and per pair of people who share a one-to-one room, and empty once per window (`ttl-counter.ts`).
  const ringsPerUser = createTtlCounter({ ttlMs: CALL_RING_WINDOW_MS, window: 'fixed', now });
  const ringsPerPair = createTtlCounter({ ttlMs: CALL_RING_WINDOW_MS, window: 'fixed', now });

  function unregister(deviceId: string, entry: StreamEntry): boolean {
    if (streams.get(deviceId) !== entry) return false;
    streams.delete(deviceId);
    addCount(streamsPerUser, entry.userId, -1);
    return true;
  }

  const quiet = (lastAt: number, at: number): boolean => at - lastAt >= CALL_TALLY_IDLE_MS;
  const releaseShare = (call: AdmittedCall): void => addCount(admittedPerUser, call.userId, -1);
  const admittedCount = (): number => ringing.calls.size + connected.calls.size;

  /** The admitted call `key` and its tier, if it is still live; an expired one is dropped on the way. */
  function liveCall(key: string, at: number): { readonly tier: CallTier; readonly call: AdmittedCall } | undefined {
    for (const tier of tiers) {
      const call = tier.calls.get(key);
      if (call === undefined) continue;
      if (at - call.lastAt < tier.idleMs) return { tier, call };
      tier.calls.delete(key);
      releaseShare(call);
    }
    return undefined;
  }

  /**
   * Counts `signal` against what `deviceId` has sent for its call. False, with nothing counted, when that is over the
   * call's cap for the signal's kind, or when the device needs a new tally and the tallies are full.
   */
  function countTally(deviceId: string, signal: RelayCallSignal, at: number): boolean {
    const key = `${deviceId}:${signal.callId}`;
    let tally = tallies.get(key);
    if (tally !== undefined && quiet(tally.lastAt, at)) tally = undefined;
    if (tally === undefined) {
      if (!tallies.has(key) && tallies.size >= CALL_TALLIES_MAX) return false;
      tally = { firstAt: at, lastAt: at, counts: { sdp: 0, candidate: 0, verify: 0, control: 0 } };
    }
    const kind: TallyKind =
      signal.type === 'call:ice' ? callRelayKindOf(signal.signal) : signal.type === 'call:verify' ? 'verify' : 'control';
    const cap = kind === 'control' ? CALL_CONTROL_PER_END_MAX : callRelayCap(kind, at - tally.firstAt);
    if (tally.counts[kind] >= cap) return false;
    tally.counts[kind] += 1;
    tally.lastAt = at;
    touch(tallies, key, tally);
    return true;
  }

  return {
    openStream(device, sink) {
      const existing = streams.get(device.deviceId);
      if (existing === undefined) {
        if (streams.size >= CALL_STREAMS_MAX) return { ok: false, scope: 'relay' };
        if ((streamsPerUser.get(device.userId) ?? 0) >= CALL_STREAMS_PER_USER_MAX) return { ok: false, scope: 'user' };
      } else {
        unregister(device.deviceId, existing);
        existing.sink.end('replaced');
      }
      const entry: StreamEntry = { userId: device.userId, sink };
      streams.set(device.deviceId, entry);
      addCount(streamsPerUser, device.userId, 1);
      return { ok: true, release: () => void unregister(device.deviceId, entry) };
    },

    admit(sender) {
      const at = now();
      sweepFront(buckets, (bucket) => at - bucket.at >= BUCKET_REFILL_MS);
      // Ids are wire ids, which hold no ':', so the joined key names one user and one device.
      const key = `${sender.userId}:${sender.deviceId}`;
      const { socketFramesBurst: burst, socketFramesPerSecond: perSecond } = CALL_LIMITS;
      const bucket = buckets.get(key);
      const tokens =
        bucket === undefined ? burst : Math.min(burst, bucket.tokens + ((at - bucket.at) / MS_PER_SECOND) * perSecond);
      const allowed = tokens >= 1;
      touch(buckets, key, { tokens: allowed ? tokens - 1 : tokens, at });
      // Full, the oldest budget is forgotten and its sender starts again from a full burst. Forcing that takes
      // CALL_FRAME_BUDGETS_MAX signed pairs, each in a token the host minted, sending within one refill.
      if (buckets.size > CALL_FRAME_BUDGETS_MAX) dropOldest(buckets);
      if (allowed) return { ok: true };
      return { ok: false, retryAfterMs: Math.ceil(((1 - tokens) / perSecond) * MS_PER_SECOND) };
    },

    countRing(senderUserId, targetUserId, callId) {
      const at = now();
      sweepFront(ringVerdicts, (expiresAt) => expiresAt <= at);
      // Ids are wire ids, which hold no ':', so the joined keys cannot collide.
      const key = `${senderUserId}:${targetUserId}:${callId}`;
      const knownUntil = ringVerdicts.get(key);
      if (knownUntil !== undefined && knownUntil > at) return { ok: true };
      const user = ringsPerUser.hit(senderUserId);
      if (user.count > CALL_RING_USER_LIMIT) return { ok: false, scope: 'user', resetsAt: user.resetsAt };
      const pair = ringsPerPair.hit(`${senderUserId}:${targetUserId}`);
      if (pair.count > CALL_RING_PAIR_LIMIT) return { ok: false, scope: 'pair', resetsAt: pair.resetsAt };
      // Only an allowed call is remembered: at most the per-person cap of them per person. Full anyway, it is not, and
      // the call's next ring is judged (and counted) again: stricter, never looser.
      if (knownUntil !== undefined || ringVerdicts.size < CALL_RING_VERDICTS_MAX) {
        touch(ringVerdicts, key, at + RING_VERDICT_TTL_MS);
      }
      return { ok: true };
    },

    countSignal(from, toDeviceId, signal) {
      const at = now();
      for (const tier of tiers) sweepFront(tier.calls, (call) => at - call.lastAt >= tier.idleMs, releaseShare);
      sweepFront(tallies, (tally) => quiet(tally.lastAt, at));

      // Which admitted call the signal belongs to, and which way it goes. A ring opens (or refreshes) its own, from the
      // ringing device to the rung one, within the ringing person's share and the relay's ceiling; anything else
      // needs one already, either way.
      const forward = `${signal.callId}:${from.deviceId}:${toDeviceId}`;
      const back = `${signal.callId}:${toDeviceId}:${from.deviceId}`;
      let key = forward;
      let found = liveCall(forward, at);
      if (found === undefined && signal.type !== 'call:ring') {
        key = back;
        found = liveCall(back, at);
        if (found === undefined) return false;
      }
      if (found === undefined) {
        if (admittedCount() >= CALL_ADMITTED_MAX) return false;
        if ((admittedPerUser.get(from.userId) ?? 0) >= CALL_ADMITTED_PER_USER_MAX) return false;
      }
      // Only a signal that passes keeps its call and its tally alive.
      if (!countTally(from.deviceId, signal, at)) return false;

      if (found === undefined) {
        addCount(admittedPerUser, from.userId, 1);
        touch(ringing.calls, key, { lastAt: at, userId: from.userId, answered: false });
        return true;
      }
      const { tier, call } = found;
      if (signal.type === 'call:end') {
        // Either way, an end closes the call between these two devices: the end itself passes (the route delivers it),
        // then nothing more of the call does, and its place in the person's share is free again.
        tier.calls.delete(key);
        releaseShare(call);
        return true;
      }
      // Connected only when both ends have said so: the rung device accepts, then the ringing device confirms.
      const answered = call.answered || (signal.type === 'call:accept' && key === back);
      const next = answered && signal.type === 'call:accepted' && key === forward ? connected : tier;
      if (next !== tier) tier.calls.delete(key);
      touch(next.calls, key, { lastAt: at, userId: call.userId, answered });
      return true;
    },

    deliver(toDeviceId, event) {
      // Serialised first, whether the device listens or not: an offline target costs the same work as an online one.
      const frame = sseEvent(CALL_STREAM_EVENT.SIGNAL, event);
      const entry = streams.get(toDeviceId);
      if (entry === undefined || entry.sink.bufferedBytes > CALL_STREAM_BUFFER_MAX_BYTES) return false;
      entry.sink.write(frame);
      return true;
    },

    closeAll() {
      const open = [...streams.values()];
      streams.clear();
      streamsPerUser.clear();
      for (const entry of open) entry.sink.end('closing');
    },

    get streams() {
      return streams.size;
    },

    get held() {
      return {
        frameBudgets: buckets.size,
        admittedCalls: admittedCount(),
        tallies: tallies.size,
        ringVerdicts: ringVerdicts.size,
      };
    },
  };
}
