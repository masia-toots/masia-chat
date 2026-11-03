import { describe, expect, it } from 'vitest';
import type { GenericPush, PushBridge } from '../ports/push-bridge.js';
import { contractTitle, type ContractFactory } from './contract-support.js';

/**
 * Every field a generic push may carry. Typed as a record over `keyof GenericPush`, so adding a
 * field to the port (for instance message text) breaks compilation HERE until someone decides, on
 * purpose, whether a push is allowed to say that.
 */
const ALLOWED_PUSH_FIELDS: Readonly<Record<keyof GenericPush, true>> = {
  conversationId: true,
  receivedAt: true,
};

const CONTRACT_PUSH: GenericPush = { conversationId: 'contract-conversation', receivedAt: 1000 };

/**
 * What the suite needs beyond the port itself.
 *
 * Why: a real bridge cannot be told to receive a push from the outside. The host's test wiring
 * simulates the platform delivering one (a fake APNs/FCM callback).
 */
export interface PushBridgeContractHarness<T extends PushBridge> {
  push(subject: T, p: GenericPush): void | Promise<void>;
}

/** Registers the behavioural contract every `PushBridge` implementation must honour. */
export function describePushBridgeContract<T extends PushBridge>(
  name: string,
  factory: ContractFactory<T>,
  harness: PushBridgeContractHarness<T>,
): void {
  describe(contractTitle('PushBridge', name), () => {
    it('returns an unsubscribe function from onGenericPush', async () => {
      const bridge = await factory();
      expect(typeof bridge.onGenericPush(() => undefined)).toBe('function');
    });

    it('delivers the conversation id and the receive time unchanged', async () => {
      const bridge = await factory();
      const seen: GenericPush[] = [];
      bridge.onGenericPush((p) => seen.push(p));
      await harness.push(bridge, CONTRACT_PUSH);
      expect(seen).toEqual([CONTRACT_PUSH]);
    });

    it('never delivers a field beyond the allowed ones (no text rides on a push)', async () => {
      const bridge = await factory();
      const seen: GenericPush[] = [];
      bridge.onGenericPush((p) => seen.push(p));
      await harness.push(bridge, CONTRACT_PUSH);
      expect(seen).toHaveLength(1);
      expect(Object.keys(seen[0] ?? {}).sort()).toEqual(Object.keys(ALLOWED_PUSH_FIELDS).sort());
    });

    it('delivers to every subscriber', async () => {
      const bridge = await factory();
      const first: GenericPush[] = [];
      const second: GenericPush[] = [];
      bridge.onGenericPush((p) => first.push(p));
      bridge.onGenericPush((p) => second.push(p));
      await harness.push(bridge, CONTRACT_PUSH);
      expect(first).toHaveLength(1);
      expect(second).toHaveLength(1);
    });

    it('stops delivering once the subscriber has unsubscribed', async () => {
      const bridge = await factory();
      const seen: GenericPush[] = [];
      const unsubscribe = bridge.onGenericPush((p) => seen.push(p));
      unsubscribe();
      await harness.push(bridge, CONTRACT_PUSH);
      expect(seen).toEqual([]);
    });
  });
}
