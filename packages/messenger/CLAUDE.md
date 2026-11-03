# Open Masia messenger — rules for a working session (router)

> **A router, not a manual.** It says where each rule lives. A router that retells drifts, so **a new rule goes
> to its home file, never here.** Target: this file stays under ~3k tokens.

## Who we are

An open core for **end-to-end encrypted chats between people** (MLS, RFC 9420), where an AI assistant, Masia,
is a **visible, opt-in member** of a room instead of a silent reader. Client packages are Apache-2.0, the relay
(server) is AGPL-3.0. We are **readable first**: the repo shows how it is built (plan, decisions, lessons, log),
not only the code. Today it is pre-1.0 and partly built; [`docs/context.md`](docs/context.md) says exactly how far.

## Where the rules live

| Need | Home |
| --- | --- |
| What this is, why it is shaped this way, devices, honest limits (**the spec**) | [`docs/canon.md`](docs/canon.md) |
| Packages, ports, data flow, the E2EE model on one screen, repo layout | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) |
| State now, next steps, chosen designs, open questions | [`docs/context.md`](docs/context.md) |
| How we work: plan, gates, agents, report, commits, reviews | [`docs/protocol.md`](docs/protocol.md) |
| Decisions with the alternatives we rejected (immutable) | [`docs/adr/README.md`](docs/adr/README.md) |
| What we learned (rules, one to three lines each) · the full cases | [`docs/experience.md`](docs/experience.md) · [`docs/experience-archive.md`](docs/experience-archive.md) |
| Chronology of decisions and steps (what / why / files / decision / next) | [`docs/log.md`](docs/log.md) |
| Releases | [`docs/CHANGELOG.md`](docs/CHANGELOG.md) |
| The ports and their contract suites | `../contracts/src/ports` · `../contracts/src/contract-tests` |

**Read order for a new session:** this file, then `docs/context.md`, then `docs/canon.md` for the area you touch.
Read `docs/experience.md` (headings only) before a design or a crypto decision, `docs/log.md` for the newest
entries. Load what the task touches; do not read the rest speculatively.

## The boundary law

- This package may import **only `@masia/contracts` and its own npm dependencies.** Nothing from the host
  application (its apps, backend, shared UI and i18n packages, ORM client). `messenger` and `relay` never import
  each other: they meet only through the wire protocol and the contracts.
- **A need that seems to require an import is a missing port.** Add the port to `packages/contracts` with a
  fake and a contract suite; never cross the line.
- **Two guards, both blocking:** the ESLint `no-restricted-imports` block (reads import text) and
  dependency-cruiser, `pnpm boundary` (resolves every import to a file, `import type` included). A
  negative-control test proves each still fails when it should.
- **Contracts are the PR condition.** Every port has a contract suite. It runs here against the in-memory fakes
  and in the host against its real implementation. A change is mergeable only when both are green.
- **A file moves into this package only with its tests.** The host re-exports for one release, then drops it.

## Run it

```sh
pnpm install
pnpm -F @masia/contracts -F @masia/messenger -F @masia/relay -F @masia/relay-server test   # unit + contract suites
pnpm -F @masia/messenger typecheck && pnpm -F @masia/messenger lint
pnpm boundary                          # the dependency-cruiser guard (CI, blocking)
pnpm -F @masia/messenger docs:check    # every relative link resolves, no forbidden token in the docs
```

The relay-server tests use a real Postgres and are skipped without one; set `RELAY_TEST_REQUIRE_DB=1` (CI does)
to make an unreachable database a failure instead.

## How we work

[`docs/protocol.md`](docs/protocol.md) is the whole story. In four lines: **plan first, code after an explicit
go**; **one agent = one step**, in its own worktree, reviewed by the lead before it merges; **gates stop us**
(licences, history, prod, infrastructure, anything irreversible); **security review precedes crypto code.**
Commits are Conventional Commits, staged by explicit path (never `git add -A`), never amended or force-pushed.

## How to propose a change

1. A design choice that fixes a shape or rejects an alternative: a new [ADR](docs/adr/README.md) (next number,
   never edit an accepted one; amend or supersede with a new record).
2. Update [`docs/canon.md`](docs/canon.md) **in the same PR** (the canon is WHAT and WHY, the code is HOW).
3. Add an entry at the top of [`docs/log.md`](docs/log.md); sharpen [`docs/experience.md`](docs/experience.md) if you
   learned a rule; refresh [`docs/context.md`](docs/context.md) if the state or the next steps moved.
4. A new or changed port: fake plus contract suite in `packages/contracts`, same PR.
5. Run the four commands above. A PR is not ready until they are green.

## Code discipline (the whole list, deliberately short)

TypeScript strict, no `any` (use `unknown` and narrow) · named exports only · no magic strings or numbers
(extract a `const`) · files `kebab-case` · **one source of truth:** before adding a value, type or rule, find
its home and use it, never copy · every async function handles or propagates its error · validate input at every
boundary · no secrets in code or logs · pin dependencies, review a new one before adding it · a bug fix ships
with the test that would have caught it · tests do not depend on order and do not mock the database layer.

## Editorial rules for public docs (checked by `docs:check`)

These files are read by strangers. Therefore: **English**, terse, concrete · **roles, not personal names** ("the
founder", "the maintainer", "the reviewer", "a family member") · no hostnames, domains, emails, ports or
secrets of any deployment · no infrastructure or production access details · no names of other projects · **no
paths into any private repository**: cite a private decision as "internal ADR-117 (summarised in
[adr/0001](docs/adr/0001-e2ee-on-mls.md))" and copy the needed substance here instead of linking out · relative
links only, and they must resolve · say "target" for what is not built yet and never claim more than the code
does.
