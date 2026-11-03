import swagger from '@fastify/swagger';
import {
  MAX_ADMIN_OF_USERS,
  RELAY_HEALTH_PATH,
  RELAY_PROTOCOL_VERSION,
  RELAY_TOKEN_CLOCK_TOLERANCE_SECONDS,
  RELAY_TOKEN_TTL_SECONDS,
} from '@masia/relay';
import Fastify, { type FastifyInstance } from 'fastify';
import { createAuthHooks, type TokenExpectations } from './auth.js';
import { registerCors } from './cors.js';
import type { Database } from './db.js';
import { createDeviceListDirectory, createDeviceLookupLimiter } from './domain/device-lists.js';
import { createKeyPackageDirectory } from './domain/key-packages.js';
import { createEpochSerializer } from './epoch-serializer.js';
import { installErrorHandler } from './error-handler.js';
import { registerConversationRoutes } from './routes/conversations.js';
import { registerDeviceListRoutes } from './routes/device-lists.js';
import { registerDeviceRoutes } from './routes/devices.js';
import { registerKeyPackageRoutes } from './routes/key-packages.js';
import type { RouteDeps } from './routes/route-deps.js';
import { BEARER_SECURITY_SCHEME } from './routes/schemas.js';
import type { TokenKeyring } from './token-keys.js';

/**
 * Room for the largest legitimate request: a key-package upload of 100 packages of 16 KiB, or a
 * commit with its Welcome, all as base64 (4/3 of the bytes). Fastify's default of 1 MiB is too
 * small for both; anything bigger than this is not a message this relay should take.
 */
export const MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024;

/**
 * How long one request may take from its first byte to the answer, and how long a connection may
 * sit idle. Every database step has its own, shorter limit (db.ts); these stop a slow or stalled
 * client from holding a socket for ever.
 */
export const REQUEST_TIMEOUT_MS = 30_000;
export const CONNECTION_TIMEOUT_MS = 60_000;

const SECONDS_PER_MINUTE = 60;

/** The OpenAPI document's version, tied to the wire protocol so a breaking change bumps both. */
const API_VERSION = `${RELAY_PROTOCOL_VERSION}.0.0`;

export interface BuildServerOptions {
  /** Request logging; on for the real process, off in tests. */
  readonly logger?: boolean;
  /** The relay's own database. The caller owns it and closes it. */
  readonly database: Database;
  /** The public keys access tokens are verified with (the host API signs them with the private half). */
  readonly tokenKeys: TokenKeyring;
  /** The `iss`/`aud` tokens must carry (config.ts). Required: the open relay has no default. */
  readonly tokenExpectations: TokenExpectations;
  /**
   * The operator principal, the account that owns every ASSISTANT device (config.ts). Absent or
   * `null`: no ASSISTANT device can be registered.
   */
  readonly operatorUserId?: string | null;
  /** Injected clock for the in-memory limiters and the key-package lifetimes, so tests can move time. */
  readonly now?: () => number;
  /**
   * The URL prefix every route is served under (config.ts `resolveRelayBasePath`): `''` for the origin
   * root, or a validated path such as `/relay`. Routes outside it answer 404. The OpenAPI document keeps
   * the unprefixed paths and names the prefix as its server URL.
   */
  readonly basePath?: string;
  /**
   * Origins other than its own that may call the relay from a browser (config.ts
   * `resolveRelayAllowedOrigins`, cors.ts). Absent or empty: same-origin clients only.
   */
  readonly allowedOrigins?: readonly string[];
}

