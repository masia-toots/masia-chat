import type { Transport, TransportRequest, TransportResponse } from '../ports/transport.js';
import { createFakeEmitter } from './fake-emitter.js';

/** The one route every fake relay answers, so a contract suite always has a path to probe. */
export const FAKE_TRANSPORT_HEALTH_PATH = '/health';

const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;

/** One request the fake saw, kept so a test can assert what the messenger sent. */
export interface FakeTransportCall {
  readonly path: string;
  readonly init: TransportRequest | undefined;
}

/** A fake relay connection: scripted responses in, published topic bytes out, calls recorded. */
export interface FakeTransport extends Transport {
  /** Delivers `bytes` to every subscriber of `topic`, as the relay would. */
  publish(topic: string, bytes: Uint8Array): void;
  readonly calls: readonly FakeTransportCall[];
}

export interface FakeTransportOptions {
  /** Scripted answers by exact path, added to the built-in health route. */
  readonly routes?: Readonly<Record<string, TransportResponse>>;
}

interface TopicMessage {
  readonly topic: string;
  readonly bytes: Uint8Array;
}

/** In-memory `Transport`: unknown paths answer 404 with an empty body. */
export function createFakeTransport(options: FakeTransportOptions = {}): FakeTransport {
  const routes: Readonly<Record<string, TransportResponse>> = {
    [FAKE_TRANSPORT_HEALTH_PATH]: { status: HTTP_OK, headers: {}, body: new Uint8Array() },
    ...options.routes,
  };
  const calls: FakeTransportCall[] = [];
  const messages = createFakeEmitter<TopicMessage>();

  return {
    calls,
    async fetch(path, init) {
      calls.push({ path, init });
      return routes[path] ?? { status: HTTP_NOT_FOUND, headers: {}, body: new Uint8Array() };
    },
    subscribe(topic, onMessage) {
      return messages.add((message) => {
        if (message.topic === topic) onMessage(message.bytes);
      });
    },
    publish(topic, bytes) {
      messages.emit({ topic, bytes });
    },
  };
}
