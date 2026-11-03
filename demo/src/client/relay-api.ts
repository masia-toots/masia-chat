import {
  PAGE_MAX,
  RelayErrorCode,
  ROOM_BUSY_RETRY_AFTER_SECONDS,
  type DeviceListEntry,
  type DeviceRole,
} from '@masia/contracts/wire';
import { fromBase64, toBase64 } from './bytes.js';

// The relay's REST surface, as one browser client reads it: bytes in, bytes out, base64 and paging
// stay in this file. Retries are the narrow set a client may always make: a 429/503 waits for
// `Retry-After`, a 401 asks for a fresh token once. Everything else is a typed `RelayHttpError`; a
// network failure is status 0, which for a commit means "it may or may not have landed".

export const NETWORK_ERROR = 'NETWORK';
const MAX_ATTEMPTS = 4;
const BACKOFF_MS = 400;

export class RelayHttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;
  readonly retryAfterSeconds: number | undefined;
  constructor(
    status: number,
    code: string,
    message: string,
    details: Record<string, unknown> = {},
    retryAfterSeconds?: number,
  ) {
    super(`${status} ${code}: ${message}`);
    this.name = 'RelayHttpError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.retryAfterSeconds = retryAfterSeconds;
  }
  /** The epoch the room is at, on the 409 that says the caller built on an old one. */
  get currentEpoch(): number | undefined {
    const value = this.details.currentEpoch;
    return typeof value === 'number' ? value : undefined;
  }
  /** The device-list version the relay holds, on a version conflict. */
  get currentVersion(): number | undefined {
    const value = this.details.currentVersion;
    return typeof value === 'number' ? value : undefined;
  }
  is(code: string): boolean {
    return this.code === code;
  }
}

export interface HandshakeRow {
  readonly seq: number;
  /** The epoch the commit was BUILT on (the relay's `expectedEpoch`); a Welcome carries its commit's. */
  readonly epoch: number;
  readonly kind: 'COMMIT' | 'WELCOME';
  readonly senderDeviceId: string;
  readonly bytes: Uint8Array;
  readonly memberDelta: WireMemberDelta | null;
  readonly createdAt: string;
}

export interface EnvelopeRow {
  readonly seq: number;
  readonly epoch: number;
  readonly senderDeviceId: string;
  readonly ciphertext: Uint8Array;
  readonly createdAt: string;
}

export interface WireMemberDelta {
  readonly added: readonly {
    readonly deviceId: string;
    readonly userId: string;
    readonly role: DeviceRole;
    readonly keyPackageId: string;
  }[];
  readonly removed: readonly string[];
}

export interface RelayPage<R> {
  readonly rows: readonly R[];
  readonly oldestAvailableSeq: number;
  readonly removedAtEpoch: number | null;
}

export interface ServedDeviceList {
  readonly userId: string;
  readonly version: number;
  readonly devices: readonly DeviceListEntry[];
  readonly signature: Uint8Array;
}

export interface ClaimedKeyPackage {
  readonly deviceId: string;
  readonly keyPackageId: string;
  readonly bytes: Uint8Array;
  readonly lastResort: boolean;
}

