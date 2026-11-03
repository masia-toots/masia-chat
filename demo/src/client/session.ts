import { DEMO_PATHS, RELAY_PREFIX, SESSION_HEADER } from '../../shared/paths.js';

// The playground's own small server, as the page talks to it: sign in with a name, get a relay token,
// list who else is here. DEMO ONLY: the server hands a token to anyone who types a name (see
// `server/app.ts`). The wire is the page's, so the header and the paths are written once here.

/** What the page calls the relay through (the server's proxy). */
export const RELAY_BASE = RELAY_PREFIX;

export interface SignedInSession {
  readonly userId: string;
  readonly deviceId: string;
  readonly displayName: string;
  readonly session: string;
}

export interface PersonView {
  readonly userId: string;
  readonly displayName: string;
}

export interface TokenSource {
  /** A token for the relay; `force` skips the cache (the relay said 401, or someone new arrived). */
  token(force: boolean): Promise<string>;
  /** Forget the cached token: the next call fetches one that introduces whoever is here now. */
  invalidate(): void;
}

type Fetch = typeof fetch;

/** How early before its expiry a cached token is replaced. */
const TOKEN_SLACK_MS = 30_000;

export async function signIn(name: string, doFetch: Fetch = fetch): Promise<SignedInSession> {
  const response = await doFetch(DEMO_PATHS.login, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!response.ok) {
    throw new Error(response.status === 422 ? 'BAD_NAME' : `LOGIN_${response.status}`);
  }
  const body = (await response.json()) as Partial<SignedInSession>;
  if (
    typeof body.userId !== 'string' ||
    typeof body.deviceId !== 'string' ||
    typeof body.displayName !== 'string' ||
    typeof body.session !== 'string'
  ) {
    throw new Error('LOGIN_MALFORMED');
  }
  return { userId: body.userId, deviceId: body.deviceId, displayName: body.displayName, session: body.session };
}

export function createTokenSource(
  session: string,
  doFetch: Fetch = fetch,
  now: () => number = Date.now,
): TokenSource {
  let cached: { token: string; expiresAt: number } | undefined;
  let inflight: Promise<string> | undefined;

  async function fetchToken(): Promise<string> {
    const response = await doFetch(DEMO_PATHS.token, { headers: { [SESSION_HEADER]: session } });
    if (!response.ok) throw new Error(`TOKEN_${response.status}`);
    const body = (await response.json()) as { token?: unknown; expiresAt?: unknown };
    if (typeof body.token !== 'string' || typeof body.expiresAt !== 'number') {
      throw new Error('TOKEN_MALFORMED');
    }
    cached = { token: body.token, expiresAt: body.expiresAt };
    return body.token;
  }

  return {
    token(force) {
      if (!force && cached !== undefined && cached.expiresAt - TOKEN_SLACK_MS > now()) {
        return Promise.resolve(cached.token);
      }
      inflight ??= fetchToken().finally(() => {
        inflight = undefined;
      });
      return inflight;
    },
    invalidate() {
      cached = undefined;
    },
  };
}

export async function fetchPeople(session: string, doFetch: Fetch = fetch): Promise<readonly PersonView[]> {
  const response = await doFetch(DEMO_PATHS.people, { headers: { [SESSION_HEADER]: session } });
  if (!response.ok) throw new Error(`PEOPLE_${response.status}`);
  const body = (await response.json()) as { people?: unknown };
  if (!Array.isArray(body.people)) return [];
  return body.people.flatMap((raw): PersonView[] => {
    const row = raw as Partial<PersonView> | null;
    return row && typeof row.userId === 'string' && typeof row.displayName === 'string'
      ? [{ userId: row.userId, displayName: row.displayName }]
      : [];
  });
}
