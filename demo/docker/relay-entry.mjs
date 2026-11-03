/* global process, console -- Node globals; the repo's flat ESLint config declares none for .mjs */
// The relay container's entrypoint: migrate the database, start the relay, and make it reachable.
//
//  1. `prisma migrate deploy` applies the relay's own migrations to its own database (the relay's
//     documented way); a failure stops the container, so a half-migrated relay never answers.
//  2. The token public key is read from the file the key generator wrote and handed to the relay in the
//     variable the relay reads (RELAY_TOKEN_PUBLIC_KEY). No key lives in the compose file.
//  3. The relay listens on the loopback address only (it has no setting for another one), so it is
//     started on an inner port and a small TCP forwarder exposes it to the other containers. The
//     forwarder adds nothing and reads nothing: bytes in, bytes out.

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';

const PUBLIC_PORT = 3400;
const INNER_PORT = 3401;
const RELAY_DIR = '/app/apps/relay';
const PUBLIC_KEY_FILE = process.env.DEMO_TOKEN_PUBLIC_KEY_FILE ?? '/keys/token-public.b64';

const env = {
  ...process.env,
  RELAY_PORT: String(INNER_PORT),
  RELAY_TOKEN_PUBLIC_KEY: readFileSync(PUBLIC_KEY_FILE, 'utf8').trim(),
};

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: RELAY_DIR, env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
}

console.log('relay-entry: applying the relay migrations');
const migrated = await run(`${RELAY_DIR}/node_modules/.bin/prisma`, ['migrate', 'deploy']);
if (migrated !== 0) {
  console.error(`relay-entry: migrate deploy failed (exit ${migrated})`);
  process.exit(migrated);
}

console.log('relay-entry: starting the relay');
const relay = spawn(`${RELAY_DIR}/node_modules/.bin/tsx`, ['src/main.ts'], {
  cwd: RELAY_DIR,
  env,
  stdio: 'inherit',
});

const forwarder = createServer((client) => {
  const upstream = connect(INNER_PORT, '127.0.0.1');
  client.pipe(upstream);
  upstream.pipe(client);
  const drop = () => {
    client.destroy();
    upstream.destroy();
  };
  client.on('error', drop);
  upstream.on('error', drop);
  client.on('close', drop);
  upstream.on('close', drop);
});
forwarder.listen(PUBLIC_PORT, '0.0.0.0', () => {
  console.log(`relay-entry: forwarding 0.0.0.0:${PUBLIC_PORT} to the relay on 127.0.0.1:${INNER_PORT}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    forwarder.close();
    relay.kill(signal);
  });
}
relay.once('exit', (code, signal) => {
  forwarder.close();
  process.exit(code ?? (signal ? 0 : 1));
});
