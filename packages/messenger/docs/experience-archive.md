# Experience archive: the cases behind the rules

Each entry is the full case for the rule of the same name in [`experience.md`](experience.md): what happened,
what it cost, what we do now. Dated, never rewritten; if a case is overtaken, a newer entry says so.

## Process and economy

### Measure the library before choosing a toolchain
2026-10-10. The plan assumed `mls-rs` compiled to WASM, which needs a Rust toolchain the maintainer's machine
did not have. A revision made the pure-TypeScript `ts-mls` the first candidate, with a written threshold: add a
member to a group of 50 in under 300 ms. One agent measured it in about 40 minutes: 128 ms in Node, 29 ms in
Chromium, a 38 KB gzip bundle, zero WASM. No toolchain, no wrapper, no CSP relaxation. Now: write the
threshold first, measure the cheap candidate first, keep the other as plan B behind the same interface
([ADR 0003](adr/0003-ts-mls-behind-mls-engine.md)).

### One step, one agent, one worktree
2026-10-10. The economy revision of the plan recorded that most of the cost of earlier efforts was
long-lived agents that re-read the same context. Phase 1 instead ran each step (skeleton, benchmark, relay,
move of the client's data and hooks, relay hardening) as one agent in its own worktree for 23 to 46 minutes,
with a brief and a verify command, followed by the lead's review. The target for the whole of phase 1 was
about 1.2 M agent tokens against about 3 M for the old layout. Now: one decided step per agent, the agent ends
with its step ([`protocol.md`](protocol.md#agent--one-step)).

### Match the model tier to the check
2026-10-10. Cheaper tier: skeleton, CI guard, relay schema, UI split along a drawn map, purge job: what to do is
written down and tests, typecheck or grep can tell. Strongest tier: the review of the crypto core, the review
of the library, the security pass before beta. The point showed itself at once: the relay, built by a
cheaper-tier agent with passing tests, had two authorisation holes that a strongest-tier read-only review found
in five minutes. Now: the reviewer is never the author and never a lower tier than the work it reviews.

### The lead draws the map, agents move the files
2026-10-10. Before the client's code moved into the package, the lead read the host's 2,600-line messenger page
and found it already had two bodies: a people-chat body and an assistant-chat body. It wrote a list: goes to
the package (the people chat, the contact model, the hooks, the devices card) and stays in the host (dock, scene,
stickers, lanes, the assistant body). A cheaper agent then moved the data and hooks in 45 minutes with the host's
suites green. Now: judgement first, drawn on paper; mechanics after.

### Put a critic in front of a design
2026-09-09. The design of [ADR 0001](adr/0001-e2ee-on-mls.md) went through an independent critic pass before it
was accepted. Verdict: right shape, "not acceptable as written": three claims that were false (erasing the text
column left derived copies; "sealed sender"; one key of Masia for all families) and no answer to the "ghost
device" a server operator could add. All were closed in the ADR. Now: a design goes through a critic before the
founder sees it as final.

### Say what you did not re-run
2026-10-10. After the relay step merged, the verification on the trunk was killed by the machine (about 3 GB of
memory free); only the boundary check was re-run there and the full test run followed on the next pass. The
state table in [`context.md`](context.md) still labels the relay's 218 tests "2026-10-10 record, not re-run
without a database". Now: a report names the signal it saw; a carried-over number says it is a record.

## Boundary and packaging

### Boundary first, repo later
2026-10-07 to 2026-10-10. A separate repository from day one was rejected: two weeks of tooling instead of
cryptography ([ADR 0002](adr/0002-open-package-and-contracts.md)). Instead the skeleton step put the guard in
CI as blocking from the first commit: an ESLint block and dependency-cruiser. The boundary check covered 55
modules then and 122 now, with no exception. `git subtree split` and publication stay a separate gate, because
publication is a production event.

### A file moves only with its tests
2026-10-10. The client's data and hooks (the live state of a conversation, the wire types, the contact model,
circles and groups) moved into the package together with their tests; limits became parameters instead of
copied constants; the host kept a re-export for one release and no component changed. The package suites, the
host's suites and the host's build stayed green. Now: no test, no move.

### A need for an import is a missing port
2026-10-10. The circles and groups hooks needed the host's address book. The port `PresenceDirectory` grew into
`ContactsDirectory` (the old name stays a deprecated alias for one release), and the hooks were rewritten
against the port instead of the host's generated API types. The `Transport` port did **not** grow for a temporary
protocol: the messenger speaks the host's existing JSON messages by a convention (events on topic `msg:`, link
state on `messenger:connection`, commands POSTed to a fixed path), and the adapter and the convention leave
together when the relay path replaces them.

### Prove the guard fails
2026-10-10. The skeleton includes a test in the contracts package that plants a forbidden import and expects both
guards (lint and dependency-cruiser) to fail. Without it, a guard that never fires and a guard that is broken
look the same. Now: every guard ships with its negative control.

## Crypto and trust

### The library's receive-side validation is not yours
2026-08-28 (advisory), 2026-10-10 (review). A high-severity advisory against `ts-mls` traced to one shared
predicate: it skipped the UpdatePath when sending a Remove and accepted its absence when receiving, so a removed
member could derive later epoch keys. The review's point: where sender and receiver share code, one bug cuts
both ways. A related deviation still stands (a GroupContextExtensions-only commit without a path is accepted).
Now: `MlsEngine` validates every incoming commit itself, before the library; the advisory and the deviation are
contract tests ([ADR 0005](adr/0005-security-review-conditions.md)).

### Pin a young dependency exactly, and hide it
2026-10-10. The library has one volunteer maintainer, no audit, and 17 release candidates of its next version in
nine months without a release. Now: exact version `1.6.4`, lockfile integrity, an upgrade only in a pull request
where someone reads the diff, no release candidates, an interface of our own so `mls-rs` can replace it, and an
advisory watch ([ADR 0003](adr/0003-ts-mls-behind-mls-engine.md)).

### Declared is not decrypted
2026-10-10. The relay trusted the member change a committer declared. A lie could silently cut a user's device off
the relay, grant relay access to a device that was never added, or hide a guardian removal from the relay's own
check. The cost is availability and the honesty of the "who can read" screen, not confidentiality. The hardening
step stores and serves the declared change and binds every Add to a key package the same committer claimed. The
client half (compare the served change with the decrypted commit, reject a mismatch) is a condition of the next
step.

### A role marker is not a permission
2026-10-10. The relay checked only that the actor was an admin. In a room shared by two families, one family's
admin could remove the other family's guardian, and the same marker let any admin register guardian or assistant
devices for any user. Now the token carries `adminOf`, the list of users the admin acts for, and a removal or a
registration needs the target in that list. The marker alone grants nothing.

### The relay's epoch is not the MLS epoch
2026-10-10. The relay advances its counter on any accepted commit. A member could post garbage; every client
would reject it; the room would answer `409` to every later commit forever. The fix reads the part of the
MLSMessage that RFC 9420 leaves in the clear (group id, epoch, content type) and requires it to match the room,
after the authorisation and epoch checks so a stranger learns nothing about a room. The parser is fuzzed; a
public message is accepted only from a member, which is stricter than the review asked. Still open: the recovery
flow when clients do reject a commit (the room shows a security state and an admin resets the group).

### Do not claim what you cannot show
2026-09-09. The critic found that "who reads: nobody" was false while summaries, embeddings and extracted facts
survived a purge of the text column; that "sealed sender" is impossible with bearer tokens and indexed foreign
keys; and that a room with media under a family envelope cannot carry a plain "encrypted" badge. The ADR dropped
the term, wrote "metadata-visible by design", and splits the badge into text and media. Now every claim is
reviewed like code, and the canon has an [honest limits](canon.md#honest-limits) section.

## Relay and data

### The relay owns the ciphertext, so no plaintext column exists
2026-10-10. The first sketch added a ciphertext column beside the text column in the host's message table and
forbade text for encrypted rooms with a check. Once the relay became its own process with its own database, that
was two homes for messages and a text column that still existed. The relay's schema has no such column, and a
test reads the schema, the migration SQL and (given a database) the live catalogue for any column named like
text, body, content, message or payload ([ADR 0004](adr/0004-relay-owns-ciphertext.md)).

### Purge the copies, not only the column
2026-09-09. Erasing the text of a conversation leaves its summary, embedding, extracted fact and source ids,
the modified text of deliveries, source rows and cache traces. The design lists every derived copy for the
purge and adds a nightly assertion that no encrypted conversation holds any of them. Running the purge in
production is irreversible, so it is a gate and follows a verified backup.

### Keep the ORM client out of the open packages
2026-10-10. The boundary forbids a runtime ORM client in the open packages. The relay agent therefore kept the
ORM for the schema and the migrations (with six `CHECK` constraints written by hand) and used plain SQL through
`pg` at runtime. We kept it: the dependency is lighter and a reader audits visible queries faster than a
generated client.

## Documentation

### Write the forbidden list so it cannot match itself
2026-10-10. The docs checker flags personal names, production hostnames and private paths. Written in plain text,
those words would sit in the checker's own source. Written as escapes, an editing tool decoded the escapes back
to plain characters and a name briefly landed in the file. The fix: write the backslashes from code, then look
at the bytes on disk and grep for the plain names (none). The checker also prints only a label and a line,
never the text it matched.

### Copy substance across a privacy boundary, never links
2026-10-10. These records were born inside a larger private repository. A link into it is dead for a reader and
a leak for us. Rule: cite a private decision as "internal ADR-117, summarised in 0001" and carry its substance in
the public record; the checker flags paths into the private tree.
