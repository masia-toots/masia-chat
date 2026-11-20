/**
 * The one WebCrypto Ed25519 check of the wire: the signed device list (`device-list.ts`) and the
 * identity transfer (`identity-transfer.ts`) both verify through it, so "a key WebCrypto cannot use
 * verifies nothing" is decided in one place. Internal: not re-exported from `./index.ts`.
 */

/** The Ed25519 algorithm identifier WebCrypto takes. */
export function ed25519(): { name: string } {
  return { name: 'Ed25519' };
}

/** A copy on its own ArrayBuffer (what WebCrypto's `BufferSource` type asks for). */
export function own(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes);
}

/**
 * True when `signature` is `publicKey`'s Ed25519 signature over `message`. A key that is not a point
 * on the curve, or that WebCrypto refuses for any other reason, verifies nothing: `false`, never a
 * throw. The caller checks the sizes first and names its own refusal.
 */
export async function verifyEd25519(
  publicKey: Uint8Array,
  signature: Uint8Array,
  message: Uint8Array,
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey('raw', own(publicKey), ed25519(), false, ['verify']);
    return await crypto.subtle.verify(ed25519(), key, own(signature), own(message));
  } catch {
    return false;
  }
}
