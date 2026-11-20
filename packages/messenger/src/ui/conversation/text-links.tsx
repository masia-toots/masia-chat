/**
 * Bare web addresses in a chat text become links (founder 2026-11-07, «лінка має бути лінкою»). THE ONE rule for
 * every chat bubble — a person's, my own, Masia's post in a family room, the AI chat's own lines — so an address is
 * clickable wherever a message is drawn, and nowhere is it decided twice.
 *
 * Safe by construction: only `http:` / `https:` with a host become an `href` (the URL parser normalises it; a
 * `javascript:` / `data:` / `ftp:` text never matches), and every link opens a new tab with `noopener noreferrer`.
 * Never an HTML string — the pieces map onto React elements, the text stays text.
 */
import { Fragment, type ReactNode } from 'react';

export const LINK_CLASS = 'hub-msg-link';

export interface TextPiece {
  readonly text: string;
  /** Present only for a safe web address: the normalised `href`. */
  readonly href?: string;
}

/** `http(s)://` where no letter or digit stands right before it, up to whitespace or a quote/angle bracket. */
const ADDRESS = /(?<![\p{L}\p{N}])https?:\/\/[^\s<>"«»“”]+/giu;
/** Punctuation that ends a sentence, not an address: «див. https://x.y/a.» — the dot is the sentence's. */
const TRAILING = /[.,;:!?…'’)\]}]+$/u;

/** A web address with a host, or null. Only `http:` / `https:` — the one gate for an `href` in a bubble. */
export function safeWebHref(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!url.hostname) return null;
  return url.href;
}

/** A closing bracket stays when the address opened one: `https://uk.wikipedia.org/wiki/Мова_(лінгвістика)`. */
function trimTrailing(candidate: string): string {
  let out = candidate;
  for (;;) {
    const tail = TRAILING.exec(out)?.[0];
    if (!tail) return out;
    const last = out.slice(-1);
    const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
    const open = pairs[last];
    if (open !== undefined && count(out, open) >= count(out, last)) return out;
    out = out.slice(0, -1);
  }
}

function count(text: string, ch: string): number {
  return text.split(ch).length - 1;
}

/** The text split into plain pieces and links, in order; a text without an address is one plain piece. */
export function splitLinks(text: string): TextPiece[] {
  const out: TextPiece[] = [];
  let last = 0;
  for (const match of text.matchAll(ADDRESS)) {
    const start = match.index ?? 0;
    const raw = trimTrailing(match[0]);
    const href = safeWebHref(raw);
    if (!href || raw.length <= 'https://'.length) continue;
    if (start > last) out.push({ text: text.slice(last, start) });
    out.push({ text: raw, href });
    last = start + raw.length;
  }
  if (last < text.length || out.length === 0) out.push({ text: text.slice(last) });
  return out;
}

/**
 * The text with its addresses as links. `renderPlain` draws the pieces between them (the bubble passes its `@tag`
 * chips) — so a tag inside an address (`https://x.com/@masia`) is never a chip.
 */
export function renderLinks(
  text: string,
  renderPlain: (plain: string) => ReactNode = (plain) => plain,
): ReactNode[] {
  return splitLinks(text).map((piece, i) =>
    piece.href === undefined ? (
      <Fragment key={i}>{renderPlain(piece.text)}</Fragment>
    ) : (
      <a key={i} className={LINK_CLASS} href={piece.href} target="_blank" rel="noopener noreferrer">
        {piece.text}
      </a>
    ),
  );
}
