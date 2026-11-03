// Negative control for the open-messenger boundary (ADR-161): a guard that has never been seen to
// FAIL proves nothing. This runs the host repository's real ESLint config over probe sources that sit
// inside the guarded packages and asserts the forbidden imports are rejected and the allowed ones are
// not. Since 2026-10-10 the guard is an ALLOWLIST (architecture review round 1, M14): workspace
// packages nobody thought to ban are refused too, and the probes below cover every one of them.
//
// The probes are deliberately NOT read from the lint config: if someone narrows the guard, this test
// must fail, which it cannot do if it reads the same list. They are derived from the host repository's
// own layout instead (its workspace file and the package manifests on disk), so this file names no
// package of the host, and a workspace package added tomorrow is probed without anyone editing here.
//
// It runs in both repositories: in the host's (where the homes sit beside the host's own packages and
// apps, and every one of them is probed) and in the open one (where only the playground sits beside
// them). The parts that need a host application are skipped where there is none; where the root lint
// config or the workspace file is absent the suite is skipped.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

// packages/contracts/src/__tests__ -> four levels up is the repository root.
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const WORKSPACE_FILE = 'pnpm-workspace.yaml';
const LINT_CONFIG_FILE = 'eslint.config.js';
/** Packages of the host's tooling: their own manifests, outside the workspace, in this directory. */
const TOOLING_DIR = 'tools';
const PROBE_FILE = '_boundary_probe.ts';
const RESTRICTED_IMPORTS_RULE = 'no-restricted-imports';
/** The start of the guard's message in either repository's lint config. */
const BOUNDARY_MESSAGE = 'Open messenger boundary';
const LINT_TIMEOUT_MS = 30_000;

const HAS_LINT_CONFIG =
  existsSync(path.join(REPO_ROOT, WORKSPACE_FILE)) &&
  existsSync(path.join(REPO_ROOT, LINT_CONFIG_FILE));

/**
 * The guard's subjects and, for each, the ONLY workspace packages it may import. Written out here on
 * purpose (see the header): the guard's own copy of this table is what is under test.
 */
const OPEN_HOMES = [
  { dir: 'packages/contracts', mayImport: ['@masia/contracts'] },
  { dir: 'packages/messenger', mayImport: ['@masia/contracts', '@masia/messenger'] },
  { dir: 'packages/relay', mayImport: ['@masia/contracts', '@masia/relay'] },
  { dir: 'apps/relay', mayImport: ['@masia/contracts', '@masia/relay', '@masia/relay-server'] },
] as const;

/** Spellings the guard must refuse whatever the package: the host's ORM client is the host's database. */
const ALWAYS_FORBIDDEN = ['@prisma/client'] as const;

/** The relay's vocabulary as a client may take it (architecture review round 2, M6). */
const RELAY_WIRE_SPECIFIERS = ['@masia/contracts/wire', '@masia/contracts/wire/relay-api'] as const;
/** The relay's code, which a client must never import. */
const RELAY_CODE_SPECIFIERS = ['@masia/relay', '@masia/relay-server'] as const;

interface WorkspacePackage {
  readonly dir: string;
  readonly name: string;
}

