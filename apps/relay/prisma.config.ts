import path from 'node:path';
import { defineConfig } from 'prisma/config';
import { DATABASE_URL_ENV, resolveDatabaseUrl } from './src/config.ts';

// The Prisma CLI (migrate, validate) reads RELAY_DATABASE_URL from the process environment. This
// config gives it the SAME resolution the server uses (config.ts), so the documented development
// default exists in one place and `NODE_ENV=production` refuses to guess a database.
process.env[DATABASE_URL_ENV] = resolveDatabaseUrl(process.env);

export default defineConfig({
  schema: path.join(import.meta.dirname, 'prisma', 'schema.prisma'),
});
