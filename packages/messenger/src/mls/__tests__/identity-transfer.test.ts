/**
 * ADR-218 §1, §2: the client half of the identity transfer. HPKE seal and open of the identity key
 * to a one-time key, the refusal of a key that does not verify under the pin, the request and holder
 * signatures, and the decoys of the number sheet.
 *
 * The known-answer blob below was sealed by `@hpke/core` called directly (not through this module)
 * with `info` and aad written out by hand from the ADR, to the transfer key derived from the label
 * `mls-golden/transfer`. The other golden vectors of the format live in
 * `@masia/contracts` `src/wire/__tests__/identity-transfer.test.ts`; the inputs here are the same.
 * Every key is derived in the test from a public label or generated fresh: no key material is stored.
 */
import {
  decodeBase64,
  encodeBase64,
  IDENTITY_KEY_PKCS8_MAX_BYTES,
  IDENTITY_TRANSFER_ERRORS,
  IdentityRequestPurpose,
  type IdentityTransferBinding,
  IdentityTransferError,
  isPairingNumber,
  PAIRING_CHOICES,
  PAIRING_NONCE_BYTES,
  PAIRING_NUMBER_COUNT,
  PAIRING_NUMBER_MIN,
  pairingCommitment,
  verifyHolderProof,
  verifyIdentityRebindSignature,
  verifyIdentityRequestSignature,
} from '@masia/contracts/wire';
import { getCiphersuiteFromName, getCiphersuiteImpl } from 'ts-mls';
import { describe, expect, it } from 'vitest';
import { MLS_CIPHER_SUITE_NAME } from '../constants.js';
import { generateIdentityKeyPair } from '../device-list.js';
import {
  createPairingNonce,
  createTransferKeyPair,
  openIdentity,
  pairingChoices,
  sealIdentity,
  signHolderProof,
  signIdentityRebind,
  signIdentityRequest,
  type SealedIdentity,
} from '../identity-transfer.js';

/** The DER prefix of an Ed25519 PKCS#8 private key (RFC 8410) before its 32-byte seed. */
const ED25519_PKCS8_PREFIX = [
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
];

async function sha256Of(label: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(label)));
}

/** The Ed25519 key whose seed is SHA-256(label): its seed, its PKCS#8 and its raw public key. */
async function keyFromLabel(
  label: string,
): Promise<{ seed: Uint8Array; pkcs8: Uint8Array; publicKey: Uint8Array }> {
  const seed = await sha256Of(label);
  const pkcs8 = new Uint8Array([...ED25519_PKCS8_PREFIX, ...seed]);
  const key = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, true, ['sign']);
  const jwk = await crypto.subtle.exportKey('jwk', key);
  const x = (jwk.x ?? '').replace(/-/g, '+').replace(/_/g, '/').padEnd(44, '=');
  return { seed, pkcs8, publicKey: decodeBase64(x) ?? new Uint8Array() };
}

const fill = (value: number, length = 32) => new Uint8Array(length).fill(value);

async function suite() {
  return getCiphersuiteImpl(getCiphersuiteFromName(MLS_CIPHER_SUITE_NAME));
}

async function codeOf(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    return error instanceof IdentityTransferError ? error.code : 'NOT_AN_IDENTITY_TRANSFER_ERROR';
  }
}

/** A fresh pairing: the person's identity key (B holds it), N's device key and N's transfer key. */
async function freshPairing() {
  const identity = await generateIdentityKeyPair();
  const transfer = await createTransferKeyPair();
  const binding: IdentityTransferBinding = {
    userId: 'alice',
    deviceId: 'dev-new',
    signatureKey: (await (await suite()).signature.keygen()).publicKey,
    transferKey: transfer.publicKey,
    identityKey: identity.publicKey,
    listVersion: 3,
  };
  return { identity, transfer, binding };
}

