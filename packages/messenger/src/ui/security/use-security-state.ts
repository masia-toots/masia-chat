/**
 * `useSecurityState`: the live security state of one room, from the provider's `SecurityStateSource`.
 *
 * `undefined` = the client does not know (no source mounted, no id, or the source has nothing for the
 * room). Every security screen treats that as "draw nothing": an unknown room must not look secure.
 */
import { useCallback, useSyncExternalStore } from 'react';
import type { ConversationSecurityState } from '../../protocol/security-state.js';
import { useMessengerUi } from '../provider/messenger-ui.js';

const NO_UNSUBSCRIBE = (): void => undefined;

export function useSecurityState(
  conversationId: string | null | undefined,
): ConversationSecurityState | undefined {
  const { security } = useMessengerUi();
  const subscribe = useCallback(
    (onChange: () => void) =>
      security && conversationId ? security.subscribe(conversationId, onChange) : NO_UNSUBSCRIBE,
    [security, conversationId],
  );
  const snapshot = useCallback(
    () => (security && conversationId ? security.securityStateOf(conversationId) : undefined),
    [security, conversationId],
  );
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
