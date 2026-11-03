import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactPlugin from 'eslint-plugin-react';
import reactHooksPlugin from 'eslint-plugin-react-hooks';
import prettierConfig from 'eslint-config-prettier';

// The messenger's boundary law, in the open repository's own words: the client and the relay import
// `@masia/contracts`, their own package and their own npm dependencies, nothing else in the workspace;
// `messenger` and `relay` never import each other (they meet through the wire protocol). The playground
// is a client of the packages: it imports `@masia/messenger` and `@masia/contracts`, never the relay and
// never an import of theirs. ONE list; the guard blocks below derive their `files` and their allowlists
// from it. An allowlist: a workspace package added tomorrow is refused
// until it is named here.
const HOMES = [
  { dir: 'packages/contracts', mayImport: ['@masia/contracts'] },
  { dir: 'packages/messenger', mayImport: ['@masia/contracts', '@masia/messenger'] },
  { dir: 'packages/relay', mayImport: ['@masia/contracts', '@masia/relay'] },
  { dir: 'apps/relay', mayImport: ['@masia/contracts', '@masia/relay', '@masia/relay-server'] },
  { dir: 'demo', mayImport: ['@masia/contracts', '@masia/messenger'] },
];
const BOUNDARY_MESSAGE =
  'Open messenger boundary: only @masia/contracts and own deps. Add a port, never an import.';

/** Every workspace scope is refused, then the home's own allowlist is re-included (gitignore syntax). */
function boundaryPatterns(mayImport) {
  return [
    {
      group: [
        '@masia/*',
        ...mayImport.flatMap((name) => [`!${name}`, `!${name}/*`]),
        '@prisma/client',
        '**/apps/**',
        '**/packages/**',
        '**/demo/**',
      ],
      message: BOUNDARY_MESSAGE,
    },
  ];
}

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', '**/*.d.ts'] },

  eslint.configs.recommended,
  ...tseslint.configs.recommended,

  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
    },
  },

  // React: the messenger's UI core and the playground.
  {
    files: ['packages/**/*.{ts,tsx}', 'demo/**/*.{ts,tsx}'],
    plugins: { react: reactPlugin, 'react-hooks': reactHooksPlugin },
    settings: { react: { version: 'detect' } },
    rules: {
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },

  ...HOMES.map(({ dir, mayImport }) => ({
    files: [`${dir}/**/*.{ts,tsx,js,mjs,cjs}`],
    rules: {
      'no-restricted-imports': ['error', { patterns: boundaryPatterns(mayImport) }],
    },
  })),

  // Prettier last: it disables every formatting rule that would conflict.
  prettierConfig,
);
