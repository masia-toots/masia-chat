import { MESSENGER_LANGS, type MessengerLang } from '@masia/contracts';

// The page speaks English. `?lang=uk` or `?lang=de` changes only the words the messenger itself ships
// in all three languages (the empty-contacts block); the rest of the bundle is English-only here.

export const DEFAULT_LANG: MessengerLang = 'en';

export function langFromSearch(search: string): MessengerLang {
  const asked = new URLSearchParams(search).get('lang');
  return MESSENGER_LANGS.find((lang) => lang === asked) ?? DEFAULT_LANG;
}
