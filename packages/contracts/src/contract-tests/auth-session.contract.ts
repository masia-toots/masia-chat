import { describe, expect, it } from 'vitest';
import type { AuthSession, AuthSessionState } from '../ports/auth-session.js';
import { contractTitle, type ContractFactory } from './contract-support.js';

/**
 * What the suite needs beyond the port itself.
 *
 * Why: a real adapter cannot be told to emit from the outside. The host's test wiring supplies the
 * trigger (sign the user out, expire the token), the suite checks what subscribers then see.
 */
export interface AuthSessionContractHarness<T extends AuthSession> {
  triggerChange(subject: T): void | Promise<void>;
}

/** Registers the behavioural contract every `AuthSession` implementation must honour. */
export function describeAuthSessionContract<T extends AuthSession>(
  name: string,
  factory: ContractFactory<T>,
  harness: AuthSessionContractHarness<T>,
): void {
  describe(contractTitle('AuthSession', name), () => {
    it('identifies the user and the install with non-empty ids', async () => {
      const session = await factory();
      expect(session.userId).not.toBe('');
      expect(session.deviceId).not.toBe('');
    });

    it('resolves a non-empty bearer token', async () => {
      const session = await factory();
      expect(await session.getToken()).not.toBe('');
    });

    it('returns an unsubscribe function from onChange', async () => {
      const session = await factory();
      expect(typeof session.onChange(() => undefined)).toBe('function');
    });

    it('tells a subscriber about a change, for the same install', async () => {
      const session = await factory();
      const seen: AuthSessionState[] = [];
      session.onChange((state) => seen.push(state));
      await harness.triggerChange(session);
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((state) => state.deviceId === session.deviceId)).toBe(true);
    });

    it('stops telling a subscriber once it has unsubscribed', async () => {
      const session = await factory();
      const seen: AuthSessionState[] = [];
      const unsubscribe = session.onChange((state) => seen.push(state));
      unsubscribe();
      await harness.triggerChange(session);
      expect(seen).toEqual([]);
    });

    it('treats a second unsubscribe as harmless', async () => {
      const session = await factory();
      const unsubscribe = session.onChange(() => undefined);
      unsubscribe();
      expect(() => unsubscribe()).not.toThrow();
    });
  });
}
