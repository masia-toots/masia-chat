# Log: how the open messenger got here

A dated chronicle of decisions and steps, **newest first**, each as What / Why / Files / Decision / Next. It
is the "why" behind [`CHANGELOG.md`](CHANGELOG.md) (which lists releases only) and it never rewrites an old
entry. Step names (K0 to K14) are those of the working plan ([`protocol.md`](protocol.md)); the plan file itself
lives in the host project's private working space, so the entries below carry what it decided. The state today
is in [`context.md`](context.md). "Lead" is the AI session that plans and reviews; an "agent" does one step.
Entries are added at the top. Times are agent working time, not elapsed days.

## 2026-11-22 · The playground's call, after review

- **What.** The review of the playground's call found two claims that were stronger than the code. The ICE answer
  said it checked that "the page and the relay" are on loopback, but the relay's address as the page sees it is
  always the page's own `/relay` door, so only the page was ever checked; the answer now takes the page's address
  alone, and every document says plainly that the relay behind the door (`DEMO_RELAY_URL`) is not checked. The
  call smoke's hang-up step pressed «Close» on both screens for up to a minute, so a hang-up that never reached the
  other side (ending there as `lost` half a minute later) still passed; it now makes two calls, the first ended by
  the caller and the second by the callee, and each time the other side must show a plain "Call ended" with no
  problem line within five seconds and close its screen by itself, with «Close» never pressed. It also checks that
  each screen names the other person and that the received audio energy grows, not only packets and bytes.
  Smaller: a room's call key is refused unless its group is open on the tab; a test shows a tag made before a
  commit failing after it, and `fresh` catching the room up first; the call setup is made once per tab by
  `useState`; the fold button's backing is opaque; the README lists the call's known limits (six HTTP/1.1
  connections per browser, a refused token kept until the tab renews it, a stopped channel back only after a
  reload) and the exact loopback names. The relay changed under the call the same day, after its own second
  review: a call that only rings is still forgotten after 10 quiet minutes, but a connected one (the callee's
  `call:accept`, then the caller's `call:accepted`) keeps its place through 4 quiet hours, and a `call:end` either
  way is delivered and then closes it; the frame budget is per signed user and device, and a slow reader is cut off
  past 64 KiB unread. The sentences that said a hang-up after ten quiet minutes is dropped (the playground's
  README, `call-ports.ts`, `calls.md`, design 17 in `context.md`) now say this.
- **Why.** A smoke that cannot fail on the thing it names, and a security sentence the code does not back, are
  worse than neither.
- **Files.** `demo/src/host/call-ice.ts` (+ test) · `demo/src/host/call.tsx` · `demo/src/client/room.ts` ·
  `demo/src/client/runtime.test.ts` · `demo/smoke/two-people-call.ts` · `demo/src/host/call-frame.css` ·
  `demo/src/host/call-icons.tsx` · `demo/src/host/call-ports.ts` · `demo/README.md` · `calls.md` · `context.md` ·
  this log's entry below (its ICE decision corrected in place, as it had not left the branch).
- **Decision.** No check of the relay behind the door: the playground states what it does not check instead. The
  fold mark keeps pointing down, as the first host's does. The smoke reads the end through the screen that is
  already there (stage, closing words, problem line); the package's screen did not need a new attribute.
- **Checked.** 153 tests in 19 files; `smoke:call` against the changed relay with the switch on, both directions:
  each side about 100 audio packets in 2 seconds with growing energy, and a plain end on the other side within
  0.2 seconds of the hang-up.
- **Next.** The adapter's in-memory relay in this package's tests never closes a call on `call:end`. Made to, it
  shows two ends the changed relay now drops, harmlessly: a second `answered-elsewhere` to a device already told,
  and the second side's end when both sides close. Keeping "the adapter never sends what the relay drops" true is a
  change to the adapter, not to the test alone.

## 2026-11-22 · A call between the playground's two tabs

- **What.** The playground places a one-to-one audio call between its two tabs, on this package's pieces: the
  engine (`useAudioCallHost`), the call screen (`AudioCallHost`), «Call» (`useCallEntry`), the binding
  (`callTag` / `callVerify`) over a keyring of the playground's room, the plain `<audio>` speaker, and the relay's
  call channel as the socket. The playground adds its English words for every screen key, an inline icon for every
  icon name, a small `esc*` frame stylesheet, and an ICE answer of its own. Its server now streams an event
  stream through its `/relay` door instead of buffering it, and its compose file starts the relay with
  `RELAY_CALLS_ENABLED=true`. A Chromium smoke (`smoke:call`), run by hand against the running stack, places a
  call between two people and checks that the received audio grows on both sides and that a hang-up ends it on
  both.
- **Why.** The playground is the first outside consumer of the package, and a call that only the first host can
  place proves nothing about the open pieces. The two tabs on one machine are also the smallest honest setup for
  a call: no STUN, no TURN, nothing that is not in this repository.
- **Files.** `demo/src/host/call*.ts(x)` · `demo/src/host/call-frame.css` · `demo/src/client/room.ts` and
  `runtime.ts` (the room's call key) · `demo/src/Shell.tsx` · `demo/server/proxy.ts` · `demo/docker-compose.yml` ·
  `demo/smoke/` · `demo/README.md` · `calls.md` · `context.md` · the open repository's root `README.md`.
- **Decision.** ICE is `all` with no servers when the page is on loopback; anywhere else it is relay-only with no
  servers, so an answered call ends as `relay-unavailable` instead of handing each side the other's IP address.
  Only the page is checked: it reaches the relay through its own server's `/relay` door, and where that server
  forwards (`DEMO_RELAY_URL`) is not checked, so whoever runs that relay sees both addresses and every SDP. The binding runs in the page, since the playground has no MLS worker; the key is wiped after
  each question as in a worker. «Call» is offered only in a room of exactly two people. Every use of the relay
  adapter sits in one file (`demo/src/host/call-ports.ts`), imported by name. The wiring asks nothing of the relay
  beyond its admitted-call rule: the engine's order (ring, accept, then the SDP and the check) is exactly what the
  relay admits, and the hang-up of a call quiet for ten minutes, dropped there, ends the other side when its audio
  stops. Against a relay with the switch off, the stream's `404` stops the adapter for good and «Call» stays off
  with its hint. The README says what a call proves (the fingerprints bound to the chat's group) and what it does
  not protect (the relay sees the signalling, both IP addresses and the SDP; there are no rules on who may call).
  The adapter announces closes but not opens, so the playground reads `isOpen()` every half second while «Call»
  listens; the adapter was left as it is.
- **Checked.** `smoke:call` against the relay with the switch on, two isolated Chromium pages with a fake
  microphone: both live and verified, each side received 100 audio packets in 2 seconds, and the caller's hang-up
  closed both screens. With the switch off, each tab asked for its stream once (`404`) and «Call» stayed off with
  "The call channel is not connected".
- **Next.** An open event in the adapter would remove that poll; a test in this package that drives the engine
  itself over the channel.

## 2026-11-22 · The relay can carry call signals, opt-in, and a socket adapter uses it

- **What.** An instant, unstored call-signal channel in the relay (`GET /calls/stream`, server-sent events;
  `POST /calls/signal`, always an empty `202`), registered only with `RELAY_CALLS_ENABLED=true`; its vocabulary
  (`call-relay.ts`: routes, events, limits, `parseRelayCallSignal` and the stream parsers) in
  `@masia/contracts/wire`; its streams and budgets (`createCallChannel`) in `@masia/relay`; and
  `createRelayCallSocket` in `@masia/messenger/call`, the engine's socket port over the two routes.
- **Why.** The engine, its binding and its screen moved in the same day, but nothing in this repository could
  carry its signals, so no call could run without a host's own server.
- **Files.** `src/call/relay-socket.ts` · `../contracts/src/wire/call-relay.ts` · `../relay/src/call-channel.ts` ·
  `../../apps/relay/src/routes/calls.ts` · `../../apps/relay/src/domain/call-parties.ts` · `calls.md` ·
  `canon.md` · `context.md` · `ARCHITECTURE.md` · `../README.md`.
- **Decision.** Server-sent events down and a POST per signal up, on the server that already runs (design 17).
  A security review set the conditions before the code: `USER` devices of a two-person room only; the relay
  stamps the sender; the client pins its peer and drops a replayed ring; the same answer whether the target
  listens or not; a stream closes when its token expires and re-checks its device every minute; caps per device,
  per caller, per pair, per call and per stream; no token in a query string and no SDP in a log; off by default;
  no STUN. Rejected: a WebSocket (a new dependency, a second protocol to secure) and sealed mailbox messages (poll
  lag, stored call metadata). The operator of a relay with the switch on sees who calls whom, both addresses and
  every SDP, and applies no host rules; the docs say so.
- **Review of the build.** A code review found that a made-up call id bought a fresh set of per-call caps for
  every signal but a ring. Now a ring admits its call between the ringing and the rung device, any other signal
  passes only inside an admitted call (either way; otherwise dropped, still `202`), a call quiet for 10 minutes
  is forgotten, and every table the channel keeps has a hard ceiling, with a share per person for admitted calls.
  Also: the frame budget is spent before any database read; a stream's life is bounded by the token's own
  lifetime as well as its `exp`, and its timer never past what Node takes; `deliver` serialises before it looks
  for the stream; the adapter caps `Retry-After` at its backoff ceiling and `closesInMs` at the longest a token
  lives. Cost, accepted: the hang-up of a call silent for 10 minutes no longer reaches the other end, which ends
  the call when the audio stops.
- **Next.** A call between the playground's two tabs over the channel, on the package's call screen, with its ICE
  answer (every candidate only on loopback, relay-only otherwise); a test that drives the engine itself over it.

## 2026-11-22 · The call screen and its hooks move into the open packages

- **What.** The first host's one-to-one call screen moved in behind a new door, `@masia/messenger/call/react`.
  It brings the pure render (`AudioCallScreen` with `audio-call.css`), the host component that owns the timers,
  the fold, the focus and the cues (`AudioCallHost`), the engine hooks (`useAudioCallHost`, `useAudioCall`), the
  way into a call (`useCallEntry`), and the pure readings under them (`call-view`, `call-entry`). A plain
  `<audio>` speaker came with them (`@masia/messenger/call/browser-speaker`). The host passes in the words
  (`CALL_SCREEN_TEXT_KEYS`), the icons (`CALL_ICON_NAMES`), its layer, its ports, its signalling hold and the cues.
- **Why.** The playground is to mount the same screen as the first host. The screen used no UI kit component, only
  its own CSS and the host's full-screen frame classes, so it could move as it is.
- **Files.** `src/call/react/` · `src/call/browser-speaker.ts` · `package.json` (two exports) · `calls.md` §
  The call screen · `context.md`.
- **Decision.** A move with no change of behaviour: the first host draws the same pixels through thin wrappers.
  What stays with the host: the ring's sound, the room directory, the push plumbing, its audio-bus speaker and
  the frame stylesheet (`esc*`). An open `extra` slot takes the host's own row (for an assistant in the call);
  nothing fills it yet.
- **Next.** The playground mounts the screen with a frame stylesheet of its own.

## 2026-11-22 · The call binding and the engine's own suites move in

- **What.** The call binding (`callTag` / `callVerify`, `src/call/call-binding.ts`) moved in from the first host,
  where it runs inside the MLS Worker, with the engine's own suites (`call-engine.test.ts`,
  `call-engine-tracks.test.ts`, `call-engine-support.ts`) and the binding's suites on a fixed keyring (who the peer
  may be, the badge). It is exported from `@masia/messenger/call` and from its own door,
  `@masia/messenger/call/call-binding`, so a worker can load it without the engine.
- **Why.** The engine's suites drive the real binding, so neither could move without the other, and a binding
  that only the first host had left the open repository with an engine it could not test end to end.
- **Files.** `src/call/call-binding.ts` · `src/call/index.ts` · `src/call/__tests__/` · `package.json` (the door) ·
  `calls.md` · `context.md`.
- **Decision.** A move with no change of behaviour; history follows the files (`git mv`). Two spellings changed
  because the package may not import the host: a refusal throws the package's own `CallBindingError` (`INVALID`),
  which the first host maps back onto its own worker error, and a room member is typed as the package's
  `DeviceIdentity` (the same `userId`, `deviceId`, `role`). The keyring that derives the call key from a live
  room, and the binding's tests over a real room and a real Worker port, stay with the host.
- **Next.** The call screen into the package, then signals through the relay and a call between the playground's
  two tabs (context, next step 5).

## 2026-11-22 · The one-to-one audio call engine moves into the open packages

- **What.** The host-neutral part of the first host's one-to-one audio call moved in: the engine
  (`createAudioCallEngine(ports)`), its state machine, the SDP checks, browser adapters for the peer connection
  and the microphone, and the binding port's types, behind a new door `@masia/messenger/call`; the
  `call:*` wire contract and the verification tag into `@masia/contracts/wire`. The machine, SDP, wire and browser-adapter tests moved with them; the engine's own suites and the speaker
  adapter stayed in the first host. A
  new page, [`calls.md`](calls.md), says what the engine guarantees and which ports a host must provide.
- **Why.** The calls work in the first host, and the engine was already written on ports with no framework, so
  it could be moved as it is. The repository's README said calls were not here.
- **Files.** `src/call/` · `src/state-machine/` · `../contracts/src/wire/` · `calls.md` · `context.md` ·
  `ARCHITECTURE.md` · `../README.md`.
- **Decision.** A move with no change of behaviour. Signalling, TURN credentials, the binding to a live MLS room,
  the call screen and the rules on who may call whom stay with the host. Signalling through the relay was not
  taken: the first host's decision record rejected it (ringing would lag by the relay's poll interval, and a live
  channel is a second realtime transport to secure), and changing that needs a decision record of its own.
