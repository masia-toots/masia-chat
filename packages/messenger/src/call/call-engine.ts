/**
 * The 1:1 audio call engine (ADR-211, step Д2a): headless, framework-free, one per app. It drives ONE
 * `RTCPeerConnection` through the call state machine (`audioCall`, `audio-call-machine.ts`) and talks to the world only
 * through ports (`CallEnginePorts`), so every rule below is unit-tested with fakes and the same code runs in the
 * two-browser harness. The React side (`useAudioCall.ts`) and the screen author's guide (`README.md`) live with the
 * host app.
 *
 * ## What it guarantees
 *
 *  - **No audio before the check, either way.** The remote track is held — `enabled = false`, attached to nothing —
 *    until the machine is `verified`: the peer's tag checked out in the MLS worker (decision 4) and, where the
 *    browser can say which certificate DTLS actually accepted, that certificate hashes to the fingerprint the tag
 *    bound. Our own microphone track is off (it sends silence) until the same moment; mute applies on top.
 *  - **One fingerprint per SDP, one transport per call.** Ours and the peer's: an SDP with no fingerprint, with
 *    more than one distinct value, or with an m-line outside its one BUNDLE group is refused (`sdp.ts`) — the call
 *    ends `verify-failed` before anything is attached. The peer connection is `max-bundle` with RTCP muxed, so the
 *    audio and the control channel share the one DTLS transport whose fingerprint the tag binds (ADR-215 decision 4).
 *  - **The transport stays the one that was verified.** The audio sender's DTLS transport at `verified` is
 *    remembered; if it is ever replaced, or the certificate the peer presents on it stops hashing to the tagged
 *    fingerprint, the call ends `verify-failed` (an ICE restart keeps the transport and is not a change).
 *  - **Reflection fails at once.** A peer tag equal to one we sent ends the call; the worker refuses it too.
 *  - **The person, not just a device.** The worker verifies only the one other person of the room on a device of
 *    their own (never the assistant's, a guardian's, or our own other device) and names them; on the callee side
 *    that person must be the one the ring named. `verifiedPeer` is what the screen shows.
 *  - **Own epoch only**, bounded: a failed check catches the room up and tries again — at most 3 times within
 *    10 s of our first tag — then "cannot verify". A tag that never comes is the same failure.
 *  - **Relay-only means relay-only.** When the server answers `relay`, the peer connection gets
 *    `iceTransportPolicy: 'relay'` AND the engine drops every non-relay candidate both ways, trickled or inside an
 *    SDP. A relay-only call with no TURN to use ends honestly (`relay-unavailable`) instead of trying.
 *  - **TURN only for an answered call; the live path moved onto each fresh set.** The ICE route gives nothing for a
 *    ringing call (`PENDING`), so the engine asks once the server's `call:accept` is in — never while it rings, never
 *    for an answer another device won. A `PENDING` that still comes is asked again, backing off, inside the connect
 *    deadline. The caller asks for a fresh set before the held one expires (counted from the server's `expiresIn`
 *    where it says it) and hands it to the connection; a live TURN allocation keeps the credential it was made with
 *    and dies with it, so the caller then restarts ICE. Only the caller ever offers — two offers never cross — and
 *    the callee tops its own set up before it answers — only once that set is inside its renew window, so a hostile
 *    caller's restart offers cannot spend the callee's hourly ICE quota. A restart changes the ICE credentials and the candidates and
 *    nothing else: the same fingerprint, the same m-lines, relay-only both ways — or the call ends `verify-failed`.
 *    One that misses its deadline is dropped and tried once more; a media path that stays down ends the call
 *    `lost`. A failed renewal leaves the call alone and asks later. Every wait dies with the call.
 *  - **Busy is invisible.** A second ring while a call is live is ignored — never declined: to that caller it is
 *    an unanswered call like any other (decision 8).
 *  - **Honest ends.** The socket closing, the media path failing or staying down, a local deadline passing: each
 *    ends the call with a reason (`lost`, `connect-failed`, `no-answer`) — nothing is left "connected" that is not.
 *  - **Nothing from the server is trusted for shape** (`parseCallServerEvent`), and events of another call or
 *    of the wrong side (an offer to the caller, an answer to the callee) are dropped.
 *  - **A control channel on every call, silent until verified.** One pre-negotiated data channel
 *    (`CALL_CONTROL_CHANNEL`) is created with the peer, before the first offer, so a later use of it needs no
 *    renegotiation (ADR-215 decision 4). Nothing is sent on it, and anything received is dropped, until the call
 *    is verified AND the channel passed the transport check: its SCTP runs over the audio sender's own DTLS
 *    transport (`pc.sctp.transport === sender.transport`) and the certificate the peer presented there hashes to
 *    the tagged fingerprint. A browser that cannot say either never gets the channel (the audio call still runs on
 *    ADR-211's checks). It closes with the call. The engine defines no protocol on it.
 */
import {
  CALL_LIMITS,
  parseCallServerEvent,
  type CallClientEndReason,
  type CallClientEvent,
  type CallEndReason,
  type CallRole,
  type CallSignal,
} from '@masia/contracts/wire';
import { audioCall, isAudioCallBusy, type AudioCallMachine, type AudioCallState } from './audio-call-machine.js';
import type {
  CallOtherDevice,
  CallTagAnswer,
  CallTagRequest,
  CallVerifyAnswer,
  CallVerifyRequest,
} from './call-binding-types.js';
import {
  boundFingerprint,
  certificateFingerprint,
  fingerprintHash,
  isRelayCandidate,
  relayOnlySdp,
  scrubRelayCandidate,
  sdpIceUfrag,
  sdpLayout,
} from './sdp.js';

// ── ports ────────────────────────────────────────────────────────────────────────────────────────

/** The chat socket, as far as calls need it. */
export interface CallSocketPort {
  /** Send a call frame; false when the socket is not open (the frame is dropped, not queued). */
  send(event: CallClientEvent): boolean;
  isOpen(): boolean;
  /** Every server frame whose type starts with `call:`, raw (the engine validates it). Returns unsubscribe. */
  subscribe(onFrame: (raw: unknown) => void): () => void;
  /** Every close of an opened socket, with its code. Returns unsubscribe. */
  onClosed(onClose: (code: number) => void): () => void;
}

export interface CallIceServer {
  readonly urls: readonly string[];
  readonly username?: string;
  readonly credential?: string;
}

/**
 * `POST /api/calls/:callId/ice-servers`, as the engine needs it. `PENDING` = the call is not accepted yet (no
 * servers); only `OK` carries a set, and with it `expiresAt`: when the set stops working, in epoch milliseconds by the
 * SERVER's clock — and, from a server that says it, `expiresInMs`: how long it had left when the server answered,
 * which needs no clock compared.
 */
export interface CallIceAnswer {
  readonly status: 'OK' | 'PENDING' | 'NOT_CONFIGURED' | 'PROVIDER_ERROR';
  readonly iceServers: readonly CallIceServer[];
  readonly iceTransportPolicy: 'all' | 'relay';
  readonly expiresAt?: number;
  readonly expiresInMs?: number;
}

/**
 * The call's control data channel: created by `createPeer` itself — so it exists before the first offer, on both
 * sides — as `createDataChannel(label, { negotiated: true, id, ordered: true })` (reliable: no retransmit limit).
 * Pre-negotiated with a fixed id, so neither side waits for the other to announce it, and a later use of it never
 * needs a renegotiation (ADR-215 decision 4). The engine carries no protocol on it: text in, text out, nothing
 * before the call is verified.
 */
export const CALL_CONTROL_CHANNEL = { label: 'masia-call-ctl', id: 0 } as const;

export interface CallControlChannelSpec {
  readonly label: string;
  readonly id: number;
}

export interface CallPeerConfig {
  readonly iceServers: readonly CallIceServer[];
  readonly iceTransportPolicy: 'all' | 'relay';
  /** The control channel to create with the peer, before any offer or answer (`CALL_CONTROL_CHANNEL`). */
  readonly control: CallControlChannelSpec;
}

/** What happens on the control channel. `data` is whatever the browser delivered — the engine checks it. */
export type CallControlEvent =
  | { readonly kind: 'open' }
  | { readonly kind: 'close' }
  | { readonly kind: 'message'; readonly data: unknown };

export interface CallCandidate {
  readonly candidate: string;
  readonly sdpMid: string | null;
  readonly sdpMLineIndex: number | null;
}

/** `RTCPeerConnection.connectionState`. */
export type CallPeerState = 'new' | 'connecting' | 'connected' | 'disconnected' | 'failed' | 'closed';

export interface CallPeerEvents {
  /** A local ICE candidate; null when gathering is complete. */
  candidate(candidate: CallCandidate | null): void;
  /** The remote audio arrived (the engine holds it until verified). */
  track(track: MediaStreamTrack, stream: MediaStream): void;
  state(state: CallPeerState): void;
  /** The control channel opened, closed, or carried a message (the engine drops it unless verified). */
  control(event: CallControlEvent): void;
  /** The descriptions changed (`signalingstatechange`): the engine looks at `transport()` again. */
  transport(): void;
}

/**
 * Which DTLS transport carries what, as the browser says (ADR-215 decision 4).
 *   audio         — the audio sender's `RTCDtlsTransport`: an identity, compared and never read; null when the
 *                   browser does not expose it.
 *   controlShared — the control channel's SCTP runs over that very object (`pc.sctp.transport === audio`).
 *   certificates  — the DER certificates the peer presented on it (`getRemoteCertificates()`), first = its own;
 *                   null when this browser cannot tell, empty until DTLS is up.
 */
export interface CallTransportView {
  readonly audio: object | null;
  readonly controlShared: boolean;
  readonly certificates: readonly ArrayBuffer[] | null;
}

