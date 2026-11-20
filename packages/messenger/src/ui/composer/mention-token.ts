/**
 * The pure half of @-completion (ADR-199 §5): where the active token is, what to show for it, and
 * what the text becomes when a row is picked. No DOM, no React — the popover and both composers
 * (the package's and the host's) call these, so there is one answer to «is the caret in a mention».
 */
import type { MentionCandidate } from '../provider/slots.js';

/** The `@…` the caret sits in: `[start, end)` in the value, `query` = the characters after `@`. */
export interface ActiveMentionToken {
  readonly start: number;
  readonly end: number;
  readonly query: string;
}

/** The popover shows at most this many rows; the rest are reached by narrowing the query. */
export const MENTION_POPOVER_MAX_ROWS = 6;

const WHITESPACE = /\s/;
/** A letter or digit right before the `@` makes it part of a word (an email), not a mention. */
const WORD_CHAR = /[\p{L}\p{N}]/u;
const MENTION_SIGIL = '@';

/**
 * The mention token the caret is in, or `null`: the caret must be right after `@` plus zero or more
 * non-whitespace characters, and the `@` must open a word (start of text, or after whitespace or
 * punctuation — `a@b` is an address).
 */
export function activeMentionToken(value: string, caret: number): ActiveMentionToken | null {
  const end = Math.max(0, Math.min(caret, value.length));
  let at = -1;
  for (let i = end - 1; i >= 0; i -= 1) {
    const ch = value.charAt(i);
    if (WHITESPACE.test(ch)) break;
    if (ch === MENTION_SIGIL) {
      at = i;
      break;
    }
  }
  if (at < 0) return null;
  const before = at > 0 ? value.charAt(at - 1) : '';
  if (before && WORD_CHAR.test(before)) return null;
  return { start: at, end, query: value.slice(at + 1, end) };
}

/** The text after picking `tag` for the active token: `@tag ` replaces the token, the caret follows the space. */
export function insertMention(value: string, caret: number, tag: string): { value: string; caret: number } {
  const token = activeMentionToken(value, caret);
  if (!token) return { value, caret };
  const inserted = `${MENTION_SIGIL}${tag} `;
  return {
    value: value.slice(0, token.start) + inserted + value.slice(token.end),
    caret: token.start + inserted.length,
  };
}

/** Lower-case without diacritics, so `Олена` meets `олена` and `Jörg` meets `jorg`. */
export function foldForMatch(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/**
 * The rows for a query: a prefix of the tag, of the name, or of any word of the name (case- and
 * diacritics-insensitive), in the candidates' own order, cut to the popover's row limit.
 */
export function filterMentionCandidates(
  candidates: readonly MentionCandidate[],
  query: string,
  limit = MENTION_POPOVER_MAX_ROWS,
): MentionCandidate[] {
  const q = foldForMatch(query);
  const hits = q
    ? candidates.filter((c) => {
        if (foldForMatch(c.tag).startsWith(q)) return true;
        const name = foldForMatch(c.name);
        return name.startsWith(q) || name.split(/\s+/).some((word) => word.startsWith(q));
      })
    : [...candidates];
  return hits.slice(0, limit);
}