- **Next.** Signals through the relay, a call between the playground's two tabs, and a call screen in the
  package, after that decision and a security review (context, next step 5).

## 2026-11-20 · The state page is brought up to date with the code

- **What.** `context.md` rewritten from "State as of 2026-11-07" to 2026-11-20, every line checked against the
  code and a test run of the day: contracts 661 tests, the client 879 (and 19 interop scenarios, run again: 19
  of 19 pass), the relay library 91, the relay server 505 against a real Postgres, the playground 133;
  `pnpm boundary` cruised 390 modules and found no violation. The state table now covers the outbox, the
  server-owned unread number, the picture rule with the host's viewer and swipe, the contact strip of other
  families, the identity-key transfer with the operator's reset, the Masia add rule and the relay's
  guardian-removal rule. Chosen design records 12 to 15 added; the next-steps table and the list of what comes
  after it rewritten; the open questions A to D kept as they were.
- **Why.** The open set moved a good deal after 2026-11-07 and the page had stopped saying so: it still said
  that a room another device joins stays pending until enrolment is built (enrolment has been built since
  2026-10-10) and that key-package claims are neither consumed nor expired. The repository is about to be shown
  again, and this is the page a reader opens second.
- **Files.** `context.md` · `log.md`.
- **Decision.** Rewritten, not appended; the chronology stays here. The commits since 2026-11-07 that have no
  entry of their own (the contact strip of other families, the picture pager and the reply swipe, `data-chat-pane`,
  the identity transfer and the operator's reset) are recorded in the state table and in designs 14 and 15 and
  are not back-filled as dated entries. K7 (the purge) and K8 (the one switch) are not claimed done: this folder
  records neither. Calls are said to be outside the open set, with nothing decided about moving them in.
- **Next.** Three docs lag behind the code and are separate edits: [canon section 3](canon.md#3-devices) and
  [`CHANGELOG.md`](CHANGELOG.md) do not describe the identity transfer and the operator's reset (or the picture
  pager and the reply swipe), and this package's README still lists linking a new device as open.

## 2026-11-20 · Opening a chat reads it, even when the newest line is my own

- **What.** (1) `ui/conversation/messenger-chat-view.tsx`: the view sends `msg:read` up to the newest message
  the server holds (`isUnconfirmedMessage` skips a row still on its way), whoever wrote it; it used to read only
  when the newest message was someone else's. (2) `hooks/use-messenger.ts`: a `msg:read` receipt that flips no
  status keeps the same message list.
- **Why.** In an end-to-end encrypted room the host named a read instant that fell a few hundred milliseconds
  short of the server's row for the newest message, so that row stayed unread. Once the reader replied, their
  own line was the newest and no read was ever sent again: an unread badge that opening the chat never cleared.
  The host now names the server's time; this change makes a missed read heal on the next open. Because both
  sides of an open chat now read, a receipt that changes nothing must not produce a new list: the new list
  would make the view read again, and that read is the other side's receipt (two open chats would bounce reads).
- **Files.** `ui/conversation/messenger-chat-view.tsx` · `hooks/use-messenger.ts` · their tests.
- **Decision.** `upTo` stays an instant of the server's rows; naming the right instant for an encrypted room is
  the host's job (it holds both the relay's and the server's rows), not the protocol's.
- **Next.** None.

## 2026-11-18 · One set of outbox rules, for the host's assistant chat too

- **What.** (1) `hooks/outbox-rules.ts`: the rules moved out of `messenger-outbox.ts` and made generic over the
  entry and the history row (`settleOutboxEntries` with `OutboxHistoryRules { sentAt, shows, rowId, rowAt }`,
  `failWaitingEntries`, `weaveOutboxRows`); `settleOutboxWithHistory` and `withOutboxRows` call them, with the
  same behaviour. (2) `ui/conversation/unsent-row.tsx`: the bubble's "not sent" strip as its own component,
  used by the bubble and exported.
- **Why.** The host's chat with its assistant has its own send path and lost messages the same way (a frame
  dropped while no socket was open, a row replaced by a history load). It now keeps an outbox in the same store
  under these rules; a second copy of the rules would drift from the first.
