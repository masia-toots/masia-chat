/**
 * call-signal — the wire contract of a 1:1 audio call (ADR-211 decision 2, step Д1). ONE home for the
 * `call:*` event names, their payloads, the limits, the end reasons and the runtime validation — the API's on every
 * frame a client sends (`parseCallClientEvent`), the hub's on every frame the server sends (`parseCallServerEvent`).
 * Carried on `/ws/chat` as `{ type, payload }`, like every other event.
 *
 * Who sends what:
 *
 *   client → server                          server → client
 *   ───────────────                          ───────────────
 *   call:invite  {requestId, conversationId,  call:invite  {requestId, callId, ringUntil}   (ack, to the inviting socket)
 *                 deviceId}                   call:ring    {callId, conversationId, callerUserId, callerDeviceId, ringUntil,
 *                                                           silent}
 *   call:accept  {callId, deviceId}           call:accept  {callId, callerDeviceId, calleeDeviceId}   (to the two ends)
 *   call:decline {callId}                     call:ice     {callId, signal}   (from the other end, verbatim)
 *   call:ice     {callId, signal}             call:verify  {callId, tag}      (from the other end, verbatim)
 *   call:verify  {callId, tag}                call:end     {callId, reason}
 *   call:end     {callId, reason}
 *   call:ringing {callId}                     (answered with call:ring to that socket, or call:end if it is over)
 *
 * `call:ringing` (step Д3a, ADR-211 decision 10): a callee device says it has the ring on screen, or a device opened
 * from the CALL push (`call-push.ts`) asks to learn the call; that socket gets `call:ring`. It does not hold the push
 * back for the callee's other devices. Only the callee's sockets are heard, only while it rings — anything else is
 * dropped like any stray call event.
 *
 * The SDP offer and answer ride `call:ice` (`signal.kind` = `offer` | `answer`): ADR-211 names seven events and no
 * offer/answer pair, and the SDP is where the ICE credentials and the DTLS fingerprint live, so it belongs to the
 * same channel as the candidates. The server checks only the shape and who may send which kind (an offer only from
 * the caller's device, an answer only from the device that accepted); it never reads inside.
 *
 * `deviceId` is the sender's MLS device id. The server forwards it as data (it goes into the verification tag,
 * `call-verify-tag.ts`) and never routes by it: routing is by the server's own record of the two sockets.
 *
 * Pure module: no I/O, browser-safe.
 */

const MS_SEC = 1_000;

export const CALL_EVENT = {
  INVITE: 'call:invite',
  RING: 'call:ring',
  ACCEPT: 'call:accept',
  DECLINE: 'call:decline',
  ICE: 'call:ice',
  VERIFY: 'call:verify',
  END: 'call:end',
  RINGING: 'call:ringing',
} as const;
export type CallEventType = (typeof CALL_EVENT)[keyof typeof CALL_EVENT];

const CALL_EVENT_TYPES: ReadonlySet<string> = new Set(Object.values(CALL_EVENT));

/** Is this wire `type` one of the call events? (The socket routes on it before validating the payload.) */
export function isCallEventType(type: unknown): type is CallEventType {
  return typeof type === 'string' && CALL_EVENT_TYPES.has(type);
}

export const CALL_LIMITS = {
  /** How long the callee's devices ring before the call ends as `no-answer` (server-enforced). */
  ringTimeoutMs: 45 * MS_SEC,
  /** A whole SDP (offer or answer). An audio-only SDP is ~2–4 KB; this leaves room, not abuse. */
  sdpMaxChars: 16_000,
  /** One ICE candidate line. */
  candidateMaxChars: 1_000,
  /** `sdpMid` of a candidate. */
  sdpMidMaxChars: 64,
  /** The highest m-line index accepted (audio-only: 0; room for a data channel later). */
  sdpMLineIndexMax: 15,
  /**
   * Per socket, a token bucket over every `call:*` frame it sends: this many at once, then this many per second. A
   * call's start (offer, a few dozen candidates, the tag) fits the burst; the server drops what is over, silently.
   */
  socketFramesBurst: 64,
  socketFramesPerSecond: 8,
  /**
   * Per socket, how long the answer "the calls are open to this account" is kept before the next `call:*` frame asks
   * again. An account removed from the listed family on an open socket loses its call frames within this; a burst of
   * frames costs one read, not one per frame (final security review, L3). `call:end` is heard whatever the answer.
   */
  socketAccessRecheckMs: 30 * MS_SEC,
  /** Per call and per end: the SDPs (the first offer or answer, then ICE restarts) the server relays; the rest are dropped. */
  sdpPerEndMax: 16,
  /** Per call and per end: the candidates (end-of-candidates included) the server relays. */
  candidatesPerEndMax: 256,
  /** Per call and per end: the verification tags the server relays. Never grows. */
  verifyPerEndMax: 4,
  /**
   * A call that lives on restarts ICE with every fresh TURN set (an offer, an answer, a new gathering — at most twice
   * per set, and the server's sets are fresh at most every 8 minutes): the SDP and candidate caps above grow by one
   * refill for every this long since the call was placed. Twice what such a call uses, so a call is never cut for
   * its length; the total stays bounded by the call's age.
   */
  relayRefillMs: 2 * 60 * MS_SEC,
  /** One refill: this many SDPs more… */
  sdpPerRefill: 1,
  /** …and this many candidates (a relay-only gathering is a few; a direct one a dozen or two). */
  candidatesPerRefill: 32,
  /**
   * TURN credentials for an accepted call (`POST /api/calls/:callId/ice-servers`): the server keeps one set per call
   * and person and hands it out again until this much is left of it; a request after that gets a fresh set. A client
   * that renews asks inside this window, or it is handed the set it already holds.
   */
  turnRenewWindowMs: 2 * 60 * MS_SEC,
} as const;

