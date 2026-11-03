import {
  DEVICE_LIST_TARGET_LIMIT,
  DEVICE_LIST_USER_LIMIT,
  DEVICE_LIST_VERSIONS_PAGE_MAX,
  DEVICE_LIST_WINDOW_MS,
  type DeviceListEntry,
  MAX_DEVICES_PER_USER,
  MAX_PUBLIC_KEY_BYTES,
  MAX_SIGNATURE_BYTES,
  RelayError,
  RelayErrorCode,
} from '@masia/relay';
import type { FastifyInstance } from 'fastify';
import { principalOf } from '../auth.js';
import { putDeviceList } from '../domain/device-lists.js';
import { collection, fromBase64, toDeviceListDto, toDeviceListVersionDto } from '../dto.js';
import type { RouteDeps } from './route-deps.js';
import {
  bytesSchema,
  collectionSchema,
  errorResponses,
  idParams,
  idSchema,
  roleSchema,
  SECURITY,
  timestampSchema,
  versionSchema,
} from './schemas.js';

const TAG = 'device-lists';
const MS_PER_MINUTE = 60_000;

/** One line of the list. Mirrors `DeviceListEntry` (@masia/contracts/wire). */
const deviceListEntrySchema = {
  type: 'object',
  properties: {
    id: idSchema,
    role: roleSchema,
    signatureKey: bytesSchema(MAX_PUBLIC_KEY_BYTES, "The device's MLS signature public key"),
    conversationId: {
      ...idSchema,
      description:
        'ASSISTANT entries only: the one conversation the assistant device serves. Part of the ' +
        'signed bytes (`mls-device-list/v1`); on any other role 422 DEVICE_LIST_ENTRY_INVALID.',
    },
  },
  required: ['id', 'role', 'signatureKey'],
  additionalProperties: false,
} as const;

const deviceListResponseSchema = {
  type: 'object',
  properties: {
    userId: idSchema,
    version: versionSchema,
    devices: { type: 'array', items: deviceListEntrySchema },
    signature: bytesSchema(MAX_SIGNATURE_BYTES, "The owner's signature over the list"),
    updatedAt: timestampSchema,
  },
  required: ['userId', 'version', 'devices', 'signature', 'updatedAt'],
} as const;

/** One stored version. Mirrors `DeviceListVersion` (@masia/contracts/wire). */
const deviceListVersionSchema = {
  type: 'object',
  properties: {
    userId: idSchema,
    version: versionSchema,
    devices: { type: 'array', items: deviceListEntrySchema },
    signature: bytesSchema(MAX_SIGNATURE_BYTES, "The owner's signature over this version"),
  },
  required: ['userId', 'version', 'devices', 'signature'],
} as const;

interface PutDeviceListBody {
  version: number;
  devices: DeviceListEntry[];
  signature: string;
}

