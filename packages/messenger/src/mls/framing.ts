import {
  KEY_PACKAGE_PRIVATE_FORMAT_VERSION,
  MAX_AAD_EXTRA_BYTES,
  MAX_GROUP_LEAVES,
  MAX_ID_BYTES,
  MAX_KEY_PACKAGE_BYTES,
  MAX_KEY_PACKAGE_PRIVATE_BYTES,
  MAX_PRIVATE_KEY_BYTES,
  MAX_STATE_BYTES,
  PENDING_COMMIT_FORMAT_VERSION,
  STATE_FORMAT_VERSION,
} from './constants.js';
import { decodeId, encodeId } from './credential.js';
import { fail, MlsEngineErrorCode } from './mls-error.js';

/**
 * The few byte layouts the engine owns itself: the authenticated-data framing of application
 * messages, the stored form of a KeyPackage's secrets, the envelope around a serialized group
 * state, and the stored form of a commit we posted but have not seen acknowledged. Plain
 * length-prefixed fields read through one bounds-checked reader, so a hostile or truncated buffer
 * can only ever produce `MlsEngineError`.
 *
 * Every stored layout starts with a format version byte. A version this build does not read is
 * `STATE_VERSION_UNSUPPORTED` (the bytes are probably fine for another build: keep them), never
 * `STATE_CORRUPT` (the bytes are damaged).
 */

const U8_MAX = 0xff;
const U16_BYTES = 2;
const U16_MAX = 0xffff;
const U64_BYTES = 8;
/** The longest hash any MLS cipher suite uses (SHA-512); a stored commit hash is never longer. */
const MAX_DIGEST_BYTES = 64;

/**
 * Writes the layouts above. Every method range-checks its input and throws `INVALID_STATE` rather
 * than silently truncating: a value that does not fit is a bug in the engine, and a truncated
 * field would be read back as something else.
 */
class ByteWriter {
  private readonly parts: Uint8Array[] = [];

  u8(value: number): this {
    if (!Number.isInteger(value) || value < 0 || value > U8_MAX) {
      throw fail(MlsEngineErrorCode.INVALID_STATE, 'A field does not fit 8 bits.');
    }
    this.parts.push(Uint8Array.of(value));
    return this;
  }

  u16(value: number): this {
    if (!Number.isInteger(value) || value < 0 || value > U16_MAX) {
      throw fail(MlsEngineErrorCode.INVALID_STATE, 'A field does not fit 16 bits.');
    }
    const bytes = new Uint8Array(U16_BYTES);
    new DataView(bytes.buffer).setUint16(0, value);
    this.parts.push(bytes);
    return this;
  }

  /** A non-negative safe integer as 8 big-endian bytes (versions and timestamps stay far below 2^53). */
  u64(value: number): this {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw fail(MlsEngineErrorCode.INVALID_STATE, 'A number in the state is not a safe integer.');
    }
    const bytes = new Uint8Array(U64_BYTES);
    new DataView(bytes.buffer).setBigUint64(0, BigInt(value));
    this.parts.push(bytes);
    return this;
  }

  /** `u16 length | bytes`; a vector over 65,535 bytes is refused by `u16`. */
  u16Vector(bytes: Uint8Array): this {
    return this.u16(bytes.length).raw(bytes);
  }

  /** `u8 length | ascii id`. An invalid id is `INVALID_ARGUMENT` (`encodeId`). */
  id(id: string): this {
    const bytes = encodeId(id);
    return this.u8(bytes.length).raw(bytes);
  }

  raw(bytes: Uint8Array): this {
    this.parts.push(bytes);
    return this;
  }

  finish(): Uint8Array {
    const total = this.parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of this.parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }
}

class ByteReader {
  private offset = 0;

  constructor(
    private readonly bytes: Uint8Array,
    private readonly corrupt: (what: string) => Error,
  ) {}

  private take(count: number, what: string): Uint8Array {
    if (count > this.bytes.length - this.offset) throw this.corrupt(`${what} is truncated`);
    const out = this.bytes.subarray(this.offset, this.offset + count);
    this.offset += count;
    return out;
  }

  u8(what: string): number {
    return this.take(1, what)[0] ?? 0;
  }

  u16(what: string): number {
    const head = this.take(U16_BYTES, what);
    return new DataView(head.buffer, head.byteOffset, head.byteLength).getUint16(0);
  }

  /** Eight big-endian bytes as a number; a value past 2^53 is corrupt, never silently rounded. */
  u64(what: string): number {
    const head = this.take(U64_BYTES, what);
    const value = new DataView(head.buffer, head.byteOffset, head.byteLength).getBigUint64(0);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw this.corrupt(`${what} is out of range`);
    return Number(value);
  }

  u16Vector(what: string, maxBytes: number): Uint8Array {
    const length = this.u16(what);
    if (length > maxBytes) throw this.corrupt(`${what} is too long`);
    return Uint8Array.from(this.take(length, what));
  }

