/**
 * SecurityStrip: what sits between the host's header and the thread — the guardian ribbon, the
 * room's live E2EE state (sign in again, removed, another tab, a history gap, sending) and, when the
 * room is stalled, the recovery banner. Reads the room's state once and draws nothing when the
 * state is unknown. `MessengerChatView` mounts it when it is given a `conversationId`.
 */
import { GuardianRibbon } from './guardian-ribbon.js';
import { RecoveryBanner } from './recovery-banner.js';
import { RoomStateBanner } from './room-state-banner.js';
import { useSecurityState } from './use-security-state.js';

export interface SecurityStripProps {
  conversationId: string | null | undefined;
}

export function SecurityStrip({ conversationId }: SecurityStripProps) {
  const state = useSecurityState(conversationId);
  if (!state) return null;
  return (
    <>
      <GuardianRibbon guardians={state.guardians} />
      <RoomStateBanner state={state} />
      <RecoveryBanner recovery={state.recovery} />
    </>
  );
}
