/**
 * The fingerprint binding of a 1:1 audio call, INSIDE the host's MLS Worker (internal ADR-211 decision 4).
 *
 * `K` = the MLS exporter of the two people's 1:1 room (`label = "masia-call-fp"`, context = the callId), derived
 * by the host's room (`CallKeyring.key`) for the epoch this device holds NOW. `K` never leaves this module: the
 * page asks two questions only, and gets a tag or a verdict back.
 *
 *  - `callTag`    — this device's tag for ITS role. A device computes only the tag of its own role: the device id
 *                   of that role must be this Worker's device (the page cannot make the Worker speak for another).
 *  - `callVerify` — does the peer's tag prove the same `K`, the same two device ids and the same two DTLS
 *                   fingerprints? False for a missing or malformed tag, for our own tag reflected back, for a peer
 *                   device the room's group does not hold at this epoch, and for any mismatch. Constant time
 *                   (`verifyPeerCallTag`). A verdict that passes names the person verified (`peerUserId`).
 *
 * WHO the peer is. `K` proves only "a member device of this room": the assistant's device, a guardian's device (it
 * sits on the minor's account, so it carries the child's user id) and this person's own other devices hold it too.
 * So both questions also require the peer device to be the ONE other person's own device, as the group holds it at
 * this epoch: role USER, not this person, in a room whose USER devices belong to exactly one other person. Anything
 * else is refused — `callTag` will not compute a tag for it (INVALID), `callVerify` never says ok. A peer device the
 * group does not hold yet is not refused by `callTag` (catching up may add it); `callVerify` says not ok.
 *
 * Both answers also say WHO ELSE could listen (decision 5): every member device of the room at that epoch apart
 * from the two that talk, by kind — any of them can derive `K` and could sit in the middle, so the call badge
 * names them all, not only Masia.
 *
 * Own epoch only: neither question takes an epoch, so a peer can never make this side derive for an epoch it
 * names. When the two sides stand on different epochs the check fails; the page then asks again with `fresh`,
 * which catches the room up first (bounded by the engine: 3 retries within 10 s, `call-engine.ts`).
 *
 * The tag construction itself is the contracts' one (`@masia/contracts/wire`, `call-verify-tag.ts`); nothing of it is
 * re-implemented here. `K` is wiped after each question.
 *
 * A refusal throws `CallBindingError` (`INVALID`); a host maps it onto its own Worker protocol. A Worker imports this
 * file through its own door, `@masia/messenger/call/call-binding`, so the engine's barrel stays out of the Worker.
 */
import {
  callTagInput,
  computeCallTag,
  normalizeDtlsFingerprint,
  verifyPeerCallTag,
  type CallTagBinding,
  type CallTagRole,
} from '@masia/contracts/wire/call-verify-tag';
import { DeviceRole } from '@masia/contracts/wire';
// A member as the room's group holds it is the identity in that member's leaf credential: `{ userId, deviceId, role }`.
import type { DeviceIdentity as RoomMember } from '../mls/credential.js';
// The port's types (what the page asks, what it gets back): `call-binding-types.ts`, exported beside this file.
import type {
  CallOtherDevice,
  CallOtherDeviceKind,
  CallTagAnswer,
  CallTagRequest,
  CallVerifyAnswer,
  CallVerifyRequest,
} from './call-binding-types.js';

/** The room's call key at its current epoch, and who is in the group then. Worker-internal: never posted. */
export interface CallKey {
  readonly key: Uint8Array;
  readonly epoch: number;
  readonly members: readonly RoomMember[];
}

/** What the binding needs of a room: this device, and `K` for a call (the host's room derives it). */
export interface CallKeyring {
  readonly selfUserId: string;
  readonly selfDeviceId: string;
  key(callId: string, fresh: boolean): Promise<CallKey>;
}

/** Why the binding refused a question, as a stable code: the request is not one this Worker answers. */
export const CALL_BINDING_ERRORS = {
  INVALID: 'INVALID',
} as const;
export type CallBindingErrorCode = (typeof CALL_BINDING_ERRORS)[keyof typeof CALL_BINDING_ERRORS];

/** The one error the binding throws itself. Errors of the keyring (`key`) pass through as they are. */
export class CallBindingError extends Error {
  readonly code: CallBindingErrorCode;
  constructor(code: CallBindingErrorCode) {
    super(`call binding: ${code}`);
    this.name = 'CallBindingError';
    this.code = code;
  }
}

const invalid = (): CallBindingError => new CallBindingError(CALL_BINDING_ERRORS.INVALID);

/**
 * The request as the shared tag function takes it, or `INVALID` when it is not one. The shape (role, call id, device
 * ids, two distinct devices) is the shared construction's own check (`callTagInput`); this adds what only the Worker
 * knows: the role's device must be this one.
 */
