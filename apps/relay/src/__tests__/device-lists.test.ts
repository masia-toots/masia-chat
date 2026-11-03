import {
  DEVICE_LIST_TARGET_LIMIT,
  DEVICE_LIST_USER_LIMIT,
  DEVICE_LIST_WINDOW_MS,
  DeviceRole,
  RelayErrorCode,
} from '@masia/relay';
import { describe, expect, it } from 'vitest';
import {
  b64,
  databaseSuite,
  expectStatus,
  listEntry,
  OPERATOR,
  signedList,
} from './support/harness.js';

/** A USER device's entry with its real 32-byte signature key (the relay refuses any other length). */
const entry = (id: string) => listEntry(id);

interface ListBody {
  userId: string;
  version: number;
  devices: Array<{ id: string; role: string; signatureKey: string }>;
  signature: string;
}

databaseSuite('device lists (ADR-117 §2a)', (harness) => {
  it('stores a list signed by the pinned identity key exactly as signed, and never signs or edits it', async () => {
    const alice = await harness().enrol('alice', 'alice-phone');
    // `enrol` already stored version 1; this is version 2, signed by alice's identity key.
    const { signature, ...upload } = signedList('alice', 2, [
      entry('alice-phone'),
      entry('alice-tablet'),
    ]);

    const stored = await alice.post('/users/me/device-list', { ...upload, signature });
    expectStatus(stored, 201);
    expect(stored.json<ListBody>()).toMatchObject({ userId: 'alice', version: 2, devices: upload.devices, signature });

    const fetched = await alice.get('/users/alice/device-list');
    expectStatus(fetched, 200);
    expect(fetched.json<ListBody>()).toMatchObject({ version: 2, devices: upload.devices, signature });
  });

  describe('who may read it (security review round 2, M5: the contact gate)', () => {
    it('is read by a contact: a device that shares a room with one of the owner\'s devices', async () => {
      const alice = await harness().enrol('alice', 'alice-phone');
      const bob = await harness().enrol('bob', 'bob-phone');
      await harness().createRoom('room-1', alice);
      expectStatus(await harness().addToRoom('room-1', alice, bob), 201);

      const reply = await bob.get('/users/alice/device-list');
      expectStatus(reply, 200);
      expect(reply.json<ListBody>().devices.map((device) => device.id)).toEqual(['alice-phone']);
    });

    it('shows a stranger nothing: 403 NOT_A_CONTACT, the same for a user with a list and one without', async () => {
      await harness().enrol('alice', 'alice-phone');
      const mallory = await harness().enrol('mallory', 'mallory-phone');

      const existing = await mallory.get('/users/alice/device-list');
      expectStatus(existing, 403);
      expect(existing.json()).toMatchObject({ error: RelayErrorCode.NOT_A_CONTACT });
      const missing = await mallory.get('/users/nobody/device-list');
      expectStatus(missing, 403);
      expect(missing.json()).toEqual(existing.json());
    });

    it("hides a MINOR's list (and the GUARDIAN row on it) from a stranger; the guardian and a contact read it", async () => {
      const kid = await harness().enrol('kid', 'kid-tablet');
      await harness().enrol('kid', 'kid-guardian', DeviceRole.GUARDIAN, { guardian: 'dad' });
      const mallory = await harness().enrol('mallory', 'mallory-phone');

      const refused = await mallory.get('/users/kid/device-list');
      expectStatus(refused, 403);
      expect(JSON.stringify(refused.json())).not.toContain('kid-guardian');

      await harness().enrol('dad', 'dad-phone');
      const dad = await harness().caller({ userId: 'dad', deviceId: 'dad-phone' }, { adminOf: ['kid'] });
      const forDad = await dad.get('/users/kid/device-list');
      expectStatus(forDad, 200);
      expect(forDad.json<ListBody>().devices.map((device) => device.role)).toContain(DeviceRole.GUARDIAN);

      const aunt = await harness().enrol('aunt', 'aunt-phone');
      await harness().createRoom('family-room', aunt);
      expectStatus(await harness().addToRoom('family-room', aunt, kid), 201);
      expectStatus(await aunt.get('/users/kid/device-list'), 200);
      // Being in a room with the CHILD is what counts; mallory is still nobody's contact.
      expectStatus(await mallory.get('/users/kid/device-list'), 403);
    });

    it("lets every device read the operator's list: a member verifies it before adding the assistant", async () => {
      await harness().enrol(OPERATOR, 'masia-seat-1', DeviceRole.ASSISTANT);
      const alice = await harness().enrol('alice', 'alice-phone');
      const reply = await alice.get(`/users/${OPERATOR}/device-list`);
      expectStatus(reply, 200);
      expect(reply.json<ListBody>().devices.map((device) => device.id)).toEqual(['masia-seat-1']);
    });
  });

  it('accepts only the next version: a repeat is a 409 carrying the version on file', async () => {
    const alice = await harness().enrol('alice', 'alice-phone'); // stored version 1
    const repeat = await alice.post(
      '/users/me/device-list',
      signedList('alice', 1, [entry('alice-phone')]),
    );
    expectStatus(repeat, 409);
    expect(repeat.json()).toMatchObject({ error: RelayErrorCode.DEVICE_LIST_VERSION_CONFLICT, currentVersion: 1 });
  });

  it('refuses a version that skips ahead (409): the uploader was working from a list that is not on file', async () => {
    const alice = await harness().enrol('alice', 'alice-phone');
    const reply = await alice.post(
      '/users/me/device-list',
      signedList('alice', 3, [entry('alice-phone')]),
    );
    expectStatus(reply, 409);
    expect(reply.json()).toMatchObject({ currentVersion: 1 });
  });

  it('lets exactly one of two simultaneous uploads from the same base win', async () => {
    const phone = await harness().enrol('alice', 'alice-phone');
    const tablet = await harness().enrol('alice', 'alice-tablet'); // list is now at version 2
    const body = (seed: string) =>
      signedList('alice', 3, [entry('alice-phone'), entry('alice-tablet'), entry(`alice-${seed}`)]);

    const replies = await Promise.all([
      phone.post('/users/me/device-list', body('one')),
      tablet.post('/users/me/device-list', body('two')),
    ]);
    expect(replies.map((reply) => reply.status).sort()).toEqual([201, 409]);
  });

  it('stores a list for the token user only: there is no way to name another user', async () => {
    const mallory = await harness().enrol('mallory', 'mallory-phone');
    const bob = await harness().enrol('bob', 'bob-phone');
    expectStatus(
      await mallory.post(
        '/users/me/device-list',
        signedList('mallory', 2, [entry('mallory-phone'), entry('ghost-phone')]),
      ),
      201,
    );
    // Bob's list is untouched.
    expect((await bob.get('/users/bob/device-list')).json<ListBody>().version).toBe(1);
  });

  it('answers 404 for a user without a list (to a reader the gate lets through)', async () => {
    const alice = await harness().introduce(await harness().enrol('alice', 'alice-phone'), 'nobody');
    const reply = await alice.get('/users/nobody/device-list');
    expectStatus(reply, 404);
    expect(reply.json()).toMatchObject({ error: RelayErrorCode.DEVICE_LIST_NOT_FOUND });
  });

  it.each([
    ['a duplicated device', { version: 2, devices: [entry('alice-phone'), entry('alice-phone')] }],
    ['version 0', { version: 0, devices: [entry('alice-phone')] }],
    ['a role the relay does not know', { version: 2, devices: [{ ...entry('alice-phone'), role: 'ROOT' }] }],
    ['a signature key that is not base64', { version: 2, devices: [{ ...entry('alice-phone'), signatureKey: '***' }] }],
  ])('rejects %s (400)', async (_label, fields) => {
    const alice = await harness().enrol('alice', 'alice-phone');
    const reply = await alice.post('/users/me/device-list', { signature: b64('signature-bytes'), ...fields });
    expectStatus(reply, 400);
  });

  describe('reads of ANOTHER user are limited (security review 2026-10-10 §4: enumeration)', () => {
    it(`stops all devices of ONE user at ${DEVICE_LIST_USER_LIMIT} reads together (429 ACTOR_RATE_LIMITED), and forgives after the window`, async () => {
      // Enrolling stored lists (PUT), which are not lookups and spend no budget.
      const phone = await harness().enrol('alice', 'alice-phone');
      const tablet = await harness().enrol('alice', 'alice-tablet');
      const devices = [phone, tablet];

      // A different target each time, so only the CALLER's budget is in play; no target is anywhere
      // near its own cap. None is a contact: each read is refused by the gate (403) AND counted
      // against the caller, so a walk through the user ids stops after one budget.
      for (let attempt = 0; attempt < DEVICE_LIST_USER_LIMIT; attempt += 1) {
        const reply = await devices[attempt % devices.length]?.get(`/users/target-${attempt}/device-list`);
        expect(reply?.status, `read ${attempt + 1}`).toBe(403);
      }
      const limited = await tablet.get('/users/one-target-too-many/device-list');
      expectStatus(limited, 429);
      expect(limited.json()).toMatchObject({ error: RelayErrorCode.ACTOR_RATE_LIMITED });
      const retryAfter = Number(limited.headers['retry-after']);
      expect(retryAfter).toBeGreaterThan(0);
      expect(retryAfter).toBeLessThanOrEqual(DEVICE_LIST_WINDOW_MS / 1000);

      // The budget is the USER's: the other device is stopped too. Reading your own list costs
      // nothing, so it still works with the budget spent (the user must never be locked out of
      // their own directory by what a stranger-walk spent).
      expectStatus(await phone.get('/users/another-target/device-list'), 429);
      expectStatus(await phone.get('/users/alice/device-list'), 200);

      harness().clock.advance(DEVICE_LIST_WINDOW_MS);
      expectStatus(await phone.get('/users/another-target/device-list'), 403);
    });

    it(`stops EVERYONE together at ${DEVICE_LIST_TARGET_LIMIT} reads of one target (429 TARGET_RATE_LIMITED)`, async () => {
      const bob = await harness().enrol('bob', 'bob-phone');
      const readers = [
        await harness().introduce(await harness().enrol('u1', 'u1-phone'), 'bob'),
        await harness().introduce(await harness().enrol('u2', 'u2-phone'), 'bob'),
        await harness().introduce(await harness().enrol('u3', 'u3-phone'), 'bob'),
        await harness().introduce(await harness().enrol('u4', 'u4-phone'), 'bob'),
      ];
      const fresh = await harness().introduce(await harness().enrol('u5', 'u5-phone'), 'bob', 'u1');
      const perReader = DEVICE_LIST_TARGET_LIMIT / readers.length;
      expect(perReader).toBeLessThan(DEVICE_LIST_USER_LIMIT); // no reader is stopped by its own cap

      for (const reader of readers) {
        for (let attempt = 0; attempt < perReader; attempt += 1) {
          expectStatus(await reader.get('/users/bob/device-list'), 200);
        }
      }
      // A user who has not read anything yet is refused: the TARGET's budget is spent.
      const limited = await fresh.get('/users/bob/device-list');
      expectStatus(limited, 429);
      expect(limited.json()).toMatchObject({ error: RelayErrorCode.TARGET_RATE_LIMITED });
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);

      // Other targets are unaffected, and so is the owner reading their own list: an outside flood
      // must not lock bob out of his own device list.
      expectStatus(await fresh.get('/users/u1/device-list'), 200);
      expectStatus(await bob.get('/users/bob/device-list'), 200);

      harness().clock.advance(DEVICE_LIST_WINDOW_MS);
      expectStatus(await fresh.get('/users/bob/device-list'), 200);
    });

    it("does not let a caller refused for its own volume spend the target's budget", async () => {
      await harness().enrol('bob', 'bob-phone');
      const alice = await harness().introduce(await harness().enrol('alice', 'alice-phone'), 'bob');
      const carol = await harness().introduce(await harness().enrol('carol', 'carol-phone'), 'bob');
      // Alice may make DEVICE_LIST_USER_LIMIT reads; that is also exactly bob's whole budget as a
      // target, so keep her one short and leave bob one read for carol to prove it is unspent.
      const spent = Math.min(DEVICE_LIST_USER_LIMIT, DEVICE_LIST_TARGET_LIMIT - 1);

      for (let attempt = 0; attempt < spent; attempt += 1) {
        expectStatus(await alice.get('/users/bob/device-list'), 200);
      }
      // Alice runs into her own cap with reads of OTHER users, then keeps hammering bob. Every one
      // of those is refused for her volume and must not count against bob.
      for (let attempt = 0; attempt < DEVICE_LIST_USER_LIMIT - spent; attempt += 1) {
        expectStatus(await alice.get(`/users/someone-${attempt}/device-list`), 403);
      }
      for (let attempt = 0; attempt < DEVICE_LIST_TARGET_LIMIT; attempt += 1) {
        expectStatus(await alice.get('/users/bob/device-list'), 429);
      }
      expectStatus(await carol.get('/users/bob/device-list'), 200);
    });

    it('keeps the budgets of a user as an actor and as a target apart', async () => {
      const bob = await harness().introduce(await harness().enrol('bob', 'bob-phone'), 'carol');
      const carol = await harness().introduce(await harness().enrol('carol', 'carol-phone'), 'bob');
      for (let attempt = 0; attempt < DEVICE_LIST_USER_LIMIT; attempt += 1) {
        expectStatus(await carol.get('/users/bob/device-list'), 200);
      }
      // Carol's budget as an ACTOR is spent and bob's as a TARGET is spent. Bob reading carol still
      // works (carol's budget as a target is untouched, bob's as an actor is too).
      expectStatus(await carol.get('/users/bob/device-list'), 429);
      expectStatus(await bob.get('/users/carol/device-list'), 200);
    });
  });
});
