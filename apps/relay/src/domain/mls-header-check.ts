import {
  HandshakeKind,
  MlsContentType,
  MlsHeaderError,
  type MlsFramedHeader,
  type MlsHeader,
  type MlsHeaderField,
  MlsSenderType,
  MlsWireFormat,
  parseMlsHeader,
  RelayError,
  RelayErrorCode,
} from '@masia/relay';

/**
 * The relay's check of the CLEARTEXT header of an MLSMessage, with no cryptography (security review
 * 2026-10-10 §4, "Relay design"). RFC 9420 keeps `group_id`, `epoch` and `content_type` in the
 * clear even in a PrivateMessage, so the relay can insist that what a member posts as "a commit
 * for epoch N of this room" at least LOOKS like one. It proves nothing about the content (only the
 * clients can); it stops a stalled room being one cheap request away: without it any member could
 * post garbage, the relay would advance its epoch counter, every client would reject the commit,
 * and every honest commit after that would get 409 for ever.
 *
 * Each check throws `MLS_HEADER_MISMATCH` (422) and NAMES the field, so a client bug is findable.
 * They run inside the serializer's transaction after the membership and epoch checks: a stranger
 * learns nothing about a room's group id, and an honest-but-stale commit still gets its 409.
 */

/** What the relay knows about the room the message is posted to. */
export interface RoomHeaderFacts {
  readonly groupId: Buffer;
  /** The room's current epoch. The serializer has already proved the sender built on exactly it. */
  readonly epoch: number;
}

/** The message kinds that carry group traffic, and the MLS content type each must have. */
type FramedKind = typeof HandshakeKind.COMMIT | 'APPLICATION';

const EXPECTED_CONTENT_TYPE: Readonly<Record<FramedKind, MlsContentType>> = {
  [HandshakeKind.COMMIT]: MlsContentType.COMMIT,
  APPLICATION: MlsContentType.APPLICATION,
};

function mismatch(field: MlsHeaderField, what: string): RelayError {
  return new RelayError(
    RelayErrorCode.MLS_HEADER_MISMATCH,
    `The MLSMessage header does not match the room or the kind of message: ${field} ${what}.`,
    { field },
  );
}

/** Reads the header, turning every way it can be unreadable into the one 422 the client sees. */
function readHeader(bytes: Uint8Array): MlsHeader {
  try {
    return parseMlsHeader(bytes);
  } catch (error) {
    if (error instanceof MlsHeaderError) {
      throw new RelayError(
        RelayErrorCode.MLS_HEADER_MISMATCH,
        `The MLSMessage header is not readable: ${error.field} (${error.reason}).`,
        { field: error.field, reason: error.reason },
      );
    }
    throw error;
  }
}

function framedHeader(
  header: MlsHeader,
  allowedWireFormats: readonly MlsWireFormat[],
): MlsFramedHeader {
  if (
    (header.wireFormat === MlsWireFormat.PUBLIC_MESSAGE ||
      header.wireFormat === MlsWireFormat.PRIVATE_MESSAGE) &&
    allowedWireFormats.includes(header.wireFormat)
  ) {
    return header;
  }
  throw mismatch('wireFormat', 'is not an allowed wire format for this message');
}

function assertFramedMatches(
  header: MlsFramedHeader,
  kind: FramedKind,
  room: RoomHeaderFacts,
): void {
  if (!room.groupId.equals(header.groupId)) throw mismatch('groupId', "is not the room's group");
  if (header.epoch !== BigInt(room.epoch))
    throw mismatch('epoch', "is not the room's current epoch");
  if (header.contentType !== EXPECTED_CONTENT_TYPE[kind]) {
    throw mismatch('contentType', 'is not the content type of this kind of message');
  }
}

/**
 * A commit posted to `POST /handshakes`: a PublicMessage or a PrivateMessage, for the room's group
 * and current epoch, of content type `commit` (a standalone proposal is refused before this, see
 * `HandshakeKind`).
 *
 * A PublicMessage must also name an ordinary MEMBER as its sender: the other sender types exist
 * for external joins and external proposers, which phase 1 does not have (review §2), so a
 * PublicMessage from anyone else could only be an attempt to use a path that is switched off.
 */
export function assertHandshakeHeader(bytes: Uint8Array, room: RoomHeaderFacts): void {
  const header = framedHeader(readHeader(bytes), [
    MlsWireFormat.PUBLIC_MESSAGE,
    MlsWireFormat.PRIVATE_MESSAGE,
  ]);
  assertFramedMatches(header, HandshakeKind.COMMIT, room);
  if (
    header.wireFormat === MlsWireFormat.PUBLIC_MESSAGE &&
    header.sender?.type !== MlsSenderType.MEMBER
  ) {
    throw mismatch('sender', 'must be a group member in a PublicMessage');
  }
}

/**
 * An application message posted to `POST /envelopes`: always a PrivateMessage (a PublicMessage
 * would put the text in the clear, which the relay refuses to store), for the room's group and
 * current epoch, of content type `application`.
 */
export function assertEnvelopeHeader(bytes: Uint8Array, room: RoomHeaderFacts): void {
  const header = framedHeader(readHeader(bytes), [MlsWireFormat.PRIVATE_MESSAGE]);
  assertFramedMatches(header, 'APPLICATION', room);
}

/**
 * A Welcome sent beside a commit. It names no group and no epoch in the clear (only the cipher
 * suite), so those cannot be checked; it must still parse as a Welcome and not be something else.
 */
export function assertWelcomeHeader(bytes: Uint8Array): void {
  const header = readHeader(bytes);
  if (header.wireFormat !== MlsWireFormat.WELCOME) {
    throw mismatch('wireFormat', 'is not a Welcome');
  }
}
