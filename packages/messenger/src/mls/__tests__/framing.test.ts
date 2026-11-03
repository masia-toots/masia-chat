import { describe, expect, it } from 'vitest';
import {
  KEY_PACKAGE_PRIVATE_FORMAT_VERSION,
  MAX_AAD_EXTRA_BYTES,
  MAX_GROUP_LEAVES,
  MAX_ID_BYTES,
  MAX_KEY_PACKAGE_BYTES,
  MAX_KEY_PACKAGE_PRIVATE_BYTES,
  MAX_PLAINTEXT_BYTES,
  MAX_PRIVATE_KEY_BYTES,
  MAX_STATE_BYTES,
  PENDING_COMMIT_FORMAT_VERSION,
  STATE_FORMAT_VERSION,
} from '../constants.js';
import {
  assertExtraAadSize,
  decodeKeyPackageSecrets,
  decodePendingCommitEnvelope,
  decodeStateEnvelope,
  encodeKeyPackageSecrets,
  encodePendingCommitEnvelope,
  encodeStateEnvelope,
  frameAad,
  unframeAad,
} from '../framing.js';
import { MlsEngineErrorCode } from '../mls-error.js';
import { expectCode } from './support/expect-code.js';

const filled = (length: number, value: number) => new Uint8Array(length).fill(value);
/** One past what a `u16` length prefix can say. */
const OVER_U16 = 0x10000;
/** The SHA-256 output length: the hash of suite 1. */
const SHA256_BYTES = 32;
/** The SHA-512 output length: the longest hash an MLS suite uses. */
const LONGEST_MLS_HASH_BYTES = 64;

function withFirstByte(bytes: Uint8Array, value: number): Uint8Array {
  const out = Uint8Array.from(bytes);
  out[0] = value;
  return out;
}

describe('authenticated-data framing (review §4: the conversation id is inside every application message)', () => {
  it('prefixes the conversation id and hands `extra` back', () => {
    const extra = Uint8Array.of(1, 2, 3);
    const framed = frameAad('conv-1', extra);
    expect(framed[0]).toBe('conv-1'.length);
    expect(Array.from(unframeAad('conv-1', framed))).toEqual([1, 2, 3]);
    expect(unframeAad('conv-1', frameAad('conv-1'))).toHaveLength(0);
  });

  it('refuses a message framed for another conversation, whatever the difference', async () => {
    const framed = frameAad('conv-1', Uint8Array.of(9));
    await expectCode(() => unframeAad('conv-2', framed), MlsEngineErrorCode.AAD_MISMATCH);
    await expectCode(() => unframeAad('conv-', framed), MlsEngineErrorCode.AAD_MISMATCH); // a prefix of the id is not the id
    await expectCode(() => unframeAad('conv-10', framed), MlsEngineErrorCode.AAD_MISMATCH);
    await expectCode(() => unframeAad('conv-1', new Uint8Array()), MlsEngineErrorCode.AAD_MISMATCH);
    await expectCode(() => unframeAad('conv-1', Uint8Array.of(6)), MlsEngineErrorCode.AAD_MISMATCH);
  });

  it('refuses an invalid conversation id (a caller bug) and oversized extra data', async () => {
    await expectCode(() => frameAad('not valid'), MlsEngineErrorCode.INVALID_ARGUMENT);
    await expectCode(() => frameAad(''), MlsEngineErrorCode.INVALID_ARGUMENT);
    await expectCode(
      () => frameAad('c', new Uint8Array(MAX_AAD_EXTRA_BYTES + 1)),
      MlsEngineErrorCode.DECODE_TOO_LARGE,
    );
    expect(frameAad('c', new Uint8Array(MAX_AAD_EXTRA_BYTES))).toHaveLength(
      2 + MAX_AAD_EXTRA_BYTES,
    );
  });

  it('caps the extra data at the named AAD limit, far below a message (1 KiB)', () => {
    expect(MAX_AAD_EXTRA_BYTES).toBe(1024);
    expect(MAX_AAD_EXTRA_BYTES).toBeLessThan(MAX_PLAINTEXT_BYTES);
    expect(() => assertExtraAadSize(new Uint8Array(MAX_AAD_EXTRA_BYTES))).not.toThrow();
  });
});

