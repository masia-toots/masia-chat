import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  sign,
} from 'node:crypto';
import {
  type DeviceListEntry,
  DeviceRole,
  deviceListSigningBytes,
  RELAY_TOKEN_TTL_SECONDS,
} from '@masia/relay';
import { buildKeyPackage, buildPrivateMessage, MlsContentType } from '@masia/relay/testing';
import type { FastifyInstance } from 'fastify';
import { SignJWT } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, inject } from 'vitest';
import { createDatabase, type Database, type DatabaseTimeouts } from '../../db.js';
import { buildServer } from '../../server.js';
import { tokenKeyId, tokenKeyringOf } from '../../token-keys.js';
import { assertThrowawayDatabaseName, databaseNameOf } from './test-database.js';

/** A throwaway Ed25519 pair: the relay under test trusts the public half, tests sign with the private one. */
export function generateTestKeyPair(): {
  privateKey: KeyObject;
  publicKey: KeyObject;
  kid: string;
} {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKey, publicKey, kid: tokenKeyId(publicKey) };
}

/** The key the test relay trusts. Generated per test file, never a real one. */
export const TEST_KEY_PAIR = generateTestKeyPair();

/** The keyring of the test relay: just `TEST_KEY_PAIR`'s public key. */
export const TEST_TOKEN_KEYS = tokenKeyringOf([TEST_KEY_PAIR.publicKey]);
/**
 * The `iss`/`aud` the test relay is configured with. The open relay has no default pair (it is
 * deployment config, `TEST_TOKEN_EXPECTATIONS.issuer` / `TEST_TOKEN_EXPECTATIONS.audience`), so tests name their own.
 */
export const TEST_TOKEN_EXPECTATIONS = { issuer: 'test-host', audience: 'test-relay' } as const;
/** The verify options of a relay configured with `TEST_TOKEN_EXPECTATIONS`. */
export const TEST_VERIFY = { expect: TEST_TOKEN_EXPECTATIONS } as const;

/** Every table the relay owns. The reset empties exactly these, in one statement. */
const RELAY_TABLES = [
  'room_members',
  'envelopes',
  'mls_handshakes',
  'conversation_e2ee',
  'key_package_claims',
  'key_packages',
  'device_lists',
  'device_list_versions',
  'identity_keys',
  'devices',
] as const;

const MS_PER_SECOND = 1000;

/** A clock the tests move by hand; the limiters read it instead of the wall clock. */
export class TestClock {
  private current = Date.UTC(2026, 9, 10);

  readonly now = (): number => this.current;

  /** The clock in whole seconds, as an MLS lifetime counts. */
  readonly seconds = (): number => Math.floor(this.current / MS_PER_SECOND);

  advance(ms: number): void {
    this.current += ms;
  }
}

/** Opaque test bytes as the base64 text the API takes. At least 3 characters, so it is a valid field. */
export function b64(text: string): string {
  return Buffer.from(text).toString('base64');
}

/** The fixed start of a PKCS#8 Ed25519 private key; the 32-byte seed follows. */
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const ED25519_PUBLIC_KEY_LENGTH = 32;

const identityKeyPairs = new Map<string, { privateKey: KeyObject; publicKey: Buffer }>();

/**
 * The account identity key pair of `userId`: a REAL Ed25519 pair, derived from the id so it is the
 * same every time. The relay verifies every stored device list under the pinned key, so a test that
 * uploads a list signs it with this key (`signedList`).
 */
export function identityKeyPairOf(userId: string): { privateKey: KeyObject; publicKey: Buffer } {
  let pair = identityKeyPairs.get(userId);
  if (pair === undefined) {
    const seed = createHash('sha256').update(`identity:${userId}`).digest();
    const privateKey = createPrivateKey({
      key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
      format: 'der',
      type: 'pkcs8',
    });
    const spki = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
    pair = { privateKey, publicKey: spki.subarray(spki.length - ED25519_PUBLIC_KEY_LENGTH) };
    identityKeyPairs.set(userId, pair);
  }
  return pair;
}

/**
 * The same keys every time for the same device id, so a device list can name them. The identity key
 * is the PERSON's (one per user across their USER devices, canon §3), so it derives from `userId`
 * when given (a real Ed25519 key, `identityKeyPairOf`); the signature key is the device's own.
 */
export function keysOf(
  deviceId: string,
  userId: string = deviceId,
): { identityKeyPub: string; signatureKeyPub: string } {
  return {
    identityKeyPub: identityKeyPairOf(userId).publicKey.toString('base64'),
    signatureKeyPub: createHash('sha256').update(`signature:${deviceId}`).digest().toString('base64'),
  };
}

