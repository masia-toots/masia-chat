/**
 * The messenger's MLS engine (internal ADR-117, summarised in docs/adr/0001). Import it as
 * `@masia/messenger/mls`.
 *
 * Everything the rest of the messenger may depend on is the `MlsEngine` interface and its data
 * types; `createTsMlsEngine` is the one implementation (over `ts-mls@1.6.4`). The validator, the
 * framing helpers and the header parser are internal: they are not exported here, and the tests
 * import them by path.
 */
export {
  DeviceRole,
  MlsEngineError,
  MlsEngineErrorCode,
  type AddedMember,
  type AddInput,
  type AddResult,
  type AdoptPendingCommitResult,
  type CreateGroupInput,
  type CreateGroupResult,
  type DecryptResult,
  type DeviceDirectory,
  type DeviceIdentity,
  type DeviceKeys,
  type EncryptResult,
  type GroupState,
  type GuardianPolicy,
  type JoinFromWelcomeInput,
  type JoinFromWelcomeResult,
  type KeyPackageBundle,
  type ListedDevice,
  type MemberDelta,
  type MemberView,
  type MlsEngine,
  type MlsEngineContext,
  type OwnCommitResult,
  type PendingCommit,
  type ProcessCommitInput,
  type ProcessCommitResult,
  type RemoveInput,
  type RemoveResult,
  type SelfUpdateResult,
  type SigningKeyPair,
  type VerifiedDeviceList,
} from './mls-engine.js';
export {
  DIRECTORY_TIMEOUT_MS,
  KEY_PACKAGE_LIFETIME_SECONDS,
  KEY_PACKAGE_MIN_REMAINING_SECONDS,
  RELAY_BACKLOG_RETENTION_SECONDS,
} from './constants.js';
export { createTsMlsEngine } from './ts-mls-engine.js';
export { decodeCredentialIdentity, encodeCredentialIdentity } from './credential.js';
export {
  APPROVAL_CODE_DIGITS,
  deviceApprovalCode,
  formatApprovalCode,
  parseApprovalCode,
} from './approval-code.js';
export {
  DEVICE_LIST_ERRORS,
  DEVICE_LIST_FORMAT,
  DeviceListError,
  deviceListSigningBytes,
  generateIdentityKeyPair,
  signDeviceList,
  verifyDeviceList,
  type DeviceListErrorCode,
  type DeviceListPin,
  type SignedDeviceList,
} from './device-list.js';