- **Files.** `hooks/{outbox-rules.ts,messenger-outbox.ts,index.ts}` · `ui/conversation/{unsent-row.tsx,bubble.tsx,index.ts}`.
- **Decision.** The rules take the outbox's own row shape through four small functions instead of a common row
  type: the two chats' rows differ (a sender id and `createdAt` here, a role and a timestamp there), and the
  rules need only a time, an id and "is this row my entry". `PENDING_MESSAGE_ID_PREFIX`, the size cap and the
  clock-skew window moved with them and are re-exported where they were.
- **Next.** A turn id carried by the frame and returned by the echo and by every refusal would make matching
  exact; that is the host server's change.

## 2026-11-17 · A line that never left outlives the screen (the outbox)

- **What.** (1) `hooks/outbox-store.ts`: a generic subscriber store of per-address lists (`createOutboxStore`,
  `OutboxStorage`, `browserOutboxStorage`), memory or a Web Storage subset, every storage access wrapped.
  (2) `hooks/messenger-outbox.ts`: the plaintext outbox on it, written per account and conversation
  (`MESSENGER_OUTBOX_KEY_PREFIX`, `OUTBOX_STATE` `sending | unconfirmed | failed`, a size cap past which an
  entry stays in memory). (3) `useMessenger` reads it through `useSyncExternalStore` (option `outbox`, default
  `sharedMessengerOutbox()`): every send, text included, puts an entry and shows its row at once; the echo
  (`msg:sent` or my own `msg:new`, either order) removes it; a dropped link marks waiting entries failed; the
  next history page drops an entry it shows and fails one it should show but does not. `deleteMessage` on a
  pending id discards locally and sends nothing. (4) The bubble's "not sent" strip has Retry and Delete; an
  unconfirmed row's menu is Copy only and has no reactions. (5) `MessengerChatViewProps.composerBlock`: a host
  line in place of the composer.
- **Why.** Two reports from testers. A message refused in an encrypted room showed "not sent" and was gone
  after a tab switch: the refusal lived in the screen's state. Sent messages "randomly disappeared": a text
  had no row until its echo, so a frame the server dropped without a word (or a link that was not open) left
  nothing on screen, and a failed row died with the screen too.
- **Files.** `hooks/{outbox-store.ts,messenger-outbox.ts,use-messenger.ts,index.ts}` ·
  `hooks/__tests__/use-messenger.test.ts` · `ui/conversation/{bubble.tsx,messenger-chat-view.tsx,messenger-chat-view.css}`
  · `ui/conversation/__tests__/messenger-chat-view.test.tsx`.
- **Decision.** The store is generic and the encrypted host builds its own on it with `storage: null`: plaintext
  of an encrypted room never goes to browser storage, so its line survives the screen but not a reload until the
  host's secure store holds it. Failed rows are woven in by time, waiting rows stay at the end: a waiting row
  carries the device's clock and the server's rows the server's, and weaving by time let two quick messages swap
  places while the first was confirmed. History matching uses kind, words, reply and a 30 s clock-skew window,
  one row per entry, and never matches a refused entry (it cannot have arrived).
- **Next.** The encrypted outbox across a reload (host secure store). The assistant chat has its own send path
  and the same class of loss; it is not this package's hook.

## 2026-11-15 · The thread lets the host draw its own service rows

- **What.** `MessengerChatViewProps.renderServiceRow?: (row: ServiceRowProps) => ReactNode | undefined`, with
  `ServiceRowProps { message, isOwn }` (exported). The view asks it about each `SYSTEM` message only; a node
  replaces the bubble, `undefined` keeps it. `P2PChatBody` passes it through like every other view prop.
- **Why.** The host's 1:1 audio call writes a missed-call row (a `SYSTEM` row with a code, worded by the host).
  As a bubble it reads like a message the other person typed; the host wants a compact line with a "call back"
  action, and the vocabulary of calls is the host's, not this package's.
- **Files.** `ui/conversation/{messenger-chat-view.tsx,index.ts}` · `ui/conversation/__tests__/messenger-chat-view.test.tsx`
  (1 new test).
- **Decision.** A render prop on the view, not a new slot in `MessengerUiSlots`: it answers per row and may
  decline, which a component slot cannot say, and only the conversation view has rows. Nothing else changes for
  a host that does not pass it.

## 2026-11-07 · A message that never left says so, and can be sent again

