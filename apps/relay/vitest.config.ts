import { defineConfig } from 'vitest/config';
// Repo-wide CI failure reporting (see vitest.shared.ts). Monorepo-only: dropped at `git subtree split`.
import { ciReporting } from '../../vitest.shared';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Creates/migrates the throwaway test database once and tells the suites whether it is there.
    globalSetup: ['src/__tests__/support/global-setup.ts'],
    // The database suites share ONE test database and empty it between tests, so two test files
    // running side by side would wipe each other's rows.
    fileParallelism: false,
    ...ciReporting(),
  },
});
