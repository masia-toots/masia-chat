/**
 * Seed contacts (К10b): the config reader and the words of the empty-state block.
 *
 * The reader's contract is «a half-filled stub is normal, junk is dropped, nothing throws», because the
 * list comes from a file a maintainer edits by hand. The words' contract is «every shipped language
 * has every sentence».
 *
 * Test by failure (planted in the reader, seen to fail, removed):
 *   - the `SEED_CONTACTS_MAX` cut dropped -> "keeps at most SEED_CONTACTS_MAX, in the file order, and cuts a long name".
 */
import { MESSENGER_LANGS } from '@masia/contracts';
import { describe, expect, it } from 'vitest';
import {
  parseSeedContacts,
  SEED_CONTACTS_MAX,
  SEED_CONTACTS_TEXT,
  SEED_NAME_MAX,
  seedContactLinks,
  seedContactsText,
} from '../seed-contacts.js';

describe('parseSeedContacts', () => {
  it('a half-filled stub is a person: empty email and GitHub become null', () => {
    const seeds = parseSeedContacts([{ name: 'Ada', email: '', github: '' }]);
    expect(seeds).toEqual([{ id: 'seed-1', displayName: 'Ada', email: null, github: null }]);
  });

  it('reads the array and the {contacts: [...]} wrapper alike', () => {
    const entry = { name: 'Ada', email: 'ada@example.org', github: 'ada' };
    expect(parseSeedContacts([entry])).toEqual(parseSeedContacts({ contacts: [entry] }));
    expect(parseSeedContacts([entry])[0]).toMatchObject({ email: 'ada@example.org', github: 'ada' });
  });

  it('keeps the config id when it has one, else numbers the entry by its place in the file', () => {
    const seeds = parseSeedContacts([{ id: 'lead', name: 'A' }, { name: 'B' }]);
    expect(seeds.map((s) => s.id)).toEqual(['lead', 'seed-2']);
  });

  it('a mail that is not one becomes null', () => {
    for (const email of ['a@b', 'plain', 'a b@example.org', '<a@example.org>', '@example.org']) {
      expect(parseSeedContacts([{ name: 'X', email }])[0]?.email, email).toBeNull();
    }
  });

  it('a profile URL or @handle is reduced to the login; a non-login becomes null', () => {
    const login = (github: string) => parseSeedContacts([{ name: 'X', github }])[0]?.github;
    expect(login('@ada')).toBe('ada');
    expect(login('https://github.com/ada')).toBe('ada');
    expect(login('https://github.com/ada/')).toBe('ada');
    expect(login('ada-lovelace')).toBe('ada-lovelace');
    expect(login('-ada')).toBeNull();
    expect(login('ada--x')).toBeNull();
    expect(login('ada/evil')).toBeNull();
    expect(login('a'.repeat(40))).toBeNull();
  });

  it('drops what is not a person and never throws', () => {
    expect(parseSeedContacts(null)).toEqual([]);
    expect(parseSeedContacts('x')).toEqual([]);
    expect(parseSeedContacts({})).toEqual([]);
    expect(parseSeedContacts([null, 3, 'x', [], {}, { name: '  ' }, { name: 7 }])).toEqual([]);
    expect(parseSeedContacts([{ name: 'Ok' }, null])).toHaveLength(1);
  });

  it('keeps at most SEED_CONTACTS_MAX, in the file order, and cuts a long name', () => {
    const many = Array.from({ length: SEED_CONTACTS_MAX + 3 }, (_, i) => ({ name: `P${i}` }));
    const seeds = parseSeedContacts(many);
    expect(seeds).toHaveLength(SEED_CONTACTS_MAX);
    expect(seeds[0]?.displayName).toBe('P0');
    expect(parseSeedContacts([{ name: 'n'.repeat(SEED_NAME_MAX + 20) }])[0]?.displayName).toHaveLength(
      SEED_NAME_MAX,
    );
  });
});

describe('seedContactLinks', () => {
  it('links only what the stub has', () => {
    expect(
      seedContactLinks({ id: 'a', displayName: 'A', email: 'a@example.org', github: 'a-b' }),
    ).toEqual({ mailto: 'mailto:a@example.org', github: 'https://github.com/a-b' });
    expect(seedContactLinks({ id: 'a', displayName: 'A', email: null, github: null })).toEqual({
      mailto: null,
      github: null,
    });
  });
});

describe('seedContactsText', () => {
  it('every shipped language has every sentence', () => {
    for (const lang of MESSENGER_LANGS) {
      const words = SEED_CONTACTS_TEXT[lang];
      for (const [field, value] of Object.entries(words)) {
        expect(value.trim().length, `${lang}.${field}`).toBeGreaterThan(0);
      }
    }
  });

  it('the three languages are three texts, and an unknown language reads English', () => {
    const leads = new Set(MESSENGER_LANGS.map((lang) => seedContactsText(lang).lead));
    expect(leads.size).toBe(MESSENGER_LANGS.length);
    expect(seedContactsText('xx' as never)).toBe(SEED_CONTACTS_TEXT.en);
  });
});
