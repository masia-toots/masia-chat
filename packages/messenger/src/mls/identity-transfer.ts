/**
 * The identity transfer on the client (internal ADR-218 §1, §2, §5): the new device's one-time HPKE
 * key, sealing the person's identity key to it and opening it again, the holder proof, the request
 * signature, the rebind signature after an operator reset (§6), the pairing nonces, and the decoys of
 * the holder's number sheet.
 *
 * The canonical bytes, tags, sizes and checks are the wire contract's (`@masia/contracts/wire`,
 * `identity-transfer.ts`), because the relay verifies the same signatures and commitments. This module
 * adds only what a client does: draw randomness, seal, open and sign. The relay never opens anything.
 *
 * HPKE is RFC 9180 base mode with the primitives of MLS suite 1: DHKEM(X25519, HKDF-SHA256),
 * HKDF-SHA256, AES-128-GCM, through the `ts-mls` ciphersuite the engine already uses (no new
 * dependency). `info` is `IDENTITY_TRANSFER_FORMAT` and the aad is `identityTransferAad`, so a blob
 * opens only for the device, keys, identity key and list version it was sealed for. The identity key
 * is Ed25519 in WebCrypto (as `device-list.ts`); the device key signs through the suite, as a leaf does.
 */
import {
  ed25519,
  type HolderStatement,
  IDENTITY_KEY_PKCS8_MAX_BYTES,
  IDENTITY_TRANSFER_ERRORS,
  IDENTITY_TRANSFER_FORMAT,
  type IdentityRebindFields,
  type IdentityRequestFields,
  identityRebindBytes,
  identityRequestBytes,
  type IdentityTransferBinding,
  identityTransferAad,
  IdentityTransferError,
  holderStatementBytes,
  isPairingNumber,
  PAIRING_CHOICES,
  PAIRING_NONCE_BYTES,
  PAIRING_NUMBER_COUNT,
  PAIRING_NUMBER_MIN,
  verifyHolderProof,
} from '@masia/contracts/wire';
import { type CiphersuiteImpl, getCiphersuiteFromName, getCiphersuiteImpl } from 'ts-mls';
import { MLS_CIPHER_SUITE_NAME } from './constants.js';

/** N's one-time transfer key pair, raw X25519. The private half stays on N until the request ends. */
export interface TransferKeyPair {
  readonly publicKey: Uint8Array;
  readonly privateKey: Uint8Array;
}

/** An identity key sealed to a transfer key: the HPKE encapsulated key and the ciphertext. */
export interface SealedIdentity {
  readonly enc: Uint8Array;
  readonly ciphertext: Uint8Array;
}

/** What N gets from a sealed key it could open and check: the key, and its holder proof to post. */
export interface OpenedIdentity {
  /** The identity private key, PKCS#8, exactly as the holder stores it. */
  readonly privateKeyPkcs8: Uint8Array;
  /** N's holder proof, already verified under the pinned identity key. */
  readonly holderProof: Uint8Array;
}

const INFO = new TextEncoder().encode(IDENTITY_TRANSFER_FORMAT);

let suite: Promise<CiphersuiteImpl> | undefined;

/** The MLS suite 1 implementation, assembled once (a failed assembly is retried on the next call). */
function cipherSuite(): Promise<CiphersuiteImpl> {
  suite ??= getCiphersuiteImpl(getCiphersuiteFromName(MLS_CIPHER_SUITE_NAME)).catch(
    (error: unknown) => {
      suite = undefined;
      throw error;
    },
  );
  return suite;
}

function invalid(detail: string): IdentityTransferError {
  return new IdentityTransferError(IDENTITY_TRANSFER_ERRORS.INVALID, detail);
}

/** A fresh one-time X25519 key pair for one identity request. */
export async function createTransferKeyPair(): Promise<TransferKeyPair> {
  const { hpke } = await cipherSuite();
  const pair = await hpke.generateKeyPair();
  return {
    publicKey: await hpke.exportPublicKey(pair.publicKey),
    privateKey: await hpke.exportPrivateKey(pair.privateKey),
  };
}

/** A fresh pairing nonce (`r_N` on the new device, `r_B` on the holder) from the crypto RNG. */
export function createPairingNonce(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(PAIRING_NONCE_BYTES));
}

/**
 * The holder's side: seals `identityKeyPkcs8` to `binding.transferKey` with the binding as aad. Throws
 * `IdentityTransferError` `MALFORMED` for a binding the aad cannot encode, a key of the wrong size or
 * a transfer key HPKE cannot use.
 */