describe('KeyPackage secrets (what a device keeps until the Welcome arrives)', () => {
  const secrets = {
    keyPackage: filled(300, 1),
    initPrivateKey: filled(32, 2),
    hpkePrivateKey: filled(32, 3),
    signaturePrivateKey: filled(32, 4),
  };

  it('round-trips', () => {
    const decoded = decodeKeyPackageSecrets(encodeKeyPackageSecrets(secrets));
    expect(decoded).toEqual(secrets);
  });

  it('is versioned: another version is unsupported, not corrupt', async () => {
    const encoded = encodeKeyPackageSecrets(secrets);
    expect(encoded[0]).toBe(KEY_PACKAGE_PRIVATE_FORMAT_VERSION);
    for (const version of [
      KEY_PACKAGE_PRIVATE_FORMAT_VERSION - 1,
      KEY_PACKAGE_PRIVATE_FORMAT_VERSION + 1,
    ]) {
      await expectCode(
        () => decodeKeyPackageSecrets(withFirstByte(encoded, version)),
        MlsEngineErrorCode.STATE_VERSION_UNSUPPORTED,
      );
    }
  });

  it('refuses to write a field its length prefix cannot describe, instead of truncating it', async () => {
    await expectCode(
      () => encodeKeyPackageSecrets({ ...secrets, keyPackage: new Uint8Array(OVER_U16) }),
      MlsEngineErrorCode.INVALID_STATE,
    );
  });

  it('refuses truncation at every length, trailing bytes, and a vector longer than its field allows', async () => {
    const encoded = encodeKeyPackageSecrets(secrets);
    for (let length = 0; length < encoded.length; length += 1) {
      await expectCode(
        () => decodeKeyPackageSecrets(encoded.slice(0, length)),
        MlsEngineErrorCode.STATE_CORRUPT,
      );
    }
    await expectCode(
      () => decodeKeyPackageSecrets(Uint8Array.from([...encoded, 0])),
      MlsEngineErrorCode.STATE_CORRUPT,
    );
    const oversizedKey = encodeKeyPackageSecrets({
      ...secrets,
      initPrivateKey: filled(MAX_PRIVATE_KEY_BYTES + 1, 2),
    });
    await expectCode(() => decodeKeyPackageSecrets(oversizedKey), MlsEngineErrorCode.STATE_CORRUPT);
    const oversizedPackage = encodeKeyPackageSecrets({
      ...secrets,
      keyPackage: filled(MAX_KEY_PACKAGE_BYTES + 1, 1),
    });
    await expectCode(
      () => decodeKeyPackageSecrets(oversizedPackage),
      MlsEngineErrorCode.STATE_CORRUPT,
    );
  });

  it('checks the size cap before reading anything', async () => {
    await expectCode(
      () => decodeKeyPackageSecrets(new Uint8Array(MAX_KEY_PACKAGE_PRIVATE_BYTES + 1)),
      MlsEngineErrorCode.DECODE_TOO_LARGE,
    );
  });
});

