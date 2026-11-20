import {
  DeviceRole,
  IDENTITY_REQUEST_DAILY_LIMIT,
  IDENTITY_REQUEST_LIMIT_WINDOW_MS,
  IDENTITY_REQUEST_OPEN_LIMIT,
  IDENTITY_REQUEST_TTL_MS,
  type IdentityRequestDto,
  IdentityRequestPurpose,
  IdentityRequestState,
  RelayErrorCode,
  SEALED_IDENTITY_TTL_MS,
} from '@masia/relay';
import { describe, expect, it } from 'vitest';
import { HolderProofRefusal } from '../domain/devices.js';
import { IdentityRequestLimit, IdentityRequestRefusal } from '../domain/identity-requests.js';
import {
  b64,
  type Caller,
  countRows,
  databaseSuite,
  expectStatus,
  holderProofOf,
  identityRequestDraft,
  keysOf,
  testBytes,
} from './support/harness.js';

/**
 * ADR-218 §1, §2, §4, §5: the relay side of the identity transfer. A new device N asks, a holder
 * challenges, N reveals, the holder approves with the key sealed to N, and N alone reads it until its
 * holder proof deletes it. «Це не я» (or a wrong number) rejects the request and revokes N.
 */

const BASE = '/users/me/identity-requests';
const PROOF = '/devices/me/holder-proof';
const { PAIR, BACKFILL } = IdentityRequestPurpose;
const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;

/** The holder's nonce `r_B` (test bytes). */
const HOLDER_NONCE = testBytes('r_B').toString('base64');

/** What a holder posts to approve: a list version and an opaque sealed key (test bytes only). */
const APPROVAL = {
  listVersion: 3,
  sealed: {
    enc: testBytes('hpke-enc').toString('base64'),
    ciphertext: b64('a sealed identity key, opaque to the relay'),
  },
} as const;

interface Page {
  rows: IdentityRequestDto[];
  nextCursor: string | null;
}

