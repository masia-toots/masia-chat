# Interop of the MLS engine against OpenMLS

`MlsEngine` ([canon section 9](../../../../docs/canon.md#9-the-mls-engine)) is built on one library, ts-mls. A
test that only uses that library cannot tell "correct" from "consistent with itself". This directory runs the
engine against a **second, independent implementation**, OpenMLS (Rust), and records what each side accepts
and refuses.

The engine is driven through the `MlsEngine` interface only. OpenMLS runs as a small JSON-lines program in a
container with no network, a read-only root and no capabilities; the test talks to it over stdin and stdout.

## Run

```sh
pnpm -F @masia/messenger test:interop          # build the image, run the suite, write the results
node run-interop.mjs --no-cache                # (from this directory) rebuild the image from scratch
```

Needs Docker and, for the image build only, the network. The run writes `log.txt` and `results.json` to
`.artifacts/2026-10-10-mls-interop/` (override with `--out <dir>`): the versions used, every check with the
library's own error text, and the runtime. The exit code is the suite's.

Without `MLS_INTEROP=1` the suite is skipped with a one-line reason, so `pnpm test` never needs Docker.

## Files

| File                          | What it is                                                                                                                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Dockerfile`, `openmls-peer/` | The OpenMLS side: base images pinned by digest, crates pinned `=x.y.z` and built `--locked` from a committed `Cargo.lock`. One command per JSON line.                                       |
| `peer.ts`                     | Starts the container and speaks to it.                                                                                                                                                      |
| `harness.ts`                  | A room that holds engine devices and OpenMLS devices side by side; relays every commit as the relay would; compares epoch, tree, `epoch_authenticator` and exporter secret after each step. |
| `openmls-interop.test.ts`     | The scenarios, gated by `MLS_INTEROP=1`.                                                                                                                                                    |
| `recorder.ts`                 | Writes each check as PASS, FAIL (with the exact error) or NOT-TRIGGERABLE (with why).                                                                                                       |
| `run-interop.mjs`             | Builds, runs, records versions, writes the artifacts.                                                                                                                                       |

## What the run proves

- **A**: a group made by the engine admits an OpenMLS device by Welcome; Add, self-update, messages both ways
  (with the conversation-bound AAD) and Remove all converge. OpenMLS commits with and without an UpdatePath are
  accepted; our Add-only commits (no UpdatePath, legal) are accepted by OpenMLS.
- **B**: a group made by OpenMLS (padding, mixed wire-format policy) admits an engine device by Welcome with
  `expectedGroupId` and `expectedEpoch`; messages flow both ways.
- **C**: what the engine forbids is refused when a real OpenMLS produces it: a proposal by reference, a
  standalone proposal, an external commit, a PublicMessage commit or proposal, a GroupContextExtensions commit,
  an application message not bound to its conversation (no AAD, another conversation, a malformed frame, a
  wrong extra), KeyPackages and leaves with the wrong capabilities, suite, lifetime or credential layout,
  Welcomes for another conversation, group or epoch, and the guardian and Masia membership rules. Each refusal
  names its code and leaves the state unchanged.
- **K, S**: random mixed sequences (three seeds, 18 moves each, five devices of each kind) and one minimal tree
  shape found by them (K1). Both are green with the pinned library patch; see finding F1 below.
- **L0, N0**: the wire layout the canon pins (credential bytes, `0xf0c1`, AAD frame), and a negative control
  that proves the comparisons can fail.

Our credential layout, the `0xf0c1` group-context extension, the AAD frame and the capability lists were
accepted by OpenMLS in every scenario. OpenMLS needed two settings, both of which any implementation needs: the
ratchet tree in the GroupInfo (its default is off, and the engine cannot take a tree out of band) and `0xf0c1`
in its leaf capabilities (the RFC requires every member to list the group's extensions).

## Finding F1 (ts-mls, not our layout): fixed by a pinned patch

**Status since 2026-10-10: green.** The repo pins `patches/ts-mls@1.6.4.patch` (recorded in
`pnpm-lock.yaml` under `patchedDependencies` and applied by `pnpm install`), which makes the library check
exactly what RFC 9420 section 12.4.3.1 asks ([canon section 9.7](../../../../docs/canon.md#97-choices-made-on-purpose-and-known-limits),
"Patched library check"). `K1` and `S1` pass, and `results.json` records the patch's lockfile hash next
to the ts-mls version (`tsMlsPatch`), so a result names the exact library it ran against. The text below is
the finding as it was first recorded, kept for the record.

Without the patch, `K1` and `S1` seed 11 fail with `LIBRARY_REJECTED ... non-blank intermediate node must list leaf node in its
unmerged_leaves`. ts-mls 1.6.4 requires every non-blank node on the whole direct path of an unmerged leaf to
carry the same `unmerged_leaves` list as the node that names it. RFC 9420 section 12.4.3.1 asks only that the
non-blank nodes between the leaf and that node list it. After a member from the other half of the tree commits
an UpdatePath, the root's list is empty while the lower node still lists the leaf, which is legal. It needs a
room that has held five or more devices, so a group made and joined only by the engine hits it too, and OpenMLS
accepts the same tree (the third check of K1). Effect: an Add can leave the newcomer unable to join.

The suite stays red until this is fixed in the library or by a patch; then K1 and S1 turn green with no change
here. _(Until 2026-10-10 that was the state. The patch landed; K1 and S1 are green, and stay as the
witnesses that turn red again if the patch is dropped before a ts-mls release carries the fix.)_

## What is not proven

- A commit **without** an UpdatePath where RFC 9420 requires one: stock OpenMLS never builds it (its builder
  attaches the path whenever the RFC requires it). The rule is covered by the engine's own tests with
  hand-made commits, not by an OpenMLS commit. An Add-only commit has no path by design and is covered.
- GroupContextExtensions commits that change or add an extension: OpenMLS refuses to build them (the extension
  would have to be a required capability). Only the commit that drops every extension reached the engine.
- Receive-side checks for a leaf that lacks the conversation extension or the pinned suite: OpenMLS refuses to
  commit them. The send-side checks ran.
- One OpenMLS version (0.9.1), one cipher suite (1), the basic credential only.
- Rooms above 8 devices, an offline device replaying a backlog, restart from saved state, concurrent commits
  (the harness relays one commit at a time).
- Performance and the browser: this runs under Node.
