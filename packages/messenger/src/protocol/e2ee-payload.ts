/**
 * What travels INSIDE an end-to-end encrypted message (canon section 10, ADR-117 amendment (е)).
 *
 * In an E2EE room the relay stores only ciphertext, so everything that makes a message a message (its
 * id, whether it is new text, an edit, a delete or a sticker, what it replies to) has to ride inside
 * the encrypted bytes. This file owns that inner format: a small, versioned, length-capped JSON
 * object, UTF-8 encoded, that the engine seals as one MLS application message.
 *
 * Three promises, each a way a hostile or broken sender could hurt a reader:
 *  1. **Decoding never throws.** Bytes from another member are untrusted input: a malformed, oversized,
 *     future-versioned or unknown-kind payload comes back as a typed `E2eePayloadError`, and the screen
 *     shows that one message as "unreadable" instead of breaking the thread.
 *  2. **Every field is capped and checked** (ids are wire ids, text has a length limit). Unknown extra
 *     fields are ignored, so a newer sender stays readable by an older client within the same version.
 *     **No URL travels**: a sticker is a catalog id the READER's host resolves from its own catalog
 *     (ADR-117 amendment (і), round 2 sec-M4: a sender-chosen image URL made every reader's device
 *     fetch it, and the "same-origin path" check was bypassable with `/\evil.com`). A field named
 *     `imageUrl` from an older sender is ignored like any unknown field.
 *  3. **Reactions ride here too** (ADR-117 amendment (и), superseding the first cut that kept them on
 *     the server's plaintext path): the server knows an E2EE message by no id of its own, and an
 *     assistant member can only speak through the room. A reaction is one emoji on a payload id.
 *
 * A `notice` is a system line a member posts INTO the room (for example an assistant's "joined"): an
 * i18n KEY, never text, and a reader renders only the keys its host allows.
 *
 * Decoding hands back the payload; `e2eePayloadToEvent` turns it into the `msg:*` events the existing
 * view-model (`useMessenger`'s reducer) already understands, so the screens draw an E2EE room with the
 * same code as any other.
 */
import { isWireId } from '@masia/contracts/wire';
import type { MsgDeletedEvent, MsgEditedEvent, MsgNewEvent } from './events.js';
import type { MessageReaction } from './messages.js';

/** The format version this build writes and reads. A higher one is `VERSION_UNSUPPORTED`, never a guess. */
export const E2EE_PAYLOAD_VERSION = 1;

/** What a payload can say. A kind this build does not know is `UNKNOWN_KIND` (shown as unreadable). */
export const E2EE_PAYLOAD_KINDS = [
  'text',
  'edit',
  'delete',
  'sticker',
  'reaction',
  'notice',
] as const;
export type E2eePayloadKind = (typeof E2EE_PAYLOAD_KINDS)[number];

const KIB = 1024;
/**
 * The largest encoded payload, in bytes. Below the engine's plaintext cap (about 62 KiB) with room to
 * spare, so a payload this file accepts is never refused by `encrypt`.
 */
export const E2EE_PAYLOAD_MAX_BYTES = 48 * KIB;
/** The longest message text, in UTF-16 code units. */
export const E2EE_TEXT_MAX_CHARS = 10_000;
/** The longest reply quote a sender may attach (a preview, not the whole message). */
export const E2EE_QUOTE_MAX_CHARS = 280;
/** The longest sender name carried in a reply quote. */
export const E2EE_NAME_MAX_CHARS = 120;
/** The longest sticker motion or sound preset name. */
export const E2EE_PRESET_MAX_CHARS = 64;
/** The longest reaction, in UTF-16 code units: one emoji, including ZWJ sequences and skin tones. */
export const E2EE_REACTION_MAX_CHARS = 32;
/** The longest notice key (`namespace:dotted.key`). */
export const E2EE_NOTICE_KEY_MAX_CHARS = 128;