/** Builds the relay process's Fastify app. Does not listen, so tests can `inject` into it. */
export async function buildServer(options: BuildServerOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: MAX_REQUEST_BODY_BYTES,
    requestTimeout: REQUEST_TIMEOUT_MS,
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    // Fastify's validator strips unknown body fields by default. A field the relay does not know
    // is a client bug (or an attempt, e.g. an `actor` in a body), and silently dropping it would
    // hide it; reject instead.
    ajv: { customOptions: { removeAdditional: false } },
  });

  const expect = options.tokenExpectations;
  const basePath = options.basePath ?? '';
  app.decorateRequest('principal', null);
  installErrorHandler(app);

  // Registered before the routes: the OpenAPI document is built from the routes added after it.
  await app.register(swagger, {
    openapi: {
      openapi: '3.0.3',
      info: {
        title: 'Masia relay',
        version: API_VERSION,
        description:
          'The open Masia relay: orders MLS commits per conversation (the epoch serializer), ' +
          'stores signed device lists and key packages, and delivers ciphertext it cannot read.',
      },
      // The paths below are relative to this server URL: the deployment's base path (`RELAY_BASE_PATH`,
      // config.ts), which swagger strips from the documented routes. "/" at an origin root.
      servers: [
        {
          url: basePath === '' ? '/' : basePath,
          description: 'This relay, at its configured base path',
        },
      ],
      components: {
        securitySchemes: {
          [BEARER_SECURITY_SCHEME]: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
            description:
              'EdDSA (Ed25519) access token from the host API, named by its `kid` header: { iss, aud, ' +
              'sub: userId, did: deviceId, role?: "FAMILY_ADMIN", ' +
              'adminOf?: userId[], guardianOf?: userId[], iat, exp }. `iss` and `aud` must equal the ' +
              "relay's configured RELAY_TOKEN_ISSUER and RELAY_TOKEN_AUDIENCE. Lives at most " +
              `${RELAY_TOKEN_TTL_SECONDS / SECONDS_PER_MINUTE} minutes; \`iat\` and \`exp\` are checked with ` +
              `${RELAY_TOKEN_CLOCK_TOLERANCE_SECONDS} seconds of clock tolerance. \`role\` alone grants nothing: ` +
              'an admin acts only on the users listed in `adminOf` (never the admin themself), and a ' +
              'guardian device only for the children listed in `guardianOf` (each list at most ' +
              `${MAX_ADMIN_OF_USERS}; a list without the role is refused).`,
          },
        },
      },
    },
  });

  const deviceLookups = createDeviceLookupLimiter({ now: options.now });
  const operatorUserId = options.operatorUserId ?? null;
  const deps: RouteDeps = {
    db: options.database,
    // Tokens are checked against the real clock: they are signed with it, and moving the test
    // clock (for the limiters) must not expire them.
    auth: createAuthHooks({ keyring: options.tokenKeys, db: options.database, expect }),
    serializer: createEpochSerializer(options.database, { now: options.now }),
    keyPackages: createKeyPackageDirectory(options.database, { now: options.now, operatorUserId }),
    deviceLists: createDeviceListDirectory(options.database, { limiter: deviceLookups, operatorUserId }),
    deviceLookups,
    operatorUserId,
  };

  // On the root scope, before the routes: a preflight to any path is answered here (cors.ts).
  registerCors(app, options.allowedOrigins ?? []);

  // Every route lives in one child scope so a deployment can mount the whole relay under a prefix
  // (`options.basePath`). With no prefix this is the same route table as before. The error handler,
  // the request decoration and the OpenAPI collection above are inherited by the scope.
  await app.register(
    async (scope) => {
      scope.get(
        RELAY_HEALTH_PATH,
        {
          schema: {
            operationId: 'getHealth',
            tags: ['health'],
            summary: 'Liveness and protocol version (no authentication)',
            response: {
              200: {
                type: 'object',
                properties: { ok: { type: 'boolean' }, protocol: { type: 'integer' } },
                required: ['ok', 'protocol'],
              },
            },
          },
        },
        async () => ({ ok: true, protocol: RELAY_PROTOCOL_VERSION }),
      );
      registerDeviceRoutes(scope, deps);
      registerDeviceListRoutes(scope, deps);
      registerKeyPackageRoutes(scope, deps);
      registerConversationRoutes(scope, deps);
    },
    { prefix: basePath },
  );

  return app;
}
