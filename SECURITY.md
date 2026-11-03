# Security policy

This repository holds the open Masia messenger: the ports (`packages/contracts`), the client core
(`packages/messenger`), the relay (`packages/relay`, `apps/relay`) and the playground (`demo`). People
will trust it with conversations, so a report is welcome here; we would much rather hear it from you
than from an incident.

## How to report

Write to **security@masia.to** with `SECURITY` in the subject. If nobody answers within the time below,
write to a maintainer listed in [MAINTAINERS.md](MAINTAINERS.md). Please do **not** open a public issue, a
pull request or a discussion for a vulnerability.

Please include:

- what the issue is, and what an attacker gets out of it;
- the steps to reproduce (a request, a script, a test, or a short recording);
- the package and the commit or version you looked at;
- for a protocol or cryptography finding, the section of the canon it contradicts
  ([`packages/messenger/docs/canon.md`](packages/messenger/docs/canon.md)), if you can name it.

## What we promise

- We acknowledge a report within **3 working days** and tell you what we think of it within **10**.
- We will not pursue anyone who reports in good faith and keeps to the scope below, and we will not ask
  you to sign anything before we read your report.
- We tell you when it is fixed, and credit you in the changelog if you want to be credited.
- We ask for **90 days** of coordinated disclosure before a public write-up (less once a fix is released);
  if a fix needs longer, we say so and agree a date with you.

## What we do not offer

There is **no bug bounty**: no money, no swag. This is a small, self-funded project, and pretending
otherwise would waste your time. Everything else above still holds.

## Scope

**In scope**

- The code in this repository: the MLS integration, the client state, the relay's authorisation and
  delivery logic, the wire protocol and its parsers, the ports and their fakes.
- Anything that lets the relay, or anyone with its database, read a message, forge one, replay one, or
  join a room it is not a member of.
- Anything that lets one person act as another: device registration, device lists, key packages,
  tokens, identity keys.
- The playground, where it claims more than it does (its shortcuts are listed in
  [`demo/README.md`](demo/README.md) and are not findings).

**Out of scope**

- Deployments of this code operated by others, including the maintainers' own product: report those to
  the operator under its own policy.
- Findings against dependencies with no demonstrated impact here; report those upstream.
- Denial of service, volumetric or otherwise; please do not test it against anyone's relay.
- Social engineering of the maintainers.
- Anything requiring physical access to an already-unlocked device.

## Please do not

- Test against a relay you do not operate. Run the playground (`demo/`) or your own relay instead.
- Hold a finding for leverage. Tell us; we will fix it.

## What the code protects today, and what it does not

The project is pre-1.0. The current, honest state is written down next to the design, not here, so the
two cannot drift: [Honest limits](packages/messenger/docs/canon.md#honest-limits) and
[What the relay sees](packages/messenger/docs/canon.md#5-what-the-relay-sees) in the canon, and the state of
the build in [`packages/messenger/docs/context.md`](packages/messenger/docs/context.md). A report that
restates a limit listed there is a known gap, not a finding; a report that shows the code falling short
of what those pages claim is exactly what we want.