describe('group state envelope', () => {
  const envelope = {
    conversationId: 'conv-1',
    selfUpdatePending: true,
    receiveFloorSeconds: 1_799_000_000,
    listPins: new Map([
      ['alice', 3],
      ['bob', 12],
    ]),
    clientState: filled(500, 7),
  };
  // version | flags | idLen | id (6) | floor u64 | pinCount u16 | pins ...
  const FLOOR_AT = 3 + 'conv-1'.length;
  const PIN_COUNT_AT = FLOOR_AT + 8;
  const FIRST_PIN_AT = PIN_COUNT_AT + 2;

  it('round-trips both flag values', () => {
    expect(decodeStateEnvelope(encodeStateEnvelope(envelope))).toEqual(envelope);
    const calm = { ...envelope, selfUpdatePending: false };
    expect(decodeStateEnvelope(encodeStateEnvelope(calm))).toEqual(calm);
  });

  it('round-trips the receive floor and the pinned list versions, in order', () => {
    const decoded = decodeStateEnvelope(encodeStateEnvelope(envelope));
    expect(decoded.receiveFloorSeconds).toBe(envelope.receiveFloorSeconds);
    expect([...decoded.listPins]).toEqual([...envelope.listPins]);
    const bare = { ...envelope, listPins: new Map<string, number>(), receiveFloorSeconds: 0 };
    expect(decodeStateEnvelope(encodeStateEnvelope(bare))).toEqual(bare);
  });

  it('refuses a duplicated pin, a bad pinned user id and an absurd pin count', async () => {
    const encoded = encodeStateEnvelope(envelope);
    // First pin is `alice` (len 5): make the second pin ('bob', len 3) read as `alice` too.
    const firstPinEnd = FIRST_PIN_AT + 1 + 'alice'.length + 8;
    const duplicate = Uint8Array.from(encoded);
    duplicate[firstPinEnd] = 5;
    duplicate.set(new TextEncoder().encode('alice'), firstPinEnd + 1);
    await expectCode(
      () => decodeStateEnvelope(duplicate.slice(0, firstPinEnd + 1 + 5 + 8)),
      MlsEngineErrorCode.STATE_CORRUPT,
    );
    const badUser = Uint8Array.from(encoded);
    badUser[FIRST_PIN_AT + 1] = 0x20; // a space inside the pinned user id
    await expectCode(() => decodeStateEnvelope(badUser), MlsEngineErrorCode.STATE_CORRUPT);
    const tooMany = Uint8Array.from(encoded);
    tooMany[PIN_COUNT_AT] = (MAX_GROUP_LEAVES + 1) >> 8;
    tooMany[PIN_COUNT_AT + 1] = (MAX_GROUP_LEAVES + 1) & 0xff;
    await expectCode(() => decodeStateEnvelope(tooMany), MlsEngineErrorCode.STATE_CORRUPT);
    // A count that promises more pins than the bytes hold.
    const short = Uint8Array.from(encoded);
    short[PIN_COUNT_AT + 1] = 200;
    await expectCode(() => decodeStateEnvelope(short), MlsEngineErrorCode.STATE_CORRUPT);
  });

  it('is versioned: an older or newer version is unsupported (keep the bytes), never corrupt', async () => {
    const encoded = encodeStateEnvelope(envelope);
    expect(encoded[0]).toBe(STATE_FORMAT_VERSION);
    for (const version of [STATE_FORMAT_VERSION - 1, STATE_FORMAT_VERSION + 1]) {
      await expectCode(
        () => decodeStateEnvelope(withFirstByte(encoded, version)),
        MlsEngineErrorCode.STATE_VERSION_UNSUPPORTED,
      );
    }
  });

  it('refuses unknown flags', async () => {
    const encoded = encodeStateEnvelope(envelope);
    const unknownFlag = Uint8Array.from(encoded);
    unknownFlag[1] = (unknownFlag[1] ?? 0) | 0b10;
    await expectCode(() => decodeStateEnvelope(unknownFlag), MlsEngineErrorCode.STATE_CORRUPT);
  });

  it('refuses a bad conversation id, however it is damaged', async () => {
    const encoded = encodeStateEnvelope(envelope);
    const zeroLength = Uint8Array.from(encoded);
    zeroLength[2] = 0;
    await expectCode(() => decodeStateEnvelope(zeroLength), MlsEngineErrorCode.STATE_CORRUPT);
    const tooLong = Uint8Array.from(encoded);
    tooLong[2] = MAX_ID_BYTES + 1;
    await expectCode(() => decodeStateEnvelope(tooLong), MlsEngineErrorCode.STATE_CORRUPT);
    const badCharacter = Uint8Array.from(encoded);
    badCharacter[3] = 0x20; // a space inside the id
    await expectCode(() => decodeStateEnvelope(badCharacter), MlsEngineErrorCode.STATE_CORRUPT);
    await expectCode(
      () => decodeStateEnvelope(encoded.slice(0, 5)),
      MlsEngineErrorCode.STATE_CORRUPT,
    );
    await expectCode(() => decodeStateEnvelope(new Uint8Array()), MlsEngineErrorCode.STATE_CORRUPT);
  });

  it('checks the size cap before reading anything', async () => {
    await expectCode(
      () => decodeStateEnvelope(new Uint8Array(MAX_STATE_BYTES + 1)),
      MlsEngineErrorCode.DECODE_TOO_LARGE,
    );
  });

  it('refuses to write an invalid id instead of storing it', async () => {
    await expectCode(
      () => encodeStateEnvelope({ ...envelope, conversationId: 'not valid' }),
      MlsEngineErrorCode.INVALID_ARGUMENT,
    );
    await expectCode(
      () =>
        encodeStateEnvelope({
          ...envelope,
          listPins: new Map([['x'.repeat(MAX_ID_BYTES + 1), 1]]),
        }),
      MlsEngineErrorCode.INVALID_ARGUMENT,
    );
  });
});

describe('pending commit (a commit we posted, kept until the relay answers)', () => {
  const pending = { commitHash: filled(SHA256_BYTES, 5), nextState: filled(400, 6) };

  it('round-trips', () => {
    expect(decodePendingCommitEnvelope(encodePendingCommitEnvelope(pending))).toEqual(pending);
  });

  it('is versioned: another version is unsupported, not corrupt', async () => {
    const encoded = encodePendingCommitEnvelope(pending);
    expect(encoded[0]).toBe(PENDING_COMMIT_FORMAT_VERSION);
    await expectCode(
      () => decodePendingCommitEnvelope(withFirstByte(encoded, PENDING_COMMIT_FORMAT_VERSION + 1)),
      MlsEngineErrorCode.STATE_VERSION_UNSUPPORTED,
    );
  });

  it('refuses truncation, an empty or oversized hash, a missing state and an oversized buffer', async () => {
    const encoded = encodePendingCommitEnvelope(pending);
    const headerBytes = 1 + 2 + SHA256_BYTES;
    for (let length = 0; length <= headerBytes; length += 1) {
      await expectCode(
        () => decodePendingCommitEnvelope(encoded.slice(0, length)),
        MlsEngineErrorCode.STATE_CORRUPT,
      );
    }
    await expectCode(
      () =>
        decodePendingCommitEnvelope(
          encodePendingCommitEnvelope({ ...pending, commitHash: new Uint8Array() }),
        ),
      MlsEngineErrorCode.STATE_CORRUPT,
    );
    await expectCode(
      () =>
        decodePendingCommitEnvelope(
          encodePendingCommitEnvelope({
            ...pending,
            commitHash: filled(LONGEST_MLS_HASH_BYTES + 1, 1),
          }),
        ),
      MlsEngineErrorCode.STATE_CORRUPT,
    );
    await expectCode(
      () => decodePendingCommitEnvelope(new Uint8Array(MAX_STATE_BYTES + OVER_U16)),
      MlsEngineErrorCode.DECODE_TOO_LARGE,
    );
  });
});