/** The entry a device has in its owner's signed list. `conversationId` is an ASSISTANT's alone. */
export function listEntry(
  deviceId: string,
  role: DeviceRole = DeviceRole.USER,
  conversationId?: string,
): DeviceListEntry {
  return {
    id: deviceId,
    role,
    signatureKey: keysOf(deviceId).signatureKeyPub,
    ...(conversationId === undefined ? {} : { conversationId }),
  };
}

/** Where the harness binds an ASSISTANT device it enrols, unless the test names a conversation. */
export function assistantRoomOf(deviceId: string): string {
  return `room-of-${deviceId}`;
}

/**
 * The body of an upload of version `version` of `userId`'s list, signed as the client would: by the
 * account's identity key over the canonical bytes. `signer` signs with ANOTHER account's key, the
 * shape of an attack (the bytes still name `userId`).
 */
export function signedList(
  userId: string,
  version: number,
  devices: readonly DeviceListEntry[],
  signer: string = userId,
): { version: number; devices: DeviceListEntry[]; signature: string } {
  const bytes = deviceListSigningBytes(userId, version, devices);
  const signature = sign(null, bytes, identityKeyPairOf(signer).privateKey).toString('base64');
  return { version, devices: [...devices], signature };
}

export interface TokenClaims {
  readonly sub?: string;
  readonly did?: string;
  readonly role?: string;
  /** `unknown` on purpose: a test may bend it (a string, numbers) to prove the verifier refuses it. */
  readonly adminOf?: unknown;
  readonly guardianOf?: unknown;
  readonly reach?: unknown;
}

/**
 * How a test token differs from a well-formed one. `null` leaves a thing out; leaving the option
 * unset gives the well-formed value, so each negative test bends exactly one thing.
 */
export interface TokenOptions {
  /** The signing key; default `TEST_KEY_PAIR`'s private key. */
  readonly key?: KeyObject;
  /** The `kid` header; default the key's own id, `null` for none. */
  readonly kid?: string | null;
  readonly issuer?: string | null;
  /** A list is the standard's other shape for `aud`, which the relay refuses. */
  readonly audience?: string | readonly string[] | null;
  /** Seconds from now to `exp`; default the contract's life, `null` for no `exp`. */
  readonly expiresInSeconds?: number | null;
  /** The `iat` as epoch seconds; default now, `null` for none. */
  readonly issuedAt?: number | null;
}

/** Signs an EdDSA token as the host would. Claims and options can be left out or bent, to test the verifier. */
export async function signTestToken(
  claims: TokenClaims,
  options: TokenOptions = {},
): Promise<string> {
  const { sub, ...payload } = claims;
  const key = options.key ?? TEST_KEY_PAIR.privateKey;
  const kid = options.kid === undefined ? TEST_KEY_PAIR.kid : options.kid;
  const now = Math.floor(Date.now() / 1000);
  const issuer = options.issuer === undefined ? TEST_TOKEN_EXPECTATIONS.issuer : options.issuer;
  const audience =
    options.audience === undefined ? TEST_TOKEN_EXPECTATIONS.audience : options.audience;

  let jwt = new SignJWT({ ...payload }).setProtectedHeader({
    alg: 'EdDSA',
    ...(kid === null ? {} : { kid }),
  });
  if (sub !== undefined) jwt = jwt.setSubject(sub);
  if (issuer !== null) jwt = jwt.setIssuer(issuer);
  if (audience !== null)
    jwt = jwt.setAudience(typeof audience === 'string' ? audience : [...audience]);
  if (options.issuedAt !== null) jwt = jwt.setIssuedAt(options.issuedAt ?? now);
  if (options.expiresInSeconds !== null) {
    jwt = jwt.setExpirationTime(now + (options.expiresInSeconds ?? RELAY_TOKEN_TTL_SECONDS));
  }
  return jwt.sign(key);
}

/**
 * A token of the retired scheme: HS256 under a shared secret, otherwise well-formed (right `iss`,
 * `aud`, `kid`). The relay must refuse it whatever the secret is, including a public key's bytes.
 */
