import { describe, expect, it } from 'vitest';
import { MAX_GROUP_ID_BYTES } from '../constants.js';
import { MlsContentType, MlsSenderType, MlsWireFormat, parseMlsHeader } from '../message-header.js';
import { MlsEngineErrorCode } from '../mls-error.js';
import { expectCode } from './support/expect-code.js';

/** Tiny hand-built MLSMessage prefixes: the parser is tested against the RFC's layout, not against the library's encoder. */

const CAP = 1024;
const SUITE = 1;
const VERSION = 1;

const u16 = (value: number) => [(value >> 8) & 0xff, value & 0xff];
const u32 = (value: number) => [...u16(value >>> 16), ...u16(value & 0xffff)];
const u64 = (value: number) => [...u32(0), ...u32(value)];
/** A vector with the smallest valid length prefix (RFC 9420 §2.1.2). */
function vec(content: readonly number[]): number[] {
  const n = content.length;
  if (n <= 0x3f) return [n, ...content];
  if (n <= 0x3fff) return [0x40 | (n >> 8), n & 0xff, ...content];
  return [0x80 | (n >> 24), (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff, ...content];
}
const bytes = (...parts: (readonly number[])[]) => Uint8Array.from(parts.flat());
const range = (length: number) => Array.from({ length }, (_, i) => (i * 7) & 0xff);

const privateMessage = (
  groupId: readonly number[] = range(32),
  epoch = 5,
  contentType: number = MlsContentType.COMMIT,
) =>
  bytes(
    u16(VERSION),
    u16(MlsWireFormat.PRIVATE_MESSAGE),
    vec(groupId),
    u64(epoch),
    [contentType],
    vec(range(10)),
  );

describe('parseMlsHeader (review §1: size-capped, never trusts a claimed length)', () => {
  it('reads a PrivateMessage', () => {
    const header = parseMlsHeader(privateMessage(range(32), 5), CAP);
    expect(header).toMatchObject({
      wireFormat: MlsWireFormat.PRIVATE_MESSAGE,
      epoch: 5n,
      contentType: MlsContentType.COMMIT,
    });
    if (header.wireFormat !== MlsWireFormat.PRIVATE_MESSAGE) throw new Error('wrong kind');
    expect(Array.from(header.groupId)).toEqual(range(32));
  });

  it('keeps a 64-bit epoch exact', () => {
    const message = bytes(
      u16(VERSION),
      u16(MlsWireFormat.PRIVATE_MESSAGE),
      vec([1]),
      u32(0xffffffff),
      u32(0xfffffffe),
      [MlsContentType.APPLICATION],
    );
    const header = parseMlsHeader(message, CAP);
    if (header.wireFormat !== MlsWireFormat.PRIVATE_MESSAGE) throw new Error('wrong kind');
    expect(header.epoch).toBe(0xfffffffffffffffen);
  });

  it('reads a PublicMessage with its sender, skipping the authenticated data', () => {
    const message = bytes(
      u16(VERSION),
      u16(MlsWireFormat.PUBLIC_MESSAGE),
      vec(range(8)),
      u64(9),
      [MlsSenderType.MEMBER],
      u32(3),
      vec(range(20)),
      [MlsContentType.PROPOSAL],
      vec([]),
    );
    expect(parseMlsHeader(message, CAP)).toMatchObject({
      wireFormat: MlsWireFormat.PUBLIC_MESSAGE,
      epoch: 9n,
      sender: { type: MlsSenderType.MEMBER, index: 3 },
      contentType: MlsContentType.PROPOSAL,
    });
  });

  it('reads the four sender types of a PublicMessage', () => {
    const withSender = (sender: readonly number[]) =>
      bytes(u16(VERSION), u16(MlsWireFormat.PUBLIC_MESSAGE), vec([1]), u64(1), sender, vec([]), [
        MlsContentType.COMMIT,
      ]);
    expect(parseMlsHeader(withSender([MlsSenderType.EXTERNAL, ...u32(2)]), CAP)).toMatchObject({
      sender: { type: MlsSenderType.EXTERNAL, index: 2 },
    });
    expect(parseMlsHeader(withSender([MlsSenderType.NEW_MEMBER_PROPOSAL]), CAP)).toMatchObject({
      sender: { type: MlsSenderType.NEW_MEMBER_PROPOSAL },
    });
    expect(parseMlsHeader(withSender([MlsSenderType.NEW_MEMBER_COMMIT]), CAP)).toMatchObject({
      sender: { type: MlsSenderType.NEW_MEMBER_COMMIT },
    });
  });

  it('reads a Welcome, a KeyPackage and a GroupInfo', () => {
    expect(
      parseMlsHeader(
        bytes(u16(VERSION), u16(MlsWireFormat.WELCOME), u16(SUITE), vec(range(5))),
        CAP,
      ),
    ).toEqual({
      wireFormat: MlsWireFormat.WELCOME,
      cipherSuite: SUITE,
    });
    expect(
      parseMlsHeader(
        bytes(u16(VERSION), u16(MlsWireFormat.KEY_PACKAGE), u16(VERSION), u16(SUITE), range(10)),
        CAP,
      ),
    ).toEqual({
      wireFormat: MlsWireFormat.KEY_PACKAGE,
      cipherSuite: SUITE,
    });
    expect(
      parseMlsHeader(bytes(u16(VERSION), u16(MlsWireFormat.GROUP_INFO), range(10)), CAP),
    ).toEqual({
      wireFormat: MlsWireFormat.GROUP_INFO,
    });
  });

  it('reads vectors with 2-byte and 4-byte length prefixes', () => {
    const twoByte = bytes(u16(VERSION), u16(MlsWireFormat.WELCOME), u16(SUITE), vec(range(200)));
    expect(parseMlsHeader(twoByte, CAP)).toMatchObject({ cipherSuite: SUITE });
    const fourByte = bytes(u16(VERSION), u16(MlsWireFormat.WELCOME), u16(SUITE), vec(range(20000)));
    expect(parseMlsHeader(fourByte, 64 * 1024)).toMatchObject({ cipherSuite: SUITE });
  });

  it('checks the cap first, on the length alone', async () => {
    await expectCode(
      () => parseMlsHeader(new Uint8Array(CAP + 1), CAP),
      MlsEngineErrorCode.DECODE_TOO_LARGE,
    );
    await expectCode(
      () => parseMlsHeader(privateMessage(), 5),
      MlsEngineErrorCode.DECODE_TOO_LARGE,
    );
    // At the cap, a zero-filled buffer is read, and found to be the wrong version.
    await expectCode(
      () => parseMlsHeader(new Uint8Array(CAP), CAP),
      MlsEngineErrorCode.SUITE_NOT_PINNED,
    );
  });

  it('refuses another protocol version', async () => {
    for (const version of [0, 2, 0xffff]) {
      await expectCode(
        () =>
          parseMlsHeader(
            bytes(u16(version), u16(MlsWireFormat.PRIVATE_MESSAGE), vec([1]), u64(1), [
              MlsContentType.COMMIT,
            ]),
            CAP,
          ),
        MlsEngineErrorCode.SUITE_NOT_PINNED,
      );
    }
    await expectCode(
      () =>
        parseMlsHeader(
          bytes(u16(VERSION), u16(MlsWireFormat.KEY_PACKAGE), u16(2), u16(SUITE)),
          CAP,
        ),
      MlsEngineErrorCode.SUITE_NOT_PINNED,
    );
  });

  it('refuses reserved and unknown wire formats, content types and sender types', async () => {
    for (const wireFormat of [0, 6, 0xffff]) {
      await expectCode(
        () => parseMlsHeader(bytes(u16(VERSION), u16(wireFormat), range(16)), CAP),
        MlsEngineErrorCode.MALFORMED_MESSAGE,
      );
    }
    for (const contentType of [0, 4, 0xff]) {
      await expectCode(
        () => parseMlsHeader(privateMessage(range(8), 1, contentType), CAP),
        MlsEngineErrorCode.MALFORMED_MESSAGE,
      );
    }
    for (const sender of [0, 5, 0xff]) {
      const message = bytes(
        u16(VERSION),
        u16(MlsWireFormat.PUBLIC_MESSAGE),
        vec([1]),
        u64(1),
        [sender, ...u32(0)],
        vec([]),
        [MlsContentType.COMMIT],
      );
      await expectCode(() => parseMlsHeader(message, CAP), MlsEngineErrorCode.MALFORMED_MESSAGE);
    }
  });

  it('refuses non-minimal and invalid length prefixes (RFC 9420 §2.1.2)', async () => {
    const withGroupIdPrefix = (prefix: readonly number[], rest: readonly number[]) =>
      bytes(u16(VERSION), u16(MlsWireFormat.PRIVATE_MESSAGE), prefix, rest, u64(1), [
        MlsContentType.COMMIT,
      ]);
    // 5 written in two bytes, and 100 written in four.
    await expectCode(
      () => parseMlsHeader(withGroupIdPrefix([0x40, 0x05], range(5)), CAP),
      MlsEngineErrorCode.MALFORMED_MESSAGE,
    );
    await expectCode(
      () => parseMlsHeader(withGroupIdPrefix([0x80, 0, 0, 100], range(100)), CAP),
      MlsEngineErrorCode.MALFORMED_MESSAGE,
    );
    // Prefix 0b11 is invalid.
    await expectCode(
      () => parseMlsHeader(withGroupIdPrefix([0xc0], range(5)), CAP),
      MlsEngineErrorCode.MALFORMED_MESSAGE,
    );
  });

  it('never trusts a claimed length: past the end, or over the group id cap', async () => {
    // Claims 2^30 - 1 bytes, has 8.
    const claimsHuge = bytes(
      u16(VERSION),
      u16(MlsWireFormat.PRIVATE_MESSAGE),
      [0xbf, 0xff, 0xff, 0xff],
      range(8),
    );
    await expectCode(() => parseMlsHeader(claimsHuge, CAP), MlsEngineErrorCode.MALFORMED_MESSAGE);
    await expectCode(
      () => parseMlsHeader(privateMessage(range(MAX_GROUP_ID_BYTES + 1)), CAP),
      MlsEngineErrorCode.MALFORMED_MESSAGE,
    );
    expect(parseMlsHeader(privateMessage(range(MAX_GROUP_ID_BYTES)), CAP)).toMatchObject({
      epoch: 5n,
    });
  });

  it('every truncation of a valid message is MALFORMED_MESSAGE, never another error', async () => {
    const full = bytes(
      u16(VERSION),
      u16(MlsWireFormat.PUBLIC_MESSAGE),
      vec(range(16)),
      u64(7),
      [MlsSenderType.MEMBER],
      u32(1),
      vec(range(9)),
      [MlsContentType.COMMIT],
    );
    for (let length = 0; length < full.length; length += 1) {
      await expectCode(
        () => parseMlsHeader(full.slice(0, length), CAP),
        MlsEngineErrorCode.MALFORMED_MESSAGE,
      );
    }
    expect(parseMlsHeader(full, CAP)).toMatchObject({ epoch: 7n });
  });

  it('returns copies: changing the input afterwards does not change the group id read from it', () => {
    const message = privateMessage(range(8));
    const header = parseMlsHeader(message, CAP);
    if (header.wireFormat !== MlsWireFormat.PRIVATE_MESSAGE) throw new Error('wrong kind');
    const before = Array.from(header.groupId);
    message.fill(0xff);
    expect(Array.from(header.groupId)).toEqual(before);
  });
});
