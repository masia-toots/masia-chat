import { describe, expect, it } from 'vitest';
import { MESSENGER_ICON_NAMES, type IconSet } from '../ports/icon-set.js';
import { contractTitle, type ContractFactory } from './contract-support.js';

/** Sizes the suite draws at: small, typical and large, in the host's own units. */
const CONTRACT_ICON_SIZES = [12, 24, 64] as const;

/** Registers the behavioural contract every `IconSet` implementation must honour. */
export function describeIconSetContract<T extends IconSet>(
  name: string,
  factory: ContractFactory<T>,
): void {
  describe(contractTitle('IconSet', name), () => {
    it.each(MESSENGER_ICON_NAMES)('draws the %s icon', async (icon) => {
      const icons = await factory();
      const drawn = icons.render(icon, CONTRACT_ICON_SIZES[1]);
      expect(drawn).not.toBeNull();
      expect(drawn).not.toBeUndefined();
    });

    it('draws at every size without throwing', async () => {
      const icons = await factory();
      for (const size of CONTRACT_ICON_SIZES) {
        expect(() => icons.render('send', size)).not.toThrow();
      }
    });

    it('draws without a size, leaving it to the host stylesheet', async () => {
      const icons = await factory();
      for (const icon of MESSENGER_ICON_NAMES) {
        expect(icons.render(icon)).not.toBeNull();
      }
    });

    it('draws with a class name on the icon, so a stylesheet can address one glyph', async () => {
      const icons = await factory();
      expect(() => icons.render('chat', undefined, 'contract-glyph')).not.toThrow();
      expect(icons.render('chat', undefined, 'contract-glyph')).not.toBeNull();
    });

    it('draws the same thing for the same request', async () => {
      const icons = await factory();
      expect(icons.render('lock', CONTRACT_ICON_SIZES[1])).toEqual(
        icons.render('lock', CONTRACT_ICON_SIZES[1]),
      );
    });
  });
}