/** One `RTCPeerConnection`, reduced to what a 1:1 audio call does with it. */
export interface CallPeer {
  addTrack(track: MediaStreamTrack, stream: MediaStream): void;
  /** createOffer + setLocalDescription; the local SDP as set. */
  createOffer(): Promise<string>;
  /** setRemoteDescription(offer) + createAnswer + setLocalDescription; the local SDP as set. */
  acceptOffer(sdp: string): Promise<string>;
  setAnswer(sdp: string): Promise<void>;
  /**
   * The remote SDP as the browser now holds it (`pc.remoteDescription.sdp`, re-serialised from what it parsed);
   * null when there is none. The engine reads the bound fingerprint back from it.
   */
  appliedRemoteSdp(): string | null;
  /** null = end of candidates. */
  addCandidate(candidate: CallCandidate | null): Promise<void>;
  /**
   * A renewed TURN set (`setConfiguration`, the policy unchanged). The browser gathers with it at its NEXT gathering
   * — an ICE restart; a live allocation keeps the credential it was made with. Never throws.
   */
  setIceServers(servers: readonly CallIceServer[]): void;
  /**
   * An ICE restart, offered: `createOffer({ iceRestart: true })` + setLocalDescription — new ICE credentials, a new
   * gathering with the servers last set; the same DTLS transport, certificate and m-lines. The local SDP as set.
   */
  restartIce(): Promise<string>;
  /** Drop a description still waiting for its other half (`setLocalDescription({ type: 'rollback' })`); none: nothing. */
  rollback(): Promise<void>;
  /**
   * The local ICE ufrag of the candidate pair the audio's transport uses now — which ICE generation carries the call;
   * null when no pair is selected or the browser cannot tell.
   */
  pathUfrag(): string | null;
  /** The transports as they are now: the audio's, whether the control channel shares it, the peer's certificate. */
  transport(): CallTransportView;
  /** Send a text message on the control channel; false when it is not open. */
  sendControl(text: string): boolean;
  /**
   * Switch what the audio sender sends (`RTCRtpSender.replaceTrack`) — no renegotiation, the same transceiver.
   * Rejects as the browser does; the engine decides what then goes back on the line.
   */
  replaceAudioTrack(track: MediaStreamTrack | null): Promise<void>;
  /** Close the control channel only (the peer broke its rules); the call goes on. */
  closeControl(): void;
  /** Close the control channel and the connection. */
  close(): void;
}

/** Where the remote audio plays. */
export interface CallSpeaker {
  /** Play the stream; false when the browser refused to start playback (autoplay) — `resume` from a gesture. */
  attach(stream: MediaStream): Promise<boolean>;
  resume(): Promise<boolean>;
  detach(): void;
  /** Playback was stopped from outside (the audio bus gave the foreground to other media). Returns unsubscribe. */
  onInterrupted?(listener: () => void): () => void;
  /** The engine is gone: let go of what the speaker holds (its audio-bus registration). */
  dispose?(): void;
}

/** The MLS worker's two call questions (their types: `call-binding-types.ts`; the host implements them). `K` never leaves it. */
export interface CallBindingPort {
  callTag(request: CallTagRequest): Promise<CallTagAnswer>;
  callVerify(request: CallVerifyRequest): Promise<CallVerifyAnswer>;
}

export interface CallEnginePorts {
  readonly socket: CallSocketPort;
  readonly iceServers: (callId: string) => Promise<CallIceAnswer>;
  /** null: no encryption runtime — a call could never be verified, so none is placed. */
  readonly binding: CallBindingPort | null;
  readonly microphone: () => Promise<MediaStream>;
  readonly createPeer: (config: CallPeerConfig, events: CallPeerEvents) => CallPeer;
  readonly speaker: CallSpeaker;
  /** This install's MLS device id (the one the worker speaks for). */
  readonly localDeviceId: () => string;
  /** A fresh `call:invite` request id (`CALL_REQUEST_ID_PATTERN`). */
  readonly newRequestId: () => string;
  /** Defaults to the app's one machine, `audioCall`. */
  readonly machine?: AudioCallMachine;
  readonly now?: () => number;
}

// ── what the screen reads ────────────────────────────────────────────────────────────────────────

/**
 * Why the engine could not do what was asked, or why a call ended badly on THIS side — words for the screen:
 *   microphone-denied      — the person (or the OS) refused the microphone.
 *   microphone-unavailable — there is no microphone, or it is busy elsewhere.
 *   offline                — the chat socket is not open, or closed under the call.
 *   relay-unavailable      — this call must go through TURN (not the same family) and the server has none to give.
 *   cannot-connect         — the media path could not be set up (the ICE route failed, ICE never connected).
 *   cannot-verify          — the call could not be verified: the tags did not check out (in time), an SDP carried
 *                            no or several fingerprints or was not bundled, or DTLS accepted another certificate —
 *                            nothing was played. Also a verified call whose DTLS transport or peer certificate
 *                            changed under it (the audio stopped at once).
 *   speaker-blocked        — the browser would not start playback (or other media took over); `resumeSpeaker()`
 *                            from a tap.
 */
export type AudioCallProblem =
  | 'microphone-denied'
  | 'microphone-unavailable'
  | 'offline'
  | 'relay-unavailable'
  | 'cannot-connect'
  | 'cannot-verify'
  | 'speaker-blocked';

export type AudioCallMedia = 'none' | 'connecting' | 'connected';

/** The person on the other end and the device they talk from, as the MLS worker verified them. */
export interface AudioCallPeer {
  readonly userId: string;
  readonly deviceId: string;
}

export interface AudioCallSnapshot {
  /** The machine's state: who, which call, and — once `ended` — why. */
  readonly call: AudioCallState;
  readonly muted: boolean;
  /** The media path: `connected` = ICE + DTLS up. Not the same as "may play" — see `live`. */
  readonly media: AudioCallMedia;
  /** Show "connected" only when this is true: verified AND the media path is up. */
  readonly live: boolean;
  readonly problem: AudioCallProblem | null;
  /** Every OTHER member device of the room at this call's epoch, by kind — the badge (decision 5). */
  readonly others: readonly CallOtherDevice[];
  /**
   * Who the call was verified with: the one other person of the room, on a device of their own, as the MLS worker
   * holds them — on the callee side also the person the ring named. Null until `verified`; kept once the call ends,
   * until the next one. The screen names THIS, never a user id the server sent (`call.callerUserId`).
   */
  readonly verifiedPeer: AudioCallPeer | null;
  /**
   * The control channel can carry messages now: the call is verified, the channel is open, and it runs over the
   * audio's own DTLS transport with the tagged certificate (ADR-215 decision 4). Stays false for a whole call in a
   * browser that cannot say which transport or certificate is in use.
   */
  readonly controlOpen: boolean;
}

export type AudioCallRefusal =
  | 'disabled'
  | 'busy'
  | 'offline'
  | 'microphone-denied'
  | 'microphone-unavailable'
  | 'not-ringing'
  | 'gone'
  | 'cancelled';

export type AudioCallResult = { readonly ok: true } | { readonly ok: false; readonly reason: AudioCallRefusal };

export interface AudioCallEngine {
  getSnapshot(): AudioCallSnapshot;
  /** Fires on every snapshot change. Returns unsubscribe. */
  subscribe(listener: () => void): () => void;
  /** Place a call in this 1:1 encrypted room. Asks for the microphone first. */
  call(conversationId: string): Promise<AudioCallResult>;
  /** Answer the ringing call. Asks for the microphone first; a refusal leaves it ringing. */
  answer(): Promise<AudioCallResult>;
  /** Decline the ringing call. */
  decline(): void;
  /** End whatever is up: cancel a start, decline a ring, hang up a call. */
  hangUp(): void;
  setMuted(muted: boolean): void;
  /** Start playback again from a gesture (after `speaker-blocked`). */
  resumeSpeaker(): Promise<boolean>;
  /** The closing beat is over: `ended` → `idle`, the problem cleared. */
  dismiss(): void;
  /**
   * Send a text message to the other person's device on the call's control channel. False — nothing sent — unless
   * `controlOpen`, or when the text is longer than `controlMessageMaxChars`. No protocol is defined on it yet.
   */
  sendControl(text: string): boolean;
  /** Messages from the other side's device on the control channel — only those that came after verification. */
  onControlMessage(listener: (text: string) => void): () => void;
  /**
   * ADR-215 decision 10 — the call's own microphone track (echo-cancelled, as the call took it), for a capture tap
   * that must never open a second microphone. Null unless the call is verified. Mute disables this very track, so a
   * tap of a muted call reads silence; the tap stops itself on mute too (decision 7).
   */
  localTrack(): MediaStreamTrack | null;
  /**
   * ADR-215 decision 11 — put `track` (the mixing graph's output) on the call's sender in place of the microphone;
   * `null` puts the plain microphone back. A track is put on only in a verified call. Swaps run one at a time, in the
   * order asked. A swap that fails puts the microphone back; if that fails too, the call ends (`connect-failed`) —
   * nothing half-built stays on the line. True = what was asked is what is sent now. The engine never stops `track`:
   * the graph is its owner's.
   */
  replaceOutboundTrack(track: MediaStreamTrack | null): Promise<boolean>;
  /**
   * Stop; a live call is hung up. A call started or answered whose ack has not come yet is hung up when the ack
   * comes: the engine listens for those acks alone, for as long as one could come, then stops listening.
   */
  dispose(): void;
}

// ── limits the ADR does not fix (smallest safe values; README lists them) ───────────────────────