  /** `u8 length | ascii id`, the counterpart of `ByteWriter.id`. */
  id(what: string): string {
    const length = this.u8(`${what} length`);
    if (length === 0 || length > MAX_ID_BYTES) throw this.corrupt(`bad ${what} length`);
    const id = decodeId(this.take(length, what));
    if (id === undefined) throw this.corrupt(`${what} is not a valid id`);
    return id;
  }

  /** Everything not yet read. */
  rest(): Uint8Array {
    return Uint8Array.from(this.bytes.subarray(this.offset));
  }
}

/** Reads the version byte of a stored layout: another version is unsupported, not corrupt. */
function expectVersion(reader: ByteReader, expected: number, layout: string): void {
  const version = reader.u8('version');
  if (version !== expected) {
    throw fail(
      MlsEngineErrorCode.STATE_VERSION_UNSUPPORTED,
      `${layout} is format version ${version}; this build reads version ${expected}. Keep the bytes.`,
    );
  }
}

// --- Authenticated data of application messages (security review §4 "AAD") ---------------------------

/** The caller's extra AAD is a few bytes of counter, never content: `MAX_AAD_EXTRA_BYTES`. */
export function assertExtraAadSize(extra: Uint8Array): void {
  if (extra.length > MAX_AAD_EXTRA_BYTES) {
    throw fail(
      MlsEngineErrorCode.DECODE_TOO_LARGE,
      `The additional authenticated data is over ${MAX_AAD_EXTRA_BYTES} bytes.`,
    );
  }
}

/**
 * `u8 len(conversationId) | conversationId | extra`. The conversation id is ALWAYS inside the
 * authenticated data of an application message, so a ciphertext lifted from one conversation and
 * replayed into another fails to open even if the relay re-keyed the mapping (the id in the
 * GroupContext is the second line of defence). `extra` is the hook for a per-sender counter.
 */
export function frameAad(conversationId: string, extra: Uint8Array = new Uint8Array()): Uint8Array {
  assertExtraAadSize(extra);
  return new ByteWriter().id(conversationId).raw(extra).finish();
}

/** Strips the framing and returns `extra`; `AAD_MISMATCH` when it does not start with this conversation's id. */
export function unframeAad(conversationId: string, authenticatedData: Uint8Array): Uint8Array {
  const id = encodeId(conversationId);
  const mismatch = fail(
    MlsEngineErrorCode.AAD_MISMATCH,
    'The message is not bound to this conversation.',
  );
  if (authenticatedData.length < 1 + id.length || (authenticatedData[0] ?? -1) !== id.length)
    throw mismatch;
  for (let i = 0; i < id.length; i += 1) {
    if (authenticatedData[1 + i] !== id[i]) throw mismatch;
  }
  return Uint8Array.from(authenticatedData.subarray(1 + id.length));
}

// --- KeyPackage secrets (what a device keeps until the Welcome arrives) -------------------------------

export interface KeyPackageSecrets {
  /** The public KeyPackage as an MLSMessage: `joinGroup` needs the package itself, not only the keys. */
  readonly keyPackage: Uint8Array;
  readonly initPrivateKey: Uint8Array;
  readonly hpkePrivateKey: Uint8Array;
  readonly signaturePrivateKey: Uint8Array;
}

export function encodeKeyPackageSecrets(secrets: KeyPackageSecrets): Uint8Array {
  return new ByteWriter()
    .u8(KEY_PACKAGE_PRIVATE_FORMAT_VERSION)
    .u16Vector(secrets.keyPackage)
    .u16Vector(secrets.initPrivateKey)
    .u16Vector(secrets.hpkePrivateKey)
    .u16Vector(secrets.signaturePrivateKey)
    .finish();
}

export function decodeKeyPackageSecrets(bytes: Uint8Array): KeyPackageSecrets {
  if (bytes.length > MAX_KEY_PACKAGE_PRIVATE_BYTES) {
    throw fail(
      MlsEngineErrorCode.DECODE_TOO_LARGE,
      'The key package secrets are over the size cap.',
    );
  }
  const corrupt = (what: string) =>
    fail(MlsEngineErrorCode.STATE_CORRUPT, `Key package secrets: ${what}.`);
  const reader = new ByteReader(bytes, corrupt);
  expectVersion(reader, KEY_PACKAGE_PRIVATE_FORMAT_VERSION, 'The key package secret');
  const secrets: KeyPackageSecrets = {
    keyPackage: reader.u16Vector('key package', MAX_KEY_PACKAGE_BYTES),
    initPrivateKey: reader.u16Vector('init key', MAX_PRIVATE_KEY_BYTES),
    hpkePrivateKey: reader.u16Vector('encryption key', MAX_PRIVATE_KEY_BYTES),
    signaturePrivateKey: reader.u16Vector('signature key', MAX_PRIVATE_KEY_BYTES),
  };
  if (reader.rest().length > 0) throw corrupt('trailing bytes');
  return secrets;
}

// --- Group state envelope ---------------------------------------------------------------------------------

