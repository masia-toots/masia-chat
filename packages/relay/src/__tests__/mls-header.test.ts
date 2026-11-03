import { describe, expect, it } from 'vitest';
import { MAX_GROUP_ID_BYTES } from '../index.js';
import {
  MAX_MLS_HEADER_INPUT_BYTES,
  MlsContentType,
  MlsHeaderError,
  MlsHeaderErrorReason,
  type MlsHeader,
  MlsSenderType,
  MlsWireFormat,
  MAX_KEY_PACKAGE_INPUT_BYTES,
  parseKeyPackageLifetime,
  parseMlsHeader,
} from '../index.js';
import {
  buildKeyPackage,
  buildPrivateMessage,
  buildPrivateMessageOfSize,
  buildPublicMessage,
  buildWelcome,
  encodeLength,
  uint16,
  uint32,
  uint64,
  vector,
} from '../testing/mls-messages.js';

// A plain Uint8Array, like what the parser returns: a Node Buffer is not `toEqual` to one.
const GROUP = new Uint8Array([0x67, 0x72, 0x70, 0x31]); // "grp1"
const hex = (text: string): Buffer => Buffer.from(text.replaceAll(' ', ''), 'hex');

function failureOf(bytes: Uint8Array): MlsHeaderError {
  try {
    parseMlsHeader(bytes);
  } catch (error) {
    if (error instanceof MlsHeaderError) return error;
    throw error;
  }
  throw new Error('expected parseMlsHeader to throw');
}

function expectFailure(bytes: Uint8Array, reason: MlsHeaderErrorReason, field: string): void {
  const error = failureOf(bytes);
  expect({ reason: error.reason, field: error.field }).toEqual({ reason, field });
}

describe('parseMlsHeader — literal RFC 9420 byte vectors', () => {
  // Written out by hand from RFC 9420 §6 and §2.1.2, not produced by the test encoders.
  it('reads a PrivateMessage carrying an application message', () => {
    //   version=1 | wire_format=2 | group_id<V>=len 4 "grp1" | epoch=7 | content_type=1 | …
    const header = parseMlsHeader(hex('0001 0002 04 67727031 0000000000000007 01 00'));
    expect(header).toEqual({
      wireFormat: MlsWireFormat.PRIVATE_MESSAGE,
      groupId: GROUP,
      epoch: 7n,
      contentType: MlsContentType.APPLICATION,
    });
  });

  it('reads a PublicMessage carrying a commit from a member', () => {
    //   … | sender_type=1 (member) | leaf_index=3 | authenticated_data<V>=empty | content_type=3
    const header = parseMlsHeader(hex('0001 0001 04 67727031 000000000000000a 01 00000003 00 03'));
    expect(header).toEqual({
      wireFormat: MlsWireFormat.PUBLIC_MESSAGE,
      groupId: GROUP,
      epoch: 10n,
      contentType: MlsContentType.COMMIT,
      sender: { type: MlsSenderType.MEMBER, index: 3 },
    });
  });

  it('reads a PublicMessage from a new_member_commit sender, which has no body, and skips authenticated_data', () => {
    const header = parseMlsHeader(hex('0001 0001 04 67727031 0000000000000001 04 02 aabb 03'));
    expect(header).toMatchObject({
      sender: { type: MlsSenderType.NEW_MEMBER_COMMIT },
      contentType: MlsContentType.COMMIT,
      epoch: 1n,
    });
    expect((header as { sender: { index?: number } }).sender.index).toBeUndefined();
  });

  it('reads a group id whose length needs the two-byte form (64 bytes: 0x40 0x40)', () => {
    const groupId = new Uint8Array(64).fill(0xab);
    const header = parseMlsHeader(
      Buffer.concat([hex('0001 0002 4040'), groupId, hex('0000000000000000 02')]),
    );
    expect(header).toMatchObject({ groupId, epoch: 0n, contentType: MlsContentType.PROPOSAL });
  });

  it('reads a Welcome: cipher suite, then a well-formed secrets vector', () => {
    //   version=1 | wire_format=3 | cipher_suite=1 | secrets<V>=len 3 | …
    expect(parseMlsHeader(hex('0001 0003 0001 03 010203 00'))).toEqual({
      wireFormat: MlsWireFormat.WELCOME,
      cipherSuite: 1,
    });
  });

  it('recognises a GroupInfo by its wire format, and reads a KeyPackage version and cipher suite', () => {
    // One parser for engine and relay since 2026-10-10: the KeyPackage branch reads what the engine
    // read (the inner version and the suite), so the relay now refuses a truncated one too.
    expect(parseMlsHeader(hex('0001 0004'))).toEqual({ wireFormat: MlsWireFormat.GROUP_INFO });
    expect(parseMlsHeader(hex('0001 0005 0001 0001 ff'))).toEqual({
      wireFormat: MlsWireFormat.KEY_PACKAGE,
      cipherSuite: 1,
    });
    expectFailure(hex('0001 0005 ff'), MlsHeaderErrorReason.TRUNCATED, 'version');
  });
});