export const AUDIO_CALL_ENGINE_LIMITS = {
  /** The server's `call:invite` ack. */
  inviteAckMs: 15_000,
  /** The server's `call:accept` after «Answer». */
  acceptAckMs: 15_000,
  /**
   * After the ring's length (`CALL_LIMITS.ringTimeoutMs`, counted from when the ring got here), the server's
   * `call:end no-answer` is waited for this long before ending locally.
   */
  ringGraceMs: 5_000,
  /** Decision 4: the verification window, from our first tag. */
  verifyWindowMs: 10_000,
  /** Decision 4: catch-up retries within the window. */
  verifyRetries: 3,
  /** Retry n waits n × this. */
  verifyRetryStepMs: 1_500,
  /** From the accept to a verified, connected call. */
  connectMs: 30_000,
  /** The ICE route still says `PENDING` after the accept (a race): ask again after this, doubling… */
  icePendingRetryMs: 250,
  /** …up to this; all within `connectMs`. */
  icePendingRetryMaxMs: 4_000,
  /**
   * Ask for a fresh TURN set this long before the held one expires: inside the server's renew window (before it, the
   * server hands the same set back), with half that window to spare for a device clock behind the server's.
   */
  iceRenewLeadMs: CALL_LIMITS.turnRenewWindowMs / 2,
  /** …but never sooner than this from now (a short or already-late set must not spin). */
  iceRenewMinMs: 5_000,
  /**
   * A renewal brought no fresher set (it failed, or the server handed the same one back): ask again after this,
   * doubling up to `CALL_LIMITS.turnRenewWindowMs` — so a renewal never waits past the whole window.
   */
  iceRenewRetryMs: 30_000,
  /**
   * The caller's ICE restart onto a fresh set: from its offer to the audio on a candidate pair of the new
   * generation. Missed, the offer is dropped, the route asked once more and the restart tried again — at most
   * `iceRestartAttempts` per set. All of it fits well inside `iceRenewLeadMs`: the old set still works meanwhile.
   */
  iceRestartMs: 15_000,
  iceRestartAttempts: 2,
  /** How long a restart waits on the route: the callee's top-up before it answers, the caller's ask before its retry. */
  iceTopUpMs: 5_000,
  /** The restart's answer is applied: look at which candidate pair carries the audio this often, until its deadline. */
  restartPollMs: 500,
  /** A call that was up, with its media path down this long, ends `lost` (a path that is not coming back). */
  mediaDownMs: 30_000,
  /** Signals held before the remote description is set / before our SDP went out. */
  pendingSignalsMax: 64,
  /** Tags the peer may send in one call (a retry sends a new one); more is an attack. */
  peerTagsMax: 8,
  /** Abandoned requests / calls remembered to hang up a late ack. */
  abandonedMax: 8,
  /** DTLS is up but the browser names no peer certificate yet: look again this often (until `connectMs`). */
  certificatePollMs: 250,
  /** One control-channel message, either way (well under the 16 KiB every browser's SCTP carries in one message). */
  controlMessageMaxChars: 16_000,
  /**
   * Control-channel messages from the peer in any one second; one more closes the channel. A backstop well above
   * what a feature on it sends (ADR-215: at most 2 segments a second, a `state` every 2 s).
   */
  controlMessagesPerSecond: 20,
} as const;

const L = AUDIO_CALL_ENGINE_LIMITS;

// ── the engine ───────────────────────────────────────────────────────────────────────────────────

type IceOutcome = { readonly ok: true; readonly ice: CallIceAnswer } | { readonly ok: false };

type Timer = ReturnType<typeof setTimeout>;

/** The caller's ICE restart in flight: where it is, its offer's ICE ufrag once set, and its deadline. */
interface Restart {
  phase: 'offering' | 'offered' | 'answered';
  ufrag: string | null;
  readonly deadline: Timer;
}

interface Session {
  readonly conversationId: string;
  readonly localDeviceId: string;
  readonly requestId: string | null;
  callId: string | null;
  role: CallRole | null;
  peerDeviceId: string | null;
  /** Callee side: the person the ring named — the verified peer must be them. Null on the caller side. */
  readonly ringCallerUserId: string | null;
  /** The person the worker verified the peer device for (set when the tag checked out). */
  peerUserId: string | null;
  mic: MediaStream | null;
  /** When the TURN set the peer was given (or last handed) expires, server's clock; null = nothing to renew. */
  iceExpiresAt: number | null;
  /**
   * The same expiry by THIS device's clock: when the answer arrived plus the server's `expiresInMs`. Null when no set
   * is held, or the server did not say how long (then the window cannot be placed without comparing clocks).
   */
  iceHeldUntil: number | null;
  /** Renewals in a row that brought no fresher set (the backoff's exponent). */
  iceRetries: number;
  /** The caller's next renewal, waiting for its moment (one at a time). */
  iceRenew: Timer | null;
  relay: boolean;
  peer: CallPeer | null;
  /** Work on the peer, one step at a time (SDP and candidates in order). */
  queue: Promise<void>;
  /** Signals that came before the peer existed (the callee's offer may beat its own setup). */
  early: CallSignal[];
  /** Remote candidates held until the remote description is set. */
  pendingRemote: Array<CallCandidate | null>;
  /** Our own signals held until our SDP went out. */
  pendingLocal: CallSignal[];
  localSdpSent: boolean;
  offerSent: boolean;
  remoteSet: boolean;
  localFp: string | null;
  remoteFp: string | null;
  /** The m-lines of the first exchange, ours and the peer's (`sdpLayout`): an ICE restart keeps each exactly. */
  localLayout: string | null;
  remoteLayout: string | null;
  /** The peer's ICE ufrag now: an offer or answer of a restart must bring another. */
  remoteUfrag: string | null;
  /** Caller: the ICE restart in flight, and the restarts tried for the set held. */
  restart: Restart | null;
  restartAttempts: number;
  /** The media path went down after being up: what ends the call if it stays down. */
  mediaDown: Timer | null;
  tagsStarted: boolean;
  lastTag: string | null;
  readonly sentTags: Set<string>;
  peerTag: string | null;
  peerTags: number;
  verifyStartedAt: number;
  retries: number;
  verifying: boolean;
  reverify: boolean;
  tagOk: boolean;
  remote: { readonly track: MediaStreamTrack; readonly stream: MediaStream } | null;
  mediaUp: boolean;
  mediaEver: boolean;
  /** DTLS is up and the browser names no certificate yet: `confirm` looks again shortly (one timer at a time). */
  certificateWait: boolean;
  /** The control channel is open (it carries nothing either way until the call is verified). */
  controlOpen: boolean;
  /** The engine closed the control channel because the peer broke its rules; it stays closed for this call. */
  controlShut: boolean;
  /** The peer's control messages in the current one-second window, and when that window began. */
  controlCount: number;
  controlWindowAt: number;
  /** The audio sender's DTLS transport the call was verified on (ADR-215 decision 4); a change of it ends the call. */
  boundTransport: object | null;
  /** The control channel passed the transport check: it shares that transport, whose certificate is the tagged one. */
  controlTrusted: boolean;
  /** Transport checks started; only the latest one may grant trust. */
  transportChecks: number;
  /** Swaps of the audio sender's track (`replaceOutboundTrack`), one at a time. */
  outbound: Promise<unknown>;
  readonly timers: Set<Timer>;
  closed: boolean;
}

const MIC_DENIED_ERRORS = new Set(['NotAllowedError', 'SecurityError', 'PermissionDeniedError']);

function micProblem(error: unknown): 'microphone-denied' | 'microphone-unavailable' {
  const name = typeof error === 'object' && error !== null ? (error as { name?: unknown }).name : undefined;
  return typeof name === 'string' && MIC_DENIED_ERRORS.has(name) ? 'microphone-denied' : 'microphone-unavailable';
}

function stopStream(stream: MediaStream | null): void {
  for (const track of stream?.getTracks() ?? []) {
    try {
      track.stop();
    } catch {
      /* already stopped */
    }
  }
}

const RELAY_URL = /^turns?:/i;

const hasRelay = (servers: readonly CallIceServer[]): boolean => servers.some((s) => s.urls.some((u) => RELAY_URL.test(u)));

/** What a fetched ICE answer means for the call: a problem that stops it, or none. */
function iceProblem(outcome: IceOutcome): AudioCallProblem | null {
  // Unreadable, or still PENDING when the asking stopped: the media path cannot be set up.
  if (!outcome.ok || outcome.ice.status === 'PENDING') return 'cannot-connect';
  if (outcome.ice.iceTransportPolicy !== 'all' && !hasRelay(outcome.ice.iceServers)) return 'relay-unavailable';
  return null;
}

function remember<T>(set: Set<T>, value: T): void {
  set.add(value);
  if (set.size > L.abandonedMax) set.delete(set.values().next().value as T);
}

