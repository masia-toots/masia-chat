import {
  CLAIM_LIMIT,
  CLAIM_TARGET_LIMIT,
  CLAIM_USER_LIMIT,
  CLAIM_WINDOW_MS,
  type ClaimKeyPackagesRequest,
  KEY_PACKAGE_UPLOAD_DEVICE_LIMIT,
  KEY_PACKAGE_UPLOAD_USER_LIMIT,
  KEY_PACKAGE_UPLOAD_WINDOW_MS,
  MAX_DEVICES_PER_USER,
  MAX_KEY_PACKAGE_BYTES,
  MAX_KEY_PACKAGES_PER_UPLOAD,
  MAX_UNCLAIMED_KEY_PACKAGES_PER_DEVICE,
} from '@masia/relay';
import type { FastifyInstance } from 'fastify';
import { principalOf } from '../auth.js';
import { collection, fromBase64, toClaimedKeyPackageDto } from '../dto.js';
import type { RouteDeps } from './route-deps.js';
import {
  bytesSchema,
  collectionSchema,
  errorResponses,
  idSchema,
  SECURITY,
  uuidSchema,
} from './schemas.js';

const TAG = 'key-packages';
const MS_PER_MINUTE = 60_000;

const keyPackageBytesSchema = bytesSchema(MAX_KEY_PACKAGE_BYTES, 'An MLS KeyPackage');

interface UploadItem {
  bytes: string;
  /** Defaulted to false by the schema (`useDefaults`). */
  lastResort: boolean;
}

export function registerKeyPackageRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { auth, keyPackages } = deps;

  app.post<{ Body: UploadItem[] }>(
    '/key-packages',
    {
      onRequest: auth.requireActiveDevice,
      schema: {
        operationId: 'uploadKeyPackages',
        tags: [TAG],
        summary: 'Upload key packages for the calling device',
        description:
          "The body is an array of MLS KeyPackages (as MLSMessages). The relay reads each one's " +
          'lifetime from its cleartext: an unreadable package is 422 KEY_PACKAGE_UNREADABLE ' +
          '(with `index`, `field`, `reason`), an expired one 422 KEY_PACKAGE_EXPIRED; expired ' +
          'packages are never served and are purged. After the upload the device must own at ' +
          'least one unexpired last-resort package (kept even when the pool is empty, never ' +
          'consumed), else 422 LAST_RESORT_REQUIRED, and at most ' +
          `${MAX_UNCLAIMED_KEY_PACKAGES_PER_DEVICE} unclaimed packages, else 409 ` +
          'KEY_PACKAGE_POOL_FULL; either refusal rolls the whole upload back. Uploads are limited ' +
          `to ${KEY_PACKAGE_UPLOAD_DEVICE_LIMIT} per device and ${KEY_PACKAGE_UPLOAD_USER_LIMIT} ` +
          `per user per ${KEY_PACKAGE_UPLOAD_WINDOW_MS / MS_PER_MINUTE} minutes (429 ` +
          'UPLOAD_RATE_LIMITED, `Retry-After`). A package the device already holds (the same ' +
          'bytes, spent or not) is skipped, not stored twice, and not counted in `uploaded`, so a ' +
          'retried upload is safe and answers `uploaded: 0` with the same `available`: an MLS ' +
          'KeyPackage is single use and must never reach two claimers. `available` is how many ' +
          'ordinary packages remain.',
        security: SECURITY,
        body: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_KEY_PACKAGES_PER_UPLOAD,
          items: {
            type: 'object',
            properties: {
              bytes: keyPackageBytesSchema,
              lastResort: { type: 'boolean', default: false },
            },
            required: ['bytes'],
            additionalProperties: false,
          },
        },
        response: {
          201: {
            description: 'Stored.',
            type: 'object',
            properties: { uploaded: { type: 'integer' }, available: { type: 'integer' } },
            required: ['uploaded', 'available'],
          },
          ...errorResponses(409, 422, 429),
        },
      },
    },
    async (request, reply) => {
      const principal = principalOf(request);
      const result = await keyPackages.upload(
        { userId: principal.userId, deviceId: principal.deviceId },
        request.body.map((item) => ({
          bytes: fromBase64(item.bytes, MAX_KEY_PACKAGE_BYTES),
          lastResort: item.lastResort,
        })),
      );
      return reply.code(201).send(result);
    },
  );

  app.post<{ Body: ClaimKeyPackagesRequest }>(
    '/key-packages/claim',
    {
      onRequest: auth.requireActiveDevice,
      schema: {
        operationId: 'claimKeyPackages',
        tags: [TAG],
        summary: 'Claim one key package per active device of a user, or of the devices named',
        description:
          'Returns, for each non-revoked device of the user, its newest unexpired unconsumed ' +
          "ordinary package (marking it consumed) or, when that device's pool is empty, its " +
          'newest unexpired last-resort package (not consumed). `deviceIds` narrows the claim to ' +
          `those devices (1 to ${MAX_DEVICES_PER_USER} ids; an empty list is 400, never "all"): ` +
          'it is a filter over the active devices, not a demand, so an id that is unknown, ' +
          "revoked, another person's, or has no package to give is absent from the answer " +
          '(the same for each; compare the answer\'s `deviceId`s with what you asked for), and ' +
          "no other device's package is touched. Without it, every active device answers. " +
          'Either way the rows come oldest device first. Every claim is recorded: a commit ' +
          'may later add a device only with a package that its own committer claimed. Claims are ' +
          `limited per calling device (${CLAIM_LIMIT} per ${CLAIM_WINDOW_MS / MS_PER_MINUTE} ` +
          `minutes, 429 CLAIM_RATE_LIMITED), per calling user across all of their devices ` +
          `(${CLAIM_USER_LIMIT}, 429 ACTOR_RATE_LIMITED) and per target user across all callers ` +
          `(${CLAIM_TARGET_LIMIT}, 429 TARGET_RATE_LIMITED; claiming your own packages is not ` +
          'counted against the target; naming devices changes none of the budgets), with ' +
          "`Retry-After`: an unlimited claim is a way to drain a victim's pool. Only the owner, an admin of the owner (`adminOf`) or a contact (a device " +
          "that shares or shared a room with one of the user's devices) may claim; the operator's " +
          'packages (the account that owns every ASSISTANT device) are claimable by every device. ' +
          'Anyone else gets 403 NOT_A_CONTACT, checked after the limits and before any package is ' +
          'handed out.',
        security: SECURITY,
        body: {
          type: 'object',
          properties: {
            userId: idSchema,
            deviceIds: {
              type: 'array',
              items: idSchema,
              minItems: 1,
              maxItems: MAX_DEVICES_PER_USER,
              description:
                "Only these of the user's devices (a repeated id counts once); left out: all of them.",
            },
          },
          required: ['userId'],
          additionalProperties: false,
        },
        response: {
          200: {
            description: 'One package per active device (of those named, when `deviceIds` is given).',
            ...collectionSchema({
              type: 'object',
              properties: {
                deviceId: idSchema,
                keyPackageId: uuidSchema,
                bytes: keyPackageBytesSchema,
                lastResort: { type: 'boolean' },
              },
              required: ['deviceId', 'keyPackageId', 'bytes', 'lastResort'],
            }),
          },
          ...errorResponses(429),
        },
      },
    },
    async (request) => {
      const principal = principalOf(request);
      const { userId, deviceIds } = request.body;
      const claimed = await keyPackages.claim(principal, userId, deviceIds);
      return collection(claimed.map(toClaimedKeyPackageDto));
    },
  );
}