export interface RelayApiDeps {
  /** The relay's address as the page sees it: the same-origin `/relay` door, or the relay itself in a test. */
  readonly baseUrl: string;
  /** A token for the relay; `force` is set when the relay just answered 401 for the last one. */
  readonly token: (force: boolean) => Promise<string>;
  readonly fetch?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function waitSeconds(error: RelayHttpError, attempt: number): number {
  if (error.retryAfterSeconds !== undefined) return error.retryAfterSeconds;
  return error.code === RelayErrorCode.ROOM_BUSY
    ? ROOM_BUSY_RETRY_AFTER_SECONDS
    : (BACKOFF_MS * 2 ** attempt) / 1000;
}

export interface RelayApi {
  registerDevice(input: {
    id: string;
    name: string;
    platform: string;
    identityKeyPub: Uint8Array;
    signatureKeyPub: Uint8Array;
  }): Promise<void>;
  putDeviceList(input: {
    version: number;
    devices: readonly DeviceListEntry[];
    signature: Uint8Array;
  }): Promise<void>;
  getDeviceList(userId: string): Promise<ServedDeviceList | null>;
  /** The person's pinned identity key (null when none is pinned yet). */
  identityKeyOf(userId: string): Promise<Uint8Array | null>;
  uploadKeyPackages(items: readonly { bytes: Uint8Array; lastResort: boolean }[]): Promise<void>;
  claimKeyPackages(userId: string): Promise<readonly ClaimedKeyPackage[]>;
  openRoom(conversationId: string, input: { groupId: Uint8Array; treeHash: Uint8Array }): Promise<number>;
  postHandshake(
    conversationId: string,
    input: {
      expectedEpoch: number;
      senderDeviceId: string;
      bytes: Uint8Array;
      memberDelta: WireMemberDelta;
      newTreeHash: Uint8Array;
      welcome?: Uint8Array;
    },
  ): Promise<{ epoch: number; seq: number }>;
  listHandshakes(
    conversationId: string,
    query: { fromEpoch: number; afterSeq: number },
  ): Promise<RelayPage<HandshakeRow>>;
  postEnvelope(
    conversationId: string,
    input: { epoch: number; senderDeviceId: string; ciphertext: Uint8Array; clientMsgId: string },
  ): Promise<{ seq: number }>;
  listEnvelopes(conversationId: string, query: { afterSeq: number }): Promise<RelayPage<EnvelopeRow>>;
}

export function createRelayApi(deps: RelayApiDeps): RelayApi {
  const doFetch = deps.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const sleep = deps.sleep ?? defaultSleep;
  const base = deps.baseUrl.replace(/\/+$/, '');

  async function once(method: string, path: string, body: unknown, force: boolean): Promise<unknown> {
    const token = await deps.token(force);
    let response: Response;
    try {
      response = await doFetch(`${base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new RelayHttpError(0, NETWORK_ERROR, 'the relay did not answer');
    }
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text === '' ? undefined : JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (response.status >= 200 && response.status < 300) return parsed;
    const record = asRecord(parsed);
    const { error, message, ...details } = record;
    const retryAfter = Number(response.headers.get('retry-after'));
    throw new RelayHttpError(
      response.status,
      typeof error === 'string' ? error : `HTTP_${response.status}`,
      typeof message === 'string' ? message : response.statusText,
      details,
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
    );
  }

  async function call(method: string, path: string, body?: unknown): Promise<unknown> {
    let force = false;
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await once(method, path, body, force);
      } catch (error) {
        if (!(error instanceof RelayHttpError)) throw error;
        // REBASE_LIMIT is a rule, not load: handed to the caller at once.
        const load =
          (error.status === 429 && error.code !== RelayErrorCode.REBASE_LIMIT) || error.status === 503;
        if (error.status === 401 && !force) {
          force = true;
          continue;
        }
        if (!load || attempt + 1 >= MAX_ATTEMPTS) throw error;
        await sleep(waitSeconds(error, attempt) * 1000);
      }
    }
  }

  function readHandshake(raw: unknown): HandshakeRow {
    const row = asRecord(raw);
    return {
      seq: numberOr(row.seq, 0),
      epoch: numberOr(row.epoch, 0),
      kind: row.kind === 'WELCOME' ? 'WELCOME' : 'COMMIT',
      senderDeviceId: String(row.senderDeviceId ?? ''),
      bytes: fromBase64(String(row.bytes ?? '')),
      memberDelta: (row.memberDelta as WireMemberDelta | null | undefined) ?? null,
      createdAt: String(row.createdAt ?? ''),
    };
  }

  function readEnvelope(raw: unknown): EnvelopeRow {
    const row = asRecord(raw);
    return {
      seq: numberOr(row.seq, 0),
      epoch: numberOr(row.epoch, 0),
      senderDeviceId: String(row.senderDeviceId ?? ''),
      ciphertext: fromBase64(String(row.ciphertext ?? '')),
      createdAt: String(row.createdAt ?? ''),
    };
  }

  /** Reads every page after `afterSeq` (a room's tail is short here; the cap keeps a bug from looping). */
  async function readAll<R extends { seq: number }>(
    path: (afterSeq: number) => string,
    afterSeq: number,
    readRow: (raw: unknown) => R,
  ): Promise<RelayPage<R>> {
    const rows: R[] = [];
    let cursor = afterSeq;
    let oldest = 1;
    let removedAtEpoch: number | null = null;
    for (let page = 0; page < 200; page += 1) {
      const body = asRecord(await call('GET', path(cursor)));
      const batch = Array.isArray(body.rows) ? body.rows.map(readRow) : [];
      rows.push(...batch);
      oldest = numberOr(body.oldestAvailableSeq, oldest);
      removedAtEpoch = typeof body.removedAtEpoch === 'number' ? body.removedAtEpoch : removedAtEpoch;
      const last = batch[batch.length - 1];
      if (last === undefined || typeof body.nextCursor !== 'string') break;
      cursor = last.seq;
    }
    return { rows, oldestAvailableSeq: oldest, removedAtEpoch };
  }

  const room = (conversationId: string): string => `/conversations/${encodeURIComponent(conversationId)}`;

  return {
    async registerDevice(input) {
      await call('POST', '/devices', {
        id: input.id,
        name: input.name,
        platform: input.platform,
        identityKeyPub: toBase64(input.identityKeyPub),
        signatureKeyPub: toBase64(input.signatureKeyPub),
      });
    },

    async putDeviceList(input) {
      await call('POST', '/users/me/device-list', {
        version: input.version,
        devices: input.devices,
        signature: toBase64(input.signature),
      });
    },

    async getDeviceList(userId) {
      try {
        const body = asRecord(await call('GET', `/users/${encodeURIComponent(userId)}/device-list`));
        return {
          userId: String(body.userId ?? userId),
          version: numberOr(body.version, 0),
          devices: Array.isArray(body.devices) ? (body.devices as DeviceListEntry[]) : [],
          signature: fromBase64(String(body.signature ?? '')),
        };
      } catch (error) {
        if (error instanceof RelayHttpError && error.code === RelayErrorCode.DEVICE_LIST_NOT_FOUND) {
          return null;
        }
        throw error;
      }
    },

    async identityKeyOf(userId) {
      const body = asRecord(await call('GET', `/users/${encodeURIComponent(userId)}/devices`));
      return typeof body.identityKeyPub === 'string' ? fromBase64(body.identityKeyPub) : null;
    },

    async uploadKeyPackages(items) {
      await call(
        'POST',
        '/key-packages',
        items.map((item) => ({ bytes: toBase64(item.bytes), lastResort: item.lastResort })),
      );
    },

    async claimKeyPackages(userId) {
      const body = asRecord(await call('POST', '/key-packages/claim', { userId }));
      const rows = Array.isArray(body.rows) ? body.rows : [];
      return rows.map((raw): ClaimedKeyPackage => {
        const row = asRecord(raw);
        return {
          deviceId: String(row.deviceId ?? ''),
          keyPackageId: String(row.keyPackageId ?? ''),
          bytes: fromBase64(String(row.bytes ?? '')),
          lastResort: row.lastResort === true,
        };
      });
    },

    async openRoom(conversationId, input) {
      const body = asRecord(
        await call('POST', `${room(conversationId)}/e2ee`, {
          groupId: toBase64(input.groupId),
          treeHash: toBase64(input.treeHash),
        }),
      );
      return numberOr(body.epoch, 0);
    },

    async postHandshake(conversationId, input) {
      const body = asRecord(
        await call('POST', `${room(conversationId)}/handshakes`, {
          expectedEpoch: input.expectedEpoch,
          senderDeviceId: input.senderDeviceId,
          bytes: toBase64(input.bytes),
          memberDelta: input.memberDelta,
          newTreeHash: toBase64(input.newTreeHash),
          ...(input.welcome === undefined ? {} : { welcome: toBase64(input.welcome) }),
        }),
      );
      return { epoch: numberOr(body.epoch, input.expectedEpoch + 1), seq: numberOr(body.seq, 0) };
    },

    listHandshakes(conversationId, query) {
      return readAll(
        (afterSeq) =>
          `${room(conversationId)}/handshakes?fromEpoch=${query.fromEpoch}&afterSeq=${afterSeq}&limit=${PAGE_MAX}`,
        query.afterSeq,
        readHandshake,
      );
    },

    async postEnvelope(conversationId, input) {
      const body = asRecord(
        await call('POST', `${room(conversationId)}/envelopes`, {
          epoch: input.epoch,
          ciphertext: toBase64(input.ciphertext),
          senderDeviceId: input.senderDeviceId,
          clientMsgId: input.clientMsgId,
        }),
      );
      return { seq: numberOr(body.seq, 0) };
    },

    listEnvelopes(conversationId, query) {
      return readAll(
        (afterSeq) => `${room(conversationId)}/envelopes?afterSeq=${afterSeq}&limit=${PAGE_MAX}`,
        query.afterSeq,
        readEnvelope,
      );
    },
  };
}
