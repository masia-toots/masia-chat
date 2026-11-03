/**
 * Seed contacts: the people a host offers a person who has NOBODY yet (К10b, the playground).
 *
 * ## What a seed is, and what it is not
 *
 * A seed is a SUGGESTION with real-world contact details (a name, an email, a GitHub handle). It is
 * not an entry of the address book: there is no `userId`, no chat to open and no relay behind it, so
 * it never reaches `ContactsDirectory`, never joins a circle and never shows a "send request"
 * button. Its one job is the empty state of the People tab, which would otherwise say «find someone
 * by @tag» to a person who knows nobody to look for. In the playground that sentence points at the
 * maintainers of the project; a host that has no use for it passes no seeds and sees the old text.
 *
 * ## Why not a method on the port
 *
 * `ContactsDirectory` is the contract between the messenger and every host's address book. A seed is
 * a deployment choice of one host (a config file, an env var), not data the host's server owns, so
 * it rides `MessengerUiServices.seedContacts` instead of widening a port every host would have to
 * implement and every contract suite would have to prove.
 *
 * ## Why the words live here
 *
 * The empty state needs three sentences ("no contacts yet", "or write to the maintainers", a label
 * for the mail and GitHub links). `MESSENGER_I18N_KEYS` is the frozen vocabulary of the host's
 * bundle, and adding a key to it is a change to the contracts package every host has to follow. The
 * seed block is an optional feature with its own words, so they are kept next to it, in the three
 * languages the messenger ships (`MESSENGER_LANGS`), and picked by the bundle's own `lang`.
 *
 * Pure data and string handling: no React, no DOM, no network.
 */
import type { MessengerLang } from '@masia/contracts';

/** One suggested person. Empty email / GitHub are `null`: a stub is allowed to be unfinished. */
export interface SeedContact {
  /** Stable key for the list (the config's own, or the index when the config has none). */
  readonly id: string;
  readonly displayName: string;
  readonly email: string | null;
  /** The bare GitHub login, without `@` or a URL. */
  readonly github: string | null;
}

/** Most seeds a host may show: a suggestion list, never a directory. */
export const SEED_CONTACTS_MAX = 8;
/** Longest display name kept, in characters. */
export const SEED_NAME_MAX = 80;

/** A mail address in the plain sense: one `@`, a dot in the domain, no spaces, no angle brackets. */
const EMAIL_PATTERN = /^[^\s@<>"]{1,64}@[^\s@<>"]{1,190}\.[^\s@<>".]{2,}$/u;
/** GitHub's own rule for a login: letters, digits, single hyphens, 1 to 39 characters, no edge hyphen. */
const GITHUB_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/u;

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Reads a seed list from untrusted config (a parsed JSON file, an env var). The shape is
 * `[{ "name": "...", "email": "...", "github": "..." }]`, or an object with that array under
 * `contacts`. Anything that is not a person is dropped, never thrown: a half-filled stub (empty
 * email, empty GitHub) is the normal case, and a typo in one entry must not blank the whole list.
 *
 *  - a person needs a non-empty `name` (cut at `SEED_NAME_MAX`);
 *  - an `email` that does not look like one, and a `github` that is not a login, become `null`
 *    (a leading `@` or a `github.com/` prefix on the login is tolerated and removed);
 *  - at most `SEED_CONTACTS_MAX` people are kept, in the file's order.
 */
export function parseSeedContacts(raw: unknown): SeedContact[] {
  const list =
    Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw['contacts']) ? raw['contacts'] : [];
  const seeds: SeedContact[] = [];
  list.forEach((entry: unknown, index) => {
    if (!isRecord(entry) || seeds.length >= SEED_CONTACTS_MAX) return;
    const name = text(entry['name']).slice(0, SEED_NAME_MAX).trim();
    if (name === '') return;
    const email = text(entry['email']);
    const login = text(entry['github'])
      .replace(/^https?:\/\/(www\.)?github\.com\//iu, '')
      .replace(/^@/u, '')
      .replace(/\/+$/u, '');
    const id = text(entry['id']);
    seeds.push({
      id: id !== '' ? id.slice(0, 64) : `seed-${index + 1}`,
      displayName: name,
      email: EMAIL_PATTERN.test(email) ? email : null,
      github: GITHUB_PATTERN.test(login) ? login : null,
    });
  });
  return seeds;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Where a seed's links point: a `mailto:` and a GitHub profile, each only when the stub has it. */
export function seedContactLinks(seed: SeedContact): { mailto: string | null; github: string | null } {
  return {
    mailto: seed.email === null ? null : `mailto:${seed.email}`,
    github: seed.github === null ? null : `https://github.com/${seed.github}`,
  };
}

/** The words of the seed block. */
export interface SeedContactsText {
  /** The empty-state sentence: replaces the host's own «no contacts yet» when seeds are present. */
  readonly lead: string;
  /** The label above the suggested people. */
  readonly maintainers: string;
  readonly mail: string;
  readonly github: string;
}

/** The seed block's words, in every language the messenger ships. */
export const SEED_CONTACTS_TEXT: Readonly<Record<MessengerLang, SeedContactsText>> = {
  uk: {
    lead: 'Контактів ще немає. Додайте когось за @тегом або напишіть мейнтейнерам.',
    maintainers: 'Мейнтейнери',
    mail: 'Пошта',
    github: 'GitHub',
  },
  en: {
    lead: 'No contacts yet. Add someone by @tag, or write to the maintainers.',
    maintainers: 'Maintainers',
    mail: 'Email',
    github: 'GitHub',
  },
  de: {
    lead: 'Noch keine Kontakte. Füge jemanden per @Tag hinzu oder schreibe den Maintainern.',
    maintainers: 'Maintainer',
    mail: 'E-Mail',
    github: 'GitHub',
  },
};

/** The words for `lang`; a language the table does not know reads English. */
export function seedContactsText(lang: MessengerLang): SeedContactsText {
  return SEED_CONTACTS_TEXT[lang] ?? SEED_CONTACTS_TEXT.en;
}