/** Server-minted call id: 16 random bytes, base64url, no padding (`randomBytes(16).toString('base64url')`). */
export const CALL_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
/** Client nonce for `call:invite` — ties the server's ack (which carries the new `callId`) to the request. */
export const CALL_REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
/** An MLS device id as the client knows it (`masia_<user>_<n>` today; the pattern does not assume the format). */
export const CALL_DEVICE_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
/** A verification tag: HMAC-SHA256 → 32 bytes → 43 base64url chars, no padding. */
export const CALL_TAG_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A user id as the server names the caller (a UUID today; bounded, not assumed). */
const USER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** An ISO-8601 moment (`ringUntil`): bounded text that parses as a date. */
const ISO_MAX_CHARS = 40;

export type CallRole = 'caller' | 'callee';

/**
 * Why a call ended — the `call:end` reason the server sends. The CALLER never learns why nobody answered
 * (ADR-211 decision 8): a callee who blocked them, who is offline, or whom policy protects all end in `no-answer`.
 *
 *   hangup             — the other end hung up after the call was answered.
 *   cancelled          — the caller hung up while it was still ringing (what the callee's devices see).
 *   declined           — the callee declined.
 *   no-answer          — nobody answered in time (or, to the caller, any reason they must not learn).
 *   answered-elsewhere — another device of the callee answered; this one goes quiet.
 *   lost               — the other end's connection died (socket gone, server restarted) — an honest end.
 *   verify-failed      — the fingerprint check failed on one side; the call never started.
 *   connect-failed     — the media path could not be set up.
 *   rate-limited       — the caller started too many calls (a fact about the caller, not the callee).
 *   unavailable        — the call cannot be placed here (calls off, not a 1:1 encrypted room the caller is in).
 */
export const CALL_END_REASONS = [
  'hangup',
  'cancelled',
  'declined',
  'no-answer',
  'answered-elsewhere',
  'lost',
  'verify-failed',
  'connect-failed',
  'rate-limited',
  'unavailable',
] as const;
export type CallEndReason = (typeof CALL_END_REASONS)[number];

/** The reasons a CLIENT may put in its own `call:end` (the rest are the server's to decide). */
export const CALL_CLIENT_END_REASONS = ['hangup', 'verify-failed', 'connect-failed'] as const;
export type CallClientEndReason = (typeof CALL_CLIENT_END_REASONS)[number];

/** What `call:ice` carries: the SDP pair and the trickled candidates. */
export type CallSignal =
  | { readonly kind: 'offer'; readonly sdp: string }
  | { readonly kind: 'answer'; readonly sdp: string }
  | {
      readonly kind: 'candidate';
      readonly candidate: string;
      readonly sdpMid: string | null;
      readonly sdpMLineIndex: number | null;
    }
  | { readonly kind: 'end-of-candidates' };

// ── client → server payloads ─────────────────────────────────────────────────────────────────────

export interface CallInvitePayload {
  readonly requestId: string;
  readonly conversationId: string;
  readonly deviceId: string;
}
export interface CallAcceptPayload {
  readonly callId: string;
  readonly deviceId: string;
}
export interface CallDeclinePayload {
  readonly callId: string;
}
export interface CallIcePayload {
  readonly callId: string;
  readonly signal: CallSignal;
}
export interface CallVerifyPayload {
  readonly callId: string;
  readonly tag: string;
}
/** A callee device shows the ring (step Д3a). */
export interface CallRingingPayload {
  readonly callId: string;
}
export interface CallClientEndPayload {
  readonly callId: string;
  readonly reason: CallClientEndReason;
}

