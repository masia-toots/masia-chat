/**
 * Fakes for the call engine's ports (`call-engine.ts`). The tag logic is NOT faked: the binding port runs the
 * worker's own `callTag` / `callVerify` (`call-binding.ts`) over a keyring whose `K` depends on the epoch each
 * device holds — so reflection, membership and epoch skew behave exactly as in the worker.
 */
import { createHash } from 'node:crypto';
import { vi } from 'vitest';
import { CALL_LIMITS, type CallClientEvent } from '@masia/contracts/wire';
import { createAudioCallMachine } from '../audio-call-machine.js';
import {
  callTag,
  callVerify,
  type CallBindingInput,
  type CallKeyring,
} from '../index.js';
import type { DeviceIdentity as RoomMember } from '../../mls/credential.js';
import {
  createAudioCallEngine,
  type CallBindingPort,
  type CallCandidate,
  type CallIceAnswer,
  type CallIceServer,
  type CallPeer,
  type CallPeerConfig,
  type CallPeerEvents,
  type CallSpeaker,
  type CallTransportView,
} from '../index.js';

export const CONV = '6f1c2b1e-3a4d-4c5e-8f90-1a2b3c4d5e6f';
export const CALL = 'c0000000000000000000a1';
export const CALL_2 = 'c0000000000000000000b2';
export const DEV_A = 'dev-a';
export const DEV_B = 'dev-b';
export const ALICE = '11111111-1111-4111-8111-111111111111';
export const BOB = '22222222-2222-4222-8222-222222222222';
/** A third person: never a party of the 1:1 room between the two above. */
export const CAROL = '33333333-3333-4333-8333-333333333333';
export const RING_UNTIL = '2026-11-15T10:00:45.000Z';
export const T0 = Date.parse('2026-11-15T10:00:00.000Z');

const hex = (byte: string, n = 32) => `${`${byte}:`.repeat(n - 1)}${byte}`;
/** Stand-ins for the DER certificates each side's DTLS presents; the fingerprints below are their real SHA-256. */
export const CERT_A = new Uint8Array([48, 3, 1, 1, 0xa]).buffer;
export const CERT_B = new Uint8Array([48, 3, 1, 1, 0xb]).buffer;
const fingerprintOf = (der: ArrayBuffer): string =>
  `sha-256 ${(createHash('sha256').update(new Uint8Array(der)).digest('hex').toUpperCase().match(/../g) ?? []).join(':')}`;
export const FP_A = fingerprintOf(CERT_A);
export const FP_B = fingerprintOf(CERT_B);
/** What a signalling path in the middle would put in an SDP instead. */
export const FP_M = `sha-256 ${hex('EE')}`;

export const HOST = 'candidate:1 1 udp 2122260223 192.168.1.20 54321 typ host generation 0';
export const SRFLX = 'candidate:2 1 udp 1686052607 203.0.113.7 54321 typ srflx raddr 192.168.1.20 rport 54321 generation 0';
export const RELAY = 'candidate:3 1 udp 41885439 198.51.100.9 3478 typ relay raddr 203.0.113.7 rport 54321 generation 0';
export const RELAY_SCRUBBED = 'candidate:3 1 udp 41885439 198.51.100.9 3478 typ relay raddr 0.0.0.0 rport 0 generation 0';

/** How an SDP is laid out beyond its fingerprints — what a signalling path could rewrite. */
export interface SdpShape {
  /** The application (control channel) m-section's fingerprint lines; default: the same as the audio one's. */
  readonly app?: string | readonly string[];
  /** The `a=group:BUNDLE` mids; null = no BUNDLE group at all. Default `0 1`: both m-sections on one transport. */
  readonly bundle?: string | null;
  /** The ICE username fragment, the same in every m-section (an ICE restart gives a new one). Default `abcd`. */
  readonly ufrag?: string;
  /** The audio m-section without `a=rtcp-mux`. */
  readonly noMux?: boolean;
  /** Lines after the last m-section — e.g. a third m-line a signalling path added. */
  readonly extra?: readonly string[];
}

/** The ICE ufrag of an SDP made with the default shape. */
export const UFRAG = 'abcd';

