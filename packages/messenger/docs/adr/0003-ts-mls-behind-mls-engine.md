# 0003 — `ts-mls` behind our own `MlsEngine`

- **Status:** Accepted 2026-10-10.
- **Date:** 2026-10-10
- **Decided by:** the lead (an AI session), on a measured result; the rule "measure first" is
  [0002](0002-open-package-and-contracts.md) decision 6. The independent review that set the conditions is in
  [0005](0005-security-review-conditions.md).
- **Builds on:** [0001](0001-e2ee-on-mls.md) (MLS, devices, two zones) and 0002.
- **Canon:** [`../canon.md`](../canon.md) §2.

## Problem

The client needs an implementation of MLS (RFC 9420). Writing one is out of the question; the choice is a
library. Two candidates: `ts-mls` (pure TypeScript, MIT) and `mls-rs` compiled to WebAssembly (Rust). Wanted:
the speed to add a member to a 50-person group in the browser without a noticeable pause (**threshold: under
300 ms on the critical path**), no extra build chain for a reader who wants to run the repository, and an
honest account of how much we are trusting one small project.

## Options

- **`mls-rs` → WASM.** Mature design, Rust. Costs: a Rust toolchain on every contributor's machine (the
  maintainer's had none), a WASM wrapper, a native fallback for phones if WebKit is slow, and
  `wasm-unsafe-eval` in the web content-security policy. Not measured: the bench stopped at the first
  candidate that passed.
- **`ts-mls` 1.6.4.** Pure TypeScript, MIT, runs on WebCrypto. No WASM, no Rust, no CSP relaxation. Young, with
  one volunteer maintainer.

## Measurement

`ts-mls` 1.6.4 (npm latest; the 2.0 release candidates were not measured). Node 24 with WebCrypto, and one run
in headless Chromium 148. Every member is its own client state in one process; the median of five runs; every
run asserts correctness (epochs and exporter secrets match, a 1 KB message round-trips). Cipher suite 1
(`MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519`, mandatory to implement, entirely on WebCrypto).

| Group size N | Add: create | Add: process (median / worst) | encrypt 1 KB | decrypt | self-update create / process | remove create / process |
| --- | --- | --- | --- | --- | --- | --- |
| 2 | 5.3 | 4.1 / 4.1 | 1.0 | 1.2 | 6.4 / 4.9 | 3.9 / n/a |
| 5 | 7.0 | 5.6 / 6.0 | 1.2 | 0.9 | 10.3 / 7.9 | 9.9 / 8.3 |
| 20 | 22.1 | 19.4 / 27.8 | 1.3 | 1.1 | 38.4 / 27.4 | 42.5 / 28.3 |
| 50 | 43.2 | 37.9 / 84.1 | 1.2 | 1.0 | 74.5 / 51.7 | 90.2 / 54.6 |

All times in milliseconds, Node.

- **The gate, "add a member to a group of 50":** critical path (create + the slowest member's processing) is
  **128 ms** in Node (range 83 to 225) and **29 ms** in Chromium. **Pass**, with a 2x to 10x margin. The serial
  sum in one thread (create, 49 processings, Welcome) is 2,296 ms, but that is not the real shape: every device
  processes its own commit.
- Chromium's WebCrypto is 5 to 6 times cheaper per call than Node's; Node's profile is plumbing
  (`importKey`, algorithm normalisation), not curve arithmetic.
- **Sizes at N=50:** key package 332 B · Add commit 503 B · Welcome 11.9 KB · a 1 KB message is 1,165 B on the
  wire · self-update 4.5 KB on a "cold" tree and 769 B on a "warm" one (every member has self-updated once
  after joining) · client state 104 KB (encode 6 ms, decode 28 ms).
- **Other suites at N=50 (critical path):** suite 1 with the library's pure-JS crypto provider 72 ms (about 30
  percent faster in Node, fewer calls; an option for server-side tools) · P-256 95 ms, but 261 ms for a joiner
  (only if a phone browser forces it) · X25519/ChaCha20 87 ms · a post-quantum suite 85 ms, but 64 KB
  self-updates and 74 KB Welcomes, 14x the traffic (later).
- **Bundle:** the set of 19 functions we use, suite 1: **138 KB minified, 38 KB gzip**. One hard dependency
  (`@hpke/core`), one required peer (`@noble/ciphers`), the rest optional. All MIT. Zero WASM.

## Maturity (the risk, stated plainly)

- Repository from April 2025, version 1.0.0 in July 2025. **One volunteer maintainer** (its security policy
  says so), no professional audit, no response-time commitment.
- **A high-severity advisory (GHSA-gwp3-968w-m7gv, 2026-08-28), fixed in 1.6.4:** a commit with a single Remove
  and no UpdatePath was accepted, so the removed member could derive later epoch keys. Found by an outside
  reporter. Our regression probe passes on 1.6.4.
