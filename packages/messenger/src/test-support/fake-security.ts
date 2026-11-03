/**
 * A `SecurityStateSource` a test steers, and builders for the view-model. Test-only (never exported).
 *
 * `set` replaces a room's state and notifies its subscribers, the way the engine wiring will when an
 * epoch advances; between sets `securityStateOf` returns the SAME object (the source's contract).
 */
import type {
  ConversationSecurityState,
  SecurityDevice,
  SecurityGuardian,
} from '../protocol/security-state.js';
import type { SecurityStateSource } from '../ui/provider/security-source.js';

export interface FakeSecuritySource extends SecurityStateSource {
  set(conversationId: string, state: ConversationSecurityState | undefined): void;
  /** How many live subscriptions a room has (a leak check). */
  subscriberCount(conversationId: string): number;
}

export function createFakeSecuritySource(
  initial: Readonly<Record<string, ConversationSecurityState>> = {},
): FakeSecuritySource {
  const states = new Map<string, ConversationSecurityState>(Object.entries(initial));
  const listeners = new Map<string, Set<() => void>>();
  return {
    securityStateOf: (conversationId) => states.get(conversationId),
    subscribe(conversationId, onChange) {
      const set = listeners.get(conversationId) ?? new Set<() => void>();
      set.add(onChange);
      listeners.set(conversationId, set);
      return () => {
        set.delete(onChange);
      };
    },
    set(conversationId, state) {
      if (state) states.set(conversationId, state);
      else states.delete(conversationId);
      for (const listener of [...(listeners.get(conversationId) ?? [])]) listener();
    },
    subscriberCount: (conversationId) => listeners.get(conversationId)?.size ?? 0,
  };
}

export const FAKE_AUTHENTICATOR = 'A1B2 C3D4 E5F6 0718 293A 4B5C 6D7E 8F90';

/** An encrypted room with nobody else in it; override what a test is about. */
export function makeSecurityState(over: Partial<ConversationSecurityState> = {}): ConversationSecurityState {
  return {
    e2ee: 'on',
    masia: 'absent',
    guardians: [],
    epoch: 7,
    epochAuthenticator: FAKE_AUTHENTICATOR,
    devices: [],
    ...over,
  };
}

export function makeGuardian(over: Partial<SecurityGuardian> = {}): SecurityGuardian {
  return { userId: 'mom', displayName: 'Mom', forUserId: 'kid', ...over };
}

export function makeSecurityDevice(over: Partial<SecurityDevice> = {}): SecurityDevice {
  return {
    deviceId: 'dev-1',
    label: 'iPhone 17',
    role: 'USER',
    verified: true,
    isThis: false,
    ...over,
  };
}
