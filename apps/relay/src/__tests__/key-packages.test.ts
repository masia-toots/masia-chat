import {
  CLAIM_LIMIT,
  CLAIM_TARGET_LIMIT,
  CLAIM_USER_LIMIT,
  CLAIM_WINDOW_MS,
  KEY_PACKAGE_UPLOAD_DEVICE_LIMIT,
  KEY_PACKAGE_UPLOAD_USER_LIMIT,
  KEY_PACKAGE_UPLOAD_WINDOW_MS,
  MAX_KEY_PACKAGE_BYTES,
  MAX_KEY_PACKAGES_PER_UPLOAD,
  MAX_UNCLAIMED_KEY_PACKAGES_PER_DEVICE,
  DeviceRole,
  MlsHeaderErrorReason,
  RelayErrorCode,
} from '@masia/relay';
import { describe, expect, it } from 'vitest';
import {
  type Caller,
  type Harness,
  b64,
  countRows,
  databaseSuite,
  expectStatus,
  keyPackageB64,
  OPERATOR,
  TestClock,
} from './support/harness.js';

interface Claim {
  deviceId: string;
  keyPackageId: string;
  bytes: string;
  lastResort: boolean;
}

/** Every test starts at the harness clock's start; the packages below are alive then (90 days). */
const START = new TestClock();
const SECONDS_PER_DAY = 24 * 60 * 60;
const MS_PER_SECOND = 1000;
/** A credential type RFC 9420 does not define. */
const UNKNOWN_CREDENTIAL_TYPE = 0x7777;
/** RFC 9420 leaf_node_source of a leaf that came from a commit, not a key package. */
const COMMIT_LEAF_NODE_SOURCE = 3;

/** A distinct, readable, unexpired KeyPackage per name. */
const packageBytes = (name: string) => keyPackageB64(START, { seed: name });
const ordinary = (name: string) => ({ bytes: packageBytes(name) });
const lastResort = (name: string) => ({ bytes: packageBytes(name), lastResort: true });
/** A package whose lifetime ends `days` after the start (negative: already over). */
const endingIn = (name: string, days: number, isLastResort = false) => ({
  bytes: keyPackageB64(START, { seed: name, notAfter: START.seconds() + days * SECONDS_PER_DAY }),
  lastResort: isLastResort,
});

/**
 * Claims `userId`'s packages as `by`, introduced (`Harness.introduce`): these suites test the pool
 * and its limits, not the contact gate, which has its own describe below.
 */
async function claim(harness: Harness, by: Caller, userId: string): Promise<Claim[]> {
  const introduced = await harness.introduce(by, userId);
  const reply = await introduced.post('/key-packages/claim', { userId });
  expectStatus(reply, 200);
  return reply.json<{ rows: Claim[] }>().rows;
}

