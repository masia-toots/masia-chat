import { createHash, randomBytes } from 'node:crypto';
import { MAX_REACH_USERS, type RelayTokenSubject } from '@masia/contracts/wire';
import { DISPLAY_NAME_MAX } from '../shared/paths.js';

// The playground's account book: who has opened a tab, in memory, gone on restart. DEMO ONLY.
//
// A real host has accounts, passwords or OAuth, and a social graph that decides who is introduced to
// whom. The playground has none of that: opening the page and typing a name makes a new person, and the
// "social graph" is "everybody who is here", so two tabs can find each other without a directory
// service. That is the whole point of the `reach` claim (the host's introductions) and the only place
// the playground has to decide anything about it.

/** Most people kept; the oldest is forgotten first. A playground, never a service. */
export const PEOPLE_MAX = 256;

/**
 * How long a person counts as "here" after their tab last called in. The page asks every few seconds; a
 * background tab is slowed by the browser to about once a minute, so this is a little over two of those.
 * A reloaded tab is a new person, so without this the list would keep every earlier tab of the day.
 */
export const PRESENCE_MS = 150_000;

export interface Person {
  readonly userId: string;
  readonly deviceId: string;
  readonly displayName: string;
  readonly joinedAt: number;
}

/** What a visitor gets back when they sign in: the secret that proves the next call is theirs. */
export interface SignedIn {
  readonly person: Person;
  readonly session: string;
}

export interface PeopleBook {
  signIn(rawName: unknown): SignedIn | null;
  /** The person behind a session secret, or `null`. */
  bySession(session: unknown): Person | null;
  /** Everyone but `userId` who is here (see `PRESENCE_MS`), newest first, as the visitor may see them. */
  others(userId: string): readonly Pick<Person, 'userId' | 'displayName'>[];
  /** What the relay token for this person says: no admin rights, introduced to the newest others who are here. */
  subjectOf(person: Person): RelayTokenSubject;
  readonly size: number;
}

/** A name a person may type: printable text, no control or format characters, 1 to `DISPLAY_NAME_MAX`. */
export function cleanDisplayName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.normalize('NFC').replace(/\s+/gu, ' ').trim();
  if (name === '' || [...name].length > DISPLAY_NAME_MAX) return null;
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(name)) return null;
  return name;
}

const sessionKey = (session: string): string => createHash('sha256').update(session).digest('hex');
/** A wire id of a given prefix: letters, digits, `_` and `-` only, well under the id limit. */
const newId = (prefix: string): string => `${prefix}-${randomBytes(9).toString('base64url')}`;

export function createPeopleBook(now: () => number = Date.now): PeopleBook {
  const bySessionKey = new Map<string, Person>();
  const byUser = new Map<string, Person>();
  const lastSeen = new Map<string, number>();

  function forget(person: Person): void {
    byUser.delete(person.userId);
    lastSeen.delete(person.userId);
    for (const [key, candidate] of bySessionKey) {
      if (candidate.userId === person.userId) bySessionKey.delete(key);
    }
  }

  const isHere = (person: Person): boolean => now() - (lastSeen.get(person.userId) ?? 0) <= PRESENCE_MS;

  /** Everyone but `userId` who is here, newest first. */
  const othersHere = (userId: string): Person[] =>
    [...byUser.values()].filter((person) => person.userId !== userId && isHere(person)).reverse();

  return {
    signIn(rawName) {
      const displayName = cleanDisplayName(rawName);
      if (displayName === null) return null;
      if (byUser.size >= PEOPLE_MAX) {
        const oldest = byUser.values().next().value;
        if (oldest !== undefined) forget(oldest);
      }
      const person: Person = {
        userId: newId('u'),
        deviceId: newId('d'),
        displayName,
        joinedAt: now(),
      };
      const session = randomBytes(32).toString('base64url');
      byUser.set(person.userId, person);
      lastSeen.set(person.userId, now());
      bySessionKey.set(sessionKey(session), person);
      return { person, session };
    },
    bySession(session) {
      const person =
        typeof session === 'string' && session !== '' ? (bySessionKey.get(sessionKey(session)) ?? null) : null;
      if (person !== null) lastSeen.set(person.userId, now());
      return person;
    },
    others(userId) {
      return othersHere(userId).map(({ userId: id, displayName }) => ({ userId: id, displayName }));
    },
    subjectOf(person) {
      const reach = othersHere(person.userId)
        .slice(0, MAX_REACH_USERS)
        .map((other) => other.userId);
      return { userId: person.userId, deviceId: person.deviceId, adminOf: [], guardianOf: [], reach };
    },
    get size() {
      return byUser.size;
    },
  };
}
