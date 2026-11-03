# Context: where the open messenger stands

The current state, the designs we chose (and why), what comes next and what is still undecided. Read this
second, after [`../CLAUDE.md`](../CLAUDE.md). It is rewritten whenever the state moves; the chronology is in
[`log.md`](log.md), the spec in [`canon.md`](canon.md). **State as of 2026-10-10**, pre-1.0, version 0.0.1.

Steps are named K0 to K14 in the working plan ([`protocol.md`](protocol.md)); this page uses the same names.

## State today

| Where                                                    | What exists                                                                                                                                                                                                                                                                                                                                                                                                                                                             | What is stubbed or missing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts`                                     | Ten ports; an in-memory fake and a contract suite for each; `@masia/contracts/wire`, the one home of the wire vocabulary (roles, id shape, limits, retention, MLS profile, header parser, relay token claims); a negative-control test of the boundary guard. 451 tests (2026-10-10; was 131 before the wire module).                                                                                                                                                   | A real host implementation of any port lives in the host, not here.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `packages/messenger/src`                                 | `createMessenger(ports)`, which only holds the ports. `protocol/`: the `msg:*` wire types and the codec over `Transport` (the interim wire). `hooks/`: `useMessenger`. `contacts/`: the contact model, `useContactCircles`, `useGroups`, all against `ContactsDirectory`. `mls/`: the `MlsEngine` and its receive-side validator, over the wire module. `ui/`: the screens against the ports. 569 tests, plus 19 interop scenarios skipped without Docker (2026-10-10). | No device linking. No room runtime: nothing in the package drives the engine against the relay (commits, one writer per room, enrolment), so `createMessenger` still only holds the ports; the first host and the playground each carry their own. No `SecureStorage` implementation either, by design: the package ships the port and a fake, and the host's Keychain, Keystore and web stores live in the host. _Until 2026-10-10 this cell said "No MLS yet" and "No UI yet"; until 2026-11-03 it said "no secure-storage plugin" and "the host does not yet feed the UI from the engine". All stale._                                                                  |
| `packages/messenger/src/ui/security` (K5b)               | The security state of a room as components against a state value: the zone badge and its sheet, the guardian ribbon, the stall banner, the role and verified marks in the Devices card, and the epoch system row. `ConversationSecurityState` (`protocol/`) and the `security` source on `MessengerUiProvider` are the one wiring point. Tests against a fake source.                                                                                                   | **Filled since 2026-10-10 (K8 wiring)** by the first host, from the engine in a Worker: zone, epoch, security code, devices, this device, sending, read-only, removed, history gap, sign-in. Still empty: guardians and device names (they need the host's signed device lists), so the engine admits no member it cannot check and a room another device joins stays `pending` until enrolment is built. _Until 2026-10-10: "Nothing fills the source yet"._ The thread has no system-row slot, so the epoch lines are not interleaved. Add-a-device and the leaf and self-Update counts are not drawn.                                                                   |
| `packages/messenger/src/mls/__tests__/interop` (K8-prep) | An interop run of `MlsEngine` against OpenMLS 0.9.1 in a pinned container (`pnpm test:interop`, needs Docker, skipped otherwise): groups made by either side and joined from the other's Welcome, Add, remove, self-update, messages both ways, three seeded random sequences, and the refusals checked against real OpenMLS output. 19 scenarios, about 30 s. Our credential layout, the `0xf0c1` extension and the AAD frame are accepted by OpenMLS in every case.   | **Green, 19 of 19, with a patched library:** the one defect it found (F1: ts-mls 1.6.4 refused to join a valid tree in which an unmerged leaf sits under a node whose ancestor was refreshed from the other half of the tree, minimal case `K1`, hit by engine devices alone in a room that has held five or more devices) is fixed by a pinned patch of the library to RFC 9420 section 12.4.3.1 (canon section 9.7, "Patched library check"); upstream report pending. Not covered: a commit without an UpdatePath (stock OpenMLS never builds one), other OpenMLS versions or cipher suites, offline backlog. See [its README](../src/mls/__tests__/interop/README.md). |
| `packages/relay`                                         | Re-exports `@masia/contracts/wire` (where the vocabulary and the fuzzed MLSMessage header parser now live) and adds the relay-only limits, one error-code table, device-list version rule, TTL counters. 91 tests (2026-10-10). _Until 2026-10-10 it kept its own copies of the vocabulary, the header parser and the token contract._                                                                                                                                  | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `apps/relay`                                             | Own Postgres schema and migrations (devices, device lists, key packages and their claims, conversations, handshakes, envelopes, room members); the epoch serializer; the HTTP API (`openapi.json`); auth verification; hardening from the first security review and review round 1. 313 tests against a real database (2026-10-10).                                                                                                                                     | Tokens are EdDSA (Ed25519) JWTs with `iss`, `aud` (configured: `RELAY_TOKEN_ISSUER`, `RELAY_TOKEN_AUDIENCE`, no default), `kid` and a 10-minute life, minted by the host and verified here by public key (no shared secret, no HS256). Key-package claims are neither consumed nor expired. Deployment, TLS and backups are decided outside this repository.                                                                                                                                                                                                                                                                                                               |
| Guards                                                   | ESLint `no-restricted-imports` plus dependency-cruiser (`pnpm boundary`, 268 modules, no violations), both as an allowlist: an open package imports `@masia/contracts`, itself, node builtins and its declared npm dependencies only. Both blocking in CI. _Until 2026-10-10 they listed the host's packages (a blocklist)._                                                                                                                                            | ESLint reads import text only, so a relative climb into another package is caught by dependency-cruiser alone.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Docs                                                     | The kitchen: this folder (K10).                                                                                                                                                                                                                                                                                                                                                                                                                                         | `docs:check` verifies links and forbidden tokens only; it does not prove the prose is true.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

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
   attachments come through `ThemeTokens`, `IconSet`, `I18nBundle`, `MediaUpload`, `RichAttachment`. Why: the
   repository is shown as proof of an approach, and the proof needs a screen. →
   [ADR 0002](adr/0002-open-package-and-contracts.md).
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

## Next steps

1. **K3: the client's MLS core.** _Built (see State today); kept here for the record._ `MlsEngine` over ts-mls with the receive-side validator, group state in
   `SecureStorage`, the self-update schedule, a failed decryption shown as a security state of the room. Its
   acceptance is the "must before K3 code" checklist in [ADR 0005](adr/0005-security-review-conditions.md),
   including a check that the member change the relay serves equals what the decrypted commit does.
2. **K4: the host issues the relay token, and Masia gets her place in the room.** EdDSA token with audience,
   issuer and a short life, carrying the scope of users an admin may act for; her per-conversation key in a
   custody service; mode and membership as one fact.
3. **K5: the UI core moves in.** The conversation view, composer, contacts, and the new zone badge, guardian
   badge, Devices screen and epoch lines; each file moves only with its tests. _K5a (the screens) and K5b (the
   security-state UI) are built. Wiring, 2026-10-10: the web host fills `SecurityStateSource` from the engine
   running in a Worker (canon section 11). Next: the membership and custody facts (K4b) for guardians and
   device names, and a system-row slot in the thread for `EpochSystemRow`._
4. **K6: the secure-storage plugin.** _Built in the first host, outside this package (2026-10-10); kept here for
   the record._ A native implementation of `SecureStorage` (Keychain, Keystore) with the three access classes,
   and a wrapped IndexedDB on the web behind the same port
   ([canon section 9.7](canon.md#97-choices-made-on-purpose-and-known-limits)). Still open: a native Worker
   bridge, so the stored bytes need not pass the page
   ([canon section 11](canon.md#11-the-hosts-engine-a-worker-and-what-this-device-means)).
5. **K7: the purge.** Erase text and every derived copy for each direct and group chat, plus a nightly assertion
   that no encrypted conversation holds plaintext. **Irreversible: a gate.**
6. **K8: the one switch.** Deploy, interoperability run, real-device run, then the switch and the purge;
   splitting the packages into their own repositories is a separate gate after that.
   _K8-prep, desktop WebKit run, done 2026-10-10 ([canon section 8](canon.md#8-the-crypto-library-is-measured-not-guessed)):
   the engine runs under a strict policy with no `eval` and no WebAssembly, every scenario passes, and an Add
   in a group of 50 took 172 ms p95 in a Worker (budget 300 ms). It stands in for the phone and does not
   replace it: that WebKit build is not Apple's, lacks Ed25519 and X25519 in WebCrypto (a bench-only stand-in
   filled in), and stalls the page thread on every WebCrypto round trip. The device run must show the
   per-call WebCrypto latency (the Add makes about 1100 calls, so it must stay under about 0.27 ms), that
   Ed25519 and X25519 exist on the oldest supported OS, whether the page thread stalls, the effect of
   thermal and low-power throttling, and that a module Worker loads under the app shell's policy. It also
   bears on open question D: MLS state belongs in a Worker, and the Worker needs its own policy header._
   _K8 wiring, host side, 2026-10-10 (canon sections 10 and 11): the engine runs in the web host's module
   Worker with its own policy (no `eval`, checked at start), pending commits per section 9.7, one writer per
   room across tabs, the payload inside the ciphertext, the relay token's lifecycle and the sign-out wipe;
   a room is encrypted only when the host's inbox says `e2ee: true`. Still missing on the host's api: signed
   device lists for the directory, KeyPackage and Welcome enrolment, the `e2ee` field in the inbox, the
   relay's public URL (to pin the Worker's `connect-src`), reactions keyed by payload id, and a push from the
   relay (the Worker polls). The phone run (WebCrypto latency, the Worker policy in WKWebView) is still open._

Phase 2 (media and calls) starts only after phase 1 is in production, with its own ADR.

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
  _The Worker part is built on the web host (2026-10-10, canon section 11); Trusted Types and native-only
  guardians are still open._

## Links

- Spec: [`canon.md`](canon.md) — [two zones](canon.md#1-two-zones) · [devices](canon.md#3-devices) ·
  [history](canon.md#4-history-at-switch-on) · [what the relay sees](canon.md#5-what-the-relay-sees) ·
  [the boundary](canon.md#6-the-boundary-and-the-ports) · [honest limits](canon.md#honest-limits)
- Map: [`ARCHITECTURE.md`](ARCHITECTURE.md) · Method: [`protocol.md`](protocol.md)
- Decisions: [`adr/README.md`](adr/README.md) · Lessons: [`experience.md`](experience.md) ·
  Chronology: [`log.md`](log.md) · Releases: [`CHANGELOG.md`](CHANGELOG.md)
