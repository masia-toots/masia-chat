import {
  createTtlCounter,
  RateLimitedError,
  RelayErrorCode,
  retryAfterSeconds,
} from '@masia/relay';

/**
 * Limits on looking up ANOTHER user, counted per calling USER and per TARGET user (security review
 * 2026-10-10 §4, "Enumeration"). A limit per calling device is no limit: a user may hold many
 * devices and register many users, so N devices x the per-device cap drains a victim's key-package
 * pool or maps a child's devices. Two more counters close that:
 *
 *  - per ACTOR user: all of a user's devices share one budget, so adding devices buys nothing;
 *  - per TARGET user: everyone together share one budget for being looked up, so adding users
 *    buys nothing either.
 *
 * WHAT A LOOKUP COSTS is decided by the caller's relationship to the target (`LookupCharge`, chosen
 * by the contact gate, `lookupAccess` in devices.ts). The budget exists to stop a walk through the
 * user-id space, so it is spent only by lookups that could be part of one:
 *
 *  - your own directory, and that of a user you administer or share a room with, costs NOTHING. An
 *    open client re-reads the lists of everyone in its rooms about once a minute on every device, so
 *    a budget that counted those would be spent by ordinary use (7 people with 2 devices each). Those
 *    targets are already known to the caller, and the gate has checked the relationship;
 *  - the operator account (everyone may look it up, it owns every ASSISTANT device) costs the CALLER's
 *    budget only. One shared target budget for an account that everybody reads would let any single
 *    user make it unreachable for all the others;
 *  - a host introduction to a user the caller shares no room with costs the caller's budget AND the
 *    target's;
 *  - a probe the gate refuses (a stranger) costs the caller's budget only, so a walk through the
 *    user-id space stops after one budget and cannot spend anybody else's.
 *
 * The target budget is also a lever: whoever can spend it can make a user briefly unreachable. That
 * is the price of the cap for the calls that spend it, and a 429 is loud and recoverable where a
 * drained pool is not. Only a caller the gate lets through can spend it, and only through an
 * introduction, which the host grants.
 */

/** What one lookup is charged against. */
export const LookupCharge = {
  /** Nothing: the caller's own directory, or that of someone it administers or shares a room with. */
  NONE: 'NONE',
  /** The calling user's budget only: the operator account, which everybody may read. */
  ACTOR: 'ACTOR',
  /** The calling user's budget, then the target's: an introduced stranger. */
  ACTOR_AND_TARGET: 'ACTOR_AND_TARGET',
} as const;
export type LookupCharge = (typeof LookupCharge)[keyof typeof LookupCharge];

export interface LookupLimiterOptions {
  readonly windowMs: number;
  /** Lookups one calling user (all devices together) may make in a window. */
  readonly actorLimit: number;
  /** Lookups of one target user (everybody together) in a window. */
  readonly targetLimit: number;
  /** Injected so tests can move time. */
  readonly now?: () => number;
}

export interface LookupLimiter {
  /**
   * Counts a lookup against what `charge` names and throws a 429 if a budget is spent. The caller's
   * budget is checked before the target's, so a caller refused for its own volume does not also spend
   * the target's.
   */
  charge(actorUserId: string, targetUserId: string, charge: LookupCharge): void;
  /** `charge` with `ACTOR_AND_TARGET`: the full price, for lookups whose relationship is not known (claims). */
  check(actorUserId: string, targetUserId: string): void;
}

function limited(
  code: typeof RelayErrorCode.ACTOR_RATE_LIMITED | typeof RelayErrorCode.TARGET_RATE_LIMITED,
  message: string,
  resetsAt: number,
  now: number,
): RateLimitedError {
  return new RateLimitedError(code, message, retryAfterSeconds(resetsAt, now));
}

export function createLookupLimiter(options: LookupLimiterOptions): LookupLimiter {
  const now = options.now ?? Date.now;
  // Two counters, never one keyed by a mix of both kinds of id: a user is both an actor and a
  // target, and their two budgets must not be the same number.
  const byActor = createTtlCounter({ ttlMs: options.windowMs, window: 'fixed', now });
  const byTarget = createTtlCounter({ ttlMs: options.windowMs, window: 'fixed', now });

  function chargeActor(actorUserId: string): void {
    const actor = byActor.hit(actorUserId);
    if (actor.count > options.actorLimit) {
      throw limited(
        RelayErrorCode.ACTOR_RATE_LIMITED,
        'Too many lookups from this user; try again later.',
        actor.resetsAt,
        now(),
      );
    }
  }

  function chargeTarget(targetUserId: string): void {
    const target = byTarget.hit(targetUserId);
    if (target.count > options.targetLimit) {
      throw limited(
        RelayErrorCode.TARGET_RATE_LIMITED,
        'That user has been looked up too often; try again later.',
        target.resetsAt,
        now(),
      );
    }
  }

  const limiter: LookupLimiter = {
    charge(actorUserId, targetUserId, charge) {
      if (charge === LookupCharge.NONE) return;
      chargeActor(actorUserId);
      // Checked after the actor budget on purpose: a caller already refused for its own volume
      // must not also spend the target's shared budget. Your own directory never spends it.
      if (charge === LookupCharge.ACTOR || actorUserId === targetUserId) return;
      chargeTarget(targetUserId);
    },
    check(actorUserId, targetUserId) {
      limiter.charge(actorUserId, targetUserId, LookupCharge.ACTOR_AND_TARGET);
    },
  };
  return limiter;
}
