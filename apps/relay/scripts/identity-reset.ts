import { DATABASE_URL_ENV } from '../src/config.js';
import { createDatabase } from '../src/db.js';
import {
  describeDatabaseUrl,
  IdentityResetExit,
  runIdentityResetCli,
} from '../src/operator/identity-reset.js';

/**
 * The relay operator's identity-key reset (ADR-218 §6), run on the relay's own machine:
 *
 *   tsx scripts/identity-reset.ts <userId> [--first-device <id>] [--revoke <id,…> --reason <text>]
 *   tsx scripts/identity-reset.ts <userId> --apply --confirm <userId> --first-device <id> […]
 *
 * A dry run unless `--apply` (src/operator/identity-reset.ts says what each flag does). The database
 * is `RELAY_DATABASE_URL` and nothing else: no development fallback, so the CLI never touches a
 * database nobody named. The output names the database without its credentials.
 * Runbook: docs/infrastructure/deployment.md § Relay → Identity-key reset.
 */
const url = process.env[DATABASE_URL_ENV];
if (url === undefined || url === '') {
  process.stderr.write(
    `identity-reset: ${DATABASE_URL_ENV} must be set (there is no default here).\n`,
  );
  process.exit(IdentityResetExit.USAGE);
}

process.exitCode = await runIdentityResetCli(process.argv.slice(2), {
  openDatabase: () =>
    createDatabase(url, {
      onIdleError: (error) =>
        process.stderr.write(`identity-reset: idle connection: ${error.message}\n`),
      maxConnections: 1,
    }),
  out: (line) => process.stdout.write(`${line}\n`),
  target: describeDatabaseUrl(url),
});