describe('createTransferKeyPair and createPairingNonce', () => {
  it('give a fresh 32-byte X25519 pair and a fresh nonce on every call', async () => {
    const [a, b] = await Promise.all([createTransferKeyPair(), createTransferKeyPair()]);
    expect(a.publicKey).toHaveLength(32);
    expect(a.privateKey).toHaveLength(32);
    expect(encodeBase64(a.publicKey)).not.toBe(encodeBase64(b.publicKey));
    const [r1, r2] = [createPairingNonce(), createPairingNonce()];
    expect(r1).toHaveLength(PAIRING_NONCE_BYTES);
    expect(encodeBase64(r1)).not.toBe(encodeBase64(r2));
  });
});

describe('sealIdentity and openIdentity', () => {
  it('round-trips the identity key, and the opened key comes with a holder proof the pin accepts', async () => {
    const { identity, transfer, binding } = await freshPairing();
    const sealed = await sealIdentity(binding, identity.privateKeyPkcs8);
    const opened = await openIdentity(binding, transfer.privateKey, sealed);
    expect(encodeBase64(opened.privateKeyPkcs8)).toBe(encodeBase64(identity.privateKeyPkcs8));
    expect(await verifyHolderProof(identity.publicKey, binding, opened.holderProof)).toBe(true);
    // The ciphertext is not the key.
    expect(encodeBase64(sealed.ciphertext)).not.toContain(
      encodeBase64(identity.privateKeyPkcs8).slice(0, 16),
    );
  });

  it('opens the golden blob, sealed outside this module with the ADR info and aad', async () => {
    const identity = await keyFromLabel('mls-golden/identity');
    const device = await keyFromLabel('mls-golden/device');
    const { hpke } = await suite();
    const transfer = await hpke.deriveKeyPair(await sha256Of('mls-golden/transfer'));
    const binding: IdentityTransferBinding = {
      userId: 'alice',
      deviceId: 'dev-new',
      signatureKey: device.publicKey,
      transferKey: await hpke.exportPublicKey(transfer.publicKey),
      identityKey: identity.publicKey,
      listVersion: 7,
    };
    const golden: SealedIdentity = {
      enc: decodeBase64('zVRsSjIno8d5bWLVjfPklwgD3bbt4/EWaro8zORUEC0=') ?? new Uint8Array(),
      ciphertext:
        decodeBase64(
          '7Ym1HWbQ18Y8GmCOtAWOqKbLoHAq7YvbSWg+bWwa+3cmrYudgeSuSrJSMX+DDC4JmwgnDkSFiZ1PZyDijEXpVQ==',
        ) ?? new Uint8Array(),
    };
    const opened = await openIdentity(
      binding,
      await hpke.exportPrivateKey(transfer.privateKey),
      golden,
    );
    expect(encodeBase64(opened.privateKeyPkcs8)).toBe(encodeBase64(identity.pkcs8));
    // Ed25519 is deterministic: the proof is the golden holder proof of the contracts vectors.
    expect(encodeBase64(opened.holderProof)).toBe(
      'SNr8vJusS8PJaRkwiDxVgH4CwJm6s6LxqBb/TyEJACkZ/Pqb9NfpqsqJhlUrXEZyNZlB3MuBtGekerhy5D5ZBg==',
    );
  });

  it('fails to open when ANY field of the aad changes', async () => {
    const { identity, transfer, binding } = await freshPairing();
    const sealed = await sealIdentity(binding, identity.privateKeyPkcs8);
    const other = await generateIdentityKeyPair();
    const changed: IdentityTransferBinding[] = [
      { ...binding, userId: 'bob' },
      { ...binding, deviceId: 'dev-other' },
      { ...binding, signatureKey: fill(0x55) },
      { ...binding, transferKey: (await createTransferKeyPair()).publicKey },
      { ...binding, identityKey: other.publicKey },
      { ...binding, listVersion: binding.listVersion + 1 },
    ];
    for (const wrong of changed) {
      expect(await codeOf(openIdentity(wrong, transfer.privateKey, sealed))).toBe(
        IDENTITY_TRANSFER_ERRORS.INVALID,
      );
    }
    // ...and the unchanged binding still opens it.
    await expect(openIdentity(binding, transfer.privateKey, sealed)).resolves.toBeDefined();
  });

  it('fails with another transfer key, and on a tampered blob', async () => {
    const { identity, transfer, binding } = await freshPairing();
    const sealed = await sealIdentity(binding, identity.privateKeyPkcs8);
    const flip = (bytes: Uint8Array) => {
      const copy = new Uint8Array(bytes);
      copy[copy.length - 1] = (copy[copy.length - 1] ?? 0) ^ 1;
      return copy;
    };
    const attempts: Array<[Uint8Array, SealedIdentity]> = [
      [(await createTransferKeyPair()).privateKey, sealed],
      [transfer.privateKey, { ...sealed, ciphertext: flip(sealed.ciphertext) }],
      [transfer.privateKey, { ...sealed, enc: flip(sealed.enc) }],
      [transfer.privateKey, { ...sealed, ciphertext: sealed.ciphertext.subarray(1) }],
    ];
    for (const [privateKey, blob] of attempts) {
      expect(await codeOf(openIdentity(binding, privateKey, blob))).toBe(
        IDENTITY_TRANSFER_ERRORS.INVALID,
      );
    }
  });

  it('refuses a key that does not verify under the pinned identity key, though it opens', async () => {
    // A relay (or a confused holder) seals SOME key to N with the right binding: the blob opens, but
    // the key is not the one N's number covered.
    const { transfer, binding } = await freshPairing();
    const impostor = await generateIdentityKeyPair();
    const sealed = await sealIdentity(binding, impostor.privateKeyPkcs8);
    expect(await codeOf(openIdentity(binding, transfer.privateKey, sealed))).toBe(
      IDENTITY_TRANSFER_ERRORS.INVALID,
    );
    // Bytes that are no Ed25519 PKCS#8 at all are refused the same way.
    const garbage = await sealIdentity(binding, fill(0x42, 48));
    expect(await codeOf(openIdentity(binding, transfer.privateKey, garbage))).toBe(
      IDENTITY_TRANSFER_ERRORS.INVALID,
    );
  });

  it('refuses to seal a key of a size no identity key has, or to a binding the aad cannot encode', async () => {
    const { identity, binding } = await freshPairing();
    for (const attempt of [
      sealIdentity(binding, new Uint8Array()),
      sealIdentity(binding, fill(1, IDENTITY_KEY_PKCS8_MAX_BYTES + 1)),
      sealIdentity({ ...binding, listVersion: 0 }, identity.privateKeyPkcs8),
      sealIdentity({ ...binding, transferKey: fill(1, 31) }, identity.privateKeyPkcs8),
    ]) {
      expect(await codeOf(attempt)).toBe(IDENTITY_TRANSFER_ERRORS.MALFORMED);
    }
  });
});

