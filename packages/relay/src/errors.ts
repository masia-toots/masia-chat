import { RelayErrorCode } from '@masia/contracts/wire';

/**
 * Every way the relay refuses a request, as ONE table: the stable machine code (`RelayErrorCode`, the
 * wire vocabulary in `@masia/contracts/wire`, which clients branch on) and the HTTP status it travels
 * under (here: the status is the relay's). Callers throw a `RelayError`; the HTTP layer reads the
 * status from here. Having the status in one place is what stops "409 here, 422 there" drift.
 */
/** Every code, for the `error` enum of the published error schema. */
export const RELAY_ERROR_CODES = Object.values(RelayErrorCode);

export const RELAY_ERROR_STATUS: Readonly<Record<RelayErrorCode, number>> = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  ACTOR_DEVICE_UNKNOWN: 403,
  ACTOR_DEVICE_REVOKED: 403,
  NOT_A_MEMBER: 403,
  REMOVED: 403,
  DEVICE_MISMATCH: 403,
  GUARDIAN_REMOVE_FORBIDDEN: 403,
  ROLE_FORBIDDEN: 403,
  REVOKE_FORBIDDEN: 403,
  DEVICE_OWNED_BY_OTHER: 403,
  NOT_A_CONTACT: 403,
  DEVICE_LIST_NOT_FOUND: 404,
  NOT_FOUND: 404,
  EPOCH_CONFLICT: 409,
  DEVICE_LIST_VERSION_CONFLICT: 409,
  STILL_IN_ROOMS: 409,
  CONVERSATION_EXISTS: 409,
  DEVICE_IDENTITY_IMMUTABLE: 409,
  CLIENT_MSG_ID_REUSED: 409,
  KEY_PACKAGE_POOL_FULL: 409,
  IDENTITY_KEY_CHANGED: 409,
  IDENTITY_KEY_IN_USE: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  DEVICE_NOT_IN_SIGNED_LIST: 422,
  DEVICE_REVOKED: 422,
  LAST_RESORT_REQUIRED: 422,
  ALREADY_MEMBER: 422,
  REMOVE_TARGET_NOT_MEMBER: 422,
  INVALID_MEMBER_DELTA: 422,
  MLS_HEADER_MISMATCH: 422,
  KEY_PACKAGE_NOT_CLAIMED_BY_COMMITTER: 422,
  HANDSHAKE_KIND_UNSUPPORTED: 422,
  KEY_PACKAGE_UNREADABLE: 422,
  KEY_PACKAGE_EXPIRED: 422,
  DEVICE_LIST_ENTRY_INVALID: 422,
  DEVICE_LIST_SIGNATURE_INVALID: 422,
  REBASE_LIMIT: 429,
  CLAIM_RATE_LIMITED: 429,
  UPLOAD_RATE_LIMITED: 429,
  ACTOR_RATE_LIMITED: 429,
  TARGET_RATE_LIMITED: 429,
  INTERNAL: 500,
  ROOM_BUSY: 503,
};

/**
 * The code a request refused by the HTTP framework itself (bad JSON, a body over the limit, a
 * wrong content type, an unknown route) travels under, keyed by the framework's status. Any other
 * 4xx from the framework is a `VALIDATION_FAILED`. Every code here has exactly that status in
 * `RELAY_ERROR_STATUS`, which a test pins.
 */
export const FRAMEWORK_ERROR_CODE_BY_STATUS: Readonly<Record<number, RelayErrorCode>> = {
  400: RelayErrorCode.VALIDATION_FAILED,
  401: RelayErrorCode.UNAUTHENTICATED,
  404: RelayErrorCode.NOT_FOUND,
  413: RelayErrorCode.PAYLOAD_TOO_LARGE,
  415: RelayErrorCode.UNSUPPORTED_MEDIA_TYPE,
};

/** The code for a framework refusal with HTTP status `status` (a 4xx). */
export function frameworkErrorCode(status: number): RelayErrorCode {
  return FRAMEWORK_ERROR_CODE_BY_STATUS[status] ?? RelayErrorCode.VALIDATION_FAILED;
}

/** The JSON body of every error response: a stable `error` code, a human `message`, extra facts. */
export interface RelayErrorBody {
  readonly error: RelayErrorCode;
  readonly message: string;
  readonly [detail: string]: unknown;
}

/**
 * A refusal the caller can act on. `details` are the machine-readable facts a client needs to
 * recover (the current epoch, the current list version); they are merged into the response body.
 * Never put a secret or a key in `details` or `message`.
 */
export class RelayError extends Error {
  readonly code: RelayErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: RelayErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'RelayError';
    this.code = code;
    this.details = details;
  }

  get statusCode(): number {
    return RELAY_ERROR_STATUS[this.code];
  }

  toBody(): RelayErrorBody {
    return { ...this.details, error: this.code, message: this.message };
  }
}

/** The sender built its commit on an epoch the group has already left. It must rebase and resend. */
export class EpochConflictError extends RelayError {
  readonly currentEpoch: number;

  constructor(currentEpoch: number) {
    super(
      RelayErrorCode.EPOCH_CONFLICT,
      'The group has moved past the epoch this message was built on; rebase and resend.',
      { currentEpoch },
    );
    this.name = 'EpochConflictError';
    this.currentEpoch = currentEpoch;
  }
}

const MS_PER_SECOND = 1000;

/** Whole seconds until `resetsAt` (epoch ms), at least 1: the value of a `Retry-After` header. */
export function retryAfterSeconds(resetsAt: number, now: number): number {
  return Math.max(1, Math.ceil((resetsAt - now) / MS_PER_SECOND));
}

/** The detail an HTTP layer turns into a `Retry-After` header. */
export const RETRY_AFTER_DETAIL = 'retryAfterSeconds';

/** A 429: the caller spent a budget. `retryAfterSeconds` is in the body and in `Retry-After`. */
export class RateLimitedError extends RelayError {
  readonly retryAfterSeconds: number;

  constructor(
    code:
      | typeof RelayErrorCode.CLAIM_RATE_LIMITED
      | typeof RelayErrorCode.UPLOAD_RATE_LIMITED
      | typeof RelayErrorCode.ACTOR_RATE_LIMITED
      | typeof RelayErrorCode.TARGET_RATE_LIMITED,
    message: string,
    retryAfter: number,
  ) {
    super(code, message, { [RETRY_AFTER_DETAIL]: retryAfter });
    this.name = 'RateLimitedError';
    this.retryAfterSeconds = retryAfter;
  }
}

/**
 * A 503: the room stayed locked by other writers for longer than the relay waits for a lock. The
 * request changed nothing and may be sent again as it is.
 */
export class RoomBusyError extends RelayError {
  readonly retryAfterSeconds: number;

  constructor(retryAfter: number) {
    super(RelayErrorCode.ROOM_BUSY, 'The room is busy; send the same request again shortly.', {
      [RETRY_AFTER_DETAIL]: retryAfter,
    });
    this.name = 'RoomBusyError';
    this.retryAfterSeconds = retryAfter;
  }
}
