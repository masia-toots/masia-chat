import {
  type DeviceRole,
  CLIENT_HANDSHAKE_KIND,
  MAX_ENVELOPE_BYTES,
  MAX_GROUP_ID_BYTES,
  MAX_HANDSHAKE_BYTES,
  MAX_MEMBER_DELTA_ENTRIES,
  MAX_REBASES,
  MAX_TREE_HASH_BYTES,
  RelayError,
  RelayErrorCode,
} from '@masia/relay';
import type { FastifyInstance } from 'fastify';
import { assertActingAs, principalOf } from '../auth.js';
import { type DeclaredMemberDelta, EMPTY_DECLARED_MEMBER_DELTA } from '../domain/member-delta.js';
import {
  assertWindowNotExhausted,
  envelopeWindow,
  handshakeWindow,
  listEnvelopes,
  listHandshakes,
  requireReader,
} from '../domain/rooms.js';
import { fromBase64, pageCollection, toEnvelopeDto, toHandshakeDto } from '../dto.js';
import type { RouteDeps } from './route-deps.js';
import {
  bytesSchema,
  epochSchema,
  errorResponses,
  handshakeKindSchema,
  idParams,
  idSchema,
  INT32_MAX,
  pageQueryProperties,
  roleSchema,
  SECURITY,
  seqSchema,
  sequencedCollectionSchema,
  timestampSchema,
  uuidSchema,
} from './schemas.js';

const TAG = 'conversations';

/** A write that repeats one already stored answers 200 with the original receipt; a new one 201. */
const REPLAYED = 200;
const CREATED = 201;
const statusOf = (receipt: { readonly replayed: boolean }): number =>
  receipt.replayed ? REPLAYED : CREATED;

/**
 * `kind` is accepted as any short string so that a kind the relay does not take (a standalone
 * PROPOSAL from an older client) gets its own clear 422 instead of a generic schema 400.
 */
const MAX_KIND_LENGTH = 32;

const commitBytesSchema = bytesSchema(MAX_HANDSHAKE_BYTES, 'An MLS handshake message');
const treeHashSchema = bytesSchema(MAX_TREE_HASH_BYTES, 'The ratchet-tree hash after the commit');

/**
 * One declared Add. `keyPackageId` is the package the committer's device claimed for the added
 * device (`POST /key-packages/claim`); the relay refuses an Add whose package it cannot match to
 * that claim (422 KEY_PACKAGE_NOT_CLAIMED_BY_COMMITTER).
 */
const declaredAddSchema = {
  type: 'object',
  properties: {
    deviceId: idSchema,
    userId: idSchema,
    role: roleSchema,
    keyPackageId: uuidSchema,
  },
  required: ['deviceId', 'userId', 'role', 'keyPackageId'],
  additionalProperties: false,
} as const;

/** THE member-delta schema: what a commit declares, as posted and as served back. */
const declaredMemberDeltaSchema = {
  type: 'object',
  properties: {
    added: { type: 'array', maxItems: MAX_MEMBER_DELTA_ENTRIES, items: declaredAddSchema },
    removed: { type: 'array', maxItems: MAX_MEMBER_DELTA_ENTRIES, items: idSchema },
  },
  required: ['added', 'removed'],
  additionalProperties: false,
} as const;

const handshakeResponseSchema = {
  type: 'object',
  properties: {
    seq: seqSchema,
    epoch: epochSchema,
    kind: handshakeKindSchema,
    senderDeviceId: idSchema,
    bytes: commitBytesSchema,
    memberDelta: {
      ...declaredMemberDeltaSchema,
      nullable: true,
      description:
        'What the sender DECLARED the commit adds and removes, exactly as posted; null on a ' +
        'WELCOME. The relay cannot read the commit: every member must compare this with the ' +
        'changes the decrypted commit really makes, and treat a difference as an attack.',
    },
    createdAt: timestampSchema,
  },
  required: ['seq', 'epoch', 'kind', 'senderDeviceId', 'bytes', 'memberDelta', 'createdAt'],
} as const;

const envelopeResponseSchema = {
  type: 'object',
  properties: {
    seq: seqSchema,
    epoch: epochSchema,
    senderDeviceId: idSchema,
    ciphertext: bytesSchema(MAX_ENVELOPE_BYTES, 'An MLS application message'),
    createdAt: timestampSchema,
  },
  required: ['seq', 'epoch', 'senderDeviceId', 'ciphertext', 'createdAt'],
} as const;

const createGroupReceiptSchema = {
  type: 'object',
  properties: { epoch: epochSchema },
  required: ['epoch'],
} as const;

const handshakeReceiptSchema = {
  type: 'object',
  properties: { epoch: epochSchema, seq: seqSchema },
  required: ['epoch', 'seq'],
} as const;

