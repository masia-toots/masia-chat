/**
 * How the `msg:*` protocol rides the `Transport` port: topics, the command path, and the byte codec.
 *
 * Why this exists: `Transport` offers only request/response and byte topics (it is shaped for the
 * relay). The current host protocol is a JSON socket, so the hooks reach it through this small
 * convention, and the host adapter (in Masia: `TransportOverWsConnection`) maps it onto the socket:
 *  - server events arrive as JSON bytes on `MESSENGER_EVENT_TOPIC`;
 *  - connection state arrives as JSON bytes on `MESSENGER_CONNECTION_TOPIC` (the current state first,
 *    then every change), because the port has no connection primitive of its own;
 *  - commands are POSTed to `MESSENGER_COMMAND_PATH`, the adapter forwards the body to the socket.
 * The relay protocol (K2) replaces this convention; only this file and the adapter change then.
 */
import type { TransportRequest } from '@masia/contracts';
import type { MsgClientEvent, MsgServerEvent } from './events.js';

/** Topic prefix of every server event; the event's own `type` starts with it. */
export const MESSENGER_EVENT_TOPIC = 'msg:';

/** Topic carrying `{"connected": boolean}` — the live link, current value first. */
export const MESSENGER_CONNECTION_TOPIC = 'messenger:connection';

/** Where a client command is POSTed (the body is a JSON `MsgClientEvent`). */
export const MESSENGER_COMMAND_PATH = '/messenger/command';

/** Page size of the history endpoint; the hooks page older messages in steps of this. */
export const HISTORY_PAGE_SIZE = 30;

/** Every server event type this client understands; anything else on the topic is dropped. */
const SERVER_EVENT_TYPES: ReadonlySet<string> = new Set<MsgServerEvent['type']>([
  'msg:new',
  'msg:sent',
  'msg:read',
  'msg:typing',
  'msg:deleted',
  'msg:edited',
  'msg:reacted',
  'msg:error',
]);

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(textDecoder.decode(bytes));
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Decodes one topic message into a known server event, or `null` when it is not one (malformed
 * bytes, a foreign shape, a type from a newer server). A push must never throw into the transport.
 *
 * The payload is trusted past the `type` check: the server is the host's own, and a field-by-field
 * validator here would be a second copy of the type definitions.
 */
export function parseMsgServerEvent(bytes: Uint8Array): MsgServerEvent | null {
  const value = parseJson(bytes);
  if (!isRecord(value) || typeof value.type !== 'string' || !SERVER_EVENT_TYPES.has(value.type)) {
    return null;
  }
  if (!isRecord(value.payload)) return null;
  return value as unknown as MsgServerEvent;
}

/** The request that carries `event` to the server. */
export function commandRequest(event: MsgClientEvent): TransportRequest {
  return { method: 'POST', body: JSON.stringify(event) };
}

/** Bytes of a server event, for an adapter (or a test) publishing it on `MESSENGER_EVENT_TOPIC`. */
export function encodeMsgServerEvent(event: MsgServerEvent): Uint8Array {
  return textEncoder.encode(JSON.stringify(event));
}

/** Decodes a connection-topic message; `null` when it does not say. */
export function parseConnectionState(bytes: Uint8Array): boolean | null {
  const value = parseJson(bytes);
  return isRecord(value) && typeof value.connected === 'boolean' ? value.connected : null;
}

/** Bytes of a connection-state message, for an adapter (or a test) publishing it. */
export function encodeConnectionState(connected: boolean): Uint8Array {
  return textEncoder.encode(JSON.stringify({ connected }));
}

/** Decodes a JSON response body; `undefined` when it is not JSON. */
export function parseJsonBody(bytes: Uint8Array): unknown {
  return parseJson(bytes);
}

/** The history request path for one page: `base` is the host's endpoint, `cursor` the page before. */
export function historyPagePath(base: string, cursor: string | null): string {
  const query = `limit=${HISTORY_PAGE_SIZE}`;
  return cursor === null
    ? `${base}?${query}`
    : `${base}?${query}&cursor=${encodeURIComponent(cursor)}`;
}
