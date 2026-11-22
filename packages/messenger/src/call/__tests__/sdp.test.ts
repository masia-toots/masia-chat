/**
 * What the call engine reads out of, and strips from, an SDP (ADR-211 decisions 4 and 6, step Д2a).
 *
 *  - The DTLS fingerprint the tag binds: exactly ONE distinct value per SDP. An SDP may carry several
 *    `a=fingerprint` lines (session level and media level, or two hash functions); if the tag bound one and the
 *    browser enforced another, a signalling path could sit in the middle undetected — so more than one distinct
 *    value (after canonicalisation) is refused, and so is a weak or ill-formed one.
 *  - A relay-only call keeps only `typ relay` candidates, in the SDP and trickled, both ways, with the related
 *    address (the device's own public address, as the TURN server saw it) blanked.
 *  - The certificate actually in use, hashed the way the SDP names it, for the check after DTLS connects.
 *  - What an ICE restart may change (the ICE credentials, the candidates) and what it may not (the m-lines, their
 *    mids, RTCP muxing).
 */
import { describe, expect, it } from 'vitest';
import {
  boundFingerprint,
  certificateFingerprint,
  fingerprintHash,
  isRelayCandidate,
  relayOnlySdp,
  scrubRelayCandidate,
  sdpBundled,
  sdpFingerprint,
  sdpIceUfrag,
  sdpLayout,
} from '../sdp.js';

const HEX_A = `${'AB:'.repeat(31)}AB`;
const HEX_B = `${'CD:'.repeat(31)}CD`;
const FP_A = `sha-256 ${HEX_A}`;

const HOST = 'candidate:1 1 udp 2122260223 192.168.1.20 54321 typ host generation 0 network-id 1';
const SRFLX = 'candidate:2 1 udp 1686052607 203.0.113.7 54321 typ srflx raddr 192.168.1.20 rport 54321 generation 0';
const RELAY = 'candidate:3 1 udp 41885439 198.51.100.9 3478 typ relay raddr 203.0.113.7 rport 54321 generation 0';
const MDNS = 'candidate:4 1 udp 2122260223 4f1c-uuid.local 50000 typ host';

