/**
 * What the call engine reads out of an SDP, and what it strips from one (ADR-211 decisions 4 and 6). Pure: no
 * browser state, no I/O beyond `crypto.subtle` for the certificate hash.
 *
 * ## The fingerprint the tag binds — exactly one
 *
 * The verification tag (`@masia/contracts/wire`) binds ONE DTLS fingerprint per side. An SDP may carry
 * several `a=fingerprint` lines — at session level and at media level, one per m-section, or the same certificate
 * under two hash functions. If the engine bound one value and the browser enforced another, a signalling path could
 * hand each side a certificate of its own in the line the engine does not read and sit in the middle undetected.
 * So an SDP — ours or the peer's — is accepted only when ALL its fingerprint lines canonicalise to ONE value, with a
 * hash function of at least SHA-256 and the length that function gives; that value is what the tag binds and what
 * the browser enforces. The same value repeated (session + media level, or one per bundled m-section, as browsers
 * write it) is still one value.
 *
 * ## One transport for the audio and the control channel (ADR-215 decision 4)
 *
 * Every call runs the audio and its control data channel over ONE DTLS transport (`bundlePolicy: 'max-bundle'`),
 * so the fingerprint the tag binds is the one that protects both. An SDP rewritten to unbundle — no BUNDLE group, an
 * m-line left outside it (a rejected one included), an m-line without a mid, or a second group (a second transport)
 * — could put the data channel on a transport whose certificate nobody tagged. Such an SDP has no bound fingerprint:
 * `boundFingerprint` is null and the call fails verification.
 *
 * ## Relay-only calls — the client filters, it does not trust the server to
 *
 * Outside "same family" (decision 6) a call is TURN-only so neither side learns the other's address. Besides
 * `iceTransportPolicy: 'relay'` on the peer connection, the engine itself drops every candidate that is not
 * `typ relay` — the ones it sends and the ones it receives, trickled or embedded in an SDP — and blanks the related
 * address of each relay candidate (`raddr`/`rport`: this device's public address as the TURN server saw it, which
 * the peer does not need to connect). An honest client must not depend on the server's filter.
 */
import { normalizeDtlsFingerprint } from '@masia/contracts/wire';

/** A WebCrypto digest name the fingerprint check can run. */
export type FingerprintHash = 'SHA-256' | 'SHA-384' | 'SHA-512';

/** The hash functions accepted in an SDP fingerprint, with the length each gives. SHA-1 and MD5 are refused. */
const HASHES: Readonly<Record<string, { readonly name: FingerprintHash; readonly bytes: number }>> = {
  'sha-256': { name: 'SHA-256', bytes: 32 },
  'sha-384': { name: 'SHA-384', bytes: 48 },
  'sha-512': { name: 'SHA-512', bytes: 64 },
};

const FINGERPRINT_LINE = /^a=fingerprint:/i;
const CANDIDATE_LINE = 'a=candidate:';
const BLANK_ADDRESS = '0.0.0.0';
const BLANK_PORT = '0';

/** The WebCrypto name of a canonical fingerprint's hash function; null when it is not one we accept. */
export function fingerprintHash(canonical: string): FingerprintHash | null {
  const [hash, hex] = canonical.split(' ');
  const spec = hash === undefined ? undefined : HASHES[hash];
  if (!spec || hex === undefined || hex.split(':').length !== spec.bytes) return null;
  return spec.name;
}

/**
 * The ONE canonical DTLS fingerprint of an SDP (`sha-256 AB:CD:…`), or null when it has none, more than one
 * distinct value, an ill-formed line, or a hash function weaker than SHA-256.
 */
export function sdpFingerprint(sdp: string): string | null {
  let found: string | null = null;
  for (const line of sdp.split(/\r?\n/)) {
    if (!FINGERPRINT_LINE.test(line)) continue;
    const canonical = normalizeDtlsFingerprint(line);
    if (canonical === null || fingerprintHash(canonical) === null) return null;
    if (found !== null && found !== canonical) return null;
    found = canonical;
  }
  return found;
}

const BUNDLE_GROUP = 'a=group:BUNDLE';

/**
 * Does the whole SDP run over one transport? Exactly one `a=group:BUNDLE` line, at session level, naming each
 * m-section's mid exactly once — and every m-section has exactly one mid, listed there. A BUNDLE group is all the
 * negotiation can say about sharing a transport; anything looser is refused.
 */
export function sdpBundled(sdp: string): boolean {
  const lines = sdp.split(/\r?\n/);
  const firstMedia = lines.findIndex((line) => line.startsWith('m='));
  if (firstMedia < 0) return false;
  const groups = lines.filter((line) => line === BUNDLE_GROUP || line.startsWith(`${BUNDLE_GROUP} `));
  if (groups.length !== 1) return false;
  const groupLine = groups[0]!;
  if (lines.indexOf(groupLine) > firstMedia) return false; // a group is a session-level attribute
  const grouped = groupLine.slice(BUNDLE_GROUP.length).trim().split(/\s+/).filter(Boolean);
  if (grouped.length === 0 || new Set(grouped).size !== grouped.length) return false;

  const mids: string[] = [];
  let sectionMids = -1; // -1 = still at session level
  for (const line of lines) {
    if (line.startsWith('m=')) {
      if (sectionMids === 0) return false; // the previous m-section had no mid
      sectionMids = 0;
    } else if (sectionMids >= 0 && line.startsWith('a=mid:')) {
      sectionMids += 1;
      if (sectionMids > 1) return false;
      mids.push(line.slice('a=mid:'.length).trim());
    }
  }
  if (sectionMids === 0) return false; // the last m-section had no mid
  return (
    mids.length === grouped.length && new Set(mids).size === mids.length && mids.every((mid) => grouped.includes(mid))
  );
}

