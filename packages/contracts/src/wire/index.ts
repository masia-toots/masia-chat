// `@masia/contracts/wire`: the wire vocabulary of the open messenger, in ONE home. Every client and
// every relay imports these values instead of keeping a copy (architecture review round 1, M14):
// the device roles and the credential layout, the size limits, retention, the MLS profile and the
// conversation-id extension, the AAD frame, the handshake kinds, the cleartext MLS header parser,
// the relay token's claims, the relay's HTTP vocabulary (refusal codes, device-list entries, page
// caps, the key-package upload budget) and the signed device list's canonical encoding with its
// signature check, the identity transfer's canonical bytes with its checks (ADR-218), and the 1:1
// audio call's `call:*` contract with its fingerprint tag (ADR-211). Pure data, byte decoding,
// SHA-256, WebCrypto Ed25519 verification and HMAC-SHA256; no dependency.
export * from './vocabulary.js';
export * from './mls-header.js';
export * from './relay-token.js';
export * from './relay-api.js';
export * from './device-list.js';
export * from './identity-transfer.js';
export * from './call-signal.js';
export * from './call-verify-tag.js';
