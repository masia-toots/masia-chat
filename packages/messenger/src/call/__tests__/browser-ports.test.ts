// @vitest-environment jsdom
/**
 * The browser's peer connection as the call engine gets it (`createBrowserPeer`, ADR-211 + ADR-215 decision 4):
 * one bundled transport (`max-bundle`, RTCP muxed), the control channel created at once — before any offer — and a
 * view of the transports for the binding checks: the audio sender's DTLS transport, whether the control channel's
 * SCTP runs over that very object, and the certificates the peer presented on it. A stand-in `RTCPeerConnection`
 * records what the adapter asks of it; nothing else is faked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBrowserPeer } from '../browser-ports.js';
import { CALL_CONTROL_CHANNEL, type CallPeerEvents } from '../call-engine.js';

type SelectedPair = { local?: { usernameFragment?: string | null } } | null;
type Dtls = {
  getRemoteCertificates?: () => ArrayBuffer[];
  iceTransport?: { getSelectedCandidatePair?: () => SelectedPair };
};

class StandInPeerConnection {
  static last: StandInPeerConnection | null = null;
  readonly steps: string[] = [];
  readonly channels: Array<{
    label: string;
    init: RTCDataChannelInit;
    binaryType: string;
    close: ReturnType<typeof vi.fn>;
  }> = [];
  sctp: { transport: Dtls } | null = null;
  audioTransport: Dtls | null = null;
  localDescription: { type?: string; sdp: string } | null = null;
  remoteDescription: { sdp: string } | null = null;
  signalingState = 'stable';
  /** What each `createOffer` was asked. */
  readonly offerOptions: Array<RTCOfferOptions | undefined> = [];
  onsignalingstatechange: (() => void) | null = null;
  /** What `setConfiguration` throws, as a closed connection does (`InvalidStateError`); null = it applies. */
  refuseConfiguration: Error | null = null;
  constructor(public config: RTCConfiguration) {
    StandInPeerConnection.last = this;
    this.steps.push('construct');
  }
  getConfiguration(): RTCConfiguration {
    return { ...this.config };
  }
  setConfiguration(config: RTCConfiguration) {
    this.steps.push('setConfiguration');
    if (this.refuseConfiguration) throw this.refuseConfiguration;
    this.config = config;
  }
  createDataChannel(label: string, init: RTCDataChannelInit) {
    this.steps.push('createDataChannel');
    const channel = { label, init, binaryType: 'blob', readyState: 'connecting', send: vi.fn(), close: vi.fn() };
    this.channels.push(channel);
    return channel;
  }
  /** The audio sender's `replaceTrack`; `transceivers: 'none'` = a connection with no audio transceiver yet. */
  readonly replaceTrack = vi.fn(async (_track: unknown) => {});
  transceivers: 'audio' | 'none' = 'audio';
  getTransceivers() {
    if (this.transceivers === 'none') return [];
    return [{ receiver: { track: { kind: 'audio' } }, sender: { transport: this.audioTransport, replaceTrack: this.replaceTrack } }];
  }
  async createOffer(options?: RTCOfferOptions) {
    this.steps.push('createOffer');
    this.offerOptions.push(options);
    return { type: 'offer', sdp: options?.iceRestart ? 'v=0\r\na=ice-ufrag:next\r\n' : 'v=0\r\n' };
  }
  async setLocalDescription(description: { type?: string; sdp?: string }) {
    if (description.type === 'rollback') {
      this.steps.push('rollback');
      this.signalingState = 'stable';
      return;
    }
    this.steps.push('setLocalDescription');
    this.localDescription = { type: description.type, sdp: description.sdp ?? '' };
    if (description.type === 'offer') this.signalingState = 'have-local-offer';
  }
  close() {
    this.steps.push('close');
  }
}

const events = (): CallPeerEvents & { transport: ReturnType<typeof vi.fn> } => ({
  candidate: vi.fn(),
  track: vi.fn(),
  state: vi.fn(),
  control: vi.fn(),
  transport: vi.fn(),
});