/**
 * The fingerprint the call binds (ADR-211 decision 4 + ADR-215 decision 4): the SDP's one fingerprint
 * (`sdpFingerprint`), and only when every m-section runs over the one bundled transport (`sdpBundled`); else null.
 */
export function boundFingerprint(sdp: string): string | null {
  return sdpBundled(sdp) ? sdpFingerprint(sdp) : null;
}

/**
 * The SDP's m-lines as an ICE restart must leave them (ADR-211 amendment of 2026-11-15): each m-section's media, its
 * one mid, and whether it muxes RTCP (`a=rtcp-mux`), in order — `audio:0+mux application:1`. A restart changes the
 * ICE credentials and the candidates and nothing here; an m-line added or dropped, a mid renamed or RTCP unmuxed is
 * another layout. Null when there is no m-section, or one has no mid or more than one.
 */
export function sdpLayout(sdp: string): string | null {
  const sections: Array<{ media: string; mids: string[]; mux: boolean }> = [];
  for (const line of sdp.split(/\r?\n/)) {
    if (line.startsWith('m=')) {
      sections.push({ media: line.slice(2).split(' ')[0] ?? '', mids: [], mux: false });
      continue;
    }
    const section = sections.at(-1);
    if (!section) continue;
    if (line.startsWith('a=mid:')) section.mids.push(line.slice('a=mid:'.length).trim());
    else if (line.trimEnd() === 'a=rtcp-mux') section.mux = true;
  }
  if (sections.length === 0 || sections.some((s) => s.mids.length !== 1)) return null;
  return sections.map((s) => `${s.media}:${s.mids[0]}${s.mux ? '+mux' : ''}`).join(' ');
}

/**
 * The SDP's ICE username fragment: the one value all its `a=ice-ufrag` lines name (one transport, one set of ICE
 * credentials). An ICE restart is the only change that gives a new one. Null when there is none, or two.
 */
export function sdpIceUfrag(sdp: string): string | null {
  let found: string | null = null;
  for (const line of sdp.split(/\r?\n/)) {
    if (!line.startsWith('a=ice-ufrag:')) continue;
    const ufrag = line.slice('a=ice-ufrag:'.length).trim();
    if (!ufrag || (found !== null && found !== ufrag)) return null;
    found = ufrag;
  }
  return found;
}

/** The tokens of a candidate line (with or without its `a=` prefix). */
function candidateTokens(line: string): string[] {
  return line.trim().replace(/^a=/, '').split(/\s+/);
}

/**
 * Is this ICE candidate a TURN relay candidate? Read by position, as RFC 8839 lays the line out
 * (`candidate:<foundation> <component> <transport> <priority> <address> <port> typ <type> …`), so the word "relay"
 * anywhere else (an address, an extension value) does not count.
 */
export function isRelayCandidate(line: string): boolean {
  const t = candidateTokens(line);
  return t[0] !== undefined && t[0].startsWith('candidate:') && t[6] === 'typ' && t[7] === 'relay';
}

/** The same candidate with its related address blanked (`raddr 0.0.0.0 rport 0`); unchanged when it has none. */
export function scrubRelayCandidate(line: string): string {
  const prefixed = line.startsWith('a=');
  const t = candidateTokens(line);
  let changed = false;
  // Extensions start after `typ <type>`; they come in name/value pairs.
  for (let i = 8; i + 1 < t.length; i += 2) {
    if (t[i] === 'raddr' && t[i + 1] !== BLANK_ADDRESS) {
      t[i + 1] = BLANK_ADDRESS;
      changed = true;
    } else if (t[i] === 'rport' && t[i + 1] !== BLANK_PORT) {
      t[i + 1] = BLANK_PORT;
      changed = true;
    }
  }
  if (!changed) return line;
  return `${prefixed ? 'a=' : ''}${t.join(' ')}`;
}

/** An SDP's lines, each with its own ending: a browser ends a line at "\n", with or without a "\r" before it. */
const SDP_LINES = /[^\n]*\n|[^\n]+$/g;

/**
 * The SDP with every non-relay `a=candidate` line removed and the relay ones scrubbed; nothing else changes. Lines
 * are read the way the browser reads them, so an SDP that mixes "\r\n" and "\n" cannot hide a candidate inside the
 * line before it; each kept line keeps its own ending.
 */
export function relayOnlySdp(sdp: string): string {
  return (sdp.match(SDP_LINES) ?? [])
    .map((chunk) => {
      const line = chunk.replace(/\r?\n$/, '');
      if (!line.startsWith(CANDIDATE_LINE)) return chunk;
      return isRelayCandidate(line) ? `${scrubRelayCandidate(line)}${chunk.slice(line.length)}` : '';
    })
    .join('');
}

/** The fingerprint of a DER certificate, hashed with `hash`, in the canonical SDP form. */
export async function certificateFingerprint(der: ArrayBuffer, hash: FingerprintHash): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest(hash, der));
  const hex = Array.from(digest, (b) => b.toString(16).padStart(2, '0').toUpperCase()).join(':');
  return `${hash.toLowerCase()} ${hex}`;
}
