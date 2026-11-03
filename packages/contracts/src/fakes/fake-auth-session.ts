import type { AuthSession, AuthSessionState } from '../ports/auth-session.js';
import { createFakeEmitter } from './fake-emitter.js';

export const FAKE_USER_ID = 'fake-user';
export const FAKE_DEVICE_ID = 'fake-device';
export const FAKE_TOKEN = 'fake-token';

/** A fake session plus the one control a test needs: flip the signed-in state, as a host would. */
export interface FakeAuthSession extends AuthSession {
  setAuthenticated(authenticated: boolean): void;
}

export interface FakeAuthSessionOptions {
  readonly userId?: string;
  readonly deviceId?: string;
}

/** In-memory `AuthSession`: signed in on creation; `getToken` rejects while signed out. */
export function createFakeAuthSession(options: FakeAuthSessionOptions = {}): FakeAuthSession {
  const userId = options.userId ?? FAKE_USER_ID;
  const deviceId = options.deviceId ?? FAKE_DEVICE_ID;
  let authenticated = true;
  const changes = createFakeEmitter<AuthSessionState>();

  return {
    userId,
    deviceId,
    async getToken() {
      if (!authenticated) throw new Error('fake auth session: signed out, no token');
      return FAKE_TOKEN;
    },
    onChange: (cb) => changes.add(cb),
    setAuthenticated(next) {
      authenticated = next;
      changes.emit({ userId, deviceId, authenticated });
    },
  };
}
