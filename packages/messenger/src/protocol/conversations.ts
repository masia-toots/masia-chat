/**
 * The conversation shapes of the inbox, as the current host protocol speaks them.
 *
 * `MessengerConversationPreview` is the row the contact model (`../contacts`) is derived from; it
 * lives with the other wire shapes so the host and the package read one definition.
 */

export type ConversationType = 'AI_CHAT' | 'DIRECT' | 'GROUP' | 'FAMILY';
export type MasiaMode = 'ACTIVE' | 'LISTENING' | 'SILENT';

/** Entity types of the contact model: what one plate in the channel bank stands for. */
export type EntityType = 'MASIA' | 'FAMILY_MEMBER' | 'FAMILY_GROUP' | 'GROUP' | 'CONTACT';

/** Participant preview in a messenger conversation. */
export interface ParticipantPreview {
  personId: string;
  name: string;
  avatarUrl?: string | null;
  /**
   * The person's chosen accent colour (internal ADR-199 §8): a hex of the host's palette, or null = the host
   * derives one from the id. The package never derives it — the host hands the resolved colour to the view.
   */
  accentColor?: string | null;
  type?: string;
  /**
   * The USER behind the participant, when the row carries one (ADR-115, К3).
   * A family member is identified by `personId` — one person per family — but a
   * CONTACT from another family has no person in mine, so the only stable id the
   * two inboxes share is the user's. `getEntityConversations` filters a CONTACT's
   * chats on THIS field; `undefined` for legacy rows that predate the projection.
   */
  userId?: string | null;
}

/** Last message preview in the messenger inbox. */
export interface LastMessagePreview {
  text: string;
  senderName: string;
  createdAt: string;
  /** A plain string, not `MessageType`: a preview must survive a kind this client has never heard of. */
  messageType: string;
  isDeleted: boolean;
}

/** Group preview embedded in conversation data. */
export interface GroupPreview {
  id: string;
  name: string;
  avatarUrl: string | null;
}

/** Conversation preview for the messenger inbox. */
export interface MessengerConversationPreview {
  id: string;
  title: string | null;
  /** True once a user has explicitly renamed the chat. DIRECT chats then show
   *  this shared `title` to both parties instead of the viewer-relative name. */
  titleCustom: boolean;
  type: ConversationType;
  isPrivate: boolean;
  /** ADR-065 surface ② — Masia's live interpreter is on for this conversation. */
  autoTranslate: boolean;
  /** T0-a (2026-09-09) — disappearing-message window in seconds; null = off. One of
   *  `DISAPPEAR_AFTER_SEC_OPTIONS` (`data-retention.ts`). Drives the ⋯ menu's checked
   *  row and the timer glyph beside the chat title. */
  disappearAfterSec?: number | null;
  masiaMode: MasiaMode;
  avatarUrl: string | null;
  groupId: string | null;
  group: GroupPreview | null;
  lastMessage: LastMessagePreview | null;
  /** Unread messages in this room for the requesting person — the host's one number (`unread:update` moves it live). */
  unreadCount: number;
  /** The subset of `unreadCount` that calls the person by name (own `@tag`, `@all`, `@online`). `<= unreadCount`. */
  unreadMentions: number;
  /**
   * The requesting person's mute of this room (ISO instant), or `null` when they never muted it. The room is
   * muted while the instant is in the future; a past instant means «not muted any more». A far-future
   * sentinel means «until unmuted». Mute silences the push and the chip, never the unread count itself.
   */
  mutedUntil: string | null;
  participantCount: number;
  participants: ParticipantPreview[];
  createdAt: string;
  /** canon chat §10 — the pinned primary Masia conversation (one per person). The
   *  backend sorts it to the TOP of the list; the UI renders a pinned affordance. */
  isPrimary?: boolean;
  /** When this conversation was pinned to the top (set for the primary). */
  pinnedAt?: string | null;
  /** canon chat §11 — space keys attached to this chat (incl. `parent:child`). */
  attachedSpaces?: string[];
  /** canon chat §11 — skill slugs attached to this chat. */
  attachedSkills?: string[];
  /** ADR-079 — the family space this chat is HOMED in (the per-space chat), else null.
   *  The chat space-selector matches an existing space chat through this. */
  spaceId?: string | null;
  /**
   * The room's text is end-to-end encrypted (MLS, canon section 9): its messages travel through the
   * relay as ciphertext and are decrypted on the device. Optional: a host that does not send it has
   * no E2EE rooms, and the client keeps the plaintext path (absent = `false`).
   */
  e2ee?: boolean;
  /**
   * The room's MLS group id (canonical base64) once a member recorded it with the host, else `null`.
   * A member that holds no state for the room joins THIS group (and checks it against the Welcome).
   */
  mlsGroupId?: string | null;
  /**
   * Server features that read the text and are off in this room, with one reason and an i18n key the
   * client renders as is. `null` (or absent) when nothing is off: a room that is not end-to-end
   * encrypted. The host owns the reason and feature vocabulary; this package only shows the key.
   */
  plaintextFeaturesOff?: PlaintextFeaturesOffNote | null;
  /**
   * Masia in this room is a GUEST: the room is end-to-end encrypted and no one family's — its people belong to more
   * than one family, or a family's guest or contributor sits among them (a visitor is not the family) — so she
   * answers from the room alone, with no family's knowledge, and the family of the person who switched her on pays. A client says so in the room header while she is in the room (`masiaMode` not `SILENT`). Optional:
   * absent = `false` (a host without guest rooms).
   */
  masiaGuest?: boolean;
}

/** Why server features are off in a room, as the host words it (see `plaintextFeaturesOff`). */
export interface PlaintextFeaturesOffNote {
  readonly reason: string;
  /** An i18n key, with its namespace (`ns:key`), the client translates as is. */
  readonly i18nKey: string;
  readonly features: readonly string[];
}
