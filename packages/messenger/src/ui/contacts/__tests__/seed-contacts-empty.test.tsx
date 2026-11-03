// @vitest-environment jsdom
/**
 * The People tab's empty state with seed contacts (К10b).
 *
 *   - no seeds -> the host's own `contacts.noContacts` line, unchanged (a host that passes nothing
 *     sees nothing new);
 *   - seeds -> the package's sentence in the bundle's language (uk / en / de), and each person with
 *     the links the stub has: a mail link only when there is a mail, a GitHub link only when there is
 *     a login, never an empty `href`;
 *   - a person who HAS contacts never sees the seeds: they are an empty state, not an ad.
 *
 * Test by failure (planted in the component, seen to fail, removed):
 *   - the `seedContacts.length === 0` guard reduced to `!seedContacts` -> "an empty seed list is the same as none";
 *   - `i18n.lang` ignored (always English) -> "the sentence follows the bundle's language".
 */
import { createFakeI18nBundle } from '@masia/contracts/fakes';
import { afterEach, describe, expect, it } from 'vitest';
import { circle, contact, HOME_CIRCLE_ID, makeCircles } from '../../../test-support/fake-circles.js';
import { cleanupUi, q, qa, renderUi } from '../../../test-support/fake-ui.js';
import type { SeedContact } from '../../../contacts/seed-contacts.js';
import { SEED_CONTACTS_TEXT } from '../../../contacts/seed-contacts.js';
import { PeoplePanel } from '../people-panel.js';

afterEach(cleanupUi);

const SEEDS: SeedContact[] = [
  { id: 'a', displayName: 'Ada', email: 'ada@example.org', github: 'ada' },
  { id: 'b', displayName: 'Bob', email: null, github: null },
];

function mountEmpty(over: Parameters<typeof renderUi>[1] = {}) {
  const { data } = makeCircles({ circles: [circle(HOME_CIRCLE_ID, 'R', [], true)], contacts: [] });
  return renderUi(<PeoplePanel data={data} onOpenContact={() => undefined} autoFocusSearch={false} />, over);
}

describe('People tab, empty, with seed contacts', () => {
  it("no seeds: the host's own line", () => {
    mountEmpty();
    expect(q('[data-sec=mine] .circlesel__empty')?.textContent).toBe('No contacts yet — find someone by @tag.');
    expect(q('[data-testid=seed-contacts]')).toBeNull();
  });

  it('an empty seed list is the same as none', () => {
    mountEmpty({ seedContacts: [] });
    expect(q('[data-testid=seed-contacts]')).toBeNull();
    expect(q('[data-sec=mine] .circlesel__empty')?.textContent).toContain('find someone by @tag');
  });

  it("the sentence follows the bundle's language", () => {
    for (const lang of ['uk', 'en', 'de'] as const) {
      mountEmpty({ seedContacts: SEEDS, i18n: createFakeI18nBundle(lang) });
      expect(q('[data-testid=seed-contacts] .circlesel__empty')?.textContent, lang).toBe(
        SEED_CONTACTS_TEXT[lang].lead,
      );
      expect(q('[data-testid=seed-contacts] h4')?.textContent, lang).toBe(SEED_CONTACTS_TEXT[lang].maintainers);
      cleanupUi();
    }
  });

  it('lists each person with the links the stub has and none it has not', () => {
    mountEmpty({ seedContacts: SEEDS });
    const ada = q('[data-seed-id=a]');
    const bob = q('[data-seed-id=b]');
    expect(ada?.querySelector('.circlesel__seed-name')?.textContent).toBe('Ada');
    expect(ada?.querySelector<HTMLAnchorElement>('[data-link=mail]')?.getAttribute('href')).toBe(
      'mailto:ada@example.org',
    );
    expect(ada?.querySelector<HTMLAnchorElement>('[data-link=github]')?.getAttribute('href')).toBe(
      'https://github.com/ada',
    );
    expect(bob?.querySelector('.circlesel__seed-name')?.textContent).toBe('Bob');
    expect(bob?.querySelectorAll('a')).toHaveLength(0);
    expect(qa('[data-testid=seed-contacts] a').every((a) => a.getAttribute('href'))).toBe(true);
  });

  it('GitHub opens in a new tab with noopener', () => {
    mountEmpty({ seedContacts: SEEDS });
    const link = q<HTMLAnchorElement>('[data-seed-id=a] [data-link=github]');
    expect(link?.target).toBe('_blank');
    expect(link?.rel).toContain('noopener');
    expect(link?.rel).toContain('noreferrer');
  });

  it('contacts present: no seeds', () => {
    const { data } = makeCircles({
      circles: [circle(HOME_CIRCLE_ID, 'R', [], true)],
      contacts: [contact('u1', 'Una', false, false)],
    });
    renderUi(<PeoplePanel data={data} onOpenContact={() => undefined} autoFocusSearch={false} />, {
      seedContacts: SEEDS,
    });
    expect(q('[data-testid=seed-contacts]')).toBeNull();
    expect(q('[data-user-id=u1]')).not.toBeNull();
  });
});
