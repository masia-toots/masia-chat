// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { MentionCandidate } from '../../provider/slots.js';
import { renderMentions } from '../render-mentions.js';

const people: MentionCandidate[] = [
  { id: 'me', tag: 'olena_k', name: 'Олена' },
  { id: 'masia', tag: 'masia', name: 'Masia' },
];

function mount(text: string, who = 'me'): HTMLElement {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  document.body.appendChild(host);
  act(() => createRoot(host).render(<div>{renderMentions(text, people, who)}</div>));
  return host;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('renderMentions', () => {
  it('wraps a candidate tag in a chip and leaves the rest of the text verbatim', () => {
    const host = mount('hey @masia, come');
    const chips = host.querySelectorAll('.hub-msg-mention');
    expect(chips).toHaveLength(1);
    expect(chips[0]!.textContent).toBe('@masia');
    expect(chips[0]!.classList.contains('is-me')).toBe(false);
    expect(host.textContent).toBe('hey @masia, come');
  });

  it('returns the plain text when no tag matches, as one string', () => {
    expect(renderMentions('hey @nobody and a@b.c', people, 'me')).toEqual(['hey @nobody and a@b.c']);
    expect(renderMentions('plain', people, 'me')).toEqual(['plain']);
    expect(renderMentions('@masia', undefined, 'me')).toEqual(['@masia']);
  });

  it('marks the reader with is-me', () => {
    const host = mount('@olena_k see this');
    const chip = host.querySelector('.hub-msg-mention')!;
    expect(chip.classList.contains('is-me')).toBe(true);
    expect(mount('@olena_k', 'other').querySelector('.hub-msg-mention.is-me')).toBeNull();
  });

  describe('`@all` / `@online` chips (ADR-201 Decision 4)', () => {
    const room: MentionCandidate[] = [
      ...people,
      { id: 'broadcast:all', tag: 'all', name: 'Усі в чаті', broadcast: 'all' },
      { id: 'broadcast:online', tag: 'online', name: 'Хто зараз тут', broadcast: 'online' },
    ];
    function mountRoom(text: string, viewerOnline?: boolean): HTMLElement {
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
      const host = document.createElement('div');
      document.body.appendChild(host);
      act(() => createRoot(host).render(<div>{renderMentions(text, room, 'someone-else', viewerOnline)}</div>));
      return host;
    }

    it('🔴 `@all` is a chip and is-me for every reader, online or not', () => {
      for (const online of [true, false, undefined]) {
        const chip = mountRoom('@all, вечеря!', online).querySelector('.hub-msg-mention')!;
        expect(chip.textContent).toBe('@all');
        expect(chip.classList.contains('is-me')).toBe(true);
      }
    });

    it('🔴 `@online` is is-me only while the viewer is online', () => {
      const live = mountRoom('@online хто тут?', true).querySelector('.hub-msg-mention')!;
      expect(live.textContent).toBe('@online');
      expect(live.classList.contains('is-me')).toBe(true);
      expect(mountRoom('@online хто тут?', false).querySelector('.hub-msg-mention')!.classList.contains('is-me')).toBe(false);
      expect(mountRoom('@online хто тут?').querySelector('.hub-msg-mention')!.classList.contains('is-me')).toBe(false);
    });

    it('`@All` · `@all-` · `@all_` · `@Online` read like the server reads them (a trailing separator is punctuation); `@allan`, `@all-x` and an address are not chips', () => {
      const chips = [
        ...mountRoom('@All @all- @all_ (@Online) @allan @all-x x@all.com', true).querySelectorAll('.hub-msg-mention'),
      ];
      expect(chips.map((c) => c.textContent)).toEqual(['@All', '@all', '@all', '@Online']);
    });

    it('without the rows (direct room) `@all` stays plain text', () => {
      expect(renderMentions('@all @online', people, 'me', true)).toEqual(['@all @online']);
    });
  });

  it('reads the tag case-insensitively, stops at a handle boundary, and skips an address', () => {
    const host = mount('@Masia! @masiax olena@masia.example.org (@olena_k)');
    const chips = [...host.querySelectorAll('.hub-msg-mention')].map((c) => c.textContent);
    expect(chips).toEqual(['@Masia', '@olena_k']);
    expect(host.textContent).toBe('@Masia! @masiax olena@masia.example.org (@olena_k)');
  });
});
