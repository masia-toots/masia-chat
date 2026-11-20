/**
 * The state of the @-completion popover for one text box (ADR-199 §5), shared by the package's slim
 * composer and the host's richer one so the two behave alike: open while the caret sits in an `@…`
 * token with at least one match, ↑/↓ move, Enter/Tab insert, Esc closes until the token changes,
 * a tap inserts. The hook does not render: `MentionPopover` draws what it returns.
 *
 * The caret is read from the box after each value change (the browser has placed it by then), so
 * the host wires nothing beyond `value`, its `onChange` and the box's ref.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import type { MentionCandidate } from '../provider/slots.js';
import { activeMentionToken, filterMentionCandidates, insertMention } from './mention-token.js';

export interface UseMentionPopoverOptions {
  readonly candidates?: readonly MentionCandidate[];
  readonly value: string;
  readonly textareaRef: RefObject<HTMLTextAreaElement | null>;
  /** Receives the new text when a row is picked (the host sets its draft from it). */
  onChange(next: string): void;
  /** Read at key time: `false` turns the popover off for the moment (dictation running, a mode that takes the line). */
  enabled?(): boolean;
}

export interface MentionPopoverState {
  readonly open: boolean;
  readonly matches: readonly MentionCandidate[];
  readonly activeIndex: number;
  /** The listbox's id and the id of its active option (for `aria-activedescendant` on the box). */
  readonly listboxId: string;
  readonly activeOptionId: string | undefined;
  setActiveIndex(index: number): void;
  /** Call first in the box's `onKeyDown`; `true` = the popover took the key (Enter did not send). */
  onKeyDown(event: KeyboardEvent<Element>): boolean;
  pick(candidate: MentionCandidate): void;
}

const KEY_DOWN = 'ArrowDown';
const KEY_UP = 'ArrowUp';
const KEY_ENTER = 'Enter';
const KEY_TAB = 'Tab';
const KEY_ESCAPE = 'Escape';

export function useMentionPopover({ candidates, value, textareaRef, onChange, enabled }: UseMentionPopoverOptions): MentionPopoverState {
  const listboxId = useId();
  const [caret, setCaret] = useState(value.length);
  const [activeIndex, setActiveIndex] = useState(0);
  // Esc hides the popover for THIS token; typing on (a different token) brings it back.
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const pendingCaretRef = useRef<number | null>(null);

  // After a change the browser has placed the caret; read it once the DOM has the new value — in a LAYOUT effect, so the
  // caret (and the token built from it) is in step with `value` before the next keystroke. A passive effect lagged one render:
  // a fast typist's Enter replaced the PREVIOUS token (`@mam` + caret 3 → `@masia m`; sim-chat-intents К6, 2026-11-07).
  useLayoutEffect(() => {
    const box = textareaRef.current;
    setCaret(box ? box.selectionStart ?? value.length : value.length);
  }, [value, textareaRef]);

  // After an insert, put the caret right after the inserted `@tag `.
  useLayoutEffect(() => {
    const next = pendingCaretRef.current;
    if (next === null) return;
    pendingCaretRef.current = null;
    const box = textareaRef.current;
    if (!box) return;
    box.focus();
    box.setSelectionRange(next, next);
    setCaret(next);
  }, [value, textareaRef]);

  const token = useMemo(() => (candidates?.length ? activeMentionToken(value, caret) : null), [candidates, value, caret]);
  const matches = useMemo(
    () => (token ? filterMentionCandidates(candidates ?? [], token.query) : []),
    [candidates, token],
  );
  const tokenStart = token?.start;
  const open = matches.length > 0 && dismissedAt !== tokenStart;

  // The highlighted row stays in range as the matches narrow.
  const boundedIndex = matches.length ? Math.min(activeIndex, matches.length - 1) : 0;
  useEffect(() => {
    if (boundedIndex !== activeIndex) setActiveIndex(boundedIndex);
  }, [boundedIndex, activeIndex]);
  useEffect(() => {
    if (tokenStart === undefined) setActiveIndex(0);
  }, [tokenStart]);

  const pick = useCallback(
    (candidate: MentionCandidate) => {
      const next = insertMention(value, caret, candidate.tag);
      if (next.value === value) return;
      pendingCaretRef.current = next.caret;
      onChange(next.value);
    },
    [value, caret, onChange],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<Element>): boolean => {
      if (!open || (enabled && !enabled())) return false;
      switch (event.key) {
        case KEY_DOWN:
          event.preventDefault();
          setActiveIndex((i) => (i + 1) % matches.length);
          return true;
        case KEY_UP:
          event.preventDefault();
          setActiveIndex((i) => (i - 1 + matches.length) % matches.length);
          return true;
        case KEY_ENTER:
        case KEY_TAB: {
          if (event.nativeEvent.isComposing) return false;
          const chosen = matches[boundedIndex];
          if (!chosen) return false;
          event.preventDefault();
          pick(chosen);
          return true;
        }
        case KEY_ESCAPE:
          event.preventDefault();
          setDismissedAt(tokenStart ?? null);
          return true;
        default:
          return false;
      }
    },
    [open, enabled, matches, boundedIndex, pick, tokenStart],
  );

  const shown = open && (!enabled || enabled());
  return {
    open: shown,
    matches,
    activeIndex: boundedIndex,
    listboxId,
    activeOptionId: shown ? mentionOptionId(listboxId, boundedIndex) : undefined,
    setActiveIndex,
    onKeyDown,
    pick,
  };
}

/** The DOM id of one option row (the box points at it with `aria-activedescendant`). */
export function mentionOptionId(listboxId: string, index: number): string {
  return `${listboxId}-opt-${index}`;
}
