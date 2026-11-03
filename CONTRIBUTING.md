# Contributing

Thank you for looking. This is a small project with a strict shape; the shape is what keeps the messenger
embeddable, so it is worth reading before you write code. The full working agreement is in
[`packages/messenger/docs/protocol.md`](packages/messenger/docs/protocol.md); this page is the short version.

## The one rule: contracts

The client (`packages/messenger`), the relay (`packages/relay`, `apps/relay`) and the playground (`demo`) meet
a host only through the ports in [`packages/contracts`](packages/contracts). A change that needs something new
from the host adds a **port**, never an import across the boundary.

A pull request is **green only when the contract suites pass twice**:

1. in the package, against the in-memory fakes (`pnpm test`); and
2. against a host: the same suites run over a real implementation of the ports. The playground's adapter
   (`demo/src/host`) is the host in this repository; if you change a port, show the suite passing against it
   (or against your own host, and say so in the pull request).

If you change a port and cannot run the second half, say so; the maintainers will run it before merging.

## Before you open a pull request

```sh
pnpm install
pnpm typecheck
pnpm lint
pnpm test                # the relay's database suites need a Postgres; see the README
pnpm boundary            # who may import whom, resolved to files (dependency-cruiser)
pnpm docs:check          # every link and anchor resolves
pnpm forbidden-tokens    # nothing private in what is published
```

CI runs exactly these (`.github/workflows/ci.yml`), plus a secret scan (gitleaks) over the tree and its history;
a red gate blocks the merge, and `boundary` has no debt to hide behind. The boundary is enforced twice on
purpose: the lint config reads the import text, `pnpm boundary` resolves it. A public test vector or a
throwaway test key that the secret scan flags goes into `.gitleaks.toml` with the reason; a real credential is
never allowed there, it is rotated.

## Security and crypto

A vulnerability goes through the private route in [SECURITY.md](SECURITY.md), never into a public issue or a
pull request. A change to the cryptographic core (the MLS integration, key handling, the relay's authorisation)
gets an independent review before it merges; say in the pull request what you changed and why it is safe.

## Commits

- Conventional Commits: `type(scope): subject` (`feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `ci`),
  in the imperative, one step per commit.
- Stage files by explicit path; no `git add -A`. Do not amend or force-push a shared branch.
- A decision that is not obvious from the diff goes in the commit body, or in an ADR under
  [`packages/messenger/docs/adr`](packages/messenger/docs/adr).
- Docs change in the same commit as the code they describe.

## Licences

Contributions are accepted under the licence of the directory they change: Apache-2.0 for the contracts, the
messenger and the playground, AGPL-3.0-only for the relay (`packages/relay`, `apps/relay`). Each directory
carries its own `LICENSE`; the root `LICENSE` is the Apache-2.0 text.
