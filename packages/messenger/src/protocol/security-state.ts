/**
 * The security state of ONE conversation, as the UI draws it (step К5b).
 *
 * A pure view-model: plain data, no React, no MLS library types, no I/O. The UI core only READS it
 * (through `SecurityStateSource` on `MessengerUiProvider`); the engine and the hooks that FILL it
 * (the member list from the MLS tree, the epoch, the authenticator, the device verification) are the
 * next step. Keeping the shape here, in `protocol/`, is what lets that step and the screens meet
 * without either importing the other.
 *
 * Nothing in this file is a claim by itself: a field says what the client KNOWS about the room, and
 * a room whose state is unknown has no `ConversationSecurityState` at all (the UI then shows no
 * badge, never a reassuring default).
 */

import type { DeviceRole } from '@masia/contracts/wire';

/** Whether the room's TEXT is end-to-end encrypted: `pending` while the switch-on or the first keys are in flight. */
export type E2eeStatus = 'off' | 'pending' | 'on';

/**
 * Whether Masia is in the room, and what that means for the server.
 *
 * `present-server-reads` is the ONLY non-absent value on purpose: Masia is a server-side member whose
 * key is kept by the operator (ADR-117 §3), so wherever she is, the server can read the room. There
 * is no "present, but encrypted" state, because there is no such thing today.
 */
export type MasiaPresence = 'absent' | 'present-server-reads';

/** The device roles (canon section 3): the wire's `DeviceRole` (`@masia/contracts/wire`), imported, not copied. */
export type SecurityDeviceRole = DeviceRole;

/**
 * `stalled`: the room cannot move to its next epoch (a replay stopped, a key refresh is owed) and
 * messages wait. Absent or `none` = nothing to report.
 */
export type RecoveryStatus = 'none' | 'stalled';

/** An adult who can read the room on behalf of a child (a GUARDIAN device on the child's account). */
export interface SecurityGuardian {
  readonly userId: string;
  /** What every member sees: "<displayName> sees this chat". */
  readonly displayName: string;
  /** The user (the child) whose account carries the guardian device. */
  readonly forUserId: string;
}

/** One device that is a leaf of the room's key tree. */
export interface SecurityDevice {
  /** The stable install id; the same id the host sends with every request (canon section 3). */
  readonly deviceId: string;
  /** What the device is called ("iPhone 17"). */
  readonly label: string;
  readonly role: SecurityDeviceRole;
  /**
   * The device's key was checked against its owner's signed device list. This is the client's own
   * check; it is NOT "a person compared the security codes".
   */
  readonly verified: boolean;
  /** A newcomer that owes its first key update: until it arrives, this device is the only new key material. */
  readonly needsSelfUpdate?: boolean;
  /** This is the device the screen is running on. */
  readonly isThis: boolean;
}

/**
 * Where THIS device keeps its keys (canon section 11): `hardware` = the phone's Keychain or Keystore;
 * `browser` = the web fallback (a non-extractable WebCrypto key in IndexedDB), which hides values from
 * casual browsing only and protects neither a disk copy nor against script in the same page.
 */
export type KeyStoreClass = 'hardware' | 'browser';

/** What this device can honestly say about itself (canon section 11). Shown in the security sheet. */
export interface ThisDeviceSecurity {
  /**
   * The MLS engine runs in its own module Worker: the room's keys are never in the page's memory, and
   * only decrypted messages cross to it. `false` = the engine shares the page (no Worker available).
   */
  readonly engineIsolated: boolean;
  readonly keyStore: KeyStoreClass;
}

export interface ConversationSecurityState {
  readonly e2ee: E2eeStatus;
  readonly masia: MasiaPresence;
  /** Every guardian of anyone in the room. Shown to EVERY member, the child included; never hidden. */
  readonly guardians: readonly SecurityGuardian[];
  /** The group's epoch (a counter). Shown beside the security code so two people can tell versions apart. */
  readonly epoch?: bigint | number;
  /**
   * The epoch authenticator, already formatted for people: `EPOCH_AUTHENTICATOR_GROUPS` groups of
   * `EPOCH_AUTHENTICATOR_GROUP_LENGTH` hex digits, space-separated (`formatEpochAuthenticator` builds
   * it from the engine's bytes). SHOWN, NOT ENFORCED: nothing compares it for the person.
   */
  readonly epochAuthenticator?: string;
  readonly devices: readonly SecurityDevice[];
  readonly recovery?: RecoveryStatus;
  /** This device's own protection (engine isolation, key store). Absent = not known, nothing is claimed. */
  readonly thisDevice?: ThisDeviceSecurity;
  /**
   * A change of keys (a commit) or a message of ours is on its way to the relay. The composer stays
   * usable: what is typed now is queued and goes out after it (canon section 11).
   */
  readonly sending?: boolean;
  /** Another tab of this browser holds the room: this one shows it, and cannot send until it takes over. */
  readonly readOnly?: boolean;
  /** This device was removed from the room: it keeps what it already read and can neither read on nor send. */
  readonly removed?: boolean;
  /**
   * The relay no longer holds the start of this device's history (retention): messages before this
   * ISO time are only on the person's other devices.
   */
  readonly historyBefore?: string;
  /** The relay refused this device's session (signed out, or not identified): sign in again to read and send. */
  readonly signInRequired?: boolean;
}