/**
 * A browser-shaped SDP: an audio m-section (mid 0, with the embedded candidates) and the control channel's
 * application m-section (mid 1), each carrying its own fingerprint line(s), both in one BUNDLE group.
 */
export function sdpWith(
  fingerprints: string | readonly string[],
  candidates: readonly string[] = [],
  shape: SdpShape = {},
): string {
  const lines = (fp: string | readonly string[]) => (typeof fp === 'string' ? [fp] : fp).map((f) => `a=fingerprint:${f}`);
  const bundle = shape.bundle === undefined ? '0 1' : shape.bundle;
  const ufrag = shape.ufrag ?? UFRAG;
  return [
    'v=0',
    'o=- 1 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    ...(bundle === null ? [] : [`a=group:BUNDLE ${bundle}`]),
    'm=audio 9 UDP/TLS/RTP/SAVPF 111',
    'c=IN IP4 0.0.0.0',
    `a=ice-ufrag:${ufrag}`,
    'a=ice-pwd:abcdefghijklmnopqrstuvwx',
    ...lines(fingerprints),
    'a=setup:actpass',
    'a=mid:0',
    ...candidates.map((c) => `a=${c}`),
    ...(shape.noMux ? [] : ['a=rtcp-mux']),
    'a=rtpmap:111 opus/48000/2',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
    `a=ice-ufrag:${ufrag}`,
    'a=ice-pwd:abcdefghijklmnopqrstuvwx',
    ...lines(shape.app ?? fingerprints),
    'a=setup:actpass',
    'a=mid:1',
    'a=sctp-port:5000',
    ...(shape.extra ?? []),
    '',
  ].join('\r\n');
}

/** How long the fake TURN sets below live (the route's sets live 10 minutes; the engine reads `expiresAt`, never this). */
export const ICE_TTL_MS = 10 * 60_000;

export const ICE_ALL: CallIceAnswer = {
  status: 'OK',
  iceServers: [{ urls: ['stun:stun.example.test:3478'] }],
  iceTransportPolicy: 'all',
  expiresAt: T0 + ICE_TTL_MS,
};
export const ICE_RELAY: CallIceAnswer = {
  status: 'OK',
  iceServers: [{ urls: ['turn:turn.example.test:3478?transport=udp'], username: 'u', credential: 'c' }],
  iceTransportPolicy: 'relay',
  expiresAt: T0 + ICE_TTL_MS,
};
export const ICE_RELAY_NONE: CallIceAnswer = { status: 'NOT_CONFIGURED', iceServers: [], iceTransportPolicy: 'relay' };
/** What the route answers while the call is not accepted yet. */
export const ICE_PENDING: CallIceAnswer = { status: 'PENDING', iceServers: [], iceTransportPolicy: 'relay' };

/**
 * The ICE route as the first host's server runs it, on the SERVER's clock —
 * this device's clock plus `skewMs`:
 *   - PENDING with no servers until `accept()` (the server's record says `accepted`);
 *   - then ONE set per call and person, handed out again until its last `CALL_LIMITS.turnRenewWindowMs`, then a
 *     fresh one, each living `ttlMs`; `expiresAt` is the server's clock, `expiresIn` the whole seconds left by it
 *     (`legacy`: a server from before `expiresIn`, which says only `expiresAt`).
 * `minted` lists every set made (its username and expiry); `answers` every answer given, in order.
 */
export function turnServer(
  options: { readonly skewMs?: number; readonly ttlMs?: number; readonly legacy?: boolean } = {},
) {
  const skew = options.skewMs ?? 0;
  const ttl = options.ttlMs ?? ICE_TTL_MS;
  const state = { accepted: false };
  const minted: Array<{ readonly username: string; readonly expiresAt: number }> = [];
  const answers: CallIceAnswer[] = [];
  const serverNow = (): number => Date.now() + skew;
  const answer = async (): Promise<CallIceAnswer> => {
    let out: CallIceAnswer;
    if (!state.accepted) {
      out = ICE_PENDING;
    } else {
      let kept = minted.at(-1);
      if (!kept || kept.expiresAt - serverNow() <= CALL_LIMITS.turnRenewWindowMs) {
        kept = { username: `turn-user-${minted.length + 1}`, expiresAt: serverNow() + ttl };
        minted.push(kept);
      }
      out = {
        status: 'OK',
        iceServers: [{ urls: ['turn:turn.example.test:3478?transport=udp'], username: kept.username, credential: 'c' }],
        iceTransportPolicy: 'relay',
        expiresAt: kept.expiresAt,
        // As the route says it (whole seconds, floored) and the client reads it (milliseconds).
        ...(options.legacy ? {} : { expiresInMs: Math.max(0, Math.floor((kept.expiresAt - serverNow()) / 1_000)) * 1_000 }),
      };
    }
    answers.push(out);
    return out;
  };
  return {
    answer,
    minted,
    answers,
    serverNow,
    accept(): void {
      state.accepted = true;
    },
  };
}