describe('signIdentityRequest, signIdentityRebind and signHolderProof', () => {
  it('signs the request with the MLS device key so the relay check (WebCrypto) accepts it: golden', async () => {
    const device = await keyFromLabel('mls-golden/device');
    const { hpke } = await suite();
    const transfer = await hpke.deriveKeyPair(await sha256Of('mls-golden/transfer'));
    const transferKey = await hpke.exportPublicKey(transfer.publicKey);
    const commitment = await pairingCommitment({
      userId: 'alice',
      deviceId: 'dev-new',
      signatureKey: device.publicKey,
      transferKey,
      deviceNonce: fill(0x11),
    });
    const fields = {
      userId: 'alice',
      deviceId: 'dev-new',
      purpose: IdentityRequestPurpose.PAIR,
      transferKey,
      commitment,
    };
    // The suite's device key is the raw 32-byte seed, as the engine's leaf key is.
    const signature = await signIdentityRequest(device.seed, fields);
    expect(encodeBase64(signature)).toBe(
      'J5hYpk7t2qgLVKHgUlrDfX+6BDy3QceOMkZijoVj4jPgcnzV7P7j3XfvYJ1p5giTFhAqB1UE2TrSdZEhurYBAg==',
    );
    expect(await verifyIdentityRequestSignature(device.publicKey, fields, signature)).toBe(true);
  });

  it('a fresh engine device key signs a backfill request the relay accepts', async () => {
    const deviceKey = await (await suite()).signature.keygen();
    const fields = {
      userId: 'alice',
      deviceId: 'dev-old',
      purpose: IdentityRequestPurpose.BACKFILL,
      transferKey: (await createTransferKeyPair()).publicKey,
    };
    const signature = await signIdentityRequest(deviceKey.signKey, fields);
    expect(await verifyIdentityRequestSignature(deviceKey.publicKey, fields, signature)).toBe(true);
  });

  it('signs the rebind after an operator reset with the device key, as the relay checks it: golden', async () => {
    const device = await keyFromLabel('mls-golden/device');
    const identity = await keyFromLabel('mls-golden/identity');
    const fields = {
      userId: 'alice',
      deviceId: 'dev-new',
      identityKey: identity.publicKey,
      resetId: '6f1c2a3b-4d5e-4f60-8a71-92b3c4d5e6f7',
    };
    const signature = await signIdentityRebind(device.seed, fields);
    expect(encodeBase64(signature)).toBe(
      'QVqgH7jGWIeSJFQbtFye7cVtebe9eABStwA8lS1jm/r1eBS3yURjP23Q/aRJfnt8ZfIqK+XgAQoU8TjkdIOMDQ==',
    );
    expect(await verifyIdentityRebindSignature(device.publicKey, fields, signature)).toBe(true);
    expect(
      await verifyIdentityRebindSignature(
        device.publicKey,
        { ...fields, resetId: '00000000-0000-4000-8000-000000000000' },
        signature,
      ),
    ).toBe(false);
  });

  it('a first holder proves itself with its own key; the proof names exactly that device', async () => {
    const identity = await generateIdentityKeyPair();
    const statement = { userId: 'alice', deviceId: 'dev-first', signatureKey: fill(9) };
    const proof = await signHolderProof(identity.privateKeyPkcs8, statement);
    expect(await verifyHolderProof(identity.publicKey, statement, proof)).toBe(true);
    expect(
      await verifyHolderProof(identity.publicKey, { ...statement, deviceId: 'dev-other' }, proof),
    ).toBe(false);
  });
});