export function registerDeviceListRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { db, auth, deviceLists } = deps;

  app.post<{ Body: PutDeviceListBody }>(
    '/users/me/device-list',
    {
      onRequest: auth.requireActiveDevice,
      schema: {
        operationId: 'putOwnDeviceList',
        tags: [TAG],
        summary: "Store the caller's signed device list",
        description:
          'ADR-117 §2a. The relay stores the list exactly as the client signed it and never signs ' +
          'it itself. It applies two rules. The version must be the stored version + 1 (the first ' +
          'list is version 1), else 409 with `currentVersion`. The signature must verify under the ' +
          "account's pinned identity key over the canonical `mls-device-list/v1` bytes, else 422 " +
          'DEVICE_LIST_SIGNATURE_INVALID (`reason` is `BAD_SIGNATURE`, or `NO_PINNED_KEY` when ' +
          'the account has no pinned key yet: register a device first); every reader verifies the ' +
          'whole chain of versions, so one version nobody can verify would block all of them. ' +
          'Entries that cannot be signed in that format (a key that is not 32 bytes, an ASSISTANT ' +
          'entry without its conversation) are 422 DEVICE_LIST_ENTRY_INVALID. Every version is kept ' +
          '(append-only, `GET /users/{userId}/device-list/versions`). A `conversationId` is ' +
          'accepted on an ASSISTANT entry only (422 DEVICE_LIST_ENTRY_INVALID otherwise).',
        security: SECURITY,
        body: {
          type: 'object',
          properties: {
            version: versionSchema,
            devices: {
              type: 'array',
              items: deviceListEntrySchema,
              maxItems: MAX_DEVICES_PER_USER,
            },
            signature: bytesSchema(MAX_SIGNATURE_BYTES, "The owner's signature over the list"),
          },
          required: ['version', 'devices', 'signature'],
          additionalProperties: false,
        },
        response: {
          201: { description: 'Stored.', ...deviceListResponseSchema },
          ...errorResponses(409, 422),
        },
      },
    },
    async (request, reply) => {
      const { body } = request;
      const stored = await putDeviceList(db, principalOf(request).userId, {
        version: body.version,
        devices: body.devices,
        signature: fromBase64(body.signature, MAX_SIGNATURE_BYTES),
      });
      return reply.code(201).send(toDeviceListDto(stored));
    },
  );

  app.get<{ Params: { userId: string } }>(
    '/users/:userId/device-list',
    {
      onRequest: auth.requireActiveDevice,
      schema: {
        operationId: 'getUserDeviceList',
        tags: [TAG],
        summary: "A user's current signed device list",
        description:
          "Clients verify the signature against the user's pinned identity key; the relay checked it " +
          'once, when the list was stored, but is not trusted for it. ' +
          'Readable by the owner, by an admin of the owner (`adminOf`) and by a contact: a device ' +
          "that shares (or shared) a room with one of the owner's devices. The operator's list (the " +
          'account that owns every ASSISTANT device) is readable by every device. Anyone else gets ' +
          '403 NOT_A_CONTACT, the same for a user who exists and one who does not. ' +
          'The gate is checked first, then the lookup budget (429 with `Retry-After`) that the ' +
          'relationship prices: your own list, the list of a user you administer and that of a ' +
          'user you share a room with cost nothing (an open client re-reads those about once a ' +
          'minute on every device); the operator account costs the calling user ' +
          `(${DEVICE_LIST_USER_LIMIT} per ${DEVICE_LIST_WINDOW_MS / MS_PER_MINUTE} minutes across all ` +
          'of their devices, 429 ACTOR_RATE_LIMITED) and no target budget, so nobody can make it ' +
          "unreachable for the others; a user reached through the token's `reach` claim costs the " +
          `calling user and the target (${DEVICE_LIST_TARGET_LIMIT} across all callers, 429 ` +
          'TARGET_RATE_LIMITED); a refused stranger (403) costs the calling user, so a walk through ' +
          'the user ids stops after one budget.',
        security: SECURITY,
        params: idParams('userId'),
        response: {
          200: { description: 'The current list.', ...deviceListResponseSchema },
          ...errorResponses(404, 429),
        },
      },
    },
    async (request) => {
      const list = await deviceLists.lookup(principalOf(request), request.params.userId);
      if (list === null) {
        throw new RelayError(RelayErrorCode.DEVICE_LIST_NOT_FOUND, 'That user has no device list yet.');
      }
      return toDeviceListDto(list);
    },
  );

  app.get<{
    Params: { userId: string };
    Querystring: { afterVersion: number; limit: number };
  }>(
    '/users/:userId/device-list/versions',
    {
      onRequest: auth.requireActiveDevice,
      schema: {
        operationId: 'listUserDeviceListVersions',
        tags: [TAG],
        summary: "Every stored version of a user's signed device list newer than `afterVersion`",
        description:
          'The relay keeps every version (append-only). A member that pinned version N passes ' +
          '`afterVersion=N` and verifies each row, oldest first, against the pinned identity key: ' +
          'the rows are exactly what the owner uploaded, so the client rebuilds the signed ' +
          '`mls-device-list/v1` bytes from them. `nextCursor` is the last version on the page (pass ' +
          `it as \`afterVersion\`), null on the last page; at most ${DEVICE_LIST_VERSIONS_PAGE_MAX} ` +
          'rows a page. A user with no list (or none newer) is an empty page. Same contact gate ' +
          '(403 NOT_A_CONTACT) and same lookup budget and pricing as `GET /users/{userId}/device-list`.',
        security: SECURITY,
        params: idParams('userId'),
        querystring: {
          type: 'object',
          properties: {
            afterVersion: { type: 'integer', minimum: 0, maximum: versionSchema.maximum, default: 0 },
            limit: {
              type: 'integer',
              minimum: 1,
              maximum: DEVICE_LIST_VERSIONS_PAGE_MAX,
              default: DEVICE_LIST_VERSIONS_PAGE_MAX,
            },
          },
          additionalProperties: false,
        },
        response: {
          200: {
            description: 'Versions newer than `afterVersion`, oldest first.',
            ...collectionSchema(deviceListVersionSchema),
          },
          ...errorResponses(429),
        },
      },
    },
    async (request) => {
      const { afterVersion, limit } = request.query;
      const page = await deviceLists.versions(
        principalOf(request),
        request.params.userId,
        afterVersion,
        limit,
      );
      const last = page.rows[page.rows.length - 1];
      return collection(
        page.rows.map(toDeviceListVersionDto),
        page.hasMore && last !== undefined ? String(last.version) : null,
      );
    },
  );
}