databaseSuite('key packages (ADR-117 §2, H6)', (harness) => {
  it('stores an upload that includes a last-resort package and reports what is left', async () => {
    const bob = await harness().enrol('bob', 'bob-phone');
    const reply = await bob.post('/key-packages', [ordinary('a'), ordinary('b'), lastResort('z')]);
    expectStatus(reply, 201);
    expect(reply.json()).toEqual({ uploaded: 3, available: 2 });
  });

  it('refuses an upload that leaves the device without a last-resort package, and stores none of it', async () => {
    const bob = await harness().enrol('bob', 'bob-phone');
    const reply = await bob.post('/key-packages', [ordinary('a'), ordinary('b')]);
    expectStatus(reply, 422);
    expect(reply.json()).toMatchObject({ error: RelayErrorCode.LAST_RESORT_REQUIRED });
    expect(await countRows('SELECT count(*) AS n FROM key_packages', harness().db)).toBe(0);
  });

  it('accepts a top-up without a new last-resort once the device has one', async () => {
    const bob = await harness().enrol('bob', 'bob-phone');
    expectStatus(await bob.post('/key-packages', [ordinary('a'), lastResort('z')]), 201);
    const topUp = await bob.post('/key-packages', [ordinary('b'), ordinary('c')]);
    expectStatus(topUp, 201);
    expect(topUp.json()).toEqual({ uploaded: 2, available: 3 });
  });

  it.each([
    ['an empty list', []],
    ['a package that is not base64', [{ bytes: '%%%not base64%%%', lastResort: true }]],
    [
      'a package over the size limit',
      [{ bytes: Buffer.alloc(MAX_KEY_PACKAGE_BYTES + 1).toString('base64'), lastResort: true }],
    ],
    ['an unknown field', [{ ...lastResort('z'), owner: 'someone-else' }]],
  ])('rejects %s (400)', async (_label, body) => {
    const bob = await harness().enrol('bob', 'bob-phone');
    expectStatus(await bob.post('/key-packages', body), 400);
  });

  it('hands out ordinary packages once each, then falls back to the last-resort without consuming it', async () => {
    const bob = await harness().enrol('bob', 'bob-phone');
    const alice = await harness().enrol('alice', 'alice-phone');
    expectStatus(
      await bob.post('/key-packages', [ordinary('first'), ordinary('second'), lastResort('last')]),
      201,
    );

    const [one] = await claim(harness(), alice, 'bob');
    const [two] = await claim(harness(), alice, 'bob');
    const [three] = await claim(harness(), alice, 'bob');
    const [four] = await claim(harness(), alice, 'bob');

    expect([one?.lastResort, two?.lastResort]).toEqual([false, false]);
    // Which of the two ordinary packages comes first is not promised (one upload shares one
    // timestamp); that each is handed out exactly once is.
    expect([one?.bytes, two?.bytes].sort()).toEqual(
      [packageBytes('first'), packageBytes('second')].sort(),
    );
    // The pool is empty: the last-resort answers, again and again, and stays unconsumed.
    expect(three).toMatchObject({ lastResort: true, bytes: packageBytes('last') });
    expect(four).toMatchObject({ lastResort: true, keyPackageId: three?.keyPackageId });
    expect(
      await countRows(
        'SELECT count(*) AS n FROM key_packages WHERE last_resort AND consumed_at IS NOT NULL',
        harness().db,
      ),
    ).toBe(0);
  });

  it('returns one package per ACTIVE device of the user and skips a revoked one', async () => {
    const phone = await harness().enrol('bob', 'bob-phone');
    const tablet = await harness().enrol('bob', 'bob-tablet');
    const alice = await harness().enrol('alice', 'alice-phone');
    expectStatus(await phone.post('/key-packages', [ordinary('p'), lastResort('p-last')]), 201);
    expectStatus(await tablet.post('/key-packages', [lastResort('t-last')]), 201);

    expect((await claim(harness(), alice, 'bob')).map((item) => item.deviceId)).toEqual([
      'bob-phone',
      'bob-tablet',
    ]);

    expectStatus(await phone.post('/devices/bob-tablet/revoke'), 200);
    expect((await claim(harness(), alice, 'bob')).map((item) => item.deviceId)).toEqual(['bob-phone']);
  });

  it('answers an empty collection for a user without devices', async () => {
    const alice = await harness().enrol('alice', 'alice-phone');
    expect(await claim(harness(), alice, 'nobody')).toEqual([]);
  });

  it('never hands the same package to two simultaneous claimers', async () => {
    const bob = await harness().enrol('bob', 'bob-phone');
    const alice = await harness().enrol('alice', 'alice-phone');
    const carol = await harness().enrol('carol', 'carol-phone');
    expectStatus(
      await bob.post('/key-packages', [ordinary('first'), ordinary('second'), lastResort('last')]),
      201,
    );

    const [forAlice, forCarol] = await Promise.all([claim(harness(), alice, 'bob'), claim(harness(), carol, 'bob')]);
    expect(forAlice[0]?.lastResort).toBe(false);
    expect(forCarol[0]?.lastResort).toBe(false);
    expect(forAlice[0]?.keyPackageId).not.toBe(forCarol[0]?.keyPackageId);
  });

  it('refuses the database a consumed last-resort package, whatever the application does', async () => {
    const bob = await harness().enrol('bob', 'bob-phone');
    expectStatus(await bob.post('/key-packages', [lastResort('last')]), 201);
    await expect(
      harness().db.query('UPDATE key_packages SET consumed_at = now() WHERE last_resort'),
    ).rejects.toThrow();
  });

  it(`limits one device to ${CLAIM_LIMIT} claims per window (429 with Retry-After), and forgives after it`, async () => {
    const bob = await harness().enrol('bob', 'bob-phone');
    const alice = await harness().introduce(await harness().enrol('alice', 'alice-phone'), 'bob');
    const carol = await harness().introduce(await harness().enrol('carol', 'carol-phone'), 'bob');
    expectStatus(await bob.post('/key-packages', [lastResort('last')]), 201);

    for (let attempt = 1; attempt <= CLAIM_LIMIT; attempt += 1) {
      expectStatus(await alice.post('/key-packages/claim', { userId: 'bob' }), 200);
    }
    const limited = await alice.post('/key-packages/claim', { userId: 'bob' });
    expectStatus(limited, 429);
    expect(limited.json()).toMatchObject({ error: RelayErrorCode.CLAIM_RATE_LIMITED });
    const retryAfter = Number(limited.headers['retry-after']);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(CLAIM_WINDOW_MS / 1000);

    // The limit is per claiming device: someone else is not affected.
    expectStatus(await carol.post('/key-packages/claim', { userId: 'bob' }), 200);

    harness().clock.advance(CLAIM_WINDOW_MS);
    expectStatus(await alice.post('/key-packages/claim', { userId: 'bob' }), 200);
  });

  describe('claims are recorded (security review 2026-10-10 §4: who claimed which package)', () => {
    it('records the claimer of an ordinary package, once', async () => {
      const bob = await harness().enrol('bob', 'bob-phone');
      const alice = await harness().enrol('alice', 'alice-phone');
      expectStatus(await bob.post('/key-packages', [ordinary('first'), lastResort('last')]), 201);

      const [taken] = await claim(harness(), alice, 'bob');
      const { rows } = await harness().db.query<{ id: string; claimer: string }>(
        'SELECT key_package_id::text AS id, claimer_device_id AS claimer FROM key_package_claims',
      );
      expect(rows).toEqual([{ id: taken?.keyPackageId, claimer: 'alice-phone' }]);
    });

    it('records every claimer of a last-resort package, which is handed out again and again', async () => {
      const bob = await harness().enrol('bob', 'bob-phone');
      const alice = await harness().enrol('alice', 'alice-phone');
      const carol = await harness().enrol('carol', 'carol-phone');
      expectStatus(await bob.post('/key-packages', [lastResort('last')]), 201);

      const [forAlice] = await claim(harness(), alice, 'bob');
      await claim(harness(), alice, 'bob'); // the same claimer again: still one row for the pair
      const [forCarol] = await claim(harness(), carol, 'bob');
      expect(forAlice?.keyPackageId).toBe(forCarol?.keyPackageId);

      const { rows } = await harness().db.query<{ claimer: string }>(
        'SELECT claimer_device_id AS claimer FROM key_package_claims ORDER BY claimer_device_id',
      );
      expect(rows.map((row) => row.claimer)).toEqual(['alice-phone', 'carol-phone']);
    });

    it('records nothing when the pool has nothing to give', async () => {
      const alice = await harness().enrol('alice', 'alice-phone');
      expect(await claim(harness(), alice, 'nobody')).toEqual([]);
      expect(await countRows('SELECT count(*) AS n FROM key_package_claims', harness().db)).toBe(0);
    });

    it('serves a canonical UUID as the package id: that is what a commit names in memberDelta', async () => {
      const bob = await harness().enrol('bob', 'bob-phone');
      const alice = await harness().enrol('alice', 'alice-phone');
      expectStatus(await bob.post('/key-packages', [lastResort('last')]), 201);
      expect((await claim(harness(), alice, 'bob'))[0]?.keyPackageId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });
  });

  describe('who may claim (security review round 2, M5: the contact gate)', () => {
    it('refuses a stranger (403 NOT_A_CONTACT), the same for a user who exists and one who does not, and hands out nothing', async () => {
      const bob = await harness().enrol('bob', 'bob-phone');
      expectStatus(await bob.post('/key-packages', [ordinary('first'), lastResort('last')]), 201);
      const mallory = await harness().enrol('mallory', 'mallory-phone');

      const existing = await mallory.post('/key-packages/claim', { userId: 'bob' });
      expectStatus(existing, 403);
      expect(existing.json()).toMatchObject({ error: RelayErrorCode.NOT_A_CONTACT });
      const missing = await mallory.post('/key-packages/claim', { userId: 'nobody' });
      expectStatus(missing, 403);
      expect(missing.json()).toEqual(existing.json());
      expect(await countRows('SELECT count(*) AS n FROM key_package_claims', harness().db)).toBe(0);
      expect(
        await countRows('SELECT count(*) AS n FROM key_packages WHERE consumed_at IS NOT NULL', harness().db),
      ).toBe(0);
    });

    it("refuses a stranger a MINOR's packages, the GUARDIAN leaf's included; the guardian and a contact may claim", async () => {
      const kid = await harness().enrol('kid', 'kid-tablet');
      const guardianDevice = await harness().enrol('kid', 'kid-guardian', DeviceRole.GUARDIAN, {
        guardian: 'dad',
      });
      expectStatus(await kid.post('/key-packages', [lastResort('kid-last')]), 201);
      expectStatus(await guardianDevice.post('/key-packages', [lastResort('guardian-last')]), 201);
      const mallory = await harness().enrol('mallory', 'mallory-phone');

      const refused = await mallory.post('/key-packages/claim', { userId: 'kid' });
      expectStatus(refused, 403);
      expect(refused.json()).toMatchObject({ error: RelayErrorCode.NOT_A_CONTACT });

      // The adult who administers the child (the token's `adminOf`) is let through.
      await harness().enrol('dad', 'dad-phone');
      const dad = await harness().caller({ userId: 'dad', deviceId: 'dad-phone' }, { adminOf: ['kid'] });
      expect((await claim(harness(), dad, 'kid')).map((row) => row.deviceId).sort()).toEqual([
        'kid-guardian',
        'kid-tablet',
      ]);

      // So is a contact: a device that shares a room with one of the child's devices.
      const aunt = await harness().enrol('aunt', 'aunt-phone');
      await harness().createRoom('family-room', aunt);
      expectStatus(await harness().addToRoom('family-room', aunt, kid), 201);
      expectStatus(await aunt.post('/key-packages/claim', { userId: 'kid' }), 200);
    });

    it("lets every device claim the operator's packages: that is how a member adds the assistant", async () => {
      const assistant = await harness().enrol(OPERATOR, 'masia-seat-1', DeviceRole.ASSISTANT);
      expectStatus(await assistant.post('/key-packages', [lastResort('seat-last')]), 201);
      const alice = await harness().enrol('alice', 'alice-phone');

      const reply = await alice.post('/key-packages/claim', { userId: OPERATOR });
      expectStatus(reply, 200);
      expect(reply.json<{ rows: Claim[] }>().rows.map((row) => row.deviceId)).toEqual(['masia-seat-1']);
    });
  });

  describe('per-user and per-target limits (security review 2026-10-10 §4: enumeration)', () => {
    it(`stops several devices of ONE user at ${CLAIM_USER_LIMIT} claims together, though each is far below its own ${CLAIM_LIMIT}`, async () => {
      const phone = await harness().enrol('alice', 'alice-phone');
      const tablet = await harness().enrol('alice', 'alice-tablet');
      const laptop = await harness().enrol('alice', 'alice-laptop');
      const devices = [phone, tablet, laptop];
      expect(CLAIM_USER_LIMIT).toBeGreaterThan(CLAIM_LIMIT); // the per-device cap alone would allow 3 x 30
      expect(CLAIM_USER_LIMIT).toBeLessThanOrEqual(devices.length * (CLAIM_LIMIT - 1));

      // A different target every time, so only the CALLER's budgets are in play. None of them is
      // a contact: each claim is refused by the gate (403) AND counted, since the budgets come first.
      for (let attempt = 0; attempt < CLAIM_USER_LIMIT; attempt += 1) {
        const reply = await devices[attempt % devices.length]?.post('/key-packages/claim', {
          userId: `target-${attempt}`,
        });
        expect(reply?.status, `claim ${attempt + 1}`).toBe(403);
      }
      const limited = await tablet.post('/key-packages/claim', { userId: 'one-target-too-many' });
      expectStatus(limited, 429);
      expect(limited.json()).toMatchObject({ error: RelayErrorCode.ACTOR_RATE_LIMITED });
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);

      // Every device of the user is stopped, not just the one that happened to hit the cap.
      expectStatus(await phone.post('/key-packages/claim', { userId: 'another-target' }), 429);
      expectStatus(await laptop.post('/key-packages/claim', { userId: 'another-target' }), 429);

      harness().clock.advance(CLAIM_WINDOW_MS);
      expectStatus(await phone.post('/key-packages/claim', { userId: 'another-target' }), 403);
      expectStatus(await phone.post('/key-packages/claim', { userId: 'alice' }), 200);
    });

    it(`stops EVERYONE together at ${CLAIM_TARGET_LIMIT} claims against one target (429 TARGET_RATE_LIMITED)`, async () => {
      const bob = await harness().enrol('bob', 'bob-phone');
      expectStatus(await bob.post('/key-packages', [lastResort('last')]), 201);
      const claimers = [
        await harness().introduce(await harness().enrol('u1', 'u1-phone'), 'bob'),
        await harness().introduce(await harness().enrol('u2', 'u2-phone'), 'bob'),
        await harness().introduce(await harness().enrol('u3', 'u3-phone'), 'bob'),
      ];
      const fresh = await harness().introduce(await harness().enrol('u4', 'u4-phone'), 'bob', 'carol');
      const perClaimer = CLAIM_TARGET_LIMIT / claimers.length;
      expect(perClaimer).toBeLessThan(CLAIM_LIMIT); // no claimer is stopped by its own caps

      for (const claimer of claimers) {
        for (let attempt = 0; attempt < perClaimer; attempt += 1) {
          expectStatus(await claimer.post('/key-packages/claim', { userId: 'bob' }), 200);
        }
      }
      // A user who has not claimed anything yet is refused: the TARGET's budget is spent.
      const limited = await fresh.post('/key-packages/claim', { userId: 'bob' });
      expectStatus(limited, 429);
      expect(limited.json()).toMatchObject({ error: RelayErrorCode.TARGET_RATE_LIMITED });
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);

      // Other targets are unaffected, and so is the owner looking at their own packages: an
      // outside flood must not lock bob out of his own devices.
      expectStatus(await fresh.post('/key-packages/claim', { userId: 'carol' }), 200);
      expectStatus(await bob.post('/key-packages/claim', { userId: 'bob' }), 200);

      harness().clock.advance(CLAIM_WINDOW_MS);
      expectStatus(await fresh.post('/key-packages/claim', { userId: 'bob' }), 200);
    });

    it("does not let a caller that was refused for its own volume spend the target's budget", async () => {
      const bob = await harness().enrol('bob', 'bob-phone');
      expectStatus(await bob.post('/key-packages', [lastResort('last')]), 201);
      const alice = await harness().introduce(await harness().enrol('alice', 'alice-phone'), 'bob');
      const carol = await harness().introduce(await harness().enrol('carol', 'carol-phone'), 'bob');

      for (let attempt = 0; attempt < CLAIM_LIMIT; attempt += 1) {
        expectStatus(await alice.post('/key-packages/claim', { userId: 'bob' }), 200);
      }
      // Alice hammers on after her per-device cap: none of this may count against bob.
      for (let attempt = 0; attempt < CLAIM_TARGET_LIMIT; attempt += 1) {
        expectStatus(await alice.post('/key-packages/claim', { userId: 'bob' }), 429);
      }
      for (let attempt = 0; attempt < CLAIM_LIMIT; attempt += 1) {
        expectStatus(await carol.post('/key-packages/claim', { userId: 'bob' }), 200);
      }
    });
  });

  describe('a retried upload (the answer was lost) stores no package twice', () => {
    const batch = () => [ordinary('only-one'), lastResort('lr')];

    it('answers 0 uploaded and the same available the second time, and keeps one copy of each', async () => {
      const bob = await harness().enrol('bob', 'bob-phone');
      const first = await bob.post('/key-packages', batch());
      expectStatus(first, 201);
      expect(first.json()).toEqual({ uploaded: 2, available: 1 });

      const second = await bob.post('/key-packages', batch());
      expectStatus(second, 201);
      expect(second.json()).toEqual({ uploaded: 0, available: 1 });
      expect(await countRows('SELECT count(*) AS n FROM key_packages', harness().db)).toBe(2);
    });

    it('never hands the same ordinary package to two claimers', async () => {
      const bob = await harness().enrol('bob', 'bob-phone');
      expectStatus(await bob.post('/key-packages', batch()), 201);
      expectStatus(await bob.post('/key-packages', batch()), 201);

      const alice = await harness().enrol('alice', 'alice-phone');
      const carol = await harness().enrol('carol', 'carol-phone');
      const [first] = await claim(harness(), alice, 'bob');
      const [second] = await claim(harness(), carol, 'bob');
      expect(first?.lastResort).toBe(false);
      // The pool held one ordinary package: the next claimer gets the last resort, not a copy.
      expect(second?.lastResort).toBe(true);
      expect(second?.bytes).not.toBe(first?.bytes);
    });

    it('stores only the new packages of a partly repeated upload, and counts only those', async () => {
      const bob = await harness().enrol('bob', 'bob-phone');
      expectStatus(await bob.post('/key-packages', [ordinary('a'), ordinary('b'), lastResort('z')]), 201);
      const overlap = await bob.post('/key-packages', [ordinary('b'), ordinary('c')]);
      expectStatus(overlap, 201);
      expect(overlap.json()).toEqual({ uploaded: 1, available: 3 });
    });

    it('counts a package repeated inside one upload once', async () => {
      const bob = await harness().enrol('bob', 'bob-phone');
      const reply = await bob.post('/key-packages', [ordinary('a'), ordinary('a'), lastResort('z')]);
      expectStatus(reply, 201);
      expect(reply.json()).toEqual({ uploaded: 2, available: 1 });
    });

    it('does not bring a package back that was already handed out', async () => {
      const bob = await harness().enrol('bob', 'bob-phone');
      const alice = await harness().enrol('alice', 'alice-phone');
      expectStatus(await bob.post('/key-packages', [ordinary('spent'), lastResort('lr')]), 201);
      const [handedOut] = await claim(harness(), alice, 'bob');
      expect(handedOut?.lastResort).toBe(false);

      const again = await bob.post('/key-packages', [ordinary('spent')]);
      expectStatus(again, 201);
      expect(again.json()).toEqual({ uploaded: 0, available: 0 });
    });

    it('stores each package once when the same upload arrives twice at the same moment', async () => {
      const bob = await harness().enrol('bob', 'bob-phone');
      const replies = await Promise.all([
        bob.post('/key-packages', batch()),
        bob.post('/key-packages', batch()),
      ]);
      for (const reply of replies) expectStatus(reply, 201);
      const uploaded = replies.map((reply) => reply.json<{ uploaded: number }>().uploaded);
      expect(uploaded.reduce((sum, count) => sum + count, 0)).toBe(2);
      expect(await countRows('SELECT count(*) AS n FROM key_packages', harness().db)).toBe(2);
    });

    it('lets two devices each hold their own package (the rule is per device)', async () => {
      const phone = await harness().enrol('bob', 'bob-phone');
      const tablet = await harness().enrol('bob', 'bob-tablet');
      expectStatus(await phone.post('/key-packages', [lastResort('lr-phone')]), 201);
      expectStatus(await tablet.post('/key-packages', [lastResort('lr-tablet')]), 201);
      expect(await countRows('SELECT count(*) AS n FROM key_packages', harness().db)).toBe(2);
    });
  });

  describe('lifetimes (review round 1, 2026-10-10: expired packages are never served)', () => {
    it.each([
      ['plain bytes that are no MLSMessage', b64('not-a-key-package'), 'version'],
      [
        'a credential of an unknown type',
        keyPackageB64(START, { credentialType: UNKNOWN_CREDENTIAL_TYPE }),
        'credential',
      ],
      [
        'a leaf that is not a key-package leaf',
        keyPackageB64(START, { leafNodeSource: COMMIT_LEAF_NODE_SOURCE }),
        'leafNodeSource',
      ],
    ])(
      'refuses %s (422 KEY_PACKAGE_UNREADABLE, naming the field)',
      async (_label, bytes, field) => {
        const bob = await harness().enrol('bob', 'bob-phone');
        const reply = await bob.post('/key-packages', [
          lastResort('ok'),
          { bytes, lastResort: false },
        ]);
        expectStatus(reply, 422);
        expect(reply.json()).toMatchObject({
          error: RelayErrorCode.KEY_PACKAGE_UNREADABLE,
          index: 1,
          field,
        });
        expect(await countRows('SELECT count(*) AS n FROM key_packages', harness().db)).toBe(0);
      },
    );

    it('names the reason of an unreadable package', async () => {
      const bob = await harness().enrol('bob', 'bob-phone');
      const reply = await bob.post('/key-packages', [
        { bytes: b64('not-a-key-package'), lastResort: true },
      ]);
      expect(reply.json()).toMatchObject({ reason: MlsHeaderErrorReason.UNSUPPORTED_VERSION });
    });

    it('refuses a package whose lifetime is already over (422 KEY_PACKAGE_EXPIRED)', async () => {
      const bob = await harness().enrol('bob', 'bob-phone');
      const reply = await bob.post('/key-packages', [lastResort('ok'), endingIn('old', -1)]);
      expectStatus(reply, 422);
      expect(reply.json()).toMatchObject({ error: RelayErrorCode.KEY_PACKAGE_EXPIRED, index: 1 });
    });

    it('stores the end of the lifetime, and keeps a "for ever" package as the latest date it can hold', async () => {
      const bob = await harness().enrol('bob', 'bob-phone');
      const forever = keyPackageB64(START, { seed: 'forever', notAfter: Number.MAX_SAFE_INTEGER });
      expectStatus(
        await bob.post('/key-packages', [
          endingIn('a', 7, true),
          { bytes: forever, lastResort: false },
        ]),
        201,
      );
      const { rows } = await harness().db.query<{ notAfter: Date }>(
        'SELECT not_after AS "notAfter" FROM key_packages ORDER BY not_after',
      );
      expect(rows.map((row) => row.notAfter.getTime())).toEqual([
        (START.seconds() + 7 * SECONDS_PER_DAY) * MS_PER_SECOND,
        Date.UTC(9999, 11, 31, 23, 59, 59),
      ]);
    });

    it('never serves a package once its lifetime is over, ordinary or last-resort', async () => {
      const bob = await harness().enrol('bob', 'bob-phone');
      const alice = await harness().enrol('alice', 'alice-phone');
      expectStatus(
        await bob.post('/key-packages', [endingIn('short', 1), endingIn('short-last', 1, true)]),
        201,
      );

      harness().clock.advance(2 * SECONDS_PER_DAY * MS_PER_SECOND);
      expect(await claim(harness(), alice, 'bob')).toEqual([]);
      expect(await countRows('SELECT count(*) AS n FROM key_package_claims', harness().db)).toBe(0);
    });

    it("purges the device's expired packages on its next upload, and asks for a live last-resort", async () => {
      const bob = await harness().enrol('bob', 'bob-phone');
      expectStatus(
        await bob.post('/key-packages', [endingIn('short', 1), endingIn('short-last', 1, true)]),
        201,
      );
      harness().clock.advance(2 * SECONDS_PER_DAY * MS_PER_SECOND);

      // The expired last-resort no longer counts: an upload without a new one is refused...
      const refused = await bob.post('/key-packages', [endingIn('fresh', 30)]);
      expectStatus(refused, 422);
      expect(refused.json()).toMatchObject({ error: RelayErrorCode.LAST_RESORT_REQUIRED });
      // ...and one with a new one replaces the dead weight.
      const accepted = await bob.post('/key-packages', [
        endingIn('fresh', 30),
        endingIn('fresh-last', 30, true),
      ]);
      expectStatus(accepted, 201);
      expect(accepted.json()).toEqual({ uploaded: 2, available: 1 });
      expect(await countRows('SELECT count(*) AS n FROM key_packages', harness().db)).toBe(2);
    });

    it('serves the NEWEST package first: the one with the most life left', async () => {
      const bob = await harness().enrol('bob', 'bob-phone');
      const alice = await harness().enrol('alice', 'alice-phone');
      expectStatus(await bob.post('/key-packages', [ordinary('older'), lastResort('last')]), 201);
      harness().clock.advance(1000);
      expectStatus(await bob.post('/key-packages', [ordinary('newer')]), 201);
      // One upload shares one transaction timestamp; a second upload is strictly later.
      await harness().db.query(
        "UPDATE key_packages SET created_at = created_at - interval '1 minute' WHERE bytes = $1",
        [Buffer.from(packageBytes('older'), 'base64')],
      );

      const [first] = await claim(harness(), alice, 'bob');
      expect(first?.bytes).toBe(packageBytes('newer'));
    });
  });

  describe('a bounded pool (review round 1, 2026-10-10)', () => {
    it(`holds at most ${MAX_UNCLAIMED_KEY_PACKAGES_PER_DEVICE} unclaimed packages per device (409 KEY_PACKAGE_POOL_FULL, nothing stored)`, async () => {
      const bob = await harness().enrol('bob', 'bob-phone');
      const uploads = Math.ceil(
        MAX_UNCLAIMED_KEY_PACKAGES_PER_DEVICE / MAX_KEY_PACKAGES_PER_UPLOAD,
      );
      let stored = 0;
      for (let upload = 0; upload < uploads; upload += 1) {
        const size = Math.min(
          MAX_KEY_PACKAGES_PER_UPLOAD,
          MAX_UNCLAIMED_KEY_PACKAGES_PER_DEVICE - stored,
        );
        const body = Array.from({ length: size }, (_, index) => ({
          bytes: packageBytes(`p-${upload}-${index}`),
          lastResort: upload === 0 && index === 0,
        }));
        expectStatus(await bob.post('/key-packages', body), 201);
        stored += size;
      }
      expect(stored).toBe(MAX_UNCLAIMED_KEY_PACKAGES_PER_DEVICE);

      const full = await bob.post('/key-packages', [ordinary('one-too-many')]);
      expectStatus(full, 409);
      expect(full.json()).toMatchObject({
        error: RelayErrorCode.KEY_PACKAGE_POOL_FULL,
        max: MAX_UNCLAIMED_KEY_PACKAGES_PER_DEVICE,
      });
      expect(await countRows('SELECT count(*) AS n FROM key_packages', harness().db)).toBe(stored);
    });

    it(`limits uploads to ${KEY_PACKAGE_UPLOAD_DEVICE_LIMIT} per device per window (429 UPLOAD_RATE_LIMITED, Retry-After)`, async () => {
      const bob = await harness().enrol('bob', 'bob-phone');
      expectStatus(await bob.post('/key-packages', [lastResort('last')]), 201);
      for (let upload = 1; upload < KEY_PACKAGE_UPLOAD_DEVICE_LIMIT; upload += 1) {
        expectStatus(await bob.post('/key-packages', [ordinary(`p-${upload}`)]), 201);
      }
      const limited = await bob.post('/key-packages', [ordinary('too-many')]);
      expectStatus(limited, 429);
      expect(limited.json()).toMatchObject({ error: RelayErrorCode.UPLOAD_RATE_LIMITED });
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);

      harness().clock.advance(KEY_PACKAGE_UPLOAD_WINDOW_MS);
      expectStatus(await bob.post('/key-packages', [ordinary('after-the-window')]), 201);
    });

    it(`limits uploads to ${KEY_PACKAGE_UPLOAD_USER_LIMIT} per user across all of their devices`, async () => {
      const devices: Caller[] = [];
      const needed =
        Math.ceil(KEY_PACKAGE_UPLOAD_USER_LIMIT / (KEY_PACKAGE_UPLOAD_DEVICE_LIMIT - 1)) + 1;
      for (let index = 0; index < needed; index += 1)
        devices.push(await harness().enrol('bob', `bob-device-${index}`));
      for (const device of devices)
        expectStatus(await device.post('/key-packages', [lastResort(device.deviceId)]), 201);

      let uploads = devices.length;
      let round = 0;
      while (uploads < KEY_PACKAGE_UPLOAD_USER_LIMIT) {
        const device = devices[round % devices.length] as Caller;
        expectStatus(await device.post('/key-packages', [ordinary(`p-${round}`)]), 201);
        uploads += 1;
        round += 1;
      }
      const limited = await devices[round % devices.length]?.post('/key-packages', [
        ordinary('too-many'),
      ]);
      expect(limited?.status).toBe(429);
      expect(limited?.json()).toMatchObject({ error: RelayErrorCode.UPLOAD_RATE_LIMITED });
    });
  });
});