const pc = (): StandInPeerConnection => {
  if (!StandInPeerConnection.last) throw new Error('no peer connection made');
  return StandInPeerConnection.last;
};

beforeEach(() => {
  StandInPeerConnection.last = null;
  vi.stubGlobal('RTCPeerConnection', StandInPeerConnection);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const CONFIG = { iceServers: [], iceTransportPolicy: 'relay', control: CALL_CONTROL_CHANNEL } as const;

describe('createBrowserPeer', () => {
  it('one bundled transport (max-bundle, RTCP muxed), the ICE policy as given', () => {
    createBrowserPeer(CONFIG, events());
    expect(pc().config).toMatchObject({ bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require', iceTransportPolicy: 'relay' });
  });

  it('the control channel exists before any offer: negotiated, the fixed id, ordered, reliable', async () => {
    const peer = createBrowserPeer(CONFIG, events());
    await peer.createOffer();
    expect(pc().steps.slice(0, 3)).toEqual(['construct', 'createDataChannel', 'createOffer']);
    expect(pc().channels).toHaveLength(1);
    expect(pc().channels[0]!.label).toBe('masia-call-ctl');
    expect(pc().channels[0]!.init).toEqual({ negotiated: true, id: 0, ordered: true });
  });

  it('transport(): the audio sender\'s DTLS transport; shared only when the SCTP transport IS that object', () => {
    const der = new Uint8Array([48, 1]).buffer;
    const audio: Dtls = { getRemoteCertificates: () => [der] };
    const peer = createBrowserPeer(CONFIG, events());
    pc().audioTransport = audio;
    pc().sctp = { transport: audio };
    expect(peer.transport()).toEqual({ audio, controlShared: true, certificates: [der] });
    // a look-alike is not the same transport
    pc().sctp = { transport: { getRemoteCertificates: () => [der] } };
    expect(peer.transport().controlShared).toBe(false);
    pc().sctp = null;
    expect(peer.transport().controlShared).toBe(false);
  });

  it('transport(): a browser that cannot name the certificate says null; no audio transport, nothing shared', () => {
    const peer = createBrowserPeer(CONFIG, events());
    const bare: Dtls = {};
    pc().audioTransport = bare;
    pc().sctp = { transport: bare };
    expect(peer.transport()).toEqual({ audio: bare, controlShared: true, certificates: null });
    pc().audioTransport = {
      getRemoteCertificates: () => {
        throw new Error('not supported');
      },
    };
    expect(peer.transport().certificates).toBeNull();
    pc().audioTransport = null;
    expect(peer.transport()).toEqual({ audio: null, controlShared: false, certificates: null });
  });

  it('appliedRemoteSdp(): the remote description as the browser holds it, null before there is one', () => {
    const peer = createBrowserPeer(CONFIG, events());
    expect(peer.appliedRemoteSdp()).toBeNull();
    pc().remoteDescription = { sdp: 'v=0\r\nas the browser wrote it\r\n' };
    expect(peer.appliedRemoteSdp()).toBe('v=0\r\nas the browser wrote it\r\n');
  });

  it('closeControl() closes the control channel only; the connection (the audio) stays', () => {
    const peer = createBrowserPeer(CONFIG, events());
    peer.closeControl();
    expect(pc().channels[0]!.close).toHaveBeenCalledTimes(1);
    expect(pc().steps).not.toContain('close');
  });

  it('setIceServers(): a renewed TURN set replaces the servers only — the policy and the bundle stay as made', () => {
    const turn = (username: string) => ({ urls: ['turn:turn.example.test:3478?transport=udp'], username, credential: 'c' });
    const peer = createBrowserPeer({ ...CONFIG, iceServers: [turn('first')] }, events());
    expect(pc().config.iceServers).toEqual([turn('first')]);
    peer.setIceServers([turn('second')]);
    expect(pc().config).toMatchObject({
      iceServers: [turn('second')],
      iceTransportPolicy: 'relay',
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
    });
  });

  it('setIceServers(): a connection that refuses it (closed) leaves the call as it is — nothing thrown', () => {
    const peer = createBrowserPeer(CONFIG, events());
    pc().refuseConfiguration = Object.assign(new Error('closed'), { name: 'InvalidStateError' });
    expect(() => peer.setIceServers([{ urls: ['turn:turn.example.test:3478'] }])).not.toThrow();
    expect(pc().steps).toContain('setConfiguration');
  });

  it('restartIce(): an offer that restarts ICE, set locally — the new description is what it returns', async () => {
    const peer = createBrowserPeer(CONFIG, events());
    await peer.createOffer();
    pc().signalingState = 'stable'; // the first answer came
    expect(await peer.restartIce()).toBe('v=0\r\na=ice-ufrag:next\r\n');
    expect(pc().offerOptions).toEqual([undefined, { iceRestart: true }]);
    expect(pc().localDescription).toEqual({ type: 'offer', sdp: 'v=0\r\na=ice-ufrag:next\r\n' });
  });

  it('rollback(): drops an offer still waiting for its answer, and nothing else', async () => {
    const peer = createBrowserPeer(CONFIG, events());
    await peer.rollback(); // stable: there is no offer to drop
    expect(pc().steps).not.toContain('rollback');
    await peer.restartIce();
    expect(pc().signalingState).toBe('have-local-offer');
    await peer.rollback();
    expect(pc().steps.at(-1)).toBe('rollback');
    expect(pc().signalingState).toBe('stable');
  });

  it('pathUfrag(): the local ICE ufrag of the candidate pair the audio\'s transport uses now', () => {
    const peer = createBrowserPeer(CONFIG, events());
    let pair: SelectedPair = { local: { usernameFragment: 'next' } };
    pc().audioTransport = { iceTransport: { getSelectedCandidatePair: () => pair } };
    expect(peer.pathUfrag()).toBe('next');
    pair = null; // no pair selected right now
    expect(peer.pathUfrag()).toBeNull();
    pair = { local: { usernameFragment: null } };
    expect(peer.pathUfrag()).toBeNull();
  });

  it('pathUfrag(): a browser that cannot tell says null — never a guess, never a throw', () => {
    const peer = createBrowserPeer(CONFIG, events());
    expect(peer.pathUfrag()).toBeNull(); // no transport yet
    pc().audioTransport = {};
    expect(peer.pathUfrag()).toBeNull(); // no `iceTransport`
    pc().audioTransport = { iceTransport: {} };
    expect(peer.pathUfrag()).toBeNull(); // no `getSelectedCandidatePair`
    pc().audioTransport = {
      iceTransport: {
        getSelectedCandidatePair: () => {
          throw new Error('not supported');
        },
      },
    };
    expect(peer.pathUfrag()).toBeNull();
  });

  it('replaceAudioTrack(): the audio sender switches track in place (ADR-215 decision 11); a failure reaches the engine', async () => {
    const peer = createBrowserPeer(CONFIG, events());
    const graph = { kind: 'audio', id: 'graph' } as unknown as MediaStreamTrack;
    await peer.replaceAudioTrack(graph);
    expect(pc().replaceTrack).toHaveBeenCalledWith(graph);
    expect(pc().steps).not.toContain('createOffer'); // no renegotiation
    pc().replaceTrack.mockRejectedValueOnce(Object.assign(new Error('bad track'), { name: 'InvalidModificationError' }));
    await expect(peer.replaceAudioTrack(graph)).rejects.toThrow('bad track');
    pc().transceivers = 'none';
    await expect(peer.replaceAudioTrack(graph)).rejects.toThrow();
  });

  it('a change of descriptions is reported, so the engine looks at the transports again', () => {
    const e = events();
    createBrowserPeer(CONFIG, e);
    pc().onsignalingstatechange?.();
    expect(e.transport).toHaveBeenCalledTimes(1);
  });
});
