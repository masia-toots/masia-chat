# Changelog

All notable changes to `@masia/messenger`. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project is pre-1.0, so any release may change
anything.

For the **why** behind each change, and the order things happened in, read [`log.md`](log.md).

## [Unreleased]

### Added

- The open repository's root (`tools/open-split/scaffold/`: workspace manifest, lint config with the same
  boundary, `README.md`, `SECURITY.md`), an assembly that builds the open repository outside the host from a
  committed revision (`tools/open-split/assemble.mjs`) and a scan of the set's history under the forbidden-token
  rules, counts only (`tools/open-split/history-scan.mjs`). Not published yet.
- The kitchen: a router `CLAUDE.md`, `ARCHITECTURE.md`, `context.md`, `protocol.md`, `experience.md` (renamed
  from `lessons.md`, now an index) with `experience-archive.md`, `log.md`, ADRs 0003 to 0005, and a
  `docs:check` script that verifies links and flags forbidden tokens.
- The relay (`@masia/relay`, `@masia/relay-server`): its own database schema, the epoch serializer, the device
  and key-package API, authorisation scoped by `adminOf`, a header check on every handshake, and per-target
  rate limits.
- The client's data and hooks, moved out of the Masia hub (no components yet):
  - `@masia/messenger/protocol`: the `msg:*` wire types (messages, conversation previews, client and
    server events) and the codec that carries them over the `Transport` port.
  - `@masia/messenger/hooks`: `useMessenger`, the live state of one conversation.
  - `@masia/messenger/contacts`: the contact model (building and seating the channel bank) and the
    `useContactCircles` and `useGroups` hooks.
- Tests for all of it, against the fakes in `@masia/contracts`.
- `@masia/messenger/ui`, the human-chat screens, moved out of the Masia hub (ADR-161):
  - the conversation (`MessengerChatView`, `Bubble`, `P2PChatBody`), the channel bank and its conversation
    picker, the contacts menu and door with the circles, groups and requests panels, and the `DevicesCard`;
  - `MessengerUiProvider`, the one context that carries the ports and the host's slots (menu, horizontal
    scroller, gallery, person chip, optional composer) and facts;
  - tests against the fakes in `@masia/contracts` (`ui/**/__tests__`).
- The security-state UI (K5b), in `@masia/messenger/ui` and `@masia/messenger/protocol`:
  - `ConversationSecurityState`, `EpochEvent` and `formatEpochAuthenticator` (the epoch authenticator as eight
    groups of four hex digits), a plain description of a room that the host fills from the engine;
  - `MessengerUiProvider` takes an optional `security` source (`securityStateOf`, `subscribe`); without it
    nothing is drawn;
  - `ZoneBadge`: a header badge for the four zones (encrypted, Masia, pending, plain) that opens a sheet with
    the explanation, every guardian, the security code with a compare hint, what is not hidden (media,
    metadata) and a link to the room's devices; a room with no state draws no badge;
  - `GuardianRibbon` ("Mom sees this chat", collapsed to "N adults see this chat" beyond two) and
    `RecoveryBanner` (a stalled room, no time promised), neither dismissable, drawn by `MessengerChatView`
    when it is given a `conversationId`;
  - `DevicesCard` shows a role chip, a verified mark, a "waiting for the first key update" warning and a
    "current" marker for a room's devices, and lists the room's other devices read-only; no new action;
  - `EpochSystemRow` for device added or removed, Masia joined or left, a changed key and encryption on
    (built and tested alone; the thread has no system-row slot yet);
  - contracts: 33 `I18nBundle` keys (`zone`, `guardians`, `fingerprint`, `recovery`, more `epoch` and
    `devices`) with fakes, and the `--msg-warn` theme token (16 tokens now). No new icon names.
