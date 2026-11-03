import { defineAttackContract } from './contract-attacks.js';
import { defineBacklogContract } from './contract-backlog.js';
import { defineLifecycleContract } from './contract-lifecycle.js';
import { definePendingCommitContract } from './contract-pending-commit.js';
import { defineRobustnessContract } from './contract-robustness.js';
import type { ContractSubject } from './support/subject.js';

/**
 * The whole contract for an `MlsEngine`: what an honest engine does (lifecycle), what it refuses
 * (attacks, needs the subject's adversary), that it reads a replayed backlog (backlog, needs the
 * adversary too), that its own commits survive a lost acknowledgement (pending commit) and that it
 * never breaks on bad bytes (robustness).
 * A second engine (`mls-rs` -> WASM) is admitted by passing this suite with its own subject.
 */
export function defineEngineContract(subject: ContractSubject): void {
  defineLifecycleContract(subject);
  defineAttackContract(subject);
  defineBacklogContract(subject);
  definePendingCommitContract(subject);
  defineRobustnessContract(subject);
}
