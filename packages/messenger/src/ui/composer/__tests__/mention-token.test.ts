import { describe, expect, it } from 'vitest';
import type { MentionCandidate } from '../../provider/slots.js';
import { activeMentionToken, filterMentionCandidates, foldForMatch, insertMention, MENTION_POPOVER_MAX_ROWS } from '../mention-token.js';

const people: MentionCandidate[] = [
  { id: 'p1', tag: 'olena_k', name: 'Олена Коваль' },
  { id: 'p2', tag: 'joerg', name: 'Jörg Müller' },
  { id: 'masia', tag: 'masia', name: 'Masia' },
];

describe('activeMentionToken', () => {
  it('finds a bare @ at the caret', () => {
    expect(activeMentionToken('hi @', 4)).toEqual({ start: 3, end: 4, query: '' });
  });

  it('finds @ plus the letters typed so far', () => {
    expect(activeMentionToken('hi @ma', 6)).toEqual({ start: 3, end: 6, query: 'ma' });
  });

  it('is null when a space separates the caret from the @', () => {
    expect(activeMentionToken('@ma hello', 9)).toBeNull();
  });

  it('is null inside an address (a letter right before the @)', () => {
    expect(activeMentionToken('a@b', 3)).toBeNull();
  });

  it('opens after punctuation and at the start of the text', () => {
    expect(activeMentionToken('(@m', 3)).toEqual({ start: 1, end: 3, query: 'm' });
    expect(activeMentionToken('@', 1)).toEqual({ start: 0, end: 1, query: '' });
  });

  it('only looks at the text before the caret', () => {
    expect(activeMentionToken('@ma tail', 3)).toEqual({ start: 0, end: 3, query: 'ma' });
  });

  it('is null without any @', () => {
    expect(activeMentionToken('hello', 5)).toBeNull();
  });
});

describe('insertMention', () => {
  it('replaces the active token with @tag and a space, caret after it', () => {
    expect(insertMention('hi @ma', 6, 'masia')).toEqual({ value: 'hi @masia ', caret: 10 });
  });

  it('keeps the text after the caret', () => {
    expect(insertMention('@ol tail', 3, 'olena_k')).toEqual({ value: '@olena_k  tail', caret: 9 });
  });

  it('leaves the text alone when the caret is not in a token', () => {
    expect(insertMention('hello', 5, 'masia')).toEqual({ value: 'hello', caret: 5 });
  });
});

describe('filterMentionCandidates', () => {
  it('offers everyone for an empty query', () => {
    expect(filterMentionCandidates(people, '').map((c) => c.id)).toEqual(['p1', 'p2', 'masia']);
  });

  it('matches a prefix of the tag', () => {
    expect(filterMentionCandidates(people, 'ol').map((c) => c.id)).toEqual(['p1']);
  });

  it('matches a prefix of the name, case- and diacritics-insensitive, and of any word of it', () => {
    expect(filterMentionCandidates(people, 'олена').map((c) => c.id)).toEqual(['p1']);
    expect(filterMentionCandidates(people, 'jorg').map((c) => c.id)).toEqual(['p2']);
    expect(filterMentionCandidates(people, 'mül').map((c) => c.id)).toEqual(['p2']);
    expect(filterMentionCandidates(people, 'ковал').map((c) => c.id)).toEqual(['p1']);
  });

  it('offers nothing for a query nobody starts with', () => {
    expect(filterMentionCandidates(people, 'zzz')).toEqual([]);
  });

  it('cuts to the row limit', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ id: `p${i}`, tag: `tag${i}`, name: `Name ${i}` }));
    expect(filterMentionCandidates(many, 'tag')).toHaveLength(MENTION_POPOVER_MAX_ROWS);
  });

  it('folds case and diacritics', () => {
    expect(foldForMatch('Jörg É')).toBe('jorg e');
  });
});
