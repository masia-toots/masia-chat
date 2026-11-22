/**
 * The call engine's ports in a real browser, the generic half (ADR-211, step Д2a): `RTCPeerConnection`, the
 * microphone and the `call:invite` request id. Thin on purpose — every decision is in `call-engine.ts`, where it is
 * tested; this file only translates. The host adds what is its own: the speaker on its audio output, the socket the
 * call frames ride, the ICE route.
 */
import type { CallIceServer, CallPeer, CallPeerConfig, CallPeerEvents } from './call-engine.js';

// ── the peer connection ─────────────────────────────────────────────────────────────────────────

/** `getRemoteCertificates()` and the ICE transport under it, where the browser has them (not every engine does). */
type DtlsTransportLike = {
  getRemoteCertificates?: () => ArrayBuffer[];
  iceTransport?: { getSelectedCandidatePair?: () => { local?: { usernameFragment?: string | null } } | null };
};

/** The local ufrag of the pair the ICE transport under `transport` uses now; null when none or unknown. */
function selectedUfrag(transport: DtlsTransportLike | null): string | null {
  const ice = transport?.iceTransport;
  if (typeof ice?.getSelectedCandidatePair !== 'function') return null;
  try {
    return ice.getSelectedCandidatePair()?.local?.usernameFragment ?? null;
  } catch {
    return null;
  }
}

function certificatesOf(transport: DtlsTransportLike): readonly ArrayBuffer[] | null {
  if (typeof transport.getRemoteCertificates !== 'function') return null;
  try {
    return transport.getRemoteCertificates();
  } catch {
    return null;
  }
}

const rtcIceServers = (servers: readonly CallIceServer[]): RTCIceServer[] =>
  servers.map((s) => ({
    urls: [...s.urls],
    ...(s.username !== undefined ? { username: s.username } : {}),
    ...(s.credential !== undefined ? { credential: s.credential } : {}),
  }));

/**
 * One `RTCPeerConnection`: one bundled transport for everything (`max-bundle`, RTCP muxed — ADR-215 decision 4),
 * and its control channel created at once — before any offer — pre-negotiated with the fixed id, ordered and
 * reliable (`CALL_CONTROL_CHANNEL`).
 */
export function createBrowserPeer(config: CallPeerConfig, events: CallPeerEvents): CallPeer {
  const pc = new RTCPeerConnection({
    iceServers: rtcIceServers(config.iceServers),
    iceTransportPolicy: config.iceTransportPolicy,
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require',
  });
  const channel = pc.createDataChannel(config.control.label, { negotiated: true, id: config.control.id, ordered: true });
  channel.binaryType = 'arraybuffer';
  channel.onopen = () => events.control({ kind: 'open' });
  channel.onclose = () => events.control({ kind: 'close' });
  channel.onmessage = (event: MessageEvent) => events.control({ kind: 'message', data: event.data as unknown });

  pc.onicecandidate = (event) => {
    const c = event.candidate;
    events.candidate(c ? { candidate: c.candidate, sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex } : null);
  };
  pc.ontrack = (event) => {
    // The engine holds the track (disabled, attached to nothing) until the call is verified.
    events.track(event.track, event.streams[0] ?? new MediaStream([event.track]));
  };
  pc.onconnectionstatechange = () => events.state(pc.connectionState);
  // A new description is the only way a transport can be replaced; the engine looks again.
  pc.onsignalingstatechange = () => events.transport();

  const localSdp = (): string => {
    const sdp = pc.localDescription?.sdp;
    if (!sdp) throw new Error('call: no local description');
    return sdp;
  };
  /** The audio transceiver's sender — found by its receiver, whatever track the sender carries now. */
  const audioSender = (): RTCRtpSender | null =>
    pc.getTransceivers().find((t) => t.receiver.track?.kind === 'audio')?.sender ?? null;
  /** The audio sender's DTLS transport (one for everything: max-bundle); null when the browser does not expose it. */
  const audioTransport = (): (DtlsTransportLike & object) | null =>
    (audioSender()?.transport ?? null) as (DtlsTransportLike & object) | null;

  return {
    addTrack(track, stream) {
      pc.addTrack(track, stream);
    },
    async createOffer() {
      await pc.setLocalDescription(await pc.createOffer());
      return localSdp();
    },
    async acceptOffer(sdp) {
      await pc.setRemoteDescription({ type: 'offer', sdp });
      await pc.setLocalDescription(await pc.createAnswer());
      return localSdp();
    },
    async setAnswer(sdp) {
      await pc.setRemoteDescription({ type: 'answer', sdp });
    },
    appliedRemoteSdp() {
      return pc.remoteDescription?.sdp ?? null;
    },
    async addCandidate(candidate) {
      // null = the peer's end of candidates.
      await pc.addIceCandidate(candidate ?? undefined);
    },
    setIceServers(servers) {
      // Everything else as the connection was made: a configuration may change only its ICE servers.
      try {
        pc.setConfiguration({ ...pc.getConfiguration(), iceServers: rtcIceServers(servers) });
      } catch {
        /* closed, or refused: the connection goes on with the set it has */
      }
    },
    async restartIce() {
      await pc.setLocalDescription(await pc.createOffer({ iceRestart: true }));
      return localSdp();
    },
    async rollback() {
      if (pc.signalingState === 'stable') return;
      await pc.setLocalDescription({ type: 'rollback' });
    },
    pathUfrag() {
      return selectedUfrag(audioTransport());
    },
    transport() {
      const audio = audioTransport();
      const sctp = pc.sctp?.transport ?? null;
      return {
        audio,
        controlShared: audio !== null && sctp === audio,
        certificates: audio ? certificatesOf(audio) : null,
      };
    },
    sendControl(text) {
      if (channel.readyState !== 'open') return false;
      try {
        channel.send(text);
        return true;
      } catch {
        return false;
      }
    },
    async replaceAudioTrack(track) {
      const sender = audioSender();
      if (!sender) throw new Error('call: no audio sender');
      await sender.replaceTrack(track);
    },
    closeControl() {
      try {
        channel.close();
      } catch {
        /* already closed */
      }
    },
    close() {
      try {
        channel.close();
      } catch {
        /* already closed */
      }
      pc.close();
    },
  };
}

// ── the microphone ──────────────────────────────────────────────────────────────────────────────

/** The microphone, with the browser's voice processing on. Rejects with the browser's own error (its `name`). */
export async function browserMicrophone(): Promise<MediaStream> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    throw Object.assign(new Error('no microphone API'), { name: 'NotFoundError' });
  }
  return navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: false,
  });
}

// ── the rest ────────────────────────────────────────────────────────────────────────────────────

/** A `call:invite` request id: 16 random bytes, base64url (`CALL_REQUEST_ID_PATTERN`). */
export function newCallRequestId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