export async function signHs256TestToken(claims: TokenClaims, secret: Uint8Array): Promise<string> {
  const { sub, ...payload } = claims;
  let jwt = new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256', kid: TEST_KEY_PAIR.kid })
    .setIssuer(TEST_TOKEN_EXPECTATIONS.issuer)
    .setAudience(TEST_TOKEN_EXPECTATIONS.audience)
    .setIssuedAt()
    .setExpirationTime(`${RELAY_TOKEN_TTL_SECONDS}s`);
  if (sub !== undefined) jwt = jwt.setSubject(sub);
  return jwt.sign(secret);
}

export interface Reply {
  readonly status: number;
  readonly headers: Readonly<Record<string, unknown>>;
  json<T = Record<string, unknown>>(): T;
}

/** One device's view of the API: a token and the two verbs. */
export interface Caller {
  /** The account the DEVICE belongs to (for a GUARDIAN device: the child it guards). */
  readonly userId: string;
  /** The account the TOKEN is for (`sub`): `userId`, except for a GUARDIAN device. */
  readonly tokenUserId: string;
  readonly deviceId: string;
  readonly role: DeviceRole;
  readonly token: string;
  get(url: string): Promise<Reply>;
  post(url: string, payload?: object): Promise<Reply>;
  del(url: string): Promise<Reply>;
}

export interface Harness {
  readonly app: FastifyInstance;
  readonly db: Database;
  readonly clock: TestClock;
  /** Empties every relay table (guarded: only a database named `*_test`). */
  reset(): Promise<void>;
  stop(): Promise<void>;
  /**
   * A token-holding caller for a device, registered or not. `adminOf` makes it a family admin of
   * exactly those users: it adds the FAMILY_ADMIN claim AND the `adminOf` list. `adminOf: []` is the
   * bare marker (an admin of nobody), which must grant nothing. `guardianOf` adds the claim and the
   * list of children the token may drive guardian devices for. `tokenUserId` is the token's `sub`
   * when it is not the device's owner (a guardian device of a child).
   */
  caller(
    who: { userId: string; deviceId: string; role?: DeviceRole; tokenUserId?: string },
    claims?: {
      adminOf?: readonly string[];
      guardianOf?: readonly string[];
      /** The host's introduction (`reach` claim): no admin marker. */
      reach?: readonly string[];
    },
  ): Promise<Caller>;
  /**
   * Registers the device AND adds it to its owner's signed device list. A GUARDIAN device belongs
   * to the CHILD `userId` and is driven by the adult `options.guardian` (default
   * `guardianOf(userId)`), whose token lists the child in `guardianOf`. An ASSISTANT device belongs to
   * the operator principal.
   */
  enrol(
    userId: string,
    deviceId: string,
    role?: DeviceRole,
    options?: EnrolOptions,
  ): Promise<Caller>;
  /**
   * The same device under a token whose `reach` claim names `targets`: the host's INTRODUCTION
   * (ADR-117 amendment (к), TODO-506). The contact gate (`lookupAccess`) lets a caller read or claim
   * a user it was introduced to, so tests whose subject is not the gate reach a stranger this way.
   * Its own user is left out of the list (the contract drops it anyway).
   */
  introduce(caller: Caller, ...targets: string[]): Promise<Caller>;
  /** Registers the device but leaves it OFF the signed list. */
  registerUnlisted(
    userId: string,
    deviceId: string,
    role?: DeviceRole,
    options?: EnrolOptions,
  ): Promise<Caller>;
  /** Opens the group of a conversation with `creator` as its first member. */
  createRoom(conversationId: string, creator: Caller): Promise<void>;
  roomEpoch(conversationId: string): Promise<number>;
  /**
   * A commit by `committer` that adds `members`, built on the room's current epoch. It first claims
   * a key package of each member as the committer, as a real client must (the relay refuses an Add
   * whose package its committer did not claim).
   */
  addToRoom(conversationId: string, committer: Caller, ...members: Caller[]): Promise<Reply>;
  /**
   * Claims a key package of each member as `committer` (giving a member that has none a last-resort
   * package first) and returns the Adds to put in a commit. A member the relay hands no package for
   * (revoked, unknown) gets `UNCLAIMED_KEY_PACKAGE_ID`, so the rule that refuses it answers.
   */
  claimFor(committer: Caller, ...members: Caller[]): Promise<AddedMember[]>;
}

export interface EnrolOptions {
  /** The adult who drives a GUARDIAN device of the child. */
  readonly guardian?: string;
  /** The conversation an ASSISTANT device serves (default `assistantRoomOf(deviceId)`). */
  readonly conversationId?: string;
}

/** The default adult behind a child's guardian device in tests that do not care who it is. */
export function guardianOf(childUserId: string): string {
  return `guardian-of-${childUserId}`;
}