describe('parseMlsHeader — every branch, built with the test encoders', () => {
  it.each([
    ['application', MlsContentType.APPLICATION],
    ['proposal', MlsContentType.PROPOSAL],
    ['commit', MlsContentType.COMMIT],
  ])('reads the %s content type of a PrivateMessage', (_label, contentType) => {
    const header = parseMlsHeader(buildPrivateMessage({ groupId: GROUP, epoch: 3, contentType }));
    expect(header).toMatchObject({ wireFormat: MlsWireFormat.PRIVATE_MESSAGE, contentType });
  });

  it.each([
    ['member', { type: MlsSenderType.MEMBER, index: 9 }],
    ['external', { type: MlsSenderType.EXTERNAL, index: 2 }],
    ['new_member_proposal', { type: MlsSenderType.NEW_MEMBER_PROPOSAL }],
    ['new_member_commit', { type: MlsSenderType.NEW_MEMBER_COMMIT }],
  ])('reads a PublicMessage from a %s sender', (_label, sender) => {
    const header = parseMlsHeader(
      buildPublicMessage({
        groupId: GROUP,
        epoch: 4,
        contentType: MlsContentType.PROPOSAL,
        sender,
      }),
    );
    expect(header).toMatchObject({
      wireFormat: MlsWireFormat.PUBLIC_MESSAGE,
      sender,
      contentType: MlsContentType.PROPOSAL,
    });
  });

  it.each([
    ['a one-byte length', 5],
    ['a two-byte length', 100],
    ['a four-byte length', 20_000],
  ])('steps over authenticated_data with %s', (_label, size) => {
    const header = parseMlsHeader(
      buildPublicMessage({
        groupId: GROUP,
        epoch: 1,
        contentType: MlsContentType.COMMIT,
        authenticatedData: Buffer.alloc(size, 7),
      }),
    );
    expect(header).toMatchObject({ contentType: MlsContentType.COMMIT });
  });

  it.each([
    ['zero', 0n],
    ['one past a 32-bit word', 2n ** 32n],
    ['the largest uint64', 2n ** 64n - 1n],
  ])('reads an epoch of %s without losing precision', (_label, epoch) => {
    const header = parseMlsHeader(
      buildPrivateMessage({ groupId: GROUP, epoch, contentType: MlsContentType.COMMIT }),
    );
    expect((header as { epoch: bigint }).epoch).toBe(epoch);
  });

  it('reads the largest group id the relay stores (a 256-byte group id needs the two-byte length form)', () => {
    const groupId = new Uint8Array(MAX_GROUP_ID_BYTES).fill(3);
    const header = parseMlsHeader(
      buildPrivateMessage({ groupId, epoch: 0, contentType: MlsContentType.COMMIT }),
    );
    expect((header as { groupId: Uint8Array }).groupId).toEqual(groupId);
  });

  it('copies the group id out of the input, so the caller may release the message', () => {
    const message = buildPrivateMessage({
      groupId: GROUP,
      epoch: 0,
      contentType: MlsContentType.COMMIT,
    });
    const header = parseMlsHeader(message) as { groupId: Uint8Array };
    message.fill(0);
    expect(header.groupId).toEqual(GROUP);
  });

  it('reads a Welcome whatever its cipher suite is, and does not need the rest of it', () => {
    expect(parseMlsHeader(buildWelcome({ cipherSuite: 3 }))).toEqual({
      wireFormat: MlsWireFormat.WELCOME,
      cipherSuite: 3,
    });
  });

  it('builds a PrivateMessage of exactly the requested size, across the length-prefix boundaries', () => {
    for (const size of [60, 100, 16_000, 16_500, 65_536, MAX_MLS_HEADER_INPUT_BYTES]) {
      const message = buildPrivateMessageOfSize(
        { groupId: GROUP, epoch: 1, contentType: MlsContentType.APPLICATION },
        size,
      );
      expect(message.length).toBe(size);
      expect(parseMlsHeader(message)).toMatchObject({ contentType: MlsContentType.APPLICATION });
    }
  });
});

