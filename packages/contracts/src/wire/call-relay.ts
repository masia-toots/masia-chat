/**
 * call-relay — the wire contract of the open relay's CALL CHANNEL (ADR-228): how two devices of a one-to-one room
 * signal a 1:1 audio call through the relay alone, with no other server. ONE home for the routes, the stream's event
 * names, the peer signals and their validation; the relay (`@masia/relay`, `apps/relay`) and the client adapter
 * (`@masia/messenger/call`, `relay-socket.ts`) both import it.
 *
 * The channel is a dumb pipe. A device holds ONE stream (`GET /calls/stream`, server-sent events) and posts each signal
 * to one device of the other person (`POST /calls/signal`, answered 202 with an empty body whether that device is
 * online or not). The relay checks who may signal whom (two USER devices of the two people of the room), stamps the
 * sender (`fromUserId`, `fromDeviceId`) from its OWN record of the token's device — never from the body — validates
 * the signal's shape, and hands it to the target's open stream. Nothing is stored and nothing is queued: a signal for
 * a device with no stream is gone.
 *
 * What a server did for a call (mint the call id, ring every device of the callee, time the ring out, let the first
 * accept win and tell the other devices `answered-elsewhere`, keep the ICE and the tags between the two ends) is the
 * CALLER's client's job here. The peer signals are therefore richer than the `call:*` client frames
 * (`call-signal.ts`): the caller's adapter tells the winning device `call:accepted` and ends the rest itself.
 *
 *   caller device                              callee devices (every USER device of the other person)
 *   ─────────────                              ──────────────
 *   call:ring {callId}               ──────►   each
 *                                    ◄──────   call:accept {callId}         (or call:decline {callId})
 *   call:accepted {callId}           ──────►   the first that accepted
 *   call:end {answered-elsewhere}    ──────►   the others
 *   call:ice / call:verify           ◄─────►   only between the caller and the accepted device
 *   call:end {reason}                ◄─────►   either end
 *
 * Pure module: no I/O, browser-safe.
 */

import {
  CALL_ID_PATTERN,
  CALL_LIMITS,
  CALL_TAG_PATTERN,
  type CallEndReason,
  type CallSignal,
  parseCallSignal,
} from './call-signal.js';
import { RELAY_TOKEN_CLOCK_TOLERANCE_SECONDS, RELAY_TOKEN_TTL_SECONDS } from './relay-token.js';
import { isWireId } from './vocabulary.js';

const MS_SEC = 1_000;

/**
 * The longest a stream can stay open: the relay closes it when its token stops, and no token lives longer than its
 * lifetime plus the clock tolerance from now. A client never schedules on a `closesInMs` above this.
 */
export const CALL_STREAM_MAX_LIFETIME_MS = (RELAY_TOKEN_TTL_SECONDS + RELAY_TOKEN_CLOCK_TOLERANCE_SECONDS) * MS_SEC;

/** The two routes, relative to the relay's base path. */
export const CALL_RELAY_PATH = {
  /** `GET`: this device's stream of signals (`text/event-stream`). */
  STREAM: '/calls/stream',
  /** `POST`: one signal to one device of the other person (`CallSignalRequest`). */
  SIGNAL: '/calls/signal',
} as const;

/** The named events of the stream. Comment lines (`: …`) are keep-alives and carry nothing. */
export const CALL_STREAM_EVENT = {
  /** First event of every stream: it is registered; `CallStreamReady`. */
  READY: 'ready',
  /** One signal from the other person (`CallStreamSignal`). */
  SIGNAL: 'signal',
  /** Last event of a stream another stream of the SAME device took the place of. Data `{}`. */
  REPLACED: 'replaced',
} as const;
export type CallStreamEventName = (typeof CALL_STREAM_EVENT)[keyof typeof CALL_STREAM_EVENT];

export const CALL_RELAY_LIMITS = {
  /** How often the relay writes a keep-alive comment on an idle stream (well under any proxy's idle timeout). */
  keepAliveMs: 15 * MS_SEC,
  /** A client that hears nothing on its stream, not even a keep-alive, for this long treats it as dead. */
  silenceMs: 45 * MS_SEC,
  /**
   * The largest `POST /calls/signal` body: a `call:ice` with the longest SDP, every character of it escaped as
   * `\uXXXX` (six bytes), and room for the envelope. Anything bigger is not a signal.
   */
  signalBodyMaxBytes: CALL_LIMITS.sdpMaxChars * 6 + 4_096,
} as const;

export const RELAY_CALL_SIGNAL = {
  RING: 'call:ring',
  ACCEPT: 'call:accept',
  ACCEPTED: 'call:accepted',
  DECLINE: 'call:decline',
  ICE: 'call:ice',
  VERIFY: 'call:verify',
  END: 'call:end',
} as const;
export type RelayCallSignalType = (typeof RELAY_CALL_SIGNAL)[keyof typeof RELAY_CALL_SIGNAL];