/** The operator principal, the only account that may hold ASSISTANT devices. */
export const OPERATOR = 'test-operator';

export function expectStatus(reply: Reply, status: number): void {
  // The body in the failure message is what makes a red test debuggable.
  expect(reply.status, JSON.stringify(reply.json())).toBe(status);
}

/** The single number a `SELECT count(*) AS n …` returns. */
export async function countRows(sql: string, db: Database): Promise<number> {
  const { rows } = await db.query<{ n: string }>(sql);
  return Number(rows[0]?.n ?? 0);
}

/** A key package id nobody claimed: well-formed (the schema passes), so the claim rule answers. */
export const UNCLAIMED_KEY_PACKAGE_ID = '00000000-0000-4000-8000-00000000dead';

/** One device a commit declares it adds, with the key package that was claimed for it. */
export interface AddedMember {
  readonly member: Caller;
  readonly keyPackageId: string;
}

/** Adds that name a package nobody claimed: for tests of the rules that answer before (or instead of) the claim rule. */
export function unclaimed(...members: readonly Caller[]): AddedMember[] {
  return members.map((member) => ({ member, keyPackageId: UNCLAIMED_KEY_PACKAGE_ID }));
}

/** The MLS group id the harness gives a room: derived, so a test can build bytes for any room. */
export function groupIdOf(conversationId: string): Buffer {
  return Buffer.from(`group-${conversationId}`);
}

/** A PrivateMessage header for `room` at `epoch` with `contentType`, as the base64 text the API takes. */
export function privateMessageB64(
  room: string,
  epoch: number,
  contentType: number,
  ciphertext?: string,
): string {
  return buildPrivateMessage({
    groupId: groupIdOf(room),
    epoch,
    contentType,
    ...(ciphertext === undefined ? {} : { ciphertext: Buffer.from(ciphertext) }),
  }).toString('base64');
}

/** Application ciphertext a member may post to `room` at `epoch`: a PrivateMessage whose body is `text`. */
export function sealed(room: string, epoch: number, text: string): string {
  return privateMessageB64(room, epoch, MlsContentType.APPLICATION, text);
}

export interface CommitBodyOptions {
  readonly room: string;
  readonly expectedEpoch: number;
  readonly sender: Caller;
  readonly added?: readonly AddedMember[];
  readonly removed?: readonly Caller[];
  /** Makes the commit's bytes unique: two commits with different `content` are different commits. */
  readonly content?: string;
}

function declaredDelta(options: CommitBodyOptions) {
  return {
    added: (options.added ?? []).map(({ member, keyPackageId }) => ({
      deviceId: member.deviceId,
      userId: member.userId,
      role: member.role,
      keyPackageId,
    })),
    removed: (options.removed ?? []).map((member) => member.deviceId),
  };
}

/** A commit the relay accepts the shape of: a PrivateMessage header for the room and the epoch. */
export function commitBody(options: CommitBodyOptions) {
  return {
    expectedEpoch: options.expectedEpoch,
    senderDeviceId: options.sender.deviceId,
    bytes: privateMessageB64(
      options.room,
      options.expectedEpoch,
      MlsContentType.COMMIT,
      options.content,
    ),
    newTreeHash: b64('tree-hash'),
    memberDelta: declaredDelta(options),
  };
}

/** A real-looking KeyPackage, alive at `clock` (or with the lifetime the options give), as base64. */
export function keyPackageB64(
  clock: TestClock,
  options: Parameters<typeof buildKeyPackage>[0] = {},
): string {
  return buildKeyPackage({ nowSeconds: clock.seconds(), ...options }).toString('base64');
}

/** One upload item: a live package, last-resort or not. */
export function keyPackageItem(clock: TestClock, lastResort = false, seed?: string) {
  return { bytes: keyPackageB64(clock, { seed }), lastResort };
}

/** How long the packages the harness inserts directly stay alive. */
const KEY_PACKAGE_TEST_LIFETIME_MS = 90 * 24 * 60 * 60 * MS_PER_SECOND;

/** A database handle that is never queried: for suites that only build the app. */
export function unusedDatabase(): Database {
  return createDatabase('postgresql://nobody@127.0.0.1:1/unused', { onIdleError: () => undefined });
}

export interface HarnessOptions {
  /** Database timeouts for this harness (a suite about ROOM_BUSY shortens the lock timeout). */
  readonly timeouts?: Partial<DatabaseTimeouts>;
}

