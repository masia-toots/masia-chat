import {
  DEVICE_LIST_TARGET_LIMIT,
  DEVICE_LIST_USER_LIMIT,
  DEVICE_LIST_WINDOW_MS,
  DeviceRole,
  RelayErrorCode,
} from '@masia/relay';
import { describe, expect, it } from 'vitest';
import { createLookupLimiter, LookupCharge } from '../domain/lookup-limits.js';
import { databaseSuite, expectStatus, OPERATOR, type Reply } from './support/harness.js';

const MS_PER_MINUTE = 60_000;
/** What an open client does: re-read everyone in its rooms about once a minute, on every device. */
const POLL_INTERVAL_MS = MS_PER_MINUTE;
const POLL_MINUTES = 30;
const CONTACTS = 20;

describe('the lookup limiter prices a lookup by what it is charged against', () => {
  const options = { windowMs: DEVICE_LIST_WINDOW_MS, actorLimit: 3, targetLimit: 2, now: () => 0 };

  function codeOf(action: () => void): string | null {
    try {
      action();
      return null;
    } catch (error) {
      return (error as { code?: string }).code ?? 'ERROR';
    }
  }

  it('charges nothing for NONE, however often', () => {
    const limiter = createLookupLimiter(options);
    for (let call = 0; call < 50; call += 1) {
      expect(codeOf(() => limiter.charge('a', 'b', LookupCharge.NONE))).toBeNull();
    }
    // ...and spent nothing: the full budget is still there.
    for (let call = 0; call < options.actorLimit; call += 1) {
      expect(codeOf(() => limiter.charge('a', 'c', LookupCharge.ACTOR))).toBeNull();
    }
  });

  it('charges only the caller for ACTOR: the target budget is untouched, whoever else looks', () => {
    const limiter = createLookupLimiter(options);
    // Many callers, each within its own budget, far beyond one target's budget.
    for (let caller = 0; caller < 10; caller += 1) {
      expect(codeOf(() => limiter.charge(`u${caller}`, 'op', LookupCharge.ACTOR))).toBeNull();
    }
    for (let call = 1; call < options.actorLimit; call += 1) {
      limiter.charge('u0', 'op', LookupCharge.ACTOR);
    }
    expect(codeOf(() => limiter.charge('u0', 'op', LookupCharge.ACTOR))).toBe(
      RelayErrorCode.ACTOR_RATE_LIMITED,
    );
  });

  it('charges the caller AND the target for ACTOR_AND_TARGET, and never the target for your own id', () => {
    const limiter = createLookupLimiter(options);
    for (let call = 0; call < options.targetLimit; call += 1) {
      expect(codeOf(() => limiter.charge(`u${call}`, 'bob', LookupCharge.ACTOR_AND_TARGET))).toBeNull();
    }
    expect(codeOf(() => limiter.charge('u9', 'bob', LookupCharge.ACTOR_AND_TARGET))).toBe(
      RelayErrorCode.TARGET_RATE_LIMITED,
    );
    // Bob reading himself spends only his own caller budget; his target budget is not involved.
    expect(codeOf(() => limiter.charge('bob', 'bob', LookupCharge.ACTOR_AND_TARGET))).toBeNull();
  });
});