/** Why a payload could not be read (or built). Stable strings: tests and logs compare them. */
export const E2EE_PAYLOAD_ERRORS = {
  /** Not UTF-8 JSON of an object. */
  MALFORMED: 'MALFORMED',
  /** Larger than `E2EE_PAYLOAD_MAX_BYTES`. */
  TOO_LARGE: 'TOO_LARGE',
  /** `v` is a version this build does not read. */
  VERSION_UNSUPPORTED: 'VERSION_UNSUPPORTED',
  /** `kind` is not one of `E2EE_PAYLOAD_KINDS`. */
  UNKNOWN_KIND: 'UNKNOWN_KIND',
  /** A field is missing, of the wrong type, or over its cap. */
  INVALID_FIELD: 'INVALID_FIELD',
} as const;
export type E2eePayloadErrorCode = (typeof E2EE_PAYLOAD_ERRORS)[keyof typeof E2EE_PAYLOAD_ERRORS];

export interface E2eePayloadError {
  readonly code: E2eePayloadErrorCode;
  /** The field at fault, for a debugger. Never the field's value (it is message content). */
  readonly field?: string;
}

/** What a reply points at. The quote is the sender's own preview; the reader may also look the id up. */
export interface E2eeReplyTo {
  readonly id: string;
  readonly quote?: string;
  readonly senderName?: string;
}

interface PayloadBase {
  readonly v: typeof E2EE_PAYLOAD_VERSION;
  /** The message's id, chosen by the sender (a wire id). Edits and deletes point at it. */
  readonly id: string;
}

export interface E2eeTextPayload extends PayloadBase {
  readonly kind: 'text';
  readonly body: string;
  readonly replyTo?: E2eeReplyTo;
}

export interface E2eeEditPayload extends PayloadBase {
  readonly kind: 'edit';
  /** The id of the text message this replaces. Only its sender's edits are applied (the reader checks). */
  readonly targetId: string;
  readonly body: string;
}

export interface E2eeDeletePayload extends PayloadBase {
  readonly kind: 'delete';
  readonly targetId: string;
}

export interface E2eeStickerPayload extends PayloadBase {
  readonly kind: 'sticker';
  /** An id in the host's sticker catalog; each reader resolves it from ITS catalog (unknown id: a placeholder). */
  readonly stickerId: string;
  readonly motion?: string;
  readonly sound?: string;
  readonly replyTo?: E2eeReplyTo;
}

/** One emoji on a message (by its payload id). `removed` takes the sender's same emoji back. */
export interface E2eeReactionPayload extends PayloadBase {
  readonly kind: 'reaction';
  readonly targetId: string;
  readonly emoji: string;
  readonly removed?: true;
}

/** A system line a member posts into the room: an i18n key (`namespace:key`), never text. */
export interface E2eeNoticePayload extends PayloadBase {
  readonly kind: 'notice';
  readonly key: string;
}

export type E2eePayload =
  | E2eeTextPayload
  | E2eeEditPayload
  | E2eeDeletePayload
  | E2eeStickerPayload
  | E2eeReactionPayload
  | E2eeNoticePayload;

/** A payload as a caller builds it (the version is filled in). */
export type E2eePayloadInput =
  | Omit<E2eeTextPayload, 'v'>
  | Omit<E2eeEditPayload, 'v'>
  | Omit<E2eeDeletePayload, 'v'>
  | Omit<E2eeStickerPayload, 'v'>
  | Omit<E2eeReactionPayload, 'v'>
  | Omit<E2eeNoticePayload, 'v'>;

export type E2eePayloadResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E2eePayloadError };

function fail<T>(code: E2eePayloadErrorCode, field?: string): E2eePayloadResult<T> {
  return { ok: false, error: field === undefined ? { code } : { code, field } };
}

type Fields = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isText(value: unknown, max: number, allowEmpty = false): value is string {
  return typeof value === 'string' && value.length <= max && (allowEmpty || value.length > 0);
}

/** No whitespace, no control characters: an emoji is a short run of symbols. */
const REACTION = /^[^\s\p{Cc}]+$/u;
/** `namespace:dotted.key`, the shape of an i18n key; anything else is not a notice. */
const NOTICE_KEY = /^[A-Za-z0-9_-]+:[A-Za-z0-9_.-]+$/;