export function createAudioCallEngine(ports: CallEnginePorts): AudioCallEngine {
  const machine = ports.machine ?? audioCall;
  const now = ports.now ?? (() => Date.now());
  const listeners = new Set<() => void>();
  const controlListeners = new Set<(text: string) => void>();

  let current: Session | null = null;
  let starting: number | null = null;
  let startSeq = 0;
  let disposed = false;
  let muted = false;
  let media: AudioCallMedia = 'none';
  let problem: AudioCallProblem | null = null;
  let others: readonly CallOtherDevice[] = [];
  let verifiedPeer: AudioCallPeer | null = null;
  /** Requests we hung up before their ack, and calls we hung up while the accept was on its way. */
  const abandonedRequests = new Set<string>();
  const abandonedCalls = new Set<string>();

  const build = (): AudioCallSnapshot => {
    const call = machine.getState();
    return {
      call,
      muted,
      media,
      live: call.name === 'verified' && media === 'connected',
      problem,
      others,
      verifiedPeer,
      controlOpen: call.name === 'verified' && current?.controlOpen === true && current.controlTrusted,
    };
  };
  let snapshot = build();

  function publish(): void {
    const next = build();
    if (
      next.call === snapshot.call &&
      next.muted === snapshot.muted &&
      next.media === snapshot.media &&
      next.live === snapshot.live &&
      next.problem === snapshot.problem &&
      next.others === snapshot.others &&
      next.verifiedPeer === snapshot.verifiedPeer &&
      next.controlOpen === snapshot.controlOpen
    ) {
      return;
    }
    snapshot = next;
    for (const listener of [...listeners]) listener();
  }

  const setProblem = (next: AudioCallProblem | null): void => {
    problem = next;
    publish();
  };
  const setMedia = (next: AudioCallMedia): void => {
    media = next;
    publish();
  };

  // ── sessions ──────────────────────────────────────────────────────────────────────────────────

  function openSession(init: {
    conversationId: string;
    localDeviceId: string;
    requestId?: string;
    callId?: string;
    role?: CallRole;
    peerDeviceId?: string;
    ringCallerUserId?: string;
    mic?: MediaStream;
  }): Session {
    if (current) closeSession(current);
    const session: Session = {
      conversationId: init.conversationId,
      localDeviceId: init.localDeviceId,
      requestId: init.requestId ?? null,
      callId: init.callId ?? null,
      role: init.role ?? null,
      peerDeviceId: init.peerDeviceId ?? null,
      ringCallerUserId: init.ringCallerUserId ?? null,
      peerUserId: null,
      mic: init.mic ?? null,
      iceExpiresAt: null,
      iceHeldUntil: null,
      iceRetries: 0,
      iceRenew: null,
      relay: true,
      peer: null,
      queue: Promise.resolve(),
      early: [],
      pendingRemote: [],
      pendingLocal: [],
      localSdpSent: false,
      offerSent: false,
      remoteSet: false,
      localFp: null,
      remoteFp: null,
      localLayout: null,
      remoteLayout: null,
      remoteUfrag: null,
      restart: null,
      restartAttempts: 0,
      mediaDown: null,
      tagsStarted: false,
      lastTag: null,
      sentTags: new Set(),
      peerTag: null,
      peerTags: 0,
      verifyStartedAt: 0,
      retries: 0,
      verifying: false,
      reverify: false,
      tagOk: false,
      remote: null,
      mediaUp: false,
      mediaEver: false,
      certificateWait: false,
      controlOpen: false,
      controlShut: false,
      controlCount: 0,
      controlWindowAt: 0,
      boundTransport: null,
      controlTrusted: false,
      transportChecks: 0,
      outbound: Promise.resolve(),
      timers: new Set(),
      closed: false,
    };
    current = session;
    muted = false;
    others = [];
    verifiedPeer = null;
    applyMute(session);
    return session;
  }

  const stale = (session: Session): boolean => session.closed || session !== current;

  function closeSession(session: Session): void {
    if (session.closed) return;
    session.closed = true;
    session.controlOpen = false;
    session.controlTrusted = false;
    for (const timer of session.timers) clearTimeout(timer);
    session.timers.clear();
    try {
      session.peer?.close();
    } catch {
      /* already closed */
    }
    stopStream(session.mic);
    if (session.remote) session.remote.track.enabled = false;
    ports.speaker.detach();
    if (current === session) {
      current = null;
      media = 'none';
    }
  }

  function after(session: Session, ms: number, fn: () => void): Timer {
    const timer = setTimeout(() => {
      session.timers.delete(timer);
      if (!stale(session)) fn();
    }, Math.max(0, ms));
    session.timers.add(timer);
    return timer;
  }

  function cancel(session: Session, timer: Timer | null): void {
    if (timer === null) return;
    clearTimeout(timer);
    session.timers.delete(timer);
  }

  const sleep = (session: Session, ms: number): Promise<void> =>
    new Promise((resolve) => {
      after(session, ms, resolve);
    });

  /** Run `step` after every earlier step of this session's peer work. */
  function enqueue(session: Session, step: () => Promise<void>): void {
    session.queue = session.queue.then(async () => {
      if (stale(session)) return;
      try {
        await step();
      } catch {
        fail(session, 'connect-failed', 'cannot-connect', 'connect-failed');
      }
    });
  }

  /**
   * Our microphone, as the peer connection sends it: OFF until the call is verified — until then the other end of
   * the media path may be anyone the signalling path chose, and a disabled track sends silence — then on unless muted.
   * Applied when the microphone is taken, at `verified`, and on every mute change.
   */
  function applyMute(session: Session): void {
    const open = !muted && machine.getState().name === 'verified';
    for (const track of session.mic?.getAudioTracks() ?? []) track.enabled = open;
  }

  // ── ends ──────────────────────────────────────────────────────────────────────────────────────

  /** End the call on what this side knows; tell the server when it has a call to tell about. */
  function fail(
    session: Session,
    reason: CallEndReason,
    why: AudioCallProblem | null,
    tell: CallClientEndReason | null,
  ): void {
    if (stale(session)) return;
    const state = machine.getState();
    if (tell && session.callId) ports.socket.send({ type: 'call:end', payload: { callId: session.callId, reason: tell } });
    problem = why ?? problem;
    if (reason === 'verify-failed' && state.name === 'connecting') {
      machine.send({ type: 'VERIFY_FAILED', callId: state.callId });
    } else {
      machine.send({ type: 'ABORT', reason });
    }
    // The machine's subscription closes the session; make sure even an unchanged state does.
    if (!stale(session)) closeSession(session);
    publish();
  }

  const verifyFail = (session: Session): void => fail(session, 'verify-failed', 'cannot-verify', 'verify-failed');

  // ── the peer ──────────────────────────────────────────────────────────────────────────────────

  const loadIce = (callId: string): Promise<IceOutcome> =>
    ports.iceServers(callId).then(
      (ice): IceOutcome => ({ ok: true, ice }),
      (): IceOutcome => ({ ok: false }),
    );

  /**
   * The ICE answer for an ACCEPTED call (only the server's `call:accept` leads here). `PENDING` then means the accept
   * outran the record the route reads: asked again, backing off, until the connect deadline closes the session (its
   * timer clears the wait). Any other answer is final.
   */
  async function acceptedIce(session: Session): Promise<IceOutcome> {
    const callId = session.callId ?? '';
    for (let attempt = 0; ; attempt += 1) {
      const outcome = await loadIce(callId);
      if (stale(session) || !outcome.ok || outcome.ice.status !== 'PENDING') return outcome;
      await sleep(session, Math.min(L.icePendingRetryMs * 2 ** Math.min(attempt, 8), L.icePendingRetryMaxMs));
    }
  }

  /**
   * The set `ice` is what the peer holds now. The CALLER renews it before it expires: counted from `expiresInMs`
   * where the server says it (no clock compared), else from `expiresAt` against this device's clock — the lead (half
   * the server's renew window) absorbing a clock that far behind. The callee never renews on a clock of its own: a
   * fresh set is of no use to its live allocation until the caller's restart, and it tops up then (`restartOffered`),
   * which keeps its sets in step with the caller's.
   */
  function holdIce(session: Session, ice: CallIceAnswer): void {
    session.iceExpiresAt = ice.status === 'OK' && ice.expiresAt !== undefined ? ice.expiresAt : null;
    session.iceHeldUntil =
      session.iceExpiresAt !== null && ice.expiresInMs !== undefined ? now() + ice.expiresInMs : null;
    session.iceRetries = 0;
    cancel(session, session.iceRenew);
    session.iceRenew = null;
    if (session.iceExpiresAt === null || session.role !== 'caller') return;
    const left = ice.expiresInMs ?? session.iceExpiresAt - now();
    renewAfter(session, Math.max(L.iceRenewMinMs, left - L.iceRenewLeadMs));
  }

  function renewAfter(session: Session, ms: number): void {
    session.iceRenew = after(session, ms, () => {
      session.iceRenew = null;
      void renewIce(session);
    });
  }

  /** The answer, when it is a set that expires later than the one held (on a relay call, one with TURN); else null. */
  function freshIce(session: Session, outcome: IceOutcome): CallIceAnswer | null {
    const held = session.iceExpiresAt;
    const ice = outcome.ok ? outcome.ice : null;
    if (held === null || ice?.status !== 'OK' || ice.expiresAt === undefined || ice.expiresAt <= held) return null;
    return !session.relay || hasRelay(ice.iceServers) ? ice : null;
  }

  /** A fresher set: to the browser, for its next gathering, and held (renewed in its turn). */
  function adoptIce(session: Session, ice: CallIceAnswer): void {
    session.peer?.setIceServers(ice.iceServers);
    holdIce(session, ice);
  }

  /**
   * Callee: is a top-up worth an ask? Only inside the held set's last `CALL_LIMITS.turnRenewWindowMs`, by this device's
   * clock: before it the route hands back the very set held, so the ask buys nothing and spends one of this person's
   * hourly ICE requests — which a hostile caller could otherwise drain with restart offers (final review, L2). No set
   * held: nothing to top up (`freshIce` drops any answer). A server that did not say how long: asked, as before — the
   * window cannot be placed without comparing clocks, and the quota is ours to spend, not the peer's to force.
   */
  function topUpDue(session: Session): boolean {
    if (session.iceExpiresAt === null) return false;
    if (session.iceHeldUntil === null) return true;
    return session.iceHeldUntil - now() <= CALL_LIMITS.turnRenewWindowMs;
  }

  /** The route asked once, for a restart: not waited on past `within` (a failure, then). */
  function askIce(session: Session, within: number): Promise<IceOutcome> {
    return new Promise((resolve) => {
      const timer = after(session, within, () => resolve({ ok: false }));
      void loadIce(session.callId ?? '').then((outcome) => {
        cancel(session, timer);
        resolve(outcome);
      });
    });
  }

  /**
   * Caller: ask for a fresh set while the call lives. A set that expires later than the held one goes to the
   * connection, is renewed in its turn, and the live path is moved onto it (`restartFor`); anything else — a failure,
   * the same set (asked early by a fast clock), a relay call's answer with no TURN in it — leaves the call untouched
   * and asks again later, backing off.
   */
  async function renewIce(session: Session): Promise<void> {
    if (session.iceExpiresAt === null || !session.callId) return;
    const outcome = await loadIce(session.callId);
    if (stale(session)) return;
    const ice = freshIce(session, outcome);
    if (ice) {
      adoptIce(session, ice);
      restartFor(session, ice);
      return;
    }
    const wait = Math.min(L.iceRenewRetryMs * 2 ** Math.min(session.iceRetries, 8), CALL_LIMITS.turnRenewWindowMs);
    session.iceRetries += 1;
    renewAfter(session, wait);
  }

  // ── the ICE restart onto a fresh set (ADR-211 amendment of 2026-11-15) ───────────────────────────

  /**
   * A fresher set is in the browser, but a live TURN allocation keeps the credential it was made with and dies with
   * it. The caller moves the call onto the fresh set: an ICE restart, whose new candidates are gathered with it. Only
   * the caller — the callee never offers, so two offers never cross — and only when the set has TURN in it (no
   * allocation, nothing to move), on a verified call, one restart at a time; a new set opens a new count of attempts.
   */
  function restartFor(session: Session, ice: CallIceAnswer): void {
    if (session.role !== 'caller' || !hasRelay(ice.iceServers) || !session.remoteSet || session.restart) return;
    if (machine.getState().name !== 'verified') return;
    session.restartAttempts = 0;
    startRestart(session);
  }

  function startRestart(session: Session): void {
    session.restartAttempts += 1;
    const restart: Restart = {
      phase: 'offering',
      ufrag: null,
      deadline: after(session, L.iceRestartMs, () => missedRestart(session, restart)),
    };
    session.restart = restart;
    enqueue(session, async () => {
      const peer = session.peer;
      if (!peer || session.restart !== restart) return;
      // A candidate of the new generation is no use before the offer that names its credentials: held till then.
      session.localSdpSent = false;
      session.pendingLocal = [];
      let sdp: string;
      try {
        sdp = await peer.restartIce();
      } catch {
        return; // the browser would not: the deadline drops it and tries once more
      }
      if (stale(session) || session.restart !== restart) return;
      const out = restartSdp(session, 'local', sdp);
      if (out === null) return;
      restart.phase = 'offered';
      restart.ufrag = sdpIceUfrag(out);
      sendSignal(session, { kind: 'offer', sdp: out });
      releaseLocal(session);
    });
  }

  /**
   * An SDP of a restart, ours or the peer's, against what the call's first exchange bound: the same one fingerprint
   * over one bundled transport (the certificate the tags bound) and the same m-lines (`sdpLayout`: none added, none
   * renamed, RTCP still muxed) — else the call ends `verify-failed` and this is null. Filtered as every SDP of the
   * call is: relay-only both ways.
   */
  function restartSdp(session: Session, side: 'local' | 'remote', sdp: string): string | null {
    const out = session.relay ? relayOnlySdp(sdp) : sdp;
    const fingerprint = side === 'local' ? session.localFp : session.remoteFp;
    const layout = side === 'local' ? session.localLayout : session.remoteLayout;
    if (fingerprint === null || layout === null || boundFingerprint(out) !== fingerprint || sdpLayout(out) !== layout) {
      verifyFail(session);
      return null;
    }
    if (out.length > CALL_LIMITS.sdpMaxChars) {
      fail(session, 'connect-failed', 'cannot-connect', 'connect-failed');
      return null;
    }
    return out;
  }

  /** Caller: the answer to our restart offer — checked as the offer was, applied, then the path watched onto it. */
  async function restartAnswered(session: Session, peer: CallPeer, restart: Restart, sdp: string): Promise<void> {
    const out = restartSdp(session, 'remote', sdp);
    if (out === null) return;
    const ufrag = sdpIceUfrag(out);
    if (ufrag === null || ufrag === session.remoteUfrag) return; // no answer to a restart: dropped
    restart.phase = 'answered';
    try {
      await peer.setAnswer(out);
    } catch {
      return; // refused by the browser: the deadline drops the offer and tries once more
    }
    if (stale(session) || session.restart !== restart) return;
    if (!appliedAsRead(peer, session.remoteFp ?? '')) return verifyFail(session);
    session.remoteUfrag = ufrag;
    watchRestart(session, restart);
  }

  /**
   * Done when the audio's candidate pair is of the new generation (its local ufrag is the restart's) — or when the
   * browser cannot say which pair it uses, and the answer applied is the most that can be known. Else looked at again
   * shortly, until the deadline.
   */
  function watchRestart(session: Session, restart: Restart): void {
    if (session.restart !== restart) return;
    const path = session.peer?.pathUfrag() ?? null;
    if (path === null || path === restart.ufrag) {
      cancel(session, restart.deadline);
      session.restart = null;
      return;
    }
    after(session, L.restartPollMs, () => watchRestart(session, restart));
  }

  /**
   * The restart's deadline passed: no answer, or the path never moved onto the new generation. The offer still
   * waiting is dropped — the old path never stopped carrying the call — then the next renewal attempt (the route
   * asked once, not waited on for long) and one more restart; after the last attempt, nothing until the next fresh
   * set. A path that dies meanwhile ends the call (`mediaDownMs`): never a loop, never a hang.
   */
  function missedRestart(session: Session, restart: Restart): void {
    if (session.restart !== restart) return;
    session.restart = null;
    enqueue(session, async () => {
      await session.peer?.rollback().catch(() => undefined);
      if (stale(session)) return;
      session.pendingLocal = []; // the dropped generation's candidates go nowhere
      session.localSdpSent = true;
      if (session.restartAttempts >= L.iceRestartAttempts) return;
      const ice = freshIce(session, await askIce(session, L.iceTopUpMs));
      if (stale(session) || session.restart) return;
      if (ice) adoptIce(session, ice);
      startRestart(session);
    });
  }

  /**
   * Callee: the caller's restart offer, on a verified call. Checked against what the first exchange bound (else the
   * call ends) and dropped when it is no restart (the ICE credentials it had). Our set is topped up first when it is
   * due (`topUpDue`) — the browser gathers the answer's candidates with what it holds then — but not waited on past
   * `iceTopUpMs`.
   */
  async function restartOffered(session: Session, peer: CallPeer, sdp: string): Promise<void> {
    if (machine.getState().name !== 'verified') return;
    const out = restartSdp(session, 'remote', sdp);
    if (out === null) return;
    const ufrag = sdpIceUfrag(out);
    if (ufrag === null || ufrag === session.remoteUfrag) return;
    const ice = topUpDue(session) ? freshIce(session, await askIce(session, L.iceTopUpMs)) : null;
    if (stale(session)) return;
    if (ice) adoptIce(session, ice);
    session.localSdpSent = false;
    session.pendingLocal = [];
    let answer: string;
    try {
      answer = await peer.acceptOffer(out);
    } catch {
      // The browser would not: the call goes on over the path it has; the caller's deadline tries once more.
      await peer.rollback().catch(() => undefined);
      session.pendingLocal = [];
      session.localSdpSent = true;
      return;
    }
    if (stale(session)) return;
    if (!appliedAsRead(peer, session.remoteFp ?? '')) return verifyFail(session);
    const local = restartSdp(session, 'local', answer);
    if (local === null) return;
    session.remoteUfrag = ufrag;
    sendSignal(session, { kind: 'answer', sdp: local });
    releaseLocal(session);
  }

  function sendSignal(session: Session, signal: CallSignal): void {
    if (!session.callId) return;
    ports.socket.send({ type: 'call:ice', payload: { callId: session.callId, signal } });
  }

  /** A local candidate, or the end of them: filtered, then sent once our SDP is out. */
  function onLocalCandidate(session: Session, candidate: CallCandidate | null): void {
    if (stale(session)) return;
    let signal: CallSignal;
    if (candidate === null) {
      signal = { kind: 'end-of-candidates' };
    } else {
      if (!candidate.candidate || candidate.candidate.length > CALL_LIMITS.candidateMaxChars) return;
      if (session.relay && !isRelayCandidate(candidate.candidate)) return;
      signal = {
        kind: 'candidate',
        candidate: session.relay ? scrubRelayCandidate(candidate.candidate) : candidate.candidate,
        sdpMid: candidate.sdpMid,
        sdpMLineIndex: candidate.sdpMLineIndex,
      };
    }
    if (!session.localSdpSent) {
      if (session.pendingLocal.length < L.pendingSignalsMax) session.pendingLocal.push(signal);
      return;
    }
    sendSignal(session, signal);
  }

  /** Our SDP, checked (one fingerprint, one bundled transport) and filtered, out; then the candidates that waited. */
  function sendLocalSdp(session: Session, kind: 'offer' | 'answer', sdp: string): boolean {
    const fingerprint = boundFingerprint(sdp);
    if (!fingerprint) {
      verifyFail(session);
      return false;
    }
    const out = session.relay ? relayOnlySdp(sdp) : sdp;
    if (out.length > CALL_LIMITS.sdpMaxChars) {
      fail(session, 'connect-failed', 'cannot-connect', 'connect-failed');
      return false;
    }
    session.localFp = fingerprint;
    session.localLayout = sdpLayout(out);
    sendSignal(session, { kind, sdp: out });
    if (kind === 'offer') session.offerSent = true;
    releaseLocal(session);
    return true;
  }

  /** Our SDP is out: the candidates that waited for it follow. */
  function releaseLocal(session: Session): void {
    session.localSdpSent = true;
    const held = session.pendingLocal;
    session.pendingLocal = [];
    for (const signal of held) sendSignal(session, signal);
  }

  async function flushRemoteCandidates(session: Session): Promise<void> {
    const held = session.pendingRemote;
    session.pendingRemote = [];
    for (const candidate of held) {
      if (stale(session)) return;
      await session.peer?.addCandidate(candidate).catch(() => undefined);
    }
  }

  /**
   * The peer's first SDP, checked (one fingerprint, one bundled transport) and filtered exactly as handed to the
   * browser; what it binds — the fingerprint, the m-lines, the ICE ufrag — is the session's from then on.
   */
  function remoteSdp(session: Session, sdp: string): string | null {
    const toSet = session.relay ? relayOnlySdp(sdp) : sdp;
    const fingerprint = boundFingerprint(toSet);
    if (!fingerprint) return null;
    session.remoteFp = fingerprint;
    session.remoteLayout = sdpLayout(toSet);
    session.remoteUfrag = sdpIceUfrag(toSet);
    return toSet;
  }

  /**
   * What the browser applied binds the fingerprint the engine read. The engine parsed the text it handed over; DTLS
   * enforces what the browser parsed. Read back from the browser's own description, it must be the same one value
   * over one bundled transport — any difference between the two readings ends the call before a tag goes out.
   */
  function appliedAsRead(peer: CallPeer, fingerprint: string): boolean {
    const applied = peer.appliedRemoteSdp();
    return applied !== null && boundFingerprint(applied) === fingerprint;
  }

  async function setupPeer(session: Session): Promise<void> {
    const outcome = await acceptedIce(session);
    if (stale(session)) return;
    const why = iceProblem(outcome);
    if (why || !outcome.ok) {
      fail(session, 'connect-failed', why ?? 'cannot-connect', 'connect-failed');
      return;
    }
    session.relay = outcome.ice.iceTransportPolicy !== 'all';
    const peer = ports.createPeer(
      {
        iceServers: outcome.ice.iceServers,
        iceTransportPolicy: session.relay ? 'relay' : 'all',
        control: CALL_CONTROL_CHANNEL,
      },
      {
        candidate: (candidate) => onLocalCandidate(session, candidate),
        track: (track, stream) => onRemoteTrack(session, track, stream),
        state: (state) => onPeerState(session, state),
        control: (event) => onControl(session, event),
        transport: () => void checkTransport(session),
      },
    );
    session.peer = peer;
    holdIce(session, outcome.ice);
    for (const track of session.mic?.getAudioTracks() ?? []) peer.addTrack(track, session.mic!);
    if (session.role === 'caller') {
      const offer = await peer.createOffer();
      if (stale(session)) return;
      if (!sendLocalSdp(session, 'offer', offer)) return;
    }
    const early = session.early;
    session.early = [];
    for (const signal of early) {
      if (stale(session)) return;
      await handleSignal(session, signal);
    }
  }

  async function handleSignal(session: Session, signal: CallSignal): Promise<void> {
    const peer = session.peer;
    if (stale(session) || !peer) return;
    switch (signal.kind) {
      case 'offer': {
        // Only the callee takes an offer: the call's first, then only ICE restarts.
        if (session.role !== 'callee') return;
        if (session.remoteSet) return restartOffered(session, peer, signal.sdp);
        const remote = remoteSdp(session, signal.sdp);
        if (!remote) return verifyFail(session);
        const answer = await peer.acceptOffer(remote);
        if (stale(session)) return;
        session.remoteSet = true;
        if (!appliedAsRead(peer, session.remoteFp ?? '')) return verifyFail(session);
        if (!sendLocalSdp(session, 'answer', answer)) return;
        await flushRemoteCandidates(session);
        startTags(session);
        return;
      }
      case 'answer': {
        if (session.role !== 'caller') return;
        // The answer to a restart offer, while one waits; else the call's first, once.
        const restart = session.restart;
        if (restart) return restart.phase === 'offered' ? restartAnswered(session, peer, restart, signal.sdp) : undefined;
        if (!session.offerSent || session.remoteSet) return;
        const remote = remoteSdp(session, signal.sdp);
        if (!remote) return verifyFail(session);
        await peer.setAnswer(remote);
        if (stale(session)) return;
        session.remoteSet = true;
        if (!appliedAsRead(peer, session.remoteFp ?? '')) return verifyFail(session);
        await flushRemoteCandidates(session);
        startTags(session);
        return;
      }
      case 'candidate': {
        if (session.relay && !isRelayCandidate(signal.candidate)) return;
        const candidate: CallCandidate = {
          candidate: session.relay ? scrubRelayCandidate(signal.candidate) : signal.candidate,
          sdpMid: signal.sdpMid,
          sdpMLineIndex: signal.sdpMLineIndex,
        };
        if (!session.remoteSet) {
          if (session.pendingRemote.length < L.pendingSignalsMax) session.pendingRemote.push(candidate);
          return;
        }
        await peer.addCandidate(candidate).catch(() => undefined);
        return;
      }
      case 'end-of-candidates': {
        if (!session.remoteSet) {
          if (session.pendingRemote.length < L.pendingSignalsMax) session.pendingRemote.push(null);
          return;
        }
        await peer.addCandidate(null).catch(() => undefined);
        return;
      }
    }
  }

  function onRemoteTrack(session: Session, track: MediaStreamTrack, stream: MediaStream): void {
    if (stale(session)) return;
    // HELD: silent and attached to nothing until the machine is `verified`.
    track.enabled = false;
    session.remote = { track, stream };
    if (machine.getState().name === 'verified') play(session);
  }

  function play(session: Session): void {
    const remote = session.remote;
    if (!remote || machine.getState().name !== 'verified') return;
    remote.track.enabled = true;
    void ports.speaker.attach(remote.stream).then((playing) => {
      if (stale(session)) return;
      if (!playing) setProblem('speaker-blocked');
      else if (problem === 'speaker-blocked') setProblem(null);
    });
  }

  function onPeerState(session: Session, state: CallPeerState): void {
    if (stale(session)) return;
    if (state === 'connected') {
      cancel(session, session.mediaDown);
      session.mediaDown = null;
      session.mediaUp = true;
      session.mediaEver = true;
      setMedia('connected');
      void confirm(session);
      void checkTransport(session); // back after a drop: still the same transport, the same certificate?
    } else if (state === 'disconnected') {
      session.mediaUp = false;
      setMedia('connecting');
      // Up once, down now. A browser may stay `disconnected` for good (its TURN allocation gone with the credential,
      // and no restart got the call off it): that is a lost call, not one left hanging.
      if (session.mediaEver && session.mediaDown === null) {
        session.mediaDown = after(session, L.mediaDownMs, () => fail(session, 'lost', null, 'connect-failed'));
      }
    } else if (state === 'failed') {
      // Up once and then gone: the network dropped. Never up: the path could not be set up.
      if (session.mediaEver) fail(session, 'lost', null, 'connect-failed');
      else fail(session, 'connect-failed', 'cannot-connect', 'connect-failed');
    }
  }

  /**
   * The control channel. Before the call is verified — and before the channel passed the transport check — the
   * other end of it may be anyone the signalling path chose, so a message then is DROPPED, not held for later,
   * exactly as the remote audio is not attached.
   *
   * The peer is bounded whether or not it is heard yet: a message that is not text, one over the size limit, or
   * more than `controlMessagesPerSecond` in one second closes the channel for the rest of the call (ADR-215 counts
   * that as a leave). The audio call goes on. The browser offers no bound on what it receives, so this is the bound.
   */
  function onControl(session: Session, event: CallControlEvent): void {
    if (stale(session)) return;
    if (event.kind === 'open' || event.kind === 'close') {
      session.controlOpen = event.kind === 'open' && !session.controlShut;
      publish();
      if (session.controlOpen) void checkTransport(session);
      return;
    }
    if (session.controlShut) return;
    const at = now();
    if (at - session.controlWindowAt >= 1_000) {
      session.controlWindowAt = at;
      session.controlCount = 0;
    }
    session.controlCount += 1;
    const { data } = event;
    if (
      session.controlCount > L.controlMessagesPerSecond ||
      typeof data !== 'string' ||
      data.length > L.controlMessageMaxChars
    ) {
      shutControl(session);
      return;
    }
    if (machine.getState().name !== 'verified' || !session.controlTrusted) return;
    for (const listener of [...controlListeners]) listener(data);
  }

  function shutControl(session: Session): void {
    session.controlShut = true;
    session.controlOpen = false;
    session.peer?.closeControl();
    publish();
  }

  // ── the check (decision 4) ────────────────────────────────────────────────────────────────────

  function bindingOf(session: Session): Omit<CallTagRequest, 'role'> | null {
    const { callId, role, peerDeviceId, localFp, remoteFp } = session;
    if (!callId || !role || !peerDeviceId || !localFp || !remoteFp) return null;
    const caller = role === 'caller';
    return {
      conversationId: session.conversationId,
      callId,
      callerDeviceId: caller ? session.localDeviceId : peerDeviceId,
      calleeDeviceId: caller ? peerDeviceId : session.localDeviceId,
      fingerprintCaller: caller ? localFp : remoteFp,
      fingerprintCallee: caller ? remoteFp : localFp,
    };
  }

  function startTags(session: Session): void {
    if (session.tagsStarted || stale(session)) return;
    session.tagsStarted = true;
    session.verifyStartedAt = now();
    // A tag that never comes, or a check that never passes, is a failure — never "verified".
    after(session, L.verifyWindowMs, () => {
      if (!session.tagOk) verifyFail(session);
    });
    void (async () => {
      if (!(await sendTag(session, false))) return;
      kickVerify(session);
    })();
  }

  /** Compute our tag (catching the room up first when `fresh`) and send it if it changed. */
  async function sendTag(session: Session, fresh: boolean): Promise<boolean> {
    const binding = bindingOf(session);
    if (!binding || !ports.binding || !session.role) {
      verifyFail(session);
      return false;
    }
    let answer: CallTagAnswer;
    try {
      answer = await ports.binding.callTag({ ...binding, role: session.role, fresh });
    } catch {
      verifyFail(session);
      return false;
    }
    if (stale(session)) return false;
    others = answer.others ?? [];
    publish();
    if (answer.tag !== session.lastTag) {
      session.lastTag = answer.tag;
      session.sentTags.add(answer.tag);
      ports.socket.send({ type: 'call:verify', payload: { callId: binding.callId, tag: answer.tag } });
    }
    return true;
  }

  function onPeerTag(session: Session, tag: string): void {
    if (stale(session) || session.tagOk) return;
    session.peerTags += 1;
    // Our own tag bounced back is a failure at once (decision 4, review finding V1).
    if (session.sentTags.has(tag) || session.peerTags > L.peerTagsMax) {
      verifyFail(session);
      return;
    }
    session.peerTag = tag;
    kickVerify(session);
  }

  function kickVerify(session: Session): void {
    if (session.verifying) {
      session.reverify = true;
      return;
    }
    void runVerify(session);
  }

  async function runVerify(session: Session): Promise<void> {
    session.verifying = true;
    try {
      for (;;) {
        session.reverify = false;
        if (stale(session) || session.tagOk) return;
        const binding = bindingOf(session);
        if (!binding || !session.lastTag || !session.peerTag || !session.role || !ports.binding) return;
        let answer: CallVerifyAnswer;
        try {
          answer = await ports.binding.callVerify({ ...binding, role: session.role, receivedTag: session.peerTag });
        } catch {
          verifyFail(session);
          return;
        }
        if (stale(session)) return;
        others = answer.others ?? others;
        publish();
        if (answer.ok) {
          // The worker names who it verified. A verdict that names nobody is no verdict; on the callee side the
          // person must be the one the ring named, or the screen showed a name the call cannot back.
          const peerUserId = typeof answer.peerUserId === 'string' && answer.peerUserId ? answer.peerUserId : null;
          if (!peerUserId || (session.ringCallerUserId !== null && peerUserId !== session.ringCallerUserId)) {
            verifyFail(session);
            return;
          }
          session.peerUserId = peerUserId;
          session.tagOk = true;
          await confirm(session);
          return;
        }
        if (session.reverify) continue; // a newer tag of the peer came in meanwhile
        if (session.retries >= L.verifyRetries || now() - session.verifyStartedAt >= L.verifyWindowMs) {
          verifyFail(session);
          return;
        }
        session.retries += 1;
        await sleep(session, L.verifyRetryStepMs * session.retries);
        if (stale(session)) return;
        // Catch the room up (own epoch only); a new epoch gives a new tag, which the peer needs.
        if (!(await sendTag(session, true))) return;
      }
    } finally {
      session.verifying = false;
    }
  }

  /** The fingerprint of the certificate in use, hashed as `tagged` names it; null when it cannot be computed. */
  const inUseFingerprint = (der: ArrayBuffer, tagged: string): Promise<string | null> => {
    const hash = fingerprintHash(tagged);
    return hash ? certificateFingerprint(der, hash).catch(() => null) : Promise.resolve(null);
  };

  /**
   * The tag checked out. Where the browser says which certificate DTLS accepted, it must hash to the fingerprint
   * the tag bound — then, and only then, `verified` and the audio plays. A browser that can name the certificate
   * and names none once DTLS is up has not said "I cannot tell": the engine looks again until it does, and the
   * connect deadline ends a call whose certificate never shows. The audio's DTLS transport at that moment is the one
   * the call is bound to from then on.
   */
  async function confirm(session: Session): Promise<void> {
    const peer = session.peer;
    const remoteFp = session.remoteFp;
    if (stale(session) || !session.tagOk || !peer || !remoteFp) return;
    const state = machine.getState();
    if (state.name !== 'connecting') return;
    const view = peer.transport();
    if (view.certificates !== null) {
      if (!session.mediaUp) return; // known once DTLS is up; `onPeerState` calls again
      const first = view.certificates[0];
      if (!first) {
        if (!session.certificateWait) {
          session.certificateWait = true;
          after(session, L.certificatePollMs, () => {
            session.certificateWait = false;
            void confirm(session);
          });
        }
        return;
      }
      const inUse = await inUseFingerprint(first, remoteFp);
      if (stale(session)) return;
      if (inUse !== remoteFp) {
        verifyFail(session);
        return;
      }
    }
    if (stale(session)) return;
    const again = machine.getState();
    if (again.name !== 'connecting') return;
    // The transport moved while the certificate was being hashed: what was checked is not what is in use.
    if (peer.transport().audio !== view.audio) {
      verifyFail(session);
      return;
    }
    session.boundTransport = view.audio;
    verifiedPeer = session.peerUserId ? { userId: session.peerUserId, deviceId: again.peerDeviceId } : null;
    machine.send({ type: 'VERIFIED', callId: again.callId });
    applyMute(session); // our microphone opens now — unless muted meanwhile
    play(session);
    void checkTransport(session);
  }

  /**
   * ADR-215 decision 4, for as long as the call is verified: the audio stays on the DTLS transport it was verified
   * on, and the certificate the peer presents there keeps hashing to the tagged fingerprint — either changing ends
   * the call (an ICE restart changes neither). The control channel is trusted only when its SCTP runs over that
   * same transport and the browser can name the certificate. Runs at `verified`, when the channel opens, on every
   * change of descriptions and on every reconnect.
   */
  async function checkTransport(session: Session): Promise<void> {
    const peer = session.peer;
    const remoteFp = session.remoteFp;
    if (stale(session) || !peer || !remoteFp || machine.getState().name !== 'verified') return;
    const check = ++session.transportChecks;
    const view = peer.transport();
    if (view.audio !== session.boundTransport) {
      verifyFail(session);
      return;
    }
    const first = view.certificates?.[0];
    let certified = false;
    if (first) {
      const inUse = await inUseFingerprint(first, remoteFp);
      if (stale(session)) return;
      if (inUse !== remoteFp || peer.transport().audio !== session.boundTransport) {
        verifyFail(session);
        return;
      }
      certified = true;
    }
    if (check !== session.transportChecks) return; // a newer check decides
    const trusted = certified && view.audio !== null && view.controlShared;
    if (trusted !== session.controlTrusted) {
      session.controlTrusted = trusted;
      publish();
    }
  }

  // ── server events ─────────────────────────────────────────────────────────────────────────────

  /**
   * The local end of a ring nobody answers: the ring's length plus a grace, from when the ring (or the invite's ack)
   * got HERE. Never from `ringUntil`: that is the server's clock, and set against this device's clock a minute's
   * skew would end every ring on arrival or let one ring on. The server ends the ring at its own `ringUntil`; this
   * is the backstop for a server that never says.
   */
  function armRingDeadline(session: Session): void {
    after(session, CALL_LIMITS.ringTimeoutMs + L.ringGraceMs, () => {
      const state = machine.getState();
      if ((state.name === 'incoming' || state.name === 'outgoing') && state.callId === session.callId) {
        fail(session, 'no-answer', null, state.name === 'outgoing' ? 'hangup' : null);
      }
    });
  }

  /**
   * After `dispose`: only the late ack of a call this engine abandoned is still handled — hung up, so nobody's phone
   * rings on for a call nobody is behind. Listening stops once no such ack is left to come.
   */
  function onLateAck(raw: unknown): void {
    const event = parseCallServerEvent(raw);
    if (event?.type === 'call:invite' && abandonedRequests.delete(event.payload.requestId)) {
      ports.socket.send({ type: 'call:end', payload: { callId: event.payload.callId, reason: 'hangup' } });
    } else if (event?.type === 'call:accept' && abandonedCalls.delete(event.payload.callId)) {
      ports.socket.send({ type: 'call:end', payload: { callId: event.payload.callId, reason: 'hangup' } });
    }
    if (abandonedRequests.size === 0 && abandonedCalls.size === 0) stopListening();
  }

  function onFrame(raw: unknown): void {
    if (disposed) {
      onLateAck(raw);
      return;
    }
    const event = parseCallServerEvent(raw);
    if (!event) return;
    const state = machine.getState();
    const session = current;
    switch (event.type) {
      case 'call:invite': {
        const { requestId, callId, ringUntil } = event.payload;
        if (state.name === 'inviting' && state.requestId === requestId && session && session.requestId === requestId) {
          machine.send({ type: 'INVITE_ACK', requestId, callId, ringUntil });
          session.callId = callId;
          armRingDeadline(session);
          // No ICE question yet: the route answers nothing but PENDING until the call is accepted.
        } else if (abandonedRequests.delete(requestId)) {
          ports.socket.send({ type: 'call:end', payload: { callId, reason: 'hangup' } });
        }
        return;
      }
      case 'call:ring': {
        const p = event.payload;
        const next = machine.send({
          type: 'RING',
          callId: p.callId,
          conversationId: p.conversationId,
          callerUserId: p.callerUserId,
          callerDeviceId: p.callerDeviceId,
          ringUntil: p.ringUntil,
        });
        // Busy (or a re-delivery): ignored — and never declined (decision 8).
        if (next === state || next.name !== 'incoming') return;
        const ringing = openSession({
          conversationId: p.conversationId,
          localDeviceId: ports.localDeviceId(),
          callId: p.callId,
          role: 'callee',
          peerDeviceId: p.callerDeviceId,
          ringCallerUserId: p.callerUserId,
        });
        problem = null;
        armRingDeadline(ringing);
        publish();
        return;
      }
      case 'call:accept': {
        const p = event.payload;
        if (abandonedCalls.delete(p.callId)) {
          // We hung up while our «Answer» was on its way, and it won: end it for the caller too.
          ports.socket.send({ type: 'call:end', payload: { callId: p.callId, reason: 'hangup' } });
          return;
        }
        if (!session) return;
        const next = machine.send({ type: 'ACCEPTED', ...p });
        if (next === state || next.name !== 'connecting') return;
        session.role = next.role;
        session.peerDeviceId = next.peerDeviceId;
        for (const timer of session.timers) clearTimeout(timer);
        session.timers.clear();
        // The server names the two devices; the one of our role must be this one.
        if ((next.role === 'caller' ? p.callerDeviceId : p.calleeDeviceId) !== session.localDeviceId) {
          verifyFail(session);
          return;
        }
        after(session, L.connectMs, () => {
          if (!session.mediaEver) fail(session, 'connect-failed', 'cannot-connect', 'connect-failed');
          else if (machine.getState().name !== 'verified') verifyFail(session);
        });
        setMedia('connecting');
        enqueue(session, () => setupPeer(session));
        return;
      }
      case 'call:ice': {
        if (!session || session.callId !== event.payload.callId) return;
        const signal = event.payload.signal;
        if (state.name === 'accepting') {
          // The offer may beat our own accept on another path: kept, in order, for the peer.
          if (session.early.length < L.pendingSignalsMax) session.early.push(signal);
          return;
        }
        if (state.name !== 'connecting' && state.name !== 'verified') return;
        if (!session.peer) {
          if (session.early.length < L.pendingSignalsMax) session.early.push(signal);
          return;
        }
        enqueue(session, () => handleSignal(session, signal));
        return;
      }
      case 'call:verify': {
        if (!session || session.callId !== event.payload.callId) return;
        if (state.name !== 'connecting') return;
        onPeerTag(session, event.payload.tag);
        return;
      }
      case 'call:end': {
        machine.send({ type: 'END', callId: event.payload.callId, reason: event.payload.reason });
        return;
      }
    }
  }

  function onSocketClosed(): void {
    if (disposed) return;
    const session = current;
    const state = machine.getState();
    if (!session || !isAudioCallBusy(state)) return;
    // A ring lives on the server: the next socket can still answer it. Everything else was bound to this socket.
    if (state.name === 'incoming') return;
    fail(session, 'lost', 'offline', null);
  }

  // ── the machine drives the teardown ───────────────────────────────────────────────────────────

  const unsubscribeMachine = machine.subscribe((state) => {
    if ((state.name === 'ended' || state.name === 'idle') && current) closeSession(current);
    publish();
  });
  const unsubscribeFrames = ports.socket.subscribe(onFrame);
  let lateAckTimer: ReturnType<typeof setTimeout> | null = null;
  let listening = true;
  function stopListening(): void {
    if (!listening) return;
    listening = false;
    if (lateAckTimer !== null) clearTimeout(lateAckTimer);
    unsubscribeFrames();
  }
  const unsubscribeClosed = ports.socket.onClosed(onSocketClosed);
  const unsubscribeInterrupted =
    ports.speaker.onInterrupted?.(() => {
      if (current && machine.getState().name === 'verified') setProblem('speaker-blocked');
    }) ?? (() => undefined);
  // A machine left by an earlier engine, mid-call or on its end: nothing of that call survives here — not even its end
  // screen, which may belong to the account that signed out of this tab (the machine is the tab's; review Д2б M3).
  if (isAudioCallBusy(machine.getState())) machine.send({ type: 'ABORT', reason: 'lost' });
  if (machine.getState().name === 'ended') machine.send({ type: 'CLOSE' });

  // ── commands ──────────────────────────────────────────────────────────────────────────────────

  async function call(conversationId: string): Promise<AudioCallResult> {
    if (disposed || !ports.binding) return { ok: false, reason: 'disabled' };
    if (starting !== null || isAudioCallBusy(machine.getState())) return { ok: false, reason: 'busy' };
    if (!ports.socket.isOpen()) {
      setProblem('offline');
      return { ok: false, reason: 'offline' };
    }
    const token = ++startSeq;
    starting = token;
    setProblem(null);
    let mic: MediaStream;
    try {
      mic = await ports.microphone();
    } catch (error) {
      if (starting !== token) return { ok: false, reason: 'cancelled' };
      starting = null;
      const why = micProblem(error);
      setProblem(why);
      return { ok: false, reason: why };
    }
    if (starting !== token || disposed) {
      stopStream(mic);
      return { ok: false, reason: 'cancelled' };
    }
    starting = null;
    // A ring may have come in while the microphone prompt was up.
    if (isAudioCallBusy(machine.getState())) {
      stopStream(mic);
      return { ok: false, reason: 'busy' };
    }
    if (!ports.socket.isOpen()) {
      stopStream(mic);
      setProblem('offline');
      return { ok: false, reason: 'offline' };
    }
    const requestId = ports.newRequestId();
    const localDeviceId = ports.localDeviceId();
    const session = openSession({ conversationId, localDeviceId, requestId, role: 'caller', mic });
    machine.send({ type: 'INVITE', requestId, conversationId, localDeviceId });
    if (!ports.socket.send({ type: 'call:invite', payload: { requestId, conversationId, deviceId: localDeviceId } })) {
      fail(session, 'lost', 'offline', null);
      return { ok: false, reason: 'offline' };
    }
    after(session, L.inviteAckMs, () => {
      const s = machine.getState();
      if (s.name === 'inviting' && s.requestId === requestId) fail(session, 'lost', 'offline', null);
    });
    return { ok: true };
  }

  async function answer(): Promise<AudioCallResult> {
    const state = machine.getState();
    const session = current;
    if (disposed || !ports.binding) return { ok: false, reason: 'disabled' };
    if (state.name !== 'incoming' || !session || session.callId !== state.callId) return { ok: false, reason: 'not-ringing' };
    if (!ports.socket.isOpen()) {
      setProblem('offline');
      return { ok: false, reason: 'offline' };
    }
    let mic: MediaStream;
    try {
      mic = await ports.microphone();
    } catch (error) {
      if (stale(session)) return { ok: false, reason: 'gone' };
      const why = micProblem(error);
      setProblem(why);
      return { ok: false, reason: why };
    }
    const still = machine.getState();
    if (stale(session) || still.name !== 'incoming' || still.callId !== state.callId) {
      stopStream(mic);
      return { ok: false, reason: 'gone' };
    }
    session.mic = mic;
    applyMute(session);
    // No ICE question yet: this device's answer may still lose to another one; the server's `call:accept` asks.
    problem = null;
    machine.send({ type: 'ACCEPT', localDeviceId: session.localDeviceId });
    if (!ports.socket.send({ type: 'call:accept', payload: { callId: state.callId, deviceId: session.localDeviceId } })) {
      fail(session, 'lost', 'offline', null);
      return { ok: false, reason: 'offline' };
    }
    for (const timer of session.timers) clearTimeout(timer);
    session.timers.clear();
    after(session, L.acceptAckMs, () => {
      const s = machine.getState();
      if (s.name === 'accepting' && s.callId === state.callId) fail(session, 'lost', 'offline', null);
    });
    publish();
    return { ok: true };
  }

  function decline(): void {
    const state = machine.getState();
    if (state.name !== 'incoming') return;
    ports.socket.send({ type: 'call:decline', payload: { callId: state.callId } });
    machine.send({ type: 'DECLINE' });
  }

  function hangUp(): void {
    if (starting !== null) {
      starting = null; // the microphone prompt's answer is dropped when it comes
      return;
    }
    const state = machine.getState();
    switch (state.name) {
      case 'incoming':
        decline();
        return;
      case 'inviting':
        remember(abandonedRequests, state.requestId);
        machine.send({ type: 'HANGUP' });
        return;
      case 'accepting':
        remember(abandonedCalls, state.callId);
        machine.send({ type: 'HANGUP' });
        return;
      case 'outgoing':
      case 'connecting':
      case 'verified':
        ports.socket.send({ type: 'call:end', payload: { callId: state.callId, reason: 'hangup' } });
        machine.send({ type: 'HANGUP' });
        return;
      default:
        return;
    }
  }

  function setMuted(next: boolean): void {
    muted = next;
    if (current) applyMute(current);
    publish();
  }

  async function resumeSpeaker(): Promise<boolean> {
    const session = current;
    if (!session || machine.getState().name !== 'verified') return false;
    const playing = await ports.speaker.resume();
    if (!stale(session)) setProblem(playing ? null : 'speaker-blocked');
    return playing;
  }

  function dismiss(): void {
    if (machine.getState().name === 'ended') machine.send({ type: 'CLOSE' });
    setProblem(null);
  }

  function sendControl(text: string): boolean {
    const session = current;
    if (
      disposed ||
      !session ||
      stale(session) ||
      !session.peer ||
      !session.controlOpen ||
      !session.controlTrusted ||
      machine.getState().name !== 'verified'
    ) {
      return false;
    }
    if (typeof text !== 'string' || text.length > L.controlMessageMaxChars) return false;
    return session.peer.sendControl(text);
  }

  /** The live session of a verified call, or null. */
  function verifiedSession(): Session | null {
    const session = current;
    if (disposed || !session || stale(session) || !session.peer || machine.getState().name !== 'verified') return null;
    return session;
  }

  const micTrackOf = (session: Session): MediaStreamTrack | null => session.mic?.getAudioTracks()[0] ?? null;

  function localTrack(): MediaStreamTrack | null {
    const session = verifiedSession();
    return session ? micTrackOf(session) : null;
  }

  function replaceOutboundTrack(track: MediaStreamTrack | null): Promise<boolean> {
    const session = current;
    if (!session || stale(session)) return Promise.resolve(false);
    const swap = async (): Promise<boolean> => {
      // Asked again when its turn comes: the call may have ended, or stopped being verified, meanwhile.
      if (verifiedSession() !== session) return false;
      const peer = session.peer!;
      const mic = micTrackOf(session);
      try {
        await peer.replaceAudioTrack(track ?? mic);
        return !stale(session);
      } catch {
        if (stale(session)) return false;
        try {
          await peer.replaceAudioTrack(mic);
        } catch {
          // Neither the graph nor the microphone: whatever the sender holds now is not what anyone chose.
          fail(session, 'connect-failed', 'cannot-connect', 'connect-failed');
        }
        return false;
      }
    };
    const result = session.outbound.then(swap, swap);
    session.outbound = result;
    return result;
  }

  function dispose(): void {
    if (disposed) return;
    starting = null;
    const state = machine.getState();
    if (state.name === 'incoming') machine.send({ type: 'ABORT', reason: 'lost' }); // go quiet; the ring is not ours to decline
    else hangUp();
    disposed = true;
    if (current) closeSession(current);
    // A call just started or answered is still acked by the server: keep listening for those acks alone, as long
    // as one could come, and hang each one up (`onLateAck`).
    if (abandonedRequests.size > 0 || abandonedCalls.size > 0) {
      lateAckTimer = setTimeout(stopListening, Math.max(L.inviteAckMs, L.acceptAckMs));
    } else {
      stopListening();
    }
    unsubscribeClosed();
    unsubscribeInterrupted();
    unsubscribeMachine();
    ports.speaker.dispose?.();
    listeners.clear();
    controlListeners.clear();
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    call,
    answer,
    decline,
    hangUp,
    setMuted,
    resumeSpeaker,
    dismiss,
    sendControl,
    onControlMessage(listener) {
      controlListeners.add(listener);
      return () => {
        controlListeners.delete(listener);
      };
    },
    localTrack,
    replaceOutboundTrack,
    dispose,
  };
}
