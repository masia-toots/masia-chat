# Log: how the open messenger got here

A dated chronicle of decisions and steps, **newest first**, each as What / Why / Files / Decision / Next. It
is the "why" behind [`CHANGELOG.md`](CHANGELOG.md) (which lists releases only) and it never rewrites an old
entry. Step names (K0 to K14) are those of the working plan ([`protocol.md`](protocol.md)); the plan file itself
lives in the host project's private working space, so the entries below carry what it decided. The state today
is in [`context.md`](context.md). "Lead" is the AI session that plans and reviews; an "agent" does one step.
Entries are added at the top. Times are agent working time, not elapsed days.

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