export type CallClientEvent =
  | { readonly type: 'call:invite'; readonly payload: CallInvitePayload }
  | { readonly type: 'call:accept'; readonly payload: CallAcceptPayload }
  | { readonly type: 'call:decline'; readonly payload: CallDeclinePayload }
  | { readonly type: 'call:ice'; readonly payload: CallIcePayload }
  | { readonly type: 'call:verify'; readonly payload: CallVerifyPayload }
  | { readonly type: 'call:end'; readonly payload: CallClientEndPayload }
  | { readonly type: 'call:ringing'; readonly payload: CallRingingPayload };

// ── server → client payloads ─────────────────────────────────────────────────────────────────────

/** The ack of `call:invite`, to the inviting socket only. `ringUntil` is ISO-8601. */
export interface CallInviteAckPayload {
  readonly requestId: string;
  readonly callId: string;
  readonly ringUntil: string;
}
/** To every device of the callee. */
export interface CallRingPayload {
  readonly callId: string;
  readonly conversationId: string;
  readonly callerUserId: string;
  readonly callerDeviceId: string;
  readonly ringUntil: string;
  /**
   * Show the ring without a sound: the callee's push gate would hold a push from this caller in this room (pushes off,
   * quiet hours, the caller or the room muted — `evaluatePushGate`, category `CALL`). Decided by the server once, when
   * the call is placed: one rule in one place, also on a device that knows nothing of the room's mute yet (review Д2б
   * L2). A client reads anything but `true` as false.
   */
  readonly silent: boolean;
}
/** To the two ends once one device of the callee accepted. */
export interface CallAcceptedPayload {
  readonly callId: string;
  readonly callerDeviceId: string;
  readonly calleeDeviceId: string;
}
export interface CallEndPayload {
  readonly callId: string;
  readonly reason: CallEndReason;
}

export type WsCallServerEvent =
  | { readonly type: 'call:invite'; readonly payload: CallInviteAckPayload }
  | { readonly type: 'call:ring'; readonly payload: CallRingPayload }
  | { readonly type: 'call:accept'; readonly payload: CallAcceptedPayload }
  | { readonly type: 'call:ice'; readonly payload: CallIcePayload }
  | { readonly type: 'call:verify'; readonly payload: CallVerifyPayload }
  | { readonly type: 'call:end'; readonly payload: CallEndPayload };

// ── runtime validation (every frame a client sends) ──────────────────────────────────────────────

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown, pattern: RegExp): string | null {
  return typeof v === 'string' && pattern.test(v) ? v : null;
}

function boundedText(v: unknown, max: number): string | null {
  return typeof v === 'string' && v.length > 0 && v.length <= max ? v : null;
}

function isoMoment(v: unknown): string | null {
  return typeof v === 'string' && v.length <= ISO_MAX_CHARS && Number.isFinite(Date.parse(v)) ? v : null;
}

function parseSignal(v: unknown): CallSignal | null {
  if (!isObj(v)) return null;
  switch (v['kind']) {
    case 'offer':
    case 'answer': {
      const sdp = boundedText(v['sdp'], CALL_LIMITS.sdpMaxChars);
      return sdp === null ? null : { kind: v['kind'], sdp };
    }
    case 'candidate': {
      const candidate = typeof v['candidate'] === 'string' && v['candidate'].length <= CALL_LIMITS.candidateMaxChars
        ? v['candidate']
        : null;
      if (candidate === null) return null;
      const mid = v['sdpMid'];
      const sdpMid = mid === null || mid === undefined ? null : boundedText(mid, CALL_LIMITS.sdpMidMaxChars);
      if (sdpMid === null && mid !== null && mid !== undefined) return null;
      const idx = v['sdpMLineIndex'];
      let sdpMLineIndex: number | null = null;
      if (idx !== null && idx !== undefined) {
        if (typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0 || idx > CALL_LIMITS.sdpMLineIndexMax) return null;
        sdpMLineIndex = idx;
      }
      return { kind: 'candidate', candidate, sdpMid, sdpMLineIndex };
    }
    case 'end-of-candidates':
      return { kind: 'end-of-candidates' };
    default:
      return null;
  }
}

/**
 * Validate one client frame that claims a `call:*` type. Returns the typed event, or null for anything malformed
 * (unknown type, missing or ill-formed field, oversize SDP). Unknown extra fields are dropped, never forwarded.
 */
