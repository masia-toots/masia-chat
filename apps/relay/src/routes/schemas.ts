import {
  base64Length,
  DEVICE_ROLES,
  HandshakeKind,
  ID_PATTERN,
  RELAY_ERROR_CODES,
  MAX_DEVICE_TEXT_LENGTH,
  PAGE_DEFAULT,
  PAGE_MAX,
  UUID_PATTERN,
} from '@masia/relay';

/**
 * The JSON-schema vocabulary shared by every route. A field that appears on more than one route
 * (an id, an epoch, a byte string, a page) is defined once here, so the rule for it cannot drift
 * between the endpoint that accepts it and the endpoint that returns it.
 *
 * Schemas do three jobs at once: they validate input (Fastify/ajv), they shape output (so a
 * handler cannot leak a column it forgot about) and they are the OpenAPI document.
 */

/** Largest value of a Postgres `integer` column: epochs and sequence numbers live in those. */
export const INT32_MAX = 2_147_483_647;

/**
 * Standard base64 with padding. Spelled out instead of `format: 'byte'` so the accepted alphabet
 * is visible here and does not depend on a validator plug-in's idea of "base64".
 */
export const BASE64_PATTERN = '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$';

export const BEARER_SECURITY_SCHEME = 'bearerAuth';
export const SECURITY = [{ [BEARER_SECURITY_SCHEME]: [] }];

export const idSchema = { type: 'string', pattern: ID_PATTERN } as const;

/** An id the relay mints itself (a key package): a canonical UUID, which Postgres can cast. */
export const uuidSchema = { type: 'string', pattern: UUID_PATTERN } as const;

export const epochSchema = { type: 'integer', minimum: 0, maximum: INT32_MAX } as const;
export const seqSchema = { type: 'integer', minimum: 1, maximum: INT32_MAX } as const;
export const versionSchema = { type: 'integer', minimum: 1, maximum: INT32_MAX } as const;

export const timestampSchema = { type: 'string', format: 'date-time' } as const;
export const nullableTimestampSchema = {
  type: 'string',
  format: 'date-time',
  nullable: true,
} as const;

export const roleSchema = { type: 'string', enum: DEVICE_ROLES } as const;

export const handshakeKindSchema = { type: 'string', enum: Object.values(HandshakeKind) } as const;

export const labelSchema = {
  type: 'string',
  minLength: 1,
  maxLength: MAX_DEVICE_TEXT_LENGTH,
  nullable: true,
} as const;

/** Opaque bytes on the wire: base64 text, at most `maxBytes` once decoded. */
export function bytesSchema(maxBytes: number, description: string) {
  return {
    type: 'string',
    minLength: 4,
    maxLength: base64Length(maxBytes),
    pattern: BASE64_PATTERN,
    description: `${description} (base64, at most ${maxBytes} bytes decoded)`,
  } as const;
}

/** Path parameters that are all ids. */
export function idParams(...names: readonly string[]) {
  return {
    type: 'object',
    properties: Object.fromEntries(names.map((name) => [name, idSchema])),
    required: names,
    additionalProperties: false,
  } as const;
}

/** The two query parameters of every paged listing; routes add their own (e.g. `fromEpoch`). */
export const pageQueryProperties = {
  afterSeq: { type: 'integer', minimum: 0, maximum: INT32_MAX, default: 0 },
  limit: { type: 'integer', minimum: 1, maximum: PAGE_MAX, default: PAGE_DEFAULT },
} as const;

const nextCursorSchema = {
  type: 'string',
  nullable: true,
  description: 'Pass as `afterSeq` to read the next page; null when there is none.',
} as const;

/** The envelope of every collection response: `{ rows, nextCursor }`. */
export function collectionSchema(item: object) {
  return {
    type: 'object',
    properties: {
      rows: { type: 'array', items: item },
      nextCursor: nextCursorSchema,
    },
    required: ['rows', 'nextCursor'],
  } as const;
}

/** A page of a conversation's log: the collection plus `oldestAvailableSeq` and `removedAtEpoch`. */
export function sequencedCollectionSchema(item: object) {
  return {
    type: 'object',
    properties: {
      rows: { type: 'array', items: item },
      nextCursor: nextCursorSchema,
      oldestAvailableSeq: {
        ...seqSchema,
        description:
          'The lowest seq the relay still holds (older rows were deleted by retention), or the next ' +
          'seq it will hand out when it holds none. A cursor below `oldestAvailableSeq - 1` has ' +
          'missed rows that no longer exist: recover from the group state, not by paging.',
      },
      removedAtEpoch: {
        ...epochSchema,
        nullable: true,
        description:
          'Set for a device a commit removed: its reading ends before this epoch (it still sees ' +
          'the commit that removed it). Once nothing is left in that window the answer is 403 REMOVED.',
      },
    },
    required: ['rows', 'nextCursor', 'oldestAvailableSeq', 'removedAtEpoch'],
  } as const;
}

// --- Errors ------------------------------------------------------------------------------------

const ERROR_DESCRIPTIONS: Readonly<Record<number, string>> = {
  400: 'The request is malformed (VALIDATION_FAILED).',
  401: 'No valid bearer token (UNAUTHENTICATED).',
  403: 'The caller may not do this (see the `error` code).',
  404: 'No such resource (see the `error` code).',
  409: 'The request conflicts with current state (see the `error` code and its facts).',
  422: 'The request is well-formed but breaks a rule (see the `error` code).',
  413: 'The body is larger than the relay takes (PAYLOAD_TOO_LARGE).',
  415: 'The body is not JSON (UNSUPPORTED_MEDIA_TYPE).',
  429: 'Too many requests (see the `error` code; `Retry-After` when it applies).',
  503: 'The room stayed locked by other writers (ROOM_BUSY); send the same request again after `Retry-After`.',
};

/**
 * Every error body. Extra facts (`currentEpoch`, `currentVersion`, …) travel beside `error` and
 * `message`, hence `additionalProperties: true`: without it the serializer would drop them.
 */
const errorBodySchema = {
  type: 'object',
  properties: {
    error: {
      type: 'string',
      enum: RELAY_ERROR_CODES,
      description: 'Stable machine code; branch on this, not on `message`.',
    },
    message: { type: 'string' },
  },
  required: ['error', 'message'],
  additionalProperties: true,
} as const;

/**
 * The response schema of one error status. `facts` names the extra fields one of its codes carries
 * beside `error` and `message` (declared, so the OpenAPI document shows them; the body would carry
 * them without, `additionalProperties` being true), and `note` says which code carries what.
 */
export function errorResponse(
  status: number,
  facts: Readonly<Record<string, object>> = {},
  note = '',
) {
  const base = ERROR_DESCRIPTIONS[status] ?? 'Error.';
  return {
    description: note === '' ? base : `${base} ${note}`,
    ...errorBodySchema,
    properties: { ...errorBodySchema.properties, ...facts },
  };
}

/**
 * Response schemas for the error statuses a route can answer. 400, 401 and 403 are on every
 * authenticated route (validation, token, revoked device), and 503 on every route that touches the
 * database (a lock or statement timeout), so they are always included.
 */
export function errorResponses(...extraStatuses: readonly number[]) {
  const statuses = [400, 401, 403, ...extraStatuses, 503];
  return Object.fromEntries(statuses.map((status) => [status, errorResponse(status)]));
}
