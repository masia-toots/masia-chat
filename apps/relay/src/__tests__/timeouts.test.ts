import { RelayErrorCode, ROOM_BUSY_RETRY_AFTER_SECONDS } from '@masia/relay';
import { describe, expect, it } from 'vitest';
import { DEFAULT_DATABASE_TIMEOUTS } from '../db.js';
import { buildServer, CONNECTION_TIMEOUT_MS, REQUEST_TIMEOUT_MS } from '../server.js';
import {
  databaseSuite,
  expectStatus,
  sealed,
  TEST_TOKEN_KEYS,
  unusedDatabase,
  TEST_TOKEN_EXPECTATIONS,
} from './support/harness.js';

const ROOM = 'room-1';
/** Short, so the suite does not wait out the production lock timeout. */
const TEST_LOCK_TIMEOUT_MS = 200;

describe('the relay never waits for ever (review round 1, 2026-10-10)', () => {
  it('bounds a request and an idle connection in Fastify', async () => {
    const database = unusedDatabase();
    const app = await buildServer({
      database,
      tokenKeys: TEST_TOKEN_KEYS,
      tokenExpectations: TEST_TOKEN_EXPECTATIONS,
    });
    try {
      // Read from the Node server Fastify built: that is where the limits actually act.
      expect(app.server.requestTimeout).toBe(REQUEST_TIMEOUT_MS);
      expect(app.server.timeout).toBe(CONNECTION_TIMEOUT_MS);
    } finally {
      await app.close();
      await database.close();
    }
  });

  it('keeps every database wait shorter than a request, so a stuck query is answered before the socket gives up', () => {
    const { connectionTimeoutMs, statementTimeoutMs, lockTimeoutMs, idleInTransactionTimeoutMs } =
      DEFAULT_DATABASE_TIMEOUTS;
    expect(lockTimeoutMs).toBeLessThan(statementTimeoutMs);
    expect(connectionTimeoutMs + statementTimeoutMs).toBeLessThan(REQUEST_TIMEOUT_MS);
    expect(idleInTransactionTimeoutMs).toBeGreaterThan(statementTimeoutMs);
  });
});

databaseSuite(
  'a room whose lock is held too long (ROOM_BUSY)',
  (harness) => {
    it('answers 503 ROOM_BUSY with Retry-After when the conversation lock is not free in time, and the resend goes through', async () => {
      const alice = await harness().enrol('alice', 'alice-phone');
      await harness().createRoom(ROOM, alice);
      const body = {
        epoch: 0,
        senderDeviceId: alice.deviceId,
        ciphertext: sealed(ROOM, 0, 'hello'),
        clientMsgId: 'msg-1',
      };

      await harness().db.transaction(async (tx) => {
        // Another writer holds the room, as a commit in flight would.
        await tx.query('SELECT 1 FROM conversation_e2ee WHERE conversation_id = $1 FOR UPDATE', [
          ROOM,
        ]);
        const busy = await alice.post(`/conversations/${ROOM}/envelopes`, body);
        expectStatus(busy, 503);
        expect(busy.json()).toMatchObject({ error: RelayErrorCode.ROOM_BUSY });
        expect(busy.headers['retry-after']).toBe(String(ROOM_BUSY_RETRY_AFTER_SECONDS));
      });

      // Nothing was written by the refused request, so sending it again as it is just works.
      expectStatus(await alice.post(`/conversations/${ROOM}/envelopes`, body), 201);
    });
  },
  { timeouts: { lockTimeoutMs: TEST_LOCK_TIMEOUT_MS } },
);