// ── media fakes ─────────────────────────────────────────────────────────────────────────────────

export interface FakeTrack {
  enabled: boolean;
  readonly kind: 'audio';
  stopped: boolean;
  stop(): void;
}
export function fakeTrack(): FakeTrack {
  return {
    enabled: true,
    kind: 'audio',
    stopped: false,
    stop() {
      this.stopped = true;
    },
  };
}
export function fakeStream(track: FakeTrack): MediaStream {
  return { getTracks: () => [track], getAudioTracks: () => [track], id: 'stream' } as unknown as MediaStream;
}

export class FakePeer implements CallPeer {
  readonly added: unknown[] = [];
  /** Whether each added track was on at the moment the peer got it — from then on, it is what the peer sends. */
  readonly addedEnabled: boolean[] = [];
  readonly candidates: Array<CallCandidate | null> = [];
  remoteSdp: string | null = null;
  localSdp: string | null = null;
  closed = false;
  /** The peer's certificates on the audio transport, as `getRemoteCertificates()` gives them; null = cannot tell. */
  certs: readonly ArrayBuffer[] | null = null;
  /** The audio sender's DTLS transport — an identity, compared and never read. */
  dtls: object = { transport: 1 };
  /** The control channel's SCTP runs over that same transport. */
  sctpShared = true;
  remoteTrack: FakeTrack | null = null;
  /** What the engine sent on the control channel. */
  readonly controlSent: string[] = [];
  controlOpen = false;
  /** What the engine asked of the connection's descriptions and servers, in order. */
  readonly log: Array<'createOffer' | 'acceptOffer' | 'setAnswer' | 'setIceServers' | 'restartIce' | 'rollback'> = [];
  /** Every remote SDP set, in order. */
  readonly remoteSdps: string[] = [];
  /** `stable`, or an offer of ours waiting for its answer. */
  signaling: 'stable' | 'have-local-offer' = 'stable';
  /** ICE restarts offered (caller) or answered (callee); restart n gathers under the ufrag `r<n>`. */
  restarts = 0;
  /** Restart offers actually dropped by a rollback. */
  rollbacks = 0;
  /** The local ufrag of the candidate pair in use: which ICE generation carries the audio. */
  path: string | null = UFRAG;
  /** A restart's answer moves the path to the new generation at once (its TURN allocation answers); false = it never does. */
  followsRestart = true;
  /** A browser that cannot say which pair is in use (`pathUfrag()` is null). */
  pathUnknown = false;
  /** Candidates the browser trickles while it sets a restart offer — before the engine has that offer in hand. */
  gatherOnRestart: string[] = [];
  private stableShape: SdpShape;
  constructor(
    readonly config: CallPeerConfig,
    readonly events: CallPeerEvents,
    /** The certificate this side's browser puts in its SDPs (a test may change it under the call). */
    public localFingerprints: string | readonly string[],
    readonly localCandidates: readonly string[] = [],
    public localShape: SdpShape = {},
  ) {
    this.stableShape = localShape;
  }
  private writeLocal(): string {
    this.localSdp = sdpWith(this.localFingerprints, this.localCandidates, this.localShape);
    return this.localSdp;
  }
  /** A new ICE generation: new credentials, a new gathering. */
  private nextGeneration(): void {
    this.restarts += 1;
    this.stableShape = this.localShape;
    this.localShape = { ...this.localShape, ufrag: `r${this.restarts}` };
  }
  addTrack(track: MediaStreamTrack): void {
    this.added.push(track);
    this.addedEnabled.push(track.enabled);
  }
  async createOffer(): Promise<string> {
    this.log.push('createOffer');
    this.signaling = 'have-local-offer';
    return this.writeLocal();
  }
  async acceptOffer(sdp: string): Promise<string> {
    this.log.push('acceptOffer');
    const restart = this.remoteSdp !== null;
    this.remoteSdp = sdp;
    this.remoteSdps.push(sdp);
    if (restart) {
      this.nextGeneration();
      if (this.followsRestart) this.path = this.localShape.ufrag ?? UFRAG;
    }
    return this.writeLocal();
  }
  async setAnswer(sdp: string): Promise<void> {
    this.log.push('setAnswer');
    this.remoteSdp = sdp;
    this.remoteSdps.push(sdp);
    if (this.signaling === 'have-local-offer' && this.restarts > 0 && this.followsRestart) {
      this.path = this.localShape.ufrag ?? UFRAG;
    }
    this.signaling = 'stable';
  }
  async restartIce(): Promise<string> {
    this.log.push('restartIce');
    this.nextGeneration();
    this.signaling = 'have-local-offer';
    const sdp = this.writeLocal();
    for (const candidate of this.gatherOnRestart) this.emitCandidate(candidate);
    return sdp;
  }
  async rollback(): Promise<void> {
    this.log.push('rollback');
    if (this.signaling === 'stable') return;
    this.rollbacks += 1;
    this.localShape = this.stableShape;
    this.writeLocal();
    this.signaling = 'stable';
  }
  pathUfrag(): string | null {
    return this.pathUnknown ? null : this.path;
  }
  /** What the browser says it applied, when a test makes it differ from what the engine set (`undefined` = same). */
  applied: string | null | undefined = undefined;
  appliedRemoteSdp(): string | null {
    return this.applied === undefined ? this.remoteSdp : this.applied;
  }
  async addCandidate(candidate: CallCandidate | null): Promise<void> {
    this.candidates.push(candidate);
  }
  /** Every fresh TURN set the engine handed the browser after the peer was made, in order. */
  readonly iceServerUpdates: Array<readonly CallIceServer[]> = [];
  setIceServers(servers: readonly CallIceServer[]): void {
    this.log.push('setIceServers');
    this.iceServerUpdates.push(servers);
  }
  transport(): CallTransportView {
    return { audio: this.dtls, controlShared: this.sctpShared, certificates: this.certs };
  }
  sendControl(text: string): boolean {
    if (this.closed || !this.controlOpen) return false;
    this.controlSent.push(text);
    return true;
  }
  /** Every track the audio sender was switched to (`replaceAudioTrack`), in order — what it sends from then on. */
  readonly replaced: unknown[] = [];
  /** The next this-many switches throw, as `RTCRtpSender.replaceTrack` does on an error inside the browser. */
  replaceFails = 0;
  async replaceAudioTrack(track: MediaStreamTrack | null): Promise<void> {
    if (this.replaceFails > 0) {
      this.replaceFails -= 1;
      throw Object.assign(new Error('replaceTrack failed'), { name: 'InvalidModificationError' });
    }
    this.replaced.push(track);
  }
  close(): void {
    this.closed = true;
    this.controlOpen = false;
  }
  // drivers
  emitTrack(): FakeTrack {
    const track = fakeTrack();
    this.remoteTrack = track;
    this.events.track(track as unknown as MediaStreamTrack, fakeStream(track));
    return track;
  }
  emitCandidate(candidate: string | null): void {
    this.events.candidate(candidate === null ? null : { candidate, sdpMid: '0', sdpMLineIndex: 0 });
  }
  connect(): void {
    this.events.state('connected');
  }
  setState(state: Parameters<CallPeerEvents['state']>[0]): void {
    this.events.state(state);
  }
  /** The control channel opened (SCTP up on both sides). */
  openControl(): void {
    this.controlOpen = true;
    this.events.control({ kind: 'open' });
  }
  /** A message from the other side on the control channel. */
  controlFromPeer(data: unknown): void {
    this.events.control({ kind: 'message', data });
  }
  /** The other side (or the network) closed the control channel. */
  peerClosesControl(): void {
    this.controlOpen = false;
    this.events.control({ kind: 'close' });
  }
  /** Times the ENGINE closed the control channel (the port method). */
  controlClosedHere = 0;
  closeControl(): void {
    this.controlClosedHere += 1;
    if (!this.controlOpen) return;
    this.controlOpen = false;
    this.events.control({ kind: 'close' }); // as a browser fires `close` after `channel.close()`
  }
  /** DTLS is up and the peer presented `der` on the audio transport. */
  presentCertificate(der: ArrayBuffer): void {
    this.certs = [der];
    this.connect();
  }
  /** A renegotiation or a rebuilt connection put the audio on ANOTHER DTLS transport. */
  changeTransport(): void {
    this.dtls = { transport: 2 };
    this.events.transport?.();
  }
  /** The browser moved the audio to another candidate pair (a network change, a restart): the same DTLS transport. */
  switchPath(): void {
    this.events.transport?.();
    this.events.state('disconnected');
    this.events.state('connected');
  }
}