databaseSuite('what a directory lookup costs (the budget stops a walk, not normal use)', (harness) => {
  /** Every GET that does not answer 200, with its path and code, so a failure says which. */
  async function refusals(
    reader: { get(url: string): Promise<Reply> },
    paths: readonly string[],
  ): Promise<string[]> {
    const refused: string[] = [];
    for (const path of paths) {
      const reply = await reader.get(path);
      if (reply.status !== 200) {
        refused.push(`${path} -> ${reply.status} ${String(reply.json().error)}`);
      }
    }
    return refused;
  }

  it(`never limits a user with ${CONTACTS} contacts on 2 devices re-reading them every minute for ${POLL_MINUTES} minutes`, async () => {
    const phone = await harness().enrol('me', 'me-phone');
    const tablet = await harness().enrol('me', 'me-tablet');
    await harness().createRoom('hub', phone);
    expectStatus(await harness().addToRoom('hub', phone, tablet), 201);
    const people = ['me'];
    for (let index = 0; index < CONTACTS; index += 1) {
      const contact = await harness().enrol(`c${index}`, `c${index}-phone`);
      expectStatus(await harness().addToRoom('hub', phone, contact), 201);
      people.push(`c${index}`);
    }
    // One pass of an open client: the signed versions of everybody in its rooms (itself included).
    const pass = people.map((userId) => `/users/${userId}/device-list/versions?afterVersion=1`);
    // 2 devices x 21 people x 30 minutes = 1260 lookups, ten times the 120-per-window budget of a
    // stranger. Not one may be refused.
    const refused: string[] = [];
    for (let minute = 0; minute < POLL_MINUTES; minute += 1) {
      for (const device of [phone, tablet]) {
        refused.push(...(await refusals(device, pass)));
      }
      harness().clock.advance(POLL_INTERVAL_MS);
    }
    expect(refused).toEqual([]);
    // The directory route draws on the same budget and is just as free for them.
    expect(await refusals(tablet, people.map((userId) => `/users/${userId}/devices`))).toEqual([]);
  }, 120_000);

  it('still stops a walk through the user ids after the budget, a stranger being refused by the gate each time', async () => {
    const mallory = await harness().enrol('mallory', 'mallory-phone');
    for (let probe = 0; probe < DEVICE_LIST_USER_LIMIT; probe += 1) {
      const reply = await mallory.get(`/users/target-${probe}/devices`);
      expect(reply.status, `probe ${probe + 1}`).toBe(403);
      expect(reply.json()).toMatchObject({ error: RelayErrorCode.NOT_A_CONTACT });
    }
    const limited = await mallory.get('/users/target-one-more/device-list');
    expectStatus(limited, 429);
    expect(limited.json()).toMatchObject({ error: RelayErrorCode.ACTOR_RATE_LIMITED });
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);

    // The window forgives.
    harness().clock.advance(DEVICE_LIST_WINDOW_MS);
    expectStatus(await mallory.get('/users/target-one-more/device-list'), 403);
  });

  it("charges a refused probe to the prober alone: a walk cannot spend a victim's budget", async () => {
    const mallory = await harness().enrol('mallory', 'mallory-phone');
    const carol = await harness().enrol('carol', 'carol-phone');
    await harness().createRoom('room', carol);
    const dave = await harness().enrol('dave', 'dave-phone');
    expectStatus(await harness().addToRoom('room', carol, dave), 201);
    // Mallory hammers dave far past any per-target cap; every probe is refused (403, then 429).
    for (let probe = 0; probe < DEVICE_LIST_TARGET_LIMIT + 10; probe += 1) {
      const reply = await mallory.get('/users/dave/devices');
      expect(reply.status).toBe(probe < DEVICE_LIST_USER_LIMIT ? 403 : 429);
    }
    // Dave's own budget as a target is untouched: carol (his contact) and an introduced reader read him.
    expectStatus(await carol.get('/users/dave/device-list'), 200);
    const erin = await harness().introduce(await harness().enrol('erin', 'erin-phone'), 'dave');
    expectStatus(await erin.get('/users/dave/device-list'), 200);
  });

  it('does not let a spent budget cut a user off from themself or from their contacts', async () => {
    const mallory = await harness().enrol('mallory', 'mallory-phone');
    const friend = await harness().enrol('friend', 'friend-phone');
    await harness().createRoom('room', mallory);
    expectStatus(await harness().addToRoom('room', mallory, friend), 201);
    for (let probe = 0; probe < DEVICE_LIST_USER_LIMIT; probe += 1) {
      await mallory.get(`/users/target-${probe}/device-list`);
    }
    expectStatus(await mallory.get('/users/target-more/device-list'), 429);
    expectStatus(await mallory.get('/users/mallory/device-list'), 200);
    expectStatus(await mallory.get('/users/mallory/devices'), 200);
    expectStatus(await mallory.get('/users/friend/device-list'), 200);
    expectStatus(await mallory.get('/users/friend/devices'), 200);
  });

  it('leaves an admin reading the people it administers unlimited', async () => {
    await harness().enrol('kid', 'kid-tablet');
    await harness().enrol('dad', 'dad-phone');
    const dad = await harness().caller({ userId: 'dad', deviceId: 'dad-phone' }, { adminOf: ['kid'] });
    const paths = Array.from(
      { length: DEVICE_LIST_USER_LIMIT + 10 },
      (_unused, index) => (index % 2 === 0 ? '/users/kid/device-list' : '/users/kid/devices'),
    );
    expect(await refusals(dad, paths)).toEqual([]);
  });

  describe("the operator account, which everybody may read and which owns every assistant device", () => {
    it("is charged to the caller only, so no group of callers can make it unreachable for the others", async () => {
      await harness().enrol(OPERATOR, 'masia-seat-1', DeviceRole.ASSISTANT);
      const perReader = 30;
      const readers = Math.ceil(DEVICE_LIST_TARGET_LIMIT / perReader) + 2;
      expect(perReader).toBeLessThan(DEVICE_LIST_USER_LIMIT);
      const callers = [];
      for (let index = 0; index < readers; index += 1) {
        callers.push(await harness().enrol(`u${index}`, `u${index}-phone`));
      }
      // Together far beyond one target's budget, each well inside its own: all are served.
      for (const caller of callers) {
        const paths = Array.from({ length: perReader }, () => `/users/${OPERATOR}/device-list`);
        expect(await refusals(caller, paths)).toEqual([]);
      }
    });

    it('still stops one caller that reads it more than its own budget (429 ACTOR_RATE_LIMITED)', async () => {
      await harness().enrol(OPERATOR, 'masia-seat-1', DeviceRole.ASSISTANT);
      const greedy = await harness().enrol('greedy', 'greedy-phone');
      const other = await harness().enrol('other', 'other-phone');
      for (let read = 0; read < DEVICE_LIST_USER_LIMIT; read += 1) {
        expectStatus(await greedy.get(`/users/${OPERATOR}/device-list`), 200);
      }
      const limited = await greedy.get(`/users/${OPERATOR}/device-list`);
      expectStatus(limited, 429);
      expect(limited.json()).toMatchObject({ error: RelayErrorCode.ACTOR_RATE_LIMITED });
      // Someone else is not affected by it.
      expectStatus(await other.get(`/users/${OPERATOR}/device-list`), 200);
    });
  });
});