- **What.** (1) `MessengerMessage.sendFailed?: boolean` (`protocol/messages.ts`) — this message is mine and it
  never left. (2) `UseMessengerReturn.retrySend(messageId)` — send that row again. (3) `useMessenger` now
  **waits for the answer** to every `msg:send`: it builds the row before posting, and on a refusal keeps it in
  the thread marked `sendFailed` (held in an unsent map, keyed by the row id the view shows) instead of letting
  the words disappear; a pending row that failed is never the one a later echo reconciles, so it keeps its place
  while other messages arrive. Pending ids carry a counter, so two sends in one millisecond cannot share one.
  (4) `Bubble` draws the state: the words stay, "not sent" in plain language next to them, the retry a real
  touch target, and no delivery tick on a row that never left. (5) Two i18n keys, `chat.notSent` and
  `chat.retrySend` (the port's `MessengerI18nKey`, the fake, the host adapter).
- **Why.** The plaintext hook posted a text message and never looked at the answer: nothing was drawn until the
  server echoed the row, so a refused send, or one into a dead socket, left an empty thread and an empty
  composer — indistinguishable from never having typed. In a private room, reported from the field, that reads
  as "messages are not being sent". The encrypted path had the mirror image of the same bug in the host: its
  catch **removed** the pending bubble. The rule is now in the canon: a line somebody typed is never lost in
  silence.
- **Files.** `protocol/messages.ts` · `hooks/use-messenger.ts` · `ui/conversation/{bubble.tsx,messenger-chat-view.tsx,messenger-chat-view.css}` ·
  `../contracts/src/ports/i18n-bundle.ts` · `../contracts/src/fakes/fake-i18n-bundle.ts` ·
  `hooks/__tests__/use-messenger.test.ts` (5 new tests).
- **Decision.** The failed row **stays where it was written** rather than moving to a tray: a message out of
  its place in the thread is a second thing to understand. The retry is the same command again, not a new
  message, so a send the host actually took (and whose answer we lost) cannot become a duplicate with a new id.
  The bubble carries no error code — the room's state belongs to the security strip, which already words it.
- **Next.** The host's encrypted hook now marks refusals the same way; a failed row does not yet survive a
  reload (the unsent map lives in the hook), which is the next step if the field asks for it.

## 2026-11-07 · The unread number is the server's: one live event, two more preview fields

- **What.** (1) A new server event, `unread:update { conversationId, unreadCount, unreadMentions }`
  (`protocol/events.ts`, in the `MsgServerEvent` union), filed under its own topic `UNREAD_EVENT_TOPIC`
  (`'unread:'`, `protocol/codec.ts`) and known to `parseMsgServerEvent`. (2) `MessengerConversationPreview` gained
  `unreadMentions: number` (the part of `unreadCount` that calls the reader) and `mutedUntil: string | null` (the
  reader's own mute). (3) Tests: the event round-trips and sits under its own topic, not the conversation one.
- **Why.** A count a client derives from the messages it happened to receive drifts the moment a second device,
  a read on another screen or a reconnect is involved. The host owns the number and says it after every delivery
  and every read; the client applies it and never adds. The event is not about one open room, so it must not
  share the conversation topic: a client with no room open still needs it.
- **Files.** `protocol/{events.ts,codec.ts,conversations.ts,index.ts}` · `protocol/__tests__/codec.test.ts`.
- **Decision.** The numbers are absolute, not a delta. `unreadMentions <= unreadCount` always. Muting changes
  neither (it is a display rule). The package only types and routes the event; what counts as a mention is the
  host's rule, so the package carries no copy of it.
- **Next.** The view consumes the event and shows the badge (a later step).

## 2026-11-06 · The sender's face and colour in the thread; one participant list

- **What.** (1) `Participant` (`ui/provider/slots.ts`: `{ id, name, avatarUrl?, color?, tag? }`) is the view's one list
  of the room's people; `MentionCandidate` is now `Participant & { tag: string }`, and `isMentionCandidate` is the filter
  `buildMentionCandidates` applies — a person without a `tag` has a face and a colour but is never a chip or a completion
  row. (2) The view hands each bubble its `sender` and `showAvatar` (the first bubble of someone else's run, in a group
  as in a 1:1). (3) `Bubble`: the sender's picture, or an initial on their colour, in a 28 px column at the left
  (`.hub-msg-avatar`; later bubbles of the run keep the column, `.hub-msg-avatar-gap`, so the text lines up); the
  sender's colour as ONE custom property on the row (`--sender-color`), read by the sender name and by a 3 px left edge
  of the bubble (`.hub-msg--edged`; never on a sticker, never on an own bubble, the same colour in light and dark); the
  bubble background is not tinted. The wire type `ParticipantPreview` gained `accentColor?` so a host can carry the
  stored choice. (4) Tests: the bubble (six cases: initial · picture · gap on later bubbles · never own · sticker keeps
  the face, not the edge · an unknown sender gets neither), the view (faces once per run, colours per row, a tag-less
  participant is not a chip, 1:1 draws the edge without the name), the filter.
- **Why.** The host's decision record on chat message intents, section 8: an avatar on the first message of a run, the
  sender's name and a thin edge in the person's colour. One list for faces and mentions, or the two drift; the colour
  rule (a palette, a default from the id, a stored choice) is the host's and stays there — the package draws a CSS
  colour it is given.
- **Files.** `ui/provider/slots.ts` · `ui/conversation/{bubble.tsx,messenger-chat-view.tsx,messenger-chat-view.css,
  mention-candidates.ts,index.ts}` · `ui/provider/index.ts` · `protocol/conversations.ts` · the three test files.
- **Decision.** The custom property sits on the ROW, not the bubble, because the avatar beside the bubble reads it
  too; the edge is a class (`hub-msg--edged`) so a sticker's transparent bubble can keep the face and drop the edge
  without a second property. The avatar is `aria-hidden`: the name row (or the room header in a 1:1) already says who.
- **Next.** The thread still has no system-row slot; a picture that fails to load shows a broken image rather than the
  initial (the host's own chip falls back — the same fallback here is a small follow-up).

## 2026-11-06 · @-mentions in the composer and the thread, by candidate list

- **What.** (1) A new field on the composer port, `mentionCandidates` (`{ id, tag, name, avatarUrl? }`): who `@` may
  complete to. The package never parses the host's handle grammar; it matches the list it is given, so a row or a
  chip exists only for a real participant. (2) `useMentionPopover` (one hook for the package's slim composer and a
  host's richer one): open while the caret sits in an `@…` token with a match, ↑/↓ move, Enter/Tab insert `@tag `
  with the caret after it, Esc hides the list until the token changes, a tap inserts; the pure half
  (`activeMentionToken`, `insertMention`, `filterMentionCandidates`: prefix of the tag or of any word of the name,
  case- and diacritics-insensitive, six rows) is tested on its own. (3) `MentionPopover`: a listbox above the
  composer (`bottom: 100%` of a positioned parent, so it stays above the on-screen keyboard the composer already
  clears), picture or initial, name, `@tag`, `aria-activedescendant` on the box. (4) `renderMentions` draws a chip
  for a candidate's tag in a bubble (`is-me` when it names the reader; an address like `a@b.c` is left alone);
  `buildMentionCandidates` turns the view's new `participants` and `masiaCanBeCalled` props into the two lists
  (chips: everyone; composer: everyone but me; the assistant first when the host says she can be called).
  Two words joined the port: the list's name and the assistant's display name.
- **Why.** A mention is a text token and nothing else is stored; the grammar has one home in the host, and the push
  for a mention is the host's job. The package's part is the completion and the chip, both from a list the host owns.
- **Files.** `ui/provider/slots.ts`; `ui/composer/{mention-token,use-mention-popover,mention-popover}`; `ui/conversation/
  {render-mentions,mention-candidates}`; small additive edits in `composer.tsx`, `bubble.tsx`, `messenger-chat-view.tsx`;
  `MESSENGER_I18N_KEYS` and the fake bundle in the contracts.
- **Decision.** Chips mark everyone with a handle, me included, so «mentioned me» can look different; the composer
  offers everyone but me. In my own bubble the chip keeps the bubble's text colour as a pill (the accent on the
  accent gradient would vanish). An empty match list closes the popover rather than showing a hint row.
- **Next.** The host's push category for a mention and the on-call's handle are the host's steps; a «mentioned me»
  badge needs a stored column and is out of scope.
## 2026-11-06 · Reply, one intent strip, server-filled quotes, ArrowUp recalls my last message

- **What.** (1) A **reply** intent: Reply is the first `⋮` row of any message that is not deleted; the strip above
  the composer says who is being answered and quotes them; the send carries `replyToId`; pictures, stickers and
  dictation stay on (an edit still turns them off). (2) The `editing` state became one `intent` (`reply | edit`)
  drawn by one `IntentStrip`; ✕ and Esc cancel. (3) The `⋮` rows come from one builder, `messageActionRows`
  (`@masia/messenger/ui`), so a host bubble can use the same list. (4) `replyToPreview` gained `deleted?`; the
  wire's `msg:new` carries it; the view fills a missing preview from the loaded list (`withReplyPreviews`), words
  a deleted parent and never quotes it, and a tap on the quote scrolls to the parent (`data-msg-id`) with a
  1.2 s flash that respects reduced motion. (5) `ComposerSlotProps.onRecallLast`: ArrowUp in an empty draft; the
  view resolves the last own text message (not a sticker, not deleted) and opens its edit, caret at the end.
  Three new words (`chat.reply`, `chat.replyingTo`, `chat.replyDeleted`).
- **Why.** `replyToId` was on the schema, the events and the bubble for months, and nothing sent one; the
  menu rows were built inline in the bubble and a second copy was about to appear in a host. One state, one row
  builder, one preview mapper (server side) was the cheapest shape that could not drift.
- **Files.** `ui/conversation/{message-actions,reply-preview}.ts`, `intent-strip.tsx`, `bubble.tsx`,
  `messenger-chat-view.{tsx,css}`, `ui/composer/composer.tsx`, `ui/provider/slots.ts`, `protocol/{messages,events}.ts`,
  `hooks/use-messenger.ts`; the contracts' key list and fake; the tests beside each.
- **Decision.** The composer reports the key and the view picks the message (a slot owns no messages). The
  server fills the quote and the client only falls back (a client-only quote breaks on a history page whose
  parent is not loaded; a denormalised copy of the parent text would outlive an edit). The Reply row reuses the
  `back` glyph, a return arrow, instead of growing the closed icon list. The text cap of the quote lives on the
  server only; the bubble ellipsises, so the client needs no second number.
- **Next.** The host's assistant-chat bubble imports `messageActionRows` and gains re-ask on edit (the host's
  own step); mentions as text tokens with a candidate list through the composer slot.
## 2026-11-03 · The first cut is pushed: one commit, to a private repository

- **What.** (1) The first cut of the open set was assembled with `tools/open-split/assemble.mjs` from one committed
  revision of the host and pushed as ONE commit, "Open Masia messenger: initial cut" (`d39915d`, authored by the
  lead maintainer of `MAINTAINERS.md`), to a PRIVATE repository of the project's GitHub organisation, branch `main`.
  The organisation carries the company's legal name; the domain is only the domain. Nothing is public: the
  visibility change is a separate decision of the founders. (2) The cut was checked where it lives: install 17 s,
  typecheck 11 s, test 264 s, lint 16 s, `docs:check` 1 s, all green; the repository's own CI (its workflow plus
  the secret-scan job) ran green on GitHub; and in `demo/` `docker compose up --build` brought the relay's
  database, the relay and the web client up healthy, two browser tabs (two people) sent one message each way, and
  the playground showed its "Text is encrypted" badge; `docker compose down -v` left nothing behind.
- **Why.** One commit, not the history. The scan of the set's history before the cut (71 commits, two identities,
  both the founder's) found no real secret: the secret scanner's 232 hits are RFC 9420 test vectors and public
  keys, and the other scanner's only find is a development database default. It did find private traces in the
  messages and in old file versions: the agent session trailer on 65 commits, the private working environment's
  paths and the production domain in 56 messages, a family member's name used as test data. No history rewriter was
  at hand, and a free-text message cannot be proven clean; a cut with no history can.
- **Files.** `docs/log.md`. The cut's own code is the K14 tooling (`tools/open-split/`); the push changed no file
  here.
- **Decision.** The K14 default, one commit, is now the decision; rewriting the history is rejected. The history
  scan keeps exiting 1 on the host's own history of the set when run with `--strict`: that is expected, it measures
  what a cut with history would have carried. It is run again, with the secret scan, as a gate before the
  visibility change. One security gate is open on the host's side, not in this repository: the host's own
  development database credentials were echoed by the relay's development defaults. The assembly now rewrites
  those defaults to a neutral `postgresql://relay@localhost` address, and the host rotates the credentials in
  question and re-checks its exposure before the visibility change.
- **Next.** The mailbox of the security address must accept mail before the first public day; the host-side gate
  above; a last run of the history scan and the secret scan on the commit that goes public; then the founders'
  call on visibility.

## 2026-11-03 · Before publishing: the README says what is built, and the founders' contacts are filled in

- **What.** (1) The README no longer says the MLS core and the UI core are "not built yet": both are, and so is
  the host's secure storage; it now lists what is built, what a host provides (ten ports, the relay token, the
  engine's runtime) and what is open. `context.md` follows. (2) `MAINTAINERS.md` and `demo/contacts.json` carry
  the decision of the founders: one public maintainer (the lead, with the project's mail address and GitHub
  organisation), the co-founder named without any contact, security reports to a dedicated address. The playground's
  test now compares names as well as mail and GitHub, and the "stub" marker is gone. (3) `docs:check` also reads
  the contracts, the relay package and the relay server.
- **Why.** The first thing a stranger reads is the README, and it understated the code; a contact table full of
  `TBD` is not publishable.
- **Files.** `README.md`, `docs/context.md`, `docs/log.md`, `scripts/docs-check.mjs` and its test; at the repository root
  `MAINTAINERS.md`, `demo/contacts.json`, `demo/src/guardrails.test.ts`.
- **Decision.** The room runtime stays outside the package for now and the README says so; it is listed as
  the next step rather than described as part of the package.
- **Next.** The publication gate, as in the K14 entry below; a security address that receives mail before the
  first public day, and the open repository's `SECURITY.md` pointing at it.

## 2026-11-03 · The Android app's Worker could not reach the relay; its relay requests now go through the page

- **What.** On the Android app the Worker's own `fetch` to the relay never left the WebView: the native shell
  serves the app from an `https://` origin that is the relay's host and answers every request of that origin
  with a bundled file, so the relay client was handed the app's `index.html` instead of JSON and reported the
  relay unreachable; the app never registered a device, while the same person's browser did in seconds. The
  host's Worker protocol gained `network: 'page'` in `init` and a `relay.fetch` call the page answers with its
  own (bridged) `fetch`; the Worker rebuilds the `Response` (status, `retry-after`, body) for its relay client,
  and a failed page call is a network failure to it. The web and iOS keep the Worker's own `fetch`.
- **Why.** Section 11 said the page holds nothing of the relay's traffic; on the Android app that was not
  true, and a messenger that cannot enrol a phone is not a messenger.
- **Files.** `docs/canon.md` (section 11, honest limits). The code is the host's (its Worker protocol, server,
  client and their tests); nothing in `src/`.
