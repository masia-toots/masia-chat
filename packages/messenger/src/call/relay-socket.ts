/**
 * The call socket over an open relay's call channel: the `CallSocketPort` the engine (`call-engine.ts`) drives, made
 * of one server-sent-event stream (`GET /calls/stream`) and one POST per signal (`POST /calls/signal`), with no other
 * server. The relay is a pipe: it checks who may signal whom, stamps the sender from its own records and stores
 * nothing. Everything a call server would decide, this adapter decides at the two ends:
 *
 * - **The caller mints the call id** (16 random bytes) and answers the engine's `call:invite` itself; it rings each
 *   device the host names (`ringTargets`: the other person's devices in the room), one POST each.
 * - **The first device to accept wins.** The caller tells it (`call:accepted`) and tells every other rung device the
 *   call was answered elsewhere; a later accept gets the same.
 * - **Each end pins its peer:** the callee to the device that rang it, the caller to the device that won. A signal of
 *   the call from any other device, even one of the same person, is dropped; so is an offer from the callee or an
 *   answer from the caller.
 * - **A call id is heard once:** a ring whose id this device has seen is dropped (a replay).
 * - **The caller times the ring** (`CALL_LIMITS.ringTimeoutMs`) and ends it as `no-answer` on both sides.
 * - **Signals of one call go out one at a time**, in order.
 *
 * The token rides the `Authorization` header of every request (never a query string), so there is no `EventSource`:
 * the stream is read with `fetch`. It is opened again before the token expires (the relay closes it then), with
 * backoff after a failure. A stream another tab opened for the same device ends this one for good.
 *
 * What the relay's operator still sees: who signals whom and when, both devices' addresses and every SDP. It cannot
 * hear the call (the media is end-to-end and the fingerprint is checked through the MLS room). There are no blocks,
 * quiet hours or child rules on this path: it is meant for a trusted relay.
 *
 * No globals are read at import time: `fetch`, the clock and the randomness come in through the options (with the
 * platform's as defaults, read when first used). No UI framework, no DOM-only API: it runs in Node tests as is.
 */
import {
  CALL_ID_PATTERN,
  CALL_LIMITS,
  CALL_RELAY_LIMITS,
  CALL_RELAY_PATH,
  CALL_STREAM_EVENT,
  MAX_DEVICES_PER_USER,
  parseCallStreamReady,
  parseCallStreamSignal,
  RELAY_CALL_SIGNAL,
  type CallClientEvent,
  type CallEndReason,
  type CallSignalRequest,
  type CallStreamSignal,
  type RelayCallEndReason,
  type RelayCallSignal,
} from '@masia/contracts/wire';
import type { CallSocketPort } from './call-engine.js';

/** What the adapter needs of a response: global `fetch`'s `Response` fits. */
export interface RelayFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  readonly body: ReadableStream<Uint8Array> | null;
}

/** What the adapter needs of `fetch`: global `fetch` fits. */
export type RelayFetch = (
  url: string,
  init: {
    readonly method: 'GET' | 'POST';
    readonly headers: Record<string, string>;
    readonly body?: string;
    readonly signal?: AbortSignal;
  },
) => Promise<RelayFetchResponse>;

export interface RelayCallSocketOptions {
  /** The relay's base URL, its base path included (`https://relay.example/relay`); no trailing slash needed. */
  readonly baseUrl: string;
  /** The access token for this device, asked again before every request (the host refreshes it). */
  readonly token: () => string | Promise<string>;
  /** The devices to ring for a call placed in `conversationId`: the OTHER person's devices in that room. */
  readonly ringTargets: (conversationId: string) => Promise<readonly string[]>;
  /** Default: the global `fetch`, read when first used. */
  readonly fetch?: RelayFetch;
  /** Default: `Date.now`. */
  readonly now?: () => number;
  /** Fills a buffer with secure random bytes. Default: the platform's `crypto.getRandomValues`. */
  readonly randomBytes?: (bytes: Uint8Array) => void;
  /** In [0, 1): the jitter of the backoff. Default: `Math.random`. */
  readonly random?: () => number;
  /** The backoff between failed attempts to open the stream: from `baseMs`, doubling, up to `maxMs`. */
  readonly reconnect?: { readonly baseMs?: number; readonly maxMs?: number };
}

