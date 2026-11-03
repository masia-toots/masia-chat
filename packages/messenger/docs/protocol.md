# Protocol: how this project is run

The working method, written down so you can judge the code by the way it was made. It is the public form of the
protocol the host project runs on; the parts that concern only that project are left out. **Short version:**
plan first, code after an explicit go; one agent per step, reviewed before it merges; humans decide the gates;
security review comes before crypto code; every decision lands in a file, not in a chat.

## Who does what

| Role | What they do |
| --- | --- |
| **Founder** | Sets the goal, answers the gates, gives the go. The only one who can approve a licence, a purge, a deploy or a publication. |
| **Maintainer** | Merges to the trunk and owns releases. Today the founder doubles as maintainer. |
| **Lead** | An AI coding session that plans, delegates, reviews, integrates and writes the docs. Does hands-on work only when it says why. |
| **Agent** | An AI coding session given exactly one step, in its own git worktree. Returns a result and ends. |
| **Reviewer** | A fresh, read-only agent that has not seen the author's reasoning: security, crypto and code review. Never the author. |

## Two phases

**Plan phase (interactive, no code).** Problem → a plan written to a file *before* any code → for a large effort,
a critic pass by a separate agent → present it, close the forks, and **wait for the go-word**. Nothing executes
before it. A design decision goes through the critic *before* the founder sees it (see
[experience](experience.md)).

**Execution phase (autonomous loop until done or gated).** The go-word flips the phase. The lead drives the goal
through every stage (build → verify → docs → commit) without re-asking what is already decided, starts any
reversible step at once, parallelises independent work, and **stops only at "done" or at a gate**. Every iteration
ends with a report (below). Stop and pause words end the loop or park it.

## The plan file is the contract

Fixed section order: goal → final point → **gates** (each question complete: context, options with cost, a
recommendation and why) → summary (at most ten lines, rewritten every iteration) → steps → **chronicle** (newest
first: date, who, one or two lines) → links.

Every step names: skills used · the area it touches · a context estimate · **parallel**: either "with step X" or
"sequential, blocks Y because …" naming the real dependency (a shared file, or data this step hands to the next;
"sequential" with no named dependency is not an answer) · **agent**: who, at which model tier · risk
(reversible / needs review / irreversible) · a verify line. Each step also names the one or two steps that follow
it, so work stays forward-compatible.

## Gates: when a human must decide

A gate is a blocking question, asked first in the turn, with options and one recommendation. Always a gate:

- **Licences, publication, and anything changing what we promise users.** A publication is a production event.
- **Irreversible actions on user data** (the history purge), always after a fresh, verified backup.
- **Production and infrastructure**: deploys, schema on production, secrets, topology, CI/CD, domains, backups.
  Committing code to the trunk is development and proceeds; deploying it is a gate.
- **A choice the founder is not ~90% likely to confirm**, or one that needs a credential, a device or an external
  system.