// ── the room's key, per epoch, per device ───────────────────────────────────────────────────────

/**
 * A 1:1 room where each device holds its own epoch; `fresh` catches a device up to `latest`. A device not named in
 * `epochs` (an `extra` member) holds `latest`: it has the room's real `K`, so a tag it computes is a correct one.
 */
export function fakeRoom(init: { epochs?: Record<string, number>; latest?: number; extra?: RoomMember[] } = {}) {
  const epochs: Record<string, number> = { [DEV_A]: 1, [DEV_B]: 1, ...init.epochs };
  const state = { latest: init.latest ?? Math.max(...Object.values(epochs)) };
  const members: RoomMember[] = [
    { userId: ALICE, deviceId: DEV_A, role: 'USER' },
    { userId: BOB, deviceId: DEV_B, role: 'USER' },
    ...(init.extra ?? []),
  ];
  const keyring = (userId: string, deviceId: string): CallKeyring => ({
    selfUserId: userId,
    selfDeviceId: deviceId,
    key: async (_callId, fresh) => {
      if (fresh) epochs[deviceId] = state.latest;
      const epoch = (epochs[deviceId] ??= state.latest);
      return { key: new Uint8Array(32).fill(epoch), epoch, members };
    },
  });
  const port = (userId: string, deviceId: string): CallBindingPort & {
    tag: ReturnType<typeof vi.fn>;
    verify: ReturnType<typeof vi.fn>;
  } => {
    const ring = keyring(userId, deviceId);
    const tag = vi.fn((request: Parameters<CallBindingPort['callTag']>[0]) => callTag(ring, request));
    const verify = vi.fn((request: Parameters<CallBindingPort['callVerify']>[0]) => callVerify(ring, request));
    return { callTag: tag, callVerify: verify, tag, verify };
  };
  return { epochs, state, members, keyring, port };
}