const envelopeReceiptSchema = {
  type: 'object',
  properties: { seq: seqSchema },
  required: ['seq'],
} as const;

interface CreateGroupBody {
  groupId: string;
  treeHash: string;
}

interface PostHandshakeBody {
  /** Defaulted to COMMIT by the schema (`useDefaults`). */
  kind: string;
  expectedEpoch: number;
  senderDeviceId: string;
  bytes: string;
  memberDelta?: {
    added: Array<{ deviceId: string; userId: string; role: DeviceRole; keyPackageId: string }>;
    removed: string[];
  };
  /** Required; checked in the handler, after `kind`, so a proposal gets its own clear refusal. */
  newTreeHash?: string;
  welcome?: string;
}

interface PostEnvelopeBody {
  epoch: number;
  ciphertext: string;
  senderDeviceId: string;
  clientMsgId?: string;
}

/**
 * The relay takes commits only. A standalone PROPOSAL is something no member accepts (the engine
 * commits proposals inline and refuses one on its own), so storing it would only stall the room.
 */
function assertCommitKind(kind: string): void {
  if (kind !== CLIENT_HANDSHAKE_KIND) {
    throw new RelayError(
      RelayErrorCode.HANDSHAKE_KIND_UNSUPPORTED,
      `The relay takes only ${CLIENT_HANDSHAKE_KIND} handshakes; propose inside a commit.`,
      { kind },
    );
  }
}

function assertDeltaSize(delta: DeclaredMemberDelta): void {
  if (delta.added.length + delta.removed.length > MAX_MEMBER_DELTA_ENTRIES) {
    throw new RelayError(
      RelayErrorCode.VALIDATION_FAILED,
      `A commit may add and remove at most ${MAX_MEMBER_DELTA_ENTRIES} devices in total.`,
    );
  }
}