// ── Epoch events: the permanent system lines of a thread ─────────────────────

/** What an epoch change looks like in the thread (canon section 3, steps 3 and 6; section 4). */
export type EpochEventKind =
  | 'device-added'
  | 'device-removed'
  | 'masia-joined'
  | 'masia-left'
  | 'key-changed'
  | 'encryption-on';

interface EpochEventBase {
  /** Stable id, so a list keeps its keys (the engine's commit id, or `<epoch>-<index>`). */
  readonly id: string;
  /** ISO time of the commit; the thread orders system lines among messages by it. */
  readonly at: string;
}

export interface DeviceAddedEvent extends EpochEventBase {
  readonly kind: 'device-added';
  /** Whose device it is. */
  readonly personName: string;
  readonly deviceLabel: string;
}

export interface DeviceRemovedEvent extends EpochEventBase {
  readonly kind: 'device-removed';
  readonly personName: string;
  readonly deviceLabel: string;
}

export interface MasiaJoinedEvent extends EpochEventBase {
  readonly kind: 'masia-joined';
}

export interface MasiaLeftEvent extends EpochEventBase {
  readonly kind: 'masia-left';
}

/** A person's identity key changed: a visible trust-on-first-use change, never a silent one (canon section 3, step 7). */
export interface KeyChangedEvent extends EpochEventBase {
  readonly kind: 'key-changed';
  readonly personName: string;
}

export interface EncryptionOnEvent extends EpochEventBase {
  readonly kind: 'encryption-on';
}

export type EpochEvent =
  | DeviceAddedEvent
  | DeviceRemovedEvent
  | MasiaJoinedEvent
  | MasiaLeftEvent
  | KeyChangedEvent
  | EncryptionOnEvent;

// ── The security code (epoch authenticator) as people read it ────────────────

/** How many groups the security code is written in. */
export const EPOCH_AUTHENTICATOR_GROUPS = 8;
/** Hex digits per group. 8 groups of 4 = 32 hex digits = the first 16 bytes (128 bits) of the authenticator. */
export const EPOCH_AUTHENTICATOR_GROUP_LENGTH = 4;

const HEX_RADIX = 16;
const HEX_DIGITS_PER_BYTE = 2;
const BYTES_SHOWN =
  (EPOCH_AUTHENTICATOR_GROUPS * EPOCH_AUTHENTICATOR_GROUP_LENGTH) / HEX_DIGITS_PER_BYTE;
const GROUP_SEPARATOR = ' ';

/**
 * Turns the engine's epoch authenticator bytes into the string `ConversationSecurityState` carries:
 * the first 16 bytes as upper-case hex in 8 groups of 4 ("A1B2 C3D4 …"). 128 bits are plenty to
 * notice a forked group, and short enough to read out on a call. Fewer than 16 bytes are refused
 * (a shorter value would look like a code and prove little).
 */
export function formatEpochAuthenticator(bytes: Uint8Array): string {
  if (bytes.length < BYTES_SHOWN) {
    throw new RangeError(
      `epoch authenticator needs at least ${BYTES_SHOWN} bytes, got ${bytes.length}`,
    );
  }
  const hex = Array.from(bytes.subarray(0, BYTES_SHOWN), (byte) =>
    byte.toString(HEX_RADIX).padStart(HEX_DIGITS_PER_BYTE, '0'),
  )
    .join('')
    .toUpperCase();
  const groups: string[] = [];
  for (let i = 0; i < hex.length; i += EPOCH_AUTHENTICATOR_GROUP_LENGTH) {
    groups.push(hex.slice(i, i + EPOCH_AUTHENTICATOR_GROUP_LENGTH));
  }
  return groups.join(GROUP_SEPARATOR);
}

/** The groups of a formatted code, for a screen that lays them out (a value without spaces is one group). */
export function epochAuthenticatorGroups(code: string): string[] {
  return code.split(/\s+/).filter((group) => group !== '');
}
