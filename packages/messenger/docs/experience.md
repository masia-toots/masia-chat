# Experience: what building this taught us

An **index of rules**, one heading and one to three lines each. The full case behind every rule (what
happened, what it cost, what we do now) is in [`experience-archive.md`](experience-archive.md), under the same
heading. Read the headings before a design or a crypto decision. When we learn something, we **recompose** this
page (merge, sharpen, drop what is no longer true); we do not just append. The cases are dated and stay.

## Process and economy

### Measure the library before choosing a toolchain
Benchmark the cheap candidate first, against a written threshold. A pure-TypeScript library passing the
threshold removed a whole layer (a Rust toolchain, a WASM wrapper, a CSP relaxation). Keep the second candidate
as plan B behind the same interface. [Case](experience-archive.md#measure-the-library-before-choosing-a-toolchain)

### One step, one agent, one worktree
Long-lived agents were the biggest cost of earlier efforts. Give an agent one decided step, a brief and a
verify command; it returns and ends. Independent steps run at the same time.
[Case](experience-archive.md#one-step-one-agent-one-worktree)

### Match the model tier to the check
A cheaper tier where what to do is written down and an objective check exists (tests, typecheck, grep); the
strongest tier for plans, ADRs, reviews, crypto and any bug with an unknown cause.
[Case](experience-archive.md#match-the-model-tier-to-the-check)

### The lead draws the map, agents move the files
Where the line falls between "knows the host's world" and "knows a conversation" is judgement; moving the files
along a drawn map is mechanics. Do the first yourself, delegate the second.
[Case](experience-archive.md#the-lead-draws-the-map-agents-move-the-files)

### Put a critic in front of a design
An independent critic pass on a design ADR, before it is accepted, finds claims you cannot keep and holes you
cannot see from inside. [Case](experience-archive.md#put-a-critic-in-front-of-a-design)

### Say what you did not re-run
A report names the signal it observed. A number carried over from an earlier run is labelled a record, not a
result. [Case](experience-archive.md#say-what-you-did-not-re-run)

## Boundary and packaging

### Boundary first, repo later
Enforce "imports only the contracts" in CI from the first commit; split the repository only when the boundary
has held. The split is a separate gate. [Case](experience-archive.md#boundary-first-repo-later)

### A file moves only with its tests
Moving code without its tests moves the risk, not the code. The old location re-exports for one release, then
goes. [Case](experience-archive.md#a-file-moves-only-with-its-tests)

### A need for an import is a missing port
When code seems to need the host, add a port with a fake and a contract suite. When a protocol is temporary,
keep it in a documented convention and let the port stay small.
[Case](experience-archive.md#a-need-for-an-import-is-a-missing-port)

### Prove the guard fails
A guard that has never gone red proves nothing. Keep a negative-control test that plants a forbidden import and
expects both guards to fail. [Case](experience-archive.md#prove-the-guard-fails)

## Crypto and trust

### The library's receive-side validation is not yours
The same predicate that skipped a required path when sending also accepted its absence when receiving. Validate
every incoming commit in your own engine, before the library, and keep regression probes for what the library
got wrong. [Case](experience-archive.md#the-librarys-receive-side-validation-is-not-yours)

### Pin a young dependency exactly, and hide it
Exact version, lockfile integrity, upgrades only by reading the diff, and an interface of our own so a second
implementation can replace it. [Case](experience-archive.md#pin-a-young-dependency-exactly-and-hide-it)

### Declared is not decrypted
A client declares what a commit does; the relay stores and serves the declaration; every member compares it
with what the decrypted commit really does and rejects a lie.
[Case](experience-archive.md#declared-is-not-decrypted)

### A role marker is not a permission
"Admin" without a scope let one family's admin act on another family. A permission names its subject:
`adminOf` lists the users. [Case](experience-archive.md#a-role-marker-is-not-a-permission)

### The relay's epoch is not the MLS epoch
The relay orders bytes it cannot read, so a member can post garbage that advances its counter and stalls the
room. Check what is checkable in the clear (the MLSMessage header), define recovery.
[Case](experience-archive.md#the-relays-epoch-is-not-the-mls-epoch)

### Do not claim what you cannot show
"Who reads: nobody" was false while derived copies existed; "sealed sender" was impossible with bearer tokens.
Every claim is checked like code. [Case](experience-archive.md#do-not-claim-what-you-cannot-show)

## Relay and data

### The relay owns the ciphertext, so no plaintext column exists
Design the store so the forbidden thing cannot be written, then test the schema. A rule that cannot be broken
beats a rule that is checked. [Case](experience-archive.md#the-relay-owns-the-ciphertext-so-no-plaintext-column-exists)

### Purge the copies, not only the column
Deleting the text column leaves summaries, embeddings, extracted facts and cache entries. List every derived
copy; assert nightly that none exists. [Case](experience-archive.md#purge-the-copies-not-only-the-column)

### Keep the ORM client out of the open packages
Schema and migrations through the ORM, runtime through plain SQL: the boundary stays simple and a reader can
audit the queries. [Case](experience-archive.md#keep-the-orm-client-out-of-the-open-packages)

## Documentation

### Write the forbidden list so it cannot match itself
A checker whose forbidden words are written in plain text flags (or leaks) its own source. Escape them, and look
at the file on disk. [Case](experience-archive.md#write-the-forbidden-list-so-it-cannot-match-itself)

### Copy substance across a privacy boundary, never links
A public record that points into a private repository is a dead link and a leak. Cite the private decision by
number and carry its substance. [Case](experience-archive.md#copy-substance-across-a-privacy-boundary-never-links)
