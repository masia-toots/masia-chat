import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { THEME_TOKEN_NAMES } from '@masia/contracts';
import { parseSeedContacts } from '@masia/messenger/contacts';

// The rules that keep the playground what it claims to be: a CLIENT of the open packages and nothing
// more. They are checks on the files themselves, so a later change that breaks one fails here.

const DEMO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = resolve(DEMO_ROOT, '..');
const SKIPPED_DIRS = new Set(['node_modules', 'dist']);

function filesUnder(dir: string, extensions: readonly string[]): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return SKIPPED_DIRS.has(entry.name) ? [] : filesUnder(join(dir, entry.name), extensions);
    return extensions.some((extension) => entry.name.endsWith(extension)) ? [join(dir, entry.name)] : [];
  });
}

const read = (path: string): string => readFileSync(path, 'utf8');
const shown = (path: string): string => relative(DEMO_ROOT, path).split(sep).join('/');

/** Every module specifier a file imports: static, side-effect, re-export and dynamic. */
function importsOf(source: string): string[] {
  const found = new Set<string>();
  for (const pattern of [
    /\bfrom\s*['"]([^'"\n]+)['"]/g,
    /\bimport\s*['"]([^'"\n]+)['"]/g,
    /\bimport\(\s*['"]([^'"\n]+)['"]/g,
  ]) {
    for (const match of source.matchAll(pattern)) found.add(match[1] as string);
  }
  return [...found];
}

/** `@scope/name/sub/path` -> `@scope/name`; `name/sub` -> `name`. */
function packageOf(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? specifier);
}

/** What the playground may import from outside itself. Never the relay, never a host application. */
const ALLOWED_PACKAGES = new Set([
  '@masia/messenger',
  '@masia/contracts',
  'react',
  'react-dom',
  '@mantine/core',
  '@mantine/hooks',
  '@vitejs/plugin-react',
  'vite',
  'vitest',
]);

describe('the playground imports only the open packages and its own files', () => {
  const sources = filesUnder(DEMO_ROOT, ['.ts', '.tsx', '.mjs']);

  it('finds the source it is meant to check', () => {
    expect(sources.length).toBeGreaterThan(25);
    expect(sources.map(shown)).toContain('src/client/runtime.ts');
    expect(sources.map(shown)).toContain('server/app.ts');
  });

  it('imports nothing but Node built-ins, allowed packages and files inside the playground', () => {
    const offenders: string[] = [];
    for (const path of sources) {
      for (const specifier of importsOf(read(path))) {
        if (specifier.startsWith('node:')) continue;
        if (specifier.startsWith('.')) {
          const target = resolve(dirname(path), specifier);
          if (target !== DEMO_ROOT && !target.startsWith(DEMO_ROOT + sep)) offenders.push(`${shown(path)} -> ${specifier}`);
          continue;
        }
        if (!ALLOWED_PACKAGES.has(packageOf(specifier))) offenders.push(`${shown(path)} -> ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('reaches the messenger and the contracts by their published entry points, never into their source', () => {
    const offenders: string[] = [];
    for (const path of sources) {
      for (const specifier of importsOf(read(path))) {
        if (/^@masia\/(messenger|contracts)\/(src|dist)\b/.test(specifier)) offenders.push(`${shown(path)} -> ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('declares no dependency on the relay, a host application or any other workspace package', () => {
    const manifest = JSON.parse(read(join(DEMO_ROOT, 'package.json'))) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const names = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
    const workspace = names.filter((name) => (manifest.dependencies?.[name] ?? manifest.devDependencies?.[name])?.startsWith('workspace:'));
    expect(workspace.sort()).toEqual(['@masia/contracts', '@masia/messenger']);
    expect(names.filter((name) => name.startsWith('@masia/') && !workspace.includes(name))).toEqual([]);
  });
});

describe('the suggested people', () => {
  /** The cell of the maintainers' table that says a person publishes no such contact. */
  const NO_CONTACT = '—';

  /** The rows of the maintainers' table: `[name, role, email, github]`, with `—` read as "none". */
  function maintainerRows(): string[][] {
    return read(join(REPO_ROOT, 'MAINTAINERS.md'))
      .split(/\r?\n/)
      .filter((line) => line.startsWith('|'))
      .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()))
      .filter((cells) => cells.length === 4 && cells[0] !== 'Name' && !/^-+$/.test(cells[0] ?? ''))
      .map((cells) => cells.map((cell) => (cell === NO_CONTACT ? '' : cell)));
  }
  const contacts = (): unknown => JSON.parse(read(join(DEMO_ROOT, 'contacts.json')));

  it('has the same people and contact details in contacts.json as in MAINTAINERS.md, person by person', () => {
    const rows = maintainerRows();
    const seeds = parseSeedContacts(contacts());
    expect(rows.length).toBeGreaterThan(0);
    expect(seeds.map((seed) => [seed.displayName, seed.email ?? '', seed.github ?? ''])).toEqual(
      rows.map((row) => [row[0], row[2], row[3]]),
    );
  });
});

describe('the look of the page', () => {
  const css = read(join(DEMO_ROOT, 'src', 'styles.css'));
  const defined = new Set([...css.matchAll(/(--demo-[a-z0-9-]+)\s*:/g)].map((match) => match[1] as string));

  it('gives a value to every colour and size the messenger draws itself from', () => {
    const missing = THEME_TOKEN_NAMES.map((name) => `--demo-${name.slice('--msg-'.length)}`).filter((name) => !defined.has(name));
    expect(missing).toEqual([]);
  });

  it('defines every --demo-* variable any file of the page reads', () => {
    const used = new Set<string>();
    for (const path of filesUnder(join(DEMO_ROOT, 'src'), ['.css', '.ts', '.tsx'])) {
      for (const match of read(path).matchAll(/var\((--demo-[a-z0-9-]+)\)/g)) used.add(match[1] as string);
    }
    expect([...used].filter((name) => !defined.has(name))).toEqual([]);
  });
});
