/**
 * No dead i18n keys (review round 1, group B removed nine): every key in `MESSENGER_I18N_KEYS` is
 * asked for by a screen of this package, because each one is a sentence every host must translate in
 * three languages. A key is "asked for" when its literal appears in the package source (tests and test
 * support excluded), or when it belongs to a family a screen builds from a template
 * (`devices.role.${role}`), listed below with the template that proves it.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MESSENGER_I18N_KEYS } from '@masia/contracts';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKIPPED_DIRS = new Set(['__tests__', 'test-support']);
const SOURCE_FILE = /\.tsx?$/;

/** Key families built from a template, and the template text that must appear in the source. */
const TEMPLATE_FAMILIES: Readonly<Record<string, string>> = {
  'devices.platform.': 'devices.platform.${',
  'devices.role.': 'devices.role.${',
};

function packageSource(dir: string): string {
  let text = '';
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (!SKIPPED_DIRS.has(name)) text += packageSource(path);
    } else if (SOURCE_FILE.test(name)) {
      text += readFileSync(path, 'utf8');
    }
  }
  return text;
}

describe('every messenger i18n key is asked for by a screen', () => {
  const source = packageSource(SRC);

  it('no key is dead', () => {
    const dead = MESSENGER_I18N_KEYS.filter((key) => {
      if (source.includes(`'${key}'`)) return false;
      const family = Object.keys(TEMPLATE_FAMILIES).find((prefix) => key.startsWith(prefix));
      return family === undefined || !source.includes(TEMPLATE_FAMILIES[family] ?? '');
    });
    expect(dead).toEqual([]);
  });
});