export async function sealIdentity(
  binding: IdentityTransferBinding,
  identityKeyPkcs8: Uint8Array,
): Promise<SealedIdentity> {
  if (identityKeyPkcs8.length === 0 || identityKeyPkcs8.length > IDENTITY_KEY_PKCS8_MAX_BYTES) {
    throw new IdentityTransferError(IDENTITY_TRANSFER_ERRORS.MALFORMED, 'identity key size');
  }
  const aad = identityTransferAad(binding);
  const { hpke } = await cipherSuite();
  const recipient = await hpke.importPublicKey(binding.transferKey).catch(() => {
    throw new IdentityTransferError(IDENTITY_TRANSFER_ERRORS.MALFORMED, 'transfer key');
  });
  const sealed = await hpke.seal(recipient, identityKeyPkcs8, INFO, aad);
  return { enc: sealed.enc, ciphertext: sealed.ct };
}

/**
 * N's side: opens `sealed` with the private half of its transfer key, then proves the key is the
 * person's: it signs N's own holder statement with it and verifies that signature under
 * `binding.identityKey`, the pin N's number also covered. Throws `IdentityTransferError` `INVALID`
 * when the blob does not open (another device, key, identity key or list version, or a tampered
 * blob) or opens to a key that does not verify; the caller discards it and says so, loudly.
 */
export async function openIdentity(
  binding: IdentityTransferBinding,
  transferPrivateKey: Uint8Array,
  sealed: SealedIdentity,
): Promise<OpenedIdentity> {
  const aad = identityTransferAad(binding);
  const { hpke } = await cipherSuite();
  let privateKeyPkcs8: Uint8Array;
  try {
    privateKeyPkcs8 = await hpke.open(
      await hpke.importPrivateKey(transferPrivateKey),
      sealed.enc,
      sealed.ciphertext,
      INFO,
      aad,
    );
  } catch {
    throw invalid('the sealed key does not open');
  }
  let holderProof: Uint8Array | null = null;
  try {
    holderProof = await signHolderProof(privateKeyPkcs8, binding);
  } catch {
    // Not an Ed25519 PKCS#8: it verifies nothing, so it is refused below like a wrong key.
  }
  if (
    holderProof === null ||
    !(await verifyHolderProof(binding.identityKey, binding, holderProof))
  ) {
    privateKeyPkcs8.fill(0);
    throw invalid('the key does not verify under the pinned identity key');
  }
  return { privateKeyPkcs8, holderProof };
}

/** The holder proof of `statement`'s device: the identity key's signature over its holder statement. */
export async function signHolderProof(
  identityKeyPkcs8: Uint8Array,
  statement: HolderStatement,
): Promise<Uint8Array> {
  const bytes = holderStatementBytes(statement);
  const key = await crypto.subtle.importKey(
    'pkcs8',
    new Uint8Array(identityKeyPkcs8),
    ed25519(),
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign(ed25519(), key, new Uint8Array(bytes)));
}

/** N's signature over its request, with its device key (the MLS signature private key). */
export async function signIdentityRequest(
  devicePrivateKey: Uint8Array,
  fields: IdentityRequestFields,
): Promise<Uint8Array> {
  const bytes = identityRequestBytes(fields);
  const { signature } = await cipherSuite();
  return signature.sign(devicePrivateKey, bytes);
}

/**
 * The rebind signature of the device an operator reset names (ADR-218 §6): its device key's signature
 * over the new identity key and that reset, which the relay asks for before it pins the key.
 */
export async function signIdentityRebind(
  devicePrivateKey: Uint8Array,
  fields: IdentityRebindFields,
): Promise<Uint8Array> {
  const bytes = identityRebindBytes(fields);
  const { signature } = await cipherSuite();
  return signature.sign(devicePrivateKey, bytes);
}

const UINT32_RANGE = 2 ** 32;

/** A uniform integer in `[0, bound)` from the crypto RNG; rejection sampling, so no modulo bias. */
function randomBelow(bound: number): number {
  const limit = Math.floor(UINT32_RANGE / bound) * bound;
  for (;;) {
    const [value = limit] = crypto.getRandomValues(new Uint32Array(1));
    if (value < limit) return value % bound;
  }
}

/**
 * The holder's sheet: `PAIRING_CHOICES` distinct numbers, the real `number` among
 * `PAIRING_CHOICES - 1` decoys drawn uniformly from the other numbers, at a uniformly random
 * position. Throws `MALFORMED` for a value no pairing produces.
 */
export function pairingChoices(number: number): number[] {
  if (!isPairingNumber(number)) {
    throw new IdentityTransferError(IDENTITY_TRANSFER_ERRORS.MALFORMED, 'pairing number');
  }
  const decoys: number[] = [];
  while (decoys.length < PAIRING_CHOICES - 1) {
    const candidate = PAIRING_NUMBER_MIN + randomBelow(PAIRING_NUMBER_COUNT);
    if (candidate !== number && !decoys.includes(candidate)) decoys.push(candidate);
  }
  decoys.splice(randomBelow(PAIRING_CHOICES), 0, number);
  return decoys;
}