Not a gate: a recommendation the founder would almost surely pick (do it and report what was decided), and
**uncertainty about execution**, which is cured by verifying, never by asking. If there is no gate, there is
still a proposal: "next" is never empty. This project's gates so far: history at the switch (drop), where the relay
lives (own process), licences (Apache-2.0 / AGPL-3.0), rollout (one switch, no beta); four design amendments are
open ([context](context.md#open-questions)).

## The report

Every lead message ends with a status block. The fields, in short:

`Plan · date · tag · iteration` — `Phase` (plan / execution / paused / stopped / done) — `Goal` — `Done` since
the founder's last action · `Now` (what is actually running, else none) · `Next` (1–3) — `Step` n/N, skills, area,
model tier — `Blocker` and its owner — `Gates` (production / infrastructure / none) — `Needed from you` —
`Suggestions` (the lead's own, beyond the plan) — `Through the user's eyes` (who is on this surface, what they feel
and where they stumble, then a criticism and an improvement; never a bare "fine") — `Plan` link — `Open gates`
(one sentence each, options not listed in prose) — context and time estimates.

Reporting rules: a step code is always followed by a plain phrase saying what it does; "verified" or "works"
**names the observed signal** (test, log, screenshot, API reply), otherwise say "read the code"; a defence is
proved by showing it fail without the fix (a negative control); a time estimate sits next to the real wall-clock.

## Agent = one step

- **One task, one worktree.** A writing agent works in its own copy of the repository (a fresh branch from the
  trunk), merges the trunk before returning, and removes its worktree as its last act. Readers need no copy.
- **A brief, not raw files.** The lead reads once and gives a 3–5k-token brief: the goal, what is decided, what is
  ruled out, the files that matter, the scope fence, the verify command. The agent does not rediscover context.
- **The agent dies after its step**; the next step is a new agent. Long-lived agents were the biggest cost of
  earlier efforts. Independent steps run at the same time; "tidier in sequence" is not a dependency.
- **Model tier by step.** A cheaper tier when *all* hold: what to do is decided and written down · an objective
  check exists (tests, typecheck, grep, a script) · it does not touch schema, auth, protocol or security · nobody
  must judge a look or a text. The strongest tier for any plan, ADR or architecture, any review (code, security,
  frames, copy), a bug with an unknown cause, and any step a cheaper tier failed twice.
- **The lead reviews and integrates.** The diff is read, the verify command re-run on the trunk, and the work
  brought in by cherry-pick or merge.
- **Merge conditions, all required:** the contract suites green (here and in the host) · `pnpm boundary` green ·
  the package tests green · `docs:check` green · docs updated in the same change.
- **Fences.** An agent edits only the paths its brief names; anything else it finds becomes a note in its report.

## Security review before crypto code

A cryptographic core is not started until an independent reviewer has read the design and the chosen library.
The verdict is GO, GO with conditions, or NO, with two lists: **must before the code** (these become the next
step's acceptance criteria) and **must before beta**. The first such review gave GO with conditions and found two
authorisation holes in already-built relay code; they were fixed in a dedicated step before any client crypto
([ADR 0005](adr/0005-security-review-conditions.md)). A library with one maintainer is acceptable only pinned to an
exact version, behind our own interface, with our own regression probes and an interoperability run.

## How a decision is recorded

| Kind | Home | Rule |
| --- | --- | --- |
| A decision with rejected alternatives | [`adr/`](adr/README.md) | Immutable. Change it with a new ADR that amends or supersedes it. |
| What and why of one feature system | [`canon.md`](canon.md) | Updated in the same change as the code; supersede, never delete. |
| How | the code | Conforms to the canon. |
| Chronology | [`log.md`](log.md) | Newest first, never rewritten; what / why / files / decision / next. |
| What we learned | [`experience.md`](experience.md) | An index of rules; recomposed, not appended. Cases in the archive. |
| Where we are | [`context.md`](context.md) | Rewritten when state moves. |
| Releases | [`CHANGELOG.md`](CHANGELOG.md) | Per release only. |

Rejected approaches are recorded too: a decision with no "why not the other one" is half a decision. The moment a
design choice is made it is written down; iteration that is not yet a choice is not recorded as one.

## Commit hygiene

- Conventional Commits: `type(scope): subject` (`feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `ci`, …).
- **Stage by explicit path only** (pathspec commits). Never `git add -A` or `git add .`; one commit holds one
  step's own files. Look at the staged diff for secrets before committing.
- Create new commits; never amend one that exists, never skip hooks, never force-push the trunk.
- Trailers: a commit that carries out a founder's decision names who decided; an AI session adds a co-author line.
- A change to an API route regenerates the API description in the same commit.

## End of a step

Done means: verified (with a named signal) → docs updated (canon / ADR / log / context as the change requires;
experience *recomposed* if a rule was learned) → committed by pathspec → reported with the lead's own proposals.
A request handed to another area stays an open item of the sender until the answer returns; one older than about a
week is escalated or taken back.
