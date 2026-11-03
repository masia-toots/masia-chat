import { defineConfig } from 'vitest/config';
// Repo-wide CI failure reporting (see vitest.shared.ts). Monorepo-only: dropped at `git subtree split`.
import { ciReporting } from '../../vitest.shared';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    ...ciReporting(),
  },
});
