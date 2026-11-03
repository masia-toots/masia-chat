// In-memory fakes of every port: what the messenger's own tests run against, and what the contract
// suites prove behave like a real implementation. Subpath: `@masia/contracts/fakes`.

export {
  createFakeAuthSession,
  FAKE_DEVICE_ID,
  FAKE_TOKEN,
  FAKE_USER_ID,
  type FakeAuthSession,
  type FakeAuthSessionOptions,
} from './fake-auth-session.js';
export {
  createFakeTransport,
  FAKE_TRANSPORT_HEALTH_PATH,
  type FakeTransport,
  type FakeTransportCall,
  type FakeTransportOptions,
} from './fake-transport.js';
export { createFakeSecureStorage, type FakeSecureStorage } from './fake-secure-storage.js';
export { createFakePushBridge, type FakePushBridge } from './fake-push-bridge.js';
export {
  createFakeContactsDirectory,
  createFakePresenceDirectory,
  FAKE_ACCEPTED_USER_ID,
  FAKE_DIRECTORY_REFUSALS,
  FAKE_HOME_CIRCLE_ID,
  FAKE_STRANGER_USER_ID,
  type FakeContactsDirectory,
  type FakeContactsDirectoryOptions,
} from './fake-contacts-directory.js';
export { createFakeThemeTokens, FAKE_THEME_TOKENS } from './fake-theme-tokens.js';
export { createFakeIconSet, type FakeIcon } from './fake-icon-set.js';
export { createFakeI18nBundle, FAKE_I18N_STRINGS } from './fake-i18n-bundle.js';
export { createFakeMediaUpload, FAKE_MEDIA_URL_PREFIX } from './fake-media-upload.js';
export {
  createFakeRichAttachment,
  FAKE_ATTACHMENT_KIND,
  type FakeAttachmentNode,
} from './fake-rich-attachment.js';
