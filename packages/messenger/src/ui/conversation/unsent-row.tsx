/**
 * «Not sent» under a message of mine that never left, with its Retry and, for my own row, its Delete.
 * ONE row for every chat that keeps an outbox: the messenger's bubble and the chat with Masia's
 * (2026-11-18, TODO-1398: its unsent turns used to vanish instead). Words come through the provider.
 */
import { useT } from '../provider/messenger-ui.js';
import './messenger-chat-view.css';

export interface UnsentRowProps {
  /** The row's id (`pending-…`): what Retry and Delete are called with. */
  readonly messageId: string;
  /** Sends it again; absent: the row still says «not sent», without a retry. */
  readonly onRetrySend?: (id: string) => void;
  /** Lets it go (it never reached the server, so this is local); absent: no Delete. */
  readonly onDelete?: (id: string) => void;
}

export function UnsentRow({ messageId, onRetrySend, onDelete }: UnsentRowProps) {
  const t = useT();
  return (
    <div className="hub-msg-unsent">
      <span className="hub-msg-unsent-label">{t('chat.notSent')}</span>
      {onRetrySend && (
        <button type="button" className="hub-msg-unsent-retry" onClick={() => onRetrySend(messageId)}>
          {t('chat.retrySend')}
        </button>
      )}
      {onDelete && (
        <button type="button" className="hub-msg-unsent-delete" onClick={() => onDelete(messageId)}>
          {t('chat.delete')}
        </button>
      )}
    </div>
  );
}
