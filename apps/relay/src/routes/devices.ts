import {
  DEVICE_LIST_TARGET_LIMIT,
  DEVICE_LIST_USER_LIMIT,
  DEVICE_LIST_WINDOW_MS,
  DeviceRole,
  MAX_PUBLIC_KEY_BYTES,
} from '@masia/relay';
import type { FastifyInstance } from 'fastify';
import { principalOf } from '../auth.js';
import {
  admitLookup,
  findIdentityKey,
  listActiveDevices,
  LookupReach,
  registerDevice,
  resetIdentityKey,
  revokeDevice,
} from '../domain/devices.js';
import { collection, fromBase64, toBase64, toDeviceDto, toPublicDeviceDto } from '../dto.js';
import type { RouteDeps } from './route-deps.js';
import {
  bytesSchema,
  collectionSchema,
  errorResponse,
  errorResponses,
  idParams,
  idSchema,
  labelSchema,
  nullableTimestampSchema,
  roleSchema,
  SECURITY,
  timestampSchema,
} from './schemas.js';

const TAG = 'devices';
const MS_PER_MINUTE = 60_000;

/** The device as the wire shows it. Mirrors `DeviceDto` (dto.ts); the serializer drops anything else. */
const deviceResponseSchema = {
  type: 'object',
  properties: {
    id: idSchema,
    userId: idSchema,
    role: roleSchema,
    name: labelSchema,
    platform: labelSchema,
    identityKeyPub: bytesSchema(MAX_PUBLIC_KEY_BYTES, 'The device identity public key'),
    signatureKeyPub: bytesSchema(MAX_PUBLIC_KEY_BYTES, 'The device MLS signature public key'),
    createdAt: timestampSchema,
    lastSeenAt: nullableTimestampSchema,
    revokedAt: nullableTimestampSchema,
  },
  required: [
    'id',
    'userId',
    'role',
    'name',
    'platform',
    'identityKeyPub',
    'signatureKeyPub',
    'createdAt',
    'lastSeenAt',
    'revokedAt',
  ],
} as const;

/** What another user sees of a device. Mirrors `PublicDeviceDto` (dto.ts). */
const publicDeviceResponseSchema = {
  type: 'object',
  properties: {
    id: idSchema,
    role: roleSchema,
    identityKeyPub: deviceResponseSchema.properties.identityKeyPub,
    signatureKeyPub: deviceResponseSchema.properties.signatureKeyPub,
  },
  required: ['id', 'role', 'identityKeyPub', 'signatureKeyPub'],
} as const;

/** `GET /users/:userId/devices`: the collection plus the person's pinned identity key. */
const devicesCollectionSchema = (() => {
  const base = collectionSchema({ anyOf: [deviceResponseSchema, publicDeviceResponseSchema] });
  return {
    ...base,
    properties: {
      ...base.properties,
      identityKeyPub: {
        ...bytesSchema(MAX_PUBLIC_KEY_BYTES, "The person's pinned identity key"),
        type: ['string', 'null'],
      },
    },
    required: [...base.required, 'identityKeyPub'],
  } as const;
})();

interface RegisterDeviceBody {
  id: string;
  /** The account the device belongs to; the token's own user when omitted. */
  userId?: string;
  /** Defaulted to USER by the schema (`useDefaults`), so it is always present here. */
  role: DeviceRole;
  name?: string | null;
  platform?: string | null;
  identityKeyPub: string;
  signatureKeyPub: string;
}

