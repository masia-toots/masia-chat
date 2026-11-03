import {
  MAX_GROUP_ID_BYTES,
  MAX_HANDSHAKE_BYTES,
  MAX_KEY_PACKAGE_BYTES,
  MLS_PROTOCOL_VERSION_10,
} from './vocabulary.js';

/**
 * The cleartext header of an MLSMessage (RFC 9420 §6), read WITHOUT any cryptography and without an
 * MLS library: pure byte decoding. ONE parser for both sides of the wire. The MLS engine
 * (`@masia/messenger`) uses it to refuse a message on the raw bytes before its library decodes a
 * single field; the relay uses it to check a handshake against the room. Until 2026-10-10 the engine
 * kept a "deliberate minimal copy" of the relay's parser, held to it by a parity test (architecture
 * review round 1); both now import this one.
 *
 * What is in the clear depends on the wire format: always the version and the wire format; the
 * group id, epoch and content type of a PublicMessage or PrivateMessage; the sender of a
 * PublicMessage only (a PrivateMessage encrypts its sender); the cipher suite of a Welcome or a
 * KeyPackage.
 *
 * Why the relay looks at it at all: the relay's epoch counter is not the MLS epoch. Without a
 * check, any member can post garbage (or a replayed commit); the relay advances its counter, every
 * client rejects the commit, and from then on the room answers 409 to every honest commit for ever
 * (security review 2026-10-10 §4). RFC 9420 leaves `group_id`, `epoch` and `content_type` in the
 * clear even in a PrivateMessage, so the relay can require that they match the room and the kind
 * of message the sender says it is posting. That proves nothing about the content (only the
 * clients can), it just stops a stalled room being one cheap request away.
 *
 * This parser reads only the PREFIX it needs and never allocates from a length the message
 * claims: every length is checked against the bytes actually present, and the whole input is
 * size-capped first. The only way it fails is `MlsHeaderError`.
 */

/** `WireFormat` (RFC 9420 §6). 0 is reserved and never valid. */
export const MlsWireFormat = {
  PUBLIC_MESSAGE: 1,
  PRIVATE_MESSAGE: 2,
  WELCOME: 3,
  GROUP_INFO: 4,
  KEY_PACKAGE: 5,
} as const;
export type MlsWireFormat = (typeof MlsWireFormat)[keyof typeof MlsWireFormat];

/** `ContentType` (RFC 9420 §6.1). 0 is reserved and never valid. */
export const MlsContentType = {
  APPLICATION: 1,
  PROPOSAL: 2,
  COMMIT: 3,
} as const;
export type MlsContentType = (typeof MlsContentType)[keyof typeof MlsContentType];

/** `SenderType` (RFC 9420 §6.1). 0 is reserved and never valid. */
export const MlsSenderType = {
  MEMBER: 1,
  EXTERNAL: 2,
  NEW_MEMBER_PROPOSAL: 3,
  NEW_MEMBER_COMMIT: 4,
} as const;
export type MlsSenderType = (typeof MlsSenderType)[keyof typeof MlsSenderType];

/**
 * Largest message the parser looks at when the caller names no cap. It is the largest thing a
 * client may post as a handshake, so a message the relay would store anyway is never refused here
 * for its size alone. A caller that expects a smaller kind of message (an envelope, a KeyPackage)
 * passes that kind's cap.
 */
export const MAX_MLS_HEADER_INPUT_BYTES = MAX_HANDSHAKE_BYTES;

