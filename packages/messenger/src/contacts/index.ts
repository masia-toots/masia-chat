/**
 * The contacts side of the messenger: the pure model that turns an inbox into a channel bank, and the
 * hooks that own the circles, requests and groups, read and written through `ContactsDirectory`.
 */
export {
  bankSections,
  buildContacts,
  contactRouteKey,
  contactUnread,
  decodeContactKey,
  getEntityConversations,
  pinnedContactKeys,
  recencySnapshot,
  recentWindow,
  seatContacts,
  type BankSections,
  type ContactKind,
  type ContactLite,
  type FamilyMembership,
  type FamilyMemberLite,
  type GroupLite,
  type MessengerContact,
} from './contact-model.js';
export {
  CONTACT_SEARCH_DEBOUNCE_MS,
  CONTACT_SEARCH_MIN,
  splitByCircle,
  useContactCircles,
  type Circle,
  type CircleMember,
  type CircleWriteResult,
  type Contact,
  type ContactCircles,
  type ContactRequest,
  type ContactRequests,
  type RequestUser,
  type UseContactCirclesOptions,
  type UserSearchHit,
} from './use-contact-circles.js';
export {
  parseSeedContacts,
  SEED_CONTACTS_MAX,
  SEED_CONTACTS_TEXT,
  SEED_NAME_MAX,
  seedContactLinks,
  seedContactsText,
  type SeedContact,
  type SeedContactsText,
} from './seed-contacts.js';
export {
  GROUP_NAME_MAX,
  useGroups,
  type Group,
  type GroupMember,
  type Groups,
  type UseGroupsOptions,
} from './use-groups.js';
