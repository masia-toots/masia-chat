// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanupUi, click, pressKey, q, qa, renderUi, typeInto } from '../../../test-support/fake-ui.js';
import type { MentionCandidate } from '../../provider/slots.js';
import { Composer } from '../composer.js';

afterEach(cleanupUi);

const box = (): HTMLTextAreaElement => q<HTMLTextAreaElement>('.msg-composer__input')!;
const listbox = (): HTMLElement | null => q('[role="listbox"]');
const options = (): HTMLElement[] => qa('[role="option"]');

const people: MentionCandidate[] = [
  { id: 'masia', tag: 'masia', name: 'Masia' },
  { id: 'p1', tag: 'olena_k', name: 'Олена', avatarUrl: 'https://x/olena.png' },
  { id: 'p2', tag: 'mark', name: 'Mark' },
];

describe('Composer with mention candidates', () => {
  it('shows nothing until an @ is typed, then lists everyone, with a name and @tag per row', () => {
    renderUi(<Composer onSend={() => undefined} mentionCandidates={people} />);
    typeInto(box(), 'hello');
    expect(listbox()).toBeNull();
    typeInto(box(), 'hello @');
    expect(listbox()).not.toBeNull();
    expect(listbox()!.getAttribute('aria-label')).toBe('Mention someone — @');
    expect(options()).toHaveLength(3);
    expect(options()[1]!.textContent).toContain('Олена');
    expect(options()[1]!.textContent).toContain('@olena_k');
    expect(options()[1]!.querySelector('img')!.getAttribute('src')).toBe('https://x/olena.png');
    // an initial stands in for a missing picture
    expect(options()[2]!.querySelector('.msg-mention-popover__avatar--initial')!.textContent).toBe('M');
  });

  it('filters by prefix of tag or name and highlights the first row for the keyboard', () => {
    renderUi(<Composer onSend={() => undefined} mentionCandidates={people} />);
    typeInto(box(), '@ma');
    const row = (o: HTMLElement): string => `${o.querySelector('.msg-mention-popover__name')!.textContent} ${o.querySelector('.msg-mention-popover__tag')!.textContent}`;
    expect(options().map(row)).toEqual(['Masia @masia', 'Mark @mark']);
    expect(options()[0]!.getAttribute('aria-selected')).toBe('true');
    expect(box().getAttribute('aria-activedescendant')).toBe(options()[0]!.id);
  });

  it('Enter with the popover open inserts «@tag » instead of sending; ↓ moves the highlight', () => {
    const onSend = vi.fn();
    renderUi(<Composer onSend={onSend} mentionCandidates={people} />);
    typeInto(box(), 'hi @ma');
    pressKey(box(), 'ArrowDown');
    expect(options()[1]!.getAttribute('aria-selected')).toBe('true');
    pressKey(box(), 'Enter');
    expect(onSend).not.toHaveBeenCalled();
    expect(box().value).toBe('hi @mark ');
    expect(box().selectionStart).toBe('hi @mark '.length);
    expect(listbox()).toBeNull();
    // a second Enter now sends the finished line
    pressKey(box(), 'Enter');
    expect(onSend).toHaveBeenCalledWith('hi @mark');
  });

  it('Tab inserts too, and a tap on a row inserts', () => {
    renderUi(<Composer onSend={() => undefined} mentionCandidates={people} />);
    typeInto(box(), '@ol');
    pressKey(box(), 'Tab');
    expect(box().value).toBe('@olena_k ');
    typeInto(box(), '@olena_k @');
    click(options()[0] ?? null);
    expect(box().value).toBe('@olena_k @masia ');
  });

  it('Esc closes the popover for this token and Enter then sends', () => {
    const onSend = vi.fn();
    renderUi(<Composer onSend={onSend} mentionCandidates={people} />);
    typeInto(box(), '@ma');
    pressKey(box(), 'Escape');
    expect(listbox()).toBeNull();
    pressKey(box(), 'Enter');
    expect(onSend).toHaveBeenCalledWith('@ma');
  });

  it('closes when nobody matches, and never opens inside an address', () => {
    renderUi(<Composer onSend={() => undefined} mentionCandidates={people} />);
    typeInto(box(), '@zzz');
    expect(listbox()).toBeNull();
    typeInto(box(), 'olena@ma');
    expect(listbox()).toBeNull();
  });

  it('without candidates there is no popover and no aria-autocomplete', () => {
    renderUi(<Composer onSend={() => undefined} />);
    typeInto(box(), '@ma');
    expect(listbox()).toBeNull();
    expect(box().getAttribute('aria-autocomplete')).toBeNull();
  });
});

// ADR-201 Decision 4: `@all` / `@online` rows draw a glyph (no face) and insert like any other row.
describe('Composer with the broadcast rows', () => {
  const room: MentionCandidate[] = [
    { id: 'p2', tag: 'mark', name: 'Mark' },
    { id: 'broadcast:all', tag: 'all', name: 'Усі в чаті', broadcast: 'all' },
    { id: 'broadcast:online', tag: 'online', name: 'Хто зараз тут', broadcast: 'online' },
  ];

  it('lists both rows with a glyph instead of an initial or picture, labelled and tagged', () => {
    renderUi(<Composer onSend={() => undefined} mentionCandidates={room} />);
    typeInto(box(), '@');
    expect(options()).toHaveLength(3);
    for (const row of [options()[1]!, options()[2]!]) {
      expect(row.querySelector('.msg-mention-popover__avatar--room svg')).not.toBeNull();
      expect(row.querySelector('.msg-mention-popover__avatar--initial')).toBeNull();
      expect(row.querySelector('img')).toBeNull();
    }
    expect(options()[1]!.textContent).toContain('Усі в чаті');
    expect(options()[1]!.textContent).toContain('@all');
    expect(options()[2]!.textContent).toContain('@online');
  });

  it('`@al` narrows to the `all` row and Enter inserts «@all »; `@on` finds `online`', () => {
    const onSend = vi.fn();
    renderUi(<Composer onSend={onSend} mentionCandidates={room} />);
    typeInto(box(), 'hey @al');
    expect(options()).toHaveLength(1);
    pressKey(box(), 'Enter');
    expect(onSend).not.toHaveBeenCalled();
    expect(box().value).toBe('hey @all ');
    typeInto(box(), '@on');
    expect(options().map((o) => o.querySelector('.msg-mention-popover__tag')!.textContent)).toEqual(['@online']);
  });
});