/** The close codes `onClosed` reports. */
export const RELAY_SOCKET_CLOSE = {
  /** The stream was lost; the adapter is opening it again. */
  LOST: 1006,
  /** `close()` was called. */
  CLOSED: 1000,
  /** Another stream for this device took over (another tab or app): this one stopped for good. */
  REPLACED: 4409,
  /** The relay refused this device (not a USER device, the call channel off): stopped for good. */
  REFUSED: 4403,
} as const;

export type RelayCallSocketStatus = 'connecting' | 'open' | 'waiting' | 'stopped';

export interface RelayCallSocket extends CallSocketPort {
  /** Stops for good: the stream is closed, nothing is opened again, open calls end (best effort, at the peer too). */
  close(): void;
  status(): RelayCallSocketStatus;
}

const DEFAULTS = {
  reconnectBaseMs: 1_000,
  reconnectMaxMs: 30_000,
  /** The next stream is opened this long before the token (and so the stream) expires… */
  rotateLeadMs: 30_000,
  /** …unless what is left is shorter than this: then the stream simply ends and is opened again. */
  rotateMinMs: 5_000,
  /** A failed early reopen is tried again after this, while the old stream still runs. */
  rotateRetryMs: 5_000,
  /** Calls this device keeps state for at once; a ring over it is dropped. */
  callsMax: 32,
  /** Call ids remembered as seen, and for how long. */
  seenMax: 256,
  seenTtlMs: 30 * 60_000,
  /** A callee's ring left unanswered is forgotten after this (the engine keeps its own deadline). */
  ringForgetMs: 2 * CALL_LIMITS.ringTimeoutMs,
  /** One stream event, at most: the largest signal the relay takes, plus its envelope. */
  eventMaxChars: CALL_RELAY_LIMITS.signalBodyMaxBytes + 1_024,
} as const;

const CALL_ID_BYTES = 16;
const HTTP_ACCEPTED = 202;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_TOO_MANY = 429;
const MS_PER_SECOND = 1_000;

type Phase = 'ringing' | 'accepting' | 'connected';

interface CallRecord {
  readonly callId: string;
  readonly role: 'caller' | 'callee';
  readonly conversationId: string;
  /** This device, as the engine named it in its invite or accept. */
  localDeviceId: string;
  phase: Phase;
  /** Callee: the device that rang (pinned at the ring). Caller: the device that won (pinned at the accept). */
  peer: string | null;
  /** Caller: the devices rung so far. */
  readonly rung: Set<string>;
  timer: ReturnType<typeof setTimeout> | null;
}

interface Connection {
  readonly controller: AbortController;
  /** Let go of on purpose: whatever it does from now on is not news. */
  retired: boolean;
}

function base64Url(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let out = '';
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      out += alphabet[(value >> bits) & 63];
    }
  }
  if (bits > 0) out += alphabet[(value << (6 - bits)) & 63];
  return out;
}

/** The relay's Retry-After, never more than `capMs`: a relay (or whatever answers in its place) cannot park us for a day. */
function retryAfterMs(response: RelayFetchResponse, capMs: number): number | null {
  const header = response.headers.get('retry-after');
  const seconds = header === null ? NaN : Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(capMs, seconds * MS_PER_SECOND) : null;
}

