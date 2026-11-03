import {
  isWildcardHost,
  resolveDatabaseUrl,
  resolveOperatorUserId,
  resolveRelayAllowedOrigins,
  resolveRelayBasePath,
  resolveRelayHost,
  resolveRelayPort,
  resolveTokenExpectations,
  resolveTokenKeyring,
} from './config.js';
import { createDatabase } from './db.js';
import { startRetentionJob } from './retention.js';
import { buildServer } from './server.js';

// The process entrypoint. Everything testable lives in server.ts; this wires the environment in,
// listens, and shuts down cleanly.
const database = createDatabase(resolveDatabaseUrl(), {
  // Without a listener, `pg` would turn a dropped idle connection into a process crash.
  onIdleError: (error) => app.log.error({ err: error }, 'idle database connection failed'),
});
const tokenKeys = resolveTokenKeyring();
// Resolved up front with the rest of the configuration, so a bad value stops the process before it
// opens anything.
const host = resolveRelayHost();
const port = resolveRelayPort();
const basePath = resolveRelayBasePath();
const allowedOrigins = resolveRelayAllowedOrigins();
const app = await buildServer({
  logger: true,
  database,
  tokenKeys,
  tokenExpectations: resolveTokenExpectations(),
  operatorUserId: resolveOperatorUserId(),
  basePath,
  allowedOrigins,
});
// Key ids only (a hash of each PUBLIC key): enough to see which keys a rotation has the relay trusting.
app.log.info({ tokenKeyIds: tokenKeys.kids }, 'access-token public keys loaded');

const retention = startRetentionJob(database, {
  onSwept: (result) => app.log.info(result, 'retention sweep done'),
  onError: (error) => app.log.error({ err: error }, 'retention sweep failed'),
});

const SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM'] as const;
for (const signal of SHUTDOWN_SIGNALS) {
  process.once(signal, () => {
    retention.stop();
    // Stop taking requests first, then let the pool drain: the other order drops in-flight work.
    app
      .close()
      .then(() => database.close())
      .catch((error: unknown) => {
        app.log.error({ err: error }, 'shutdown failed');
        process.exitCode = 1;
      });
  });
}

try {
  await app.listen({ host, port });
  if (isWildcardHost(host)) {
    app.log.warn({ host }, 'listening on every interface; put a firewall or a proxy in front');
  }
  app.log.info({ host, port, basePath: basePath === '' ? '/' : basePath, allowedOrigins }, 'relay listening');
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
