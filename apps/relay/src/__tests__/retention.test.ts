import { RELAY_BACKLOG_RETENTION_SECONDS } from '@masia/relay';
import { describe, expect, it, vi } from 'vitest';
import { purgeExpired, startRetentionJob } from '../retention.js';
import {
  type Caller,
  countRows,
  databaseSuite,
  expectStatus,
  keyPackageItem,
  sealed,
} from './support/harness.js';

const ROOM = 'room-1';
const MS_PER_SECOND = 1000;
const RETENTION_MS = RELAY_BACKLOG_RETENTION_SECONDS * MS_PER_SECOND;
/** A little more than the retention: what a row is aged by to fall out of it. */
const PAST_RETENTION_MS = RETENTION_MS + 60 * MS_PER_SECOND;

interface EnvelopePage {
  rows: Array<{ seq: number }>;
  nextCursor: string | null;
  oldestAvailableSeq: number;
  removedAtEpoch: number | null;
}

databaseSuite('the retention job (ADR-117 §2; review round 1, 2026-10-10)', (harness) => {
  async function roomWithAliceAndBob(): Promise<{ alice: Caller; bob: Caller }> {
    const alice = await harness().enrol('alice', 'alice-phone');
    const bob = await harness().enrol('bob', 'bob-phone');
    await harness().createRoom(ROOM, alice);
    expectStatus(await harness().addToRoom(ROOM, alice, bob), 201); // epoch 1
    return { alice, bob };
  }

  async function send(from: Caller, text: string): Promise<number> {
    const reply = await from.post(`/conversations/${ROOM}/envelopes`, {
      epoch: 1,
      senderDeviceId: from.deviceId,
      ciphertext: sealed(ROOM, 1, text),
    });
    expectStatus(reply, 201);
    return reply.json<{ seq: number }>().seq;
  }

  /** Ages the envelopes up to `seq` past the retention, as time would. */
  async function age(table: 'envelopes' | 'mls_handshakes', throughSeq: number): Promise<void> {
    await harness().db.query(
      `UPDATE ${table} SET created_at = now() - make_interval(secs => $1) WHERE seq <= $2`,
      [PAST_RETENTION_MS / MS_PER_SECOND, throughSeq],
    );
  }

  it('deletes handshakes and envelopes older than RELAY_BACKLOG_RETENTION_SECONDS, batch by batch, and keeps the rest', async () => {
    const { alice } = await roomWithAliceAndBob();
    for (let index = 0; index < 5; index += 1) await send(alice, `message-${index}`);
    await age('envelopes', 4);
    await age('mls_handshakes', 1);

    const result = await purgeExpired(harness().db, { now: Date.now(), batch: 2 });
    expect(result).toMatchObject({ handshakes: 1, envelopes: 4 });
    expect(await countRows('SELECT count(*) AS n FROM envelopes', harness().db)).toBe(1);
    expect(await countRows('SELECT count(*) AS n FROM mls_handshakes', harness().db)).toBe(0);

    // A second sweep finds nothing: the job is safe to run as often as it likes.
    expect(await purgeExpired(harness().db, { now: Date.now(), batch: 2 })).toEqual({
      handshakes: 0,
      envelopes: 0,
      keyPackages: 0,
    });
  });

  it('never hands a deleted seq out again: the next message continues the sequence', async () => {
    const { alice, bob } = await roomWithAliceAndBob();
    expect([await send(alice, 'a'), await send(alice, 'b'), await send(alice, 'c')]).toEqual([
      1, 2, 3,
    ]);
    await age('envelopes', 3);
    await purgeExpired(harness().db, { now: Date.now() });

    // Before the counters, MAX(seq) + 1 of an empty table was 1 again, and bob's cursor (3) would
    // have skipped the next three messages.
    expect(await send(alice, 'd')).toBe(4);
    const page = (
      await bob.get(`/conversations/${ROOM}/envelopes?afterSeq=3`)
    ).json<EnvelopePage>();
    expect(page.rows.map((row) => row.seq)).toEqual([4]);
  });

  it('tells a reader where the backlog now starts (oldestAvailableSeq), so a device that was away too long knows it missed rows', async () => {
    const { alice, bob } = await roomWithAliceAndBob();
    for (const text of ['a', 'b', 'c', 'd']) await send(alice, text);
    const before = (await bob.get(`/conversations/${ROOM}/envelopes`)).json<EnvelopePage>();
    expect(before.oldestAvailableSeq).toBe(1);

    await age('envelopes', 2);
    await purgeExpired(harness().db, { now: Date.now() });

    const after = await bob.get(`/conversations/${ROOM}/envelopes?afterSeq=0`);
    expectStatus(after, 200);
    const page = after.json<EnvelopePage>();
    expect(page.oldestAvailableSeq).toBe(3); // the cursor 0 is below 3 - 1: rows 1 and 2 are gone
    expect(page.rows.map((row) => row.seq)).toEqual([3, 4]);
    expect(page.removedAtEpoch).toBeNull();

    // With every row gone, the backlog starts at the NEXT seq the room will hand out.
    await age('envelopes', 4);
    await purgeExpired(harness().db, { now: Date.now() });
    expect((await bob.get(`/conversations/${ROOM}/envelopes`)).json<EnvelopePage>()).toMatchObject({
      rows: [],
      oldestAvailableSeq: 5,
    });
  });

  it('serves oldestAvailableSeq on the handshake log too', async () => {
    const { bob } = await roomWithAliceAndBob();
    const reply = await bob.get(`/conversations/${ROOM}/handshakes`);
    expectStatus(reply, 200);
    expect(reply.json()).toMatchObject({ oldestAvailableSeq: 1, removedAtEpoch: null });
  });

  it('purges key packages that expired, and consumed ones once their claim record is past retention', async () => {
    const bob = await harness().enrol('bob', 'bob-phone');
    expectStatus(
      await bob.post('/key-packages', [
        keyPackageItem(harness().clock, false, 'expiring'),
        keyPackageItem(harness().clock, false, 'consumed-long-ago'),
        keyPackageItem(harness().clock, false, 'fresh'),
        keyPackageItem(harness().clock, true, 'last-resort'),
      ]),
      201,
    );
    const ids = (
      await harness().db.query<{ id: string }>(
        `SELECT id FROM key_packages WHERE device_id = 'bob-phone' AND NOT last_resort ORDER BY id`,
      )
    ).rows.map((row) => row.id);
    const [expiring, consumed] = ids; // any two of the three ordinary packages
    await harness().db.query(
      `UPDATE key_packages SET not_after = now() - interval '1 second' WHERE id = $1`,
      [expiring],
    );
    await harness().db.query(
      `UPDATE key_packages SET consumed_at = now() - make_interval(secs => $2) WHERE id = $1`,
      [consumed, PAST_RETENTION_MS / MS_PER_SECOND],
    );

    const result = await purgeExpired(harness().db, { now: Date.now() });
    expect(result.keyPackages).toBe(2);
    const left = (
      await harness().db.query<{ id: string }>(
        `SELECT id FROM key_packages WHERE device_id = 'bob-phone'`,
      )
    ).rows;
    expect(left.map((row) => row.id)).not.toContain(expiring);
    expect(left.map((row) => row.id)).not.toContain(consumed);
    expect(left).toHaveLength(2); // the third ordinary package and the last-resort one stay
  });

  describe('the periodic job', () => {
    it('sweeps at once and then on every interval, and stops when told', async () => {
      vi.useFakeTimers();
      try {
        const swept = vi.fn();
        const job = startRetentionJob(harness().db, {
          onSwept: swept,
          onError: (error) => {
            throw error;
          },
          intervalMs: 1000,
        });
        await vi.waitFor(() => expect(swept).toHaveBeenCalledTimes(1));
        await vi.advanceTimersByTimeAsync(1000);
        await vi.waitFor(() => expect(swept).toHaveBeenCalledTimes(2));
        job.stop();
        await vi.advanceTimersByTimeAsync(5000);
        expect(swept).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('purges even when nobody listens for the result', async () => {
      const queries: string[] = [];
      const recording = {
        query: (sql: string) => {
          queries.push(sql);
          return Promise.resolve({ rowCount: 0, rows: [] });
        },
      };
      const job = startRetentionJob(recording as never, {
        onError: (error) => {
          throw error;
        },
      });
      await vi.waitFor(() => expect(queries.length).toBeGreaterThanOrEqual(3));
      job.stop();
      expect(queries.some((sql) => sql.startsWith('DELETE FROM envelopes'))).toBe(true);
    });

    it('reports a failed sweep and keeps running', async () => {
      const failure = new Error('database gone');
      const broken = { query: () => Promise.reject(failure) };
      const errors: unknown[] = [];
      const job = startRetentionJob(broken, {
        onError: (error) => errors.push(error),
        intervalMs: 10,
      });
      await vi.waitFor(() => expect(errors.length).toBeGreaterThanOrEqual(2));
      job.stop();
      expect(errors[0]).toBe(failure);
    });
  });
});