export function createRelayCallSocket(options: RelayCallSocketOptions): RelayCallSocket {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const now = options.now ?? (() => Date.now());
  const random = options.random ?? (() => Math.random());
  const randomBytes = options.randomBytes ?? ((bytes: Uint8Array) => void globalThis.crypto.getRandomValues(bytes));
  const doFetch: RelayFetch = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const reconnectBaseMs = options.reconnect?.baseMs ?? DEFAULTS.reconnectBaseMs;
  const reconnectMaxMs = options.reconnect?.maxMs ?? DEFAULTS.reconnectMaxMs;

  const frameListeners = new Set<(raw: unknown) => void>();
  const closeListeners = new Set<(code: number) => void>();
  const calls = new Map<string, CallRecord>();
  const seen = new Map<string, number>();
  const chains = new Map<string, Promise<void>>();

  let status: RelayCallSocketStatus = 'connecting';
  let open = false;
  let current: Connection | null = null;
  let next: Connection | null = null;
  let attempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let rotateTimer: ReturnType<typeof setTimeout> | null = null;

  // ── to the engine ──────────────────────────────────────────────────────────────────────────────────

  function emit(type: string, payload: object): void {
    const frame = { type, payload };
    for (const listener of [...frameListeners]) listener(frame);
  }

  function emitEnd(callId: string, reason: CallEndReason): void {
    emit('call:end', { callId, reason });
  }

  function notifyClosed(code: number): void {
    for (const listener of [...closeListeners]) listener(code);
  }

  // ── to the relay ───────────────────────────────────────────────────────────────────────────────────

  async function postSignal(conversationId: string, toDeviceId: string, signal: RelayCallSignal): Promise<number> {
    const body: CallSignalRequest = { conversationId, toDeviceId, signal };
    try {
      const response = await doFetch(`${baseUrl}${CALL_RELAY_PATH.SIGNAL}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${await options.token()}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return response.status;
    } catch {
      return 0;
    }
  }

  /** Runs `task` after every earlier task of the same call: one POST at a time, in order. */
  function enqueue(callId: string, task: () => Promise<void>): void {
    const previous = chains.get(callId) ?? Promise.resolve();
    const chained = previous.then(task, task).catch(() => undefined);
    chains.set(callId, chained);
    void chained.then(() => {
      if (chains.get(callId) === chained) chains.delete(callId);
    });
  }

  function send(record: CallRecord, toDeviceId: string, signal: RelayCallSignal): void {
    enqueue(record.callId, async () => {
      await postSignal(record.conversationId, toDeviceId, signal);
    });
  }

  /** Ends `reason` to every rung device but `except`, at the time the queue gets there (rings may be in flight). */
  function endRung(record: CallRecord, reason: RelayCallEndReason, except: string | null = null): void {
    enqueue(record.callId, async () => {
      for (const device of record.rung) {
        if (device !== except) await postSignal(record.conversationId, device, { type: 'call:end', callId: record.callId, reason });
      }
    });
  }

  // ── bookkeeping ────────────────────────────────────────────────────────────────────────────────────

  function markSeen(callId: string): void {
    const at = now();
    for (const [id, expiresAt] of seen) {
      if (expiresAt > at && seen.size < DEFAULTS.seenMax) break;
      seen.delete(id);
    }
    seen.set(callId, at + DEFAULTS.seenTtlMs);
  }

  function wasSeen(callId: string): boolean {
    const expiresAt = seen.get(callId);
    return expiresAt !== undefined && expiresAt > now();
  }

  function drop(record: CallRecord): void {
    if (record.timer !== null) clearTimeout(record.timer);
    record.timer = null;
    calls.delete(record.callId);
  }

  function mintCallId(): string {
    const bytes = new Uint8Array(CALL_ID_BYTES);
    randomBytes(bytes);
    return base64Url(bytes);
  }

  // ── what the engine sends ──────────────────────────────────────────────────────────────────────────

  function onClientEvent(event: CallClientEvent): void {
    switch (event.type) {
      case 'call:invite':
        placeCall(event.payload.requestId, event.payload.conversationId, event.payload.deviceId);
        return;
      case 'call:accept': {
        const record = calls.get(event.payload.callId);
        if (record?.role !== 'callee' || record.phase !== 'ringing' || record.peer === null) return;
        record.phase = 'accepting';
        record.localDeviceId = event.payload.deviceId;
        if (record.timer !== null) clearTimeout(record.timer);
        record.timer = null;
        send(record, record.peer, { type: 'call:accept', callId: record.callId });
        return;
      }
      case 'call:decline': {
        const record = calls.get(event.payload.callId);
        if (record?.role !== 'callee' || record.peer === null) return;
        drop(record);
        send(record, record.peer, { type: 'call:decline', callId: record.callId });
        return;
      }
      case 'call:ice': {
        const record = calls.get(event.payload.callId);
        if (record?.phase !== 'connected' || record.peer === null) return;
        const { signal } = event.payload;
        // The offer is the caller's to send, the answer the callee's: the other way round is a confused engine.
        if ((signal.kind === 'offer' && record.role !== 'caller') || (signal.kind === 'answer' && record.role !== 'callee')) {
          return;
        }
        send(record, record.peer, { type: 'call:ice', callId: record.callId, signal });
        return;
      }
      case 'call:verify': {
        const record = calls.get(event.payload.callId);
        if (record?.phase !== 'connected' || record.peer === null) return;
        send(record, record.peer, { type: 'call:verify', callId: record.callId, tag: event.payload.tag });
        return;
      }
      case 'call:end': {
        const record = calls.get(event.payload.callId);
        if (record === undefined) return;
        drop(record);
        if (record.role === 'caller' && record.phase === 'ringing') {
          endRung(record, 'cancelled');
        } else if (record.role === 'callee' && record.phase === 'ringing' && record.peer !== null) {
          send(record, record.peer, { type: 'call:decline', callId: record.callId });
        } else if (record.peer !== null) {
          send(record, record.peer, { type: 'call:end', callId: record.callId, reason: event.payload.reason });
        }
        return;
      }
      case 'call:ringing':
        // A call server's question ("which call rings here?"); the ring itself is already here.
        return;
    }
  }

  function placeCall(requestId: string, conversationId: string, localDeviceId: string): void {
    const callId = mintCallId();
    markSeen(callId);
    const record: CallRecord = {
      callId,
      role: 'caller',
      conversationId,
      localDeviceId,
      phase: 'ringing',
      peer: null,
      rung: new Set(),
      timer: null,
    };
    const ringUntil = new Date(now() + CALL_LIMITS.ringTimeoutMs).toISOString();
    // The ack, as a call server would send it: after `send` has returned, never inside it.
    queueMicrotask(() => emit('call:invite', { requestId, callId, ringUntil }));
    if (calls.size >= DEFAULTS.callsMax) {
      queueMicrotask(() => emitEnd(callId, 'unavailable'));
      return;
    }
    calls.set(callId, record);
    record.timer = setTimeout(() => {
      if (calls.get(callId) !== record || record.phase !== 'ringing') return;
      drop(record);
      emitEnd(callId, 'no-answer');
      endRung(record, 'no-answer');
    }, CALL_LIMITS.ringTimeoutMs);

    enqueue(callId, async () => {
      let targets: readonly string[];
      try {
        targets = [...new Set(await options.ringTargets(conversationId))].slice(0, MAX_DEVICES_PER_USER);
      } catch {
        targets = [];
      }
      for (const target of targets) {
        if (calls.get(callId) !== record || record.phase !== 'ringing') return;
        // Counted before the answer: an accept may come back before this POST does.
        record.rung.add(target);
        const answer = await postSignal(conversationId, target, { type: 'call:ring', callId });
        if (answer === HTTP_ACCEPTED) continue;
        record.rung.delete(target);
        if (answer === HTTP_TOO_MANY && calls.get(callId) === record) {
          drop(record);
          emitEnd(callId, 'rate-limited');
          for (const device of record.rung) {
            await postSignal(conversationId, device, { type: 'call:end', callId, reason: 'cancelled' });
          }
          return;
        }
      }
      if (calls.get(callId) === record && record.phase === 'ringing' && record.rung.size === 0) {
        drop(record);
        emitEnd(callId, 'unavailable');
      }
    });
  }

  // ── what the relay delivers ────────────────────────────────────────────────────────────────────────

  function onSignal(event: CallStreamSignal): void {
    const { signal, fromDeviceId, conversationId } = event;
    if (signal.type === RELAY_CALL_SIGNAL.RING) {
      onRing(event);
      return;
    }
    const record = calls.get(signal.callId);
    if (record === undefined || record.conversationId !== conversationId) return;

    switch (signal.type) {
      case 'call:accept': {
        if (record.role !== 'caller' || !record.rung.has(fromDeviceId)) return;
        if (record.phase === 'ringing') {
          record.phase = 'connected';
          record.peer = fromDeviceId;
          if (record.timer !== null) clearTimeout(record.timer);
          record.timer = null;
          emit('call:accept', { callId: record.callId, callerDeviceId: record.localDeviceId, calleeDeviceId: fromDeviceId });
          send(record, fromDeviceId, { type: 'call:accepted', callId: record.callId });
          endRung(record, 'answered-elsewhere', fromDeviceId);
        } else if (fromDeviceId !== record.peer) {
          send(record, fromDeviceId, { type: 'call:end', callId: record.callId, reason: 'answered-elsewhere' });
        }
        return;
      }
      case 'call:accepted': {
        if (record.role !== 'callee' || record.phase !== 'accepting' || fromDeviceId !== record.peer) return;
        record.phase = 'connected';
        emit('call:accept', { callId: record.callId, callerDeviceId: record.peer, calleeDeviceId: record.localDeviceId });
        return;
      }
      case 'call:decline': {
        if (record.role !== 'caller' || record.phase !== 'ringing' || !record.rung.has(fromDeviceId)) return;
        drop(record);
        emitEnd(record.callId, 'declined');
        endRung(record, 'declined', fromDeviceId);
        return;
      }
      case 'call:ice': {
        if (fromDeviceId !== record.peer || record.phase === 'ringing') return;
        const kind = signal.signal.kind;
        if ((kind === 'offer' && record.role !== 'callee') || (kind === 'answer' && record.role !== 'caller')) return;
        emit('call:ice', { callId: record.callId, signal: signal.signal });
        return;
      }
      case 'call:verify': {
        if (fromDeviceId !== record.peer || record.phase !== 'connected') return;
        emit('call:verify', { callId: record.callId, tag: signal.tag });
        return;
      }
      case 'call:end': {
        // While it rings, only the caller ends a call (a callee device that leaves just stops ringing).
        if (fromDeviceId !== record.peer) return;
        drop(record);
        emitEnd(record.callId, signal.reason);
        return;
      }
    }
  }

  function onRing(event: CallStreamSignal): void {
    const { callId } = event.signal;
    // Heard once: a ring this device has seen (a replay, or one of its own calls) is not a new call.
    if (wasSeen(callId) || calls.has(callId)) return;
    markSeen(callId);
    if (calls.size >= DEFAULTS.callsMax) return;
    const record: CallRecord = {
      callId,
      role: 'callee',
      conversationId: event.conversationId,
      localDeviceId: '',
      phase: 'ringing',
      peer: event.fromDeviceId,
      rung: new Set(),
      timer: null,
    };
    calls.set(callId, record);
    record.timer = setTimeout(() => {
      if (calls.get(callId) === record && record.phase === 'ringing') drop(record);
    }, DEFAULTS.ringForgetMs);
    emit('call:ring', {
      callId,
      conversationId: event.conversationId,
      // As the relay knows the caller, never as anything in the signal says.
      callerUserId: event.fromUserId,
      callerDeviceId: event.fromDeviceId,
      ringUntil: new Date(now() + CALL_LIMITS.ringTimeoutMs).toISOString(),
      silent: false,
    });
  }

  // ── the stream ─────────────────────────────────────────────────────────────────────────────────────

  function clearTimer(timer: ReturnType<typeof setTimeout> | null): null {
    if (timer !== null) clearTimeout(timer);
    return null;
  }

  function retire(connection: Connection | null): void {
    if (connection === null) return;
    connection.retired = true;
    connection.controller.abort();
  }

  /** The calls this stream carried end with it, as the engine ends them; a ring still waiting survives. */
  function endCallsOnLoss(): void {
    for (const record of [...calls.values()]) {
      if (record.role === 'callee' && record.phase === 'ringing') continue;
      drop(record);
      // Best effort: the POST route may still work when only the stream died.
      if (record.role === 'caller' && record.phase === 'ringing') endRung(record, 'cancelled');
      else if (record.peer !== null) send(record, record.peer, { type: 'call:end', callId: record.callId, reason: 'lost' });
    }
  }

  function stop(code: number): void {
    if (status === 'stopped') return;
    const wasOpen = open;
    status = 'stopped';
    open = false;
    reconnectTimer = clearTimer(reconnectTimer);
    rotateTimer = clearTimer(rotateTimer);
    retire(current);
    retire(next);
    current = null;
    next = null;
    endCallsOnLoss();
    for (const record of [...calls.values()]) drop(record);
    if (wasOpen) notifyClosed(code);
  }

  function lost(delayMs: number | null): void {
    if (status === 'stopped') return;
    const wasOpen = open;
    open = false;
    rotateTimer = clearTimer(rotateTimer);
    retire(current);
    retire(next);
    current = null;
    next = null;
    if (wasOpen) {
      endCallsOnLoss();
      notifyClosed(RELAY_SOCKET_CLOSE.LOST);
    }
    status = 'waiting';
    const backoff = Math.min(reconnectMaxMs, reconnectBaseMs * 2 ** attempt);
    attempt += 1;
    // Full jitter on the backoff, never below the relay's own Retry-After (itself capped at `reconnectMaxMs`).
    const wait = Math.max(delayMs ?? 0, Math.floor(backoff / 2 + (random() * backoff) / 2));
    reconnectTimer = clearTimer(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect(false);
    }, wait);
  }

  /** `closesInMs` comes through `parseCallStreamReady`, which caps it at the longest a stream can live. */
  function scheduleRotation(closesInMs: number): void {
    rotateTimer = clearTimer(rotateTimer);
    if (closesInMs < DEFAULTS.rotateMinMs) return;
    const lead = Math.min(DEFAULTS.rotateLeadMs, closesInMs / 2);
    rotateTimer = setTimeout(() => {
      rotateTimer = null;
      if (status === 'open' && next === null) connect(true);
    }, closesInMs - lead);
  }

  function connect(rotation: boolean): void {
    if (status === 'stopped') return;
    const connection: Connection = { controller: new AbortController(), retired: false };
    if (rotation) {
      next = connection;
    } else {
      current = connection;
      status = 'connecting';
    }
    void run(connection);
  }

  /** The stream ended or failed without being let go of: what that means depends on what it was. */
  function onConnectionEnd(connection: Connection, failure: { status: number; retryAfterMs: number | null } | null): void {
    if (connection.retired || status === 'stopped') return;
    connection.retired = true;
    if (failure !== null && (failure.status === HTTP_FORBIDDEN || failure.status === HTTP_NOT_FOUND)) {
      stop(RELAY_SOCKET_CLOSE.REFUSED);
      return;
    }
    if (connection === next) {
      next = null;
      if (current === null || current.retired) {
        lost(failure?.retryAfterMs ?? null);
      } else {
        // The running stream still has time: try the early reopen again.
        rotateTimer = clearTimer(rotateTimer);
        rotateTimer = setTimeout(() => {
          rotateTimer = null;
          if (status === 'open' && next === null) connect(true);
        }, Math.max(DEFAULTS.rotateRetryMs, failure?.retryAfterMs ?? 0));
      }
      return;
    }
    if (connection === current) {
      if (next !== null) return; // the reopen under way takes over
      lost(failure?.retryAfterMs ?? null);
    }
  }

  function onStreamEvent(connection: Connection, name: string, data: string): void {
    if (connection.retired || status === 'stopped') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    if (name === CALL_STREAM_EVENT.READY) {
      const ready = parseCallStreamReady(parsed);
      if (ready === null) return;
      if (connection === next) {
        const previous = current;
        current = connection;
        next = null;
        retire(previous);
      } else if (connection !== current) {
        return;
      }
      attempt = 0;
      status = 'open';
      open = true;
      scheduleRotation(ready.closesInMs);
    } else if (name === CALL_STREAM_EVENT.REPLACED) {
      if (connection !== current) return;
      if (next !== null) {
        // Our own reopen took the device's place: expected.
        connection.retired = true;
        return;
      }
      // Another tab or app opened this device's stream: two would fight over it, so this one stops.
      stop(RELAY_SOCKET_CLOSE.REPLACED);
    } else if (name === CALL_STREAM_EVENT.SIGNAL) {
      const signal = parseCallStreamSignal(parsed);
      if (signal !== null) onSignal(signal);
    }
  }

  async function run(connection: Connection): Promise<void> {
    let response: RelayFetchResponse;
    try {
      response = await doFetch(`${baseUrl}${CALL_RELAY_PATH.STREAM}`, {
        method: 'GET',
        headers: { authorization: `Bearer ${await options.token()}`, accept: 'text/event-stream' },
        signal: connection.controller.signal,
      });
    } catch {
      onConnectionEnd(connection, null);
      return;
    }
    if (response.status !== 200 || response.body === null) {
      // A refused token (401) is asked for again on the next try; on a reopen, the old stream runs on meanwhile.
      onConnectionEnd(connection, { status: response.status, retryAfterMs: retryAfterMs(response, reconnectMaxMs) });
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let silence: ReturnType<typeof setTimeout> | null = null;
    const armSilence = (): void => {
      silence = clearTimer(silence);
      // The relay writes at least a keep-alive this often; a quiet stream is a dead one.
      silence = setTimeout(() => connection.controller.abort(), CALL_RELAY_LIMITS.silenceMs);
    };
    armSilence();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        armSilence();
        buffer += decoder.decode(value, { stream: true }).replace(/\r/g, '');
        let cut = buffer.indexOf('\n\n');
        while (cut >= 0) {
          const block = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          let name = 'message';
          const data: string[] = [];
          for (const line of block.split('\n')) {
            if (line.startsWith(':')) continue;
            const colon = line.indexOf(':');
            const field = colon < 0 ? line : line.slice(0, colon);
            const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
            if (field === 'event') name = value;
            else if (field === 'data') data.push(value);
          }
          if (data.length > 0) onStreamEvent(connection, name, data.join('\n'));
          cut = buffer.indexOf('\n\n');
        }
        // A frame larger than any the relay sends is not one: drop the stream rather than grow without end.
        if (buffer.length > DEFAULTS.eventMaxChars) break;
      }
    } catch {
      // Aborted, or the connection failed.
    } finally {
      silence = clearTimer(silence);
      connection.controller.abort();
    }
    onConnectionEnd(connection, null);
  }

  // ── the port ───────────────────────────────────────────────────────────────────────────────────────

  connect(false);

  return {
    send(event) {
      if (!open) return false;
      // A malformed id never leaves this device (the relay would refuse it anyway).
      if ('callId' in event.payload && !CALL_ID_PATTERN.test(event.payload.callId)) return true;
      onClientEvent(event);
      return true;
    },
    isOpen: () => open,
    subscribe(onFrame) {
      frameListeners.add(onFrame);
      return () => frameListeners.delete(onFrame);
    },
    onClosed(onClose) {
      closeListeners.add(onClose);
      return () => closeListeners.delete(onClose);
    },
    close: () => stop(RELAY_SOCKET_CLOSE.CLOSED),
    status: () => status,
  };
}
