/**
 * `@tag` chips in a message text (ADR-199 §5). The package does not parse the host's handle
 * grammar: it marks only the tags of the candidates it is given (a real participant, the
 * assistant when she can be called), read case-insensitively, when the `@` opens a word (an address
 * like `a@b.c` is left alone) and the tag ends where a handle character does not follow. Everything
 * else is returned verbatim, so a text without a hit is one plain string.
 */
import type { ReactNode } from 'react';
import type { MentionCandidate } from '../provider/slots.js';
import { renderLinks } from './text-links.js';

const MENTION_CLASS = 'hub-msg-mention';
const IS_ME_CLASS = 'is-me';

function escapeForRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
}

/**
 * `(^|not-a-word-char)@(tag1|tag2…)(the handle ends here)`, longest tags first. The handle ends where no letter or
 * digit follows — directly or after a run of `-` / `_`: `@all-` and `@masia_` are the tag followed by punctuation (the
 * server reads them so: `parseMentions` strips a trailing separator), `@all-x` is another handle.
 */
function mentionPattern(candidates: readonly MentionCandidate[]): RegExp | null {
  const tags = [...new Set(candidates.map((c) => c.tag.toLowerCase()).filter(Boolean))].sort(
    (a, b) => b.length - a.length,
  );
  if (tags.length === 0) return null;
  return new RegExp(
    `(^|[^\\p{L}\\p{N}])@(${tags.map(escapeForRegex).join('|')})(?![\\p{L}\\p{N}]|[_-]+[\\p{L}\\p{N}])`,
    'giu',
  );
}

/**
 * Whether a chip reads «this is about me» (the `is-me` accent). A person's tag: it is mine. `@all`: always — it
 * names everyone. `@online`: only while I am online myself (`viewerOnline`, the host's socket state) — if the
 * chat is open for me, I was among the people it called (ADR-201 Decision 4).
 */
function isAboutViewer(candidate: MentionCandidate, currentPersonId: string, viewerOnline: boolean): boolean {
  if (candidate.broadcast === 'all') return true;
  if (candidate.broadcast === 'online') return viewerOnline;
  return candidate.id === currentPersonId;
}

export function renderMentions(
  text: string,
  candidates: readonly MentionCandidate[] | undefined,
  currentPersonId: string,
  viewerOnline = false,
): ReactNode[] {
  const pattern = candidates?.length ? mentionPattern(candidates) : null;
  if (!pattern) return [text];
  const byTag = new Map(candidates!.map((c) => [c.tag.toLowerCase(), c] as const));
  const out: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const lead = match[1] ?? '';
    const tag = (match[2] ?? '').toLowerCase();
    const candidate = byTag.get(tag);
    if (!candidate) continue;
    const start = (match.index ?? 0) + lead.length;
    const end = start + 1 + (match[2] ?? '').length;
    if (start > last) out.push(text.slice(last, start));
    const mine = isAboutViewer(candidate, currentPersonId, viewerOnline);
    out.push(
      <span key={`${start}-${tag}`} className={`${MENTION_CLASS}${mine ? ` ${IS_ME_CLASS}` : ''}`}>
        {text.slice(start, end)}
      </span>,
    );
    last = end;
  }
  if (out.length === 0) return [text];
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/**
 * A message text as the bubble draws it: web addresses as links (`text-links`), `@tag` chips between them. The
 * address goes first, so a tag inside an address stays part of the link.
 */
export function renderMessageText(
  text: string,
  candidates: readonly MentionCandidate[] | undefined,
  currentPersonId: string,
  viewerOnline = false,
): ReactNode[] {
  return renderLinks(text, (plain) => renderMentions(plain, candidates, currentPersonId, viewerOnline));
}
