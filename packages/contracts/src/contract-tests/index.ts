// One vitest suite per port. A host runs each against its REAL implementation; this package runs
// them against the in-memory fakes. A host change that touches the messenger is mergeable only
// when both are green (ADR-161). Subpath: `@masia/contracts/contract-tests` (needs vitest).

export { secureStorageOutcome, type ContractFactory } from './contract-support.js';
export {
  describeAuthSessionContract,
  type AuthSessionContractHarness,
} from './auth-session.contract.js';
export { describeTransportContract, type TransportContractHarness } from './transport.contract.js';
export {
  describeSecureStorageContract,
  type SecureStorageContractHarness,
} from './secure-storage.contract.js';
export {
  describePushBridgeContract,
  type PushBridgeContractHarness,
} from './push-bridge.contract.js';
export {
  describeContactsDirectoryContract,
  type ContactsDirectoryContractHarness,
} from './contacts-directory.contract.js';
export { describeThemeTokensContract } from './theme-tokens.contract.js';
export { describeIconSetContract } from './icon-set.contract.js';
export { describeI18nBundleContract } from './i18n-bundle.contract.js';
export { describeMediaUploadContract } from './media-upload.contract.js';
export { describeRichAttachmentContract } from './rich-attachment.contract.js';
