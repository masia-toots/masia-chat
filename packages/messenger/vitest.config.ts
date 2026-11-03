import { defineConfig } from 'vitest/config';
// Repo-wide CI failure reporting (see vitest.shared.ts). Monorepo-only: dropped at `git subtree split`.
import { ciReporting } from '../../vitest.shared';

// The MLS suites do real HPKE and tree math (an Add in a group of 50, 32-leaf secret trees). Alone they
// finish in well under a second each; next to the jsdom UI suites on a loaded machine a few crossed the
// 5 s default (30 s too, with two agents running suites side by side). The budget that matters (300 ms for an Add in a group of 50) is asserted inside the tests.
const MLS_TEST_TIMEOUT_MS = 60_000;

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
    testTimeout: MLS_TEST_TIMEOUT_MS,
    ...ciReporting(),
  },
});
