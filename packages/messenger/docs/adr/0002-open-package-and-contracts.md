# 0002 — An open messenger: packages · contracts · the boundary · licences · a UI core

- **Status:** Accepted 2026-10-10 (design; execution is phase 1 of the open-messenger plan).
- **Date:** 2026-10-10
- **Decided by:** the founder. The wish: make the messenger open source, as the studio, the editor and the
  world already are; prepare for separate repositories and for isolation from the host application's
  environment; "we will have contracts, and a PR can be made only if all contracts are fulfilled"
  (2026-10-07). Then: the package takes the UI as well, to save effort (2026-10-10). Gates picked on
  2026-10-10: G1 drop history · G3 Apache-2.0 for the client and AGPL-3.0 for the server · G4 beta = chats
  with the founders · the UI is part of the core.
- **Builds on:** [0001](0001-e2ee-on-mls.md) (end-to-end encryption on MLS, two zones, first-class devices).
  The host project's neighbouring decisions (its messenger scope, contact circles with consent, its API
  code-generation rule) are private and are summarised here in words.
- **Amends:** 0001 §6 (history: **drop** instead of backup — see decision 7).
- **Canon:** [`../canon.md`](../canon.md).

## Context

0001 made end-to-end encryption of human chats the target. Cryptography that cannot be read from outside is
marketing, not security. The Signal precedent: trust comes from code that can be read, and from an open server,
so that it is visible what the server CANNOT do. The founder decided on 2026-10-07 that the messenger is an
open product, and the strategy lane turned that into a public commitment: this repository is the PROOF of the
approach, readable first.

Today the messenger is smeared across the host application — one page component of about 2,600 lines knows
about the dock, the universe scene, stickers and "lanes" — and a messaging service in the host's backend.
There is no boundary.

## Decision

1. **We open a PACKAGE, not an application.** Three packages in the monorepo from the first commit, ready for
   `git subtree split`:
   - `packages/contracts` — the ports (interfaces plus `*.contract.test.ts` with fakes). Protocol ports:
     `AuthSession` · `Transport` · `SecureStorage` · `PushBridge` · `PresenceDirectory`. **UI ports:**
     `ThemeTokens` (CSS variables as input, no import of the host's UI kit) · `IconSet` · `I18nBundle` (the
     `messenger.*` keys live in the package; the host mounts the namespace) · `MediaUpload` ·
     `RichAttachment` (stickers belong to the host's world, so they are a render slot).
   - `packages/messenger` — the **MLS core, the client state and the UI CORE** (conversation list · thread ·
     composer · contacts and circles · "Devices" · the room's security state · epoch system lines ·
     `useMessenger`). It does not know about families, persons, task engines, the ORM, the universe scene, the
     dock or stickers.
   - `apps/relay` (plus `packages/relay` as a library) — the delivery server: `Device`, `DeviceList`,
     `KeyPackage`, `ConversationE2ee`, `MlsHandshake`, the epoch serializer, generic push. A separate process
     and a separate database.

   The host application consumes the package and supplies the implementations of the ports (its dock, its
   in-app state, stickers, lanes and spaces stay in the host as adapters). The earlier decision that the host
   is one build and the messenger is a hook stays.

2. **Contracts are a condition of a PR.** The contract tests run in the package against fakes, and in the host
   against the real implementations; a host PR that touches the messenger is green only when both suites are
   green.
3. **The boundary first, the repository later.** `eslint no-restricted-imports` plus `dependency-cruiser` in CI:
   `messenger` and `relay` may import only `contracts` and their own dependencies; an import from the host's
   backend, app or UI kit is a red build. `subtree split` and publication are a separate gate of the founder
   after phase 1 is in production (publication is a production event).
4. **Licences (G3):** `messenger` and `contracts` (the UI included) — **Apache-2.0**; `relay` — **AGPL-3.0**.
   `ts-mls` (MIT) and `mls-rs` (Apache-2.0 or MIT) are compatible.
5. **Docs live in the package:** `packages/messenger/docs/{canon.md, adr/, CHANGELOG.md, lessons.md}` — the
   same texts, with human names; the host's lane keeps a pointer. An editorial pass (the founder's personal
   matters, production details, names) happens before publication; production access, backups and secrets
   live ONLY in the private monorepo.