/** Why a header could not be read. Stable, so callers and tests branch on it, not on a message. */
export const MlsHeaderErrorReason = {
  TOO_LARGE: 'TOO_LARGE',
  TRUNCATED: 'TRUNCATED',
  UNSUPPORTED_VERSION: 'UNSUPPORTED_VERSION',
  UNKNOWN_WIRE_FORMAT: 'UNKNOWN_WIRE_FORMAT',
  UNKNOWN_SENDER_TYPE: 'UNKNOWN_SENDER_TYPE',
  UNKNOWN_CONTENT_TYPE: 'UNKNOWN_CONTENT_TYPE',
  INVALID_LENGTH_PREFIX: 'INVALID_LENGTH_PREFIX',
  NON_MINIMAL_LENGTH: 'NON_MINIMAL_LENGTH',
  VECTOR_TOO_LONG: 'VECTOR_TOO_LONG',
  NOT_A_KEY_PACKAGE: 'NOT_A_KEY_PACKAGE',
  UNKNOWN_CREDENTIAL_TYPE: 'UNKNOWN_CREDENTIAL_TYPE',
  NOT_A_KEY_PACKAGE_LEAF: 'NOT_A_KEY_PACKAGE_LEAF',
} as const;
export type MlsHeaderErrorReason = (typeof MlsHeaderErrorReason)[keyof typeof MlsHeaderErrorReason];

/** The part of the message being read when it failed; the relay reports it to the client. */
export type MlsHeaderField =
  | 'message'
  | 'version'
  | 'wireFormat'
  | 'groupId'
  | 'epoch'
  | 'sender'
  | 'authenticatedData'
  | 'contentType'
  | 'cipherSuite'
  | 'secrets'
  | 'initKey'
  | 'encryptionKey'
  | 'signatureKey'
  | 'credential'
  | 'capabilities'
  | 'leafNodeSource'
  | 'lifetime';

/** The one error `parseMlsHeader` throws, whatever the input. */
export class MlsHeaderError extends Error {
  readonly reason: MlsHeaderErrorReason;
  readonly field: MlsHeaderField;

  constructor(reason: MlsHeaderErrorReason, field: MlsHeaderField, message?: string) {
    super(message ?? `Unreadable MLSMessage header (${reason} at ${field}).`);
    this.name = 'MlsHeaderError';
    this.reason = reason;
    this.field = field;
  }
}

export interface MlsSender {
  readonly type: MlsSenderType;
  /** The leaf index of a `member`, the sender index of an `external` sender; absent otherwise. */
  readonly index?: number;
}

/** A PublicMessage or a PrivateMessage: the two wire formats that carry a group's traffic. */
export interface MlsFramedHeader {
  readonly wireFormat: typeof MlsWireFormat.PUBLIC_MESSAGE | typeof MlsWireFormat.PRIVATE_MESSAGE;
  readonly groupId: Uint8Array;
  /** A `uint64` on the wire, so a bigint: no value a peer can send loses precision. */
  readonly epoch: bigint;
  readonly contentType: MlsContentType;
  /** Present for a PublicMessage only; in a PrivateMessage the sender is encrypted. */
  readonly sender?: MlsSender;
}

/** A Welcome: it names no group and no epoch in the clear, only the cipher suite. */
export interface MlsWelcomeHeader {
  readonly wireFormat: typeof MlsWireFormat.WELCOME;
  readonly cipherSuite: number;
}

/** A KeyPackage: `version` and `cipher_suite` come first in the KeyPackage body (RFC 9420 §10). */
export interface MlsKeyPackageHeader {
  readonly wireFormat: typeof MlsWireFormat.KEY_PACKAGE;
  readonly cipherSuite: number;
}

/** A GroupInfo: recognised, nothing past the wire format is read. The messenger never accepts one. */
export interface MlsGroupInfoHeader {
  readonly wireFormat: typeof MlsWireFormat.GROUP_INFO;
}

export type MlsHeader =
  | MlsFramedHeader
  | MlsWelcomeHeader
  | MlsKeyPackageHeader
  | MlsGroupInfoHeader;