function sdp(lines: string[]): string {
  return `${lines.join('\r\n')}\r\n`;
}
function offer({
  session = [] as string[],
  media = [`a=fingerprint:sha-256 ${HEX_A}`],
  candidates = [] as string[],
  secondMedia = null as string[] | null,
}: { session?: string[]; media?: string[]; candidates?: string[]; secondMedia?: string[] | null } = {}): string {
  return sdp([
    'v=0',
    'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    ...session,
    'a=group:BUNDLE 0',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111',
    'c=IN IP4 0.0.0.0',
    'a=ice-ufrag:abcd',
    'a=ice-pwd:abcdefghijklmnopqrstuvwx',
    ...media,
    'a=setup:actpass',
    'a=mid:0',
    ...candidates.map((c) => `a=${c}`),
    'a=rtpmap:111 opus/48000/2',
    ...(secondMedia ? ['m=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'c=IN IP4 0.0.0.0', ...secondMedia, 'a=mid:1'] : []),
  ]);
}

describe('sdpFingerprint: the one fingerprint an SDP binds', () => {
  it('reads the media-level fingerprint, canonical (hash lower-case, hex upper-case)', () => {
    expect(sdpFingerprint(offer())).toBe(FP_A);
    expect(sdpFingerprint(offer({ media: [`a=fingerprint:SHA-256 ${HEX_A.toLowerCase()}`] }))).toBe(FP_A);
  });

  it('a session-level fingerprint alone is the one', () => {
    expect(sdpFingerprint(offer({ session: [`a=fingerprint:sha-256 ${HEX_A}`], media: [] }))).toBe(FP_A);
  });

  it('the same value repeated (session + media, or one per m-section) is still ONE value', () => {
    expect(sdpFingerprint(offer({ session: [`a=fingerprint:sha-256 ${HEX_A}`] }))).toBe(FP_A);
    expect(sdpFingerprint(offer({ secondMedia: [`a=fingerprint:sha-256 ${HEX_A.toLowerCase()}`] }))).toBe(FP_A);
  });

  it('two distinct values are refused — whichever the tag bound, the browser might enforce the other', () => {
    expect(sdpFingerprint(offer({ session: [`a=fingerprint:sha-256 ${HEX_B}`] }))).toBeNull();
    expect(sdpFingerprint(offer({ secondMedia: [`a=fingerprint:sha-256 ${HEX_B}`] }))).toBeNull();
    expect(sdpFingerprint(offer({ media: [`a=fingerprint:sha-256 ${HEX_A}`, `a=fingerprint:sha-256 ${HEX_B}`] }))).toBeNull();
    // the same certificate under a second hash function is a second value too
    expect(
      sdpFingerprint(offer({ media: [`a=fingerprint:sha-256 ${HEX_A}`, `a=fingerprint:sha-512 ${`${'EF:'.repeat(63)}EF`}`] })),
    ).toBeNull();
  });

  it('none, an ill-formed one, or a weak or unknown hash function is refused', () => {
    expect(sdpFingerprint(offer({ media: [] }))).toBeNull();
    expect(sdpFingerprint(offer({ media: ['a=fingerprint:sha-256 not-hex'] }))).toBeNull();
    expect(sdpFingerprint(offer({ media: [`a=fingerprint:sha-256 ${HEX_A}`, 'a=fingerprint:garbage'] }))).toBeNull();
    expect(sdpFingerprint(offer({ media: [`a=fingerprint:sha-1 ${'AB:'.repeat(19)}AB`] }))).toBeNull();
    expect(sdpFingerprint(offer({ media: [`a=fingerprint:md5 ${'AB:'.repeat(15)}AB`] }))).toBeNull();
    // a hash name the SDP claims must also have that hash's length
    expect(sdpFingerprint(offer({ media: [`a=fingerprint:sha-256 ${'AB:'.repeat(19)}AB`] }))).toBeNull();
    expect(sdpFingerprint('')).toBeNull();
  });

  it('sha-384 and sha-512 are accepted', () => {
    const fp384 = `sha-384 ${'0A:'.repeat(47)}0A`;
    expect(sdpFingerprint(offer({ media: [`a=fingerprint:${fp384}`] }))).toBe(fp384);
    expect(fingerprintHash(fp384)).toBe('SHA-384');
    expect(fingerprintHash(FP_A)).toBe('SHA-256');
  });
});

describe('relay-only: only `typ relay` candidates, both ways, in the SDP and trickled', () => {
  it('tells a relay candidate from every other kind', () => {
    expect(isRelayCandidate(RELAY)).toBe(true);
    expect(isRelayCandidate(`a=${RELAY}`)).toBe(true);
    expect(isRelayCandidate('candidate:3 1 tcp 41885439 198.51.100.9 443 typ relay raddr 0.0.0.0 rport 0 tcptype passive')).toBe(true);
    expect(isRelayCandidate(HOST)).toBe(false);
    expect(isRelayCandidate(SRFLX)).toBe(false);
    expect(isRelayCandidate(MDNS)).toBe(false);
    expect(isRelayCandidate('candidate:5 1 udp 1 203.0.113.7 1 typ prflx')).toBe(false);
    // the word in the wrong place, or a type that only starts with it
    expect(isRelayCandidate('candidate:6 1 udp 1 relay 1 typ host')).toBe(false);
    expect(isRelayCandidate('candidate:6 1 udp 1 203.0.113.7 1 typ relayed')).toBe(false);
    expect(isRelayCandidate('candidate:7 1 udp 1 203.0.113.7 1 typ')).toBe(false);
    expect(isRelayCandidate('')).toBe(false);
  });

  it('blanks the related address of a relay candidate (it is this device\'s own public address)', () => {
    expect(scrubRelayCandidate(RELAY)).toBe('candidate:3 1 udp 41885439 198.51.100.9 3478 typ relay raddr 0.0.0.0 rport 0 generation 0');
    expect(scrubRelayCandidate(`a=${RELAY}`)).toBe('a=candidate:3 1 udp 41885439 198.51.100.9 3478 typ relay raddr 0.0.0.0 rport 0 generation 0');
    const bare = 'candidate:3 1 udp 41885439 198.51.100.9 3478 typ relay generation 0';
    expect(scrubRelayCandidate(bare)).toBe(bare);
  });

  it('drops every non-relay candidate embedded in an SDP and keeps the rest of it byte for byte', () => {
    const full = offer({ candidates: [HOST, SRFLX, RELAY, MDNS] });
    const relayOnly = relayOnlySdp(full);
    expect(relayOnly).not.toContain('typ host');
    expect(relayOnly).not.toContain('typ srflx');
    expect(relayOnly).not.toContain('192.168.1.20');
    expect(relayOnly).not.toContain('203.0.113.7');
    expect(relayOnly).toContain('a=candidate:3 1 udp 41885439 198.51.100.9 3478 typ relay raddr 0.0.0.0 rport 0 generation 0\r\n');
    expect(relayOnly).toBe(offer({ candidates: ['candidate:3 1 udp 41885439 198.51.100.9 3478 typ relay raddr 0.0.0.0 rport 0 generation 0'] }));
    // an SDP with no candidates is untouched
    expect(relayOnlySdp(offer())).toBe(offer());
  });

  // Review of step Д2a (low): a browser ends an SDP line at "\n", with or without "\r". An SDP that mixes the two
  // must be read line by line the same way, or a candidate behind a bare "\n" rides inside the line before it.
  it('reads a line the way the browser does: a bare "\\n" ends it too, in an SDP that mostly uses "\\r\\n"', () => {
    const relay = 'a=candidate:3 1 udp 41885439 198.51.100.9 3478 typ relay raddr 0.0.0.0 rport 0 generation 0';
    const mixed = offer({ candidates: [RELAY] }).replace('a=mid:0\r\n', `a=mid:0\na=${HOST}\na=${SRFLX}\r\n`);
    expect(relayOnlySdp(mixed)).toBe(
      offer({ candidates: [RELAY] }).replace(`a=${RELAY}`, relay).replace('a=mid:0\r\n', 'a=mid:0\n'),
    );
    // …and the other way round: one "\r\n" in an SDP of bare "\n"
    const lf = offer({ candidates: [HOST, RELAY] }).replaceAll('\r\n', '\n').replace('a=setup:actpass\n', 'a=setup:actpass\r\n');
    const out = relayOnlySdp(lf);
    expect(out).not.toContain('typ host');
    expect(out).toContain(`${relay}\n`);
    expect(out).toContain('a=setup:actpass\r\na=mid:0\n'); // each kept line keeps its own ending
  });
});

describe('sdpBundled / boundFingerprint: one transport for the audio and the control channel (ADR-215 decision 4)', () => {
  /** Audio (mid 0) and the control channel (mid 1), each with its own fingerprint line, as Chromium writes them. */
  function call({
    group = ['a=group:BUNDLE 0 1'],
    audioFp = HEX_A,
    appFp = HEX_A,
    appMid = ['a=mid:1'],
    appPort = '9',
  }: { group?: string[]; audioFp?: string; appFp?: string; appMid?: string[]; appPort?: string } = {}): string {
    return sdp([
      'v=0',
      'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
      's=-',
      't=0 0',
      ...group,
      'm=audio 9 UDP/TLS/RTP/SAVPF 111',
      'c=IN IP4 0.0.0.0',
      `a=fingerprint:sha-256 ${audioFp}`,
      'a=setup:actpass',
      'a=mid:0',
      'a=rtcp-mux',
      'a=rtpmap:111 opus/48000/2',
      `m=application ${appPort} UDP/DTLS/SCTP webrtc-datachannel`,
      'c=IN IP4 0.0.0.0',
      `a=fingerprint:sha-256 ${appFp}`,
      'a=setup:actpass',
      ...appMid,
      'a=sctp-port:5000',
    ]);
  }

  it('audio and the control channel in one BUNDLE group: bundled, and the one fingerprint is bound', () => {
    expect(sdpBundled(call())).toBe(true);
    expect(boundFingerprint(call())).toBe(FP_A);
    // the group may name the mids in any order
    expect(sdpBundled(call({ group: ['a=group:BUNDLE 1 0'] }))).toBe(true);
  });

  it('no BUNDLE group — the SDP rewritten to unbundle — is refused', () => {
    expect(sdpBundled(call({ group: [] }))).toBe(false);
    expect(boundFingerprint(call({ group: [] }))).toBeNull();
    // another kind of group is not a BUNDLE group
    expect(sdpBundled(call({ group: ['a=group:LS 0 1'] }))).toBe(false);
  });

  it('an m-line outside the group — a rejected one included — is refused', () => {
    expect(sdpBundled(call({ group: ['a=group:BUNDLE 0'] }))).toBe(false);
    expect(sdpBundled(call({ group: ['a=group:BUNDLE 0'], appPort: '0' }))).toBe(false);
    expect(boundFingerprint(call({ group: ['a=group:BUNDLE 0'] }))).toBeNull();
  });

  it('an m-line with no mid, or two BUNDLE groups (two transports), is refused', () => {
    expect(sdpBundled(call({ appMid: [] }))).toBe(false);
    expect(sdpBundled(call({ group: ['a=group:BUNDLE 0', 'a=group:BUNDLE 1'] }))).toBe(false);
    expect(sdpBundled(call({ group: ['a=group:BUNDLE 0 1', 'a=group:BUNDLE 0 1'] }))).toBe(false);
    expect(sdpBundled(sdp(['v=0', 'a=group:BUNDLE 0']))).toBe(false);
    expect(sdpBundled('')).toBe(false);
  });

  it('only the application m-line\'s fingerprint swapped: bundled, but no fingerprint to bind', () => {
    const swapped = call({ appFp: HEX_B });
    expect(sdpBundled(swapped)).toBe(true);
    expect(boundFingerprint(swapped)).toBeNull();
  });
});

describe('sdpLayout / sdpIceUfrag: what an ICE restart may change, and what it may not (ADR-211, 2026-11-15)', () => {
  /** A Chromium-shaped call SDP; a restart changes only the ICE credentials and the candidates. */
  function call({
    ufrag = 'abcd',
    appUfrag = ufrag,
    candidates = [] as string[],
    audioMux = ['a=rtcp-mux'],
    extra = [] as string[],
  }: { ufrag?: string; appUfrag?: string; candidates?: string[]; audioMux?: string[]; extra?: string[] } = {}): string {
    return sdp([
      'v=0',
      'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
      's=-',
      't=0 0',
      'a=group:BUNDLE 0 1',
      'm=audio 9 UDP/TLS/RTP/SAVPF 111',
      'c=IN IP4 0.0.0.0',
      `a=ice-ufrag:${ufrag}`,
      'a=ice-pwd:abcdefghijklmnopqrstuvwx',
      `a=fingerprint:sha-256 ${HEX_A}`,
      'a=mid:0',
      ...candidates.map((c) => `a=${c}`),
      ...audioMux,
      'a=rtpmap:111 opus/48000/2',
      'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
      'c=IN IP4 0.0.0.0',
      `a=ice-ufrag:${appUfrag}`,
      'a=ice-pwd:abcdefghijklmnopqrstuvwx',
      `a=fingerprint:sha-256 ${HEX_A}`,
      'a=mid:1',
      'a=sctp-port:5000',
      ...extra,
    ]);
  }

  it('the layout: each m-section\'s media, its mid, and whether it muxes RTCP — in order', () => {
    expect(sdpLayout(call())).toBe('audio:0+mux application:1');
  });

  it('a restart\'s own changes — ICE credentials, candidates — leave the layout as it was', () => {
    expect(sdpLayout(call({ ufrag: 'efgh', candidates: [RELAY, HOST] }))).toBe(sdpLayout(call()));
  });

  it('an m-line added, a mid changed or RTCP no longer muxed is another layout', () => {
    const added = call({ extra: ['m=audio 9 UDP/TLS/RTP/SAVPF 111', 'a=mid:2', 'a=rtcp-mux'] });
    expect(sdpLayout(added)).toBe('audio:0+mux application:1 audio:2+mux');
    expect(sdpLayout(call({ audioMux: [] }))).toBe('audio:0 application:1');
    // `a=rtcp-mux-only` is another attribute, not the mux the connection requires
    expect(sdpLayout(call({ audioMux: ['a=rtcp-mux-only'] }))).toBe('audio:0 application:1');
    expect(sdpLayout(call().replace('a=mid:1', 'a=mid:x'))).toBe('audio:0+mux application:x');
  });

  it('an m-section with no mid, or two, has no layout; nor has an SDP with no m-section', () => {
    expect(sdpLayout(call().replace('a=mid:1\r\n', ''))).toBeNull();
    expect(sdpLayout(call().replace('a=mid:1', 'a=mid:1\r\na=mid:2'))).toBeNull();
    expect(sdpLayout(sdp(['v=0', 's=-']))).toBeNull();
  });

  it('the ICE ufrag: the one value every m-section names; none, or two, is no ufrag', () => {
    expect(sdpIceUfrag(call())).toBe('abcd');
    expect(sdpIceUfrag(call({ ufrag: 'efgh' }))).toBe('efgh');
    expect(sdpIceUfrag(call({ appUfrag: 'other' }))).toBeNull();
    expect(sdpIceUfrag(sdp(['v=0', 'm=audio 9 UDP/TLS/RTP/SAVPF 111', 'a=mid:0']))).toBeNull();
  });
});

describe('certificateFingerprint: the certificate in use, as the SDP spells it', () => {
  it('hashes the DER bytes with the named function, canonical form', async () => {
    const der = new Uint8Array([1, 2, 3]).buffer;
    expect(await certificateFingerprint(der, 'SHA-256')).toBe(
      'sha-256 03:90:58:C6:F2:C0:CB:49:2C:53:3B:0A:4D:14:EF:77:CC:0F:78:AB:CC:CE:D5:28:7D:84:A1:A2:01:1C:FB:81',
    );
  });
});

// ── a whole offer as each family of browsers writes it ─────────────────────────────────────────────────────────
//
// TODO-1314 (platform audit, 2026-11-15). Hand-written from the SHAPES those browsers emit for an audio m-section plus
// the control data channel under `max-bundle` — NOT captured on a device (no Firefox or Safari ran on the box: see the
// call README § Testing). They pin the places the shapes differ, which are exactly the places the engine's readers
// could disagree with a browser: where the fingerprint sits (per m-section, or once at session level), whether a
// bundled-only section repeats the ICE credentials and DTLS attributes or carries none, line endings, and attribute
// order. A real capture from a phone replaces a fixture here when one exists.
describe('a whole offer, as each browser family writes it', () => {
  const CHROMIUM_LIKE = [
    // Chromium and Safari (both libwebrtc): the fingerprint and credentials repeat in every m-section.
    'v=0',
    'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'a=group:BUNDLE 0 1',
    'a=extmap-allow-mixed',
    'a=msid-semantic: WMS stream',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111 63',
    'c=IN IP4 0.0.0.0',
    'a=rtcp:9 IN IP4 0.0.0.0',
    'a=ice-ufrag:Xk3f',
    'a=ice-pwd:aaaaaaaaaaaaaaaaaaaaaaaa',
    'a=ice-options:trickle',
    `a=fingerprint:sha-256 ${HEX_A}`,
    'a=setup:actpass',
    'a=mid:0',
    'a=sendrecv',
    'a=rtcp-mux',
    'a=rtpmap:111 opus/48000/2',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
    'a=ice-ufrag:Xk3f',
    'a=ice-pwd:aaaaaaaaaaaaaaaaaaaaaaaa',
    'a=ice-options:trickle',
    `a=fingerprint:sha-256 ${HEX_A}`,
    'a=setup:actpass',
    'a=mid:1',
    'a=sctp-port:5000',
    'a=max-message-size:262144',
  ];
  const FIREFOX_LIKE = [
    // Firefox: ONE fingerprint at session level; the first section carries the ICE credentials, and the data channel
    // rides the bundle with no transport attributes of its own (JSEP bundle-only: port 0).
    'v=0',
    'o=mozilla...THIS_IS_SDPARTA-125.0 4611731400430051336 0 IN IP4 0.0.0.0',
    's=-',
    't=0 0',
    `a=fingerprint:sha-256 ${HEX_A}`,
    'a=group:BUNDLE 0 1',
    'a=ice-options:trickle',
    'a=msid-semantic:WMS *',
    'm=audio 9 UDP/TLS/RTP/SAVPF 109 9 0 8 101',
    'c=IN IP4 0.0.0.0',
    'a=sendrecv',
    'a=ice-pwd:bbbbbbbbbbbbbbbbbbbbbbbb',
    'a=ice-ufrag:9a7c1d2e',
    'a=mid:0',
    'a=rtcp-mux',
    'a=setup:actpass',
    'a=rtpmap:109 opus/48000/2',
    'm=application 0 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
    'a=bundle-only',
    'a=mid:1',
    'a=sctp-port:5000',
    'a=max-message-size:1073741823',
  ];

  const CASES: ReadonlyArray<readonly [string, string, string]> = [
    ['Chromium / Safari (CRLF, per-section fingerprint)', `${CHROMIUM_LIKE.join('\r\n')}\r\n`, 'Xk3f'],
    ['Firefox (session fingerprint, bundle-only data channel)', `${FIREFOX_LIKE.join('\r\n')}\r\n`, '9a7c1d2e'],
    ['Firefox with bare LF line endings', `${FIREFOX_LIKE.join('\n')}\n`, '9a7c1d2e'],
  ];

  it.each(CASES)('%s: one bound fingerprint, one bundled transport, the layout and ICE ufrag an ICE restart compares', (_name, text, ufrag) => {
    expect(sdpBundled(text)).toBe(true);
    expect(sdpFingerprint(text)).toBe(FP_A);
    expect(boundFingerprint(text)).toBe(FP_A);
    expect(sdpIceUfrag(text)).toBe(ufrag);
  });

  it('the layout names each m-section’s media, mid and RTCP muxing — the audio mux a browser must write', () => {
    expect(sdpLayout(CASES[0]![1])).toBe('audio:0+mux application:1');
    expect(sdpLayout(CASES[1]![1])).toBe('audio:0+mux application:1');
    expect(sdpLayout(CASES[2]![1])).toBe('audio:0+mux application:1');
  });

  it('a relay-only call keeps such an SDP as it is when it carries no candidate, and strips a host one in either shape', () => {
    for (const [, text] of CASES) expect(relayOnlySdp(text)).toBe(text);
    const withHost = CASES[1]![1].replace('a=mid:0\n', `a=mid:0\n${'a=' + HOST}\n`).replace('a=mid:0\r\n', `a=mid:0\r\n${'a=' + HOST}\r\n`);
    expect(withHost).toContain(HOST);
    expect(relayOnlySdp(withHost)).not.toContain(HOST);
  });

  it('a browser that moves the fingerprint into a second value is still refused, wherever the second one sits', () => {
    const second = `a=fingerprint:sha-256 ${HEX_B}`;
    expect(boundFingerprint(CASES[0]![1].replace('a=mid:1', `${second}\r\na=mid:1`))).toBeNull();
    expect(boundFingerprint(CASES[1]![1].replace('a=bundle-only', `a=bundle-only\r\n${second}`))).toBeNull();
  });
});
