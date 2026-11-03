/**
 * The code that approves a second device (canon section 3): the NEW device shows it, an EXISTING
 * device of the same person types it in, and only then publishes the next version of the signed device
 * list with the new device in it.
 *
 * What the code is: a digest of the device's own identity (user, device id, MLS signature key), so it
 * names exactly one registered device. The approving device recomputes it for every device the relay
 * lists as registered but not yet on the signed list, and approves the one whose code matches. Two
 * such devices with one code are refused (the caller sees both), never guessed.
 *
 * What the code is NOT: a secret that authenticates the person (the relay session does that). It is the
 * person's own comparison of what is on the new device's screen with what they typed, so that a ghost
 * device a malicious operator slipped into the account's registered devices is not approved by
 * accident. That is also why it is long: the relay sees the new device's keys the moment it registers,
 * and a relay that wants its own ghost approved has to find a key whose code equals the one the person
 * will read off the screen within the minute it takes them to type it. Eight digits (10^8) fall to a
 * laptop in seconds; sixteen (10^16, 53 bits) do not fall inside that minute to anyone. Four groups of
 * four digits are still a thing a person types.
 *
 * Lives here, with the list format it feeds, so every client derives the same code.
 */

export const APPROVAL_CODE_DIGITS = 16;
/** Digits to a group when a screen shows the code. */
const GROUP_DIGITS = 4;
const APPROVAL_CODE_TAG = 'mls-device-approval/v1';
const MODULUS = 10n ** BigInt(APPROVAL_CODE_DIGITS);
const DIGEST_BYTES_USED = 8;

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** The code of one device: `APPROVAL_CODE_DIGITS` decimal digits, zero-padded. */
export async function deviceApprovalCode(input: {
  readonly userId: string;
  readonly deviceId: string;
  readonly signatureKey: Uint8Array;
}): Promise<string> {
  const text = JSON.stringify([
    APPROVAL_CODE_TAG,
    input.userId,
    input.deviceId,
    toBase64(input.signatureKey),
  ]);
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)),
  );
  let value = 0n;
  for (const byte of digest.subarray(0, DIGEST_BYTES_USED)) value = (value << 8n) | BigInt(byte);
  return (value % MODULUS).toString().padStart(APPROVAL_CODE_DIGITS, '0');
}

/** `1234567812345678` -> `1234 5678 1234 5678`: how a screen shows a code. */
export function formatApprovalCode(code: string): string {
  const groups: string[] = [];
  for (let at = 0; at < code.length; at += GROUP_DIGITS)
    groups.push(code.slice(at, at + GROUP_DIGITS));
  return groups.join(' ');
}

/**
 * What a person typed, as a code: spaces, dashes and dots are ignored; anything else, or the wrong
 * number of digits, is `undefined`.
 */
export function parseApprovalCode(typed: string): string | undefined {
  const digits = typed.replace(/[\s\-.]/g, '');
  return new RegExp(`^\\d{${APPROVAL_CODE_DIGITS}}$`).test(digits) ? digits : undefined;
}