export interface StateEnvelope {
  readonly conversationId: string;
  readonly selfUpdatePending: boolean;
  /**
   * The receive floor, in seconds: the lowest time a KeyPackage's `notAfter` is judged against on
   * receive. Only ever moves forward (see `ProcessCommitInput.acceptedAtMs`).
   */
  readonly receiveFloorSeconds: number;
  /**
   * The device-list version pinned per user at this epoch (the engine code review, docs/adr/0005):
   * the lowest version a backlog commit may find a device of that user listed in.
   */
  readonly listPins: ReadonlyMap<string, number>;
  /** ts-mls's own serialization of the group state. */
  readonly clientState: Uint8Array;
}

const FLAG_SELF_UPDATE_PENDING = 0b1;
const KNOWN_FLAGS = FLAG_SELF_UPDATE_PENDING;

/**
 * `version | flags | len(id) | id | receiveFloor u64 | pinCount u16 | pinCount x (len(userId) | userId | version u64) | ts-mls state`.
 */
export function encodeStateEnvelope(envelope: StateEnvelope): Uint8Array {
  const writer = new ByteWriter()
    .u8(STATE_FORMAT_VERSION)
    .u8(envelope.selfUpdatePending ? FLAG_SELF_UPDATE_PENDING : 0)
    .id(envelope.conversationId)
    .u64(envelope.receiveFloorSeconds)
    .u16(envelope.listPins.size);
  for (const [userId, version] of envelope.listPins) {
    writer.id(userId).u64(version);
  }
  return writer.raw(envelope.clientState).finish();
}

export function decodeStateEnvelope(bytes: Uint8Array): StateEnvelope {
  if (bytes.length > MAX_STATE_BYTES) {
    throw fail(MlsEngineErrorCode.DECODE_TOO_LARGE, 'The serialized state is over the size cap.');
  }
  const corrupt = (what: string) => fail(MlsEngineErrorCode.STATE_CORRUPT, `Group state: ${what}.`);
  const reader = new ByteReader(bytes, corrupt);
  expectVersion(reader, STATE_FORMAT_VERSION, 'The group state');
  const flags = reader.u8('flags');
  if ((flags & ~KNOWN_FLAGS) !== 0) throw corrupt('unknown flags');
  const conversationId = reader.id('conversation id');
  const receiveFloorSeconds = reader.u64('receive floor');
  const pinCount = reader.u16('pin count');
  // Pins are kept for users still in the tree, so never more than there can be leaves.
  if (pinCount > MAX_GROUP_LEAVES) throw corrupt('too many list pins');
  const listPins = new Map<string, number>();
  for (let i = 0; i < pinCount; i += 1) {
    const userId = reader.id('pinned user id');
    if (listPins.has(userId)) throw corrupt('a user is pinned twice');
    listPins.set(userId, reader.u64('pinned list version'));
  }
  return {
    conversationId,
    selfUpdatePending: (flags & FLAG_SELF_UPDATE_PENDING) !== 0,
    receiveFloorSeconds,
    listPins,
    clientState: reader.rest(),
  };
}

// --- Pending commit (a commit we posted, kept until the relay's answer is known) -------------------------

export interface PendingCommitEnvelope {
  /** The cipher suite's hash of the exact commit bytes we posted. */
  readonly commitHash: Uint8Array;
  /** The serialized state (`encodeStateEnvelope`) we move to if the relay took that commit. */
  readonly nextState: Uint8Array;
}

/** The pending-commit header: the version byte plus a length-prefixed hash. */
const MAX_PENDING_COMMIT_HEADER_BYTES = 1 + U16_BYTES + MAX_DIGEST_BYTES;

/** `version | u16 len(commitHash) | commitHash | next state (a whole state envelope)`. */
export function encodePendingCommitEnvelope(pending: PendingCommitEnvelope): Uint8Array {
  return new ByteWriter()
    .u8(PENDING_COMMIT_FORMAT_VERSION)
    .u16Vector(pending.commitHash)
    .raw(pending.nextState)
    .finish();
}

/**
 * Splits a stored pending commit. The next state inside stays serialized: the caller decodes it
 * with `decodeStateEnvelope`, which applies the state's own caps and version rule.
 */
export function decodePendingCommitEnvelope(bytes: Uint8Array): PendingCommitEnvelope {
  if (bytes.length > MAX_PENDING_COMMIT_HEADER_BYTES + MAX_STATE_BYTES) {
    throw fail(MlsEngineErrorCode.DECODE_TOO_LARGE, 'The pending commit is over the size cap.');
  }
  const corrupt = (what: string) =>
    fail(MlsEngineErrorCode.STATE_CORRUPT, `Pending commit: ${what}.`);
  const reader = new ByteReader(bytes, corrupt);
  expectVersion(reader, PENDING_COMMIT_FORMAT_VERSION, 'The pending commit');
  const commitHash = reader.u16Vector('commit hash', MAX_DIGEST_BYTES);
  if (commitHash.length === 0) throw corrupt('empty commit hash');
  const nextState = reader.rest();
  if (nextState.length === 0) throw corrupt('no next state');
  return { commitHash, nextState };
}
