# Calls: the one-to-one audio call engine

What is in `@masia/messenger/call`, what it promises, and what a host must give it. The wire it speaks is in
`@masia/contracts/wire`. The state of the whole package is in [`context.md`](context.md); the map is
[`ARCHITECTURE.md`](ARCHITECTURE.md).

## What it is

A headless engine for one audio call between two people who share an end-to-end encrypted one-to-one room. The
audio goes peer to peer over WebRTC. A server only passes the signalling messages along. Before any sound plays,
in either direction, each device proves to the other that it holds the room's MLS secret and that the DTLS
fingerprint it sees is the one the other device sent. The engine has no screen and no framework: it drives one
peer connection through one state machine and talks to the world only through ports. You create it with
`createAudioCallEngine(ports)`. Every rule below is unit-tested. The machine, SDP, wire and
browser-adapter tests are in this repository. The engine's own suites still run in the first host, because they drive that host's binding implementation; they move when the binding does.

The package ships the engine, its state machine (`audioCall`), the SDP checks it relies on, browser adapters for
the peer connection and the microphone, and the types of the binding port. It does not ship a
signalling server, a TURN service, a speaker adapter, a call screen or the binding's implementation. A host brings those.

## What the engine guarantees

- **No audio before the check, either way.** The remote track stays disabled and attached to nothing, and our
  own microphone track sends silence, until the call is `verified`. Verified means the peer's tag checked out
  through the binding port and, where the browser can tell, the certificate DTLS accepted hashes to the
  fingerprint the tag bound. Mute applies on top.
- **One fingerprint per SDP, one transport per call.** Ours and the peer's. An SDP with no fingerprint, with
  more than one distinct fingerprint, or with an m-line outside its one BUNDLE group is refused, and the call
  ends `verify-failed` before anything is attached. The peer fingerprint is read twice, from the text handed to
  the browser and from the description the browser applied, and the two must agree. The peer connection uses
  `bundlePolicy: 'max-bundle'` and `rtcpMuxPolicy: 'require'`.
- **The transport stays the one that was verified.** If the audio sender's DTLS transport is replaced after
  `verified`, or the peer's certificate on it changes, the call ends `verify-failed`. An ICE restart keeps the
  transport and is not a change.
- **Reflection fails.** A peer tag equal to the one we sent ends the call.
- **Bounded verification.** A failed check catches the room up and tries again, at most 3 times within 10 s of
  our first tag. Then the call cannot be verified. A tag that never comes is the same failure.
- **Relay-only means relay-only.** When the ICE answer says `relay`, the peer connection gets
  `iceTransportPolicy: 'relay'` and the engine also drops every non-relay candidate both ways, trickled or inside
  an SDP. A relay-only call with no TURN server to use ends with the problem `relay-unavailable` instead of
  trying.
- **TURN only for an answered call.** The engine asks for ICE servers once the server's `call:accept` is in,
  never while the call rings. The caller renews the set before it expires and restarts ICE onto the fresh set.
  Only the caller ever offers. A restart may change the ICE credentials and the candidates and nothing else: the
  same fingerprint, the same m-lines, or the call ends `verify-failed`.
- **Busy is invisible.** A second ring while a call is live is ignored, never declined. To that caller it looks
  like any unanswered call.
- **Honest ends.** The socket closing, the media path failing, the media path staying down for 30 s after it was
  up, or a local deadline passing: each ends the call with a reason (`lost`, `connect-failed`, `no-answer`).
  Nothing stays "connected" that is not.
- **Nothing from the server is trusted for shape.** Every server frame is validated (`parseCallServerEvent`).
  Frames of another call, or meant for the other side, are dropped.
- **A control channel on every call, silent until verified.** One pre-negotiated data channel
  (`CALL_CONTROL_CHANNEL`) is created with the peer before the first offer. Nothing is sent on it, and anything
  received is dropped, until the call is verified and the channel runs over the audio sender's own DTLS transport
  with the tagged certificate. It carries text only, it is bounded (a binary message, an oversized one or too
  many in a second close it for the rest of the call), and the engine defines no protocol on it.
- **After verification, the host can reach the call's own audio.** `localTrack()` gives the host this device's
  microphone track, and `replaceOutboundTrack(track)` lets it send a different track on the call's sender (a mix,
  for example). Both work only on a verified call. A host that uses them decides what the other person hears,
  so say so to your users.

The exact numbers (ack and ring deadlines, the verification window, renewal and restart timings, message limits)
are in `AUDIO_CALL_ENGINE_LIMITS`, next to the engine.

**Show "connected" only when `snapshot.live` is true.** It means `verified` and the media path is up. Neither
`media === 'connected'` nor `call.name === 'verified'` is enough on its own. Name the other person from
`snapshot.verifiedPeer`, which is what the call proved; an id the server sent is a claim.

## The ports a host must provide

