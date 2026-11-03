# Architecture

Four packages, one rule: the client and the relay know the host application only through the **ports** in
`@masia/contracts`. The spec (what and why) is [`canon.md`](canon.md); this page is the map. "Target" marks what
is designed but not yet in the tree; [`context.md`](context.md) has the exact state.

## Packages

| Package                              | Role                                                                                                                                                                                                                                                                                                                                                                       | License    | State                                                                                                                                                                                                                                                                      |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@masia/contracts`                   | The ports (interfaces), an in-memory fake of each, one contract suite per port; and `@masia/contracts/wire`, the ONE home of the wire vocabulary (device roles and credential layout, id shape, size limits, retention, the MLS profile, the cleartext MLS header parser, the relay token's claims). The root of the dependency graph: imports nothing from the workspace. | Apache-2.0 | built                                                                                                                                                                                                                                                                      |
| `@masia/messenger`                   | The client core. `protocol/` the wire types and codec · `hooks/` `useMessenger` · `contacts/` contact model, circles, groups · `mls/` the `MlsEngine` interface and its library adapter · `ui/` conversation list, thread, composer, contacts, Devices screen, security state                                                                                              | Apache-2.0 | built: protocol, hooks, contacts, `mls/` (engine and validator), `ui/` (screens against the ports). Target: the host feeding the UI from the engine, the relay path replacing the interim JSON protocol. _Until 2026-10-10 this row still called `mls/` and `ui/` target._ |
| `@masia/relay`                       | The relay as a library: re-exports `@masia/contracts/wire`, adds the relay-only limits, one error-code table and pure rules (device-list versioning, TTL counters). No I/O. _Until 2026-10-10 it kept its own copy of the wire vocabulary, the header parser and the token contract._                                                                                      | AGPL-3.0   | built                                                                                                                                                                                                                                                                      |
| `@masia/relay-server` (`apps/relay`) | The relay as a process: Fastify, its own Postgres database, the epoch serializer, the HTTP API.                                                                                                                                                                                                                                                                            | AGPL-3.0   | built (verifies EdDSA access tokens by public key; the host mints them)                                                                                                                                                                                                    |

## The boundary

```
        host application (UI + backend of its own choosing)
                 |  implements the ten ports
                 v
   +--------------------------------------------+
   | @masia/contracts                           |
   | 10 ports - fakes - contract suites         |
   | imports nothing else from the workspace    |
   +----------^-----------------------^---------+
              | only this             | only this
   +----------+-----------+   +-------+--------------+
   | @masia/messenger     |   | @masia/relay         |
   | client + UI core     |   | + @masia/relay-server|
   +----------+-----------+   +-------^--------------+
              |                       |
              +-----------------------+
                wire protocol: HTTP + byte topics

   allowed: @masia/contracts, the package itself, node builtins, its declared npm dependencies
   anything else is forbidden: host code, workers, tools, messenger <-> relay, the host's ORM client
```

Two guards enforce it, both as an **allowlist** (since 2026-10-10; until then they listed the host's packages):
ESLint `no-restricted-imports` (import text) and dependency-cruiser (`pnpm boundary`, resolved files,
`import type` included). A negative-control test proves both still fail when they should.

## The ports

| Port                | What the host supplies                                                                                                                                                                  |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AuthSession`       | who is signed in, the stable per-install device id, a currently valid relay access token (short-lived, minted by the host), sign-out notifications                                      |
| `Transport`         | `fetch(path, init)` and `subscribe(topic, cb)` to the relay; base URL, auth header, sockets and retries stay host-side; bodies are bytes                                                |
| `SecureStorage`     | key material by access class (`identity`, `history`, `push`): Keychain, Keystore or WebCrypto-wrapped IndexedDB                                                                         |
| `PushBridge`        | the platform push channel reduced to a content-free "something is new in room X" signal                                                                                                 |
| `ContactsDirectory` | the host's address book and consent gate: who may be addressed, display data, contacts, circles, groups, requests, search, and their writes (`PresenceDirectory` is a deprecated alias) |
| `ThemeTokens`       | values for the 16 CSS custom properties (`--msg-*`); the whole styling surface                                                                                                          |
| `IconSet`           | a renderer for a closed list of icon names                                                                                                                                              |
| `I18nBundle`        | translated strings for the closed list of `messenger.*` keys, in `uk`, `en`, `de`                                                                                                       |
| `MediaUpload`       | storing a media blob and resolving its id back to a URL                                                                                                                                 |
| `RichAttachment`    | a render slot for host-owned attachment kinds such as stickers                                                                                                                          |

## Data flow

```
host app ─ports─▶ createMessenger(ports) ─▶ hooks / (mls, ui) ─▶ Transport ─▶ relay ─▶ relay database
                                                                      ◀── bytes: handshakes, envelopes ──
```