export function registerConversationRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { db, auth, serializer } = deps;

  app.post<{ Params: { id: string }; Body: CreateGroupBody }>(
    '/conversations/:id/e2ee',
    {
      onRequest: auth.requireActiveDevice,
      schema: {
        operationId: 'createConversationGroup',
        tags: [TAG],
        summary: 'Open the end-to-end group of a conversation at epoch 0',
        description:
          "The calling device becomes the first member (it must be on its owner's signed device " +
          "list). Whether this user may open this conversation is the host API's decision, made " +
          'before it issues the token. Safe to retry: the same device opening the same group of ' +
          'the same conversation again gets 200 and the original answer; anyone else gets 409 ' +
          'CONVERSATION_EXISTS.',
        security: SECURITY,
        params: idParams('id'),
        body: {
          type: 'object',
          properties: {
            groupId: bytesSchema(MAX_GROUP_ID_BYTES, 'The MLS group id'),
            treeHash: treeHashSchema,
          },
          required: ['groupId', 'treeHash'],
          additionalProperties: false,
        },
        response: {
          [REPLAYED]: {
            description: 'A retry: the group was already opened by this device.',
            ...createGroupReceiptSchema,
          },
          [CREATED]: { description: 'The group exists.', ...createGroupReceiptSchema },
          ...errorResponses(409, 422),
        },
      },
    },
    async (request, reply) => {
      const receipt = await serializer.createGroup({
        conversationId: request.params.id,
        groupId: fromBase64(request.body.groupId, MAX_GROUP_ID_BYTES),
        treeHash: fromBase64(request.body.treeHash, MAX_TREE_HASH_BYTES),
        creatorDeviceId: principalOf(request).deviceId,
      });
      return reply.code(statusOf(receipt)).send({ epoch: receipt.epoch });
    },
  );

  app.post<{ Params: { id: string }; Body: PostHandshakeBody }>(
    '/conversations/:id/handshakes',
    {
      onRequest: auth.requireActiveDevice,
      schema: {
        operationId: 'postHandshake',
        tags: [TAG],
        summary: 'Append a commit to the conversation, in epoch order',
        description:
          'The epoch serializer (ADR-117 §2). A commit must be built on the current epoch: ' +
          '`expectedEpoch` ≠ current → 409 `{currentEpoch}`; rebase on what won and resend. After ' +
          `${MAX_REBASES} consecutive losses the answer is 429 REBASE_LIMIT. Safe to retry: the ` +
          'same device resending the same bytes for the same `expectedEpoch` after it was stored ' +
          'gets 200 and the original receipt. `kind` other than COMMIT (a standalone proposal) is ' +
          '422 HANDSHAKE_KIND_UNSUPPORTED: propose inside a commit. `bytes` must be an MLSMessage ' +
          "(a PublicMessage from a member, or a PrivateMessage) for this room's group and current " +
          'epoch with content type commit, else 422 MLS_HEADER_MISMATCH naming the field; a ' +
          '`welcome` must parse as a Welcome. The relay reads only that cleartext header, never ' +
          'the content. `memberDelta` says who the commit adds and removes, and is stored and ' +
          'returned by GET: removing a GUARDIAN device needs a FAMILY_ADMIN token whose `adminOf` ' +
          'lists the child, or another GUARDIAN device of the same child driven by a token whose ' +
          '`guardianOf` lists the child (403), adding a device that is revoked (422 ' +
          "DEVICE_REVOKED) or not on its owner's signed list (422 DEVICE_NOT_IN_SIGNED_LIST) is " +
          'refused, and each added device must name the `keyPackageId` that THIS device claimed ' +
          'for it (422 KEY_PACKAGE_NOT_CLAIMED_BY_COMMITTER). A device a commit removed gets 403 ' +
          'REMOVED. There is no groupInfo: external joins are out of scope, and an unknown field ' +
          "is a 400. `senderDeviceId` must be the token's device.",
        security: SECURITY,
        params: idParams('id'),
        body: {
          type: 'object',
          properties: {
            kind: { type: 'string', maxLength: MAX_KIND_LENGTH, default: CLIENT_HANDSHAKE_KIND },
            expectedEpoch: epochSchema,
            senderDeviceId: idSchema,
            bytes: commitBytesSchema,
            memberDelta: {
              ...declaredMemberDeltaSchema,
              description: 'Omitted means "no one added, no one removed".',
            },
            newTreeHash: treeHashSchema,
            welcome: bytesSchema(
              MAX_HANDSHAKE_BYTES,
              'The Welcome for the devices this commit adds',
            ),
          },
          required: ['expectedEpoch', 'senderDeviceId', 'bytes'],
          additionalProperties: false,
        },
        response: {
          [REPLAYED]: {
            description: 'A retry of a commit this device already stored: the original receipt.',
            ...handshakeReceiptSchema,
          },
          [CREATED]: {
            description:
              "Accepted. `epoch` is the group's epoch afterwards; `seq` the position in the log.",
            ...handshakeReceiptSchema,
          },
          ...errorResponses(409, 422, 429),
        },
      },
    },
    async (request, reply) => {
      const principal = principalOf(request);
      const { body } = request;
      assertActingAs(principal, body.senderDeviceId);
      assertCommitKind(body.kind);
      if (body.newTreeHash === undefined) {
        throw new RelayError(RelayErrorCode.VALIDATION_FAILED, 'A commit must carry newTreeHash.');
      }
      const memberDelta = body.memberDelta ?? EMPTY_DECLARED_MEMBER_DELTA;
      assertDeltaSize(memberDelta);

      const receipt = await serializer.commitHandshake({
        conversationId: request.params.id,
        senderDeviceId: principal.deviceId,
        // The claims and the users they cover come from the token and nowhere else: a body cannot
        // ask to be an admin, or an admin of someone else.
        admin: {
          actor: principal.actor,
          adminOf: principal.adminOf,
          guardianOf: principal.guardianOf,
        },
        expectedEpoch: body.expectedEpoch,
        bytes: fromBase64(body.bytes, MAX_HANDSHAKE_BYTES),
        memberDelta,
        newTreeHash: fromBase64(body.newTreeHash, MAX_TREE_HASH_BYTES),
        welcome:
          body.welcome === undefined ? undefined : fromBase64(body.welcome, MAX_HANDSHAKE_BYTES),
      });
      return reply.code(statusOf(receipt)).send({ epoch: receipt.epoch, seq: receipt.seq });
    },
  );

  app.get<{
    Params: { id: string };
    Querystring: { fromEpoch: number; afterSeq: number; limit: number };
  }>(
    '/conversations/:id/handshakes',
    {
      onRequest: auth.requireActiveDevice,
      schema: {
        operationId: 'listHandshakes',
        tags: [TAG],
        summary: "Read the conversation's handshake log, in order",
        description:
          'Members, and devices a commit removed. Returns messages built on epoch `fromEpoch` or ' +
          'later, after `afterSeq`. A device never sees handshakes older than the one that added ' +
          'it (or the epoch before it, which holds its own Welcome). A removed device reads up to ' +
          'and including the commit that removed it, with `removedAtEpoch` set, and then gets 403 ' +
          'REMOVED. Each commit carries the `memberDelta` its sender declared; compare it with ' +
          'what the decrypted commit really does. `oldestAvailableSeq` says where retention cut ' +
          'the log.',
        security: SECURITY,
        params: idParams('id'),
        querystring: {
          type: 'object',
          properties: {
            fromEpoch: { type: 'integer', minimum: 0, maximum: INT32_MAX, default: 0 },
            ...pageQueryProperties,
          },
          additionalProperties: false,
        },
        response: {
          200: {
            description: 'A page of handshakes.',
            ...sequencedCollectionSchema(handshakeResponseSchema),
          },
          ...errorResponses(),
        },
      },
    },
    async (request) => {
      const membership = await requireReader(db, request.params.id, principalOf(request).deviceId);
      const window = handshakeWindow(membership);
      const page = await listHandshakes(db, {
        conversationId: request.params.id,
        window: { ...window, fromEpoch: Math.max(request.query.fromEpoch, window.fromEpoch) },
        afterSeq: request.query.afterSeq,
        limit: request.query.limit,
      });
      assertWindowNotExhausted(page, window);
      return pageCollection(page, window, toHandshakeDto);
    },
  );

  app.post<{ Params: { id: string }; Body: PostEnvelopeBody }>(
    '/conversations/:id/envelopes',
    {
      onRequest: auth.requireActiveDevice,
      schema: {
        operationId: 'postEnvelope',
        tags: [TAG],
        summary: 'Append an encrypted message to the conversation',
        description:
          'The relay stores `ciphertext` as given and cannot read it. The sender must be a current ' +
          'member (403 NOT_A_MEMBER, or REMOVED for a device a commit removed) and `epoch` must be ' +
          "the group's current epoch, else 409 `{currentEpoch}`: the message was encrypted for a " +
          'group that no longer exists. The ciphertext must be an MLS PrivateMessage of this ' +
          "room's group and that epoch with content type application, else 422 " +
          'MLS_HEADER_MISMATCH naming the field (the relay reads only that cleartext header). ' +
          'Safe to retry with `clientMsgId`: the same device sending the same id again gets 200 ' +
          'and the original seq (409 CLIENT_MSG_ID_REUSED if the ciphertext differs).',
        security: SECURITY,
        params: idParams('id'),
        body: {
          type: 'object',
          properties: {
            epoch: epochSchema,
            ciphertext: bytesSchema(MAX_ENVELOPE_BYTES, 'An MLS application message'),
            senderDeviceId: idSchema,
            clientMsgId: {
              ...idSchema,
              description: "The sender's own id for this message, unique per sending device.",
            },
          },
          required: ['epoch', 'ciphertext', 'senderDeviceId'],
          additionalProperties: false,
        },
        response: {
          [REPLAYED]: {
            description: 'A retry (same `clientMsgId`, same ciphertext): the original seq.',
            ...envelopeReceiptSchema,
          },
          [CREATED]: { description: 'Stored.', ...envelopeReceiptSchema },
          ...errorResponses(409, 422),
        },
      },
    },
    async (request, reply) => {
      const principal = principalOf(request);
      assertActingAs(principal, request.body.senderDeviceId);
      const receipt = await serializer.appendEnvelope({
        conversationId: request.params.id,
        senderDeviceId: principal.deviceId,
        epoch: request.body.epoch,
        ciphertext: fromBase64(request.body.ciphertext, MAX_ENVELOPE_BYTES),
        clientMsgId: request.body.clientMsgId,
      });
      return reply.code(statusOf(receipt)).send({ seq: receipt.seq });
    },
  );

  app.get<{ Params: { id: string }; Querystring: { afterSeq: number; limit: number } }>(
    '/conversations/:id/envelopes',
    {
      onRequest: auth.requireActiveDevice,
      schema: {
        operationId: 'listEnvelopes',
        tags: [TAG],
        summary: "Read the conversation's encrypted messages, in order",
        description:
          'Members, and devices a commit removed (403 NOT_A_MEMBER for anyone else). Starts at the ' +
          'epoch the reading device joined in: older messages were never encrypted for it. A ' +
          'removed device reads the messages of the epochs it was a member of, with ' +
          '`removedAtEpoch` set, and then gets 403 REMOVED. `oldestAvailableSeq` says where ' +
          'retention cut the log.',
        security: SECURITY,
        params: idParams('id'),
        querystring: {
          type: 'object',
          properties: pageQueryProperties,
          additionalProperties: false,
        },
        response: {
          200: {
            description: 'A page of envelopes.',
            ...sequencedCollectionSchema(envelopeResponseSchema),
          },
          ...errorResponses(),
        },
      },
    },
    async (request) => {
      const membership = await requireReader(db, request.params.id, principalOf(request).deviceId);
      const window = envelopeWindow(membership);
      const page = await listEnvelopes(db, {
        conversationId: request.params.id,
        window,
        afterSeq: request.query.afterSeq,
        limit: request.query.limit,
      });
      assertWindowNotExhausted(page, window);
      return pageCollection(page, window, toEnvelopeDto);
    },
  );
}