- `@mantine/core` and `@mantine/hooks` are peer dependencies.
- `@masia/messenger/mls`: the MLS engine (canon section 9).
  - `MlsEngine`, our own interface over MLS (RFC 9420): groups, KeyPackages, add, remove, self-update,
    commit and Welcome processing, application messages, exporter, state encode/decode. First
    implementation, `createTsMlsEngine`, over `ts-mls` **1.6.4** (pinned exactly; its undeclared runtime
    dependencies `@noble/ciphers` 2.1.1 and `@noble/hashes` 2.3.0 are pinned beside it).
  - A receive-side validator that does not trust the library: UpdatePath rule (the GHSA-gwp3-968w-m7gv and
    GroupContextExtensions shapes), by-value proposals only, no external join or sender, leaves checked
    against the owner's verified signed device list, the role cannot change, guardian removal only by an
    admin of the child, the relay's `memberDelta` compared with the decrypted commit, Welcome tree
    re-verified, conversation id bound into the GroupContext and every application message, pinned cipher
    suite, size caps before decoding, KeyPackage lifetime window, and an outcome check on what the library
    built. One error type (`MlsEngineError`) with a closed list of codes.
  - A contract suite written against the interface (lifecycle, attacks, robustness with a seeded fuzz and a
    performance smoke), unit tests for the validator, the framing and the header parser, the RFC 9420 test
    vectors for tree math, crypto basics, secret tree, key schedule and message protection (cipher suite 1),
    and two control tests that pin what the library does on the two known bad commits.
  - Hardening after the code review of the engine (canon sections 9.3 and 9.7):
    - A compromised guardian device is removable by another guardian device of the same child whose
      registered owner is an admin, so a room with no admin leaf can still evict it.
    - Adding Masia to a room that holds a minor needs a committer who administers every minor in it
      (`MASIA_ADD_FORBIDDEN`), and a Masia leaf is valid only in the one conversation its signed list entry
      names.
    - The committer is checked against its owner's signed list on every commit, not only when it carries an
      UpdatePath.
    - Backlog-safe validation: a device that was offline replays the commits it missed against the list
      versions it had pinned at the previous epoch (`backlog`, `DeviceDirectory.listedSince`), with one
      optional refresh and retry per user. The pins are saved with the state (state format 2).
    - The KeyPackage window on receive is judged against a forward-only floor (`acceptedAtMs`,
      `RELAY_BACKLOG_RETENTION_SECONDS`) instead of the clock, so a package that expired while the commit
      waited at the relay no longer stalls a room; a sender keeps the full window.
    - A directory contract suite (`__tests__/contract-directory.ts`) that a host runs against its real
      directory.
    - Receive-side negative tests for a forged KeyPackage signature, a forged KeyPackage leaf signature, a
      forged UpdatePath leaf signature and an init key equal to the leaf key.
  - An interop run against OpenMLS 0.9.1 (K8-prep): `pnpm test:interop` builds a pinned container (Rust, no
    network at run time), drives it and `MlsEngine` side by side through `src/mls/__tests__/interop/`, and
    writes the versions, every check and the exact library errors to `results.json`. 19 scenarios: groups made
    by either side, Add, remove, self-update, messages both ways, seeded random sequences, and the refusals
    (proposal by reference, external commit, PublicMessage commit, GroupContextExtensions, KeyPackage,
    credential and Welcome rules) against real OpenMLS output. Skipped without `MLS_INTEROP=1`. It found one
    library defect (ts-mls 1.6.4 refuses to join a valid tree with an unmerged leaf under a refreshed
    ancestor), so the suite is red until that is fixed.
    _(Note, 2026-10-10: fixed by the pinned library patch, see Fixed below. The suite is green, 19 of 19, and
    `results.json` now records the patch's lockfile hash next to the ts-mls version, as `tsMlsPatch`.)_
- `bench/webkit`, a browser run of the MLS engine (`pnpm -F @masia/messenger bench:webkit`): the engine and the
  contract suite's in-memory support are built with Vite and served under a strict policy (no `eval`, no
  WebAssembly); Playwright WebKit and Chromium run the lifecycle in groups of 2, 5 and 50, the attack checks,
  the performance probes (an Add in a group of 50 five times, a self-update, 100 messages of 4 KB) and a
  module Worker that carries the engine too, then write JSON, a console log and a screenshot. It exits
  non-zero on a failed scenario or when the Add p95 passes 300 ms. It reuses a Playwright and a Vite that the
  workspace already has and adds no dependency. First results are in canon section 8.
