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
  unreadCount: number;
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
}

/** Why server features are off in a room, as the host words it (see `plaintextFeaturesOff`). */
export interface PlaintextFeaturesOffNote {
  readonly reason: string;
  /** An i18n key, with its namespace (`ns:key`), the client translates as is. */
  readonly i18nKey: string;
  readonly features: readonly string[];
}
