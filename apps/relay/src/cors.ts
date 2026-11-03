/**
 * Cross-origin access for the few app origins a deployment names (`RELAY_ALLOWED_ORIGINS`, config.ts).
 *
 * A client on the relay's own origin needs nothing here. A client served from another origin (an app
 * shell such as the iOS WebView, whose pages live at `capacitor://<host>`) sends the access token in the
 * `authorization` header, so its browser asks first with a preflight `OPTIONS`; without an answer the
 * real request never leaves it. This hook answers that preflight, and marks the real response readable,
 * for an origin on the list, and for nothing else: an unlisted origin gets no CORS header at all, and its
 * browser keeps the response from it.
 *
 * No credentials: the relay reads no cookie (the token is a header), so `Allow-Credentials` is never sent.
 */
import type { FastifyInstance } from 'fastify';

/** The methods the relay's routes use. */
const ALLOWED_METHODS = 'GET, POST, DELETE';
/** The request headers a client sends: the bearer token and the JSON body's type. */
const ALLOWED_HEADERS = 'authorization, content-type';
/** How long a browser may reuse a preflight answer, in seconds. */
const PREFLIGHT_MAX_AGE_SECONDS = 600;
const HTTP_NO_CONTENT = 204;

/**
 * Registers the hook on the ROOT scope, so it also runs for a preflight to a path no route has (Fastify
 * routes no `OPTIONS`): the hook answers it before the not-found handler would. No origins: nothing is
 * registered, and the relay behaves as before.
 */
export function registerCors(app: FastifyInstance, allowedOrigins: readonly string[]): void {
  if (allowedOrigins.length === 0) return;
  const allowed: ReadonlySet<string> = new Set(allowedOrigins);
  app.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin;
    if (typeof origin !== 'string') return;
    // The answer depends on the Origin header, so a cache in front must key on it.
    reply.header('vary', 'Origin');
    if (!allowed.has(origin)) return;
    reply.header('access-control-allow-origin', origin);
    if (request.method === 'OPTIONS' && request.headers['access-control-request-method'] !== undefined) {
      reply.header('access-control-allow-methods', ALLOWED_METHODS);
      reply.header('access-control-allow-headers', ALLOWED_HEADERS);
      reply.header('access-control-max-age', String(PREFLIGHT_MAX_AGE_SECONDS));
      await reply.code(HTTP_NO_CONTENT).send();
    }
  });
}
