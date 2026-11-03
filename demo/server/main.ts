import { createPrivateKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createDemoServer } from './app.js';
import { readConfig } from './config.js';
import { createTokenIssuer } from './issuer.js';
import { createPeopleBook } from './people.js';

// The process entrypoint: environment in, server up, clean shutdown. Everything testable is in app.ts.

const config = readConfig();
const privateKey = createPrivateKey(readFileSync(config.privateKeyFile));
const issuer = createTokenIssuer(privateKey, config.expectations);

const server = createDemoServer({
  people: createPeopleBook(),
  issuer,
  relayUrl: config.relayUrl,
  contactsFile: config.contactsFile,
  distDir: config.distDir,
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    server.close(() => process.exit(0));
    // A keep-alive connection must not hold the container open.
    server.closeAllConnections();
  });
}

server.listen(config.port, config.host, () => {
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : config.port;
  console.log(`playground: http://localhost:${port}/  (relay ${config.relayUrl.origin}, token key ${issuer.kid})`);
});