describe('parseMlsHeader — refusals', () => {
  const valid = buildPrivateMessage({
    groupId: GROUP,
    epoch: 5,
    contentType: MlsContentType.COMMIT,
  });

  it('refuses an empty message and every cut of a PrivateMessage before its content type', () => {
    // version(2) + wire_format(2) + group_id(1+4) + epoch(8) + content_type(1) = 18 bytes of header.
    const headerLength = 18;
    for (let length = 0; length < headerLength; length += 1) {
      expect(failureOf(valid.subarray(0, length)).reason, `cut at ${length}`).toBe(
        MlsHeaderErrorReason.TRUNCATED,
      );
    }
    expect(() => parseMlsHeader(valid.subarray(0, headerLength))).not.toThrow();
  });

  it('names the part being read when the message ends', () => {
    expectFailure(hex('0001'), MlsHeaderErrorReason.TRUNCATED, 'wireFormat');
    expectFailure(hex('0001 0002'), MlsHeaderErrorReason.TRUNCATED, 'groupId');
    expectFailure(hex('0001 0002 04 6772'), MlsHeaderErrorReason.TRUNCATED, 'groupId');
    expectFailure(hex('0001 0002 04 67727031 0000'), MlsHeaderErrorReason.TRUNCATED, 'epoch');
    expectFailure(
      hex('0001 0002 04 67727031 0000000000000001'),
      MlsHeaderErrorReason.TRUNCATED,
      'contentType',
    );
    expectFailure(
      hex('0001 0001 04 67727031 0000000000000001'),
      MlsHeaderErrorReason.TRUNCATED,
      'sender',
    );
    expectFailure(
      hex('0001 0001 04 67727031 0000000000000001 01 0000'),
      MlsHeaderErrorReason.TRUNCATED,
      'sender',
    );
    expectFailure(
      hex('0001 0001 04 67727031 0000000000000001 04'),
      MlsHeaderErrorReason.TRUNCATED,
      'authenticatedData',
    );
    expectFailure(hex('0001 0003'), MlsHeaderErrorReason.TRUNCATED, 'cipherSuite');
    expectFailure(hex('0001 0003 0001'), MlsHeaderErrorReason.TRUNCATED, 'secrets');
  });

  it.each([0, 2, 0xff, 0xffff])('refuses protocol version %i (only mls10 = 1)', (version) => {
    expectFailure(
      Buffer.concat([uint16(version), valid.subarray(2)]),
      MlsHeaderErrorReason.UNSUPPORTED_VERSION,
      'version',
    );
  });

  it.each([0, 6, 7, 0x100, 0xffff])('refuses wire format %i', (wireFormat) => {
    expectFailure(
      Buffer.concat([uint16(1), uint16(wireFormat)]),
      MlsHeaderErrorReason.UNKNOWN_WIRE_FORMAT,
      'wireFormat',
    );
  });

  it.each([0, 5, 0xff])('refuses sender type %i', (senderType) => {
    const message = Buffer.concat([
      hex('0001 0001 04 67727031'),
      uint64(1n),
      Buffer.from([senderType]),
      uint32(0),
      vector(Buffer.alloc(0)),
      Buffer.from([3]),
    ]);
    expectFailure(message, MlsHeaderErrorReason.UNKNOWN_SENDER_TYPE, 'sender');
  });

  it.each([0, 4, 0xff])('refuses content type %i (0 is reserved)', (contentType) => {
    expectFailure(
      buildPrivateMessage({ groupId: GROUP, epoch: 0, contentType }),
      MlsHeaderErrorReason.UNKNOWN_CONTENT_TYPE,
      'contentType',
    );
    expectFailure(
      buildPublicMessage({ groupId: GROUP, epoch: 0, contentType }),
      MlsHeaderErrorReason.UNKNOWN_CONTENT_TYPE,
      'contentType',
    );
  });

  it('refuses a group id longer than the relay stores, before reading it', () => {
    const tooLong = Buffer.concat([
      hex('0001 0002'),
      encodeLength(MAX_GROUP_ID_BYTES + 1),
      Buffer.alloc(MAX_GROUP_ID_BYTES + 1),
    ]);
    expectFailure(tooLong, MlsHeaderErrorReason.VECTOR_TOO_LONG, 'groupId');
  });

  it('refuses the reserved 0b11 length prefix', () => {
    expectFailure(
      hex('0001 0002 c0 00000000'),
      MlsHeaderErrorReason.INVALID_LENGTH_PREFIX,
      'groupId',
    );
  });

  it('refuses a length that is not in its shortest form (RFC 9420 §2.1.2)', () => {
    expectFailure(
      hex('0001 0002 4004 67727031'),
      MlsHeaderErrorReason.NON_MINIMAL_LENGTH,
      'groupId',
    ); // 4 as two bytes
    expectFailure(
      hex('0001 0002 8000 0004 67727031'),
      MlsHeaderErrorReason.NON_MINIMAL_LENGTH,
      'groupId',
    ); // 4 as four bytes
    expectFailure(
      hex('0001 0002 8000 0100 00'),
      MlsHeaderErrorReason.NON_MINIMAL_LENGTH,
      'groupId',
    ); // 256 as four bytes
  });

  it('refuses a length that claims more than the message holds, without reading or allocating that much', () => {
    // A four-byte length of 1 GiB - 1 in authenticated_data of a 30-byte message.
    const claimed = Buffer.concat([
      hex('0001 0001 04 67727031 0000000000000001 04'),
      hex('bfffffff'),
      Buffer.alloc(8),
    ]);
    expectFailure(claimed, MlsHeaderErrorReason.TRUNCATED, 'authenticatedData');
    expectFailure(
      Buffer.concat([hex('0001 0003 0001'), hex('bfffffff'), Buffer.alloc(8)]),
      MlsHeaderErrorReason.TRUNCATED,
      'secrets',
    );
  });

  it('refuses an input over the size cap before reading it', () => {
    expectFailure(
      Buffer.alloc(MAX_MLS_HEADER_INPUT_BYTES + 1),
      MlsHeaderErrorReason.TOO_LARGE,
      'message',
    );
  });

  it('is an Error with a name and a stable reason', () => {
    const error = failureOf(Buffer.alloc(0));
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('MlsHeaderError');
    expect(error.reason).toBe(MlsHeaderErrorReason.TRUNCATED);
  });
});