/** The tag the OTHER side would send, computed the way the worker does. */
export async function peerTag(
  room: ReturnType<typeof fakeRoom>,
  as: 'caller' | 'callee',
  binding: Partial<CallBindingInput> = {},
): Promise<string> {
  // The tag is computed by the device it names for its role (another device of the same person, if overridden).
  const device = as === 'caller' ? (binding.callerDeviceId ?? DEV_A) : (binding.calleeDeviceId ?? DEV_B);
  const user = as === 'caller' ? ALICE : BOB;
  const answer = await callTag(room.keyring(user, device), {
    conversationId: CONV,
    callId: CALL,
    callerDeviceId: DEV_A,
    calleeDeviceId: DEV_B,
    fingerprintCaller: FP_A,
    fingerprintCallee: FP_B,
    ...binding,
    role: as,
  });
  return answer.tag;
}

// ── one engine, every port faked ────────────────────────────────────────────────────────────────

export function fakeSocket() {
  const sent: CallClientEvent[] = [];
  /** `onSend`: the other side, played by a test, hears each frame the moment it is sent. */
  const state: { open: boolean; onSend: ((event: CallClientEvent) => void) | null } = { open: true, onSend: null };
  let onFrame: ((raw: unknown) => void) | null = null;
  const closeListeners = new Set<(code: number) => void>();
  return {
    sent,
    state,
    port: {
      send(event: CallClientEvent) {
        if (!state.open) return false;
        sent.push(event);
        state.onSend?.(event);
        return true;
      },
      isOpen: () => state.open,
      subscribe(fn: (raw: unknown) => void) {
        onFrame = fn;
        return () => {
          onFrame = null;
        };
      },
      onClosed(fn: (code: number) => void) {
        closeListeners.add(fn);
        return () => {
          closeListeners.delete(fn);
        };
      },
    },
    /** A frame from the server. */
    server(type: string, payload: unknown): void {
      onFrame?.({ type, payload });
    },
    close(code = 1006): void {
      state.open = false;
      for (const listener of [...closeListeners]) listener(code);
    },
    of<T extends CallClientEvent['type']>(type: T): Array<Extract<CallClientEvent, { type: T }>> {
      return sent.filter((e): e is Extract<CallClientEvent, { type: T }> => e.type === type);
    },
    get subscribed() {
      return onFrame !== null;
    },
  };
}