- `@masia/contracts/wire` (architecture review round 1, M14): the ONE home of what the client and the relay
  must agree on byte for byte. Device roles, credential codes and layout version, id shape and limits, the
  MLS profile (protocol version, cipher suite, the `0xf0c1` extension), the AAD frame, handshake kinds, size
  caps, retention, the cleartext MLS header parser (`parseMlsHeader`, `parseKeyPackageLifetime`) and the
  relay token contract (`relayTokenClaims` builds the claims, `readRelayTokenClaims` checks them; issuer and
  audience are arguments, never defaults). Apache-2.0, no dependencies. The engine and `@masia/relay` import
  it; the host reads it through its own re-export, so it never imports the AGPL relay.
- What travels inside the ciphertext (K8, canon section 10), in `@masia/messenger/protocol`:
  `encodeE2eePayload`, `decodeE2eePayload` and `validateE2eePayload` for a versioned (`v: 1`), length-capped
  (48 KiB; text 10 000 characters) JSON payload of four kinds (text, edit, delete, sticker) whose decoder never
  throws; `e2eePayloadToEvent` maps it onto the existing `msg:*` events and `canApplyE2eeChange` allows an
  edit or a delete only by the message's own MLS sender. A fuzz test of 3 000 random and mutated inputs.
- The room's moment in the security state (K8, canon section 11): `ConversationSecurityState` gains
  `thisDevice` (engine isolated or not, keys in `hardware` or `browser`), `sending`, `readOnly`, `removed`,
  `historyBefore` and `signInRequired`; the sheet draws a "This device" section and the strip a
  `RoomStateBanner` for each, and `I18nBundle` gains their keys (UK, EN, DE in the host). A test fails on any
  messenger key the UI does not use.
- `@masia/messenger/bundler/optional-peers`: the `ts-mls` optional peers a host's bundler leaves out when it
  bundles the engine, one list for the WebKit bench and the host's Worker build.

### Changed

- The encrypted badge says "Text is encrypted · media we can read" (was "· Masia is not here"): the zone
  already means Masia is absent, and media is the one thing a person could mistake for protected (canon
  section 5).

- `PresenceDirectory` grew into `ContactsDirectory`: besides the consent gate and display data it now
  carries the address book (contacts, circles, groups, requests, search) and their writes. The old name is
  a deprecated alias for one release.
- `react` is a peer dependency.
- `@masia/messenger/mls` (breaking, before any host uses it):
  - `DeviceDirectory` gained `listedSince` (required) and `refreshDeviceList` (optional); `GuardianPolicy`
    gained `isMinor` and `guardianOwnerOf`; a Masia entry on a device list names its conversation
    (`ListedDevice.conversationId`).
  - `joinFromWelcome` requires `expectedGroupId` and `expectedEpoch`; `processCommit` takes optional
    `backlog` and `acceptedAtMs`.
  - Commits are PrivateMessages only: a PublicMessage commit is refused (`UNEXPECTED_MESSAGE_KIND`).
  - A group has at most 256 devices (was 1024); the extra authenticated data of an application message is
    capped at 1 KB; a removal in the relay's `memberDelta` is matched by device id to the one member that
    has it, and an ambiguous id matches nobody.
  - The serialized state is format 2 (a state of format 1 is refused as corrupt).
  - The engine code review, round 1 (canon section 9; findings in [ADR 0005](adr/0005-security-review-conditions.md)):
    - `add`, `remove` and `selfUpdate` also return a `pendingCommit`; new `adoptPendingCommit`,
      `encodePendingCommit` and `decodePendingCommit` let a host recover its own commit after a lost
      acknowledgement, a restart or a 409 (host contract in canon section 9.7).
    - New error codes: `STATE_VERSION_UNSUPPORTED` (stored bytes of another format version; keep them; a
      state of format 1 is now refused with it, not as corrupt), `INVALID_ARGUMENT` (a caller's bad
      argument, previously reported under a peer-facing code), `TOO_MANY_PROPOSALS` and `GROUP_FULL` (were
      `DECODE_TOO_LARGE`), and `DIRECTORY_UNAVAILABLE` (a directory call that fails or exceeds the new
      `MlsEngineContext.directoryTimeoutMs`, default `DIRECTORY_TIMEOUT_MS` = 10 s; a failed refresh no longer
      turns into `LEAF_NOT_IN_SIGNED_LIST`).
    - The plaintext cap is derived from the relay's 64 KiB envelope and is now 63,871 bytes (was larger than
      what the relay accepts); `encrypt` checks every ciphertext against the envelope.
    - A Welcome's tree is counted against the 256-device limit before the library verifies it.
    - After a commit, parent hashes are re-checked along the committer's path only: a receiver in a populated
      group of 64 devices takes about 60 to 80 ms per commit (was 130 to 145, slowest up to 870).
    - A sender adds a KeyPackage only while it has at least 24 hours left; the saved receive floor stores
      only relay acceptance times.
    - `isMlsEngineError`, `roleOf` and `sameIdentity` are removed (internal helpers with no caller).
    - A test holds the engine's copy of the MLSMessage header parser and its shared constants to the
      relay's (moving the parser to a shared module is tracked, not done).