/** A small deterministic PRNG (mulberry32), so a failing fuzz case can be replayed. */
function prng(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Parses; passes if it returns a header or throws `MlsHeaderError`, fails on anything else. */
function parsesOrRefusesCleanly(bytes: Uint8Array): MlsHeader | MlsHeaderError {
  try {
    return parseMlsHeader(bytes);
  } catch (error) {
    expect(error, `input ${Buffer.from(bytes).toString('hex')}`).toBeInstanceOf(MlsHeaderError);
    return error as MlsHeaderError;
  }
}

describe('parseMlsHeader — fuzz-ish: nothing but MlsHeaderError ever escapes', () => {
  const ROUNDS = 4000;

  it('survives uniformly random bytes of every small length', () => {
    const random = prng(0xc0ffee);
    for (let round = 0; round < ROUNDS; round += 1) {
      const bytes = Buffer.from(
        Array.from({ length: Math.floor(random() * 64) }, () => Math.floor(random() * 256)),
      );
      parsesOrRefusesCleanly(bytes);
    }
  });

  it('survives random bytes that start like a real message, so the parser gets past the prefix', () => {
    const random = prng(0xbadf00d);
    const wireFormats = [1, 2, 3, 4, 5];
    for (let round = 0; round < ROUNDS; round += 1) {
      const wire = wireFormats[Math.floor(random() * wireFormats.length)] ?? 1;
      const tail = Array.from({ length: Math.floor(random() * 48) }, () =>
        Math.floor(random() * 256),
      );
      parsesOrRefusesCleanly(Buffer.concat([uint16(1), uint16(wire), Buffer.from(tail)]));
    }
  });

  it('survives a valid message with one random byte changed, and with every possible cut', () => {
    const random = prng(0x5eed);
    const samples = [
      buildPrivateMessage({ groupId: GROUP, epoch: 99, contentType: MlsContentType.COMMIT }),
      buildPublicMessage({
        groupId: GROUP,
        epoch: 99,
        contentType: MlsContentType.PROPOSAL,
        authenticatedData: Buffer.alloc(70, 1),
      }),
      buildWelcome(),
    ];
    for (const sample of samples) {
      for (let cut = 0; cut <= sample.length; cut += 1)
        parsesOrRefusesCleanly(sample.subarray(0, cut));
      for (let round = 0; round < ROUNDS / samples.length; round += 1) {
        const mutated = Buffer.from(sample);
        mutated[Math.floor(random() * mutated.length)] = Math.floor(random() * 256);
        parsesOrRefusesCleanly(mutated);
      }
    }
  });

  it('survives a length prefix at every value of its first byte', () => {
    for (let first = 0; first < 256; first += 1) {
      parsesOrRefusesCleanly(
        Buffer.concat([
          uint16(1),
          uint16(2),
          Buffer.from([first, 0xff, 0xff, 0xff, 0xff]),
          Buffer.alloc(16),
        ]),
      );
    }
  });
});

describe('parseKeyPackageLifetime', () => {
  function lifetimeFailure(bytes: Uint8Array): MlsHeaderError {
    try {
      parseKeyPackageLifetime(bytes);
    } catch (error) {
      expect(error, `input ${Buffer.from(bytes).toString('hex')}`).toBeInstanceOf(MlsHeaderError);
      return error as MlsHeaderError;
    }
    throw new Error('expected parseKeyPackageLifetime to throw');
  }

  it('reads not_before and not_after from a KeyPackage MLSMessage', () => {
    const bytes = buildKeyPackage({ notBefore: 1_000, notAfter: 2_000_000_000 });
    expect(parseKeyPackageLifetime(bytes)).toEqual({ notBefore: 1_000n, notAfter: 2_000_000_000n });
  });

  it('reads past an x509 credential as well as a basic one', () => {
    const bytes = buildKeyPackage({ notAfter: 5, notBefore: 1, credentialType: 2 });
    expect(parseKeyPackageLifetime(bytes)).toEqual({ notBefore: 1n, notAfter: 5n });
  });

  it('refuses a message that is not a KeyPackage', () => {
    const error = lifetimeFailure(buildWelcome());
    expect({ reason: error.reason, field: error.field }).toEqual({
      reason: MlsHeaderErrorReason.NOT_A_KEY_PACKAGE,
      field: 'wireFormat',
    });
  });

  it('refuses a credential type whose body it cannot step over', () => {
    expect(lifetimeFailure(buildKeyPackage({ credentialType: 0xf000 })).reason).toBe(
      MlsHeaderErrorReason.UNKNOWN_CREDENTIAL_TYPE,
    );
  });

  it('refuses a leaf that is not a key_package leaf (it would carry no lifetime)', () => {
    expect(lifetimeFailure(buildKeyPackage({ leafNodeSource: 2 })).reason).toBe(
      MlsHeaderErrorReason.NOT_A_KEY_PACKAGE_LEAF,
    );
  });

  it('refuses every cut before the end of the lifetime, naming the part being read', () => {
    const whole = buildKeyPackage({ notAfter: 9 });
    // The lifetime's last byte sits before leaf extensions, leaf signature, extensions, signature.
    const tail = 1 + (1 + 'leaf-signature'.length) + 1 + (1 + 'key-package-signature'.length);
    const lifetimeEnd = whole.length - tail;
    for (let cut = 0; cut < lifetimeEnd; cut += 1) {
      expect(lifetimeFailure(whole.subarray(0, cut)).reason).not.toBe(undefined);
    }
    expect(lifetimeFailure(whole.subarray(0, lifetimeEnd - 1)).field).toBe('lifetime');
    expect(parseKeyPackageLifetime(whole.subarray(0, lifetimeEnd)).notAfter).toBe(9n);
  });

  it('refuses an input over the key-package size cap before reading it', () => {
    expect(lifetimeFailure(Buffer.alloc(MAX_KEY_PACKAGE_INPUT_BYTES + 1)).reason).toBe(
      MlsHeaderErrorReason.TOO_LARGE,
    );
  });

  it('lets nothing but MlsHeaderError escape for a mutated package', () => {
    const random = prng(0x6b70);
    const sample = buildKeyPackage();
    for (let round = 0; round < 2000; round += 1) {
      const mutated = Buffer.from(sample);
      mutated[Math.floor(random() * mutated.length)] = Math.floor(random() * 256);
      try {
        parseKeyPackageLifetime(mutated);
      } catch (error) {
        expect(error).toBeInstanceOf(MlsHeaderError);
      }
    }
  });
});