- **A remaining deviation from the RFC (our probe "F8b"):** a commit that carries only a GroupContextExtensions
  proposal is accepted without an UpdatePath (RFC 9420 §12.4 requires one). The library has no option to force
  a path after an Add (an Add-only commit without a path is legal), so key refresh after an Add is a separate
  self-update.
- An open issue: external join silently uses a zero pre-shared key. We do not use external join
  ([0005](0005-security-review-conditions.md)).
- The RFC 9420 test vectors: all 16 are present and tested in the library. An interop runner against another
  MLS implementation exists (we have not run it yet). The development branch describes a v2 API; v1 is what
  ships; 17 release candidates of v2 over nine months with no release.
- Features we need, probed and passing: a role in the credential (survives a Welcome and an Update) ·
  credential validation that rejects a foreign role · external pre-shared keys · the exporter (media keys) ·
  the ratchet-tree extension · state encode and decode · out-of-order and late delivery. Missing: a custom
  credential type (only basic and X.509), and a member-list helper (we walk the ratchet tree).

## Decision

1. **Use `ts-mls`, pinned to exactly `1.6.4`,** lockfile integrity on; upgrade only in a pull request where
   someone has read the diff. Watch its advisories and the npm advisories. Do not adopt the v2 release
   candidates; if v1 stops getting fixes, move to v2 as a planned step.
2. **Only behind our own interface.** `MlsEngine` lives in `packages/messenger/src/mls/` (target): create a
   group · add · remove · self-update · encrypt · decrypt · exporter · encode and decode state · validate a
   credential. The library is one implementation of it. The contract tests are written against the
   interface, so a second implementation must pass the same suite.
3. **Invariants we impose on top of the library:**
   - **Every incoming commit is validated by the engine itself, before the library sees it** (path rules
     including GroupContextExtensions, no ExternalInit, no proposals by reference, credential and role checked
     against the owner's signed device list, role cannot change, key-package lifetime, suite pinned,
     conversation id in an immutable group-context extension). The list is in
     [0005](0005-security-review-conditions.md).
   - **After every Add, the newcomer self-updates at once:** a "warm" tree, post-compromise security, and a
     self-update six times smaller.
   - **A commit with a GroupContextExtensions proposal is made only together with a path.** We never send the
     path-less form; the engine rejects it on receive.
   - **Remove, then revoke** (0001 §5a); the relay's order is not the MLS order (see
     [0004](0004-relay-owns-ciphertext.md)).
   - **The role lives in the credential identity,** not in a leaf extension a member could rewrite in their
     own Update.
   - **No external join, no group-info export, no external pre-shared keys or senders.**
4. **Cipher suite 1** by default. P-256 only if the phone-browser measurement forces it. A post-quantum suite
   is a review trigger, not a plan.
5. **Plan B: `mls-rs` compiled to WASM** behind the same interface, passing the same contract suite. A CI job
   that builds it is desirable but not required now.

## Consequences

- No WASM and no Rust toolchain: a contributor needs Node and pnpm only; the web content-security policy needs
  no `wasm-unsafe-eval` ([context](../context.md), open question D).
- Speed is not a reason to worry; **maturity is.** That is why the validator, the pin, our own probes and the
  independent review exist. The probes (GHSA removed member, F8b, a tampered Welcome tree, a guardian removal,
  a role-dropping Update) are contract tests of `MlsEngine`.
- **Measured on Chromium, not on a phone's browser engine.** The decision stands for the desktop; the phone
  run is a condition of the production switch ([0002](0002-open-package-and-contracts.md), amendments).
- Bandwidth: a Welcome of 12 KB and a cold self-update of 4.5 KB at N=50 are acceptable for the target
  families (groups well below 50); not for broadcast-sized rooms.
- The bench scripts and raw results are not in this repository; the numbers above are the record. Anyone
  repeating it should assert correctness as we did, and measure on a real phone.

## Rejected

- **`mls-rs` → WASM first.** Toolchain and wrapper cost for a margin we did not need; kept as plan B.
- **The library's 2.0 release candidates.** Not measured, no release in nine months.
- **A pure-JS crypto provider as the client default.** Faster in Node, but it moves hashing and AES from the
  platform to JavaScript on the device that matters most; fine for server-side tools.
- **P-256 or a post-quantum suite as the default.** Slower to join or 14x the traffic, for no present need.
- **Trusting the library's receive-side validation.** It was wrong once; see
  [experience](../experience.md) ("the library's receive-side validation is not yours").

## Review trigger

A new advisory against `ts-mls`; v1 stops receiving fixes; the phone-browser measurement; a second maintainer or
an audit; the interop run; before any public claim of end-to-end encryption (a paid audit of `MlsEngine` and
the parts of the library we use).