export function registerDeviceRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { db, auth, deviceLookups, operatorUserId } = deps;

  app.post<{ Body: RegisterDeviceBody }>(
    '/devices',
    {
      // `authenticate`, not `requireActiveDevice`: the device being registered does not exist yet.
      onRequest: auth.authenticate,
      schema: {
        operationId: 'registerDevice',
        tags: [TAG],
        summary: 'Register the calling device, or refresh its label',
        description:
          'The id must equal the `did` of the token. Keys, role and owner are fixed once ' +
          'registered; only `name` and `platform` can change. 201 when new, 200 when refreshed. ' +
          "`userId` is the account the device belongs to (default: the token's user). A USER " +
          "device belongs to the token's user. A GUARDIAN device belongs to the CHILD it guards: " +
          "`userId` is the child, who must be listed in the token's `guardianOf`. An ASSISTANT device " +
          "is registered only by the relay's operator principal, for itself. Anything else is " +
          "403 ROLE_FORBIDDEN. `identityKeyPub` of a USER or ASSISTANT device is the ACCOUNT's " +
          'identity key (the key that signs its device list; for the operator, the operator key): ' +
          'the first USER or ASSISTANT device pins it for the user, every later device of either ' +
          'role must carry the same key, else 409 IDENTITY_KEY_CHANGED. A GUARDIAN device neither ' +
          'pins nor must match. Only the explicit reset (`DELETE /users/{userId}/identity-key`) ' +
          'releases the pin. The 409 carries the pinned key as `identityKeyPub` (base64), because ' +
          'a second device cannot read it any other way before it is registered: it registers ' +
          "again with that key. Only the account's own token reaches that answer (a USER device is " +
          "registered for the token's user alone, an ASSISTANT device only by the operator for " +
          'itself), so it tells an account its own public key.',
        security: SECURITY,
        body: {
          type: 'object',
          properties: {
            id: idSchema,
            userId: idSchema,
            role: { ...roleSchema, default: DeviceRole.USER },
            name: labelSchema,
            platform: labelSchema,
            identityKeyPub: bytesSchema(MAX_PUBLIC_KEY_BYTES, 'The device identity public key'),
            signatureKeyPub: bytesSchema(
              MAX_PUBLIC_KEY_BYTES,
              'The device MLS signature public key',
            ),
          },
          required: ['id', 'identityKeyPub', 'signatureKeyPub'],
          additionalProperties: false,
        },
        response: {
          200: { description: 'Already registered; label refreshed.', ...deviceResponseSchema },
          201: { description: 'Registered.', ...deviceResponseSchema },
          ...errorResponses(),
          409: errorResponse(
            409,
            {
              identityKeyPub: bytesSchema(
                MAX_PUBLIC_KEY_BYTES,
                "The person's pinned identity key, on IDENTITY_KEY_CHANGED",
              ),
            },
            'IDENTITY_KEY_CHANGED carries `identityKeyPub`, the key the person has pinned.',
          ),
        },
      },
    },
    async (request, reply) => {
      const { body } = request;
      const principal = principalOf(request);
      const { device, created } = await registerDevice(
        db,
        principal,
        {
          id: body.id,
          userId: body.userId ?? principal.userId,
          role: body.role,
          name: body.name ?? null,
          platform: body.platform ?? null,
          identityKeyPub: fromBase64(body.identityKeyPub, MAX_PUBLIC_KEY_BYTES),
          signatureKeyPub: fromBase64(body.signatureKeyPub, MAX_PUBLIC_KEY_BYTES),
        },
        { operatorUserId },
      );
      return reply.code(created ? 201 : 200).send(toDeviceDto(device));
    },
  );

  app.get<{ Params: { userId: string } }>(
    '/users/:userId/devices',
    {
      onRequest: auth.requireActiveDevice,
      schema: {
        operationId: 'listUserDevices',
        tags: [TAG],
        summary: "A user's devices that are not revoked",
        description:
          'Your own devices, and those of a user you administer (`adminOf`), come in full. Anyone ' +
          "else's come only as `{ id, role, identityKeyPub, signatureKeyPub }`, and only when " +
          "the calling device shares (or shared) a room with one of that user's devices (403 " +
          "NOT_A_CONTACT otherwise): the relay's only notion of a contact. The operator's devices " +
          '(the account that owns every ASSISTANT device) come as public rows to every device. ' +
          'The same gate guards the signed device list and the key-package claim; a user named in the ' +
          "token's `reach` claim (the host's introduction) counts as a contact. `identityKeyPub` " +
          "beside `rows` is the account's pinned identity key (null when none is pinned; the operator's " +
          'is pinned by its first ASSISTANT device, so it is never null once one is registered): the key ' +
          'a correspondent pins (TOFU) and verifies the signed device list with. The gate is checked ' +
          'first; the lookup budget is shared with `GET /users/:userId/device-list` and is spent only ' +
          'by lookups that could be part of a walk through the user ids: your own devices, those of a ' +
          'user you administer and those of a user you share a room with cost nothing; the ' +
          "operator's cost the calling user's budget; a user reached through the token's `reach` " +
          "claim costs the calling user's budget and the target's; a refused stranger (403) costs " +
          `the calling user's budget (per calling user ${DEVICE_LIST_USER_LIMIT}, per target user ` +
          `${DEVICE_LIST_TARGET_LIMIT}, per ${DEVICE_LIST_WINDOW_MS / MS_PER_MINUTE} minutes; ` +
          '429 with `Retry-After`).',
        security: SECURITY,
        params: idParams('userId'),
        response: {
          200: {
            description:
              'Active devices, oldest first: full rows for the owner and their admins, public ' +
              'rows (id, role, keys) for a contact.',
            ...devicesCollectionSchema,
          },
          ...errorResponses(429),
        },
      },
    },
    async (request) => {
      const principal = principalOf(request);
      const targetUserId = request.params.userId;
      const reach = await admitLookup(db, deviceLookups, principal, targetUserId, operatorUserId);
      const devices = await listActiveDevices(db, targetUserId);
      const identityKey = await findIdentityKey(db, targetUserId);
      return {
        ...collection(devices.map(reach === LookupReach.FULL ? toDeviceDto : toPublicDeviceDto)),
        identityKeyPub: identityKey === null ? null : toBase64(identityKey),
      };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/devices/:id/revoke',
    {
      onRequest: auth.requireActiveDevice,
      schema: {
        operationId: 'revokeDevice',
        tags: [TAG],
        summary: 'Revoke a device so it can no longer act',
        description:
          'Allowed for another device of the same user, or for a FAMILY_ADMIN token whose ' +
          "`adminOf` lists the device's user. A device that does not exist and a device the " +
          'caller may not revoke get the same 403 REVOKE_FORBIDDEN. ' +
          'ADR-117 §5a: revoking a token does not remove an MLS leaf, so the client MUST have ' +
          'committed MLS Remove for this device in every room first (Remove, then revoke). The ' +
          'relay holds the line: while the device is still a member of any room the answer is ' +
          '409 STILL_IN_ROOMS. Revoking an already-revoked device is a no-op that returns it.',
        security: SECURITY,
        params: idParams('id'),
        response: {
          200: { description: 'The revoked device.', ...deviceResponseSchema },
          ...errorResponses(409),
        },
      },
    },
    async (request) => toDeviceDto(await revokeDevice(db, principalOf(request), request.params.id)),
  );

  app.delete<{ Params: { userId: string } }>(
    '/users/:userId/identity-key',
    {
      onRequest: auth.requireActiveDevice,
      schema: {
        operationId: 'resetIdentityKey',
        tags: [TAG],
        summary: "Release an account's pinned identity key (the explicit reset)",
        description:
          "The «new person to the cryptography» flow (canon §3): after it, the account's next USER " +
          'or ASSISTANT device pins a fresh identity key and every correspondent sees a key change. ' +
          'Host-driven: only a FAMILY_ADMIN token whose `adminOf` lists the user (never the caller ' +
          "themself: the operator principal's own device is still active behind its token, so it " +
          'cannot reset its own key), and only once every USER and ASSISTANT device of the account ' +
          'is revoked (409 IDENTITY_KEY_IN_USE with `devices` otherwise; GUARDIAN devices do not ' +
          'count). Anyone else gets 403 REVOKE_FORBIDDEN. A user with no pin is a no-op. The reset ' +
          "also discards the account's signed device list and every stored version of it: the next " +
          'key starts a new chain at version 1, so no reader is served a version signed by the ' +
          'released key.',
        security: SECURITY,
        params: idParams('userId'),
        response: {
          204: { description: 'The pin is released.', type: 'null' },
          ...errorResponses(409),
        },
      },
    },
    async (request, reply) => {
      await resetIdentityKey(db, principalOf(request), request.params.userId);
      return reply.code(204).send();
    },
  );
}
