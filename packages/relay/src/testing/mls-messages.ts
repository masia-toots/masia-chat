import {
  MLS_LEAF_NODE_SOURCE_KEY_PACKAGE,
  MLS_PROTOCOL_VERSION_10,
  MlsContentType,
  MlsCredentialType,
  MlsSenderType,
  MlsWireFormat,
} from '@masia/contracts/wire';

/**
 * Hand-rolled TLS encoders for the cleartext prefix of an MLSMessage, for TESTS ONLY (exported as
 * `@masia/relay/testing`; nothing in the relay's own code imports this).
 *
 * They exist so a test can build the bytes of a PrivateMessage or a Welcome without pulling in an
 * MLS library: the relay never decrypts, so the prefix is all it ever reads. They are written
 * straight from RFC 9420 §6 and §2.1.2, separately from the parser, and `mls-header.test.ts` also
 * pins literal byte vectors, so a mistake shared by encoder and parser would still show up there.
 */

const VARINT_ONE_BYTE_MAX = 0x3f;
const VARINT_TWO_BYTE_MAX = 0x3fff;
const VARINT_FOUR_BYTE_MAX = 0x3fffffff;
const VARINT_TWO_BYTE_PREFIX = 0x4000;
const VARINT_FOUR_BYTE_PREFIX = 0x80000000;

/** The length prefix of a vector, in the shortest form (RFC 9420 §2.1.2). */
export function encodeLength(length: number): Buffer {
  if (length <= VARINT_ONE_BYTE_MAX) return Buffer.from([length]);
  if (length <= VARINT_TWO_BYTE_MAX) {
    const out = Buffer.alloc(2);
    out.writeUInt16BE(VARINT_TWO_BYTE_PREFIX | length);
    return out;
  }
  if (length <= VARINT_FOUR_BYTE_MAX) {
    const out = Buffer.alloc(4);
    out.writeUInt32BE((VARINT_FOUR_BYTE_PREFIX | length) >>> 0);
    return out;
  }
  throw new RangeError('A vector this long cannot be encoded.');
}

/** `opaque x<V>`. */
export function vector(content: Uint8Array): Buffer {
  return Buffer.concat([encodeLength(content.length), content]);
}

export function uint16(value: number): Buffer {
  const out = Buffer.alloc(2);
  out.writeUInt16BE(value);
  return out;
}

export function uint32(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value);
  return out;
}

export function uint64(value: bigint): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigUInt64BE(value);
  return out;
}

const messagePrefix = (wireFormat: number): Buffer =>
  Buffer.concat([uint16(MLS_PROTOCOL_VERSION_10), uint16(wireFormat)]);

export interface PrivateMessageOptions {
  readonly groupId: Uint8Array;
  readonly epoch: bigint | number;
  readonly contentType: number;
  /** The `ciphertext<V>` content. Defaults to a short filler. */
  readonly ciphertext?: Uint8Array;
}

const FILLER_CIPHERTEXT = Buffer.from('ciphertext-filler');
const FILLER_SENDER_DATA = Buffer.from('encrypted-sender-data');

/** A PrivateMessage: header, empty authenticated data, filler sender data, then the ciphertext. */
export function buildPrivateMessage(options: PrivateMessageOptions): Buffer {
  return Buffer.concat([
    messagePrefix(MlsWireFormat.PRIVATE_MESSAGE),
    vector(options.groupId),
    uint64(BigInt(options.epoch)),
    Buffer.from([options.contentType]),
    vector(Buffer.alloc(0)),
    vector(FILLER_SENDER_DATA),
    vector(options.ciphertext ?? FILLER_CIPHERTEXT),
  ]);
}

/**
 * A PrivateMessage of EXACTLY `totalBytes` bytes (the ciphertext is padded), for size-limit tests.
 * The length prefix of the padded vector changes size at 64 and 16384, hence the search.
 */
export function buildPrivateMessageOfSize(
  options: Omit<PrivateMessageOptions, 'ciphertext'>,
  totalBytes: number,
): Buffer {
  const base = buildPrivateMessage({ ...options, ciphertext: Buffer.alloc(0) });
  // `base` already holds a one-byte prefix for the empty ciphertext; swap it for the padded one.
  const fixed = base.length - encodeLength(0).length;
  for (const prefixBytes of [1, 2, 4]) {
    const padding = totalBytes - fixed - prefixBytes;
    if (padding >= 0 && encodeLength(padding).length === prefixBytes) {
      return buildPrivateMessage({ ...options, ciphertext: Buffer.alloc(padding, 1) });
    }
  }
  throw new RangeError(`No PrivateMessage is exactly ${totalBytes} bytes long.`);
}

