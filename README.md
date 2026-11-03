# Masia messenger

[![CI](https://github.com/masia-toots/masia-chat/actions/workflows/ci.yml/badge.svg)](https://github.com/masia-toots/masia-chat/actions/workflows/ci.yml)

End-to-end encrypted chats between people (MLS, RFC 9420), built so that an AI assistant can be a visible,
opt-in member of a room instead of a silent reader. This repository is the open core of that messenger:
the ports a host implements, the client core with its UI, a relay that delivers ciphertext and cannot read
it, and a playground that runs the whole thing on your machine.

It is **readable first**: the repository carries how it is built (the plan, the decisions, the lessons, the
log), not only the code. Start at [`packages/messenger/CLAUDE.md`](packages/messenger/CLAUDE.md), which says
where everything lives, then [`packages/messenger/docs/context.md`](packages/messenger/docs/context.md) for how
far it is today. The project is pre-1.0.

## What is here

| Directory | What | Licence |
| --- | --- | --- |
| [`packages/contracts`](packages/contracts) | The ports: the only surface the messenger and the relay share with a host, with in-memory fakes and the contract suites that prove an implementation | Apache-2.0 |
| [`packages/messenger`](packages/messenger) | The client: the MLS core, the state of a conversation, the UI core; and the documentation of the whole project | Apache-2.0 |
| [`packages/relay`](packages/relay) | The relay's delivery logic as a library | AGPL-3.0-only |
| [`apps/relay`](apps/relay) | The relay as a process: a Fastify server with its own database | AGPL-3.0-only |
| [`demo`](demo) | The playground: one command, two browser tabs, an encrypted chat through a local relay | Apache-2.0 |

Each directory carries its own `LICENSE`, and the `LICENSE` at the root is the Apache-2.0 text that covers
everything except where a directory says otherwise. The split is deliberate: what other people embed (the
client, the contracts, the playground) is Apache-2.0; the server is AGPL-3.0, so a fork of the relay stays open.
Copyright 2026 Masia Toots.

## Try it in five minutes

You need Docker with Compose v2.

```sh
git clone https://github.com/masia-toots/masia-chat.git
cd masia-chat/demo
docker compose up --build
```

Then open <http://localhost:8080> in two tabs, join with two names, and write. What is encrypted, what the
relay sees, and which shortcuts the playground takes are in [`demo/README.md`](demo/README.md).

## Develop

```sh
pnpm install
pnpm test                               # every package's unit and contract suites
pnpm typecheck
pnpm lint
pnpm boundary                           # who may import whom, resolved to files
pnpm docs:check                         # every relative link resolves, no forbidden token in the docs
pnpm forbidden-tokens                   # nothing private anywhere in what is published
```

The relay's database suites need a Postgres and are skipped without one; set `RELAY_TEST_REQUIRE_DB=1` to make
an unreachable database a failure instead (CI does).

How to contribute is in `CONTRIBUTING.md` (GitHub offers it on every new issue and pull request); how changes are made (plan first, contracts as the
condition for a merge, security review before crypto code) is in
[`packages/messenger/docs/protocol.md`](packages/messenger/docs/protocol.md). The boundary law, that the client
and the relay import only the contracts and never each other, and that the playground imports only the client
and the contracts, is enforced twice: by the lint config and by `pnpm boundary` at the root. CI
(`.github/workflows/ci.yml`) runs both, and every gate above.

## Security

A vulnerability goes through the private route in [SECURITY.md](SECURITY.md), never into a public issue.

## Maintainers

[MAINTAINERS.md](MAINTAINERS.md).
