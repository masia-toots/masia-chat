import {
  type ApproveIdentityRequestBody,
  type CreateIdentityRequestBody,
  ED25519_SIGNATURE_BYTES,
  IDENTITY_REQUEST_DAILY_LIMIT,
  IDENTITY_REQUEST_LIMIT_WINDOW_MS,
  IDENTITY_REQUEST_OPEN_LIMIT,
  IDENTITY_REQUEST_TTL_MS,
  type IdentityRequestNonceBody,
  IdentityRequestPurpose,
  IdentityRequestState,
  MAX_PUBLIC_KEY_BYTES,
  PAIRING_COMMITMENT_BYTES,
  PAIRING_NONCE_BYTES,
  REJECTED_IDENTITY_REQUEST_TTL_MS,
  SEALED_IDENTITY_ENC_BYTES,
  SEALED_IDENTITY_MAX_BYTES,
  SEALED_IDENTITY_TTL_MS,
  TRANSFER_KEY_BYTES,
} from '@masia/relay';
import type { FastifyInstance } from 'fastify';
import { principalOf } from '../auth.js';
import { IdentityRequestLimit, IdentityRequestRefusal } from '../domain/identity-requests.js';
import { collection, fromBase64, toIdentityRequestDto } from '../dto.js';
import type { RouteDeps } from './route-deps.js';
import {
  bytesSchema,
  collectionSchema,
  errorResponse,
  errorResponses,
  idSchema,
  SECURITY,
  timestampSchema,
  uuidSchema,
  versionSchema,
} from './schemas.js';

/**
 * ADR-218 §1, §2, §4: the routes of the identity transfer, all under the token's own account
 * (`/users/me/identity-requests`). The rules live in `domain/identity-requests.ts`; this file is
 * the wire: schemas, decoding, and the documented answers.
 */

const TAG = 'identity-requests';
const BASE = '/users/me/identity-requests';
const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;

function nullable<T extends object>(schema: T) {
  return { ...schema, nullable: true } as const;
}

/** The sealed identity key. Mirrors `SealedIdentityDto` (@masia/contracts/wire). */
const sealedSchema = {
  type: 'object',
  properties: {
    enc: bytesSchema(
      SEALED_IDENTITY_ENC_BYTES,
      `The HPKE encapsulated key, ${SEALED_IDENTITY_ENC_BYTES} bytes`,
    ),
    ciphertext: bytesSchema(SEALED_IDENTITY_MAX_BYTES, 'The sealed identity private key'),
  },
  required: ['enc', 'ciphertext'],
  additionalProperties: false,
} as const;

/** One request. Mirrors `IdentityRequestDto` (@masia/contracts/wire); the serializer drops the rest. */
const identityRequestSchema = {
  type: 'object',
  properties: {
    id: uuidSchema,
    deviceId: { ...idSchema, description: 'The device asking (N)' },
    purpose: { type: 'string', enum: Object.values(IdentityRequestPurpose) },
    state: { type: 'string', enum: Object.values(IdentityRequestState) },
    transferKey: bytesSchema(TRANSFER_KEY_BYTES, "N's one-time transfer key (X25519)"),
    commitment: nullable(
      bytesSchema(PAIRING_COMMITMENT_BYTES, "pair only: N's commitment to its nonce"),
    ),
    signature: bytesSchema(ED25519_SIGNATURE_BYTES, "N's device-key signature over the request"),
    challengerDeviceId: nullable({ ...idSchema, description: 'The holder that challenged' }),
    holderNonce: nullable(bytesSchema(PAIRING_NONCE_BYTES, "The challenger's nonce r_B")),
    deviceNonce: nullable(bytesSchema(PAIRING_NONCE_BYTES, "N's nonce r_N, once revealed")),
    listVersion: nullable({ ...versionSchema, description: 'The list version the approval named' }),
    sealed: nullable({
      ...sealedSchema,
      description:
        'The sealed identity key: served to the requesting device only, from approval until its ' +
        `holder proof or ${SEALED_IDENTITY_TTL_MS / MS_PER_HOUR} hours; null for every other reader.`,
    }),
    createdAt: timestampSchema,
    expiresAt: timestampSchema,
  },
  required: [
    'id',
    'deviceId',
    'purpose',
    'state',
    'transferKey',
    'commitment',
    'signature',
    'challengerDeviceId',
    'holderNonce',
    'deviceNonce',
    'listVersion',
    'sealed',
    'createdAt',
    'expiresAt',
  ],
} as const;

const requestParams = {
  type: 'object',
  properties: { id: uuidSchema },
  required: ['id'],
  additionalProperties: false,
} as const;

