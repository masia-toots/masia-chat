/**
 * A snapshot of who is signed in on this install.
 *
 * Why: the messenger must notice a sign-out or a lost token the moment it happens, without
 * polling the host and without knowing how the host authenticates.
 */
export interface AuthSessionState {
  readonly userId: string;
  readonly deviceId: string;
  readonly authenticated: boolean;
}

/**
 * Who am I, which install am I, and a bearer token for the relay.
 *
 * Why: the host owns login, refresh and token rotation. The messenger only needs the identity, the
 * stable per-install `deviceId` (the MLS leaf is bound to it, so it must outlive token rotation)
 * and a token it can present. It never sees a password or a refresh protocol.
 */
export interface AuthSession {
  readonly userId: string;
  readonly deviceId: string;
  /** Resolves a currently valid bearer token; the host refreshes it behind this call. */
  getToken(): Promise<string>;
  /** Subscribes to session changes (sign-out, token loss); returns the unsubscribe function. */
  onChange(cb: (s: AuthSessionState) => void): () => void;
}
