/**
 * The one line above the composer that says what the next send DOES (internal ADR-199 §2): answer
 * this message, or replace that one. One component for both intents, so the strip, its cancel and
 * its words cannot drift between them. ✕ cancels; the view also cancels on Esc from the composer.
 */
import type { MessengerMessage } from '../../protocol/messages.js';
import { useIcon, useT } from '../provider/messenger-ui.js';
import { replyPreviewOf } from './reply-preview.js';
import './messenger-chat-view.css';

export type MessageIntentMode = 'reply' | 'edit';

/** What the composer is about to do with `message`: quote it (`reply`) or replace its text (`edit`). */
export interface MessageIntent {
  readonly mode: MessageIntentMode;
  readonly message: MessengerMessage;
}

export interface IntentStripProps {
  intent: MessageIntent;
  onCancel(): void;
}

export function IntentStrip({ intent, onCancel }: IntentStripProps) {
  const t = useT();
  const icon = useIcon();
  const quote = intent.mode === 'reply' ? replyPreviewOf(intent.message) : null;
  return (
    <div className="hub-mchat-intent" data-intent={intent.mode}>
      <span className="hub-mchat-intent-what">
        {icon(intent.mode === 'reply' ? 'back' : 'mood', 13)}
        {intent.mode === 'reply' ? (
          <>
            <span className="hub-mchat-intent-who">{t('chat.replyingTo', { name: intent.message.senderName })}</span>
            {quote && (
              <span className="hub-mchat-intent-quote">
                {quote.deleted
                  ? t('chat.replyDeleted')
                  : intent.message.messageType === 'STICKER'
                    ? t('chat.sticker')
                    : quote.text}
              </span>
            )}
          </>
        ) : (
          t('chat.editingMessage')
        )}
      </span>
      <button type="button" onClick={onCancel} aria-label={t('common.cancel')}>
        ✕
      </button>
    </div>
  );
}
