# 0005 — The security review before the crypto core: GO, with conditions

- **Status:** Accepted 2026-10-10 (the conditions bind; the four amendments in section 4 are **proposals
  awaiting the founder's decision** and are not decided by this record).
- **Date:** 2026-10-10
- **Decided by:** the lead, applying the rule "security review before crypto code"
  ([`protocol.md`](../protocol.md#security-review-before-crypto-code)). The review was done by a fresh,
  read-only agent of the strongest tier that had not seen the authors' reasoning.
- **Builds on:** [0001](0001-e2ee-on-mls.md), [0003](0003-ts-mls-behind-mls-engine.md),
  [0004](0004-relay-owns-ciphertext.md).
- **Canon:** [`../canon.md`](../canon.md) §3 to §5.

## Problem

Two things were about to become load-bearing: a young library as the client's cryptographic core, and a relay
that had just been built. Before the first line of client crypto, an independent reader was asked: is it safe
to start, and does the relay hold the threat model of 0001?

## Verdict

**GO with conditions.**

1. The crypto core is acceptable only behind an `MlsEngine` that checks every incoming commit itself. The
   library's own receive-side check was wrong once and still accepts a path-less GroupContextExtensions commit.
2. The relay is well built: the row lock serialises writes, there is no plaintext column, the token binds the
   sender. But it trusted the client-declared member change, which allowed silently cutting a member off and
   permanently stalling a room.
3. Two real authorisation holes: an admin marker was not tied to any family, so one family's admin could remove
   another family's guardian; and a child signed its own device list, so a child could drop the guardian from
   it.
4. Phase 1 does not need external join. Do not expose it; remove the group-info field from the relay.
5. One maintainer is acceptable with an exact version pin, the RFC test vectors run through our interface,
   regression probes, and an interoperability run before beta.

## Findings, and what became of them

| Finding                                                                                                                                                                                                                                                                                                                                                                                                   | State                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Admin marker without a scope: removal of a guardian and registration of guardian or Masia devices were open to any admin                                                                                                                                                                                                                                                                                  | **Fixed** (relay hardening step): `adminOf` lists the users an admin acts for; the marker alone grants nothing                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Relay trusted the declared member change; a lie hides a guardian removal or cuts a user off                                                                                                                                                                                                                                                                                                               | **Fixed on the relay:** the declared change is stored and served, and each Add must name a key package this committer claimed. **Open on the client:** it must compare the served change with what the decrypted commit does                                                                                                                                                                                                                                                                                                               |
| Relay never read the cleartext MLSMessage header; any member could post a garbage commit and stall the room                                                                                                                                                                                                                                                                                               | **Fixed:** the header parser checks group id, epoch and content type against the room (RFC 9420 §6.3 leaves them in the clear), after the authorisation and epoch checks so an outsider learns nothing                                                                                                                                                                                                                                                                                                                                     |
| Group info stored "for external joins", readable by every member                                                                                                                                                                                                                                                                                                                                          | **Fixed:** the field and column are gone                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Key-package claim and device-list read had no per-target limit                                                                                                                                                                                                                                                                                                                                            | **Fixed:** limits per actor and per target user. **Fixed 2026-10-10:** the device-list read by a non-owner is contact-gated (a shared room) and public-only, on the same shared budget; the key-package pool is bounded (`notAfter`, expiry purge, a per-device cap, upload limits). **Fixed 2026-10-10:** the claim is contact-gated too                                                                                                                                                                                       |
| The relay token's device came from a client header; `adminOf` included the admin, so any admin could register GUARDIAN or MASIA devices on any account in reach                                                                                                                                                                                                                                           | **Fixed 2026-10-10:** the device is the signed session's own claim (a signed-out device gets no token); `adminOf` excludes self, `guardianOf` names the minors an admin may register GUARDIAN devices for, and only the operator principal registers MASIA devices                                                                                                                                                                                                                                                                         |
| Retention was stated, not enforced; deleting rows would have let sequence numbers be reused                                                                                                                                                                                                                                                                                                               | **Fixed 2026-10-10:** a periodic job deletes past `RELAY_BACKLOG_RETENTION_SECONDS`; per-conversation counters keep numbers stable; pages carry `oldestAvailableSeq`                                                                                                                                                                                                                                                                                                                                                                       |
| Retries created duplicates or conflicts; standalone proposals were accepted though no client sends them; a removed device lost the commit that removed it; no database or request timeouts                                                                                                                                                                                                                | **Fixed 2026-10-10:** idempotent commit, message (`clientMsgId`) and group creation; proposals refused; a removed device reads to its removal, then `REMOVED`; pg and Fastify timeouts, a lock wait answered 503 `ROOM_BUSY` with `Retry-After`; 30 s clock tolerance                                                                                                                                                                                                                                                                      |
| HS256 relay token: whoever holds the secret mints any identity; no audience or issuer                                                                                                                                                                                                                                                                                                                     | **Fixed (2026-10-10):** the host mints EdDSA tokens with `iss`, `aud`, `kid` and a 10-minute life from a dedicated key; the relay verifies by public key and refuses HS256 outright                                                                                                                                                                                                                                                                                                                                                        |
| A child signs its own device list                                                                                                                                                                                                                                                                                                                                                                         | **Open:** amendment A below                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Engine code review: the plaintext cap allowed messages larger than the relay's 64 KiB envelope                                                                                                                                                                                                                                                                                                            | **Fixed (2026-10-10):** the cap is derived from the envelope, the largest ids and extra data and a measured framing budget; `encrypt` checks its ciphertext; a test round-trips a plaintext at the cap                                                                                                                                                                                                                                                                                                                                     |
| Engine code review: the post-commit parent-hash check re-verified every chain of the tree (quadratic; up to 870 ms per commit at 64 devices)                                                                                                                                                                                                                                                              | **Fixed (2026-10-10):** nodes off the committer's path must be unchanged and only that path is re-hashed; 60 to 80 ms per commit at 64 devices, benchmarked in the contract suite                                                                                                                                                                                                                                                                                                                                                          |
| Engine code review: a Welcome's tree was counted only after the library had joined (and verified it), so the 256-device limit did not bound the join                                                                                                                                                                                                                                                      | **Fixed (2026-10-10):** the tree is decrypted and counted before the library joins; an oversized Welcome is `DECODE_TOO_LARGE`                                                                                                                                                                                                                                                                                                                                                                                                             |
| Engine code review: a lost acknowledgement of our own commit left the device unable to tell whether the relay took it                                                                                                                                                                                                                                                                                     | **Fixed (2026-10-10):** every own commit returns a `pendingCommit`; `adoptPendingCommit` adopts it only when the relay holds exactly its bytes. Host contract in canon §9.7                                                                                                                                                                                                                                                                                                                                                                |
| Engine code review: the header parser is a copy of the relay's, with nothing holding the two together                                                                                                                                                                                                                                                                                                     | **Fixed (2026-10-10):** a parity test runs both parsers over shared valid and malformed vectors and compares the shared constants. **Open:** one shared module (tracked). **Fixed (2026-10-10, review round 1 M14):** one parser in `@masia/contracts/wire`, imported by both; the parity test is deleted                                                                                                                                                                                                                                  |
| Engine code review: a state of an unknown format version was reported as corrupt, inviting the host to delete it                                                                                                                                                                                                                                                                                          | **Fixed (2026-10-10):** `STATE_VERSION_UNSUPPORTED`, distinct from `STATE_CORRUPT`; canon §9.7 tells the host to keep the bytes                                                                                                                                                                                                                                                                                                                                                                                                            |
| Engine code review: caller faults and directory failures were reported under peer-facing codes; a failed directory refresh read as "not listed"                                                                                                                                                                                                                                                           | **Fixed (2026-10-10):** `INVALID_ARGUMENT`, one code per limit (`TOO_MANY_PROPOSALS`, `GROUP_FULL`), `DIRECTORY_UNAVAILABLE` with a directory timeout                                                                                                                                                                                                                                                                                                                                                                                      |
| Engine code review: a sender's slow clock could add a KeyPackage its receivers find expired; the saved receive floor could come from this device's clock                                                                                                                                                                                                                                                  | **Fixed (2026-10-10):** a sender requires 24 hours of remaining lifetime; the saved floor stores relay acceptance times only                                                                                                                                                                                                                                                                                                                                                                                                               |
| Architecture review round 1, M14: the wire vocabulary (roles, limits, retention, MLS profile, header parser) lived in two or three copies held by parity tests; the host repeated the relay token contract because importing it meant importing AGPL code, and the relay compiled in one host's issuer, audience and operator; the boundary guards listed the host's packages and allowed everything else | **Fixed (2026-10-10):** one home, `@masia/contracts/wire` (Apache-2.0, no dependencies), imported by the engine, the relay and (through its own re-export) the host; the claims are built and checked by the contract (`relayTokenClaims`, `readRelayTokenClaims`); the relay requires `RELAY_TOKEN_ISSUER`/`RELAY_TOKEN_AUDIENCE` and has no default operator; ESLint and dependency-cruiser are allowlists (contracts, the package itself, builtins, declared npm dependencies), with a negative control for packages no blocklist named |
| Architecture review round 1, M15: the canon described USER devices only, while the wire carries a household model (GUARDIAN and the assistant role, `adminOf`/`guardianOf`, an operator principal) under one product's name; the canon's web-device step claimed a non-extractable key protects a disk image, which section 9.7 contradicts                                                               | **Fixed (2026-10-10):** canon §3 "Roles and principals" describes all three roles, the admin scope, `guardianOf` and the operator; the role is the generic `ASSISTANT` on the wire (ADR-117 amendment (д)); the web step is aligned with §9.7, the old text marked "until 2026-10-10"                                                                                                                                                                                                                                                      |

## Conditions

### Must be true before the first line of client crypto (these are the acceptance criteria of that step)

1. `MlsEngine` exposes no external join, no group-info export, no external pre-shared keys, no external
   senders. It rejects an incoming ExternalInit and any new-member-commit sender. _(Relay half: done.)_
2. **The receive validator**, run on every incoming commit before the library:
   - an UpdatePath is present if the proposal list is empty or contains an Update, Remove, ExternalInit or
     GroupContextExtensions proposal; no proposals by reference; no standalone proposals; no proposal from an
     external or new-member sender;
   - on a Welcome: the tree hash matches the group info, parent hashes are valid, every leaf is valid
     (RFC 9420 §12.4.3.1), proved by a tampered-tree test;
   - every LeafNode (key package, Update, UpdatePath leaf): `(userId, deviceId, role, signatureKey)` matches
     the owner's verified signed list; **the role cannot change** (it lives in the credential identity);
     key-package lifetime within limits; cipher suite pinned;
   - the conversation id sits in an immutable group-context extension and is checked on a Welcome;
   - a Remove of a guardian leaf is valid only when the committer is an admin of that child;
   - every decode is size-capped first.
3. **Contract tests of `MlsEngine`:** the advisory regression (removed member), F8b rejected, a tampered
   Welcome, a guardian removal rejected, a role-dropping Update rejected, and the 16 RFC test vectors run
   through our interface.
4. `ts-mls` pinned to exactly `1.6.4`; an advisory watch is set up.
5. **Specified:** who signs a `DeviceList` (for a minor, the guardian or admin key) and the canonical signed
   payload (a domain label, the user id, the version and the entries). _(Open: amendment A.)_
6. The admin marker is scoped with `adminOf`. _(Done.)_
7. The relay stores and serves the declared member change and checks the MLSMessage header. _(Done.)_ The
   client must compare the served change with the decrypted commit.

### Must be true before beta or the production switch

- EdDSA relay token with audience, issuer and a short life.
- Contact-gated key-package claim and device-list read; limits per target. _(Device-list read, key-package
  claim and the limits: fixed 2026-10-10; the gate is one function on the relay.)_
- The guardian-inclusion rule enforced by both relay and client: **a room that contains a device of user X
  contains every guardian device on X's list**; a child-facing disclosure of what the guardian sees.
- QR verification of keys; clients pin the highest device-list version seen and reject a rollback.
- A per-sender counter inside the encrypted payload; the epoch authenticator on the verification screen.
- A recovery flow for an invalid commit: clients report "invalid commit at N", the room shows a security state,
  an admin resets the group (a new group id).
- An interoperability run against another MLS implementation; fuzzing of the decoders a hostile peer reaches
  (Welcome, Commit, KeyPackage, MLSMessage).
- Web: strict content-security policy with Trusted Types, MLS state in a dedicated Worker, no
  `wasm-unsafe-eval`; guardian devices native-only.

### Later

`mls-rs` plan B in CI · commits as public messages so the relay derives the member change itself · a
key-transparency log · a paid audit before any public claim of end-to-end encryption · a post-quantum suite.

## The four proposed amendments to 0001 (need the founder; not decided)

- **A. Who signs a minor's device list.** Today the person's identity key signs it. Proposal: for minors, the
  guardian's or an admin's key, plus the guardian-inclusion rule above.
- **B. Verification in phase 1.** Today "key changed, confirm". Proposal: also QR verification reusing the
  device-linking QR; a key change after verification is a blocking warning; a safety number under the menu.
- **C. What is bound to a message.** 0001 says every message carries the epoch and the tree hash as
  authenticated data. The review finds that redundant: MLS already binds group id, epoch and content type and
  derives keys from the group context, which includes the tree hash. Proposal: bind the conversation id in a
  group-context extension, add a per-sender counter inside the payload (gaps show as "N messages missing"), and
  show the epoch authenticator to expose forks. The relay's own sequence number is assigned after encryption,
  so it cannot be bound.
- **D. The web device.** Proposal: remove the `wasm-unsafe-eval` assumption (the chosen library has no WASM),
  add Trusted Types, isolate MLS state in a Worker, make guardian devices native-only, shorten self-update
  intervals and auto-remove idle web devices. An XSS can still read live messages; say so.

## Other review notes, kept short

- **Device model.** A malicious relay can swap a key on first contact, roll a device list back to an older
  valid one, show different lists to different peers, or freeze an old list. Mitigations: pin the highest
  version seen, sign the version, QR verification, later a transparency log. The relay should check a new list
  against the previous list's signer; today a stolen token can upload an unsigned list (clients catch the
  ghost device; nothing earlier does).
- **Children.** The guardian badge must derive from credentials in the MLS tree, not relay metadata, and be
  shown to the child, age-appropriately. A guardian leaf appears in all of a child's rooms and cannot be
  removed by the child, so it is the most valuable target: native-only, app lock, an enforced self-update
  schedule, an alert (not an automatic removal) on a stale leaf. A guardian device needs its own device id per
  (install, account).
- **Bus factor, ranked by value for cost:** pin the version (free) · watch advisories (free) · our probes as
  contract tests (low) · the RFC vectors (low) · the library's interop runner before beta (medium) · decoder
  fuzzing (medium) · plan B in CI (medium to high) · a paid audit (high).

## Consequences

- A relay-hardening step ran before any client crypto, and the next step (the client's MLS core) takes
  conditions 1 to 7 as its acceptance criteria.
- The honest statement of what the relay still trusts, and what the clients must therefore check, is in the
  canon's [honest limits](../canon.md#honest-limits).
- 0001 stays as written until the founder decides amendments A to D; each will be a new record.

## Rejected

- **Starting the client's crypto in parallel with the relay hardening.** The conditions would have become
  rework.
- **Letting the library be the only validator.** See [experience](../experience.md).
- **Exposing external join "for later".** An unused surface with a known silent flaw.

## Review trigger

Each condition closes when its test exists. Re-review before beta, after any change of the cryptographic
library, and before any public claim of end-to-end encryption.
