// The ports: the ONLY surface the open messenger and relay share with the host application.
// Fakes live behind `@masia/contracts/fakes` and the contract suites behind
// `@masia/contracts/contract-tests`, so the runtime barrel never pulls in vitest.

export type { AuthSession, AuthSessionState } from './ports/auth-session.js';
export {
  DEFAULT_TRANSPORT_METHOD,
  TRANSPORT_METHODS,
  type Transport,
  type TransportMethod,
  type TransportRequest,
  type TransportResponse,
} from './ports/transport.js';
export {
  isSecureStorageError,
  isStorageClass,
  SECURE_STORAGE_ERROR_KINDS,
  SECURE_STORAGE_ERROR_MESSAGES,
  SECURE_STORAGE_MAX_KEY_CHARS,
  SECURE_STORAGE_MAX_VALUE_BYTES,
  SecureStorageError,
  STORAGE_CLASSES,
  type SecureStorage,
  type SecureStorageErrorKind,
  type StorageClass,
} from './ports/secure-storage.js';
export type { GenericPush, PushBridge } from './ports/push-bridge.js';
export {
  CONTACT_REQUEST_ACTIONS,
  type ContactRequestAction,
  type ContactRequestDirection,
  type ContactRequestParentApproval,
  type ContactRequestStatus,
  type ContactsDirectory,
  type DirectoryCircle,
  type DirectoryCircleMember,
  type DirectoryContact,
  type DirectoryGroup,
  type DirectoryGroupMember,
  type DirectoryGroupRole,
  type DirectoryPerson,
  type DirectoryRequest,
  type DirectoryRequests,
  type DirectoryRequestUser,
  type DirectoryUserHit,
  type DirectoryWriteResult,
  type PresenceDirectory,
  type ResolvedDisplay,
} from './ports/contacts-directory.js';
export { THEME_TOKEN_NAMES, type ThemeTokenName, type ThemeTokens } from './ports/theme-tokens.js';
export { MESSENGER_ICON_NAMES, type IconSet, type MessengerIconName } from './ports/icon-set.js';
export {
  MESSENGER_I18N_KEYS,
  MESSENGER_LANGS,
  type I18nBundle,
  type MessengerI18nKey,
  type MessengerLang,
} from './ports/i18n-bundle.js';
export type { MediaReader, MediaUpload, UploadedMedia } from './ports/media-upload.js';
export type { RichAttachment } from './ports/rich-attachment.js';