`createAudioCallEngine(ports: CallEnginePorts)`. Each field, with its contract as the code states it:

| Port | Contract |
| --- | --- |
| `socket: CallSocketPort` | The host's signalling channel, as far as calls need it. `send(event)` sends one `call:*` client frame and returns false when the socket is not open (the frame is dropped, not queued). `isOpen()`. `subscribe(onFrame)` delivers every server frame whose type starts with `call:`, raw: the engine validates it. `onClosed(onClose)` reports every close of an opened socket, with its code. Both return an unsubscribe. |
| `iceServers: (callId) => Promise<CallIceAnswer>` | The ICE servers for an answered call. `status` is `OK`, `PENDING` (not accepted yet, no servers), `NOT_CONFIGURED` or `PROVIDER_ERROR`; plus `iceServers`, `iceTransportPolicy` (`all` or `relay`), and for `OK` an `expiresAt` (epoch ms, server clock) and optionally `expiresInMs` (time left when the server answered, so no clocks need comparing). |
| `binding: CallBindingPort \| null` | The room's MLS secret, asked two questions: `callTag(request)` computes this device's tag for its own role, `callVerify(request)` checks the peer's tag. `null` means there is no encryption runtime, so a call could never be verified and none is placed. |
| `microphone: () => Promise<MediaStream>` | The microphone. Rejects with the browser's own error. |
| `createPeer: (config, events) => CallPeer` | One `RTCPeerConnection`, reduced to what a one-to-one audio call does with it. It must create the control channel from `config.control` at once, before any offer, pre-negotiated, ordered and reliable, and report candidates, the remote track, the connection state, control-channel events and description changes through `events`. |
| `speaker: CallSpeaker` | Where the remote audio plays. `attach(stream)` returns false when the browser refused to start playback; `resume()` retries from a user gesture; `detach()`. Optional `onInterrupted` (playback stopped from outside) and `dispose`. |
| `localDeviceId: () => string` | This install's MLS device id, the one the binding speaks for. |
| `newRequestId: () => string` | A fresh `call:invite` request id matching `CALL_REQUEST_ID_PATTERN`. |
| `machine?` | The state machine to drive. Defaults to the one shared `audioCall` machine. |
| `now?` | The clock, for tests. |

The browser adapters in `@masia/messenger/call` cover `createPeer` and `microphone`, and give a request id
helper for `newRequestId`. `socket`, `iceServers`, `speaker`, `binding` and `localDeviceId` are the host's.

### What the binding must check

The tag is `HMAC-SHA256(K, label ‖ role ‖ callId ‖ callerDeviceId ‖ calleeDeviceId ‖ fingerprintCaller ‖
fingerprintCallee)`, where `K` is an MLS exporter secret of the room for this call. The construction lives in
`@masia/contracts/wire` (`computeCallTag`, `verifyPeerCallTag`, `callTagInput`, `normalizeDtlsFingerprint`, and
the exporter and tag labels); a binding uses it and does not re-implement it. The comparison is constant time.

A tag alone proves only that the other end holds the room's key, and other member devices of the room hold it
too. So the engine's guarantees hold only if the host's binding also refuses, in both `callTag` and
`callVerify`, a peer device that is not the one other person's own device as the room's MLS group holds it at
this epoch, and names that person in a verdict that passes. Its answers also list every other member device of
the room at that epoch, by kind, so a screen can say who else could derive `K`. Keep `K` inside whatever holds
the MLS state (the first host computes it in a Worker and never hands it to the page), and derive it only for
the epoch this device holds now, never for one a peer names.

## The wire

The `call:*` events, their payloads, the limits (`CALL_LIMITS`), the id patterns, the end reasons and the
validators (`parseCallClientEvent` for a server, `parseCallServerEvent` for a client) live in
`@masia/contracts/wire`. The client sends `call:invite`, `call:accept`, `call:decline`, `call:ice`,
`call:verify`, `call:end` and `call:ringing`; the server sends `call:invite` (the ack), `call:ring`,
`call:accept`, `call:ice`, `call:verify` and `call:end`. The SDP offer and answer ride `call:ice`. A signalling
server checks shape and who may send what; it never reads inside an SDP or a tag.

## What is not here yet

- **Signalling.** The relay in this repository does not carry `call:*` events. A host passes them over a channel
  of its own (the first host uses its chat socket). Carrying them through the relay is a separate decision, not
  taken.
- **TURN.** No credentials route. A host answers `iceServers` itself.
- **A call in the playground.** The two-tab playground cannot place a call.
- **A call screen.** There is no screen here, and no React hook. A host builds the screen on the engine's
  snapshot and commands.
- **The binding.** Only its port types and the tag construction are here; the code that derives `K` from a live
  MLS room is the host's.
- **Platforms.** The engine has been run in Chromium. Other browsers and phones have not been measured.
