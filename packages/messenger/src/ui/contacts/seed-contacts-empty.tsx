/**
 * SeedContactsEmpty: the People tab's empty state when the host passed seed contacts (К10b).
 *
 * Without seeds it is exactly what the panel always drew: the host's own `contacts.noContacts`
 * line. With seeds the line becomes the package's three-language sentence («no contacts yet, add
 * someone or write to the maintainers») and the suggested people follow, each with the links the
 * stub has (mail, GitHub) and none it has not. A seed is a suggestion, not a contact: it has no
 * chat and no "send request", so it renders as plain text and links (see `seed-contacts.ts`).
 *
 * Links open in a new tab with `rel="noopener noreferrer"`; a `mailto:` hands the address to the
 * person's own mail client. The words come from the package table, picked by the bundle's `lang`.
 */
import { seedContactLinks, seedContactsText } from '../../contacts/seed-contacts.js';
import { useMessengerUi, useT } from '../provider/messenger-ui.js';

export function SeedContactsEmpty() {
  const { seedContacts, i18n } = useMessengerUi();
  const t = useT();
  if (!seedContacts || seedContacts.length === 0) {
    return <p className="circlesel__empty">{t('contacts.noContacts')}</p>;
  }
  const words = seedContactsText(i18n.lang);
  return (
    <div className="circlesel__seed" data-testid="seed-contacts">
      <p className="circlesel__empty">{words.lead}</p>
      <h4 className="circlesel__seed-h">{words.maintainers}</h4>
      <ul className="circlesel__seed-list">
        {seedContacts.map((seed) => {
          const links = seedContactLinks(seed);
          return (
            <li key={seed.id} className="circlesel__seed-item" data-seed-id={seed.id}>
              <span className="circlesel__seed-name">{seed.displayName}</span>
              {links.mailto && (
                <a className="circlesel__seed-link" data-link="mail" href={links.mailto}>
                  {words.mail}
                </a>
              )}
              {links.github && (
                <a
                  className="circlesel__seed-link"
                  data-link="github"
                  href={links.github}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {words.github}
                </a>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
