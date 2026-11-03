import { describe, expect, it } from 'vitest';
import { MESSENGER_I18N_KEYS, MESSENGER_LANGS, type I18nBundle } from '../ports/i18n-bundle.js';
import { contractTitle, type ContractFactory } from './contract-support.js';

/** Variables the suite passes to every key; a key that ignores them must still answer. */
const CONTRACT_VARS = { name: 'Contract', device: 'Device', count: 2 };

/** Registers the behavioural contract every `I18nBundle` implementation must honour. */
export function describeI18nBundleContract<T extends I18nBundle>(
  name: string,
  factory: ContractFactory<T>,
): void {
  describe(contractTitle('I18nBundle', name), () => {
    it('reports one of the supported languages', async () => {
      const bundle = await factory();
      const supported: readonly string[] = MESSENGER_LANGS;
      expect(supported).toContain(bundle.lang);
    });

    it.each(MESSENGER_I18N_KEYS)('translates %s to a non-empty sentence', async (key) => {
      const bundle = await factory();
      expect(bundle.t(key).trim()).not.toBe('');
    });

    it.each(MESSENGER_I18N_KEYS)('does not answer %s with its own key', async (key) => {
      const bundle = await factory();
      expect(bundle.t(key)).not.toBe(key);
    });

    it('answers every key when variables are supplied, used or not', async () => {
      const bundle = await factory();
      for (const key of MESSENGER_I18N_KEYS) {
        expect(bundle.t(key, CONTRACT_VARS).trim()).not.toBe('');
      }
    });

    it('answers the same text for the same key twice', async () => {
      const bundle = await factory();
      expect(bundle.t('zone.encrypted')).toBe(bundle.t('zone.encrypted'));
    });
  });
}