function readReplyTo(value: unknown): E2eePayloadResult<E2eeReplyTo | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (!isRecord(value) || !isWireId(value.id))
    return fail(E2EE_PAYLOAD_ERRORS.INVALID_FIELD, 'replyTo');
  const { quote, senderName } = value;
  if (quote !== undefined && !isText(quote, E2EE_QUOTE_MAX_CHARS, true)) {
    return fail(E2EE_PAYLOAD_ERRORS.INVALID_FIELD, 'replyTo.quote');
  }
  if (senderName !== undefined && !isText(senderName, E2EE_NAME_MAX_CHARS, true)) {
    return fail(E2EE_PAYLOAD_ERRORS.INVALID_FIELD, 'replyTo.senderName');
  }
  return {
    ok: true,
    value: {
      id: value.id,
      ...(quote === undefined ? {} : { quote }),
      ...(senderName === undefined ? {} : { senderName }),
    },
  };
}

function isKind(value: unknown): value is E2eePayloadKind {
  return typeof value === 'string' && (E2EE_PAYLOAD_KINDS as readonly string[]).includes(value);
}

function readVersion(value: unknown): E2eePayloadResult<typeof E2EE_PAYLOAD_VERSION> {
  if (value === E2EE_PAYLOAD_VERSION) return { ok: true, value };
  const future =
    typeof value === 'number' && Number.isInteger(value) && value > E2EE_PAYLOAD_VERSION;
  return future
    ? fail(E2EE_PAYLOAD_ERRORS.VERSION_UNSUPPORTED)
    : fail(E2EE_PAYLOAD_ERRORS.INVALID_FIELD, 'v');
}

function readSticker(value: Fields, base: PayloadBase): E2eePayloadResult<E2eeStickerPayload> {
  const { stickerId, motion, sound } = value;
  if (!isWireId(stickerId)) return fail(E2EE_PAYLOAD_ERRORS.INVALID_FIELD, 'stickerId');
  if (motion !== undefined && !isText(motion, E2EE_PRESET_MAX_CHARS)) {
    return fail(E2EE_PAYLOAD_ERRORS.INVALID_FIELD, 'motion');
  }
  if (sound !== undefined && !isText(sound, E2EE_PRESET_MAX_CHARS)) {
    return fail(E2EE_PAYLOAD_ERRORS.INVALID_FIELD, 'sound');
  }
  const reply = readReplyTo(value.replyTo);
  if (!reply.ok) return reply;
  return {
    ok: true,
    value: {
      ...base,
      kind: 'sticker',
      stickerId,
      ...(motion === undefined ? {} : { motion }),
      ...(sound === undefined ? {} : { sound }),
      ...(reply.value ? { replyTo: reply.value } : {}),
    },
  };
}

