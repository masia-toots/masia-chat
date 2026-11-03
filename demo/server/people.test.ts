import { describe, expect, it } from 'vitest';
import { MAX_REACH_USERS } from '@masia/contracts/wire';
import { DISPLAY_NAME_MAX } from '../shared/paths.js';
import { cleanDisplayName, createPeopleBook, PEOPLE_MAX, PRESENCE_MS } from './people.js';

function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

function signedIn(book: ReturnType<typeof createPeopleBook>, name: string) {
  const result = book.signIn(name);
  if (result === null) throw new Error(`could not sign in "${name}"`);
  return result;
}

describe('cleanDisplayName', () => {
  it('trims, collapses inner whitespace and keeps ordinary text in any script', () => {
    expect(cleanDisplayName('  Ada   Lovelace ')).toBe('Ada Lovelace');
    expect(cleanDisplayName('Привіт')).toBe('Привіт');
    expect(cleanDisplayName('Zoë')).toBe('Zoë');
  });

  it('refuses what is not a name', () => {
    expect(cleanDisplayName(undefined)).toBeNull();
    expect(cleanDisplayName(42)).toBeNull();
    expect(cleanDisplayName('')).toBeNull();
    expect(cleanDisplayName('   ')).toBeNull();
    // Built from code points so the source holds no invisible character.
    const control = String.fromCodePoint(0x0);
    const bidiOverride = String.fromCodePoint(0x202e);
    expect(cleanDisplayName(`a${control}b`)).toBeNull();
    expect(cleanDisplayName(`a${bidiOverride}b`)).toBeNull();
  });

  it('treats any kind of space, a line separator included, as one plain space', () => {
    expect(cleanDisplayName(`a${String.fromCodePoint(0x2028)}${String.fromCodePoint(0xa0)}b`)).toBe('a b');
  });

  it('counts characters, not bytes, against the limit', () => {
    expect(cleanDisplayName('я'.repeat(DISPLAY_NAME_MAX))).not.toBeNull();
    expect(cleanDisplayName('я'.repeat(DISPLAY_NAME_MAX + 1))).toBeNull();
  });
});

describe('the people book', () => {
  it('signs a person in with fresh ids and a secret that finds them again', () => {
    const book = createPeopleBook();
    const { person, session } = signedIn(book, 'Ada');
    expect(person.displayName).toBe('Ada');
    expect(person.userId).toMatch(/^u-/);
    expect(person.deviceId).toMatch(/^d-/);
    expect(book.bySession(session)).toBe(person);
    expect(book.bySession('wrong')).toBeNull();
    expect(book.bySession('')).toBeNull();
    expect(book.bySession(undefined)).toBeNull();
    expect(signedIn(book, 'Ada').person.userId).not.toBe(person.userId);
  });

  it('refuses a bad name without making anyone', () => {
    const book = createPeopleBook();
    expect(book.signIn('')).toBeNull();
    expect(book.size).toBe(0);
  });

  it('lists everyone but the asker, newest first', () => {
    const book = createPeopleBook();
    const ada = signedIn(book, 'Ada').person;
    const bo = signedIn(book, 'Bo').person;
    const cy = signedIn(book, 'Cy').person;
    expect(book.others(ada.userId).map((p) => p.displayName)).toEqual(['Cy', 'Bo']);
    expect(book.others(cy.userId).map((p) => p.userId)).toEqual([bo.userId, ada.userId]);
    expect(Object.keys(book.others(ada.userId)[0] ?? {}).sort()).toEqual(['displayName', 'userId']);
  });

  it('introduces a person to those who are here, and to no one else, and gives no admin rights', () => {
    const book = createPeopleBook();
    const ada = signedIn(book, 'Ada').person;
    const bo = signedIn(book, 'Bo').person;
    expect(book.subjectOf(ada)).toEqual({
      userId: ada.userId,
      deviceId: ada.deviceId,
      adminOf: [],
      guardianOf: [],
      reach: [bo.userId],
    });
  });

  it('introduces at most MAX_REACH_USERS people, the newest', () => {
    const book = createPeopleBook();
    const first = signedIn(book, 'First').person;
    const others = Array.from({ length: MAX_REACH_USERS + 5 }, (_, i) => signedIn(book, `P${i}`).person);
    const reach = book.subjectOf(first).reach ?? [];
    expect(reach).toHaveLength(MAX_REACH_USERS);
    expect(reach[0]).toBe(others[others.length - 1]?.userId);
  });

  it('forgets the oldest person once the book is full', () => {
    const book = createPeopleBook();
    const oldest = signedIn(book, 'Oldest');
    for (let i = 0; i < PEOPLE_MAX; i += 1) signedIn(book, `P${i}`);
    expect(book.size).toBe(PEOPLE_MAX);
    expect(book.bySession(oldest.session)).toBeNull();
  });

  describe('presence', () => {
    it('drops a person from the lists once their tab has not called in for PRESENCE_MS', () => {
      const time = clock();
      const book = createPeopleBook(time.now);
      const ada = signedIn(book, 'Ada');
      const bo = signedIn(book, 'Bo');

      time.advance(PRESENCE_MS);
      expect(book.others(ada.person.userId).map((p) => p.displayName)).toEqual(['Bo']);

      time.advance(1);
      expect(book.others(ada.person.userId)).toEqual([]);
      expect(book.subjectOf(ada.person).reach).toEqual([]);
      // Still in the book: their session works, and calling in brings them back.
      expect(book.bySession(bo.session)).toBe(bo.person);
      expect(book.others(ada.person.userId).map((p) => p.displayName)).toEqual(['Bo']);
    });

    it('is kept up by every call a tab makes with its session', () => {
      const time = clock();
      const book = createPeopleBook(time.now);
      const ada = signedIn(book, 'Ada');
      const bo = signedIn(book, 'Bo');
      for (let i = 0; i < 5; i += 1) {
        time.advance(PRESENCE_MS / 2);
        book.bySession(bo.session);
      }
      expect(book.others(ada.person.userId).map((p) => p.displayName)).toEqual(['Bo']);
    });
  });
});
