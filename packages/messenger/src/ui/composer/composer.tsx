/**
 * The messenger's own message input: a text box and a send button.
 *
 * Why it exists: the package must be usable on its own. A host with a richer input (attach, stickers,
 * dictation: the Masia hub's) passes it through the `Composer` slot and the conversation uses that;
 * this one covers what every host needs and nothing it would have to configure.
 *
 * Enter sends, Shift+Enter breaks the line, an empty draft sends nothing, and while the link is down
 * (`disabled`) the box is locked. `initialDraft` seeds the text once (the message being edited) and
 * puts the caret at its end; the conversation re-mounts the composer with a new `key` to seed it
 * again. ArrowUp in an empty box asks the view to recall the last own message (`onRecallLast`).
 */
import { useCallback, useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import { useIcon, useT } from '../provider/messenger-ui.js';
import type { ComposerSlotProps } from '../provider/slots.js';
import { MentionPopover } from './mention-popover.js';
import { useMentionPopover } from './use-mention-popover.js';
import './composer.css';

export function Composer({ onSend, disabled, onTyping, initialDraft, onRecallLast, mentionCandidates }: ComposerSlotProps) {
  const t = useT();
  const icon = useIcon();
  const [draft, setDraft] = useState(initialDraft ?? '');
  const boxRef = useRef<HTMLTextAreaElement | null>(null);
  // Whether the other side was last told «typing», so the signal is sent on the edges only.
  const typingRef = useRef(false);

  // A seeded box (an edit, a recall) is ready to type into: focused, caret after the last character.
  useEffect(() => {
    const box = boxRef.current;
    if (!initialDraft || !box) return;
    box.focus();
    box.setSelectionRange(initialDraft.length, initialDraft.length);
  }, [initialDraft]);

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

  const setDraftFromMention = useCallback(
    (next: string) => {
      setDraft(next);
      signalTyping(next.length > 0);
    },
    [signalTyping],
  );
  // @-completion (ADR-199 §5): only when the conversation handed candidates in.
  const mention = useMentionPopover({ candidates: mentionCandidates, value: draft, textareaRef: boxRef, onChange: setDraftFromMention });

  const handleChange = (event: ChangeEvent<HTMLTextAreaElement>): void => {
    setDraft(event.target.value);
    signalTyping(event.target.value.length > 0);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.nativeEvent.isComposing) return;
    // An open mention popover takes ↑/↓/Enter/Tab/Esc first: Enter inserts, it does not send.
    if (mention.onKeyDown(event)) return;
    if (event.key === 'ArrowUp' && draft === '' && onRecallLast) {
      event.preventDefault();
      onRecallLast();
      return;
    }
    // `isComposing`: Enter that confirms an IME candidate (Japanese, Chinese) must not send.
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    submit();
  };

  return (
    <div className="msg-composer">
      <MentionPopover state={mention} />
      <textarea
        ref={boxRef}
        className="msg-composer__input"
        rows={1}
        value={draft}
        disabled={disabled}
        placeholder={t('composer.placeholder')}
        aria-label={t('composer.placeholder')}
        aria-autocomplete={mentionCandidates?.length ? 'list' : undefined}
        aria-controls={mention.open ? mention.listboxId : undefined}
        aria-activedescendant={mention.activeOptionId}
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
