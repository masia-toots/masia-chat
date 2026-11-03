/** The HTTP verbs the messenger uses against the relay; a closed list so no caller invents one. */
export const TRANSPORT_METHODS = ['GET', 'POST', 'PUT', 'DELETE'] as const;
export type TransportMethod = (typeof TRANSPORT_METHODS)[number];

/** What a request without an explicit method means. */
export const DEFAULT_TRANSPORT_METHOD: TransportMethod = 'GET';

/**
 * A request to the relay, minus the base URL and the auth header.
 *
 * Why: the host decides where the relay lives and how requests are authenticated; the messenger
 * only says what it wants to send, so the same code runs against a real relay or a fake.
 */
export interface TransportRequest {
  readonly method?: TransportMethod;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: Uint8Array | string;
}

/**
 * The relay's answer. The body is always bytes: MLS handshakes and ciphertext are binary, and
 * decoding text is the caller's job, not the transport's.
 */
export interface TransportResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

/**
 * Request/response plus topic subscriptions to the relay.
 *
 * Why: the messenger must not know about base URLs, cookies, WebSocket vs SSE, retries or token
 * headers. The host implements those once; the messenger sees two verbs.
 */
export interface Transport {
  /** Sends one request; `path` is relative to the relay root. */
  fetch(path: string, init?: TransportRequest): Promise<TransportResponse>;
  /** Delivers raw bytes published on `topic`; returns the unsubscribe function. */
  subscribe(topic: string, onMessage: (bytes: Uint8Array) => void): () => void;
}
