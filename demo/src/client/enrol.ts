import { DeviceRole, type DeviceListEntry } from '@masia/contracts/wire';
import { signDeviceList, type DeviceKeys, type MlsEngine } from '@masia/messenger/mls';
import { toBase64 } from './bytes.js';
import type { RelayApi } from './relay-api.js';

// What a tab does once, at sign-in, to become a device the relay and other people can talk to:
//   1. make a signing key for this device (the person's Ed25519 identity key is made by the caller first:
//      the device directory needs it, and the engine needs the directory);
//   2. register the device with the relay (the first device pins the person's identity key there);
//   3. publish the signed device list, version 1, with this device on it;
//   4. upload key packages in ONE request: a few ordinary ones and one last-resort one.
// Keys live in this page's memory and nowhere else. A reload is a new person.

/** Ordinary key packages uploaded at sign-in: one per chat a stranger may start with this tab. */
export const ORDINARY_KEY_PACKAGES = 5;

export interface Enrolment {
  readonly userId: string;
  readonly deviceId: string;
  readonly displayName: string;
  readonly identity: { readonly publicKey: Uint8Array; readonly privateKeyPkcs8: Uint8Array };
  readonly keys: DeviceKeys;
  /**
   * The private halves of every key package this tab uploaded. A Welcome is addressed to one of them;
   * the joiner tries each until one opens (the relay hands out ordinary packages once, the last-resort
   * one again and again).
   */
  readonly keyPackagePrivates: readonly Uint8Array[];
}

export interface EnrolInput {
  readonly engine: MlsEngine;
  readonly api: RelayApi;
  readonly userId: string;
  readonly deviceId: string;
  readonly displayName: string;
  /** The person's identity key pair (`generateIdentityKeyPair`). */
  readonly identity: { readonly publicKey: Uint8Array; readonly privateKeyPkcs8: Uint8Array };
}

export async function enrol({
  engine,
  api,
  userId,
  deviceId,
  displayName,
  identity,
}: EnrolInput): Promise<Enrolment> {
  const signingKey = await engine.generateSigningKeyPair();
  const keys: DeviceKeys = {
    identity: { userId, deviceId, role: DeviceRole.USER },
    signingKey,
  };

  await api.registerDevice({
    id: deviceId,
    name: `${displayName} (browser tab)`,
    platform: 'web',
    identityKeyPub: identity.publicKey,
    signatureKeyPub: signingKey.publicKey,
  });

  const signed = await signDeviceList(identity.privateKeyPkcs8, {
    userId,
    version: 1,
    devices: [{ deviceId, role: DeviceRole.USER, signatureKey: signingKey.publicKey }],
  });
  const entry: DeviceListEntry = {
    id: deviceId,
    role: DeviceRole.USER,
    signatureKey: toBase64(signingKey.publicKey),
  };
  await api.putDeviceList({ version: 1, devices: [entry], signature: signed.signature });

  const bundles = [];
  for (let i = 0; i <= ORDINARY_KEY_PACKAGES; i += 1) bundles.push(await engine.createKeyPackage(keys));
  await api.uploadKeyPackages(
    bundles.map((bundle, index) => ({
      bytes: bundle.keyPackage,
      // The relay requires at least one last-resort package; it keeps serving it when the pool is empty.
      lastResort: index === ORDINARY_KEY_PACKAGES,
    })),
  );

  return {
    userId,
    deviceId,
    displayName,
    identity,
    keys,
    keyPackagePrivates: bundles.map((bundle) => bundle.keyPackagePrivate),
  };
}
