/**
 * The @-completion list above a composer (ADR-199 §5): picture (or initial), name, `@tag`, one row
 * per match, the active one highlighted. A listbox the text box drives (`aria-activedescendant`);
 * the rows take the pointer on `mousedown` so the box keeps focus and the keyboard stays up.
 *
 * It is positioned by its parent: the parent is the positioning context and the list rides above
 * it (`bottom: 100%`), so it never sits under the on-screen keyboard that the composer itself
 * already stays above.
 */
import type { MouseEvent } from 'react';
import { useT } from '../provider/messenger-ui.js';
import type { BroadcastMention, MentionCandidate } from '../provider/slots.js';
import { mentionOptionId, type MentionPopoverState } from './use-mention-popover.js';
import './mention-popover.css';

export interface MentionPopoverProps {
  readonly state: MentionPopoverState;
  /** Extra class on the list (a host's own placement rules). */
  readonly className?: string;
}

const INITIAL_LENGTH = 1;

function initialOf(name: string): string {
  return name.trim().slice(0, INITIAL_LENGTH).toUpperCase();
}

/** The picture of a row that calls the ROOM (ADR-201): a glyph, since there is no face — people for `@all`, a lit dot for `@online`. */
function RoomGlyph({ tag }: { tag: BroadcastMention }) {
  return (
    <span className="msg-mention-popover__avatar msg-mention-popover__avatar--room" aria-hidden>
      <svg viewBox="0 0 16 16" width="16" height="16" focusable="false">
        {tag === 'all' ? (
          <>
            <circle cx="6" cy="5.5" r="2.5" fill="currentColor" />
            <path d="M1.5 13c0-2.5 2-4 4.5-4s4.5 1.5 4.5 4z" fill="currentColor" />
            <circle cx="11.5" cy="6" r="2" fill="currentColor" opacity=".6" />
            <path d="M11 9.2c2 .2 3.5 1.5 3.5 3.8H12c0-1.6-.4-2.8-1-3.8z" fill="currentColor" opacity=".6" />
          </>
        ) : (
          <>
            <circle cx="8" cy="8" r="3" fill="currentColor" />
            <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" opacity=".6" />
          </>
        )}
      </svg>
    </span>
  );
}

export function MentionPopover({ state, className }: MentionPopoverProps) {
  const t = useT();
  if (!state.open) return null;
  const keepFocusInBox = (event: MouseEvent): void => event.preventDefault();
  return (
    <div
      id={state.listboxId}
      className={`msg-mention-popover${className ? ` ${className}` : ''}`}
      role="listbox"
      aria-label={t('chat.mentionHint')}
    >
      {state.matches.map((candidate: MentionCandidate, index) => {
        const active = index === state.activeIndex;
        return (
          <button
            key={candidate.id}
            id={mentionOptionId(state.listboxId, index)}
            type="button"
            role="option"
            aria-selected={active}
            className={`msg-mention-popover__option${active ? ' is-active' : ''}`}
            onMouseDown={keepFocusInBox}
            onMouseEnter={() => state.setActiveIndex(index)}
            onClick={() => state.pick(candidate)}
          >
            {candidate.broadcast ? (
              <RoomGlyph tag={candidate.broadcast} />
            ) : candidate.avatarUrl ? (
              <img className="msg-mention-popover__avatar" src={candidate.avatarUrl} alt="" />
            ) : (
              <span className="msg-mention-popover__avatar msg-mention-popover__avatar--initial" aria-hidden>
                {initialOf(candidate.name)}
              </span>
            )}
            <span className="msg-mention-popover__name">{candidate.name}</span>
            <span className="msg-mention-popover__tag">@{candidate.tag}</span>
          </button>
        );
      })}
    </div>
  );
}