6. **The crypto library is measured, not guessed (first step):** first `ts-mls` (pure TypeScript, no WASM, no
   `wasm-unsafe-eval` in the CSP, no Rust toolchain on the founder's box); `mls-rs` compiled to WASM if
   `ts-mls` does not pass the threshold (a commit on a 50-member group under 300 ms). A younger library means a
   mandatory security review before the first production byte.
7. **History at the switch is a DROP (G1 = A; amends 0001 §6):** a one-time purge of text and derived data,
   and a system line "encryption is on · history before this point was deleted". **A recovery key does not
   exist in phase 1** (there is nothing to back up); it arrives with media backups.
8. **Beta (G4 = C):** the DIRECT chats with the two founders (pinned for everyone; anyone can write) are
   switched to end-to-end encryption first; then ONE switch for all DIRECT and GROUP conversations. Locked
   chats are a development test only.
9. **Devices after the migration** — the source of truth is 0001 §2/§2a/§4/§5a; the step-by-step scenario
   (anchor device · linking by QR or code plus a signed `DeviceList` plus an Add into every group · a system
   line · the web as a weaker device · GUARDIAN · MASIA · Remove-then-revoke · self-Update) is in
   [`../canon.md`](../canon.md) § Devices.

## Consequences

- New packages and apps: `packages/contracts` · `packages/messenger` · `packages/relay` · `apps/relay` (its own
  deployment, domain and database — an infrastructure gate decided outside this repository).
- The host's large messenger page is taken apart, not copied: the line between "what knows about the universe"
  and "what knows about a conversation" is drawn by the lead; the disassembly is mechanical, along a map.
- `useMessenger` moves out of the host's shared package into this package; the host consumes it back.
- This overrides an earlier strategy position ("open source not before the paid launch").

## Rejected

- A separate repository from day one (two weeks of tooling instead of cryptography).
- Opening only the protocol plus a reference UI ("an open messenger" without a UI is a library).
- Moving the host's page wholesale (the package would then know about the universe).
- AGPL everywhere (nobody would embed the client).
- MIT everywhere (a closed fork of the relay).
- Backing up history as 0001 §6 had it (an extra evening and a recovery-key UX before it is needed; the
  founder: drop).

## Review trigger

After phase 1 is in production: did the boundary hold (zero exceptions in the guard); the actual library and
its benchmark; the date of the first public repository; the first external PR against the contracts.

## Amendments

Added later the same day (2026-10-10); the text above is unchanged.

- **Decision 5 (docs) is widened: the whole "kitchen" lives in the package.** The founder asked to show how the
  project is run, not only what it decided: `CLAUDE.md` (a router) · `docs/ARCHITECTURE.md` ·
  `docs/context.md` · `docs/canon.md` · `docs/protocol.md` · `docs/experience.md` (renamed from
  `lessons.md`; an index, with `docs/experience-archive.md` holding the cases) · `docs/log.md` (chronology) ·
  `docs/CHANGELOG.md` (releases only) · `docs/adr/`. Same layout as the host project's own working space, with
  human names and the editorial rules in [`../../CLAUDE.md`](../../CLAUDE.md).
- **Decision 8 (beta) is replaced: gate G4 = B, one switch for all, no beta channel.** After the tests pass
  (the crypto review checklist of [0005](0005-security-review-conditions.md), an interoperability run against a
  second MLS implementation, a run on a real phone's browser engine), ALL direct and group conversations switch
  in one step. Locked chats remain a development test only. Cost, accepted: the first real decryption error
  would be a user's, so the tests must pre-empt it. The founder's earlier reading (G4 = C, the founders' chats
  first) is superseded.
- **Decision 1, ports:** the port formerly called `PresenceDirectory` is now `ContactsDirectory` (it carries the
  address book, circles, groups and requests as well as the consent gate); the old name is a deprecated alias
  for one release. Ten ports in all.
