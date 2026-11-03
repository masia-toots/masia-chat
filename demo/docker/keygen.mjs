/* global process, console -- Node globals; the repo's flat ESLint config declares none for .mjs */
// Makes the playground's token key pair, once, into a volume the other services read.
//
// DEMO ONLY. The web service signs relay tokens with the private key for anyone who types a name, and the
// relay trusts the public key. Nothing in this repository is a key: this script makes a fresh pair the
// first time the stack starts, and `docker compose down -v` throws it away. A key that already exists is
// kept, so restarting the stack does not invalidate the tokens the open tabs hold.
//
// Usage: node keygen.mjs <directory>

import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, chownSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The unprivileged user the other services run as (the `node` user of the base image). */
const SERVICE_UID = 1000;
const SERVICE_GID = 1000;

const directory = process.argv[2];
if (!directory) {
  console.error('usage: node keygen.mjs <directory>');
  process.exit(2);
}

const privateFile = join(directory, 'token-private.pem');
const publicFile = join(directory, 'token-public.b64');

if (existsSync(privateFile) && existsSync(publicFile)) {
  console.log('keygen: the token key pair is already there; keeping it');
  process.exit(0);
}

mkdirSync(directory, { recursive: true });
const { publicKey, privateKey } = generateKeyPairSync('ed25519');

// The relay reads the public key as one line of base64 SPKI DER (its RELAY_TOKEN_PUBLIC_KEY format).
writeFileSync(publicFile, `${publicKey.export({ type: 'spki', format: 'der' }).toString('base64')}\n`);
writeFileSync(privateFile, privateKey.export({ type: 'pkcs8', format: 'pem' }));

chmodSync(publicFile, 0o444);
chmodSync(privateFile, 0o400);
// Running as root, hand the private key to the one user that needs it.
if (typeof process.getuid === 'function' && process.getuid() === 0) {
  chownSync(privateFile, SERVICE_UID, SERVICE_GID);
}
console.log('keygen: made a fresh Ed25519 token key pair (demo only)');
