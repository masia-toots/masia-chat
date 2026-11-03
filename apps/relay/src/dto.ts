import {
  type DeviceListEntry,
  type DeviceListVersion,
  type DeviceRole,
  type HandshakeKind,
  RelayError,
  RelayErrorCode,
} from '@masia/relay';
import type { StoredDeviceList, StoredDeviceListVersion } from './domain/device-lists.js';
import type { DeviceRow } from './domain/devices.js';
import type { ClaimedKeyPackage } from './domain/key-packages.js';
import type { DeclaredMemberDelta } from './domain/member-delta.js';
import type { EnvelopeRow, HandshakeRow, Page, ReadWindow } from './domain/rooms.js';

/**
 * The wire shapes, and the ONE place rows become them: bytes → base64 text, dates → ISO text.
 * A route never formats a row by hand, so a field cannot be spelled two ways.
 */

export interface DeviceDto {
  readonly id: string;
  readonly userId: string;
  readonly role: DeviceRole;
  readonly name: string | null;
  readonly platform: string | null;
  readonly identityKeyPub: string;
  readonly signatureKeyPub: string;
  readonly createdAt: string;
  readonly lastSeenAt: string | null;
  readonly revokedAt: string | null;
}

/**
 * A device as another user sees it: what they need to verify and address it, and nothing about its
 * owner's habits (label, platform, last seen) or its history.
 */
export type PublicDeviceDto = Pick<DeviceDto, 'id' | 'role' | 'identityKeyPub' | 'signatureKeyPub'>;

export interface ClaimedKeyPackageDto {
  readonly deviceId: string;
  readonly keyPackageId: string;
  readonly bytes: string;
  readonly lastResort: boolean;
}

export interface DeviceListDto {
  readonly userId: string;
  readonly version: number;
  readonly devices: readonly DeviceListEntry[];
  readonly signature: string;
  readonly updatedAt: string;
}

export interface HandshakeDto {
  readonly seq: number;
  readonly epoch: number;
  readonly kind: HandshakeKind;
  readonly senderDeviceId: string;
  readonly bytes: string;
  /**
   * What the sender DECLARED beside a COMMIT; `null` on a WELCOME. Members compare it
   * with the delta they derive from the decrypted commit (security review 2026-10-10 §4).
   */
  readonly memberDelta: DeclaredMemberDelta | null;
  readonly createdAt: string;
}

export interface EnvelopeDto {
  readonly seq: number;
  readonly epoch: number;
  readonly senderDeviceId: string;
  readonly ciphertext: string;
  readonly createdAt: string;
}

/** THE bytes-to-wire helper: every byte field of every response goes through it. */
export const toBase64 = (bytes: Buffer): string => bytes.toString('base64');
const toIso = (date: Date): string => date.toISOString();

export function toDeviceDto(device: DeviceRow): DeviceDto {
  return {
    id: device.id,
    userId: device.userId,
    role: device.role,
    name: device.name,
    platform: device.platform,
    identityKeyPub: toBase64(device.identityKeyPub),
    signatureKeyPub: toBase64(device.signatureKeyPub),
    createdAt: toIso(device.createdAt),
    lastSeenAt: device.lastSeenAt === null ? null : toIso(device.lastSeenAt),
    revokedAt: device.revokedAt === null ? null : toIso(device.revokedAt),
  };
}

export function toPublicDeviceDto(device: DeviceRow): PublicDeviceDto {
  return {
    id: device.id,
    role: device.role,
    identityKeyPub: toBase64(device.identityKeyPub),
    signatureKeyPub: toBase64(device.signatureKeyPub),
  };
}

export function toClaimedKeyPackageDto(item: ClaimedKeyPackage): ClaimedKeyPackageDto {
  return {
    deviceId: item.deviceId,
    keyPackageId: item.keyPackageId,
    bytes: toBase64(item.bytes),
    lastResort: item.lastResort,
  };
}

export function toDeviceListDto(list: StoredDeviceList): DeviceListDto {
  return {
    userId: list.userId,
    version: list.version,
    devices: list.devices,
    signature: toBase64(list.signature),
    updatedAt: toIso(list.updatedAt),
  };
}

export function toDeviceListVersionDto(row: StoredDeviceListVersion): DeviceListVersion {
  return {
    userId: row.userId,
    version: row.version,
    devices: row.devices,
    signature: toBase64(row.signature),
  };
}

export function toHandshakeDto(row: HandshakeRow): HandshakeDto {
  return {
    seq: row.seq,
    epoch: row.epoch,
    kind: row.kind,
    senderDeviceId: row.senderDeviceId,
    bytes: toBase64(row.bytes),
    memberDelta: row.memberDelta,
    createdAt: toIso(row.createdAt),
  };
}

export function toEnvelopeDto(row: EnvelopeRow): EnvelopeDto {
  return {
    seq: row.seq,
    epoch: row.epoch,
    senderDeviceId: row.senderDeviceId,
    ciphertext: toBase64(row.ciphertext),
    createdAt: toIso(row.createdAt),
  };
}

/** Every collection endpoint answers with this envelope (coding canon: API collection convention). */
export interface Collection<T> {
  readonly rows: readonly T[];
  /** Opaque cursor for the next page, or `null` when the collection is exhausted. */
  readonly nextCursor: string | null;
}

export function collection<T>(rows: readonly T[], nextCursor: string | null = null): Collection<T> {
  return { rows, nextCursor };
}

/** A page of a conversation's sequenced log: a collection plus what the reader needs to stay in sync. */
export interface SequencedCollection<T> extends Collection<T> {
  /** The lowest seq still held (older rows were deleted by retention); see `Page`. */
  readonly oldestAvailableSeq: number;
  /** For a device a commit removed: the epoch its reading ends at. `null` for a member. */
  readonly removedAtEpoch: number | null;
}

/**
 * A page of sequenced rows as a collection. The cursor is the last row's `seq` (as text), which the
 * client sends back as `afterSeq`; it is `null` on the last page.
 */
export function pageCollection<Row extends { readonly seq: number }, Dto>(
  page: Page<Row>,
  window: ReadWindow,
  toDto: (row: Row) => Dto,
): SequencedCollection<Dto> {
  const last = page.rows[page.rows.length - 1];
  return {
    ...collection(
      page.rows.map(toDto),
      page.hasMore && last !== undefined ? String(last.seq) : null,
    ),
    oldestAvailableSeq: page.oldestAvailableSeq,
    removedAtEpoch: window.removedAtEpoch,
  };
}

/**
 * Request bytes arrive as base64 text; the schema has already proved it is valid base64.
 *
 * The size limit is enforced HERE, on the decoded bytes, because a schema can only cap the text:
 * base64 packs 3 bytes into 4 characters, so a `maxLength` cannot say "at most N bytes" unless N is
 * a multiple of 3 (it would let 1 or 2 extra bytes through).
 */
export function fromBase64(text: string, maxBytes: number): Buffer {
  const bytes = Buffer.from(text, 'base64');
  if (bytes.length > maxBytes) {
    throw new RelayError(
      RelayErrorCode.VALIDATION_FAILED,
      `A field is longer than ${maxBytes} bytes.`,
    );
  }
  return bytes;
}