const nonceBody = {
  type: 'object',
  properties: { nonce: bytesSchema(PAIRING_NONCE_BYTES, `A ${PAIRING_NONCE_BYTES}-byte nonce`) },
  required: ['nonce'],
  additionalProperties: false,
} as const;

/** The facts a 409 of these routes carries beside `error` and `message`. */
const conflictFacts = {
  state: {
    type: 'string',
    enum: Object.values(IdentityRequestState),
    description: "The request's state, on IDENTITY_REQUEST_STATE about an existing request",
  },
  reason: {
    type: 'string',
    enum: Object.values(IdentityRequestRefusal),
    description: 'What else made the request wrong for the action, on IDENTITY_REQUEST_STATE',
  },
  challengerDeviceId: {
    ...idSchema,
    description: 'The holder that challenged, on NOT_THE_CHALLENGER',
  },
} as const;

const conflict = errorResponse(
  409,
  conflictFacts,
  'IDENTITY_REQUEST_STATE carries `state` (and `reason` when the state alone does not explain it).',
);

const SELF_ONLY =
  "Only a USER device of the token's own account may call it (403 ROLE_FORBIDDEN): GUARDIAN and " +
  "ASSISTANT devices never hold a person's identity key.";

const HOLDER_ONLY =
  'Only a HOLDER may call it (403 NOT_A_HOLDER): an unrevoked USER device of the account, on its ' +
  'latest stored device list with its own signature key, whose holder proof verifies under the ' +
  'pinned identity key (`PUT /devices/me/holder-proof`).';

const NOT_FOUND_NOTE =
  "Another account's request, and one retention has purged, are 404 NOT_FOUND alike.";

