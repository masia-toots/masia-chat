import { createServer, type RequestListener, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// Shared by the server's tests only: a real HTTP listener on a free loopback port, closed cleanly.

export interface Listening {
  /** `http://127.0.0.1:<port>`, no trailing slash. */
  readonly origin: string;
  close(): Promise<void>;
}

export async function listen(handler: RequestListener): Promise<Listening> {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
        server.closeAllConnections();
      }),
  };
}
