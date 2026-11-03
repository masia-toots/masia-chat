// Every contract suite, run against its in-memory fake. This is what proves the fakes behave like
// a real implementation would; the host runs the SAME suites against its real ones.

import {
  describeAuthSessionContract,
  describeContactsDirectoryContract,
  describeI18nBundleContract,
  describeIconSetContract,
  describeMediaUploadContract,
  describePushBridgeContract,
  describeRichAttachmentContract,
  describeSecureStorageContract,
  describeThemeTokensContract,
  describeTransportContract,
} from '../contract-tests/index.js';
import {
  createFakeAuthSession,
  createFakeContactsDirectory,
  createFakeI18nBundle,
  createFakeIconSet,
  createFakeMediaUpload,
  createFakePushBridge,
  createFakeRichAttachment,
  createFakeSecureStorage,
  createFakeThemeTokens,
  createFakeTransport,
  FAKE_ACCEPTED_USER_ID,
  FAKE_STRANGER_USER_ID,
  FAKE_TRANSPORT_HEALTH_PATH,
} from '../fakes/index.js';

const FAKE = 'in-memory fake';

describeAuthSessionContract(FAKE, () => createFakeAuthSession(), {
  triggerChange: (session) => session.setAuthenticated(false),
});

describeTransportContract(FAKE, () => createFakeTransport(), {
  probePath: FAKE_TRANSPORT_HEALTH_PATH,
  publish: (transport, topic, bytes) => transport.publish(topic, bytes),
});

// The fake is one in-memory map: one writer by construction, so no `secondWriter`.
describeSecureStorageContract(FAKE, () => createFakeSecureStorage(), {
  makeUnreachable: (storage) => storage.failWith('unavailable'),
  corrupt: (storage, key) => storage.corrupt(key),
});

describePushBridgeContract(FAKE, () => createFakePushBridge(), {
  push: (bridge, p) => bridge.push(p),
});

describeContactsDirectoryContract(FAKE, () => createFakeContactsDirectory(), {
  acceptedUserId: FAKE_ACCEPTED_USER_ID,
  strangerUserId: FAKE_STRANGER_USER_ID,
  strangerSearchQuery: FAKE_STRANGER_USER_ID,
  receiveRequest: (directory, fromUserId) => directory.receiveRequest(fromUserId),
});

describeThemeTokensContract(FAKE, () => createFakeThemeTokens());

describeIconSetContract(FAKE, () => createFakeIconSet());

describeI18nBundleContract(FAKE, () => createFakeI18nBundle());

describeMediaUploadContract(FAKE, () => createFakeMediaUpload());

describeRichAttachmentContract(FAKE, () => createFakeRichAttachment());