export interface SetupOptions {
  readonly self?: 'caller' | 'callee';
  readonly ice?: CallIceAnswer | (() => Promise<CallIceAnswer>);
  readonly localFingerprints?: string | readonly string[];
  readonly localCandidates?: readonly string[];
  /** How this side's browser lays out its own SDP (default: browser-shaped, bundled). */
  readonly localShape?: SdpShape;
  readonly room?: ReturnType<typeof fakeRoom>;
  readonly microphone?: () => Promise<MediaStream>;
  readonly speakerPlays?: boolean;
  readonly noBinding?: boolean;
  /** The machine an earlier engine left (the first host's is a module singleton shared by every engine of the tab). */
  readonly machine?: ReturnType<typeof createAudioCallMachine>;
}

export function setup(options: SetupOptions = {}) {
  const self = options.self ?? 'caller';
  const room = options.room ?? fakeRoom();
  const socket = fakeSocket();
  const machine = options.machine ?? createAudioCallMachine();
  const peers: FakePeer[] = [];
  const micTrack = fakeTrack();
  const binding = self === 'caller' ? room.port(ALICE, DEV_A) : room.port(BOB, DEV_B);
  const ice = vi.fn(async (_callId: string) => {
    const answer = options.ice ?? ICE_ALL;
    return typeof answer === 'function' ? answer() : answer;
  });
  const microphone = vi.fn(options.microphone ?? (async () => fakeStream(micTrack)));
  const speaker = {
    attach: vi.fn(async (_stream: MediaStream) => options.speakerPlays ?? true),
    resume: vi.fn(async () => true),
    detach: vi.fn(),
    dispose: vi.fn(),
  } satisfies CallSpeaker;
  let requests = 0;
  const engine = createAudioCallEngine({
    socket: socket.port,
    iceServers: ice,
    binding: options.noBinding ? null : binding,
    microphone,
    createPeer: (config, events) => {
      const peer = new FakePeer(
        config,
        events,
        options.localFingerprints ?? (self === 'caller' ? FP_A : FP_B),
        options.localCandidates ?? [],
        options.localShape ?? {},
      );
      peers.push(peer);
      return peer;
    },
    speaker,
    localDeviceId: () => (self === 'caller' ? DEV_A : DEV_B),
    newRequestId: () => `request-${(requests += 1)}`,
    machine,
  });
  return {
    engine,
    socket,
    machine,
    peers,
    peer: () => {
      const peer = peers.at(-1);
      if (!peer) throw new Error('no peer yet');
      return peer;
    },
    micTrack,
    microphone,
    speaker,
    ice,
    binding,
    room,
    state: () => machine.getState(),
    snap: () => engine.getSnapshot(),
  };
}

/**
 * WebCrypto work still running. Its promises complete on the thread pool, off the microtask queue, so no number of
 * event-loop turns says they are done: on a loaded runner a hash took longer than `settle()` waited, and a
 * different test of this suite went red on each full run (2026-11-15). So every `crypto.subtle` call is counted
 * here, and `settle()` waits for the count to reach zero.
 */