// RFC 9420 §2.1.2: the length prefix of a vector is a variable-length integer whose first two
// bits say how many bytes it takes. The smallest encoding that fits MUST be used.
const VARINT_ONE_BYTE_MAX = 0x3f;
const VARINT_TWO_BYTE_MAX = 0x3fff;
const VARINT_PREFIX_SHIFT = 6;
const VARINT_VALUE_MASK = 0x3f;
const VARINT_PREFIX_1_BYTE = 0;
const VARINT_PREFIX_2_BYTES = 1;
const VARINT_PREFIX_4_BYTES = 2;

class Reader {
  private offset = 0;
  private readonly view: DataView;

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  private get remaining(): number {
    return this.bytes.length - this.offset;
  }

  private take(count: number, field: MlsHeaderField): number {
    if (count > this.remaining) throw new MlsHeaderError(MlsHeaderErrorReason.TRUNCATED, field);
    const start = this.offset;
    this.offset += count;
    return start;
  }

  u8(field: MlsHeaderField): number {
    return this.view.getUint8(this.take(1, field));
  }

  u16(field: MlsHeaderField): number {
    return this.view.getUint16(this.take(2, field));
  }

  u32(field: MlsHeaderField): number {
    return this.view.getUint32(this.take(4, field));
  }

  u64(field: MlsHeaderField): bigint {
    return this.view.getBigUint64(this.take(8, field));
  }

  /** The length prefix of a vector (RFC 9420 §2.1.2). Rejects the invalid prefix and non-minimal forms. */
  private length(field: MlsHeaderField): number {
    const first = this.u8(field);
    const prefix = first >> VARINT_PREFIX_SHIFT;
    const high = first & VARINT_VALUE_MASK;
    if (prefix === VARINT_PREFIX_1_BYTE) return high;
    if (prefix === VARINT_PREFIX_2_BYTES) {
      const value = high * 0x100 + this.u8(field);
      if (value <= VARINT_ONE_BYTE_MAX) {
        throw new MlsHeaderError(MlsHeaderErrorReason.NON_MINIMAL_LENGTH, field);
      }
      return value;
    }
    if (prefix === VARINT_PREFIX_4_BYTES) {
      const value =
        high * 0x1000000 + this.u8(field) * 0x10000 + this.u8(field) * 0x100 + this.u8(field);
      if (value <= VARINT_TWO_BYTE_MAX) {
        throw new MlsHeaderError(MlsHeaderErrorReason.NON_MINIMAL_LENGTH, field);
      }
      return value;
    }
    throw new MlsHeaderError(MlsHeaderErrorReason.INVALID_LENGTH_PREFIX, field);
  }

  /** `opaque x<V>`: a copy of its content, never longer than `maxBytes` nor than what is present. */
  vector(field: MlsHeaderField, maxBytes: number): Uint8Array {
    const length = this.length(field);
    if (length > maxBytes) throw new MlsHeaderError(MlsHeaderErrorReason.VECTOR_TOO_LONG, field);
    const start = this.take(length, field);
    // `Uint8Array.from`, not `.slice`: on a Node Buffer `.slice` is a VIEW of the same memory.
    return Uint8Array.from(this.bytes.subarray(start, start + length));
  }

  /** `opaque x<V>` that is stepped over: only its length is validated, nothing is copied. */
  skipVector(field: MlsHeaderField): void {
    this.take(this.length(field), field);
  }
}

function readContentType(reader: Reader): MlsContentType {
  const value = reader.u8('contentType');
  if (
    value !== MlsContentType.APPLICATION &&
    value !== MlsContentType.PROPOSAL &&
    value !== MlsContentType.COMMIT
  ) {
    throw new MlsHeaderError(MlsHeaderErrorReason.UNKNOWN_CONTENT_TYPE, 'contentType');
  }
  return value;
}

