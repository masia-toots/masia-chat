import * as wire from '@masia/contracts/wire';
import { describe, expect, it } from 'vitest';
import {
  AAD_ID_LENGTH_PREFIX_BYTES,
  CONVERSATION_ID_EXTENSION_TYPE,
  ID_PATTERN,
  MAX_AAD_EXTRA_BYTES,
  MAX_ADDS_PER_COMMIT,
  MAX_CIPHERTEXT_BYTES,
  MAX_GROUP_ID_BYTES,
  MAX_GROUP_LEAVES,
  MAX_HANDSHAKE_BYTES,
  MAX_ID_BYTES,
  MAX_KEY_PACKAGE_BYTES,
  MLS_CIPHER_SUITE_ID,
  MLS_PROTOCOL_VERSION_ID,
  RELAY_BACKLOG_RETENTION_SECONDS,
} from '../constants.js';
import { CREDENTIAL_IDENTITY_VERSION, DeviceRole, isDeviceRole } from '../credential.js';
import { MlsContentType, MlsSenderType, MlsWireFormat } from '../message-header.js';

/**
 * ONE WIRE VOCABULARY. Until 2026-10-10 the engine kept copies of the relay's header parser, size
 * caps, id alphabet and roles, and `relay-parity.test.ts` loaded the relay's SOURCE through a
 * computed dynamic import to compare them (architecture review round 1, M14). Both sides now import
 * `@masia/contracts/wire`, so comparing two parsers would compare a function with itself: that test
 * is gone, and no test reaches into the relay any more (the boundary guards need no exemption).
 *
 * What is left to check is that the engine's names ARE the contract's values (the same objects, not
 * equal copies), so a future local copy fails here.
 */
describe('the engine speaks the one wire vocabulary (@masia/contracts/wire)', () => {
  it('re-exports the shared limits and the MLS profile instead of copying them', () => {
    expect(MAX_HANDSHAKE_BYTES).toBe(wire.MAX_HANDSHAKE_BYTES);
    expect(MAX_GROUP_ID_BYTES).toBe(wire.MAX_GROUP_ID_BYTES);
    expect(MAX_KEY_PACKAGE_BYTES).toBe(wire.MAX_KEY_PACKAGE_BYTES);
    expect(MAX_CIPHERTEXT_BYTES).toBe(wire.MAX_ENVELOPE_BYTES);
    expect(MAX_ADDS_PER_COMMIT).toBe(wire.MAX_DEVICES_PER_USER);
    expect(MAX_GROUP_LEAVES).toBe(wire.MAX_GROUP_LEAVES);
    expect(MAX_ID_BYTES).toBe(wire.MAX_ID_BYTES);
    expect(ID_PATTERN).toBe(wire.ID_REGEXP);
    expect(RELAY_BACKLOG_RETENTION_SECONDS).toBe(wire.RELAY_BACKLOG_RETENTION_SECONDS);
    expect(MLS_CIPHER_SUITE_ID).toBe(wire.MLS_CIPHER_SUITE_ID);
    expect(MLS_PROTOCOL_VERSION_ID).toBe(wire.MLS_PROTOCOL_VERSION_10);
    expect(CONVERSATION_ID_EXTENSION_TYPE).toBe(wire.CONVERSATION_ID_EXTENSION_TYPE);
    expect(AAD_ID_LENGTH_PREFIX_BYTES).toBe(wire.AAD_ID_LENGTH_PREFIX_BYTES);
    expect(MAX_AAD_EXTRA_BYTES).toBe(wire.MAX_AAD_EXTRA_BYTES);
  });

  it('uses the contract roles, credential version and header enums by reference', () => {
    expect(DeviceRole).toBe(wire.DeviceRole);
    expect(isDeviceRole).toBe(wire.isDeviceRole);
    expect(CREDENTIAL_IDENTITY_VERSION).toBe(wire.CREDENTIAL_IDENTITY_VERSION);
    expect(MlsWireFormat).toBe(wire.MlsWireFormat);
    expect(MlsContentType).toBe(wire.MlsContentType);
    expect(MlsSenderType).toBe(wire.MlsSenderType);
  });
});
