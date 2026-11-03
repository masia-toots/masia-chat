# @masia/messenger

An open messenger core: end-to-end encrypted human chats on MLS (RFC 9420), with Masia, an AI assistant, as
a visible, opt-in member of a room instead of a silent reader. The package does not know its host
application; it talks to the world only through the ports in `@masia/contracts`.

**Status: pre-1.0, version 0.0.1.** Built and tested:

- the ten ports, each with an in-memory fake and a contract suite, and the boundary guard;
- the client's wire protocol, `useMessenger` and contacts;
- the MLS engine (`@masia/messenger/mls`): `ts-mls` behind our own `MlsEngine`, a validator for every
  incoming commit, and an interop suite against OpenMLS (needs Docker);
- the UI core (`@masia/messenger/ui`): conversation list, thread, composer, contacts and circles, the Devices
  card and the security state of a room;
- a relay (own database, epoch serializer, device and key-package API) and a [playground](../../demo/README.md).

Not in this package: the runtime that drives the engine against the relay (commits, one writer per room,
enrolling devices). The first host and the playground each carry one, so `createMessenger` is still only a
holder of the ports, not a messenger that works out of the box. Still open: linking a new device, and a run on
a real phone.
[`docs/context.md`](docs/context.md) says exactly where we are; nothing here claims more than the code does.

## Read first

- [`docs/canon.md`](docs/canon.md) — what this is and why it is shaped this way, including the device model
  and the honest limits.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — the map: packages, ports, data flow, the E2EE model on one
  screen.
- [`docs/adr/`](docs/adr/README.md) — the decisions, with the alternatives we rejected.
- [`docs/CHANGELOG.md`](docs/CHANGELOG.md) · [`docs/log.md`](docs/log.md) — releases, and the chronicle of why.

## How it fits together

- `@masia/contracts` (Apache-2.0) — the ports, an in-memory fake of each, and a contract suite per port.
- `@masia/messenger` (this package, Apache-2.0) — the client core.
- `@masia/relay` and `@masia/relay-server` (AGPL-3.0) — the delivery server.

A host supplies a real implementation of each port. A contract suite runs against the fake here and against
the host's implementation there; a change is mergeable only when both are green. Importing anything from the
host is a red build: add a port instead.

## What a host provides

Five ports for the protocol side:

- `AuthSession` — who is signed in, the device id, a short-lived token for the relay;
- `Transport` — requests and subscriptions to the relay;
- `SecureStorage` — key material, in three access classes. The package ships the port and a fake, no
  implementation: the first host backs it with the Keychain, the Keystore and, on the web, a wrapped
  IndexedDB;
- `PushBridge` — content-free "something is new in this room" signals;
- `ContactsDirectory` — who may be addressed.

Five for the screens: `ThemeTokens`, `IconSet`, `I18nBundle`, `MediaUpload` and `RichAttachment`.

Beyond the ports, the host mints the relay token (the relay checks it against a public key) and runs the
engine: where it lives (the first host uses a Worker) and how it talks to the relay is the host's choice,
described in [canon section 11](docs/canon.md#11-the-hosts-engine-a-worker-and-what-this-device-means).

## Try it

[`demo/`](../../demo/README.md) is a playground: `docker compose up --build`, open two tabs, chat end-to-end
encrypted through a relay on your machine. It is a client of this package (the UI core) and of
`@masia/contracts`, nothing else, and it says plainly what is encrypted and what the relay sees.

## Run the tests

```sh
pnpm install
pnpm -F @masia/contracts -F @masia/messenger -F @masia/relay -F @masia/relay-server test
pnpm -F @masia/contracts typecheck
pnpm boundary
pnpm -F @masia/messenger docs:check   # links resolve, no forbidden token in the docs
```

## How this was built

We show the kitchen, not only the dish. This package is built by a small team: a founder who decides, and AI
coding sessions that plan, build and review under written rules. We say so plainly, because it is also the
method.

1. **Plan first, code after a go.** Every effort starts as a written plan: goal, gates, steps, a chronicle.
   Nothing is built until the founder says go. A design goes through an independent critic before it is
   accepted ([protocol](docs/protocol.md)).
2. **Gates stop us.** A human decides licences, publication, irreversible actions on user data, and anything
   about production. The gates so far: what to do with old history (drop it), where the relay lives (its own
   process), licences (Apache-2.0 client, AGPL-3.0 relay), rollout (one switch, no beta).
3. **One agent, one step.** The lead session writes a brief; an agent does exactly one step in its own git
   worktree and ends; the lead reads the diff and re-runs the checks before anything merges. A cheaper model
   tier does steps that a test can judge; the strongest tier does design, review and cryptography.
4. **Contracts and the boundary are the merge condition.** Every port has a contract suite; an import from the
   host is a red build; a file moves only with its tests.
5. **Reviews before risk.** A security review ran before any client cryptography. It found two authorisation
   holes in code that had passed its own tests; a hardening step fixed them first
   ([ADR 0005](docs/adr/0005-security-review-conditions.md)). The cryptographic library was measured, pinned and
   put behind our own interface ([ADR 0003](docs/adr/0003-ts-mls-behind-mls-engine.md)).
6. **Every decision lands in a file.** ADRs are immutable, the canon says what and why, the code says how, the
   [log](docs/log.md) keeps the order, and [experience](docs/experience.md) keeps what we learned, with the
   [cases](docs/experience-archive.md).

**What is ahead:** moving the room runtime into the package so a host does not write its own, Masia's place
in a room (the host's side is only partly built), linking a new device, a run on a real phone, and one switch
for all conversations in the first host after that run. Four design amendments wait for a decision
([context](docs/context.md#open-questions)).
Calls and media are phase 2. The working rules for a session are in [`CLAUDE.md`](CLAUDE.md).

## License

Apache-2.0. See [`LICENSE`](LICENSE).