- The UI ports grew to what the screens actually need: `ThemeTokens` to 15 `--msg-*` tokens, `IconSet` to 27
  names, `I18nBundle` to the sentences of the moved screens, and `MediaUpload` gained `peek` (the cached URL
  or nothing), with `MediaReader` as its reading half. Each growth comes with its fake and contract test.
- **Breaking, relay server and host token (review round 1, 2026-10-10):** the host takes the token's device
  from the signed session, not a header, and refuses a signed-out device; `adminOf` no longer names the admin,
  and a new `guardianOf` lists the minors an admin may register GUARDIAN devices for (a MASIA device only the
  operator principal may register); the token response adds `expiresIn` and clocks may disagree by 30 s. The
  relay deletes rows past `RELAY_BACKLOG_RETENTION_SECONDS` on a schedule with per-conversation sequence
  counters (numbers are never reused) and pages carry `oldestAvailableSeq`; a repeated commit, a message
  retried with its new optional `clientMsgId`, and a repeated group creation answer 200 with the original
  result; standalone proposals are refused (`HANDSHAKE_KIND_UNSUPPORTED`); a removed device reads up to its
  removing commit and then gets `REMOVED`; key packages carry `notAfter`, expire, and are capped and
  rate-limited per device; a device list read by a non-owner is contact-gated, rate-limited and public-only;
  database and request timeouts answer a stuck room with 503 `ROOM_BUSY` and `Retry-After`.
- **Breaking, relay server:** the access token is now an EdDSA (Ed25519) JWT with a fixed `iss` and `aud`, a
  lifetime of at most 10 minutes, and a `kid` header, issued by the host and verified by the relay with public
  keys only (`RELAY_TOKEN_PUBLIC_KEY`: one or more keys, so a key can be rotated). The shared HS256 secret
  (`RELAY_TOKEN_SECRET`) is removed, with no fallback: a token signed with it is refused like any other bad
  token. The claim names and limits are in `@masia/relay` (`RELAY_TOKEN_*`).
- `SecureStorage` (the port) now states what a host owes: values are device-bound (not synced, gone with the
  install), a failure is never reported as "nothing stored", and a request no store can hold is refused. Canon
  section 9.7 has the guarantees, including the honest limit of a web host: its non-extractable key hides
  values from casual browsing only and does not protect a copy of the disk (the key is stored beside the
  values); a wrapping secret that is not on the disk (WebAuthn PRF, or a server-released half) is a target.
- **Breaking, `SecureStorage` (after a review of the host stores):**
  - The error kinds are the port's: `SecureStorageError` with a `kind` of `unavailable`, `corrupt`,
    `invalid`, `conflict` or `failed` and a fixed message per kind, the `isSecureStorageError` guard,
    `isStorageClass`, and the limits (`SECURE_STORAGE_MAX_KEY_CHARS`, `SECURE_STORAGE_MAX_VALUE_BYTES`). A
    host no longer defines its own.
  - `clear(prefix)`, the sign-out wipe (`''` clears everything), is part of the port.
  - One writer per device: where several writers share one store (browser tabs), a write from a writer that
    has not seen the latest version rejects `conflict` instead of overwriting newer state.
  - The contract suite takes a harness and proves every kind: an unreachable store rejects `unavailable` for
    every call (a missing key included), a damaged value rejects `corrupt` while other keys still read, a
    stale second writer rejects `conflict`, plus copy-in, copy-out, the limits and `clear`.
