/**
 * Who a conversation's text may mention (ADR-199 §5), built once per view from what the host knows:
 * the participants that have a handle (the one `Participant` list of the view, §8 — a person without a
 * `tag` is drawn with a face and a colour but is never a chip or a row), and the assistant when she can
 * be called in this room (the host says so — her mode and the room's encryption are its facts). Two
 * lists come out of one input: the chips mark everyone (including me, so «mentioned me» can look
 * different), the composer offers everyone but me.
 */
import { BROADCAST_MENTIONS, type BroadcastMention } from '../../protocol/messages.js';
import type { MentionCandidate, Participant } from '../provider/slots.js';

/** The assistant's candidate id and tag; her id is a sentinel, not a person. */
export const MASIA_MENTION_ID = 'masia';
export const MASIA_MENTION_TAG = 'masia';

/**
 * A broadcast candidate's `id` is `broadcast:<tag>` (a sentinel, never a person). The two tags themselves — the room
 * calls of ADR-201 Decision 4, in the order the popover offers them — are the wire's own pair, `BROADCAST_MENTIONS`
 * (`../../protocol/messages.ts`); the package cannot import the host's grammar, so the hub pins that pair to
 * `BROADCAST_TAGS` of `@masia/shared` with a drift test.
 */
export const BROADCAST_MENTION_ID_PREFIX = 'broadcast:';

/** The words of the two broadcast rows — the host's translations, passed in so this stays pure. */
export type BroadcastMentionLabels = Readonly<Record<BroadcastMention, string>>;

export interface MentionCandidateLists {
  /** Everyone whose `@tag` is drawn as a chip (me included). */
  readonly all: readonly MentionCandidate[];
  /** What the composer offers after `@` (me excluded). */
  readonly forComposer: readonly MentionCandidate[];
}

export const NO_MENTION_CANDIDATES: MentionCandidateLists = { all: [], forComposer: [] };

/** A participant with a handle — the only kind that can be mentioned. */
export function isMentionCandidate(p: Participant): p is MentionCandidate {
  return typeof p.tag === 'string' && p.tag.trim().length > 0;
}

/**
 * `broadcastLabels` present = the room takes `@all` / `@online` (the host decides: a GROUP or FAMILY room of
 * three or more people — in a DIRECT room and in the assistant's own chat they are plain words): two rows
 * join the list, AFTER the people so that `@a` still completes to `@alex` first. Absent: none.
 */
export function buildMentionCandidates(
  participants: readonly Participant[] | undefined,
  currentPersonId: string,
  masiaName: string | undefined,
  broadcastLabels?: BroadcastMentionLabels,
): MentionCandidateLists {
  const people = (participants ?? []).filter(isMentionCandidate);
  const rooms: MentionCandidate[] = broadcastLabels
    ? BROADCAST_MENTIONS.map((tag) => ({
        id: `${BROADCAST_MENTION_ID_PREFIX}${tag}`,
        tag,
        name: broadcastLabels[tag],
        broadcast: tag,
      }))
    : [];
  const all: MentionCandidate[] = [
    ...(masiaName ? [{ id: MASIA_MENTION_ID, tag: MASIA_MENTION_TAG, name: masiaName }] : []),
    ...people,
    ...rooms,
  ];
  if (all.length === 0) return NO_MENTION_CANDIDATES;
  return { all, forComposer: all.filter((c) => c.id !== currentPersonId) };
}