export function parseCallClientEvent(raw: unknown): CallClientEvent | null {
  if (!isObj(raw) || !isObj(raw['payload'])) return null;
  const p = raw['payload'];
  switch (raw['type']) {
    case CALL_EVENT.INVITE: {
      const requestId = str(p['requestId'], CALL_REQUEST_ID_PATTERN);
      const conversationId = str(p['conversationId'], UUID_PATTERN);
      const deviceId = str(p['deviceId'], CALL_DEVICE_ID_PATTERN);
      if (!requestId || !conversationId || !deviceId) return null;
      return { type: 'call:invite', payload: { requestId, conversationId, deviceId } };
    }
    case CALL_EVENT.ACCEPT: {
      const callId = str(p['callId'], CALL_ID_PATTERN);
      const deviceId = str(p['deviceId'], CALL_DEVICE_ID_PATTERN);
      if (!callId || !deviceId) return null;
      return { type: 'call:accept', payload: { callId, deviceId } };
    }
    case CALL_EVENT.DECLINE: {
      const callId = str(p['callId'], CALL_ID_PATTERN);
      return callId ? { type: 'call:decline', payload: { callId } } : null;
    }
    case CALL_EVENT.ICE: {
      const callId = str(p['callId'], CALL_ID_PATTERN);
      const signal = parseSignal(p['signal']);
      if (!callId || !signal) return null;
      return { type: 'call:ice', payload: { callId, signal } };
    }
    case CALL_EVENT.VERIFY: {
      const callId = str(p['callId'], CALL_ID_PATTERN);
      const tag = str(p['tag'], CALL_TAG_PATTERN);
      if (!callId || !tag) return null;
      return { type: 'call:verify', payload: { callId, tag } };
    }
    case CALL_EVENT.END: {
      const callId = str(p['callId'], CALL_ID_PATTERN);
      const reason = (CALL_CLIENT_END_REASONS as readonly unknown[]).includes(p['reason'])
        ? (p['reason'] as CallClientEndReason)
        : null;
      if (!callId || !reason) return null;
      return { type: 'call:end', payload: { callId, reason } };
    }
    case CALL_EVENT.RINGING: {
      const callId = str(p['callId'], CALL_ID_PATTERN);
      return callId ? { type: 'call:ringing', payload: { callId } } : null;
    }
    default:
      return null;
  }
}

/**
 * Validate one SERVER frame that claims a `call:*` type — the client's side of the same contract. The client does not
 * trust the server for shape: anything malformed (an unknown reason, an ill-formed id, an oversize SDP, a client-only
 * type) is null and must be dropped. Unknown extra fields are dropped. `call:ice` is the other end's signal
 * forwarded verbatim, so it is read with the same rules as the client frame it came from.
 */
export function parseCallServerEvent(raw: unknown): WsCallServerEvent | null {
  if (!isObj(raw) || !isObj(raw['payload'])) return null;
  const p = raw['payload'];
  const callId = str(p['callId'], CALL_ID_PATTERN);
  if (!callId) return null;
  switch (raw['type']) {
    case CALL_EVENT.INVITE: {
      const requestId = str(p['requestId'], CALL_REQUEST_ID_PATTERN);
      const ringUntil = isoMoment(p['ringUntil']);
      if (!requestId || !ringUntil) return null;
      return { type: 'call:invite', payload: { requestId, callId, ringUntil } };
    }
    case CALL_EVENT.RING: {
      const conversationId = str(p['conversationId'], UUID_PATTERN);
      const callerUserId = str(p['callerUserId'], USER_ID_PATTERN);
      const callerDeviceId = str(p['callerDeviceId'], CALL_DEVICE_ID_PATTERN);
      const ringUntil = isoMoment(p['ringUntil']);
      if (!conversationId || !callerUserId || !callerDeviceId || !ringUntil) return null;
      // The sound is a preference, not a check: a missing or odd `silent` rings rather than dropping the call.
      const silent = p['silent'] === true;
      return { type: 'call:ring', payload: { callId, conversationId, callerUserId, callerDeviceId, ringUntil, silent } };
    }
    case CALL_EVENT.ACCEPT: {
      const callerDeviceId = str(p['callerDeviceId'], CALL_DEVICE_ID_PATTERN);
      const calleeDeviceId = str(p['calleeDeviceId'], CALL_DEVICE_ID_PATTERN);
      if (!callerDeviceId || !calleeDeviceId) return null;
      return { type: 'call:accept', payload: { callId, callerDeviceId, calleeDeviceId } };
    }
    case CALL_EVENT.ICE: {
      const signal = parseSignal(p['signal']);
      return signal ? { type: 'call:ice', payload: { callId, signal } } : null;
    }
    case CALL_EVENT.VERIFY: {
      const tag = str(p['tag'], CALL_TAG_PATTERN);
      return tag ? { type: 'call:verify', payload: { callId, tag } } : null;
    }
    case CALL_EVENT.END: {
      const reason = (CALL_END_REASONS as readonly unknown[]).includes(p['reason']) ? (p['reason'] as CallEndReason) : null;
      return reason ? { type: 'call:end', payload: { callId, reason } } : null;
    }
    default:
      return null;
  }
}