/** `Sender` (RFC 9420 §6.1): a type byte, then a u32 for `member` and `external`, nothing else. */
function readSender(reader: Reader): MlsSender {
  const type = reader.u8('sender');
  switch (type) {
    case MlsSenderType.MEMBER:
    case MlsSenderType.EXTERNAL:
      return { type, index: reader.u32('sender') };
    case MlsSenderType.NEW_MEMBER_PROPOSAL:
    case MlsSenderType.NEW_MEMBER_COMMIT:
      return { type };
    default:
      throw new MlsHeaderError(MlsHeaderErrorReason.UNKNOWN_SENDER_TYPE, 'sender');
  }
}

/**
 * Reads the header of an MLSMessage:
 *
 *   uint16 version = 1 · uint16 wire_format ·
 *   PrivateMessage:  group_id<V> · uint64 epoch · uint8 content_type · …
 *   PublicMessage:   group_id<V> · uint64 epoch · Sender · authenticated_data<V> · uint8 content_type · …
 *   Welcome:         uint16 cipher_suite · secrets<V> · …
 *   KeyPackage:      uint16 version = 1 · uint16 cipher_suite · …
 *
 * `maxBytes` is the cap for the kind of message the caller expects; it is checked first, so an
 * oversized input is `TOO_LARGE` before anything reads it. Everything after the part listed is left
 * unread. Throws `MlsHeaderError` and nothing else, for any input at all.
 */
export function parseMlsHeader(
  bytes: Uint8Array,
  maxBytes: number = MAX_MLS_HEADER_INPUT_BYTES,
): MlsHeader {
  if (bytes.length > maxBytes) {
    throw new MlsHeaderError(
      MlsHeaderErrorReason.TOO_LARGE,
      'message',
      `${bytes.length} bytes is over the ${maxBytes}-byte cap for this kind of message.`,
    );
  }
  const reader = new Reader(bytes);

  if (reader.u16('version') !== MLS_PROTOCOL_VERSION_10) {
    throw new MlsHeaderError(MlsHeaderErrorReason.UNSUPPORTED_VERSION, 'version');
  }
  const wireFormat = reader.u16('wireFormat');

  switch (wireFormat) {
    case MlsWireFormat.PRIVATE_MESSAGE: {
      const groupId = reader.vector('groupId', MAX_GROUP_ID_BYTES);
      const epoch = reader.u64('epoch');
      return { wireFormat, groupId, epoch, contentType: readContentType(reader) };
    }
    case MlsWireFormat.PUBLIC_MESSAGE: {
      const groupId = reader.vector('groupId', MAX_GROUP_ID_BYTES);
      const epoch = reader.u64('epoch');
      const sender = readSender(reader);
      reader.skipVector('authenticatedData');
      return { wireFormat, groupId, epoch, sender, contentType: readContentType(reader) };
    }
    case MlsWireFormat.WELCOME: {
      const cipherSuite = reader.u16('cipherSuite');
      // The secrets vector must at least be well-formed: a Welcome with no readable body is junk.
      reader.skipVector('secrets');
      return { wireFormat, cipherSuite };
    }
    case MlsWireFormat.KEY_PACKAGE: {
      // The KeyPackage's own protocol version, inside the MLSMessage.
      if (reader.u16('version') !== MLS_PROTOCOL_VERSION_10) {
        throw new MlsHeaderError(MlsHeaderErrorReason.UNSUPPORTED_VERSION, 'version');
      }
      return { wireFormat, cipherSuite: reader.u16('cipherSuite') };
    }
    case MlsWireFormat.GROUP_INFO:
      return { wireFormat };
    default:
      throw new MlsHeaderError(MlsHeaderErrorReason.UNKNOWN_WIRE_FORMAT, 'wireFormat');
  }
}

// --- KeyPackage lifetime (RFC 9420 §10, §7.2) ----------------------------------------------------

/** `CredentialType` (RFC 9420 §5.3). Only these two have a body the relay knows how to step over. */
export const MlsCredentialType = {
  BASIC: 1,
  X509: 2,
} as const;

