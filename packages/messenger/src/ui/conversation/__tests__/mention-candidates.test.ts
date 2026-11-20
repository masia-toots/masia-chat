import { describe, expect, it } from 'vitest';
import type { Participant } from '../../provider/slots.js';
import { buildMentionCandidates, isMentionCandidate, MASIA_MENTION_ID, NO_MENTION_CANDIDATES } from '../mention-candidates.js';

const participants: Participant[] = [
  { id: 'me', tag: 'olena_k', name: 'Олена' },
  { id: 'p2', tag: 'mark', name: 'Mark', avatarUrl: 'https://x/m.png', color: '#f97316' },
  { id: 'p3', tag: '', name: 'No handle' },
  { id: 'p4', name: 'No account', color: '#22c55e' },
];

describe('buildMentionCandidates', () => {
  it('chips mark everyone with a handle (me included); the composer offers everyone but me', () => {
    const lists = buildMentionCandidates(participants, 'me', undefined);
    expect(lists.all.map((c) => c.id)).toEqual(['me', 'p2']);
    expect(lists.forComposer.map((c) => c.id)).toEqual(['p2']);
  });

  it('a participant without a tag (a face and a colour only, ADR-199 §8) is never a candidate', () => {
    expect(participants.filter(isMentionCandidate).map((p) => p.id)).toEqual(['me', 'p2']);
    const lists = buildMentionCandidates(participants, 'nobody', undefined);
    expect(lists.all.some((c) => c.id === 'p4' || c.id === 'p3')).toBe(false);
    // The colour rides along on the candidate the view keeps.
    expect(lists.all.find((c) => c.id === 'p2')!.color).toBe('#f97316');
  });

  it('puts the assistant first when she can be called, under the name the words give her', () => {
    const lists = buildMentionCandidates(participants, 'me', 'Мася');
    expect(lists.forComposer[0]).toEqual({ id: MASIA_MENTION_ID, tag: 'masia', name: 'Мася' });
    expect(lists.all[0]!.id).toBe(MASIA_MENTION_ID);
  });

  it('is the shared empty value when nobody can be mentioned', () => {
    expect(buildMentionCandidates(undefined, 'me', undefined)).toBe(NO_MENTION_CANDIDATES);
    expect(buildMentionCandidates([{ id: 'p3', tag: ' ', name: 'x' }], 'me', undefined)).toBe(NO_MENTION_CANDIDATES);
  });
});

// ADR-201 Decision 4: the host passes the two labels ONLY for a group/family room of three or more
// (`broadcastTagsApply`); without them (a DIRECT room, a group of two, the assistant's chat) there is no row, no chip.
describe('buildMentionCandidates — `@all` / `@online` rows', () => {
  const labels = { all: 'Усі в чаті', online: 'Хто зараз тут' };

  it('🔴 no labels (direct room, group of two, assistant chat) → no broadcast rows and no chips', () => {
    const lists = buildMentionCandidates(participants, 'me', 'Мася');
    expect(lists.all.some((c) => c.broadcast)).toBe(false);
    expect(lists.forComposer.some((c) => c.tag === 'all' || c.tag === 'online')).toBe(false);
  });

  it('🔴 with labels → `@all` and `@online`, last, in both lists (the sender may call their own room)', () => {
    const lists = buildMentionCandidates(participants, 'me', undefined, labels);
    expect(lists.all.map((c) => c.tag)).toEqual(['olena_k', 'mark', 'all', 'online']);
    expect(lists.forComposer.map((c) => c.tag)).toEqual(['mark', 'all', 'online']);
    expect(lists.forComposer.at(-2)).toEqual({ id: 'broadcast:all', tag: 'all', name: 'Усі в чаті', broadcast: 'all' });
    expect(lists.forComposer.at(-1)).toEqual({
      id: 'broadcast:online',
      tag: 'online',
      name: 'Хто зараз тут',
      broadcast: 'online',
    });
  });

  it('the rows come after the people and the assistant, so `@a` still completes to a person first', () => {
    const lists = buildMentionCandidates(participants, 'me', 'Мася', labels);
    expect(lists.all.map((c) => c.tag)).toEqual(['masia', 'olena_k', 'mark', 'all', 'online']);
  });

  it('a room with the labels but nobody else to mention still offers the two rows', () => {
    const lists = buildMentionCandidates([{ id: 'p4', name: 'No account' }], 'me', undefined, labels);
    expect(lists.all.map((c) => c.tag)).toEqual(['all', 'online']);
  });
});