**Today** `protocol/` speaks the host's existing JSON protocol through `Transport` by a fixed convention: events
as JSON bytes on the topic `msg:`, link state on `messenger:connection`, commands POSTed to
`/messenger/command`. When the relay path replaces it, the convention and the host adapter go together.

**Handshake path (client engine and relay built; the host wiring them together is target).** To add a person's device: the committer claims a key package
(`POST /key-packages/claim`) and reads the owner's signed list (`GET /users/:id/device-list`) → `MlsEngine`
builds Commit and Welcome locally → `POST /conversations/:id/handshakes` with the epoch it built on and the
member change it declares → in **one transaction** the relay locks the conversation row (`SELECT … FOR UPDATE`):
stale epoch → `409 {currentEpoch}` and the client rebases; fifth lost race in a row → `429`; then the cleartext
MLSMessage header must match the room (`422`), the declared change must be allowed (guardian removal only by an
admin of that user, no revoked or unlisted device, each Add names a key package this committer claimed), then
the handshake is stored and the epoch advances. Members read `GET /conversations/:id/handshakes`, compare the
declared change with what the **decrypted** commit really does, and reject a lie.

**Envelope path.** `MlsEngine.encrypt` → `POST /conversations/:id/envelopes` with the epoch (current epoch only,
else `409`) → the relay stores the ciphertext it cannot read → members `GET` it, from the epoch they joined in.
Push for a room is generic ("something new in room X"); the device fetches and decrypts locally.

## The E2EE model on one screen

This is the design in [`canon.md`](canon.md). The relay enforces its half; the client half (`mls/`, the
validator that checks every incoming commit) is built too. _Until 2026-10-10 this said the client half was
target._

- **Two zones.** Conversations with Masia are server-readable and say so; conversations between people are the
  end-to-end zone. "End-to-end" is never claimed for the first.
- **Devices are first-class.** One install = one device id = one MLS leaf, with a role in its credential:
  `USER`, `GUARDIAN` or `ASSISTANT` (until 2026-10-10 spelled `MASIA`). A session token points at a device,
  never the other way round. The household model behind the roles (`adminOf`, `guardianOf`, the operator
  principal) is in [`canon.md`](canon.md#roles-and-principals-the-household-model-in-the-wire).
- **Access token.** The host mints it and the relay only verifies it. It is an EdDSA (Ed25519) JWT with an
  `iss` and `aud` the relay is configured with (no default in the open code; fixed until 2026-10-10), naming the user (`sub`) and the device (`did`), valid for at most 10 minutes, with a `kid`
  header that picks one of the relay's public keys (a short list, so a key can be rotated). The relay holds no
  signing secret and so cannot mint a token; a shared-secret (HS256) token is refused, and so is any other
  algorithm, issuer, audience or unknown key, always with the same answer.
- **Signed device list.** A person's devices are listed in a `DeviceList` signed by their identity key. A client
  accepts an Add only if the new leaf is in the owner's signed list, so a server cannot slip in a ghost device.
  The relay stores the list, requires the next version to be exactly +1, and never signs one.
- **Guardian.** A parent's device on a child's account carries a badge shown to everyone in the room. Only an
  admin of that child may remove it (the token's `adminOf` lists the child); the relay refuses anyone else.
- **Masia as a device.** Her leaf is per conversation, in the group only while her mode is not silent; her keys
  live in a custody service outside the messenger's database and API process (in the reference host, a
  separate worker that talks to the relay as the operator principal's devices).
- **Epoch serializer.** MLS needs one order of commits. The relay is that order: a row lock, one winner per
  epoch, `409` for the rest. It orders opaque bytes; clients, not the relay, validate them.

| The relay sees                                          | The relay does not see                                                                                     |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| user ids, device ids, device roles, signed device lists | message text: ciphertext only, and **no plaintext column exists** (a test fails the build if one is added) |
| which conversation, which epoch, when, how large        | any group secret or private key                                                                            |
| the roster _as declared_ by committers                  | the content of a commit; it reads only the cleartext header (group id, epoch, content type)                |
| key packages and who claimed them                       | whether a declared member change is true; the clients check that                                           |

It is metadata-visible by design: "sealed sender" is not claimed. The honest limits are in
[`canon.md`](canon.md#honest-limits).

## Repo layout

```
packages/contracts/   src/ports · src/fakes · src/contract-tests · src/wire (the wire vocabulary) · src/__tests__ (boundary negative control)
packages/messenger/   src/protocol · src/hooks · src/contacts · src/mls · src/ui · docs/ · scripts/
packages/relay/       src/protocol.ts (relay-only limits) · errors.ts · device-list.ts · ttl-counter.ts
apps/relay/           src/ (server · auth · epoch-serializer · routes/ · domain/) · prisma/ (schema, migrations) · openapi.json
```

The relay's HTTP API is described by `apps/relay/openapi.json`, generated from the route schemas.