/** `LeafNodeSource` (RFC 9420 §7.2). Only a `key_package` leaf carries a lifetime. */
export const MLS_LEAF_NODE_SOURCE_KEY_PACKAGE = 1;

/** `Capabilities` (RFC 9420 §7.2) is five vectors in a row. */
const CAPABILITIES_VECTORS = 5;

/** The `Lifetime` of a KeyPackage's leaf, in seconds since the Unix epoch (RFC 9420 §7.2). */
export interface MlsKeyPackageLifetime {
  readonly notBefore: bigint;
  readonly notAfter: bigint;
}

/** The largest input `parseKeyPackageLifetime` reads: the largest key package the relay stores. */
export const MAX_KEY_PACKAGE_INPUT_BYTES = MAX_KEY_PACKAGE_BYTES;

/**
 * Reads the `lifetime` of an MLSMessage that carries a KeyPackage, WITHOUT any cryptography:
 *
 *   uint16 version = 1 · uint16 wire_format = mls_key_package ·
 *   KeyPackage: uint16 version · uint16 cipher_suite · init_key<V> ·
 *     LeafNode: encryption_key<V> · signature_key<V> · Credential · Capabilities ·
 *               uint8 leaf_node_source = key_package · Lifetime { uint64 not_before; uint64 not_after }
 *
 * Why the relay reads it: a key package past its `not_after` is one every honest adder refuses, so
 * serving it wastes a claim and, for the last-resort package, makes the device impossible to add.
 * Reading the lifetime once at upload lets the relay store `not_after` beside the bytes and skip
 * (and purge) expired packages without reading the bytes again. The signature is NOT checked: to
 * the relay the lifetime is advisory, and the adder still verifies the whole package.
 *
 * Throws `MlsHeaderError` and nothing else, for any input at all.
 */
export function parseKeyPackageLifetime(bytes: Uint8Array): MlsKeyPackageLifetime {
  if (bytes.length > MAX_KEY_PACKAGE_INPUT_BYTES) {
    throw new MlsHeaderError(MlsHeaderErrorReason.TOO_LARGE, 'message');
  }
  const reader = new Reader(bytes);
  if (reader.u16('version') !== MLS_PROTOCOL_VERSION_10) {
    throw new MlsHeaderError(MlsHeaderErrorReason.UNSUPPORTED_VERSION, 'version');
  }
  if (reader.u16('wireFormat') !== MlsWireFormat.KEY_PACKAGE) {
    throw new MlsHeaderError(MlsHeaderErrorReason.NOT_A_KEY_PACKAGE, 'wireFormat');
  }
  // The KeyPackage's own protocol version, inside the MLSMessage.
  if (reader.u16('version') !== MLS_PROTOCOL_VERSION_10) {
    throw new MlsHeaderError(MlsHeaderErrorReason.UNSUPPORTED_VERSION, 'version');
  }
  reader.u16('cipherSuite');
  reader.skipVector('initKey');
  reader.skipVector('encryptionKey');
  reader.skipVector('signatureKey');
  const credentialType = reader.u16('credential');
  if (credentialType !== MlsCredentialType.BASIC && credentialType !== MlsCredentialType.X509) {
    throw new MlsHeaderError(MlsHeaderErrorReason.UNKNOWN_CREDENTIAL_TYPE, 'credential');
  }
  // basic: `identity<V>`; x509: `certificates<V>`. Either way exactly one vector.
  reader.skipVector('credential');
  for (let index = 0; index < CAPABILITIES_VECTORS; index += 1) reader.skipVector('capabilities');
  if (reader.u8('leafNodeSource') !== MLS_LEAF_NODE_SOURCE_KEY_PACKAGE) {
    throw new MlsHeaderError(MlsHeaderErrorReason.NOT_A_KEY_PACKAGE_LEAF, 'leafNodeSource');
  }
  const notBefore = reader.u64('lifetime');
  const notAfter = reader.u64('lifetime');
  return { notBefore, notAfter };
}