export async function startHarness(
  databaseUrl: string,
  options: HarnessOptions = {},
): Promise<Harness> {
  const db = createDatabase(databaseUrl, {
    onIdleError: (error) => {
      throw error;
    },
    timeouts: options.timeouts,
  });
  // The limiters (rebase limit, claim rate limit) keep their counts in the app's memory, so the app
  // and its clock are rebuilt for every test: one test's claims must not count against the next.
  let clock = new TestClock();
  async function buildApp(): Promise<FastifyInstance> {
    const built = await buildServer({
      database: db,
      tokenKeys: TEST_TOKEN_KEYS,
      tokenExpectations: TEST_TOKEN_EXPECTATIONS,
      operatorUserId: OPERATOR,
      now: clock.now,
    });
    await built.ready();
    return built;
  }
  let app = await buildApp();

  // What the harness has put on each user's signed list, so enrolling a second device re-sends the
  // whole list, as a real client would.
  const listed = new Map<string, DeviceListEntry[]>();
  const listVersions = new Map<string, number>();

  async function request(
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    token: string,
    payload?: object,
  ): Promise<Reply> {
    const response = await app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(payload === undefined ? {} : { payload }),
    });
    return {
      status: response.statusCode,
      headers: response.headers,
      json: <T>() => response.json<T>(),
    };
  }

  const harness: Harness = {
    get app() {
      return app;
    },
    db,
    get clock() {
      return clock;
    },

    async reset() {
      const { rows } = await db.query<{ name: string }>('SELECT current_database() AS name');
      assertThrowawayDatabaseName(rows[0]?.name ?? '');
      await db.query(`TRUNCATE TABLE ${RELAY_TABLES.join(', ')}`);
      listed.clear();
      listVersions.clear();
      await app.close();
      clock = new TestClock();
      app = await buildApp();
    },

    async stop() {
      await app.close();
      await db.close();
    },

    async caller(who, claims = {}) {
      const role = who.role ?? DeviceRole.USER;
      const tokenUserId = who.tokenUserId ?? who.userId;
      const isAdmin = claims.adminOf !== undefined || claims.guardianOf !== undefined;
      const token = await signTestToken({
        sub: tokenUserId,
        did: who.deviceId,
        ...(isAdmin ? { role: 'FAMILY_ADMIN' } : {}),
        ...(claims.adminOf === undefined ? {} : { adminOf: claims.adminOf }),
        ...(claims.guardianOf === undefined ? {} : { guardianOf: claims.guardianOf }),
        ...(claims.reach === undefined ? {} : { reach: claims.reach }),
      });
      return {
        userId: who.userId,
        tokenUserId,
        deviceId: who.deviceId,
        role,
        token,
        get: (url) => request('GET', url, token),
        post: (url, payload) => request('POST', url, token, payload),
        del: (url) => request('DELETE', url, token),
      };
    },

    async introduce(caller, ...targets) {
      const reach = targets.filter((target) => target !== caller.tokenUserId);
      if (reach.length === 0) return caller;
      return harness.caller(
        {
          userId: caller.userId,
          deviceId: caller.deviceId,
          role: caller.role,
          tokenUserId: caller.tokenUserId,
        },
        { reach },
      );
    },

    async registerUnlisted(userId, deviceId, role = DeviceRole.USER, options = {}) {
      // Each role has its own registrar (ADR-117 §3, §4): a GUARDIAN device is registered on the
      // CHILD's account by an adult whose token lists the child in `guardianOf`, and keeps that
      // token to act; an ASSISTANT device only by the operator principal.
      let device: Caller;
      if (role === DeviceRole.GUARDIAN) {
        device = await harness.caller(
          { userId, deviceId, role, tokenUserId: options.guardian ?? guardianOf(userId) },
          { guardianOf: [userId] },
        );
      } else {
        if (role === DeviceRole.ASSISTANT && userId !== OPERATOR) {
          throw new Error(`an ASSISTANT device belongs to ${OPERATOR}, not ${userId}`);
        }
        device = await harness.caller({ userId, deviceId, role });
      }
      const reply = await device.post('/devices', {
        id: deviceId,
        role,
        userId,
        name: deviceId,
        ...keysOf(deviceId, userId),
      });
      expectStatus(reply, 201);
      return device;
    },

    async enrol(userId, deviceId, role = DeviceRole.USER, options = {}) {
      const device = await harness.registerUnlisted(userId, deviceId, role, options);
      const entries = [
        ...(listed.get(userId) ?? []),
        listEntry(
          deviceId,
          role,
          role === DeviceRole.ASSISTANT
            ? (options.conversationId ?? assistantRoomOf(deviceId))
            : undefined,
        ),
      ];
      const version = (listVersions.get(userId) ?? 0) + 1;
      const body = signedList(userId, version, entries);
      if (device.tokenUserId === userId) {
        const reply = await device.post('/users/me/device-list', body);
        expectStatus(reply, 201);
      } else {
        // A guardian device's token is the ADULT's, so it cannot upload the child's list; the
        // child's own client would. Stored directly, as that upload would store it.
        await db.query(
          `INSERT INTO device_lists (user_id, version, devices_json, signature)
           VALUES ($1, $2, $3::jsonb, $4)
           ON CONFLICT (user_id) DO UPDATE
             SET version = EXCLUDED.version, devices_json = EXCLUDED.devices_json,
                 signature = EXCLUDED.signature, updated_at = now()`,
          [userId, version, JSON.stringify(entries), Buffer.from(body.signature, 'base64')],
        );
      }
      listed.set(userId, entries);
      listVersions.set(userId, version);
      return device;
    },

    async createRoom(conversationId, creator) {
      const reply = await creator.post(`/conversations/${conversationId}/e2ee`, {
        groupId: groupIdOf(conversationId).toString('base64'),
        treeHash: b64('tree-hash'),
      });
      expectStatus(reply, 201);
    },

    async roomEpoch(conversationId) {
      const { rows } = await db.query<{ epoch: number }>(
        'SELECT epoch FROM conversation_e2ee WHERE conversation_id = $1',
        [conversationId],
      );
      const epoch = rows[0]?.epoch;
      if (epoch === undefined) throw new Error(`no such room: ${conversationId}`);
      return epoch;
    },

    async claimFor(committer, ...members) {
      const added: AddedMember[] = [];
      for (const member of members) {
        // A package to claim. Inserted directly, and only for a device that exists: the upload route
        // needs the member's own token and a rate budget this helper should not spend.
        const keyPackage = buildKeyPackage({ nowSeconds: clock.seconds(), seed: member.deviceId });
        await db.query(
          `INSERT INTO key_packages (device_id, bytes, last_resort, not_after)
           SELECT $1, $2, true, $3
           WHERE EXISTS (SELECT 1 FROM devices WHERE id = $1)
             AND NOT EXISTS (SELECT 1 FROM key_packages WHERE device_id = $1)`,
          [member.deviceId, keyPackage, new Date(clock.now() + KEY_PACKAGE_TEST_LIFETIME_MS)],
        );
        // A first Add of a stranger needs an introduction (the contact gate answers 403 otherwise):
        // the claim goes out introduced, the commit under the committer's own token.
        const claimer = await harness.introduce(committer, member.userId);
        const reply = await claimer.post('/key-packages/claim', { userId: member.userId });
        if (reply.status === 429)
          throw new Error(`the harness ran out of claim budget: ${JSON.stringify(reply.json())}`);
        const rows =
          reply.status === 200
            ? reply.json<{ rows: Array<{ deviceId: string; keyPackageId: string }> }>().rows
            : [];
        const claimed = rows.find((row) => row.deviceId === member.deviceId);
        added.push({ member, keyPackageId: claimed?.keyPackageId ?? UNCLAIMED_KEY_PACKAGE_ID });
      }
      return added;
    },

    async addToRoom(conversationId, committer, ...members) {
      const added = await harness.claimFor(committer, ...members);
      return committer.post(
        `/conversations/${conversationId}/handshakes`,
        commitBody({
          room: conversationId,
          expectedEpoch: await harness.roomEpoch(conversationId),
          sender: committer,
          added,
        }),
      );
    },
  };
  return harness;
}

/**
 * A `describe` that runs against the real test database, or is skipped (with a warning printed by
 * the global setup) when Postgres is not reachable. Each test starts from empty tables.
 */
export function databaseSuite(
  name: string,
  define: (harness: () => Harness) => void,
  options: HarnessOptions = {},
): void {
  const { url } = inject('relayTestDatabase');
  if (url !== null) assertThrowawayDatabaseName(databaseNameOf(url));

  describe.skipIf(url === null)(name, () => {
    let started: Harness | undefined;

    beforeAll(async () => {
      started = await startHarness(url ?? '', options);
    });
    afterAll(async () => {
      await started?.stop();
    });
    beforeEach(async () => {
      await current().reset();
    });

    function current(): Harness {
      if (started === undefined) throw new Error('the harness is not started');
      return started;
    }
    define(current);
  });
}