function bindingOf(ring: CallKeyring, request: CallTagRequest): CallTagBinding {
  const { callId, callerDeviceId, calleeDeviceId, role } = request;
  const fingerprintCaller = normalizeDtlsFingerprint(String(request.fingerprintCaller));
  const fingerprintCallee = normalizeDtlsFingerprint(String(request.fingerprintCallee));
  if (!fingerprintCaller || !fingerprintCallee) throw invalid();
  const binding: CallTagBinding = { callId, callerDeviceId, calleeDeviceId, fingerprintCaller, fingerprintCallee };
  try {
    callTagInput(role, binding);
  } catch {
    throw invalid();
  }
  // This Worker speaks for its own device only.
  if ((role === 'caller' ? callerDeviceId : calleeDeviceId) !== ring.selfDeviceId) throw invalid();
  return binding;
}

/**
 * Who the peer device is, at this epoch:
 *   `{ userId }` — a USER device of the one other person of the room;
 *   'unknown'    — the group does not hold that device (catching up may add it);
 *   'refused'    — it is held and it is not that: an assistant's or a guardian's device, this person's own other
 *                  device, or a room whose USER devices belong to more (or fewer) than one other person.
 */
type PeerVerdict = { readonly userId: string } | 'unknown' | 'refused';

function peerOf(ring: CallKeyring, peerDeviceId: string, members: readonly RoomMember[]): PeerVerdict {
  const peer = members.find((member) => member.deviceId === peerDeviceId);
  if (!peer) return 'unknown';
  if (peer.role !== DeviceRole.USER || peer.userId === ring.selfUserId) return 'refused';
  const otherPeople = new Set(
    members
      .filter((member) => member.role === DeviceRole.USER && member.userId !== ring.selfUserId)
      .map((member) => member.userId),
  );
  return otherPeople.size === 1 ? { userId: peer.userId } : 'refused';
}

const peerDeviceOf = (role: CallTagRole, binding: CallTagBinding): string =>
  role === 'caller' ? binding.calleeDeviceId : binding.callerDeviceId;

/** The badge: the group's other member devices, by kind, from this device's side. */
function othersOf(
  ring: CallKeyring,
  role: CallTagRole,
  binding: CallTagBinding,
  members: readonly RoomMember[],
): CallOtherDevice[] {
  const peerDeviceId = peerDeviceOf(role, binding);
  const peerUserId = members.find((member) => member.deviceId === peerDeviceId)?.userId ?? null;
  const kindOf = (member: RoomMember): CallOtherDeviceKind => {
    if (member.role === DeviceRole.ASSISTANT) return 'assistant';
    if (member.role === DeviceRole.GUARDIAN) return 'guardian';
    if (member.userId === ring.selfUserId) return 'mine';
    if (peerUserId !== null && member.userId === peerUserId) return 'theirs';
    return 'other';
  };
  return members
    .filter((member) => member.deviceId !== binding.callerDeviceId && member.deviceId !== binding.calleeDeviceId)
    .map((member) => ({ deviceId: member.deviceId, userId: member.userId, kind: kindOf(member) }));
}

async function withKey<T>(
  ring: CallKeyring,
  callId: string,
  fresh: boolean,
  run: (key: CallKey) => Promise<T>,
): Promise<T> {
  const key = await ring.key(callId, fresh);
  try {
    return await run(key);
  } finally {
    key.key.fill(0);
  }
}

/** This device's tag for its own role — never for a call with a device that is not the other person's own. */
export async function callTag(ring: CallKeyring, request: CallTagRequest): Promise<CallTagAnswer> {
  const binding = bindingOf(ring, request);
  return withKey(ring, binding.callId, request.fresh === true, async ({ key, epoch, members }) => {
    if (peerOf(ring, peerDeviceOf(request.role, binding), members) === 'refused') throw invalid();
    return {
      tag: await computeCallTag(key, request.role, binding),
      epoch,
      others: othersOf(ring, request.role, binding, members),
    };
  });
}

/** Does the peer's tag check out under `K` of this device's current epoch, from the other person's own device? */
export async function callVerify(
  ring: CallKeyring,
  request: CallVerifyRequest,
): Promise<CallVerifyAnswer> {
  const binding = bindingOf(ring, request);
  return withKey(ring, binding.callId, request.fresh === true, async ({ key, epoch, members }) => {
    // Our own tag of this epoch: a received tag equal to it is a reflection, never "verified".
    const sentTag = await computeCallTag(key, request.role, binding);
    const matches = await verifyPeerCallTag({
      key,
      myRole: request.role,
      binding,
      sentTag,
      receivedTag: typeof request.receivedTag === 'string' ? request.receivedTag : null,
    });
    // The tag names device ids; only the other person's own device, as the group holds it now, may be the one.
    const peer = peerOf(ring, peerDeviceOf(request.role, binding), members);
    const ok = matches && typeof peer === 'object';
    return {
      ok,
      peerUserId: ok && typeof peer === 'object' ? peer.userId : null,
      epoch,
      others: othersOf(ring, request.role, binding, members),
    };
  });
}
