/**
 * ADR-218 §2, §5: the canonical bytes of the identity transfer and the checks the relay makes. The
 * golden vectors were computed by a separate implementation (node:crypto SHA-256 and Ed25519 over the
 * JSON arrays written out by hand from the ADR), so they pin the FORMAT, not this module's output.
 * Every key is derived in the test from a public label: no key material is stored here.
 */
import { describe, expect, it } from 'vitest';
import { decodeBase64, ed25519, encodeBase64 } from '../device-list.js';
import {
  IDENTITY_RESET_TICKET_TTL_MS,
  IDENTITY_TRANSFER_ERRORS,
  IdentityRequestPurpose,
  IdentityTransferError,
  holderStatementBytes,
  identityRebindBytes,
  identityRequestBytes,
  identityTransferAad,
  isIdentityRequestPurpose,
  isPairingNumber,
  PAIRING_CHOICES,
  PAIRING_NUMBER_COUNT,
  PAIRING_NUMBER_DIGITS,
  PAIRING_NUMBER_MIN,
  pairingCommitment,
  pairingNumber,
  verifyHolderProof,
  verifyIdentityRebindSignature,
  verifyIdentityRequestSignature,
  verifyPairingCommitment,
  type IdentityRebindFields,
  type IdentityRequestFields,
  type PairingNumberInput,
} from '../identity-transfer.js';
import { RelayErrorCode } from '../relay-api.js';

// --- Test keys, derived from labels ---------------------------------------------------------------

/** The DER prefix of an Ed25519 PKCS#8 private key (RFC 8410) before its 32-byte seed. */
const ED25519_PKCS8_PREFIX = [
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
];