describe('pairingChoices: the holder sheet', () => {
  it('offers PAIRING_CHOICES distinct numbers in range, the real one exactly once', () => {
    for (const number of [PAIRING_NUMBER_MIN, 57, PAIRING_NUMBER_MIN + PAIRING_NUMBER_COUNT - 1]) {
      for (let round = 0; round < 2_000; round += 1) {
        const choices = pairingChoices(number);
        expect(choices).toHaveLength(PAIRING_CHOICES);
        expect(new Set(choices).size).toBe(PAIRING_CHOICES);
        expect(choices.filter((choice) => choice === number)).toHaveLength(1);
        expect(choices.every(isPairingNumber)).toBe(true);
      }
    }
  });

  it('puts the real number at every position evenly and draws decoys from every other number', () => {
    const rounds = 9_000;
    const positions = new Array<number>(PAIRING_CHOICES).fill(0);
    const decoys = new Map<number, number>();
    for (let round = 0; round < rounds; round += 1) {
      const choices = pairingChoices(57);
      const at = choices.indexOf(57);
      positions[at] = (positions[at] ?? 0) + 1;
      for (const choice of choices) {
        if (choice !== 57) decoys.set(choice, (decoys.get(choice) ?? 0) + 1);
      }
    }
    const expected = rounds / PAIRING_CHOICES;
    const chiSquared = positions.reduce(
      (sum, count) => sum + (count - expected) ** 2 / expected,
      0,
    );
    // 2 degrees of freedom; 40 is p ≈ 2·10^-9, so a fair RNG never trips it and a fixed slot always does.
    expect(chiSquared).toBeLessThan(40);
    expect(decoys.has(57)).toBe(false);
    expect(decoys.size).toBe(PAIRING_NUMBER_COUNT - 1);
  });

  it('throws MALFORMED for a value no pairing produces', () => {
    for (const bad of [PAIRING_NUMBER_MIN - 1, PAIRING_NUMBER_MIN + PAIRING_NUMBER_COUNT, 42.5]) {
      expect(() => pairingChoices(bad)).toThrow(IdentityTransferError);
    }
  });
});
