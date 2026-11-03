/**
 * Shared vitest bits: ONE definition of how this repository reports test results on CI. Every
 * package's vitest config spreads `ciReporting()` into its `test` block; a new package with tests
 * gets the behaviour by doing the same.
 *
 * Two traps, both paid for once: `outputFile` must be addressed to a reporter (`{ json: … }`), a
 * bare one with two reporters writes NOTHING; and none of this can be passed on the command line,
 * `pnpm -r run test -- <args>` drops every argument.
 */

/**
 * JSON reporting, on CI only. Local runs keep their plain, fast default output. The report lands at
 * `<package>/vitest-report.json` (gitignored).
 */
export function ciReporting(): {
  reporters?: ['default', 'json'];
  outputFile?: { json: string };
} {
  if (!process.env['CI']) return {};
  return { reporters: ['default', 'json'], outputFile: { json: 'vitest-report.json' } };
}
