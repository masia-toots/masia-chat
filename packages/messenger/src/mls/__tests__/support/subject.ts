import type { Adversary } from './adversary.js';
import type { EngineFactory } from './world.js';

/**
 * What the contract suite is run against: an engine factory and, for the attack tests, the
 * adversary that knows how to forge messages for THAT engine's library. An engine without an
 * adversary still runs the lifecycle and robustness contracts; the attack contract is skipped
 * (and says so) until one is supplied.
 */
export interface ContractSubject {
  readonly name: string;
  readonly factory: EngineFactory;
  readonly adversary?: () => Promise<Adversary>;
}