/**
 * The end reasons one device may send the other. `rate-limited` and `unavailable` are never a peer's to say: a client
 * learns them from the relay's own answer (429, 403) and ends its call locally.
 */
export const RELAY_CALL_END_REASONS = [
  'hangup',
  'cancelled',
  'declined',
  'no-answer',
  'answered-elsewhere',
  'lost',
  'verify-failed',
  'connect-failed',
] as const satisfies readonly CallEndReason[];
export type RelayCallEndReason = (typeof RELAY_CALL_END_REASONS)[number];

/** What one device signals another. The relay checks the shape and never reads the SDP or the candidates. */
export type RelayCallSignal =
  | { readonly type: 'call:ring'; readonly callId: string }
  | { readonly type: 'call:accept'; readonly callId: string }
  | { readonly type: 'call:accepted'; readonly callId: string }
  | { readonly type: 'call:decline'; readonly callId: string }
  | { readonly type: 'call:ice'; readonly callId: string; readonly signal: CallSignal }
  | { readonly type: 'call:verify'; readonly callId: string; readonly tag: string }
  | { readonly type: 'call:end'; readonly callId: string; readonly reason: RelayCallEndReason };

/** The body of `POST /calls/signal`. The sender is the token's device, never a field. */
export interface CallSignalRequest {
  readonly conversationId: string;
  readonly toDeviceId: string;
  readonly signal: RelayCallSignal;
}

/** The data of a `signal` event: the sender as the RELAY knows it (its device record), and the signal. */
export interface CallStreamSignal {
  readonly conversationId: string;
  readonly fromUserId: string;
  readonly fromDeviceId: string;
  readonly signal: RelayCallSignal;
}

/** The data of the `ready` event. */
export interface CallStreamReady {
  /**
   * How long until the relay closes this stream (its token expires then). Relative, so no clock is compared: a client
   * opens its next stream, with a fresh token, before this runs out.
   */
  readonly closesInMs: number;
}

// ── runtime validation ───────────────────────────────────────────────────────────────────────────

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function matches(v: unknown, pattern: RegExp): v is string {
  return typeof v === 'string' && pattern.test(v);
}

/**
 * Validate one peer signal. Null for anything malformed or oversize (an unknown type, an ill-formed call id or tag,
 * an SDP over `CALL_LIMITS`, an end reason a peer may not send). Unknown extra fields are dropped, never forwarded.
 */
export function parseRelayCallSignal(raw: unknown): RelayCallSignal | null {
  if (!isObj(raw) || !matches(raw['callId'], CALL_ID_PATTERN)) return null;
  const callId = raw['callId'];
  switch (raw['type']) {
    case RELAY_CALL_SIGNAL.RING:
    case RELAY_CALL_SIGNAL.ACCEPT:
    case RELAY_CALL_SIGNAL.ACCEPTED:
    case RELAY_CALL_SIGNAL.DECLINE:
      return { type: raw['type'], callId };
    case RELAY_CALL_SIGNAL.ICE: {
      const signal = parseCallSignal(raw['signal']);
      return signal === null ? null : { type: 'call:ice', callId, signal };
    }
    case RELAY_CALL_SIGNAL.VERIFY:
      return matches(raw['tag'], CALL_TAG_PATTERN) ? { type: 'call:verify', callId, tag: raw['tag'] } : null;
    case RELAY_CALL_SIGNAL.END: {
      const reason = raw['reason'];
      return (RELAY_CALL_END_REASONS as readonly unknown[]).includes(reason)
        ? { type: 'call:end', callId, reason: reason as RelayCallEndReason }
        : null;
    }
    default:
      return null;
  }
}

/** Validate the data of a `signal` event, as a client reads it: the relay is not trusted for shape either. */
export function parseCallStreamSignal(raw: unknown): CallStreamSignal | null {
  if (!isObj(raw)) return null;
  const { conversationId, fromUserId, fromDeviceId } = raw;
  if (!isWireId(conversationId) || !isWireId(fromUserId) || !isWireId(fromDeviceId)) return null;
  const signal = parseRelayCallSignal(raw['signal']);
  return signal === null ? null : { conversationId, fromUserId, fromDeviceId, signal };
}

/**
 * Validate the data of the `ready` event. A `closesInMs` over `CALL_STREAM_MAX_LIFETIME_MS` is capped there: no real
 * stream lives longer, and a timer must not be handed whatever a relay says.
 */
export function parseCallStreamReady(raw: unknown): CallStreamReady | null {
  if (!isObj(raw)) return null;
  const closesInMs = raw['closesInMs'];
  return typeof closesInMs === 'number' && Number.isFinite(closesInMs) && closesInMs >= 0
    ? { closesInMs: Math.min(closesInMs, CALL_STREAM_MAX_LIFETIME_MS) }
    : null;
}
