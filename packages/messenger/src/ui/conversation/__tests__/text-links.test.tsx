// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { MentionCandidate } from '../../provider/slots.js';
import { renderMessageText } from '../render-mentions.js';
import { safeWebHref, splitLinks } from '../text-links.js';

/**
 * Founder 2026-11-07 in a family room: «@masia лінка має бути лінкою». Masia's post carried a bare share address in
 * the middle of a sentence and it was not clickable — the bubble drew text and `@tag` chips only.
 */
const MASIA_POST =
  'Готово! Ось сторінка для вас: https://example.org/share/fca08ed4 — відкрийте, коли буде хвилинка.';

const people: MentionCandidate[] = [
  { id: 'me', tag: 'olena_k', name: 'Олена' },
  { id: 'masia', tag: 'masia', name: 'Masia' },
];

function mount(text: string): HTMLElement {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  document.body.appendChild(host);
  act(() => createRoot(host).render(<div>{renderMessageText(text, people, 'me')}</div>));
  return host;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('splitLinks — a bare address in a chat text is a link', () => {
  it('🔴 the founder’s case: the share address mid-sentence is ONE link, the words around it stay text', () => {
    expect(splitLinks(MASIA_POST)).toEqual([
      { text: 'Готово! Ось сторінка для вас: ' },
      { text: 'https://example.org/share/fca08ed4', href: 'https://example.org/share/fca08ed4' },
      { text: ' — відкрийте, коли буде хвилинка.' },
    ]);
  });

  it('sentence punctuation after an address is the sentence’s, not the address’s', () => {
    for (const [text, link] of [
      ['див. https://example.org/a.', 'https://example.org/a'],
      ['(https://example.org/a)', 'https://example.org/a'],
      ['«https://example.org/a»', 'https://example.org/a'],
      ['це https://example.org/a?, так', 'https://example.org/a'],
      ['https://example.org/a!!!', 'https://example.org/a'],
    ] as const) {
      expect(splitLinks(text).find((p) => p.href)?.text, text).toBe(link);
    }
  });

  it('keeps a bracket the address opened itself, and a query with its own punctuation', () => {
    expect(splitLinks('https://uk.wikipedia.org/wiki/Мова_(лінгвістика).').find((p) => p.href)?.text).toBe(
      'https://uk.wikipedia.org/wiki/Мова_(лінгвістика)',
    );
    expect(splitLinks('https://example.org/a?x=1&y=2#top').find((p) => p.href)?.text).toBe('https://example.org/a?x=1&y=2#top');
  });

  it('plain http is a link too; several addresses in one text each get their own', () => {
    const links = splitLinks('спершу http://192.168.1.10:5173/x, потім https://example.org').filter((p) => p.href);
    expect(links.map((p) => p.text)).toEqual(['http://192.168.1.10:5173/x', 'https://example.org']);
  });

  it('🔴 never a link: javascript:, data:, ftp:, a bare scheme, a scheme glued to a word', () => {
    for (const text of [
      'javascript:alert(1)',
      'data:text/html,<b>x</b>',
      'ftp://files.example.com/a',
      'дивись https:// і все',
      'xhttps://example.org/a',
    ]) {
      expect(splitLinks(text).some((p) => p.href), text).toBe(false);
    }
    expect(safeWebHref('javascript:alert(1)')).toBeNull();
    expect(safeWebHref('https://example.org/a')).toBe('https://example.org/a');
  });

  it('a text without an address is one plain piece, verbatim', () => {
    expect(splitLinks('просто текст, без адрес')).toEqual([{ text: 'просто текст, без адрес' }]);
    expect(splitLinks('')).toEqual([{ text: '' }]);
  });
});

describe('renderMessageText — what the bubble draws', () => {
  it('🔴 the founder’s case renders a real anchor: new tab, noopener, the address as its label', () => {
    const host = mount(MASIA_POST);
    const a = host.querySelectorAll('a.hub-msg-link');
    expect(a).toHaveLength(1);
    expect(a[0]!.getAttribute('href')).toBe('https://example.org/share/fca08ed4');
    expect(a[0]!.getAttribute('target')).toBe('_blank');
    expect(a[0]!.getAttribute('rel')).toBe('noopener noreferrer');
    expect(host.textContent).toBe(MASIA_POST);
  });

  it('an @tag next to an address is still a chip; a tag INSIDE an address stays part of the link', () => {
    const host = mount('@masia глянь https://x.com/@masia/status/1 будь ласка');
    expect([...host.querySelectorAll('.hub-msg-mention')].map((n) => n.textContent)).toEqual(['@masia']);
    expect(host.querySelector('a.hub-msg-link')!.textContent).toBe('https://x.com/@masia/status/1');
  });

  it('a javascript: text renders no anchor at all', () => {
    const host = mount('натисни javascript:alert(1)');
    expect(host.querySelector('a')).toBeNull();
  });
});
