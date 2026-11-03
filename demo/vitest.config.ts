import { defineConfig } from 'vitest/config';

// MLS suites do real HPKE and tree maths; give them the same room the messenger's own suites have.
const MLS_TEST_TIMEOUT_MS = 60_000;

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}', 'server/**/*.test.ts'],
    testTimeout: MLS_TEST_TIMEOUT_MS,
  },
});