- **Breaking: the assistant's device role is the generic `ASSISTANT`** (was `MASIA`; ADR-117 amendment (д),
  review round 1 M15). `DeviceRole.ASSISTANT`, the validator reason `ASSISTANT_ADD_FORBIDDEN` (was
  `MASIA_ADD_FORBIDDEN`), the `I18nBundle` key `devices.role.ASSISTANT` (was `devices.role.MASIA`) and the
  chip class `msec-chip is-assistant`. The credential byte (3) is unchanged, so existing leaves still decode;
  the relay's database enum value is renamed by a migration. A host maps the generic role to its own
  assistant in one place.
- The engine's constants, credential codes and header parsing come from `@masia/contracts/wire` instead of
  local copies; `mls/message-header.ts` is now an adapter that maps the contract parser's errors onto
  `MlsErrorCode`. The KeyPackage header now also reads the inner protocol version and cipher suite.
- The relay requires `RELAY_TOKEN_ISSUER` and `RELAY_TOKEN_AUDIENCE` (no default; they must differ) and has
  no default operator: without `RELAY_OPERATOR_USER_ID` no ASSISTANT device can be registered.
- The boundary guards (ESLint and dependency-cruiser) are allowlists: an open package may import
  `@masia/contracts`, itself, node builtins and its declared npm dependencies, nothing else.

### Removed

- Nine `I18nBundle` keys that no screen asked for (`room.*` and `device.*`, five and four), with their fake
  entries.
- The relay's own copies of the wire vocabulary, the header parser (`packages/relay/src/mls-header.ts`) and the
  token contract (`token.ts`, with its compiled-in issuer, audience and operator id), and the parity tests that
  held the copies together (`relay-parity.test.ts`, the relay's `retention-parity.test.ts`): one module
  makes them tautological.

### Fixed

- Joining a room that has held five or more devices (interop finding F1): ts-mls 1.6.4 refused a valid
  ratchet tree in which an unmerged leaf sits under a node whose ancestor was refreshed from the other half of
  the tree, so an Add could leave the newcomer unable to join. The repo now pins a patch of the library
  (`patches/ts-mls@1.6.4.patch`, applied by `pnpm install`) that checks what RFC 9420 section 12.4.3.1 asks:
  only the non-blank nodes between the leaf and the node that lists it, by membership, and the listed leaf is
  non-blank and a descendant of that node (stricter than the library was on that bullet). Tested in
  `src/mls/__tests__/ratchet-tree-unmerged-leaves.test.ts`; the OpenMLS interop run is green (19 of 19).
- Documentation drift (review round 1): the canon now describes the roles, `guardianOf` and the operator
  principal, and its web-device step no longer claims that a non-extractable key protects a disk image
  (section 9.7 already said it does not); `ARCHITECTURE.md` no longer calls the built `mls/` and `ui/` target;
  the interop README and test comments say K1 and S1 are green; two contradictory comments in `useMessenger`
  about who receives `msg:new` now agree with the code.

## [0.0.1] - 2026-10-10

### Added

- The skeleton of the open messenger: `@masia/contracts` (ten ports, an in-memory fake for each, and a
  contract-test suite per port), `@masia/messenger` (`createMessenger(ports)`, which only holds the ports for
  now), `@masia/relay` and `@masia/relay-server` (`GET /health`).
- The boundary guard: an ESLint `no-restricted-imports` block, a dependency-cruiser rule run as `pnpm boundary`
  in CI, and a negative-control test that proves both still fail when they should.
- The documents: the canon, the first two decision records, this changelog, a lessons file.

Not in it yet: the MLS core, client state, the UI core, the relay's storage. See the canon's status line.
