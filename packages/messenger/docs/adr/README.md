# Architecture decision records

Decisions that shaped the open messenger, kept as written at the time (immutable: a later decision
supersedes or amends an earlier one, it never rewrites it). Each record has a problem, the options with
their verdicts, the decision, what it costs, and what we rejected.

| # | Decision | Status |
| --- | --- | --- |
| [0001](0001-e2ee-on-mls.md) | End-to-end encryption for human chats on MLS · two zones · Masia is a visible opt-in member · one build | Accepted 2026-09-09; §6 amended by 0002; four amendments proposed in 0005 (not decided) |
| [0002](0002-open-package-and-contracts.md) | An open messenger: packages · contracts · the boundary · licences · a UI core | Accepted 2026-10-10; decisions 5 and 8 amended the same day (see its Amendments section) |
| [0003](0003-ts-mls-behind-mls-engine.md) | `ts-mls` 1.6.4 behind our own `MlsEngine` · benchmark · invariants · plan B | Accepted 2026-10-10 |
| [0004](0004-relay-owns-ciphertext.md) | The relay owns the ciphertext · no plaintext column · the epoch serializer · plain SQL | Accepted 2026-10-10 |
| [0005](0005-security-review-conditions.md) | The security review before the crypto core: GO with conditions · what is fixed, what is open | Accepted 2026-10-10; amendments A to D await a decision |

How these fit together, in one line each: 0001 says **what** we build and claim; 0002 says **how it is
packaged and bounded**; 0003 says **which cryptographic library and under what rules**; 0004 says **where a
ciphertext lives**; 0005 says **what must be true before and after the crypto core, and what we found**.

These records were written inside a larger product and edited for publication: personal names, hostnames and
deployment details are left out, and private neighbouring decisions are summarised in words (a citation such
as "internal ADR-117" names the private record whose substance the text here carries). The design is
unchanged. Where a record says "gate", it means a decision reserved for a human; see
[`../protocol.md`](../protocol.md#gates-when-a-human-must-decide).

To add one: take the next number, name the file `NNNN-short-title.md`, add it to the table above in the same
change. Do not edit an accepted record; write a new one that amends or supersedes it and mark the old one. (A
dated "Amendments" section at the end of a record is the lightest way to mark a small change.)
