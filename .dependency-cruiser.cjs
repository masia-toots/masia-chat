/* global module */
// The open repository's boundary, second net. Run: `pnpm boundary`.
//
// The first net is the `no-restricted-imports` block in eslint.config.js, which reads the import TEXT.
// This one RESOLVES every import to the file it lands on, so a relative path, a workspace alias or a
// re-export cannot slip past, and `tsPreCompilationDeps` makes it see `import type` too (a type-only reach
// across the boundary is still a reach).
//
// Guarded: packages/contracts, packages/messenger, packages/relay, apps/relay and demo (the playground).
// An ALLOWLIST: each guarded file may land only on its own package, @masia/contracts (the playground may
// also land on the client), a node builtin or an npm package its package.json declares. Any other file in
// the workspace, including a package added tomorrow, is a violation without being named here.

const OPEN_PACKAGES = '^(packages/(contracts|messenger|relay)|apps/relay|demo)/';
const MESSENGER = '^packages/messenger/';
const RELAY = '^(packages/relay|apps/relay)/';
const CONTRACTS = '^packages/contracts/';
const PLAYGROUND = '^demo/';
/** Third-party code, resolved through pnpm's store (a workspace package resolves to its real path). */
const NPM = '(^|/)node_modules/';
/** The repository's shared test setup, which each package's `vitest.config.ts` extends; it imports only vitest. */
const ROOT_TEST_CONFIG = '^vitest\\.shared\\.ts$';
/** A host application's Prisma client: an npm path, so the allowlist alone would let it through. */
const PRISMA_CLIENT = '(^|/)node_modules/@prisma/client(/|$)';

/** Where a guarded file may land besides node builtins: its own home, the contracts, npm, test setup. */
const allowlistRule = (name, from, allowed, comment) => ({
  name,
  severity: 'error',
  comment,
  from: { path: from },
  to: { pathNot: [...allowed, NPM, ROOT_TEST_CONFIG], dependencyTypesNot: ['core'] },
});

module.exports = {
  forbidden: [
    allowlistRule(
      'contracts-imports-nothing-from-workspace',
      CONTRACTS,
      [CONTRACTS],
      'The ports are the root of the dependency graph: @masia/contracts imports no other ' +
        'workspace file, so nothing can ever form a cycle through it.',
    ),
    allowlistRule(
      'messenger-imports-only-contracts',
      MESSENGER,
      [MESSENGER, CONTRACTS],
      'Open messenger boundary (ADR-161): the client imports only @masia/contracts and its own ' +
        'deps, not the host and not the relay (they meet through the wire). Add a port, never an import.',
    ),
    allowlistRule(
      'relay-imports-only-contracts',
      RELAY,
      [RELAY, CONTRACTS],
      'Open messenger boundary (ADR-161): the relay imports only @masia/contracts and its own ' +
        'deps, not the host and not the client. Add a port, never an import.',
    ),
    allowlistRule(
      'playground-imports-only-messenger-and-contracts',
      PLAYGROUND,
      [PLAYGROUND, MESSENGER, CONTRACTS],
      'Open messenger boundary (ADR-161): the playground is a CLIENT of the open packages. It imports ' +
        '@masia/messenger, @masia/contracts and its own files, never the relay (it talks to it over the ' +
        'wire) and never a host application.',
    ),
    {
      name: 'open-messenger-no-host-prisma-client',
      severity: 'error',
      comment: "A host's Prisma client is the host's database: never the open packages'.",
      from: { path: OPEN_PACKAGES },
      to: { path: PRISMA_CLIENT },
    },
    {
      name: 'open-messenger-declared-npm-only',
      severity: 'error',
      comment:
        'An npm import the package does not declare works only by hoisting luck and breaks the ' +
        'day the package is published on its own. Declare it, or do not import it.',
      from: { path: OPEN_PACKAGES },
      // A dependency declared in ANY section passes (a worktree whose node_modules point at another
      // checkout can add a spurious npm-no-pkg next to the real npm-dev / npm-peer).
      to: {
        dependencyTypes: ['npm-no-pkg', 'npm-unknown'],
        dependencyTypesNot: ['npm', 'npm-dev', 'npm-peer', 'npm-optional', 'npm-bundled'],
      },
    },
    {
      name: 'no-unresolvable',
      severity: 'error',
      comment:
        'A guard that cannot resolve an import cannot judge it. Fix the install or the path; ' +
        'never read "unresolved" as "allowed".',
      from: { path: OPEN_PACKAGES },
      to: { couldNotResolve: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(dist|coverage)/' },
    tsPreCompilationDeps: true,
    moduleSystems: ['es6', 'cjs'],
    enhancedResolveOptions: {
      // `exports` so `@masia/contracts/fakes` resolves to its source file; `types` for typings-only entries.
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
    },
  },
};
