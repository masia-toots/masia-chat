/**
 * The messenger's own message input: a text box and a send button.
 *
 * Why it exists: the package must be usable on its own. A host with a richer input (attach, stickers,
 * dictation: the Masia hub's) passes it through the `Composer` slot and the conversation uses that;
 * this one covers what every host needs and nothing it would have to configure.
 *
 * Enter sends, Shift+Enter breaks the line, an empty draft sends nothing, and while the link is down
 * (`disabled`) the box is locked. `initialDraft` seeds the text once (the message being edited); the
 * conversation re-mounts the composer with a new `key` to seed it again.
 */
import { useCallback, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import { useIcon, useT } from '../provider/messenger-ui.js';
import type { ComposerSlotProps } from '../provider/slots.js';
import './composer.css';

export function Composer({ onSend, disabled, onTyping, initialDraft }: ComposerSlotProps) {
  const t = useT();
  const icon = useIcon();
  const [draft, setDraft] = useState(initialDraft ?? '');
  // Whether the other side was last told «typing», so the signal is sent on the edges only.
  const typingRef = useRef(false);

  const signalTyping = useCallback(
    (typing: boolean) => {
      if (typingRef.current === typing) return;
      typingRef.current = typing;
      onTyping?.(typing);
    },
    [onTyping],
  );

  const submit = useCallback(() => {
    const text = draft.trim();
    if (!text || disabled) return;
    onSend(text);
    setDraft('');
    signalTyping(false);
  }, [draft, disabled, onSend, signalTyping]);

  const handleChange = (event: ChangeEvent<HTMLTextAreaElement>): void => {
    setDraft(event.target.value);
    signalTyping(event.target.value.length > 0);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    // `isComposing`: Enter that confirms an IME candidate (Japanese, Chinese) must not send.
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    submit();
  };

  return (
    <div className="msg-composer">
      <textarea
        className="msg-composer__input"
        rows={1}
        value={draft}
        disabled={disabled}
        placeholder={t('composer.placeholder')}
        aria-label={t('composer.placeholder')}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
      />
      <button
        type="button"
        className="msg-composer__send"
        disabled={disabled || draft.trim().length === 0}
        aria-label={t('composer.send')}
        onClick={submit}
      >
        {icon('send', 18)}
      </button>
    </div>
  );
}
