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
`createAudioCallEngine(ports)`. Every rule below is unit-tested in this repository: the machine, SDP, wire,
browser-adapter and binding tests, and the engine's own suites, which drive the package's binding over a fake keyring.

The package ships the engine, its state machine (`audioCall`), the SDP checks it relies on, browser adapters for
the peer connection and the microphone, a plain speaker, the types of the binding port, the binding itself
(`callTag` / `callVerify`, [below](#what-the-binding-must-check)), which a host runs over a keyring of its room,
the call screen with its React hooks ([§ The call screen](#the-call-screen)), and a socket adapter for the relay's
opt-in call channel ([§ Signalling through the relay](#signalling-through-the-relay)). It does not ship a TURN
service or the keyring that derives the call key from a live MLS room. A host brings those, and its own signalling
channel unless it uses the relay's.

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
helper for `newRequestId`. `createAudioElementSpeaker()` (`@masia/messenger/call/browser-speaker`) is a plain
`speaker`: one `<audio>` element playing the call's stream. A host that shares its audio output between several
players gives its own speaker instead, one that reports `onInterrupted` when other media takes over.
`iceServers` and `localDeviceId` are the host's; so is `socket`, unless the host signals through the relay with
`createRelayCallSocket` ([§ Signalling through the relay](#signalling-through-the-relay)). For `binding`, a host
runs the package's `callTag` / `callVerify` over a keyring of its room, inside whatever holds its MLS state.

### What the binding must check

The tag is `HMAC-SHA256(K, label ‖ role ‖ callId ‖ callerDeviceId ‖ calleeDeviceId ‖ fingerprintCaller ‖
fingerprintCallee)`, where `K` is an MLS exporter secret of the room for this call. The construction lives in
`@masia/contracts/wire` (`computeCallTag`, `verifyPeerCallTag`, `callTagInput`, `normalizeDtlsFingerprint`, and
the exporter and tag labels); a binding uses it and does not re-implement it. The comparison is constant time.

A tag alone proves only that the other end holds the room's key, and other member devices of the room hold it
too. So the engine's guarantees hold only if the binding also refuses, in both `callTag` and `callVerify`, a peer
device that is not the one other person's own device as the room's MLS group holds it at this epoch, and names
that person in a verdict that passes. Its answers also list every other member device of the room at that epoch,
by kind, so a screen can say who else could derive `K`.

The package's binding (`call-binding.ts`, also behind its own door `@masia/messenger/call/call-binding`, so a
worker need not load the engine) does all of this. It speaks only for this device's own role, wipes `K` after
each question, and refuses a request it will not answer with `CallBindingError` (`INVALID`), which a host maps
onto its own worker protocol. What it needs from the host is a `CallKeyring`: this device's user and device
ids, and `key(callId, fresh)`, which returns `K` with the epoch it was derived for and the room's members at that
epoch (`fresh` catches the room up first). Run it inside whatever holds the MLS state (the first host runs it in
a Worker and never hands `K` to the page), and derive `K` only for the epoch this device holds now, never for
one a peer names. A host that writes its own binding must make the same checks.

## The wire

The `call:*` events, their payloads, the limits (`CALL_LIMITS`), the id patterns, the end reasons and the
validators (`parseCallClientEvent` for a server, `parseCallServerEvent` for a client) live in
`@masia/contracts/wire`. The client sends `call:invite`, `call:accept`, `call:decline`, `call:ice`,
`call:verify`, `call:end` and `call:ringing`; the server sends `call:invite` (the ack), `call:ring`,
`call:accept`, `call:ice`, `call:verify` and `call:end`. The SDP offer and answer ride `call:ice`. A signalling
server checks shape and who may send what; it never reads inside an SDP or a tag.

## Signalling through the relay

A host with no signalling server of its own can pass call signals through the relay in this repository. The
relay's call channel is **off unless the relay starts with `RELAY_CALLS_ENABLED=true`**; off, its routes do not
exist. It is meant for loopback or a trusted LAN, not for a public calling service.

**What the relay does.** Two routes, both with the relay's bearer token in the `Authorization` header (never in a
query string):

- `GET /calls/stream` — one server-sent event stream per device: `event: ready` with `{closesInMs}` (the stream
  closes when the token expires), then `event: signal` with `{conversationId, fromUserId, fromDeviceId, signal}`
  for each signal posted to this device, and a keep-alive comment every 15 seconds. A newer stream of the same
  device ends the older one with `event: replaced`.
- `POST /calls/signal` with `{conversationId, toDeviceId, signal}` — always `202` with an empty body, whether the
  other device is listening or not. Nothing is stored or queued: a signal to a device with no open stream is gone.

The signals are `call:ring`, `call:accept`, `call:accepted`, `call:decline`, `call:ice`, `call:verify` and
`call:end` (`RELAY_CALL_SIGNAL`, `parseRelayCallSignal` and the stream parsers in `@masia/contracts/wire`). The relay
checks their shape and never reads inside an SDP or a tag. It lets a device signal only when both ends are `USER`
devices, the room's current members are the `USER` devices of exactly two people, the sender is a current member
and the target is a device of the other person. It names the sender to the receiver from its own device record,
never from the body. It re-checks an open stream's device at least once a minute and closes the stream of a revoked
or removed device. It caps frames per signed user and device (the token's user and device together, so another
account's token naming your device spends its own budget; a burst, then a few per second, spent before it reads its
database), calls per person and per pair per hour (counted once per call id, so a new id buys nothing), signals per
call, open streams, and how far a slow reader may fall behind (more than 64 KiB unread, and its signals are dropped).
**A ring admits its call between the ringing device and the rung one; any other signal passes only between the two
devices of an admitted call**, either way, so a call id nobody rang buys nothing (the signal is dropped, still
`202`). A call that is only ringing is forgotten after 10 quiet minutes. A connected call (the rung device's
`call:accept`, then the ringing device's `call:accepted`) keeps its place through 4 hours of quiet, so a long call's
ICE restart and its hang-up still pass. A `call:end` either way is delivered and then closes the call: anything
after it is dropped, and its place is free. A connected call quiet for more than 4 hours loses its signalling, and
its hang-up reaches the other end only as the audio stopping. The relay keeps every such table in memory under a
hard ceiling, and one person's rings may hold only a share of it. It originates only `ready`, `replaced`, the stamped `signal`
envelope and its HTTP answers; never a ring, an accept or an end of its own. Its HTTP API, with these rules, is in
`apps/relay/openapi.json`.

**What the client does.** `createRelayCallSocket(options)` returns a `CallSocketPort` (plus `close()` and
`status()`) that the engine uses like any other socket:

```ts
const socket = createRelayCallSocket({
  baseUrl: 'http://127.0.0.1:3400', // the relay
  token: () => auth.relayToken(), // a fresh relay access token
  ringTargets: (conversationId) => devicesOfTheOtherPerson(conversationId), // the devices to ring
  // fetch, now, randomBytes, random and reconnect timings are injectable for tests
});
```

Nothing is read from globals when the module loads, and it uses no DOM-only API: `fetch` streams the events, so
it runs in a browser and in Node. Because the relay is not a call server, the two clients do that part between
them. The caller makes a fresh 16-byte call id, answers the engine's invite itself, rings the other person's
devices one by one, lets the first accept win (the other devices hear `answered-elsewhere`) and ends the call as
`no-answer` when the ring deadline passes. The callee drops a ring whose call id it has already seen. Each side
then **pins its peer**: the callee listens only to the device that rang, the caller only to the device whose
accept won, and an offer is taken only from the caller, an answer only from the callee. Signals for that call from
any other device are dropped, including the same person's other devices. A call's signals are posted one at a
time. The stream reconnects with jittered backoff (honouring `Retry-After` up to the backoff ceiling, 30 seconds by
default), is replaced before its token expires (a `closesInMs` longer than any token lives is capped),
is treated as dead after 45 seconds of silence, and stops for good on `403`/`404` or when another tab of the same
device takes over (`status()` is then `stopped`). When it drops, every call but a ring still waiting for an answer
ends as `lost`, as with any socket.

**What the operator of the relay sees.** It cannot hear a call: the audio goes peer to peer, and the engine's
check binds it to the room's MLS secret, which the relay never holds. But it sees who signals whom and when, both
devices' IP addresses and every SDP in full, candidates included. It applies no blocks, no quiet hours and no
child protection; its only rules are the ones above. The relay names no TURN server, so the two devices also see
each other's addresses.

**ICE.** Neither side names a STUN server. Answer `iceServers` with `iceTransportPolicy: 'all'` only when both
ends are on loopback, and `'relay'` otherwise; with no TURN server, a `'relay'` call off loopback does not connect
until you bring one.

**Limits of this path.** The streams and budgets live in one relay process; two relay processes behind one
address would split them. A revoked device can keep its stream for up to a minute (its posts are refused at
once). The call-server logic runs in the clients, so a peer can still mislead its own peer about why a call
ended; pinning keeps third devices out, not the peer itself. A ringing call quiet for 10 minutes, or a connected
one quiet for 4 hours, loses its signalling (see above); while the relay's table of admitted calls is full, new
rings are dropped, and many people acting together can keep it full, as they can the open streams.

## The call screen

`@masia/messenger/call/react` puts the engine on screen. It has no words, no icons and no UI kit of its own: the
host passes them in, and it uses no Mantine component. A host mounts three things.

```tsx
const binding = useMemo(() => (callTag && callVerify ? { callTag, callVerify } : null), [callTag, callVerify]);
const snapshot = useAudioCallHost({ allowed, binding, createPorts, holdSignalling, holdScreen });
const { engine } = useAudioCall();
const view = useCallView(snapshot);
return <AudioCallHost engine={engine} view={view} name={name} t={t} icon={icon} layer={Layer} />;
```

Keep that component mounted for as long as the app runs. `AudioCallHost` draws nothing while there is no engine
or no call, and it keeps its per-call state (the fold, the cues, where focus was) between calls.

### `useAudioCallHost(options)`: the tab's one engine

Mount it once. It returns the snapshot, or null while calls are off. `useAudioCall()` reads `{ engine, snapshot }`
anywhere else.

| Option | Contract |
| --- | --- |
| `allowed: boolean` | Calls are allowed for this account. A call in progress outlives it turning false; the engine goes once the call is over. |
| `binding: CallBindingPort \| null` | The two binding questions; null means no engine is made. The engine belongs to one pair of `callTag` and `callVerify` functions. A new object with the same two functions keeps the engine. A new function makes a new engine, which ends a call in progress, so keep them stable. |
| `createPorts: (binding) => CallEnginePorts` | Every port for a new engine, with the binding filled in ([§ The ports](#the-ports-a-host-must-provide)). It is called once per engine. |
| `holdSignalling?: () => release` | Open the signalling channel and keep it open while an engine lives. It is taken before the engine is made and released after the engine is disposed. |
| `holdScreen?: () => release` | Keep the screen awake from the ring until the call is over. A locked phone suspends the page, and the call with it. |

The ring's sound is not here. Read `snapshot.call.name === 'incoming'` and decide where it sounds: one tab, or
silent in a muted room.

### `AudioCallHost`: the screen and what it owns

It owns the elapsed time, the fold, «Answer» waiting for its own ring's answer, the closing beat, the focus and
the cues. The fold works per call: a new call opens unfolded. A folded call unfolds when the badge, a problem or
the blocked speaker appears or changes. A plain end closes itself after `CALL_CLOSING_MS`; a failure waits for
«Close». Focus goes back where it was when the call folds or ends.

| Prop | Contract |
| --- | --- |
| `engine: AudioCallEngine \| null` | `useAudioCall().engine`. Null: nothing is drawn. |
| `view: CallView \| null` | `useCallView(snapshot)`, called once in the component that keeps the host mounted. Null: nothing is drawn. |
| `name: string \| null` | The person the call was verified with (`view.verifiedUserId`), named as this room knows them. Before verification, the room's own name. Null: the screen says `unknownRoom`. Never a user id the server sent. |
| `t: CallScreenText` | `(key, vars?) => string` for every key in `CALL_SCREEN_TEXT_KEYS`. `dialog` takes `{ name }`. The `others.*` device kinds take `{ count }` and are plurals. |
| `icon: CallIconRenderer` | `(name, size, rotate?) => ReactNode`, an SVG element, for every name in `CALL_ICON_NAMES`. Sizes are 14 to 28 px. `rotate` is only ever 135: the red buttons draw the handset laid down. |
| `layer?: ComponentType<{ children }>` | The host's full-screen layer, above its pages. Absent: the screen renders where the host is mounted. |
| `lockHint?: boolean` | Say that locking the phone or leaving the app ends the call. True on a phone. |
| `quiet?: boolean` | No cues now, for example in quiet hours. |
| `cues?: { connected, ended, failed }` | Short sounds. `connected` plays when the call goes live. `ended` and `failed` play only for a call this device placed or answered: a ring that ended unanswered plays nothing. |
| `extra?: ReactNode` | A row of the host's own on a ring or a call, under the badge and above the buttons. It is never drawn on the end screen. |

`AudioCallScreen` is the pure render under it, with the same `view`, `name`, `t`, `icon` and `extra`. Its other
props are the values above, and every command is a callback. Use it directly for a harness or a picture.

### What the host's stylesheet provides

The screen imports `audio-call.css`, so it needs a bundler that handles CSS imports. That file draws only what
is the call's own. It stands on a full-screen dialog frame that the host's stylesheet provides, so the call looks
like the host's other full-screen calls.

- Classes: `.esc` (the full-screen column; the folded pill restyles it), `.esc__body`, `.esc__caller` (the stage
  kicker), `.esc__answers`, `.esc__btn` with `.esc__btn--done` (answer), `--snooze` (mute) and `--quiet` (close),
  `.esc__closing`, `.esc__silent` (the text button that turns the sound on), `.esc__hint` and `.esc--settled` (the
  end screen).
- Custom properties: `--esc-ink`, `--esc-dim`, `--esc-accent`, `--esc-line`, `--esc-card`, `--esc-gap` and
  `--esc-ceiling` (the top inset, clear of a notch). Also `--mantine-color-red-9`, the red of the end buttons,
  which `MantineProvider` defines.
- Keyframes: `esc-pulse` (the initial leans in while it rings).

While the pill is on screen, `PILL_CLEAR_VAR` (`--acall-pill-clear`) on `:root` says how far down it reaches, in
px. A page can start its content below that. `inCallScreen(element)` tells whether an element is in the screen or
the pill.

### `useCallEntry(conversationId, options)`: the way into a call

This hook decides whether «Call» can be pressed now in a chat. It returns `{ disabled, hint, start }`, or null when
the entry is not offered. Not offered, it asks for nothing: no permission read, no listener. The `hint` names a
`CallEntryHint` for the host to word.

| Option | Contract |
| --- | --- |
| `offered: boolean` | Calls are allowed for the account, and the room is one the server would ring. |
| `engine`, `snapshot` | From `useAudioCall()`. |
| `signalling: { isOpen(), onOpenChange(listener) }` | Whether the signalling channel is up, and its changes. It is listened to only while the entry is offered. |
| `onRefused: (key: CallRefusalKey) => void` | A refused start, with a key for the host to word. A refusal never reaches the call screen, because the call never began. A cancelled start calls nothing. |

## A host in this repository: the playground

The two-tab playground ([`demo/`](../../../demo/README.md#call-the-other-tab)) places a one-to-one call with the
pieces on this page and nothing of its own beyond its words, icons and frame:

- **Socket.** The relay's call channel, through `createRelayCallSocket`; the playground's compose file starts the
  relay with `RELAY_CALLS_ENABLED=true`. The adapter has no open event, so «Call» reads its `isOpen()` every half
  second while it listens.
- **ICE.** `all` with no servers when the page is on loopback; otherwise relay-only with no servers, so an answered
  call ends as `relay-unavailable` before any connection is tried. No STUN, no TURN. Only the page is checked: the
  page reaches the relay through its own server's `/relay` door, and the relay that server forwards to
  (`DEMO_RELAY_URL`) is not checked, so whoever runs it sees both addresses and every SDP.
- **Binding.** `callTag` / `callVerify` run in the page over a keyring of the playground's room (its MLS exporter
  for the call, at the epoch the tab holds), because the playground has no MLS worker. The binding still wipes
  `K` after each question.
- **Speaker.** `createAudioElementSpeaker()`. No cues: there is no ring sound.
- **Screen.** `AudioCallHost` in a fixed layer, with a small `esc*` frame stylesheet of its own
  (`demo/src/host/call-frame.css`), and «Call» through `useCallEntry` in a room of exactly two people.

Its smoke (`pnpm -F @masia/demo smoke:call`), run by hand against a running playground, places two calls between two
people in a real Chromium and checks that both reach the live call verified and named, that each side's received
audio grows while the call is live, and that a hang-up, by the caller in the first call and by the callee in the
second, shows a plain end on the other side within seconds and closes both screens by themselves. No test of this package runs the engine over the
channel yet.

## What is not here yet

- **Signalling for a host's own rules.** The relay's call channel (above) has no blocks, quiet hours, child
  protection or TURN. A host that needs them passes the `call:*` events over a channel of its own (the first host
  uses its chat socket).
- **TURN.** No credentials route. A host answers `iceServers` itself.
- **The screen's frame.** The `esc*` stylesheet the screen stands on is the host's. Without it the screen is
  unstyled ([§ What the host's stylesheet provides](#what-the-hosts-stylesheet-provides)).
- **The keyring.** The binding is here; the code that derives `K` from a live MLS room (the room's exporter at
  the epoch this device holds, and the members at that epoch) is the host's, behind `CallKeyring`.
- **Platforms.** The engine has been run in Chromium. Other browsers and phones have not been measured.