/** Checks a parsed object field by field and rebuilds it from the known fields only. */
export function validateE2eePayload(value: unknown): E2eePayloadResult<E2eePayload> {
  if (!isRecord(value)) return fail(E2EE_PAYLOAD_ERRORS.MALFORMED);
  const version = readVersion(value.v);
  if (!version.ok) return version;
  if (!isKind(value.kind)) return fail(E2EE_PAYLOAD_ERRORS.UNKNOWN_KIND);
  if (!isWireId(value.id)) return fail(E2EE_PAYLOAD_ERRORS.INVALID_FIELD, 'id');
  const base: PayloadBase = { v: version.value, id: value.id };
  const { body, targetId } = value;

  switch (value.kind) {
    case 'text': {
      if (!isText(body, E2EE_TEXT_MAX_CHARS))
        return fail(E2EE_PAYLOAD_ERRORS.INVALID_FIELD, 'body');
      const reply = readReplyTo(value.replyTo);
      if (!reply.ok) return reply;
      return {
        ok: true,
        value: { ...base, kind: 'text', body, ...(reply.value ? { replyTo: reply.value } : {}) },
      };
    }
    case 'edit':
      if (!isWireId(targetId)) return fail(E2EE_PAYLOAD_ERRORS.INVALID_FIELD, 'targetId');
      if (!isText(body, E2EE_TEXT_MAX_CHARS))
        return fail(E2EE_PAYLOAD_ERRORS.INVALID_FIELD, 'body');
      return { ok: true, value: { ...base, kind: 'edit', targetId, body } };
    case 'delete':
      if (!isWireId(targetId)) return fail(E2EE_PAYLOAD_ERRORS.INVALID_FIELD, 'targetId');
      return { ok: true, value: { ...base, kind: 'delete', targetId } };
    case 'sticker':
      return readSticker(value, base);
    case 'reaction': {
      const { emoji, removed } = value;
      if (!isWireId(targetId)) return fail(E2EE_PAYLOAD_ERRORS.INVALID_FIELD, 'targetId');
      if (!isText(emoji, E2EE_REACTION_MAX_CHARS) || !REACTION.test(emoji)) {
        return fail(E2EE_PAYLOAD_ERRORS.INVALID_FIELD, 'emoji');
      }
      if (removed !== undefined && removed !== true) {
        return fail(E2EE_PAYLOAD_ERRORS.INVALID_FIELD, 'removed');
      }
      return {
        ok: true,
        value: { ...base, kind: 'reaction', targetId, emoji, ...(removed ? { removed } : {}) },
      };
    }
    case 'notice': {
      const { key } = value;
      if (!isText(key, E2EE_NOTICE_KEY_MAX_CHARS) || !NOTICE_KEY.test(key)) {
        return fail(E2EE_PAYLOAD_ERRORS.INVALID_FIELD, 'key');
      }
      return { ok: true, value: { ...base, kind: 'notice', key } };
    }
  }
}

const encoder = new TextEncoder();
const strictDecoder = new TextDecoder('utf-8', { fatal: true });

/**
 * Builds the bytes to encrypt. Validates first, so a caller cannot seal what a reader would refuse;
 * a payload over the cap is `TOO_LARGE` (the composer says so, nothing is sent).
 */
export function encodeE2eePayload(input: E2eePayloadInput): E2eePayloadResult<Uint8Array> {
  const checked = validateE2eePayload({ v: E2EE_PAYLOAD_VERSION, ...input });
  if (!checked.ok) return checked;
  const bytes = encoder.encode(JSON.stringify(checked.value));
  if (bytes.length > E2EE_PAYLOAD_MAX_BYTES) return fail(E2EE_PAYLOAD_ERRORS.TOO_LARGE);
  return { ok: true, value: bytes };
}

/** Reads decrypted bytes. NEVER throws: every failure is a typed error the screen shows as "unreadable". */
export function decodeE2eePayload(bytes: Uint8Array): E2eePayloadResult<E2eePayload> {
  try {
    if (!(bytes instanceof Uint8Array)) return fail(E2EE_PAYLOAD_ERRORS.MALFORMED);
    if (bytes.length > E2EE_PAYLOAD_MAX_BYTES) return fail(E2EE_PAYLOAD_ERRORS.TOO_LARGE);
    const parsed: unknown = JSON.parse(strictDecoder.decode(bytes));
    return validateE2eePayload(parsed);
  } catch {
    return fail(E2EE_PAYLOAD_ERRORS.MALFORMED);
  }
}

/** Who sent a decrypted message and when the relay took it: the reader's facts, not the payload's. */
export interface E2eeMessageContext {
  readonly conversationId: string;
  /** The sender's person id, from the MLS tree (never from the payload). */
  readonly senderId: string;
  readonly senderName: string;
  /**
   * The reader's OWN sticker catalog: the image of a catalog id, or `undefined` for an id it does not
   * know (the sticker is drawn as a placeholder). Absent = no catalog: every sticker is a placeholder.
   */
  readonly stickerImageOf?: (stickerId: string) => string | undefined;
  /** The relay's `createdAt` for the envelope (ISO). */
  readonly createdAt: string;
}