/** The `- "<glob>"` entries of the workspace file; only `<dir>/*` and plain directories are used here. */
function workspaceGlobs(): string[] {
  const text = readFileSync(path.join(REPO_ROOT, WORKSPACE_FILE), 'utf8');
  return text
    .split('\n')
    .map((line) => /^\s*-\s*["']?([^"'\s#]+)/u.exec(line)?.[1])
    .filter((entry): entry is string => entry !== undefined);
}

function subdirectories(dir: string): string[] {
  const full = path.join(REPO_ROOT, dir);
  if (!existsSync(full)) return [];
  return readdirSync(full, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${dir}/${entry.name}`);
}

/** Every package with a manifest: the workspace's members and the tooling's own packages. */
function packagesOnDisk(): WorkspacePackage[] {
  const dirs = [
    ...workspaceGlobs().flatMap((glob) =>
      glob.endsWith('/*') ? subdirectories(glob.slice(0, -2)) : [glob],
    ),
    ...subdirectories(TOOLING_DIR),
  ];
  const found: WorkspacePackage[] = [];
  for (const dir of dirs) {
    const manifest = path.join(REPO_ROOT, dir, 'package.json');
    if (!existsSync(manifest)) continue;
    const { name } = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: unknown };
    if (typeof name === 'string') found.push({ dir, name });
  }
  return found.sort((a, b) => a.dir.localeCompare(b.dir));
}

const isOpenHome = (dir: string) => OPEN_HOMES.some((home) => home.dir === dir);

const PACKAGES = HAS_LINT_CONFIG ? packagesOnDisk() : [];
/** Everything the host repository holds besides the four guarded homes. */
const HOST_PACKAGES = PACKAGES.filter((pkg) => !isOpenHome(pkg.dir));
/** The host's applications: the relay's clients, which reach it over the wire only. */
const HOST_APPS = HOST_PACKAGES.filter((pkg) => pkg.dir.startsWith('apps/'));
/** The open repository carries no application of the host: the parts that probe one are skipped there. */
const IS_HOST_REPOSITORY = HOST_APPS.length > 0;

/** What a file in `home` must not import: every package name outside its allowlist, and the ORM client. */
function forbiddenPackageSpecifiers(home: (typeof OPEN_HOMES)[number]): string[] {
  const allowed = new Set<string>(home.mayImport);
  const names = PACKAGES.map((pkg) => pkg.name).filter((name) => !allowed.has(name));
  // The bare name and a subpath: `!name/*` in the allowlist must not re-admit another package's subpaths.
  return [...names.flatMap((name) => [name, `${name}/deep/path`]), ...ALWAYS_FORBIDDEN];
}

/**
 * Relative climbs out of the package into another tree, as written from a file in `src/` and the
 * shorter spelling a file at the package root would write: the guard refuses them wherever the
 * importing file sits.
 */
function forbiddenRelativeClimbs(): string[] {
  return HOST_PACKAGES.flatMap((pkg) => [
    `../../../${pkg.dir}/src/index.js`,
    `../../${pkg.dir}/src/index.js`,
  ]);
}

const eslint = new ESLint({ cwd: REPO_ROOT });

async function lintProbe(dir: string, code: string): Promise<ESLint.LintResult> {
  const filePath = path.join(REPO_ROOT, dir, 'src', PROBE_FILE);
  const [result] = await eslint.lintText(code, { filePath });
  if (!result) throw new Error(`ESLint returned no result for ${filePath}`);
  return result;
}

function restrictedImportMessages(result: ESLint.LintResult) {
  return result.messages.filter((message) => message.ruleId === RESTRICTED_IMPORTS_RULE);
}

const MESSENGER = OPEN_HOMES[1];
const [FIRST_HOST_APP] = HOST_APPS;
const [FIRST_HOST_PACKAGE] = HOST_PACKAGES;

describe.skipIf(!HAS_LINT_CONFIG)('open messenger boundary (negative control)', () => {
  it('derives its probes from the repository: the homes, and the packages beside them', () => {
    // A derivation that found nothing would make every `each` below pass vacuously.
    expect(HOST_PACKAGES.length).toBeGreaterThan(0);
    expect(PACKAGES.filter((pkg) => isOpenHome(pkg.dir))).toHaveLength(OPEN_HOMES.length);
  });

  it.each([...forbiddenPackageSpecifiers(MESSENGER), ...forbiddenRelativeClimbs()])(
    'rejects `import ... from "%s"` inside the messenger',
    async (specifier) => {
      const result = await lintProbe(MESSENGER.dir, `import { x } from '${specifier}';\n`);
      const violations = restrictedImportMessages(result);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.severity).toBe(2);
      expect(violations[0]?.message).toContain(BOUNDARY_MESSAGE);
    },
    LINT_TIMEOUT_MS,
  );

  it.each(OPEN_HOMES.flatMap((home) => HOST_PACKAGES.map((pkg) => [home.dir, pkg.name] as const)))(
    'guards %s against the host package %s',
    async (dir, specifier) => {
      const result = await lintProbe(dir, `import { x } from '${specifier}';\n`);
      expect(restrictedImportMessages(result)).toHaveLength(1);
    },
    LINT_TIMEOUT_MS,
  );

  it(
    'accepts a type import from @masia/contracts (zero errors)',
    async () => {
      // The export keeps `no-unused-vars` quiet, so the assertion is «zero errors», not merely
      // «zero boundary errors».
      const code = [
        "import type { AuthSession } from '@masia/contracts';",
        'export type Probe = AuthSession;',
        '',
      ].join('\n');
      const result = await lintProbe(MESSENGER.dir, code);
      expect(result.errorCount).toBe(0);
    },
    LINT_TIMEOUT_MS,
  );

  it.each([
    ['packages/relay', '@masia/messenger'],
    ['apps/relay', '@masia/messenger/ui'],
    ['packages/contracts', '@masia/relay'],
    ['packages/relay', '@masia/relay-server'],
  ] as const)(
    'rejects, inside %s, `import ... from "%s"` (each home has its own allowlist)',
    async (dir, specifier) => {
      const result = await lintProbe(dir, `import { x } from '${specifier}';\n`);
      expect(restrictedImportMessages(result)).toHaveLength(1);
    },
    LINT_TIMEOUT_MS,
  );

  it.each([
    ['packages/messenger', '@masia/contracts/wire'],
    ['packages/relay', '@masia/contracts/wire'],
    ['apps/relay', '@masia/relay'],
    ['apps/relay', '@masia/contracts'],
  ] as const)(
    'allows, inside %s, `import ... from "%s"`',
    async (dir, specifier) => {
      const result = await lintProbe(dir, `import { x } from '${specifier}';\n`);
      expect(restrictedImportMessages(result)).toEqual([]);
    },
    LINT_TIMEOUT_MS,
  );

  // The relay's clients inside the host (architecture review round 2, M6): every host application
  // takes the relay's vocabulary from the contracts, never from the relay. Host repository only.
  it
    .skipIf(!IS_HOST_REPOSITORY)
    .each(
      HOST_APPS.flatMap((app) =>
        RELAY_CODE_SPECIFIERS.map((specifier) => [app.dir, specifier] as const),
      ),
    )(
    'rejects, inside the relay client %s, `import ... from "%s"`',
    async (dir, specifier) => {
      const result = await lintProbe(dir, `import { x } from '${specifier}';\n`);
      expect(restrictedImportMessages(result)).toHaveLength(1);
    },
    LINT_TIMEOUT_MS,
  );

  it
    .skipIf(!IS_HOST_REPOSITORY)
    .each(
      HOST_APPS.flatMap((app) =>
        RELAY_WIRE_SPECIFIERS.map((specifier) => [app.dir, specifier] as const),
      ),
    )(
    'allows, inside the relay client %s, `import ... from "%s"`',
    async (dir, specifier) => {
      const result = await lintProbe(dir, `import { x } from '${specifier}';\n`);
      expect(restrictedImportMessages(result)).toEqual([]);
    },
    LINT_TIMEOUT_MS,
  );

  it.skipIf(!IS_HOST_REPOSITORY)(
    'is scoped: a host application may still import another host package',
    async () => {
      if (FIRST_HOST_APP === undefined || FIRST_HOST_PACKAGE === undefined)
        throw new Error('no host package found');
      const result = await lintProbe(
        FIRST_HOST_APP.dir,
        `import { x } from '${FIRST_HOST_PACKAGE.name}';\n`,
      );
      expect(restrictedImportMessages(result)).toEqual([]);
    },
    LINT_TIMEOUT_MS,
  );
});
