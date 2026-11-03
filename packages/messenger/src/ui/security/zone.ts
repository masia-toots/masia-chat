/**
 * Which zone a room is in, and which words and icon say so. Pure: the badge, the sheet and the
 * tests all read the zone from here, so the rule has one home (canon section 1).
 *
 * The rule, in the order it is applied:
 *  1. Masia in the room means the server can read it (her key is the operator's), whatever the
 *     encryption flag says: the Masia zone. "End-to-end" is never claimed there.
 *  2. Otherwise the text is encrypted only when the room says `on`.
 *  3. `pending` is shown as pending, never rounded up to encrypted.
 *  4. Anything else is plain: not end-to-end encrypted (the state of every people's room today).
 */
import type { MessengerI18nKey, MessengerIconName } from '@masia/contracts';
import type { ConversationSecurityState } from '../../protocol/security-state.js';

export const ZONE = {
  MASIA: 'masia',
  ENCRYPTED: 'encrypted',
  PENDING: 'pending',
  PLAIN: 'plain',
} as const;
export type Zone = (typeof ZONE)[keyof typeof ZONE];

export function zoneOf(state: Pick<ConversationSecurityState, 'e2ee' | 'masia'>): Zone {
  if (state.masia === 'present-server-reads') return ZONE.MASIA;
  if (state.e2ee === 'on') return ZONE.ENCRYPTED;
  if (state.e2ee === 'pending') return ZONE.PENDING;
  return ZONE.PLAIN;
}

/** The badge's one-line label. */
export const ZONE_LABEL_KEY: Readonly<Record<Zone, MessengerI18nKey>> = {
  [ZONE.MASIA]: 'zone.masia',
  [ZONE.ENCRYPTED]: 'zone.encrypted',
  [ZONE.PENDING]: 'zone.pending',
  [ZONE.PLAIN]: 'zone.plain',
};

/** The badge's icon; `null` = a spinner (the setup is in flight). */
export const ZONE_ICON: Readonly<Record<Zone, MessengerIconName | null>> = {
  [ZONE.MASIA]: 'masia',
  [ZONE.ENCRYPTED]: 'lock',
  [ZONE.PENDING]: null,
  [ZONE.PLAIN]: 'lock-open',
};

/**
 * The sheet's explanation. Masia gets two sentences because two things are true: in an encrypted
 * room she is a member whose key is on the server (and reads only from when she joined); in a
 * server-readable chat she reads because that is how she remembers and helps.
 */
export function explanationKeyOf(state: Pick<ConversationSecurityState, 'e2ee' | 'masia'>): MessengerI18nKey {
  switch (zoneOf(state)) {
    case ZONE.MASIA:
      return state.e2ee === 'on' ? 'zone.explainMasiaMember' : 'zone.explainMasiaServer';
    case ZONE.ENCRYPTED:
      return 'zone.explainEncrypted';
    case ZONE.PENDING:
      return 'zone.explainPending';
    case ZONE.PLAIN:
      return 'zone.explainPlain';
  }
}

/** Up to this many guardians the ribbon names each one; beyond it, it counts them. */
export const GUARDIAN_NAMED_MAX = 2;

/** One entry per guardian user (a guardian with several devices is still one adult). Order is kept. */
export function distinctGuardians<G extends { readonly userId: string }>(guardians: readonly G[]): G[] {
  const seen = new Set<string>();
  const out: G[] = [];
  for (const guardian of guardians) {
    if (seen.has(guardian.userId)) continue;
    seen.add(guardian.userId);
    out.push(guardian);
  }
  return out;
}
