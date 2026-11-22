/**
 * The call binding PORT's types (ADR-211 decision 4): what the call engine asks the host's MLS worker and what it
 * gets back. The worker derives `K` from the two people's 1:1 room and answers two questions only — this device's
 * tag for its role (`callTag`) and the verdict on the peer's tag (`callVerify`); `K` never leaves it. The engine
 * reaches that worker through `CallBindingPort` (`call-engine.ts`); the host implements it.
 */
import type { CallTagRole } from '@masia/contracts/wire';

/** What the page knows about a call: who is who, and the two fingerprints as read from the SDPs. */
export interface CallBindingInput {
  readonly conversationId: string;
  readonly callId: string;
  readonly callerDeviceId: string;
  readonly calleeDeviceId: string;
  /** The caller's DTLS fingerprint (`a=fingerprint:` of the caller's SDP); canonicalised here. */
  readonly fingerprintCaller: string;
  readonly fingerprintCallee: string;
}

export interface CallTagRequest extends CallBindingInput {
  readonly role: CallTagRole;
  /** Catch the room up before deriving `K` (a retry after a failed check). */
  readonly fresh?: boolean;
}

export interface CallVerifyRequest extends CallTagRequest {
  /** The tag the peer sent (`call:verify`), verbatim. */
  readonly receivedTag: string;
}

/**
 * What another member device of the room is, seen from this device:
 *   `mine`      — another device of this person (their second phone);
 *   `theirs`    — another device of the person on the other end;
 *   `guardian`  — a parent's guardian device (a minor's room);
 *   `assistant` — the assistant's device (Masia's, in this app);
 *   `other`     — a third person's device. A 1:1 room should hold none, and a call in a room that does is refused,
 *                 so it appears only in the verdict of a call that fails.
 */
export type CallOtherDeviceKind = 'mine' | 'theirs' | 'guardian' | 'assistant' | 'other';

export interface CallOtherDevice {
  readonly deviceId: string;
  readonly userId: string;
  readonly kind: CallOtherDeviceKind;
}

export interface CallTagAnswer {
  readonly tag: string;
  /** The epoch `K` was derived for (never secret: the room's snapshot carries it too). */
  readonly epoch: number;
  /** Every member device at that epoch apart from the two that talk, in the group's order. */
  readonly others: readonly CallOtherDevice[];
}

export interface CallVerifyAnswer {
  readonly ok: boolean;
  /**
   * The person the peer device belongs to, as the group holds it at this epoch — the one other person of the room.
   * Set only when `ok`; null otherwise. This, never a user id the server sent, is who the call was verified with.
   */
  readonly peerUserId: string | null;
  readonly epoch: number;
  readonly others: readonly CallOtherDevice[];
}