async function sha256Of(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

function fromBase64Url(text: string): Uint8Array {
  return (
    decodeBase64(text.replace(/-/g, '+').replace(/_/g, '/').padEnd(44, '=')) ?? new Uint8Array()
  );
}

interface TestKey {
  readonly publicKey: Uint8Array;
  readonly sign: (bytes: Uint8Array) => Promise<Uint8Array>;
}

/** An Ed25519 key whose seed is SHA-256(label): the same key in every run and implementation. */
async function keyFromLabel(label: string): Promise<TestKey> {
  const pkcs8 = new Uint8Array([...ED25519_PKCS8_PREFIX, ...(await sha256Of(label))]);
  const privateKey = await crypto.subtle.importKey('pkcs8', pkcs8, ed25519(), true, ['sign']);
  const jwk = await crypto.subtle.exportKey('jwk', privateKey);
  return {
    publicKey: fromBase64Url(jwk.x ?? ''),
    sign: async (bytes) =>
      new Uint8Array(await crypto.subtle.sign(ed25519(), privateKey, new Uint8Array(bytes))),
  };
}

const hex = (text: string) =>
  Uint8Array.from(text.match(/../g) ?? [], (pair) => parseInt(pair, 16));
const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const fill = (value: number, length = 32) => new Uint8Array(length).fill(value);

// --- Golden vectors (ADR-218 § 2 "Formats") -------------------------------------------------------

const GOLDEN = {
  identityPub: 'ea2d356c1d6721199a963c6ee4a04a7e3c2dd99ecd26320fdd62a5382e9a7371',
  devicePub: 'e2c2816fa043f4ce70ed00c87b41188eee8501fa5f0e516ced868f04444dbf2a',
  transferPub: '423c89563bcf61f03bf3894f02041118a9a07709d623a766fe6fb8b61ede4b20',
  commitment: 'a6748576647909a0d1a164968641b70b6644aa8cc26bcdab74b78cd07c46cc86',
  requestPair:
    '["mls-identity-request/v1","alice","dev-new","pair","QjyJVjvPYfA784lPAgQRGKmgdwnWI6dm/m+4th7eSyA=","pnSFdmR5CaDRoWSWhkG3C2ZEqozCa82rdLeM0HxGzIY="]',
  requestBackfill:
    '["mls-identity-request/v1","alice","dev-new","backfill","QjyJVjvPYfA784lPAgQRGKmgdwnWI6dm/m+4th7eSyA=",""]',
  requestSignature:
    'J5hYpk7t2qgLVKHgUlrDfX+6BDy3QceOMkZijoVj4jPgcnzV7P7j3XfvYJ1p5giTFhAqB1UE2TrSdZEhurYBAg==',
  number: 57,
  holderStatement:
    '["mls-identity-holder/v1","alice","dev-new","4sKBb6BD9M5w7QDIe0EYju6FAfpfDlFs7YaPBERNvyo="]',
  holderProof:
    'SNr8vJusS8PJaRkwiDxVgH4CwJm6s6LxqBb/TyEJACkZ/Pqb9NfpqsqJhlUrXEZyNZlB3MuBtGekerhy5D5ZBg==',
  aad: '["mls-identity-transfer/v1","alice","dev-new","4sKBb6BD9M5w7QDIe0EYju6FAfpfDlFs7YaPBERNvyo=","QjyJVjvPYfA784lPAgQRGKmgdwnWI6dm/m+4th7eSyA=","6i01bB1nIRmaljxu5KBKfjwt2Z7NJjIP3WKlOC6ac3E=","7"]',
  resetId: '6f1c2a3b-4d5e-4f60-8a71-92b3c4d5e6f7',
  rebind:
    '["mls-identity-rebind/v1","alice","dev-new","6i01bB1nIRmaljxu5KBKfjwt2Z7NJjIP3WKlOC6ac3E=","6f1c2a3b-4d5e-4f60-8a71-92b3c4d5e6f7"]',
  rebindSignature:
    'QVqgH7jGWIeSJFQbtFye7cVtebe9eABStwA8lS1jm/r1eBS3yURjP23Q/aRJfnt8ZfIqK+XgAQoU8TjkdIOMDQ==',
} as const;

const device = {
  userId: 'alice',
  deviceId: 'dev-new',
  signatureKey: hex(GOLDEN.devicePub),
  transferKey: hex(GOLDEN.transferPub),
};
const deviceNonce = fill(0x11);
const holderNonce = fill(0x22);
const numberInput: PairingNumberInput = {
  ...device,
  identityKey: hex(GOLDEN.identityPub),
  deviceNonce,
  holderNonce,
};
const pairRequest: IdentityRequestFields = {
  userId: 'alice',
  deviceId: 'dev-new',
  purpose: IdentityRequestPurpose.PAIR,
  transferKey: device.transferKey,
  commitment: hex(GOLDEN.commitment),
};

function codeOf(action: () => unknown): string | null {
  try {
    action();
    return null;
  } catch (error) {
    return error instanceof IdentityTransferError ? error.code : 'NOT_AN_IDENTITY_TRANSFER_ERROR';
  }
}

describe('the test keys', () => {
  it('derive the golden public keys, so the vectors below are reproducible from the labels', async () => {
    expect(toHex((await keyFromLabel('mls-golden/identity')).publicKey)).toBe(GOLDEN.identityPub);
    expect(toHex((await keyFromLabel('mls-golden/device')).publicKey)).toBe(GOLDEN.devicePub);
  });
});

describe('the constants the founder chose (2026-11-17)', () => {
  it('is a 2-digit number picked among 3 choices, 10 to 99', () => {
    expect(PAIRING_NUMBER_DIGITS).toBe(2);
    expect(PAIRING_CHOICES).toBe(3);
    expect(PAIRING_NUMBER_MIN).toBe(10);
    expect(PAIRING_NUMBER_COUNT).toBe(90);
    expect([9, 10, 99, 100, 10.5, '42', null].map(isPairingNumber)).toEqual([
      false,
      true,
      true,
      false,
      false,
      false,
      false,
    ]);
  });

  it('knows the two purposes and nothing else', () => {
    expect(['pair', 'backfill', 'PAIR', 'toString', ''].map(isIdentityRequestPurpose)).toEqual([
      true,
      true,
      false,
      false,
      false,
    ]);
  });

  it('names the refusals ADR-218 adds to the relay vocabulary', () => {
    expect(RelayErrorCode).toMatchObject({
      IDENTITY_REQUEST_LIMIT: 'IDENTITY_REQUEST_LIMIT',
      IDENTITY_REQUEST_STATE: 'IDENTITY_REQUEST_STATE',
      IDENTITY_REQUEST_SIGNATURE_INVALID: 'IDENTITY_REQUEST_SIGNATURE_INVALID',
      HOLDER_PROOF_INVALID: 'HOLDER_PROOF_INVALID',
      NOT_A_HOLDER: 'NOT_A_HOLDER',
      IDENTITY_RESET_PENDING: 'IDENTITY_RESET_PENDING',
      IDENTITY_REBIND_PROOF_REQUIRED: 'IDENTITY_REBIND_PROOF_REQUIRED',
    });
  });

  it('keeps an operator reset ticket open for one day (ADR-218 §6)', () => {
    expect(IDENTITY_RESET_TICKET_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });
});

describe('identityRequestBytes and verifyIdentityRequestSignature', () => {
  it('are the golden bytes for pair and for backfill', () => {
    expect(text(identityRequestBytes(pairRequest))).toBe(GOLDEN.requestPair);
    expect(
      text(
        identityRequestBytes({
          ...pairRequest,
          purpose: IdentityRequestPurpose.BACKFILL,
          commitment: undefined,
        }),
      ),
    ).toBe(GOLDEN.requestBackfill);
  });

  it('accepts the golden signature of the device key, and the same signature made here', async () => {
    const deviceKey = await keyFromLabel('mls-golden/device');
    const signature = await deviceKey.sign(identityRequestBytes(pairRequest));
    expect(encodeBase64(signature)).toBe(GOLDEN.requestSignature);
    expect(await verifyIdentityRequestSignature(device.signatureKey, pairRequest, signature)).toBe(
      true,
    );
  });

  it('refuses another key, any changed field, and anything malformed, as false', async () => {
    const signature = decodeBase64(GOLDEN.requestSignature) ?? new Uint8Array();
    const other = await keyFromLabel('mls-golden/someone-else');
    const changed: IdentityRequestFields[] = [
      { ...pairRequest, userId: 'bob' },
      { ...pairRequest, deviceId: 'dev-other' },
      { ...pairRequest, transferKey: fill(0x33) },
      { ...pairRequest, commitment: fill(0x44) },
      { ...pairRequest, purpose: IdentityRequestPurpose.BACKFILL, commitment: undefined },
      { ...pairRequest, commitment: undefined },
    ];
    expect(await verifyIdentityRequestSignature(other.publicKey, pairRequest, signature)).toBe(
      false,
    );
    for (const fields of changed) {
      expect(await verifyIdentityRequestSignature(device.signatureKey, fields, signature)).toBe(
        false,
      );
    }
    expect(
      await verifyIdentityRequestSignature(device.signatureKey, pairRequest, signature.subarray(1)),
    ).toBe(false);
    expect(await verifyIdentityRequestSignature(fill(0, 31), pairRequest, signature)).toBe(false);
  });

  it('throws MALFORMED for a request it cannot encode', () => {
    const malformed: IdentityRequestFields[] = [
      { ...pairRequest, commitment: undefined },
      { ...pairRequest, purpose: IdentityRequestPurpose.BACKFILL },
      { ...pairRequest, purpose: 'PAIR' as IdentityRequestFields['purpose'] },
      { ...pairRequest, transferKey: fill(1, 31) },
      { ...pairRequest, commitment: fill(1, 33) },
      { ...pairRequest, userId: 'al:ice' },
      { ...pairRequest, deviceId: '' },
    ];
    for (const fields of malformed) {
      expect(codeOf(() => identityRequestBytes(fields))).toBe(IDENTITY_TRANSFER_ERRORS.MALFORMED);
    }
  });
});

describe('pairingCommitment and verifyPairingCommitment', () => {
  it('is the golden SHA-256 of N, its keys and r_N', async () => {
    expect(toHex(await pairingCommitment({ ...device, deviceNonce }))).toBe(GOLDEN.commitment);
  });

  it('opens only with the nonce, the device and the keys it was made with', async () => {
    const commitment = hex(GOLDEN.commitment);
    expect(await verifyPairingCommitment({ ...device, deviceNonce }, commitment)).toBe(true);
    for (const input of [
      { ...device, deviceNonce: holderNonce },
      { ...device, deviceNonce, transferKey: fill(0x33) },
      { ...device, deviceNonce, signatureKey: fill(0x55) },
      { ...device, deviceNonce, deviceId: 'dev-other' },
      { ...device, deviceNonce, userId: 'bob' },
    ]) {
      expect(await verifyPairingCommitment(input, commitment)).toBe(false);
    }
    expect(await verifyPairingCommitment({ ...device, deviceNonce }, commitment.subarray(1))).toBe(
      false,
    );
    expect(await verifyPairingCommitment({ ...device, deviceNonce: fill(1, 16) }, commitment)).toBe(
      false,
    );
  });
});

describe('pairingNumber', () => {
  it('is the golden number', async () => {
    expect(await pairingNumber(numberInput)).toBe(GOLDEN.number);
  });

  /** The numbers of 24 holder nonces: two inputs that differ in a covered field give other sequences. */
  async function sequence(override: Partial<PairingNumberInput>): Promise<number[]> {
    return Promise.all(
      Array.from({ length: 24 }, (_, index) =>
        pairingNumber({ ...numberInput, ...override, holderNonce: fill(index) }),
      ),
    );
  }

  it('covers N, its signature and transfer keys, the identity key and both nonces', async () => {
    const base = await sequence({});
    const others = await Promise.all([
      sequence({ userId: 'bob' }),
      sequence({ deviceId: 'dev-other' }),
      sequence({ signatureKey: fill(0x55) }),
      sequence({ transferKey: fill(0x33) }),
      sequence({ identityKey: fill(0x66) }),
      sequence({ deviceNonce: fill(0x77) }),
    ]);
    for (const other of others) expect(other).not.toEqual(base);
    // ...and r_B itself: 24 different holder nonces do not give one number.
    expect(new Set(base).size).toBeGreaterThan(1);
  });

  it('throws MALFORMED for a key or nonce of the wrong size', async () => {
    for (const input of [
      { ...numberInput, identityKey: fill(1, 31) },
      { ...numberInput, holderNonce: fill(1, 16) },
      { ...numberInput, deviceNonce: fill(1, 33) },
    ]) {
      await expect(pairingNumber(input)).rejects.toMatchObject({
        code: IDENTITY_TRANSFER_ERRORS.MALFORMED,
      });
    }
  });

  it('spreads evenly over 10..99 (chi-squared over 100 000 holder nonces)', async () => {
    const draws = 100_000;
    const counts = new Array<number>(PAIRING_NUMBER_COUNT).fill(0);
    const nonce = (index: number) => {
      const bytes = new Uint8Array(32);
      new DataView(bytes.buffer).setUint32(0, index);
      return bytes;
    };
    const batch = 5_000;
    let outOfRange = 0;
    for (let start = 0; start < draws; start += batch) {
      const numbers = await Promise.all(
        Array.from({ length: batch }, (_, offset) =>
          pairingNumber({ ...numberInput, holderNonce: nonce(start + offset) }),
        ),
      );
      for (const number of numbers) {
        if (!isPairingNumber(number)) outOfRange += 1;
        else counts[number - PAIRING_NUMBER_MIN] = (counts[number - PAIRING_NUMBER_MIN] ?? 0) + 1;
      }
    }
    expect(outOfRange).toBe(0);
    const expected = draws / PAIRING_NUMBER_COUNT;
    const chiSquared = counts.reduce((sum, count) => sum + (count - expected) ** 2 / expected, 0);
    // 89 degrees of freedom: the critical value at p = 0.001 is about 136.0. The inputs are fixed, so
    // the test is deterministic; a mapping that skews or drops numbers lands far above it. 100 000
    // SHA-256 draws (ADR-218 test plan) are why this one test is allowed past 2 s.
    expect(chiSquared).toBeLessThan(136);
    expect(counts.every((count) => count > 0)).toBe(true);
  }, 20_000);
});

describe('holderStatementBytes and verifyHolderProof', () => {
  it('is the golden statement, and the golden proof of the identity key verifies under it', async () => {
    const identity = await keyFromLabel('mls-golden/identity');
    const statement = holderStatementBytes(device);
    expect(text(statement)).toBe(GOLDEN.holderStatement);
    const proof = await identity.sign(statement);
    expect(encodeBase64(proof)).toBe(GOLDEN.holderProof);
    expect(await verifyHolderProof(identity.publicKey, device, proof)).toBe(true);
  });

  it('refuses a proof under another key, of another device, or malformed, as false', async () => {
    const proof = decodeBase64(GOLDEN.holderProof) ?? new Uint8Array();
    const identityKey = hex(GOLDEN.identityPub);
    const stranger = await keyFromLabel('mls-golden/someone-else');
    expect(await verifyHolderProof(stranger.publicKey, device, proof)).toBe(false);
    expect(await verifyHolderProof(identityKey, { ...device, deviceId: 'dev-other' }, proof)).toBe(
      false,
    );
    expect(await verifyHolderProof(identityKey, { ...device, userId: 'bob' }, proof)).toBe(false);
    expect(
      await verifyHolderProof(identityKey, { ...device, signatureKey: fill(0x55) }, proof),
    ).toBe(false);
    expect(await verifyHolderProof(identityKey, device, proof.subarray(1))).toBe(false);
    expect(await verifyHolderProof(fill(0, 31), device, proof)).toBe(false);
    expect(await verifyHolderProof(identityKey, { ...device, deviceId: 'a/b' }, proof)).toBe(false);
  });

  it('a proof made with the DEVICE key is not a holder proof', async () => {
    const deviceKey = await keyFromLabel('mls-golden/device');
    const forged = await deviceKey.sign(holderStatementBytes(device));
    expect(await verifyHolderProof(hex(GOLDEN.identityPub), device, forged)).toBe(false);
  });
});

describe('identityRebindBytes and verifyIdentityRebindSignature (ADR-218 §6)', () => {
  const rebind: IdentityRebindFields = {
    userId: 'alice',
    deviceId: 'dev-new',
    identityKey: hex(GOLDEN.identityPub),
    resetId: GOLDEN.resetId,
  };

  it('is the golden statement, and the golden signature of the device key verifies under it', async () => {
    expect(text(identityRebindBytes(rebind))).toBe(GOLDEN.rebind);
    const deviceKey = await keyFromLabel('mls-golden/device');
    const signature = await deviceKey.sign(identityRebindBytes(rebind));
    expect(encodeBase64(signature)).toBe(GOLDEN.rebindSignature);
    expect(await verifyIdentityRebindSignature(device.signatureKey, rebind, signature)).toBe(true);
  });

  it('refuses another key, any changed field, and anything malformed, as false', async () => {
    const signature = decodeBase64(GOLDEN.rebindSignature) ?? new Uint8Array();
    const identity = await keyFromLabel('mls-golden/identity');
    // The identity key itself is not the device: only the device key the relay registered counts.
    expect(await verifyIdentityRebindSignature(identity.publicKey, rebind, signature)).toBe(false);
    const changed: IdentityRebindFields[] = [
      { ...rebind, userId: 'bob' },
      { ...rebind, deviceId: 'dev-other' },
      { ...rebind, identityKey: fill(0x66) },
      { ...rebind, resetId: '00000000-0000-4000-8000-000000000000' },
      { ...rebind, resetId: 'not a reset' },
      { ...rebind, identityKey: fill(1, 31) },
    ];
    for (const fields of changed) {
      expect(await verifyIdentityRebindSignature(device.signatureKey, fields, signature)).toBe(
        false,
      );
    }
    expect(
      await verifyIdentityRebindSignature(device.signatureKey, rebind, signature.subarray(1)),
    ).toBe(false);
    expect(await verifyIdentityRebindSignature(fill(0, 31), rebind, signature)).toBe(false);
  });

  it('a request signature is not a rebind signature: the formats never collide', async () => {
    const requestSignature = decodeBase64(GOLDEN.requestSignature) ?? new Uint8Array();
    expect(await verifyIdentityRebindSignature(device.signatureKey, rebind, requestSignature)).toBe(
      false,
    );
  });

  it('throws MALFORMED for a statement it cannot encode', () => {
    for (const fields of [
      { ...rebind, resetId: '' },
      { ...rebind, userId: 'al:ice' },
      { ...rebind, identityKey: fill(1, 33) },
    ]) {
      expect(codeOf(() => identityRebindBytes(fields))).toBe(IDENTITY_TRANSFER_ERRORS.MALFORMED);
    }
  });
});

describe('identityTransferAad', () => {
  const binding = { ...device, identityKey: hex(GOLDEN.identityPub), listVersion: 7 };

  it('is the golden aad', () => {
    expect(text(identityTransferAad(binding))).toBe(GOLDEN.aad);
  });

  it('throws MALFORMED for a list version below 1 or not an integer, and for bad sizes', () => {
    for (const bad of [
      { ...binding, listVersion: 0 },
      { ...binding, listVersion: 1.5 },
      { ...binding, identityKey: fill(1, 31) },
      { ...binding, transferKey: fill(1, 33) },
      { ...binding, signatureKey: new Uint8Array() },
    ]) {
      expect(codeOf(() => identityTransferAad(bad))).toBe(IDENTITY_TRANSFER_ERRORS.MALFORMED);
    }
  });
});