- **Decision.** State the limit instead of hiding it: on the Android app the relay token and the bytes the
  relay sees anyway (ciphertexts, commits, public key packages, signed lists) pass the page's memory; keys and
  group states still do not. The same native Worker bridge that would keep the stored state out of the page
  is the target that closes this too. Rejected: making the shell let the relay path through to the network
  (a `WebResourceRequest` carries no body, so a POST cannot go that way), and moving the engine into the page
  on Android (that gives up the engine's isolation to fix a transport).
- **Next.** A device run on an Android phone; then the native Worker bridge, when a host takes it on.

## 2026-11-03 · K14: the open repository is assembled outside this one, not yet published

- **What.** (1) An editorial pass over the four files the dry-run flagged: the boundary test no longer spells the
  host's private paths (it derives its probes from the workspace file and the manifests on disk, and now runs in
  both repositories: 168 probes beside the host's apps, 23 beside the playground alone); the relay's CORS test and
  config name `capacitor://localhost` and the host's shell, not the production host; the devices card's CSS names
  the host's form-factor rule in words. (2) The open repository's root lives in `tools/open-split/scaffold/`: its
  `package.json` (one workspace, the `ts-mls` patch declared, the packages' own `lint` gates), `pnpm-workspace.yaml`,
  an `eslint.config.js` that carries the same allowlist boundary, an open `vitest.shared.ts`, `.gitignore`,
  `README.md` and `SECURITY.md` (report by mail to the lead maintainer with a `SECURITY` subject; 3 and 10 working
  days; 90 days to disclosure; no bounty; deployments by others, the maintainers' product included, out of scope).
  (3) `tools/open-split/assemble.mjs` builds the open repository into a directory OUTSIDE this one: the committed
  set from `git archive`, the scaffold on top, `tsconfig.base.json` / `.nvmrc` / prettier config copied, every
  written file re-scanned for forbidden tokens, `pnpm install` there over the host's lockfile (pnpm prunes it to the
  open workspace, so every version stays the one the host tests against), one initial
  commit on `main` authored by the lead maintainer of `MAINTAINERS.md`, then typecheck / test / lint / docs:check.
  (4) `tools/open-split/history-scan.mjs` runs the same token rules over every past revision of the set, every
  commit message and every author or committer identity, and prints counts only. (5) The dry-run's SCAFFOLD
  section now knows what the scaffold, the host's root copies and the assembly provide, and `--strict` fails on a
  gap; `docs:check` reads the scaffold's docs with their links resolved from the open root.
- **Why.** The founder's word on 2026-11-03 was «prepare the cut, publication on my word»: everything up to the
  push, nothing of the push. A cut that is built by one command from a committed revision, outside the host, is
  reproducible and leaves nothing to assemble by hand on the day.
- **Files.** `tools/open-split/{dry-run,assemble,history-scan}.mjs` with tests and `scaffold/`; the contracts'
  boundary test; the relay's `config.ts` and `cors.test.ts`; `devices-card.css`; the messenger's `docs-check.mjs`;
  the host's root lint config (`demo/` joined the relative-climb group).
- **Decision.** The history is NOT rewritten here. The scan of 47 commits says the set's past carries hits in
  14 file versions, 44 of 47 commit messages and both identity strings; a one-commit cut (the assembly's default)
  carries none. History or one commit is the founders' call at the publication gate, with the scan on the table.
  The production relay needs no change: its allowed origins come from the host's launcher, outside the set.
- **Next.** The publication gate: organisation and name, history or one commit, the `TODO(founder)` contacts in
  `MAINTAINERS.md` and `demo/contacts.json`, a CI workflow for the open repository (none in the scaffold yet), and
  the `docker compose` smoke of the playground on a machine that has Docker (this one had none).

## 2026-10-11 · AD: the hub takes the relay's two new contracts, and the assistant's device list joins the one format

- **What.** (1) A second device learns the person's pinned identity key from the relay's own refusal (the 409
  `IDENTITY_KEY_CHANGED` carries it), registers again under it and ends in "needs approval" with its code; the test
  relay now answers the way the real one does. (2) A KeyPackage claim names the devices it wants (`deviceIds`,
  never an empty list): the hub asks only for the devices the tree lacks, and for the assistant only for the
  device the verified operator list names for this room, so adding her to one room no longer spends the
  packages of her other rooms. (3) The hub's device label is cut to the contract's `MAX_DEVICE_TEXT_LENGTH`, not
  to a number of its own. (4) The assistant's custody worker signs its operator list in `mls-device-list/v1`
  (each entry's `conversationId` inside the signed bytes) and reads every list, hers and the people's, with
  `verifyDeviceList` under a pinned key; its provisional format and its own verifier are gone, with no
  transition code.
- **Why.** Without (4) a hub could never believe the assistant's list: the two formats signed different bytes.
  (1) to (3) were what the relay's new contracts left for the hub to adopt.
- **Files.** The hub host's E2EE folder (`relay-client`, `room-enrollment`, `device-label`, the test relay), the
  custody worker's `operator-list`, `directory` and `relay-client`; canon section 3.
- **Decision.** The operator's key is the pin of the operator's list, seeded in the worker from its own vault and
  never learned from the relay. `identity-key-unavailable` stays, as a state for a relay that breaks the 409
  contract only.
- **Next.** The relay pins an identity key only for USER devices, so a hub cannot yet read the operator's key from
  it (docs/TODO.md 518); until that is decided a real hub cannot verify her list. One signed list holds at most
  64 entries (517).

## 2026-10-10 · W3c: the hub enrols devices, enters rooms, announces reliably, writes less per message

- **What.** (1) The hub's Worker now does what the canon described: one identity key per person on the first
  device (`mls/<userId>/identity`), device registration (`POST /devices` with `identityKeyPub`), a KeyPackage pool
  (kept at 6 or more, topped up to 16), the signed device list (`POST /users/me/device-list`), and a 16-digit code
  that a new device shows and an existing one types (`@masia/messenger/mls` `approval-code.ts`). A refusal is a
  named state (`identity-key-changed`, `device-key-lost`, `device-not-yours`, `device-revoked`,
  `identity-key-unavailable`), never a loop. (2) The directory reads the relay (pin from `GET /users/{id}/devices`,
  rows from `…/device-list/versions`, each through `verifyDeviceList`). (3) Rooms: the creator records the group
  at the api (`PUT …/mls-group`) and opens it on the relay, members join by Welcome from the Welcome's own cursor,
  and add the devices that are on a verified list; Masia's custody device is added by the room's mode. (4) An
  announce outbox per room, so the api hears of a message the relay took even when the page closed in between;
  unsent messages survive `REJOIN_NEEDED` as drafts. (5) A room banner and an "Add a device" dialog in ua, en, de.
  (6) H5: a state snapshot every 16 messages and on epoch changes, a small journal between, history in segments of
  100.
- **Why.** The step after the relay contracts of R2-A2: without it no hub could make or join a real room.
- **Files.** the hub host's E2EE folder (`device-enrolment`, `room-enrollment`, `session-enrolment`, `directory`,
  `key-package-pool`, `identity-store`, `announce-outbox`, `history-store`, `room-record`, `E2eeRoomBanner`),
  `src/mls/{approval-code,treeHash,welcomeAddressedTo}`, `hooks/use-messenger.ts`, canon sections 3, 9.7, 10, 11.
- **Decision.** Snapshot window 16, not 32 (lead): at most 16 read messages' keys wait in the stored state.
  The Android StrongBox wrapping-key split is not built (mobile lane).
- **Next.** A relay contract for the second device's pin read (docs/TODO.md 507); the trigger for re-adding a
  stalled device (511); a live run of K8 end to end.

## 2026-10-10 · K10b, the playground: one command, two tabs, a real relay

- **What.** (1) `demo/` (Apache-2.0): `docker compose up --build`, then two tabs are two people chatting
  end to end encrypted through a relay on the visitor's machine (the relay built from `apps/relay`, its own
  Postgres). The page is the UI core with a thin host adapter and a small token issuer that uses the relay's
  own vocabulary from `@masia/contracts/wire`; the token key is generated when the stack starts, so no
  secret is in the repository. (2) `ContactsDirectory.seedContacts` and an empty-list block in en, uk and de:
  the host may suggest people to a visitor who has none. (3) `MAINTAINERS.md` at the root of the open repo,
  and the one relaxation of the "roles, not names" rule that goes with it: by exact path, for the groups
  "people" and "domain" only. (4) `tools/open-split/dry-run.mjs`: a report of what a split would carry,
  which never changes a file.
- **Why.** A reader should be able to run the thing in five minutes and see for themselves what the relay
  can and cannot read. The playground is also the first outside consumer of the package, so it finds what
  the package still assumes about its host.
- **Files.** `demo/`, `MAINTAINERS.md`, `tools/open-split/`, `src/contacts/seed-contacts.ts`,
  `src/ui/contacts/seed-contacts-empty.tsx`, `scripts/forbidden-tokens.mjs` (one list, now shared with the
  dry run), `scripts/docs-check.mjs` (it also scans `MAINTAINERS.md`, `demo/` and `tools/open-split/`).
- **Decision.** The room loop (pending commit before post, adopt on conflict, commits in order, envelopes
  read before the commit that ends their epoch) is not in this package yet: the playground carries its own
  small copy behind the same host contract, and says so. Lifting it into the package is the next step on
  this front.
- **Next.** The boundary guard covering `demo/`, the room runtime in the package, and the open repository's
  own root files (the split does not carry them).

## 2026-10-10 · Review round 2, host fixes: retention, authorship, stickers, one device-list verifier

- **What.** (1) One retention rule, `isBehindRetention(cursor, oldest)` = `cursor + 1 < oldest`, in
  `protocol/relay-cursor.ts`, with no exemption for a cursor of 0; a joiner's cursors start at the seq it
  joined at (`RelayCursorAtJoin`). The reference host stores `REJOIN_NEEDED`, drops the outbox with it,
  never steps over a commit of an epoch it has not reached, and gives up after 3 conflicts that do not move
  the epoch (before: one device past retention posted the same envelope on every 409, 51 times in one sync).
  (2) The author is the MLS sender: stored history is keyed by (sender, payload id), so reusing another
  member's id replaces nothing; a property test over random two-member runs. (3) A sticker is a catalog id
  only: `imageUrl` is gone from the payload (still `v:1`; an old sender's field is ignored), each reader
  resolves the id from its own catalog, an unknown id is a placeholder. (4) One signed device-list format
  (`mls-device-list/v1`, the assistant's conversation inside the signed bytes) and one verifier,
  `mls/device-list.ts` (signature under the pinned identity key, owner, rollback, malformed entries).
- **Why.** Review round 2 MUSTs rel-M1, rel-M2, sec-M3, sec-M4 and half of arch-M3.
- **Files.** `src/protocol/relay-cursor.ts`, `src/protocol/e2ee-payload.ts`, `src/mls/device-list.ts`, their
  tests; canon sections 3, 9.7 and 10.
- **Decision.** Per-message persistence is decided in canon section 9.7 (history segments, a state checkpoint
  per epoch and every 32 messages, a small record between) but not built yet.
- **Next.** The relay serves list history and the assistant binding; then the host's enrolment (identity
  key, device registration, KeyPackages, Welcome, group creation, second-device approval) and the
  announce outbox.

## 2026-10-10 · K8 wiring W3: one payload codec, reactions inside, the host told a message exists

- **What.** The payload gains two kinds: `reaction` (keyed by the payload id, one per person and emoji,
  `removed` takes it back; `applyE2eeReaction` folds them) and `notice` (an i18n key, never prose). The
  assistant's custody device drops its own provisional codec and speaks this one through a thin adapter, with
  a cross-test in both directions. The host's client announces each sent text or sticker to the host
  (`msg:send {text: '', e2eeEnvelopeId}`), takes the host's `msg:new` for an envelope as the signal to fetch,
  weaves the host's own SYSTEM rows in by time, refuses a relay token minted for another device, and reads the
  inbox's `mlsGroupId` and `plaintextFeaturesOff`. Canon section 10 is updated.
- **Why.** Two encoders both called "v1" could not read each other: the host drew every assistant line as
  unreadable and the device dropped every human line. Without the announcement the host's inbox never learned
  an encrypted message existed; reactions as metadata would have shown the server which emoji went on which
  message.
- **Files.** `src/protocol/e2ee-payload.ts` and its test (the fuzz samples now include reactions and notices),
  `src/protocol/{conversations,events,messages,index}.ts`, `src/hooks/use-messenger.ts`
  (`announceE2eeEnvelope`), canon section 10. No change to `src/mls` or `src/relay`.
- **Decision.** One codec for every member; a client translates only notice keys it knows. Until the host's
  directory knows ages, its guardian policy treats everyone as a minor (fail closed). The assistant's reply is
  capped by the shared codec (10 000 characters).
- **Next.** Signed device lists through one shared verifier and KeyPackage/Welcome enrolment (the host has no
  device registration on the relay yet, and the identity-key model for a person with several devices is
  open); one relay client for the host and the custody device; the device's relay vocabulary from
  `@masia/contracts/wire` only.

## 2026-10-10 · K8 wiring, host side: the engine in a Worker, and the room says what it is doing

- **What.** The first host runs the engine in its own module Worker and fills `SecurityStateSource` from it.
  [Canon section 10](canon.md#10-what-travels-inside-the-ciphertext) fixes what travels inside the
  ciphertext (a versioned, capped payload whose decoder never throws, with a fuzz test);
  [section 11](canon.md#11-the-hosts-engine-a-worker-and-what-this-device-means) fixes how a host runs the
  engine: the Worker and its own policy, where the keys rest, one writer per room across tabs, pending commits,
  the relay token, the sign-out wipe, and the per-room switch. The security state gains this device and the
  room's moment (sending, read-only, removed, a history gap, sign in again); the encrypted badge now says
  "media we can read".
- **Why.** Section 5 promised a badge filled from the engine and section 9.7 a host that keeps its own commits
  across a lost answer; neither existed in a host. The Worker is open question D's answer for the web device:
  the page never holds a group state or a key.
- **Files.** `src/protocol/e2ee-payload.ts` and its test, `src/protocol/security-state.ts`,
  `src/ui/security/` (the banner, the this-device section, the dead-key test), `bundler/optional-peers.mjs`,
  this folder. No change to `src/mls`.
- **Decision.** A tab that loses the writer's lock or a compare-and-set turns read-only and queues instead of
  failing; a message typed while a commit is pending waits in the queue, so the composer never freezes;
  reactions and media stay off in encrypted rooms rather than leak beside the ciphertext. On the native app the
  stored state passes through the page on its way to the Keychain: an honest limit, stated in section 11.
- **Next.** On the host's api: signed device lists, KeyPackage and Welcome enrolment, the inbox's `e2ee`
  field, the relay's URL for the Worker's `connect-src`, reactions by payload id. Then the phone run.

## 2026-10-10 · K4b: the assistant as a real member, hosted outside the packages

- **What.** The host now keeps the assistant's `MASIA` leaf for real: one operator principal owning every
  `MASIA` device, one device per conversation bound in its id, a separate custody process holding the sealed
  keys and group states, and the invariant "mode other than silent if and only if her device is a member",
  repaired toward the mode. [Canon section 3](canon.md#3-devices) gains one paragraph describing the shape as a
  target that a host can follow.
- **Why.** Until now section 3, step 6, said what should happen but nothing in the packages or the host did it.
  The engine already enforces the rules a member checks (`mayAdd`, the conversation binding of a `MASIA`
  entry); the host side had to prove them under random mode flips and lost commands.
- **Files.** `docs/canon.md` only. No package code changed: the custody process uses the engine and the relay
  through their public interfaces.
- **Decision.** The custody process does its half of every membership change and asks the members for theirs,
  because MLS lets no member add or remove itself. Leaving is a crypto-shred followed by a member's Remove; a
  test shows the device cannot decrypt the next epoch even from a state copied before the shred.
- **Next.** The client's signed-list format and identity-key pinning (K7), so that the custody process verifies
  people's lists instead of trusting the relay; then a self-Update path for the assistant's leaf, which needs a
  tree-hash accessor on the engine.

## 2026-10-10 · K5b: the security state gets a face

- **What.** The UI core draws what the room's security state is, as components against a value the host will
  fill: a header badge with a sheet (zone, guardians, security code, what is not hidden, link to devices), a
  guardian ribbon, a stall banner, role and verified marks in the Devices card, and an epoch system row. One
  view model, `ConversationSecurityState`, and one wiring point, the `security` source on
  `MessengerUiProvider`.
- **Why.** The canon promises that the room says what it is and that a guardian is visible to everyone; until a
  screen shows it, those are words. Building the screens against a state value lets them be tested before the
  engine hooks exist, and keeps the UI from ever asking the engine.
- **Files.** `src/protocol/security-state.ts`, `src/ui/security/*`, `src/ui/provider/security-source.ts`,
  the Devices card and the conversation view, `src/test-support/fake-security.ts`; in contracts, the
  `I18nBundle` keys, their fake and the `--msg-warn` token.
- **Decision.** (1) Three states are never blurred: a room with Masia in it is never "encrypted", a room being
  set up is never rounded up, and a room with no state draws nothing. (2) The sheet, not the badge text, says
  that photos, files and metadata are not hidden; the badge keeps the short zone wording. (3) The security code
  is shown, not enforced. (4) The sheet reuses the host's menu slot instead of a new popover dependency.
  (5) The caution colour is a new token, not a host colour.
- **Next.** Wiring: the host fills the source from the engine (K3b) and the custody and membership facts (K4b),
  mounts the badge in its header, and the thread gets a system-row slot for the epoch lines.

## 2026-10-10 · K10: the kitchen goes into the package

- **What.** The package now carries the working space it was built in: the router [`../CLAUDE.md`](../CLAUDE.md),
  [`ARCHITECTURE.md`](ARCHITECTURE.md), [`context.md`](context.md), [`protocol.md`](protocol.md),
  [`experience.md`](experience.md) (renamed from `lessons.md`, now an index) with its
  [archive](experience-archive.md), this log, ADRs [0003](adr/0003-ts-mls-behind-mls-engine.md) to
  [0005](adr/0005-security-review-conditions.md), a "How this was built" section in the README, and a
  dependency-free link and token checker.
- **Why.** The founder wants to show the whole kitchen, not only the result: a reader should see how the thing
  was planned, gated, built by agents, reviewed and corrected. A repository that shows only the code asks for
  trust; one that shows the method can be judged.
- **Files.** `CLAUDE.md`, `README.md`, `docs/*.md`, `docs/adr/*`, `scripts/docs-check.mjs`, `package.json`
  (script `docs:check`). No code.
- **Decision.** Public docs obey fixed editorial rules (English; roles, not names; no deployment details; no
  paths into the private repository; "target" for what is not built) and `docs:check` enforces the checkable
  ones. Drafted by an agent from the private working space; the lead does the editorial pass.
- **Next.** The lead's pass; then the client's MLS core (K3) with the conditions of
  [0005](adr/0005-security-review-conditions.md) as its acceptance criteria.

## 2026-10-10 · K2b: relay hardening after the security review

- **What.** All six findings addressed in the relay (about 35 minutes, one agent): an `adminOf` scope on the
  token, so the admin marker alone grants nothing; the `groupInfo` field removed from the API and the schema
  (migration `20261010130000_hardening`); the declared `memberDelta` stored and served, every Add bound to a key
  package claimed by the same committer (table `key_package_claims`); a parser for the cleartext MLSMessage
  header (`group_id`, epoch, content type) checked after the authorisation and epoch checks; rate limits per
  actor and per target user (120 per 10 minutes); tests for each. A public message is accepted only from a
  member, stricter than the review asked.
- **Why.** [0005](adr/0005-security-review-conditions.md): two authorisation holes, and a relay that trusted a
  client's declaration and could be stalled by any member.
- **Files.** `apps/relay` (routes, domain, schema, migration, tests), `packages/relay/src/mls-header.ts` (50
  tests plus a fuzz), the API description.
- **Decision.** Verified at the time: library 70 tests, relay server 218 tests against a real database, the
  boundary clean (122 modules). Leftovers recorded, not fixed: key-package claims are neither consumed nor
  expired; the relay API docs and the 0001 amendments about `adminOf`, no group info, declared delta and header
  check are folded into the kitchen step. The engine must compare the served `memberDelta` with the decrypted
  commit: one more acceptance criterion for K3.
- **Next.** K3.

## 2026-10-10 · Rollout and the kitchen: gates confirmed

- **What.** The founder confirmed licences (G3 = A: Apache-2.0 for the client and contracts, AGPL-3.0 for the
  relay) and answered the rollout gate with **G4 = B: one switch for all after the tests, no beta channel**,
  overriding the lead's reading of the earlier chat (the founders' chats first). Then asked to "show our whole
  kitchen" in the open repository.
- **Why.** A beta channel means two code paths in production for a while; the founder prefers one switch. The
  cost is that the first real decryption error would be a user's.
- **Files.** The internal ADR-161 sections on beta and docs; [0002](adr/0002-open-package-and-contracts.md)
  Amendments (this log's K10 step added them to the package).
- **Decision.** Compensate with tests: the review checklist of 0005, an interoperability run against a second
  MLS implementation, a run on a real phone's browser engine, all before the switch. The plan gains the kitchen
  step (K10).
- **Next.** K10.

## 2026-10-10 · The security review: GO with conditions

- **What.** A fresh, read-only agent of the strongest tier reviewed `ts-mls` and the relay as built (about 5
  minutes of agent time). Verdict **GO with conditions**; two real authorisation holes in the relay (an
  unscoped admin marker; a child signing its own device list); the relay trusting a declared member change and
  never reading the MLSMessage header; external join not needed in phase 1; one maintainer acceptable with a
  pin and probes.
- **Why.** The rule is a security review before crypto code. The library had already been wrong once on the
  receive side.
- **Files.** The review is summarised in [0005](adr/0005-security-review-conditions.md); its checklist "must
  before client crypto code" became the acceptance criteria of K3.
- **Decision.** A new step first: relay hardening (K2b). Four amendments to the design (device-list signer for
  minors, QR verification, replacing "epoch and tree hash in AAD", the web device) are proposals that need the
  founder; nothing in them is decided.
- **Next.** K2b; the founder's decision on A to D.

## 2026-10-10 · K5a-1: the client's data and hooks move into the package

- **What.** (About 45 minutes, one agent.) `useMessenger` (generic over the message type) into
  `@masia/messenger/hooks`; the `msg:*` wire types into `/protocol`; the contact model into `/contacts` with its
  limits as parameters; `useContactCircles` and `useGroups` against the port `ContactsDirectory` (the former
  `PresenceDirectory`, kept as an alias for one release). The host re-exports; no component changed.
- **Why.** The UI core has to live in the package; data and hooks go first because components depend on them.
- **Files.** `packages/messenger/src/{hooks,protocol,contacts}`, `packages/contracts` (the port and its fake),
  the host's re-export shims. The package suites, the host's suites and its build stayed green; the boundary
  clean.
- **Decision.** `Transport` does **not** grow: until the relay path replaces it, the host gives an adapter and
  the messenger speaks the existing JSON protocol by a documented convention (events on topic `msg:`, link
  state on `messenger:connection`, commands POSTed to `/messenger/command`).
- **Next.** The components (K5, after the client's MLS core) and the host adapters.

## 2026-10-10 · K2: the relay's schema, the epoch serializer, the device and key-package API

- **What.** (About 46 minutes, one agent.) A separate Postgres schema: devices, device lists, key packages,
  conversations, handshakes, envelopes, room members. **No plaintext column exists, by construction;** a test
  asserts it. The serializer: `SELECT … FOR UPDATE`, `409 {currentEpoch}` for a stale epoch, `429` after five
  lost races. Guards: a guardian cannot be removed by the child (403), a device not on the signed list is
  refused (422), a revoked device is not added, a device cannot be revoked while it is in a room (409
  `STILL_IN_ROOMS`). HS256 token verification (issuing is the host's job).
- **Why.** [0004](adr/0004-relay-owns-ciphertext.md): the relay owns the ciphertext.
- **Files.** `apps/relay`, `packages/relay` (migrations `20261010120000_init`, six `CHECK` constraints by hand).
- **Decision.** One deviation from the brief, kept: the boundary forbids the runtime ORM client, so the server
  uses plain SQL through `pg`; the ORM owns schema and migrations only. Beyond the brief: group initialisation,
  proposals and Welcomes in handshakes, a non-user device role registrable only by an admin, an identity key
  immutable after registration, reads clipped to the epoch of joining. 127 plus 18 tests. The post-merge
  verification was killed by the machine's memory; only the boundary was re-run on the trunk, the full run
  followed.
- **Next.** The security review before any client crypto.

## 2026-10-10 · The relay owns the ciphertext (clarification)

- **What.** A table `Envelope {conversationId, epoch, seq, senderDeviceId, ciphertext, createdAt}` in the
  relay's own database; the host writes no message row for an encrypted room (only a flag and a last-activity
  time, from an internal event). Token issuing in the host, verification in the relay.
- **Why.** The relay became its own process (G2 = B), so the earlier sketch (a ciphertext column in the host's
  message table) would have made two homes for messages.
- **Files.** The plan; later [0004](adr/0004-relay-owns-ciphertext.md).
- **Decision.** As stated. Development uses a separate database on the same development server; production
  split and backups are an infrastructure gate, decided outside this repository.
- **Next.** K2.

## 2026-10-10 · K1 closed: `ts-mls` behind our `MlsEngine`

- **What.** The benchmark (about 40 minutes, one agent): adding a member to a group of 50 takes 128 ms on the
  critical path in Node and 29 ms in Chromium, against a threshold of 300 ms; 38 KB gzip; no WASM. Maturity
  is the risk: one maintainer, a high-severity advisory fixed 2026-08-28, a path-less GroupContextExtensions
  commit still accepted, no audit.
- **Why.** [0002](adr/0002-open-package-and-contracts.md) decision 6: measure, do not guess.
- **Files.** Recorded in [0003](adr/0003-ts-mls-behind-mls-engine.md). The bench scripts were run outside the
  repository and are not kept.
- **Decision.** Use `ts-mls` pinned to 1.6.4 behind our own `MlsEngine`; `mls-rs` to WASM is plan B behind
  the same interface; suite 1; a newcomer self-updates after every Add; a strongest-tier review before the
  first client crypto. No Rust toolchain is needed.
- **Next.** K2 and the move of the client's data (in parallel); the security review.

## 2026-10-10 · K1 skeleton

- **What.** (About 23 minutes, one agent.) `packages/contracts` with the ports, an in-memory fake of each and a
  contract suite per port; stubs for `packages/messenger`, `packages/relay`, `apps/relay` (a health route);
  the first docs (canon, ADRs 0001 and 0002, changelog, lessons, README); the ESLint block and
  dependency-cruiser (`pnpm boundary`), blocking in CI; a negative-control test of the guard.
- **Why.** Boundary first, repo later ([0002](adr/0002-open-package-and-contracts.md) decision 3).
- **Files.** `packages/*`, `apps/relay`, CI configuration, lint configuration.
- **Decision.** Checked on the trunk: boundary clean (55 modules), contracts 107 tests. Notes: the dev
  command now also starts the relay; dependency-cruiser 17 (CI runs Node 20); the test configs import a shared
  root config that must be adapted at the split.
- **Next.** The benchmark and the relay.

## 2026-10-10 · The trigger, and a revision of the plan

- **What.** The founder gave the go-word and said the messenger would take the UI too and that cost should be
  watched. Six revisions: **R1** the UI core goes into the package (the host keeps dock, scene, stickers and
  lanes as adapters; the large page is taken apart, not copied); **R2** five UI ports (theme tokens, icons,
  strings, media upload, rich attachments); **R3** benchmark two candidates, `ts-mls` first; **R4** economy:
  the lead does design and docs, one agent per step, a cheaper tier where a check exists, the strongest tier
  only for crypto and security review; **R5** a beta reading, superseded the same day by G4 = B; **R6** a
  section on devices after the migration (now in [`canon.md`](canon.md)).
- **Why.** An "open messenger" without a UI is a library, not a proof; and most of earlier cost was in
  long-lived agents.
- **Files.** The plan; [0002](adr/0002-open-package-and-contracts.md).
- **Decision.** Gates answered that day: G1 = A (drop history), G3 = A (licences), G4 first read as C then set
  to B. A Rust toolchain was found missing on the founder's machine, which put `ts-mls` first.
- **Next.** K1.

## 2026-10-07 · The plan is written; the relay is its own process

- **What.** The founder's brief (calls are phase 2; the messenger is open source; contracts are a condition of
  a PR; the working docs travel with the repository) became a plan with four gates. The founder answered the
  second at once: **G2 = B, the relay is a separate process with its own database from the start.**
- **Why.** The relay changes rarely, so a separate deployment costs little, and a separate process makes the
  claim "the server cannot read it" stronger.
- **Files.** The plan only.
- **Decision.** Start later, in a dedicated session. The founder also asked who else opens their code, how to
  prove that production runs what the repository shows, and how this looks on the market; the answers shaped
  the "readable first" stance.
- **Next.** The trigger.

## Background · 2026-09-09 · End-to-end encryption on MLS is accepted

- **What.** [0001](adr/0001-e2ee-on-mls.md): two zones, Masia as a visible opt-in member, first-class
  devices, a signed device list, a visible guardian leaf, one build.
- **Why.** Human chats should be unreadable by the server; Masia's zone stays honestly server-readable.
- **Decision.** An independent critic pass came first and found three false claims and the "ghost device"; all
  were closed before acceptance ([experience](experience-archive.md#put-a-critic-in-front-of-a-design)).