/** Separates a sticker's motion and sound presets in the `text` of a STICKER message (the existing wire's form). */
export const STICKER_PRESET_SEPARATOR = '|';
const NO_PRESET = 'none';

/**
 * A reaction read from the room: who (the MLS sender, never the payload) put or took back which emoji
 * on which message. Readers fold these in relay order with `applyE2eeReaction`.
 */
export interface E2eeReactionEvent {
  type: 'e2ee:reaction';
  payload: {
    messageId: string;
    conversationId: string;
    senderId: string;
    reaction: string;
    removed: boolean;
  };
}

/**
 * The reaction set of a message after one reaction event: one row per person and emoji, as the
 * plaintext path keeps it. Anyone in the room may react to any message (no sender check).
 */
export function applyE2eeReaction(
  reactions: readonly MessageReaction[],
  change: E2eeReactionEvent['payload'],
): MessageReaction[] {
  const rest = reactions.filter(
    (r) => !(r.personId === change.senderId && r.reaction === change.reaction),
  );
  return change.removed
    ? rest
    : [...rest, { personId: change.senderId, reaction: change.reaction }];
}

/**
 * The event a decrypted payload means, so the existing reducer draws it. An edit or delete is an
 * event about another message; the reader must apply it only when the target's sender is this
 * payload's sender (`canApplyE2eeChange`), because inside a room anyone can SAY "edit message X".
 * A notice is a SYSTEM message whose `text` is the KEY: the host translates it, if it allows it.
 */
/** A sticker's picture from the READER's catalog; nothing when the catalog does not know the id. */
function stickerImage(
  context: E2eeMessageContext,
  stickerId: string,
): { readonly mediaUrl?: string } {
  const url = context.stickerImageOf?.(stickerId);
  return url === undefined ? {} : { mediaUrl: url };
}

export function e2eePayloadToEvent(
  payload: E2eePayload,
  context: E2eeMessageContext,
): MsgNewEvent | MsgEditedEvent | MsgDeletedEvent | E2eeReactionEvent {
  const { conversationId, senderId, senderName, createdAt } = context;
  switch (payload.kind) {
    case 'text':
      return {
        type: 'msg:new',
        payload: {
          id: payload.id,
          conversationId,
          senderId,
          senderName,
          text: payload.body,
          messageType: 'TEXT',
          ...(payload.replyTo ? { replyToId: payload.replyTo.id } : {}),
          createdAt,
        },
      };
    case 'sticker':
      return {
        type: 'msg:new',
        payload: {
          id: payload.id,
          conversationId,
          senderId,
          senderName,
          text: `${payload.motion ?? NO_PRESET}${STICKER_PRESET_SEPARATOR}${payload.sound ?? NO_PRESET}`,
          messageType: 'STICKER',
          ...stickerImage(context, payload.stickerId),
          ...(payload.replyTo ? { replyToId: payload.replyTo.id } : {}),
          createdAt,
        },
      };
    case 'edit':
      return {
        type: 'msg:edited',
        payload: {
          messageId: payload.targetId,
          conversationId,
          text: payload.body,
          editedAt: createdAt,
        },
      };
    case 'delete':
      return { type: 'msg:deleted', payload: { messageId: payload.targetId, conversationId } };
    case 'reaction':
      return {
        type: 'e2ee:reaction',
        payload: {
          messageId: payload.targetId,
          conversationId,
          senderId,
          reaction: payload.emoji,
          removed: payload.removed === true,
        },
      };
    case 'notice':
      return {
        type: 'msg:new',
        payload: {
          id: payload.id,
          conversationId,
          senderId,
          senderName,
          text: payload.key,
          messageType: 'SYSTEM',
          createdAt,
        },
      };
  }
}

/**
 * Whether an edit or delete may touch its target: only the target's own sender may change it. The
 * relay cannot check this (it cannot read the payload), so every reader does.
 */
export function canApplyE2eeChange(
  change: Pick<E2eeMessageContext, 'senderId'>,
  target: { readonly senderId: string } | undefined,
): boolean {
  return target !== undefined && target.senderId === change.senderId;
}