export function registerIdentityRequestRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { auth, identityRequests } = deps;

  app.post<{ Body: CreateIdentityRequestBody }>(
    BASE,
    {
      onRequest: auth.requireActiveDevice,
      schema: {
        operationId: 'createIdentityRequest',
        tags: [TAG],
        summary: "Ask for the person's identity key (the calling device is N)",
        description:
          "`signature` is the calling device's registered signature key over " +
          '`identityRequestBytes` (`mls-identity-request/v1`); 422 IDENTITY_REQUEST_SIGNATURE_INVALID ' +
          'otherwise. `pair` (with `commitment`): the device is NOT on the latest stored device list ' +
          '(409 IDENTITY_REQUEST_STATE `reason: LISTED` otherwise). `backfill` (no `commitment`): the ' +
          'device IS on it (422 DEVICE_NOT_IN_SIGNED_LIST otherwise) and holds no valid holder proof ' +
          '(409 `reason: HOLDER`). The device must be registered under the pinned identity key (409 ' +
          'IDENTITY_KEY_CHANGED with the pin as `identityKeyPub`), and a key must be pinned (409 ' +
          `IDENTITY_RESET_PENDING). ${SELF_ONLY} A request lives ` +
          `${IDENTITY_REQUEST_TTL_MS / MS_PER_MINUTE} minutes from creation, number step included. A ` +
          "device's new request replaces its open one (which expires). Caps per account: " +
          `${IDENTITY_REQUEST_OPEN_LIMIT} open, ${IDENTITY_REQUEST_DAILY_LIMIT} created per ` +
          `${IDENTITY_REQUEST_LIMIT_WINDOW_MS / MS_PER_HOUR} hours (429 IDENTITY_REQUEST_LIMIT with ` +
          '`limit` and `max`; a rule, not load: no `Retry-After`, do not retry).',
        security: SECURITY,
        body: {
          type: 'object',
          properties: {
            purpose: { type: 'string', enum: Object.values(IdentityRequestPurpose) },
            transferKey: bytesSchema(
              TRANSFER_KEY_BYTES,
              `T_N, raw X25519, ${TRANSFER_KEY_BYTES} bytes`,
            ),
            commitment: bytesSchema(
              PAIRING_COMMITMENT_BYTES,
              `pair only: the commitment to r_N, ${PAIRING_COMMITMENT_BYTES} bytes`,
            ),
            signature: bytesSchema(
              ED25519_SIGNATURE_BYTES,
              `The device-key signature, ${ED25519_SIGNATURE_BYTES} bytes`,
            ),
          },
          required: ['purpose', 'transferKey', 'signature'],
          additionalProperties: false,
        },
        response: {
          201: { description: 'The request, OPEN.', ...identityRequestSchema },
          ...errorResponses(422),
          409: errorResponse(
            409,
            {
              ...conflictFacts,
              identityKeyPub: bytesSchema(
                MAX_PUBLIC_KEY_BYTES,
                "The person's pinned identity key, on IDENTITY_KEY_CHANGED",
              ),
            },
            'IDENTITY_REQUEST_STATE carries `reason`; IDENTITY_KEY_CHANGED carries `identityKeyPub`.',
          ),
          429: errorResponse(
            429,
            {
              limit: {
                type: 'string',
                enum: Object.values(IdentityRequestLimit),
                description: 'Which cap was reached',
              },
              max: { type: 'integer', description: 'The cap' },
            },
            'IDENTITY_REQUEST_LIMIT carries `limit` and `max`.',
          ),
        },
      },
    },
    async (request, reply) => {
      const { body } = request;
      const view = await identityRequests.create(principalOf(request), {
        purpose: body.purpose,
        transferKey: fromBase64(body.transferKey, TRANSFER_KEY_BYTES),
        commitment:
          body.commitment === undefined
            ? null
            : fromBase64(body.commitment, PAIRING_COMMITMENT_BYTES),
        signature: fromBase64(body.signature, ED25519_SIGNATURE_BYTES),
      });
      return reply.code(201).send(toIdentityRequestDto(view));
    },
  );

  app.get(
    BASE,
    {
      onRequest: auth.requireActiveDevice,
      schema: {
        operationId: 'listIdentityRequests',
        tags: [TAG],
        summary: "The account's identity requests",
        description:
          'Every request the relay still holds for the account, oldest first, in one page ' +
          '(`nextCursor` is always null: the caps keep it short). Holders read it at the room pace and ' +
          'on focus or a push. `state` is computed at read time; an EXPIRED or REJECTED request is ' +
          `served until retention purges it (a rejected one for at least ` +
          `${REJECTED_IDENTITY_REQUEST_TTL_MS / MS_PER_HOUR} hours, so each holder can say so once). ` +
          `\`sealed\` is null except for the requesting device. ${SELF_ONLY}`,
        security: SECURITY,
        response: {
          200: { description: 'The requests.', ...collectionSchema(identityRequestSchema) },
          ...errorResponses(),
        },
      },
    },
    async (request) => {
      const views = await identityRequests.list(principalOf(request));
      return collection(views.map(toIdentityRequestDto));
    },
  );

  app.get<{ Params: { id: string } }>(
    `${BASE}/:id`,
    {
      onRequest: auth.requireActiveDevice,
      schema: {
        operationId: 'getIdentityRequest',
        tags: [TAG],
        summary: 'One identity request (N polls its own here)',
        description:
          'N reads `holderNonce` once challenged and `sealed` once approved. `sealed` is served to the ' +
          'requesting device only, until its holder proof deletes it or ' +
          `${SEALED_IDENTITY_TTL_MS / MS_PER_HOUR} hours after approval. ${NOT_FOUND_NOTE} ${SELF_ONLY}`,
        security: SECURITY,
        params: requestParams,
        response: {
          200: { description: 'The request.', ...identityRequestSchema },
          ...errorResponses(404),
        },
      },
    },
    async (request) =>
      toIdentityRequestDto(await identityRequests.get(principalOf(request), request.params.id)),
  );

  app.delete<{ Params: { id: string } }>(
    `${BASE}/:id`,
    {
      onRequest: auth.requireActiveDevice,
      schema: {
        operationId: 'cancelIdentityRequest',
        tags: [TAG],
        summary: 'N cancels its own request («Скасувати»)',
        description:
          'The request expires now (state EXPIRED); nothing is revoked. Only the device that asked ' +
          '(403 DEVICE_MISMATCH otherwise). An expired request is a no-op; an APPROVED or REJECTED one ' +
          `is 409 IDENTITY_REQUEST_STATE. ${NOT_FOUND_NOTE}`,
        security: SECURITY,
        params: requestParams,
        response: {
          204: { description: 'Cancelled.', type: 'null' },
          ...errorResponses(404),
          409: conflict,
        },
      },
    },
    async (request, reply) => {
      await identityRequests.cancel(principalOf(request), request.params.id);
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { id: string }; Body: IdentityRequestNonceBody }>(
    `${BASE}/:id/challenge`,
    {
      onRequest: auth.requireActiveDevice,
      schema: {
        operationId: 'challengeIdentityRequest',
        tags: [TAG],
        summary: 'A holder starts the number step with its nonce r_B («Це я»)',
        description:
          'A `pair` request in state OPEN only, and once: a second challenge, from any holder, is 409 ' +
          'IDENTITY_REQUEST_STATE (a backfill has no number step: `reason: NO_NUMBER_STEP`). The ' +
          `caller becomes \`challengerDeviceId\`; other holders show «approving on …». ${HOLDER_ONLY} ` +
          NOT_FOUND_NOTE,
        security: SECURITY,
        params: requestParams,
        body: nonceBody,
        response: {
          200: { description: 'The request, CHALLENGED.', ...identityRequestSchema },
          ...errorResponses(404),
          409: conflict,
        },
      },
    },
    async (request) =>
      toIdentityRequestDto(
        await identityRequests.challenge(
          principalOf(request),
          request.params.id,
          fromBase64(request.body.nonce, PAIRING_NONCE_BYTES),
        ),
      ),
  );

  app.post<{ Params: { id: string }; Body: IdentityRequestNonceBody }>(
    `${BASE}/:id/reveal`,
    {
      onRequest: auth.requireActiveDevice,
      schema: {
        operationId: 'revealIdentityRequest',
        tags: [TAG],
        summary: 'N reveals its nonce r_N after the challenge',
        description:
          'Only the device that asked (403 DEVICE_MISMATCH), on a CHALLENGED request (409 ' +
          'IDENTITY_REQUEST_STATE otherwise). The relay checks that r_N opens the commitment ' +
          '(`verifyPairingCommitment` with the registered signature key and the stored transfer key): ' +
          '422 IDENTITY_REQUEST_SIGNATURE_INVALID otherwise, and the request stays CHALLENGED. The ' +
          `challenger checks it again. ${NOT_FOUND_NOTE}`,
        security: SECURITY,
        params: requestParams,
        body: nonceBody,
        response: {
          200: { description: 'The request, REVEALED.', ...identityRequestSchema },
          ...errorResponses(404, 422),
          409: conflict,
        },
      },
    },
    async (request) =>
      toIdentityRequestDto(
        await identityRequests.reveal(
          principalOf(request),
          request.params.id,
          fromBase64(request.body.nonce, PAIRING_NONCE_BYTES),
        ),
      ),
  );

  app.post<{ Params: { id: string }; Body: ApproveIdentityRequestBody }>(
    `${BASE}/:id/approve`,
    {
      onRequest: auth.requireActiveDevice,
      schema: {
        operationId: 'approveIdentityRequest',
        tags: [TAG],
        summary: 'The holder hands over the identity key, sealed to N',
        description:
          "`sealed` is the identity private key sealed with HPKE to the request's `transferKey`; " +
          "`listVersion` is the device-list version the seal's aad names. A `pair` request is " +
          'approved in state REVEALED by the holder that challenged it (409 IDENTITY_REQUEST_STATE, ' +
          '`reason: NOT_THE_CHALLENGER` with `challengerDeviceId`, for another holder); a `backfill` ' +
          'request in state OPEN by any holder. A revoked N is 422 DEVICE_REVOKED. The relay stores ' +
          `ciphertext only and serves it to N alone. ${HOLDER_ONLY} ${NOT_FOUND_NOTE}`,
        security: SECURITY,
        params: requestParams,
        body: {
          type: 'object',
          properties: { listVersion: versionSchema, sealed: sealedSchema },
          required: ['listVersion', 'sealed'],
          additionalProperties: false,
        },
        response: {
          200: { description: 'The request, APPROVED.', ...identityRequestSchema },
          ...errorResponses(404, 422),
          409: conflict,
        },
      },
    },
    async (request) => {
      const { body } = request;
      return toIdentityRequestDto(
        await identityRequests.approve(principalOf(request), request.params.id, {
          listVersion: body.listVersion,
          sealed: {
            enc: fromBase64(body.sealed.enc, SEALED_IDENTITY_ENC_BYTES),
            ciphertext: fromBase64(body.sealed.ciphertext, SEALED_IDENTITY_MAX_BYTES),
          },
        }),
      );
    },
  );

  app.post<{ Params: { id: string } }>(
    `${BASE}/:id/reject`,
    {
      onRequest: auth.requireActiveDevice,
      schema: {
        operationId: 'rejectIdentityRequest',
        tags: [TAG],
        summary: 'A holder rejects the request («Це не я», a wrong number)',
        description:
          'An OPEN, CHALLENGED or REVEALED request becomes REJECTED (409 IDENTITY_REQUEST_STATE ' +
          'otherwise), and the device that asked is revoked in the same transaction, unless it is ' +
          'still a member of a room (then only the request is rejected; Remove, then ' +
          `\`POST /devices/{id}/revoke\`). ${HOLDER_ONLY} ${NOT_FOUND_NOTE}`,
        security: SECURITY,
        params: requestParams,
        response: {
          200: { description: 'The request, REJECTED.', ...identityRequestSchema },
          ...errorResponses(404),
          409: conflict,
        },
      },
    },
    async (request) =>
      toIdentityRequestDto(await identityRequests.reject(principalOf(request), request.params.id)),
  );
}