databaseSuite('identity requests (ADR-218)', (harness) => {
  /** A listed device that posted its holder proof: it may challenge, approve and reject. */
  async function holder(userId: string, deviceId: string): Promise<Caller> {
    const device = await harness().enrol(userId, deviceId);
    const reply = await device.put(PROOF, { holderProof: holderProofOf(userId, deviceId) });
    expectStatus(reply, 200);
    return device;
  }

  /** N opens a pair request; returns its id and the nonce N reveals later. */
  async function ask(device: Caller, label?: string): Promise<{ id: string; nonce: string }> {
    const draft = await identityRequestDraft(device, PAIR, { label });
    const reply = await device.post(BASE, draft.body);
    expectStatus(reply, 201);
    return { id: reply.json<IdentityRequestDto>().id, nonce: draft.deviceNonce.toString('base64') };
  }

  async function read(device: Caller, id: string): Promise<IdentityRequestDto> {
    const reply = await device.get(`${BASE}/${id}`);
    expectStatus(reply, 200);
    return reply.json<IdentityRequestDto>();
  }

  /** Two holders (phone, tablet) and an unlisted laptop whose pair request the phone approved. */
  async function approvedPairing() {
    const phone = await holder('alice', 'alice-phone');
    const tablet = await holder('alice', 'alice-tablet');
    const laptop = await harness().registerUnlisted('alice', 'alice-laptop');
    const { id, nonce } = await ask(laptop);
    expectStatus(await phone.post(`${BASE}/${id}/challenge`, { nonce: HOLDER_NONCE }), 200);
    expectStatus(await laptop.post(`${BASE}/${id}/reveal`, { nonce }), 200);
    expectStatus(await phone.post(`${BASE}/${id}/approve`, APPROVAL), 200);
    return { phone, tablet, laptop, id };
  }

  async function isRevoked(deviceId: string): Promise<boolean> {
    const { rows } = await harness().db.query<{ revoked: boolean }>(
      'SELECT revoked_at IS NOT NULL AS revoked FROM devices WHERE id = $1',
      [deviceId],
    );
    return rows[0]?.revoked ?? false;
  }

  describe('POST /users/me/identity-requests', () => {
    it(`opens a pair request for an unlisted USER device: OPEN for ${IDENTITY_REQUEST_TTL_MS / MS_PER_MINUTE} minutes`, async () => {
      await holder('alice', 'alice-phone');
      const laptop = await harness().registerUnlisted('alice', 'alice-laptop');
      const { body } = await identityRequestDraft(laptop, PAIR);

      const reply = await laptop.post(BASE, body);
      expectStatus(reply, 201);
      const request = reply.json<IdentityRequestDto>();
      expect(request).toMatchObject({
        deviceId: 'alice-laptop',
        purpose: PAIR,
        state: IdentityRequestState.OPEN,
        transferKey: body.transferKey,
        commitment: body.commitment,
        signature: body.signature,
        challengerDeviceId: null,
        holderNonce: null,
        deviceNonce: null,
        listVersion: null,
        sealed: null,
      });
      expect(request.createdAt).toBe(new Date(harness().clock.now()).toISOString());
      expect(Date.parse(request.expiresAt) - Date.parse(request.createdAt)).toBe(
        IDENTITY_REQUEST_TTL_MS,
      );
    });

    it("refuses a request the device's registered key did not sign, or that changed after signing (422)", async () => {
      const laptop = await harness().registerUnlisted('alice', 'alice-laptop');
      const forged = await identityRequestDraft(laptop, PAIR, { signer: 'mallory-laptop' });
      const genuine = await identityRequestDraft(laptop, PAIR);
      const swapped = { ...genuine.body, transferKey: testBytes('another key').toString('base64') };

      for (const body of [forged.body, swapped]) {
        const reply = await laptop.post(BASE, body);
        expectStatus(reply, 422);
        expect(reply.json()).toMatchObject({
          error: RelayErrorCode.IDENTITY_REQUEST_SIGNATURE_INVALID,
        });
      }
      expect(await countRows('SELECT count(*) AS n FROM identity_requests', harness().db)).toBe(0);
    });

    it('refuses a malformed request (400): a pair without its commitment, a backfill with one, a short key', async () => {
      const laptop = await harness().registerUnlisted('alice', 'alice-laptop');
      const { body } = await identityRequestDraft(laptop, PAIR);
      const { commitment, ...withoutCommitment } = body;
      for (const malformed of [
        withoutCommitment,
        { ...body, purpose: BACKFILL, commitment },
        { ...body, transferKey: b64('too short for a key') },
      ]) {
        const reply = await laptop.post(BASE, malformed);
        expectStatus(reply, 400);
        expect(reply.json()).toMatchObject({ error: RelayErrorCode.VALIDATION_FAILED });
      }
    });

    it('takes pair from an unlisted device only, and backfill from a listed device that holds no key', async () => {
      const phone = await holder('alice', 'alice-phone');
      const tablet = await harness().enrol('alice', 'alice-tablet');
      const laptop = await harness().registerUnlisted('alice', 'alice-laptop');

      const listedPair = await tablet.post(BASE, (await identityRequestDraft(tablet, PAIR)).body);
      expectStatus(listedPair, 409);
      expect(listedPair.json()).toMatchObject({
        error: RelayErrorCode.IDENTITY_REQUEST_STATE,
        reason: IdentityRequestRefusal.LISTED,
      });

      const unlistedBackfill = await laptop.post(
        BASE,
        (await identityRequestDraft(laptop, BACKFILL)).body,
      );
      expectStatus(unlistedBackfill, 422);
      expect(unlistedBackfill.json()).toMatchObject({
        error: RelayErrorCode.DEVICE_NOT_IN_SIGNED_LIST,
      });

      const holderBackfill = await phone.post(
        BASE,
        (await identityRequestDraft(phone, BACKFILL)).body,
      );
      expectStatus(holderBackfill, 409);
      expect(holderBackfill.json()).toMatchObject({
        error: RelayErrorCode.IDENTITY_REQUEST_STATE,
        reason: IdentityRequestRefusal.HOLDER,
      });

      const backfill = await tablet.post(BASE, (await identityRequestDraft(tablet, BACKFILL)).body);
      expectStatus(backfill, 201);
      expect(backfill.json()).toMatchObject({
        purpose: BACKFILL,
        commitment: null,
        state: IdentityRequestState.OPEN,
      });
    });

    it("is for a person's own active USER devices: GUARDIAN is 403 ROLE_FORBIDDEN, revoked is 403", async () => {
      const guardian = await harness().enrol('kid', 'kid-guardian', DeviceRole.GUARDIAN);
      const byGuardian = await guardian.post(
        BASE,
        (await identityRequestDraft(guardian, PAIR)).body,
      );
      expectStatus(byGuardian, 403);
      expect(byGuardian.json()).toMatchObject({ error: RelayErrorCode.ROLE_FORBIDDEN });

      const phone = await holder('alice', 'alice-phone');
      const laptop = await harness().registerUnlisted('alice', 'alice-laptop');
      expectStatus(await phone.post('/devices/alice-laptop/revoke'), 200);
      const byRevoked = await laptop.post(BASE, (await identityRequestDraft(laptop, PAIR)).body);
      expectStatus(byRevoked, 403);
      expect(byRevoked.json()).toMatchObject({ error: RelayErrorCode.ACTOR_DEVICE_REVOKED });
    });

    it('refuses a device registered under a key no longer pinned (409 IDENTITY_KEY_CHANGED), and an account with no pin (409 IDENTITY_RESET_PENDING)', async () => {
      const laptop = await harness().registerUnlisted('alice', 'alice-laptop');
      const { body } = await identityRequestDraft(laptop, PAIR);
      const newPin = keysOf('any', 'alice-after-reset').identityKeyPub;
      await harness().db.query(
        'UPDATE identity_keys SET identity_key_pub = $2 WHERE user_id = $1',
        ['alice', Buffer.from(newPin, 'base64')],
      );
      const changed = await laptop.post(BASE, body);
      expectStatus(changed, 409);
      expect(changed.json()).toMatchObject({
        error: RelayErrorCode.IDENTITY_KEY_CHANGED,
        identityKeyPub: newPin,
      });

      await harness().db.query('DELETE FROM identity_keys WHERE user_id = $1', ['alice']);
      const pending = await laptop.post(BASE, body);
      expectStatus(pending, 409);
      expect(pending.json()).toMatchObject({ error: RelayErrorCode.IDENTITY_RESET_PENDING });
    });

    it(`caps the account at ${IDENTITY_REQUEST_OPEN_LIMIT} open requests (429 OPEN); a device's new request replaces its own`, async () => {
      const phone = await holder('alice', 'alice-phone');
      const devices: Caller[] = [];
      for (let index = 0; index <= IDENTITY_REQUEST_OPEN_LIMIT; index += 1) {
        devices.push(await harness().registerUnlisted('alice', `alice-new-${index}`));
      }
      const [first, ...others] = devices;
      const over = others.pop();
      if (first === undefined || over === undefined) throw new Error('no devices');
      const replaced = await ask(first);
      for (const device of others) await ask(device);

      const refused = await over.post(BASE, (await identityRequestDraft(over, PAIR)).body);
      expectStatus(refused, 429);
      expect(refused.json()).toMatchObject({
        error: RelayErrorCode.IDENTITY_REQUEST_LIMIT,
        limit: IdentityRequestLimit.OPEN,
        max: IDENTITY_REQUEST_OPEN_LIMIT,
      });
      expect(refused.headers['retry-after']).toBeUndefined();

      // One open request per device: asking again expires the old one instead of counting twice.
      const fresh = await ask(first, 'second');
      expect((await read(phone, replaced.id)).state).toBe(IdentityRequestState.EXPIRED);
      expect((await read(phone, fresh.id)).state).toBe(IdentityRequestState.OPEN);
    });

    it(`caps the account at ${IDENTITY_REQUEST_DAILY_LIMIT} requests a window, cancelled and replaced ones included (429 DAILY)`, async () => {
      const laptop = await harness().registerUnlisted('alice', 'alice-laptop');
      let last = '';
      for (let index = 0; index < IDENTITY_REQUEST_DAILY_LIMIT; index += 1) {
        last = (await ask(laptop, `try-${index}`)).id;
      }
      expect((await laptop.del(`${BASE}/${last}`)).status).toBe(204);

      const refused = await laptop.post(
        BASE,
        (await identityRequestDraft(laptop, PAIR, { label: 'one-too-many' })).body,
      );
      expectStatus(refused, 429);
      expect(refused.json()).toMatchObject({
        error: RelayErrorCode.IDENTITY_REQUEST_LIMIT,
        limit: IdentityRequestLimit.DAILY,
        max: IDENTITY_REQUEST_DAILY_LIMIT,
      });

      harness().clock.advance(IDENTITY_REQUEST_LIMIT_WINDOW_MS);
      await ask(laptop, 'the next day');
    });
  });

  describe('reading', () => {
    it("lists the account's requests to its USER devices, and is 404 to every other account", async () => {
      const phone = await holder('alice', 'alice-phone');
      const laptop = await harness().registerUnlisted('alice', 'alice-laptop');
      const { id } = await ask(laptop);

      const page = await phone.get(BASE);
      expectStatus(page, 200);
      expect(page.json<Page>()).toMatchObject({
        rows: [{ id, deviceId: 'alice-laptop', sealed: null }],
        nextCursor: null,
      });

      const bob = await holder('bob', 'bob-phone');
      expect((await bob.get(BASE)).json<Page>()).toEqual({ rows: [], nextCursor: null });
      for (const reply of [
        await bob.get(`${BASE}/${id}`),
        await bob.del(`${BASE}/${id}`),
        await bob.post(`${BASE}/${id}/challenge`, { nonce: HOLDER_NONCE }),
        await bob.post(`${BASE}/${id}/approve`, APPROVAL),
        await bob.post(`${BASE}/${id}/reject`),
      ]) {
        expectStatus(reply, 404);
        expect(reply.json()).toMatchObject({ error: RelayErrorCode.NOT_FOUND });
      }
      expect((await read(laptop, id)).state).toBe(IdentityRequestState.OPEN);
      expect(await isRevoked('alice-laptop')).toBe(false);
    });
  });

  describe('the number step', () => {
    it('lets one holder challenge once; a second challenge, by any holder, is 409', async () => {
      const phone = await holder('alice', 'alice-phone');
      const tablet = await holder('alice', 'alice-tablet');
      const laptop = await harness().registerUnlisted('alice', 'alice-laptop');
      const { id } = await ask(laptop);

      const challenged = await phone.post(`${BASE}/${id}/challenge`, { nonce: HOLDER_NONCE });
      expectStatus(challenged, 200);
      expect(challenged.json()).toMatchObject({
        state: IdentityRequestState.CHALLENGED,
        challengerDeviceId: 'alice-phone',
        holderNonce: HOLDER_NONCE,
      });

      for (const second of [tablet, phone]) {
        const again = await second.post(`${BASE}/${id}/challenge`, {
          nonce: testBytes('another r_B').toString('base64'),
        });
        expectStatus(again, 409);
        expect(again.json()).toMatchObject({
          error: RelayErrorCode.IDENTITY_REQUEST_STATE,
          state: IdentityRequestState.CHALLENGED,
        });
      }
      expect((await read(laptop, id)).holderNonce).toBe(HOLDER_NONCE);
    });

    it('lets only a holder challenge, approve or reject (403 NOT_A_HOLDER)', async () => {
      await holder('alice', 'alice-phone');
      // Listed, but holds no key: no proof.
      const tablet = await harness().enrol('alice', 'alice-tablet');
      // Listed, with a proof the pinned key did not make (planted past the PUT's own check).
      const watch = await harness().enrol('alice', 'alice-watch');
      await harness().db.query('UPDATE devices SET holder_proof = $2 WHERE id = $1', [
        'alice-watch',
        Buffer.from(holderProofOf('alice', 'alice-watch', 'mallory'), 'base64'),
      ]);
      // A valid proof, but not on the list: an unapproved device is never a holder.
      const ghost = await harness().registerUnlisted('alice', 'alice-ghost');
      await harness().db.query('UPDATE devices SET holder_proof = $2 WHERE id = $1', [
        'alice-ghost',
        Buffer.from(holderProofOf('alice', 'alice-ghost'), 'base64'),
      ]);
      const laptop = await harness().registerUnlisted('alice', 'alice-laptop');
      const { id } = await ask(laptop);

      for (const caller of [laptop, tablet, watch, ghost]) {
        for (const reply of [
          await caller.post(`${BASE}/${id}/challenge`, { nonce: HOLDER_NONCE }),
          await caller.post(`${BASE}/${id}/approve`, APPROVAL),
          await caller.post(`${BASE}/${id}/reject`),
        ]) {
          expectStatus(reply, 403);
          expect(reply.json()).toMatchObject({ error: RelayErrorCode.NOT_A_HOLDER });
        }
      }
      expect((await read(laptop, id)).state).toBe(IdentityRequestState.OPEN);
    });

    it('has no number step for a backfill (409 NO_NUMBER_STEP)', async () => {
      const phone = await holder('alice', 'alice-phone');
      const tablet = await harness().enrol('alice', 'alice-tablet');
      const asked = await tablet.post(BASE, (await identityRequestDraft(tablet, BACKFILL)).body);
      expectStatus(asked, 201);
      const reply = await phone.post(`${BASE}/${asked.json<IdentityRequestDto>().id}/challenge`, {
        nonce: HOLDER_NONCE,
      });
      expectStatus(reply, 409);
      expect(reply.json()).toMatchObject({
        error: RelayErrorCode.IDENTITY_REQUEST_STATE,
        reason: IdentityRequestRefusal.NO_NUMBER_STEP,
      });
    });

    it("checks N's reveal against its commitment: a wrong nonce is 422 and changes nothing", async () => {
      const phone = await holder('alice', 'alice-phone');
      const laptop = await harness().registerUnlisted('alice', 'alice-laptop');
      const { id, nonce } = await ask(laptop);

      const early = await laptop.post(`${BASE}/${id}/reveal`, { nonce });
      expectStatus(early, 409);
      expect(early.json()).toMatchObject({ state: IdentityRequestState.OPEN });
      expectStatus(await phone.post(`${BASE}/${id}/challenge`, { nonce: HOLDER_NONCE }), 200);

      const wrong = await laptop.post(`${BASE}/${id}/reveal`, {
        nonce: testBytes('not the committed nonce').toString('base64'),
      });
      expectStatus(wrong, 422);
      expect(wrong.json()).toMatchObject({
        error: RelayErrorCode.IDENTITY_REQUEST_SIGNATURE_INVALID,
      });
      expect(await read(laptop, id)).toMatchObject({
        state: IdentityRequestState.CHALLENGED,
        deviceNonce: null,
      });

      const notN = await phone.post(`${BASE}/${id}/reveal`, { nonce });
      expectStatus(notN, 403);
      expect(notN.json()).toMatchObject({ error: RelayErrorCode.DEVICE_MISMATCH });

      const revealed = await laptop.post(`${BASE}/${id}/reveal`, { nonce });
      expectStatus(revealed, 200);
      expect(revealed.json()).toMatchObject({
        state: IdentityRequestState.REVEALED,
        deviceNonce: nonce,
        holderNonce: HOLDER_NONCE,
      });
    });

    it(`expires a request ${IDENTITY_REQUEST_TTL_MS / MS_PER_MINUTE} minutes after creation, number step included`, async () => {
      const phone = await holder('alice', 'alice-phone');
      const laptop = await harness().registerUnlisted('alice', 'alice-laptop');
      const { id, nonce } = await ask(laptop);
      expectStatus(await phone.post(`${BASE}/${id}/challenge`, { nonce: HOLDER_NONCE }), 200);

      harness().clock.advance(IDENTITY_REQUEST_TTL_MS - 1);
      expect((await read(laptop, id)).state).toBe(IdentityRequestState.CHALLENGED);
      harness().clock.advance(1);
      expect((await read(laptop, id)).state).toBe(IdentityRequestState.EXPIRED);

      for (const reply of [
        await laptop.post(`${BASE}/${id}/reveal`, { nonce }),
        await phone.post(`${BASE}/${id}/reject`),
      ]) {
        expectStatus(reply, 409);
        expect(reply.json()).toMatchObject({
          error: RelayErrorCode.IDENTITY_REQUEST_STATE,
          state: IdentityRequestState.EXPIRED,
        });
      }
      expect((await laptop.del(`${BASE}/${id}`)).status).toBe(204); // a no-op
      expect(await isRevoked('alice-laptop')).toBe(false);
    });
  });

  describe('approval and the sealed key', () => {
    it('approves a pairing after the reveal, and only by the holder that challenged it', async () => {
      const phone = await holder('alice', 'alice-phone');
      const tablet = await holder('alice', 'alice-tablet');
      const laptop = await harness().registerUnlisted('alice', 'alice-laptop');
      const { id, nonce } = await ask(laptop);
      expectStatus(await phone.post(`${BASE}/${id}/challenge`, { nonce: HOLDER_NONCE }), 200);

      const early = await phone.post(`${BASE}/${id}/approve`, APPROVAL);
      expectStatus(early, 409);
      expect(early.json()).toMatchObject({ state: IdentityRequestState.CHALLENGED });
      expectStatus(await laptop.post(`${BASE}/${id}/reveal`, { nonce }), 200);

      const other = await tablet.post(`${BASE}/${id}/approve`, APPROVAL);
      expectStatus(other, 409);
      expect(other.json()).toMatchObject({
        error: RelayErrorCode.IDENTITY_REQUEST_STATE,
        reason: IdentityRequestRefusal.NOT_THE_CHALLENGER,
        challengerDeviceId: 'alice-phone',
      });

      const approved = await phone.post(`${BASE}/${id}/approve`, APPROVAL);
      expectStatus(approved, 200);
      expect(approved.json()).toMatchObject({
        state: IdentityRequestState.APPROVED,
        listVersion: APPROVAL.listVersion,
        sealed: null, // the holder is not N
      });
      const again = await phone.post(`${BASE}/${id}/approve`, APPROVAL);
      expectStatus(again, 409);
      expect(again.json()).toMatchObject({ state: IdentityRequestState.APPROVED });
      const cancelled = await laptop.del(`${BASE}/${id}`);
      expectStatus(cancelled, 409);
    });

    it('serves the sealed key to N alone, and deletes it when N posts its holder proof', async () => {
      const { phone, tablet, laptop, id } = await approvedPairing();

      expect((await read(laptop, id)).sealed).toEqual(APPROVAL.sealed);
      for (const other of [phone, tablet]) expect((await read(other, id)).sealed).toBeNull();
      expect((await phone.get(BASE)).json<Page>().rows.map((row) => row.sealed)).toEqual([null]);

      const proved = await laptop.put(PROOF, {
        holderProof: holderProofOf('alice', 'alice-laptop'),
      });
      expectStatus(proved, 200);
      expect(await read(laptop, id)).toMatchObject({
        state: IdentityRequestState.APPROVED,
        sealed: null,
      });
      expect(
        await countRows(
          'SELECT count(*) AS n FROM identity_requests WHERE sealed_enc IS NOT NULL OR sealed_ct IS NOT NULL',
          harness().db,
        ),
      ).toBe(0);
    });

    it(`stops serving the sealed key ${SEALED_IDENTITY_TTL_MS / MS_PER_HOUR} hours after approval`, async () => {
      const { laptop, id } = await approvedPairing();
      harness().clock.advance(SEALED_IDENTITY_TTL_MS - 1);
      expect((await read(laptop, id)).sealed).toEqual(APPROVAL.sealed);
      harness().clock.advance(1);
      expect((await read(laptop, id)).sealed).toBeNull();
    });

    it('lets any holder approve an open backfill, and never a revoked device (422 DEVICE_REVOKED)', async () => {
      const phone = await holder('alice', 'alice-phone');
      const tablet = await harness().enrol('alice', 'alice-tablet');
      const watch = await harness().enrol('alice', 'alice-watch');

      const asked = await tablet.post(BASE, (await identityRequestDraft(tablet, BACKFILL)).body);
      expectStatus(asked, 201);
      const tabletRequest = asked.json<IdentityRequestDto>().id;
      expectStatus(await phone.post(`${BASE}/${tabletRequest}/approve`, APPROVAL), 200);
      expect((await read(tablet, tabletRequest)).sealed).toEqual(APPROVAL.sealed);

      const watchAsked = await watch.post(BASE, (await identityRequestDraft(watch, BACKFILL)).body);
      expectStatus(watchAsked, 201);
      expectStatus(await phone.post('/devices/alice-watch/revoke'), 200);
      const refused = await phone.post(
        `${BASE}/${watchAsked.json<IdentityRequestDto>().id}/approve`,
        APPROVAL,
      );
      expectStatus(refused, 422);
      expect(refused.json()).toMatchObject({ error: RelayErrorCode.DEVICE_REVOKED });
    });
  });

  describe('rejection and cancelling', () => {
    it('«Це не я» rejects the request and revokes the device that asked, once', async () => {
      const phone = await holder('alice', 'alice-phone');
      const laptop = await harness().registerUnlisted('alice', 'alice-laptop');
      const { id } = await ask(laptop);
      expectStatus(await phone.post(`${BASE}/${id}/challenge`, { nonce: HOLDER_NONCE }), 200);

      const rejected = await phone.post(`${BASE}/${id}/reject`);
      expectStatus(rejected, 200);
      expect(rejected.json()).toMatchObject({ state: IdentityRequestState.REJECTED });
      expect(await isRevoked('alice-laptop')).toBe(true);
      const after = await laptop.get(`${BASE}/${id}`);
      expectStatus(after, 403);
      expect(after.json()).toMatchObject({ error: RelayErrorCode.ACTOR_DEVICE_REVOKED });

      const again = await phone.post(`${BASE}/${id}/reject`);
      expectStatus(again, 409);
      expect(again.json()).toMatchObject({ state: IdentityRequestState.REJECTED });
      expect((await read(phone, id)).state).toBe(IdentityRequestState.REJECTED);
    });

    it('rejects, but does not revoke, a device still in a room (its Remove comes first)', async () => {
      const phone = await holder('alice', 'alice-phone');
      const tablet = await harness().enrol('alice', 'alice-tablet');
      await harness().createRoom('room-1', phone);
      expectStatus(await harness().addToRoom('room-1', phone, tablet), 201);
      const asked = await tablet.post(BASE, (await identityRequestDraft(tablet, BACKFILL)).body);
      expectStatus(asked, 201);

      const rejected = await phone.post(`${BASE}/${asked.json<IdentityRequestDto>().id}/reject`);
      expectStatus(rejected, 200);
      expect(rejected.json()).toMatchObject({ state: IdentityRequestState.REJECTED });
      expect(await isRevoked('alice-tablet')).toBe(false);
    });

    it('lets N cancel its own request (204, EXPIRED) and nobody else (403 DEVICE_MISMATCH); nothing is revoked', async () => {
      const phone = await holder('alice', 'alice-phone');
      const laptop = await harness().registerUnlisted('alice', 'alice-laptop');
      const { id } = await ask(laptop);

      const notN = await phone.del(`${BASE}/${id}`);
      expectStatus(notN, 403);
      expect(notN.json()).toMatchObject({ error: RelayErrorCode.DEVICE_MISMATCH });
      expect((await laptop.del(`${BASE}/${id}`)).status).toBe(204);
      expect((await read(laptop, id)).state).toBe(IdentityRequestState.EXPIRED);
      expect(await isRevoked('alice-laptop')).toBe(false);
    });
  });

  describe('PUT /devices/me/holder-proof', () => {
    it('stores a proof that verifies under the pinned key and serves it in the FULL view only', async () => {
      const phone = await harness().enrol('alice', 'alice-phone');
      await harness().enrol('alice', 'alice-tablet');
      const proof = holderProofOf('alice', 'alice-phone');

      const reply = await phone.put(PROOF, { holderProof: proof });
      expectStatus(reply, 200);
      expect(reply.json()).toMatchObject({ id: 'alice-phone', holderProof: proof });

      const own = (await phone.get('/users/alice/devices')).json<{
        rows: Array<{ id: string; holderProof?: string | null }>;
      }>();
      expect(Object.fromEntries(own.rows.map((row) => [row.id, row.holderProof]))).toEqual({
        'alice-phone': proof,
        'alice-tablet': null,
      });

      const bob = await harness().introduce(await harness().enrol('bob', 'bob-phone'), 'alice');
      const strangers = (await bob.get('/users/alice/devices')).json<{
        rows: Array<Record<string, unknown>>;
      }>();
      expect(strangers.rows).toHaveLength(2);
      for (const row of strangers.rows) expect(row).not.toHaveProperty('holderProof');
    });

    it('refuses a proof the pinned key did not make, or one of another device (422 BAD_SIGNATURE)', async () => {
      const phone = await harness().enrol('alice', 'alice-phone');
      for (const holderProof of [
        holderProofOf('alice', 'alice-phone', 'mallory'),
        holderProofOf('alice', 'alice-tablet'),
        b64('short'),
      ]) {
        const reply = await phone.put(PROOF, { holderProof });
        expectStatus(reply, 422);
        expect(reply.json()).toMatchObject({
          error: RelayErrorCode.HOLDER_PROOF_INVALID,
          reason: HolderProofRefusal.BAD_SIGNATURE,
        });
      }
      expect(
        await countRows(
          'SELECT count(*) AS n FROM devices WHERE holder_proof IS NOT NULL',
          harness().db,
        ),
      ).toBe(0);
    });

    it('is for USER devices of the own account (403 ROLE_FORBIDDEN), and needs a pinned key (422 NO_PINNED_KEY)', async () => {
      const guardian = await harness().enrol('kid', 'kid-guardian', DeviceRole.GUARDIAN);
      const refused = await guardian.put(PROOF, {
        holderProof: holderProofOf('kid', 'kid-guardian'),
      });
      expectStatus(refused, 403);
      expect(refused.json()).toMatchObject({ error: RelayErrorCode.ROLE_FORBIDDEN });

      const phone = await harness().enrol('alice', 'alice-phone');
      await harness().db.query('DELETE FROM identity_keys WHERE user_id = $1', ['alice']);
      const unpinned = await phone.put(PROOF, {
        holderProof: holderProofOf('alice', 'alice-phone'),
      });
      expectStatus(unpinned, 422);
      expect(unpinned.json()).toMatchObject({
        error: RelayErrorCode.HOLDER_PROOF_INVALID,
        reason: HolderProofRefusal.NO_PINNED_KEY,
      });
    });

    it("ends the device's own open request: it holds the key now", async () => {
      await holder('alice', 'alice-phone');
      const tablet = await harness().enrol('alice', 'alice-tablet');
      const asked = await tablet.post(BASE, (await identityRequestDraft(tablet, BACKFILL)).body);
      expectStatus(asked, 201);
      expectStatus(
        await tablet.put(PROOF, { holderProof: holderProofOf('alice', 'alice-tablet') }),
        200,
      );
      expect((await read(tablet, asked.json<IdentityRequestDto>().id)).state).toBe(
        IdentityRequestState.EXPIRED,
      );
    });

    it("is dropped, with the account's requests, by a reset of the identity key", async () => {
      await holder('alice', 'alice-phone');
      const laptop = await harness().registerUnlisted('alice', 'alice-laptop');
      await ask(laptop);
      await harness().enrol('mum', 'mum-phone');
      const mum = await harness().caller(
        { userId: 'mum', deviceId: 'mum-phone' },
        { adminOf: ['alice'] },
      );
      expectStatus(await mum.post('/devices/alice-phone/revoke'), 200);
      expectStatus(await mum.post('/devices/alice-laptop/revoke'), 200);
      expect((await mum.del('/users/alice/identity-key')).status).toBe(204);

      const db = harness().db;
      expect(
        await countRows("SELECT count(*) AS n FROM identity_requests WHERE user_id = 'alice'", db),
      ).toBe(0);
      expect(
        await countRows(
          "SELECT count(*) AS n FROM devices WHERE user_id = 'alice' AND holder_proof IS NOT NULL",
          db,
        ),
      ).toBe(0);
    });
  });
});
