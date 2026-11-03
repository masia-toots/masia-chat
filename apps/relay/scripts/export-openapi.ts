import { generateKeyPairSync } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createDatabase } from '../src/db.js';
import { buildServer } from '../src/server.js';
import { tokenKeyringOf } from '../src/token-keys.js';

/**
 * Writes `apps/relay/openapi.json` from the routes' own schemas, so the document cannot disagree
 * with the code that validates requests. `pnpm openapi` after changing a route; a test fails if
 * the committed file is stale.
 *
 * The document needs no database: the pool connects lazily and nothing here queries it.
 */
const OUTPUT_PATH = fileURLToPath(new URL('../openapi.json', import.meta.url));
const UNUSED_DATABASE_URL = 'postgresql://nobody@127.0.0.1:1/unused';
/** A throwaway key, only so the app builds: no token is ever verified here. */
const tokenKeys = tokenKeyringOf([generateKeyPairSync('ed25519').publicKey]);

const database = createDatabase(UNUSED_DATABASE_URL, { onIdleError: () => undefined });
// Placeholder iss/aud: the document names the variables, never their values, and no token is verified.
const app = await buildServer({
  database,
  tokenKeys,
  tokenExpectations: { issuer: 'openapi-export', audience: 'openapi-export-relay' },
});
try {
  await app.ready();
  const next = `${JSON.stringify(app.swagger(), null, 2)}\n`;
  const previous = await readFile(OUTPUT_PATH, 'utf8').catch(() => null);
  // Write only on change, so an unchanged API leaves the file (and git) alone.
  if (previous === next) {
    process.stdout.write('openapi.json is up to date\n');
  } else {
    await writeFile(OUTPUT_PATH, next, 'utf8');
    process.stdout.write('openapi.json written\n');
  }
} finally {
  await app.close();
  await database.close();
}
