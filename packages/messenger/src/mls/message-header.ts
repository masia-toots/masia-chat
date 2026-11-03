import {
  MlsHeaderError,
  MlsHeaderErrorReason,
  parseMlsHeader as parseWireHeader,
  type MlsHeader,
} from '@masia/contracts/wire';
import { fail, MlsEngineErrorCode } from './mls-error.js';

/**
 * The cleartext header of an MLSMessage (RFC 9420 §6), read WITHOUT the library and without any
 * cryptography. The engine uses it to refuse a message on the raw bytes before ts-mls decodes a
 * single field.
 *
 * The parser itself is wire vocabulary with ONE home, `@masia/contracts/wire`, which the relay uses
 * too, so engine and relay read every header the same way by construction. Until 2026-10-10 this
 * file was a "deliberate minimal copy" of the relay's parser, held to it by a parity test
 * (architecture review round 1, M14). What is left here is the engine's error mapping.
 */

export {
  MlsContentType,
  MlsSenderType,
  MlsWireFormat,
  type MlsFramedHeader,
  type MlsGroupInfoHeader,
  type MlsHeader,
  type MlsKeyPackageHeader,
  type MlsSender,
  type MlsWelcomeHeader,
} from '@masia/contracts/wire';

/**
 * Reads the header of an MLSMessage (see `parseMlsHeader` in `@masia/contracts/wire` for the
 * layout). `maxBytes` is the cap for the kind of message the caller expects; it is checked first.
 * Throws `MlsEngineError` and nothing else, for any input at all:
 *
 * - over the cap: `DECODE_TOO_LARGE`;
 * - not MLS 1.0 (the message, or the KeyPackage inside it): `SUITE_NOT_PINNED`;
 * - anything else unreadable: `MALFORMED_MESSAGE`.
 */
export function parseMlsHeader(bytes: Uint8Array, maxBytes: number): MlsHeader {
  try {
    return parseWireHeader(bytes, maxBytes);
  } catch (error) {
    if (!(error instanceof MlsHeaderError)) {
      throw fail(MlsEngineErrorCode.MALFORMED_MESSAGE, 'Unreadable MLSMessage header.');
    }
    switch (error.reason) {
      case MlsHeaderErrorReason.TOO_LARGE:
        throw fail(MlsEngineErrorCode.DECODE_TOO_LARGE, error.message);
      case MlsHeaderErrorReason.UNSUPPORTED_VERSION:
        throw fail(MlsEngineErrorCode.SUITE_NOT_PINNED, 'The message is not MLS 1.0.');
      default:
        throw fail(
          MlsEngineErrorCode.MALFORMED_MESSAGE,
          `Unreadable MLSMessage header (${error.reason} at ${error.field}).`,
        );
    }
  }
}