let cryptoPending = 0;
{
  const subtle = globalThis.crypto.subtle as unknown as Record<string, unknown>;
  const proto = Object.getPrototypeOf(subtle) as Record<string, unknown>;
  for (const name of Object.getOwnPropertyNames(proto)) {
    const original = proto[name];
    if (name === 'constructor' || typeof original !== 'function') continue;
    Object.defineProperty(subtle, name, {
      configurable: true,
      writable: true,
      value(this: unknown, ...args: unknown[]): unknown {
        const result = (original as (...a: unknown[]) => unknown).apply(subtle, args);
        if (result instanceof Promise) {
          cryptoPending += 1;
          const done = (): void => {
            cryptoPending -= 1;
          };
          result.then(done, done);
        }
        return result;
      },
    });
  }
}

/** The longest `settle()` waits for WebCrypto before it gives up and lets the test's own assertion speak. */
const SETTLE_CRYPTO_MAX_MS = 10_000;

/**
 * Let promises run: at least `rounds` turns of the event loop AND a few real milliseconds, and — because one
 * WebCrypto result usually starts the next step — until `rounds` turns in a row saw no WebCrypto work running.
 */
export async function settle(rounds = 40, minMs = 4): Promise<void> {
  const start = performance.now();
  let quiet = 0;
  for (;;) {
    const elapsed = performance.now() - start;
    if (quiet >= rounds && elapsed >= minMs) return;
    if (elapsed > SETTLE_CRYPTO_MAX_MS) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
    quiet = cryptoPending === 0 ? quiet + 1 : 0;
  }
}

/** Advance the fake clock by `ms` and let what it woke finish. */
export async function advance(ms: number): Promise<void> {
  vi.advanceTimersByTime(ms);
  await settle();
}

/**
 * Advance by `ms` in steps of at most `step` — no longer than the shortest wait in play — so a chain of waits (ask,
 * wait, ask again) runs link by link: one jump fires only the timers that exist when it starts.
 */
export async function advanceInSteps(ms: number, step: number): Promise<void> {
  for (let left = ms; left > 0; left -= step) await advance(Math.min(step, left));
}

type Harness = ReturnType<typeof setup>;

/** What the server says in its `call:accept`: which call, and which device of the callee answered. */
export interface AcceptAs {
  readonly callId?: string;
  readonly calleeDeviceId?: string;
}

/** Caller: «Call» → ack → accept → offer out. */
export async function callerToOffer(h: Harness, ack: AcceptAs = {}): Promise<void> {
  const result = await h.engine.call(CONV);
  if (!result.ok) throw new Error(`call refused: ${result.reason}`);
  const invite = h.socket.of('call:invite').at(-1)!;
  h.socket.server('call:invite', { requestId: invite.payload.requestId, callId: ack.callId ?? CALL, ringUntil: RING_UNTIL });
  await settle();
  h.socket.server('call:accept', {
    callId: ack.callId ?? CALL,
    callerDeviceId: DEV_A,
    calleeDeviceId: ack.calleeDeviceId ?? DEV_B,
  });
  await settle();
}

/** Caller: … → the callee's answer applied, our tag out. */
export async function callerToTags(h: Harness, answerSdp = sdpWith(FP_B), ack: AcceptAs = {}): Promise<void> {
  await callerToOffer(h, ack);
  h.socket.server('call:ice', { callId: CALL, signal: { kind: 'answer', sdp: answerSdp } });
  await settle();
}

/** Callee: ring → «Answer» → accepted → the caller's offer applied, our answer and tag out. */
export async function calleeToTags(
  h: Harness,
  offerSdp = sdpWith(FP_A),
  ringAs: { readonly callerUserId?: string } = {},
): Promise<void> {
  h.socket.server('call:ring', {
    callId: CALL,
    conversationId: CONV,
    callerUserId: ringAs.callerUserId ?? ALICE,
    callerDeviceId: DEV_A,
    ringUntil: RING_UNTIL,
  });
  const result = await h.engine.answer();
  if (!result.ok) throw new Error(`answer refused: ${result.reason}`);
  h.socket.server('call:accept', { callId: CALL, callerDeviceId: DEV_A, calleeDeviceId: DEV_B });
  await settle();
  h.socket.server('call:ice', { callId: CALL, signal: { kind: 'offer', sdp: offerSdp } });
  await settle();
}