export interface PublicMessageOptions {
  readonly groupId: Uint8Array;
  readonly epoch: bigint | number;
  readonly contentType: number;
  /** Defaults to a `member` at leaf 0. */
  readonly sender?: { readonly type: number; readonly index?: number };
  readonly authenticatedData?: Uint8Array;
}

/** A PublicMessage: `FramedContent` up to and including `content_type`, then a filler body. */
export function buildPublicMessage(options: PublicMessageOptions): Buffer {
  const sender = options.sender ?? { type: MlsSenderType.MEMBER, index: 0 };
  const hasIndex = sender.type === MlsSenderType.MEMBER || sender.type === MlsSenderType.EXTERNAL;
  return Buffer.concat([
    messagePrefix(MlsWireFormat.PUBLIC_MESSAGE),
    vector(options.groupId),
    uint64(BigInt(options.epoch)),
    Buffer.from([sender.type]),
    hasIndex ? uint32(sender.index ?? 0) : Buffer.alloc(0),
    vector(options.authenticatedData ?? Buffer.alloc(0)),
    Buffer.from([options.contentType]),
    vector(FILLER_CIPHERTEXT),
  ]);
}

export interface WelcomeOptions {
  readonly cipherSuite?: number;
  readonly secrets?: Uint8Array;
}

const DEFAULT_CIPHER_SUITE = 1;

/** A Welcome wrapped in an MLSMessage: cipher suite, `secrets<V>`, then a filler `encrypted_group_info`. */
export function buildWelcome(options: WelcomeOptions = {}): Buffer {
  return Buffer.concat([
    messagePrefix(MlsWireFormat.WELCOME),
    uint16(options.cipherSuite ?? DEFAULT_CIPHER_SUITE),
    vector(options.secrets ?? Buffer.from('encrypted-group-secrets')),
    vector(Buffer.from('encrypted-group-info')),
  ]);
}

const SECONDS_PER_DAY = 24 * 60 * 60;
/** What a test key package lives by default: from a day ago to ninety days ahead of the clock. */
const DEFAULT_KEY_PACKAGE_PAST_SECONDS = SECONDS_PER_DAY;
const DEFAULT_KEY_PACKAGE_FUTURE_SECONDS = 90 * SECONDS_PER_DAY;

export interface KeyPackageOptions {
  /** Seconds since the Unix epoch. Default: ninety days after `nowSeconds`. */
  readonly notAfter?: bigint | number;
  /** Seconds since the Unix epoch. Default: one day before `nowSeconds`. */
  readonly notBefore?: bigint | number;
  /** The clock the defaults are taken from, in seconds. Default: the real clock. */
  readonly nowSeconds?: number;
  readonly credentialType?: number;
  readonly leafNodeSource?: number;
  /** Makes two packages with the same lifetime differ (a different `init_key`). */
  readonly seed?: string;
}

/**
 * A KeyPackage wrapped in an MLSMessage, laid out as RFC 9420 §10 and §7.2 say, with filler keys,
 * a basic credential, empty capabilities and a filler signature. Nothing in it would verify; it is
 * the shape the relay reads `lifetime` from, and nothing more.
 */
export function buildKeyPackage(options: KeyPackageOptions = {}): Buffer {
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const notBefore = BigInt(options.notBefore ?? nowSeconds - DEFAULT_KEY_PACKAGE_PAST_SECONDS);
  const notAfter = BigInt(options.notAfter ?? nowSeconds + DEFAULT_KEY_PACKAGE_FUTURE_SECONDS);
  const emptyVector = vector(Buffer.alloc(0));
  return Buffer.concat([
    messagePrefix(MlsWireFormat.KEY_PACKAGE),
    uint16(MLS_PROTOCOL_VERSION_10),
    uint16(DEFAULT_CIPHER_SUITE),
    vector(Buffer.from(`init-key:${options.seed ?? ''}`)),
    // LeafNode
    vector(Buffer.from('encryption-key')),
    vector(Buffer.from('signature-key')),
    uint16(options.credentialType ?? MlsCredentialType.BASIC),
    vector(Buffer.from('identity')),
    emptyVector, // capabilities.versions
    emptyVector, // capabilities.cipher_suites
    emptyVector, // capabilities.extensions
    emptyVector, // capabilities.proposals
    emptyVector, // capabilities.credentials
    Buffer.from([options.leafNodeSource ?? MLS_LEAF_NODE_SOURCE_KEY_PACKAGE]),
    uint64(notBefore),
    uint64(notAfter),
    emptyVector, // leaf_node.extensions
    vector(Buffer.from('leaf-signature')),
    // KeyPackage tail
    emptyVector, // extensions
    vector(Buffer.from('key-package-signature')),
  ]);
}

/** Re-exported so a test needs one import for the constants it builds with. */
export { MlsContentType, MlsCredentialType, MlsSenderType, MlsWireFormat };
