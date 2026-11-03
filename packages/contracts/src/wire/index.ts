// `@masia/contracts/wire`: the wire vocabulary of the open messenger, in ONE home. Every client and
// every relay imports these values instead of keeping a copy (architecture review round 1, M14):
// the device roles and the credential layout, the size limits, retention, the MLS profile and the
// conversation-id extension, the AAD frame, the handshake kinds, the cleartext MLS header parser,
// the relay token's claims, the relay's HTTP vocabulary (refusal codes, device-list entries, page
// caps, the key-package upload budget) and the signed device list's canonical encoding with its
// signature check. Pure data, byte decoding and one WebCrypto verification; no dependency.
export * from './vocabulary.js';
export * from './mls-header.js';
export * from './relay-token.js';
export * from './relay-api.js';
export * from './device-list.js';
