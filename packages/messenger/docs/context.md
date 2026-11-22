# Context: where the open messenger stands

The current state, the designs we chose (and why), what comes next and what is still undecided. Read this
second, after [`../CLAUDE.md`](../CLAUDE.md). It is rewritten whenever the state moves; the chronology is in
[`log.md`](log.md), the spec in [`canon.md`](canon.md). **State as of 2026-11-22**, pre-1.0, version 0.0.1.

Steps are named K0 to K14 in the working plan ([`protocol.md`](protocol.md)); this page uses the same names.
Test counts are what `vitest run` printed on 2026-11-20; the calls row, added on 2026-11-22, gives no count. "The first host" is the application this core was
built for; it lives outside this repository, and so does everything this page says it does.

## State today

| Where                                                    | What exists                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | What is stubbed or missing                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/contracts`                                     | Ten ports; an in-memory fake and a contract suite for each. `@masia/contracts/wire`, the one home of the wire vocabulary: roles, id shape, limits, retention (30 days), the MLS profile, the cleartext header parser, the relay token's claims (EdDSA, 10 minutes), the relay's HTTP vocabulary, the signed device list's encoding and, since 2026-11-18, the canonical bytes and checks of the identity-key transfer, and since 2026-11-22 the `call:*` signals of a one-to-one audio call and its verification tag. A negative-control test of the boundary guard. 661 tests.                                                          | A real host implementation of any port lives in the host, not here.                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `packages/messenger/src`: `protocol/` `hooks/` `contacts/` | `createMessenger(ports)`, which only holds the ports. `protocol/`: the `msg:*` wire types and the codec over `Transport` (the interim wire), among them `unread:update`: the unread number is the server's, absolute, never a sum the client keeps. `hooks/`: `useMessenger`. Every send puts its row on screen at once and an entry in an **outbox**; a line that never left stays, marked "not sent" with Retry and Delete, through a tab switch and a reload (browser storage, per account and conversation); the outbox rules are exported for a host's other chat. `contacts/`: the contact model, `useContactCircles`, `useGroups`; the channel strip seats a contact of another family behind one delimiter per family. 879 tests in the package, plus 19 interop scenarios skipped without Docker. | `createMessenger` is still only a holder of the ports. The runtime that drives the engine against the relay (sessions, enrolment, commits, one writer per room) is not in the package; the first host and the playground each carry their own. The first host keeps the outbox of an encrypted room in memory only (plaintext of an encrypted room never goes to browser storage), so there a "not sent" line outlives the screen but not a reload.                                                  |
| `packages/messenger/src/mls`                             | The `MlsEngine` over `ts-mls` and its receive-side validator, over the wire module. The signed device list and the 16-digit approval code. The Masia add rule, on send and on receive: an Add of a minor's first device, or of any guardian leaf, to a room that holds the assistant is refused unless the committer administers that minor, and an assistant leaf of anyone but the relay operator is refused. An Add can take leaves out in the same commit (`removeLeafIndexes`), and a leaf's signature key can be read (`signatureKeyOf`). The client half of the **identity-key transfer** (`identity-transfer.ts`): a new device's one-time HPKE key, sealing and opening the identity key, the holder proof, the request and rebind signatures, the pairing nonces and the decoys of the number sheet. | Nothing in this package or in the playground drives the transfer or the "add a device" step: there is no screen and no flow for them here (the first host has both). [Canon section 3](canon.md#3-devices) describes the approval-code path and not yet the identity transfer or the operator reset; the header comments of `identity-transfer.ts` (contracts and package) are the spec until it does. No secure-storage plugin here: the first host built its own, outside this package. |
| `packages/messenger/src/ui`                              | The screens against the ports: the channel strip and its conversation picker, the thread, the composer, contacts and circles, groups, requests, the Devices card. In the thread: replies (the `⋮` menu or a swipe), edits (ArrowUp recalls the last line), one intent strip, @-mentions by a candidate list, the sender's picture and colour from one participant list, web addresses as links, the "not sent" strip, and a picture viewer that pages over **every picture of the loaded thread**, not one message's (the list is a snapshot taken at the tap). The view marks its root `data-chat-pane`, so a host's composer can take a file dropped anywhere on the pane. A host draws its own `SYSTEM` rows through `renderServiceRow`, with the thread's time format (`formatMessageTime`), and replaces the composer with a line through `composerBlock`. See the [2026-11-17](log.md#2026-11-17--a-line-that-never-left-outlives-the-screen-the-outbox) and [2026-11-20](log.md#2026-11-20--opening-a-chat-reads-it-even-when-the-newest-line-is-my-own) log entries. | The package's own composer is text only: attachments, pictures, stickers, dictation, a dropped file and the phone's Enter rule belong to the host's composer, passed through the `Composer` slot. The viewer (the `Lightbox` slot) and the swipe (`attachReplySwipe`) are drawn by the host: the package decides which pictures a thread has and which row was swiped, and draws neither. |
| `packages/messenger/src/ui/security` (K5b)               | The security state of a room as components against a state value: the zone badge and its sheet, the guardian ribbon, the stall banner, the role and verified marks in the Devices card, and the epoch system row. `ConversationSecurityState` (`protocol/`) and the `security` source on `MessengerUiProvider` are the one wiring point. The first host fills the source from the engine in a Worker: zone, epoch, security code, devices, this device, sending, read-only, removed, history gap, sign-in. Tests against a fake source.                  | Still empty in the first host: guardians (they need the directory's signed device lists) and device names (a device shows as its id). `EpochSystemRow` is built and tested alone; the thread does not draw it (`renderServiceRow` hands a host its own `SYSTEM` messages, not epoch events). Add-a-device and the leaf and self-Update counts are not drawn.                                                                                                                                   |
| `packages/messenger/src/mls/__tests__/interop` (K8-prep) | An interop run of `MlsEngine` against OpenMLS 0.9.1 in a pinned container (`pnpm test:interop`, needs Docker, skipped otherwise): groups made by either side and joined from the other's Welcome, Add, remove, self-update, messages both ways, three seeded random sequences, and the refusals checked against real OpenMLS output. 19 scenarios, about 30 s. Re-run on 2026-11-20: 19 of 19 pass.                                                                                                                                                                  | **Green with a patched library:** the one defect it found (F1: ts-mls 1.6.4 refused to join a valid tree in which an unmerged leaf sits under a node whose ancestor was refreshed from the other half of the tree) is fixed by a pinned patch of the library to RFC 9420 section 12.4.3.1 (canon section 9.7, "Patched library check"); upstream report pending. Not covered: a commit without an UpdatePath (stock OpenMLS never builds one), other OpenMLS versions or cipher suites, offline backlog. See [its README](../src/mls/__tests__/interop/README.md). |
| `packages/messenger/src/call` (2026-11-22)               | `@masia/messenger/call`: the one-to-one audio call engine, `createAudioCallEngine(ports)`, headless and on ports; its state machine (`audioCall`); the SDP checks (one fingerprint, one bundle, relay-only filtering); browser adapters for the peer connection and the microphone; the binding port's types and the binding itself (`callTag` / `callVerify`, run by the host inside its MLS worker over a keyring of its room); a plain `<audio>` speaker; the call screen and its React hooks (`@masia/messenger/call/react`, words and icons passed in by the host). Moved from the first host with no change of behaviour; the machine, SDP, wire, browser-adapter and binding tests and the engine's own suites came with it. The `call:*` wire and the tag construction are in `@masia/contracts/wire`. How a host plugs in: [`calls.md`](calls.md). Since 2026-11-22 (later the same day) also `createRelayCallSocket`, the socket port over the relay's opt-in call channel (25 tests against an in-memory relay that refuses any signal outside an admitted call; the channel itself has 24 route tests on a real Postgres, plus one with the server's real timeouts run on demand, and 20 unit tests). | TURN credentials and the keyring that derives the call key from a live MLS room are the host's, through the ports (the playground carries a keyring of its room); signalling is the host's too, unless it uses the relay's call channel (off unless `RELAY_CALLS_ENABLED=true`; no TURN, none of a host's rules; loopback or a trusted LAN); only the playground's Chromium smoke, run by hand against a running stack, drives the engine over that channel, no test of this package does; the call screen's frame stylesheet (the `esc*` classes) is the host's (the playground has a small one of its own). Run in Chromium only. |
| `packages/relay`                                         | Re-exports `@masia/contracts/wire` and adds the relay-only limits, one error-code table, the device-list version rule and the TTL counters. 91 tests.                                                                                                                                                                                                                                                                                                                                                                                       | None.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `apps/relay`                                             | Its own Postgres schema and migrations (devices, device lists and their versions, the pinned identity key, key packages and their claims, conversations, handshakes, envelopes, room members and, since 2026-11-18, identity requests and identity resets); the epoch serializer; the HTTP API (`openapi.json`); auth verification (EdDSA tokens with `iss`, `aud`, `kid` and a 10-minute life, minted by the host and checked here by public key: no shared secret; the issuer and audience are configured and have no default); a retention job (handshakes and envelopes after 30 days, key packages that expired or were spent long ago). Hardening from the first security review, review round 1 and the review of 2026-11-15: only a guardian of a child may take that child's guardian device out of a room, and an assistant entry is accepted only on the operator's device list. **The operator's identity-key reset:** a command on the relay's own machine, a dry run unless `--apply --confirm <user>`; it names the one device that may pin the next key (a ticket, 24 hours) and the others rebind. 505 tests against a real database. | **No push channel:** the relay is a mailbox over HTTP and clients poll. Minting tokens is the host's job; the relay only verifies them. Deployment, TLS and backups are decided outside this repository. |
| `demo/` (the playground)                                 | `docker compose up --build`, two browser tabs, an encrypted chat through a relay on your machine; the host adapter, the client runtime and a smoke script for two people. Since 2026-11-22 a one-to-one audio call between the two tabs, on this package's engine, binding and call screen, with a Chromium smoke of its own. 153 tests. See [its README](../../../demo/README.md).                                                                                                                                                                                                                                                                                                                | A demo: no accounts (the page's server hands a token to anyone who types a name), keys in a tab's memory (a reload makes you a new person), one-to-one rooms only, polling every 2.5 s, no pictures, typing indicators, read marks or older-history paging, no assistant. A call connects directly, and only when the page is on loopback (no STUN or TURN), has no ring sound, and runs the binding in the page (no MLS worker).                                                                                                                                                                                                                                |
| Guards                                                   | ESLint `no-restricted-imports` plus dependency-cruiser (`pnpm boundary`, 390 modules, no violations), both as an allowlist: an open package imports `@masia/contracts`, itself, node builtins and its declared npm dependencies only. Both blocking in CI, with `pnpm docs:check` and `pnpm forbidden-tokens` beside them.                                                                                                                              | ESLint reads import text only, so a relative climb into another package is caught by dependency-cruiser alone.                                                                                                                                                                                                                                                                                                                                                                                  |
| Docs                                                     | The kitchen: this folder (K10), checked against the code on 2026-11-20.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `docs:check` verifies links and forbidden tokens only; it does not prove the prose is true. The canon and the changelog do not yet describe the identity transfer, the operator reset, the picture pager or the reply swipe.                                                                                                                                                                                                                                                                       |

## Chosen design (one record per surface; the reasons are in the ADRs)

1. **An open package, not an app.** Variant: publish the messenger core (client, UI core, relay) and keep the
   host's world (dock, universe scene, stickers, lanes) as adapters behind ports. Why: "an open messenger"
   without a UI is a library, and a package that knows the host's world cannot be embedded. →
   [ADR 0002](adr/0002-open-package-and-contracts.md).
2. **ts-mls behind our own `MlsEngine`.** Variant: a pure-TypeScript MLS library, wrapped by an interface we
   own; `mls-rs` compiled to WebAssembly is plan B behind the same interface. Why: it passes the speed
   threshold with a wide margin, needs no WASM, no Rust toolchain and no `wasm-unsafe-eval` in the CSP; its
   maturity is the risk, so the engine validates every incoming commit itself. →
   [ADR 0003](adr/0003-ts-mls-behind-mls-engine.md).
3. **The relay owns the ciphertext.** Variant: an `Envelope` table in the relay's own database; the host stores
   no message row for an encrypted room and learns of activity through events. Why: no plaintext column can
   exist by construction, and the host's database never holds an encrypted body. →
   [ADR 0004](adr/0004-relay-owns-ciphertext.md).
4. **The UI core lives in the package, behind UI ports.** Variant: conversation list, thread, composer, contacts
   and circles, Devices screen, room security state, epoch lines go in; theme, icons, strings, media and rich
   attachments come through `ThemeTokens`, `IconSet`, `I18nBundle`, `MediaUpload`, `RichAttachment`, and what
   only a host can draw (a menu, a scroller, the picture viewer, a person's chip, a richer composer) through
   the slots of `MessengerUiProvider`. Why: the repository is shown as proof of an approach, and the proof
   needs a screen. → [ADR 0002](adr/0002-open-package-and-contracts.md).
5. **History is dropped at the switch, not migrated.** Variant: a one-time purge of text and every derived copy,
   one system line, no recovery key in phase 1. Why: nothing to back up means no recovery-key experience to
   build before it is needed. → [ADR 0002](adr/0002-open-package-and-contracts.md) decision 7.
6. **One switch for all, after the tests, no beta channel.** Variant: all direct and group chats switch in a
   single step once the crypto review checklist, an interoperability run against a second MLS implementation and
   a run on a real phone's browser engine are green. Why: staged rollouts mean two code paths in production;
   the cost is that the first real decryption error would be a user's, which the tests must pre-empt. →
   [ADR 0002](adr/0002-open-package-and-contracts.md), amendment of 2026-10-10.
7. **An interim wire convention.** Variant: until the relay path replaces it, the messenger speaks the host's
   JSON protocol through the two `Transport` calls (events on topic `msg:`, link state on `messenger:connection`,
   commands POSTed to a fixed path), and the port does not grow. Why: no port change for a temporary protocol. →
   [canon §6](canon.md#6-the-boundary-and-the-ports).
8. **The relay is its own process with its own database, using plain SQL.** Variant: Prisma owns the schema and
   migrations only; the server talks to Postgres through `pg`. Why: the boundary forbids an ORM client in the
   open packages, and a reader finds plain SQL easier to audit. → [ADR 0004](adr/0004-relay-owns-ciphertext.md).
9. **Licences split.** Apache-2.0 for the client and contracts so they can be embedded and audited; AGPL-3.0 for
   the relay so a closed fork of the server cannot exist. → [ADR 0002](adr/0002-open-package-and-contracts.md).
10. **Mentions are text; the package highlights by a candidate list.** Variant: `@tag` in the message text and nothing
    else stored; the handle grammar has one home in the host, and the host hands the composer port a
    `mentionCandidates` list (`{ id, tag, name, avatarUrl?, color? }`, the participants WITH a `tag` of the view's one
    `Participant` list — design 11); the package completes after `@` (`useMentionPopover`,
    `MentionPopover`) and draws a chip (`renderMentions`) only for a tag on that list. Why: the package must not parse
    a grammar it does not own, and a chip for a stranger's handle would be a lie. → [log
    entry](log.md#2026-11-06---mentions-in-the-composer-and-the-thread-by-candidate-list).
11. **One participant list; the host owns faces, colours and handles.** Variant: the view takes `participants:
    Participant[]` (`{ id, name, avatarUrl?, color?, tag? }`) and derives nothing — the host resolves the picture URL,
    picks the colour (its palette, its default rule, a person's stored choice) and attaches a `tag` only to someone it
    can mention. The first bubble of someone else's run opens with their picture or an initial on their colour (28 px;
    later bubbles of the run keep the column empty so the text lines up); their colour rides as ONE custom property on
    the row (`--sender-color`) that the sender name and a 3 px left edge of the bubble read (groups and 1:1 alike, the
    same colour in light and dark, never on a sticker, never on an own bubble); the bubble background is not tinted.
    Why: a second list for faces would drift from the mention list; a colour rule in the package would duplicate the
    host's. → [log entry](log.md#2026-11-06--the-senders-face-and-colour-in-the-thread-one-participant-list).
12. **A line somebody typed is never lost in silence.** Variant: every send puts a row on screen and an outbox
    entry at once and the server's echo removes the entry; a send that was refused, lost on a dead link or dropped
    by the server stays where it was written, marked "not sent", with Retry (the same command again, never a new
    message) and Delete. The plaintext chat keeps the outbox in browser storage per account and conversation; the
    host of an encrypted room builds its own on the same store with no storage, because the plaintext of an
    encrypted room never goes to browser storage. The rules are one module (`hooks/outbox-rules.ts`) that the
    host's other chat reuses. Why: testers reported messages that "randomly disappeared" and a refusal that was
    gone after a tab switch; two copies of the rules would drift. → canon section 5 (the bullet "A line somebody
    typed is never lost in silence"); log entries
    [2026-11-07](log.md#2026-11-07--a-message-that-never-left-says-so-and-can-be-sent-again),
    [2026-11-17](log.md#2026-11-17--a-line-that-never-left-outlives-the-screen-the-outbox) and
    [2026-11-18](log.md#2026-11-18--one-set-of-outbox-rules-for-the-hosts-assistant-chat-too).
13. **The unread number is the server's; reading is the view's job.** Variant: the host says the number after every
    delivery and every read (`unread:update`, absolute); the client applies it and never adds. The open view sends
    `msg:read` up to the newest message the server holds, whoever wrote it, and a receipt that changes nothing keeps
    the same list (a new list would make the view read again, and two open chats would bounce receipts). Why: a count
    derived from the messages a client happened to receive drifts as soon as a second device or a reconnect is
    involved; a read that stopped once the reader's own line was the newest left a badge that opening the chat never
    cleared. → log entries
    [2026-11-07](log.md#2026-11-07--the-unread-number-is-the-servers-one-live-event-two-more-preview-fields) and
    [2026-11-20](log.md#2026-11-20--opening-a-chat-reads-it-even-when-the-newest-line-is-my-own).
14. **The package owns the rule, the host draws the gesture and the viewer.** Variant: one rule says what a message's
    pictures are (a document is not one, an inline photo wins over its saved copy, a sticker has none) and how the
    pictures of the whole loaded thread line up (`message-pictures.ts`); the same rule serves both of the host's chats.
    The viewer is the `Lightbox` slot and a reply swipe is the host's `attachReplySwipe`; the package reports what the
    tap or the swipe means and draws neither (it has no UI dependency for gestures). The pages are a snapshot taken at
    the tap, so a message that lands while the viewer is open does not shift the picture under the reader's thumb.
    Why: a picture must mean the same thing wherever it is tapped, and a finger and the `⋮` menu must never disagree
    about what may be answered. → the header comments of `ui/conversation/message-pictures.ts` and
    `ui/conversation/use-picture-gallery.ts`; [log entry](log.md#2026-11-15--the-thread-lets-the-host-draw-its-own-service-rows)
    for the same shape of slot.
15. **The identity key can move between a person's devices, sealed, and a lost one has an operator's way back.**
    Variant: a new device asks for the key with a request it signs with its own device key; a device that already
    holds the key shows a short number derived from the new device's id and keys and from the identity key itself (two
    digits, offered among two decoys), so a relay that swaps any of them changes the number; the holder seals the key
    to the new device's one-time key and the relay stores only that sealed blob, serves it to the asking device alone
    and opens nothing; the new device proves it holds the key by a signature under the pinned key. A request lives 10
    minutes and a sealed key a day. A person who lost every device that held the key is helped by the relay's operator
    on the relay's own machine (never over HTTP): a dry run by default, one device named, a 24-hour ticket, and the
    surviving devices rebind with one tap each; a room waits for every device that survived. Why: before it, losing the
    one device that held the identity key made the person a new person to the cryptography, and a device that held it
    was the only one that could approve another. → the header comments of
    `packages/contracts/src/wire/identity-transfer.ts` and `apps/relay/src/operator/identity-reset.ts`; the canon does
    not describe it yet (see Next steps).
16. **The call engine is open; signalling stays a host port (2026-11-22).** Variant: the host-neutral part of the
    first host's one-to-one audio call moves in as it is: the engine and its machine in `@masia/messenger/call`,
    the `call:*` signals and the verification tag in `@masia/contracts/wire`. Signalling, TURN, the binding's
    implementation, the screen and who may call whom stay with the host. Why: the engine was already written on
    ports with no framework, so this is a move, not new work; carrying signals through the relay would need a live
    channel the relay does not have and a decision the first host has not taken (its decision record rejected it,
    because ringing would lag by the poll interval). → [`calls.md`](calls.md).
    _Later the same day: the binding's implementation moved in too, with the engine's own suites; the keyring that
    derives the call key from a live room stays the host's ([log](log.md#2026-11-22--the-call-binding-and-the-engines-own-suites-move-in)).
    Then the call screen with its hooks and a plain speaker ([log](log.md#2026-11-22--the-call-screen-and-its-hooks-move-into-the-open-packages)),
    and the relay's opt-in call channel (design 17)._
17. **Call signals through the relay: server-sent events down, one POST per signal up, nothing stored, off by
    default (2026-11-22).** Variant: the relay holds one event stream per device and hands a posted signal to the
    target's stream at once; the two clients do what a call server would (ack, ring, first accept wins, ring
    timeout), and each pins its peer. Only between the `USER` devices of a two-person one-to-one room; the relay
    stamps the sender; the same empty `202` whether the target listens or not; caps per signed user and device,
    per caller, per pair, per call, per stream; a signal other than a ring passes only between the two devices of a
    call a ring admitted (forgotten after 10 quiet minutes while it rings, kept through 4 quiet hours once both ends
    connected, closed by its `call:end`), and every table the relay keeps has a ceiling; the switch
    `RELAY_CALLS_ENABLED` is off unless set. Why: plain HTTP on the server
    that already runs, with the same token and no new dependency. Rejected: a WebSocket in the relay (a new
    dependency and a second protocol to secure) and sealed messages in the mailbox (ringing would lag by the poll
    interval, and call metadata would be stored). The first host keeps its own signalling. →
    [`calls.md`](calls.md#signalling-through-the-relay) · [canon section 5](canon.md#5-what-the-relay-sees).
    _Later the same day: the playground's two tabs call each other over it; its ICE answer gives every candidate
    when the page is on loopback, and relay-only with no server otherwise, so a page opened from anywhere else ends
    an answered call before any connection is tried. Only the page is checked: the page's server forwards to a
    relay (`DEMO_RELAY_URL`) the page cannot see, and whoever runs that relay sees both addresses and every SDP
    ([log](log.md#2026-11-22--a-call-between-the-playgrounds-two-tabs))._

## Next steps

The plan's steps, as they stand:

| Step                                     | State                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| K3: the client's MLS core                | Built: `MlsEngine` over ts-mls with the receive-side validator, group state in `SecureStorage`, the self-update schedule, a failed decryption shown as a security state of the room. Its acceptance was the checklist in [ADR 0005](adr/0005-security-review-conditions.md).                                                                                                  |
| K4: the relay token and Masia's place    | Built: the token contract in `@masia/contracts/wire` and its check in the relay; Masia as an `ASSISTANT` device of the operator, admitted by the engine's Add rule and the operator-only device list. Her consent, her custody service and the rule that an encrypted room has her only with a recorded consent are the host's ([canon section 2](canon.md#2-masia-is-a-visible-opt-in-member)). |
| K5: the UI core                          | Built: K5a (the screens) and K5b (the security-state UI), both in `ui/`. Open: a system-row slot for epoch events, and guardians and device names in the host's source (State today).                                                                                                                                                                                       |
| K6: the secure-storage plugin            | Built in the first host, outside this package. Open: a native Worker bridge, so the stored bytes need not pass the page ([canon section 11](canon.md#11-the-hosts-engine-a-worker-and-what-this-device-means)); a native implementation and a wrapped IndexedDB for the web are the [canon section 9.7](canon.md#97-choices-made-on-purpose-and-known-limits) design.          |
| K7: the purge                            | A gate, irreversible: erase text and every derived copy for each direct and group chat, plus a nightly assertion that no encrypted conversation holds plaintext. This folder records no completion.                                                                                                                                                                       |
| K8: the one switch                       | Prepared: the interoperability run against OpenMLS and the desktop WebKit run (an Add in a group of 50 took 172 ms p95 in a Worker, budget 300 ms; [canon section 8](canon.md#8-the-crypto-library-is-measured-not-guessed)); the host side is wired (the engine in a module Worker with its own policy; a room is encrypted only when the host's inbox says so). Open: the run on a real phone (per-call WebCrypto latency, which must stay under about 0.27 ms; Ed25519 and X25519 on the oldest supported OS; the Worker's policy under the app shell; thermal throttling), then the switch itself. Splitting the packages into their own repositories is a separate gate after that. |

What is next, in the order we would take it:

1. **The room runtime into the package.** The runtime that drives the engine against the relay is written twice, in
   the first host and in the playground. Moving one of them in, behind the ports, is what turns `createMessenger`
   from a holder of ports into a messenger that works out of the box. No decision record yet.
2. **Write down the identity transfer and the operator reset.** [Canon section 3](canon.md#3-devices) still says a
   person who lost the one device that held the identity key becomes a new person to the cryptography; since
   2026-11-18 there is a way back (design 15), and the canon, the changelog and this package's README (which lists
   linking a new device as open) have not caught up. A screen and a flow for it in the package come after the runtime.
3. **A push channel from the relay.** The relay is a mailbox over HTTP and clients poll (the playground every
   2.5 seconds). A push needs a decision on what a live channel may carry; it has no record yet.
4. **Epoch lines in the thread, and Add-a-device in the Devices card.** `EpochSystemRow` is built; the thread needs
   a place to draw epoch events (`renderServiceRow` is for `SYSTEM` messages only).
5. **Calls, the second half.** Since 2026-11-22 the call engine, its state machine and its wire are here
   (design 16), and the relay can carry their signals, opt-in (design 17). The playground's two tabs call each
   other over that channel, on the package's call screen with a frame stylesheet of its own (its ICE answer: every
   candidate when the page is on loopback, relay-only otherwise), and its Chromium smoke drives the engine
   over the channel end to end. What is left: a test in this package that drives the engine itself over that
   channel (the playground's smoke needs a browser and a running stack, and runs by hand). Media
   and rich attachments stay out of the end-to-end encrypted path in phase 1 ([canon section 5](canon.md#5-what-the-relay-sees)).

## Open questions

Four amendments await a decision; **nothing here is decided until an ADR records it.** The security review ([ADR 0005](adr/0005-security-review-conditions.md)) proposed four changes to the design in
[ADR 0001](adr/0001-e2ee-on-mls.md). They need the founder's decision.

- **A. Who signs a minor's device list.** Today the person's own identity key signs it, so a child could drop the
  guardian from it. Proposal: for minors the guardian's or admin's key signs, plus a rule that a room containing
  a device of user X contains every guardian device on X's list.
- **B. Verification in phase 1.** Today a changed key is shown as "key changed, confirm". Proposal: also offer QR
  verification, reusing the device-linking QR, with a blocking warning on a key change after verification.
- **C. What is bound to a message.** Today the canon says every message carries epoch and tree hash as
  authenticated data. The review finds that redundant (MLS already binds group id, epoch and content type, and
  derives keys from the group context). Proposal: put the conversation id in a group-context extension, add a
  per-sender counter inside the encrypted payload (gaps show as "N messages missing"), and show the epoch
  authenticator on the verification screen to expose forks.
- **D. The web device.** Proposal: drop the assumption that the web build needs `wasm-unsafe-eval` (ts-mls has no
  WASM), add Trusted Types, keep MLS state in a dedicated Worker, and make guardian devices native-only.
  _The Worker part is built on the web host ([canon section 11](canon.md#11-the-hosts-engine-a-worker-and-what-this-device-means));
  Trusted Types and native-only guardians are still open._

## Links

- Spec: [`canon.md`](canon.md) — [two zones](canon.md#1-two-zones) · [devices](canon.md#3-devices) ·
  [history](canon.md#4-history-at-switch-on) · [what the relay sees](canon.md#5-what-the-relay-sees) ·
  [the boundary](canon.md#6-the-boundary-and-the-ports) · [honest limits](canon.md#honest-limits)
- Map: [`ARCHITECTURE.md`](ARCHITECTURE.md) · Method: [`protocol.md`](protocol.md)
- Decisions: [`adr/README.md`](adr/README.md) · Lessons: [`experience.md`](experience.md) ·
  Chronology: [`log.md`](log.md) · Releases: [`CHANGELOG.md`](CHANGELOG.md)
