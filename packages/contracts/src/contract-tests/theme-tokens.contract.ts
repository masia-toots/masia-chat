import { describe, expect, it } from 'vitest';
import { THEME_TOKEN_NAMES, type ThemeTokens } from '../ports/theme-tokens.js';
import { contractTitle, type ContractFactory } from './contract-support.js';

const CSS_CUSTOM_PROPERTY_PREFIX = '--';

/** Registers the contract every `ThemeTokens` value must honour. */
export function describeThemeTokensContract(
  name: string,
  factory: ContractFactory<ThemeTokens>,
): void {
  describe(contractTitle('ThemeTokens', name), () => {
    it.each(THEME_TOKEN_NAMES)('supplies a non-empty value for %s', async (token) => {
      const tokens = await factory();
      expect(tokens[token].trim()).not.toBe('');
    });

    it('supplies no token outside the fixed list', async () => {
      const tokens = await factory();
      const allowed: readonly string[] = THEME_TOKEN_NAMES;
      expect(Object.keys(tokens).filter((key) => !allowed.includes(key))).toEqual([]);
    });

    it('names every token as a CSS custom property', () => {
      expect(THEME_TOKEN_NAMES.every((token) => token.startsWith(CSS_CUSTOM_PROPERTY_PREFIX))).toBe(
        true,
      );
    });
  });
}
