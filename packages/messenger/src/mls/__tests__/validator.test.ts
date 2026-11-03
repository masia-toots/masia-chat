import {
  type Commit,
  type Extension,
  type GroupContext,
  type LeafNodeKeyPackage,
  type Proposal,
  type RatchetTree,
  decodeMlsMessage,
  getCiphersuiteFromName,
  getCiphersuiteImpl,
} from 'ts-mls';
import { treeHashRoot } from 'ts-mls/treeHash.js';
import { describe, expect, it } from 'vitest';
import {
  CONVERSATION_ID_EXTENSION_TYPE,
  KEY_PACKAGE_CLOCK_SKEW_SECONDS,
  KEY_PACKAGE_MAX_HORIZON_SECONDS,
  KEY_PACKAGE_MIN_REMAINING_SECONDS,
  MAX_ADDS_PER_COMMIT,
  MAX_GROUP_LEAVES,
  MAX_REMOVES_PER_COMMIT,
  MLS_CIPHER_SUITE_NAME,
} from '../constants.js';
import { DeviceRole, type DeviceIdentity, encodeCredentialIdentity } from '../credential.js';
import type { DeviceDirectory, MemberDelta } from '../mls-engine.js';
import { MlsEngineErrorCode } from '../mls-error.js';
import { createTsMlsEngine, internalClientStateOf } from '../ts-mls-engine.js';
import {
  ListLookup,
  type ValidatorContext,
  assertCommitShape,
  assertKeyPackageLifetime,
  assertMayAdd,
  assertPinnedGroupContext,
  assertSameOwner,
  conversationIdExtension,
  deviceKey,
  extensionsIdentical,
  keyServedRemovals,
  leafAt,
  mayRemoveGuardian,
  readConversationId,
  sameMemberDelta,
  treeLeaves,
  validateJoinedGroup,
  validateProposals,
} from '../validator.js';
import { expectCode } from './support/expect-code.js';
import { buildBulkRoom, buildRoom, must } from './support/fixtures.js';
import { TestWorld } from './support/world.js';

const MS = 1000;
const NOW = 1_800_000_000; // seconds; an arbitrary fixed "now"
const HOUR = 3600;
const DAY = 24 * HOUR;
const RETENTION_FLOOR_DAYS = 30;

/** Runs `validateJoinedGroup` with a fresh live lookup, as the engine does for a Welcome. */
const validateJoined = (
  ctx: ValidatorContext,
  joined: Parameters<typeof validateJoinedGroup>[1],
  conversationId: string,
) =>
  validateJoinedGroup(
    ctx,
    joined,
    conversationId,
    new ListLookup(ctx.directory, { conversationId, mode: 'live', pins: new Map() }),
  );

const identity = (
  userId: string,
  deviceId: string,
  role: DeviceRole = DeviceRole.USER,
): DeviceIdentity => ({
  userId,
  deviceId,
  role,
});

// --- assertKeyPackageLifetime ------------------------------------------------------------------------

describe('assertKeyPackageLifetime (review §1: notAfter within [now - 1h, now + 90d])', () => {
  const leaf = (notBefore: number, notAfter: number) =>
    ({
      lifetime: { notBefore: BigInt(notBefore), notAfter: BigInt(notAfter) },
    }) as unknown as LeafNodeKeyPackage;
  const accepted = (notBefore: number, notAfter: number) =>
    assertKeyPackageLifetime(leaf(notBefore, notAfter), NOW);
  const refused = (notBefore: number, notAfter: number) =>
    expectCode(() => accepted(notBefore, notAfter), MlsEngineErrorCode.LIFETIME_OUT_OF_RANGE);

  it('accepts a normal 30-day package, and the edges of the window', () => {
    accepted(NOW - HOUR, NOW + 30 * 24 * HOUR);
    accepted(NOW - 2 * HOUR, NOW - KEY_PACKAGE_CLOCK_SKEW_SECONDS); // expired exactly the skew ago
    accepted(NOW, NOW + KEY_PACKAGE_MAX_HORIZON_SECONDS); // valid for exactly the horizon
    accepted(NOW + KEY_PACKAGE_CLOCK_SKEW_SECONDS, NOW + HOUR * 2); // starts exactly the skew from now
  });

  it('refuses one second past each edge', async () => {
    await refused(NOW - 3 * HOUR, NOW - KEY_PACKAGE_CLOCK_SKEW_SECONDS - 1); // expired
    await refused(NOW, NOW + KEY_PACKAGE_MAX_HORIZON_SECONDS + 1); // valid for too long
    await refused(NOW + KEY_PACKAGE_CLOCK_SKEW_SECONDS + 1, NOW + 2 * HOUR); // not yet valid
  });

  it('refuses an inverted window', async () => {
    await refused(NOW + 10, NOW + 5);
  });

  it('as the SENDER, also demands the margin: the package must outlive our clock by a day', async () => {
    // So a receiver judging it against the relay's acceptance time never finds it expired, even when
    // our clock runs behind. The margin applies on send only; a receiver keeps the skew above.
    const send = (notAfter: number) =>
      assertKeyPackageLifetime(
        leaf(NOW - HOUR, notAfter),
        NOW,
        NOW,
        KEY_PACKAGE_MIN_REMAINING_SECONDS,
      );
    send(NOW + KEY_PACKAGE_MIN_REMAINING_SECONDS);
    await expectCode(
      () => send(NOW + KEY_PACKAGE_MIN_REMAINING_SECONDS - 1),
      MlsEngineErrorCode.LIFETIME_OUT_OF_RANGE,
    );
    accepted(NOW - HOUR, NOW + KEY_PACKAGE_MIN_REMAINING_SECONDS - 1);
  });
});

describe('assertKeyPackageLifetime with a receive floor (the backlog window)', () => {
  const leaf = (notBefore: number, notAfter: number) =>
    ({
      lifetime: { notBefore: BigInt(notBefore), notAfter: BigInt(notAfter) },
    }) as unknown as LeafNodeKeyPackage;
  const FLOOR = NOW - RETENTION_FLOOR_DAYS * DAY;

  it('judges notAfter against the floor, not against now', async () => {
    // A package that expired 20 days ago: dead by the full window, alive for a commit accepted 30 days ago.
    const stale = leaf(NOW - 50 * DAY, NOW - 20 * DAY);
    await expectCode(
      () => assertKeyPackageLifetime(stale, NOW),
      MlsEngineErrorCode.LIFETIME_OUT_OF_RANGE,
    );
    assertKeyPackageLifetime(stale, NOW, FLOOR);
  });

  it('still refuses a package that was dead before the floor, by one second past the skew', async () => {
    const edge = FLOOR - KEY_PACKAGE_CLOCK_SKEW_SECONDS;
    assertKeyPackageLifetime(leaf(edge - 30 * DAY, edge), NOW, FLOOR);
    await expectCode(
      () => assertKeyPackageLifetime(leaf(edge - 30 * DAY, edge - 1), NOW, FLOOR),
      MlsEngineErrorCode.LIFETIME_OUT_OF_RANGE,
    );
  });

  it('never lets a floor in the future relax or tighten the window beyond now', async () => {
    // A floor above `now` is clamped to `now`: the upper bounds and notBefore are still judged by now.
    const fresh = leaf(NOW - HOUR, NOW + DAY);
    assertKeyPackageLifetime(fresh, NOW, NOW + 10 * DAY);
    await expectCode(
      () => assertKeyPackageLifetime(leaf(NOW - 3 * HOUR, NOW - 2 * HOUR), NOW, NOW + 10 * DAY),
      MlsEngineErrorCode.LIFETIME_OUT_OF_RANGE,
    );
    // The horizon is judged by now whatever the floor says.
    await expectCode(
      () =>
        assertKeyPackageLifetime(leaf(NOW, NOW + KEY_PACKAGE_MAX_HORIZON_SECONDS + 1), NOW, FLOOR),
      MlsEngineErrorCode.LIFETIME_OUT_OF_RANGE,
    );
  });
});

// --- assertCommitShape -----------------------------------------------------------------------------------

describe('assertCommitShape (RFC 9420 §12.4 UpdatePath rule; GHSA-gwp3-968w-m7gv; probe F8b)', () => {
  const byValue = (proposalType: string | number, body: object = {}) => ({
    proposalOrRefType: 'proposal',
    proposal: { proposalType, ...body },
  });
  const commit = (proposals: object[], path: boolean): Commit =>
    ({ proposals, path: path ? {} : undefined }) as unknown as Commit;
  const add = () => byValue('add', { add: {} });
  const remove = () => byValue('remove', { remove: { removed: 1 } });

  it('needs a path when the proposal list is empty', async () => {
    await expectCode(() => assertCommitShape(commit([], false)), MlsEngineErrorCode.PATH_REQUIRED);
    expect(assertCommitShape(commit([], true))).toEqual([]);
  });

  it('needs no path for Adds alone', () => {
    expect(assertCommitShape(commit([add(), add()], false))).toHaveLength(2);
  });

  it('needs a path for Remove (GHSA), Update and GroupContextExtensions (F8b)', async () => {
    for (const proposal of [remove(), byValue('update'), byValue('group_context_extensions')]) {
      await expectCode(
        () => assertCommitShape(commit([add(), proposal], false)),
        MlsEngineErrorCode.PATH_REQUIRED,
      );
    }
    expect(assertCommitShape(commit([add(), remove()], true))).toHaveLength(2);
  });

  it('refuses ExternalInit before anything else, path or not', async () => {
    await expectCode(
      () => assertCommitShape(commit([byValue('external_init')], true)),
      MlsEngineErrorCode.EXTERNAL_SENDER_FORBIDDEN,
    );
    await expectCode(
      () => assertCommitShape(commit([byValue('external_init')], false)),
      MlsEngineErrorCode.EXTERNAL_SENDER_FORBIDDEN,
    );
  });

  it('refuses proposals other than Add and Remove, even with a path', async () => {
    for (const proposal of [
      byValue('update'),
      byValue('psk'),
      byValue('reinit'),
      byValue('group_context_extensions'),
      byValue(0xf001),
    ]) {
      await expectCode(
        () => assertCommitShape(commit([proposal], true)),
        MlsEngineErrorCode.PROPOSAL_NOT_ALLOWED,
      );
    }
  });

  it('refuses a proposal by reference, wherever it sits in the list', async () => {
    const reference = { proposalOrRefType: 'reference', reference: new Uint8Array(32) };
    await expectCode(
      () => assertCommitShape(commit([reference], true)),
      MlsEngineErrorCode.PROPOSAL_BY_REFERENCE_FORBIDDEN,
    );
    await expectCode(
      () => assertCommitShape(commit([add(), reference], false)),
      MlsEngineErrorCode.PROPOSAL_BY_REFERENCE_FORBIDDEN,
    );
  });

  it('bounds the number of proposals, in total before looking at them and then per kind', async () => {
    const times = (count: number, make: () => object) => Array.from({ length: count }, make);
    await expectCode(
      () =>
        assertCommitShape(
          commit(times(MAX_ADDS_PER_COMMIT + MAX_REMOVES_PER_COMMIT + 1, add), false),
        ),
      MlsEngineErrorCode.TOO_MANY_PROPOSALS,
    );
    await expectCode(
      () => assertCommitShape(commit(times(MAX_ADDS_PER_COMMIT + 1, add), false)),
      MlsEngineErrorCode.TOO_MANY_PROPOSALS,
    );
    await expectCode(
      () => assertCommitShape(commit(times(MAX_REMOVES_PER_COMMIT + 1, remove), true)),
      MlsEngineErrorCode.TOO_MANY_PROPOSALS,
    );
    const atTheLimit = [
      ...times(MAX_ADDS_PER_COMMIT, add),
      ...times(MAX_REMOVES_PER_COMMIT, remove),
    ];
    expect(assertCommitShape(commit(atTheLimit, true))).toHaveLength(
      MAX_ADDS_PER_COMMIT + MAX_REMOVES_PER_COMMIT,
    );
  });
});

// --- sameMemberDelta -----------------------------------------------------------------------------------------

describe("sameMemberDelta (review §4: the relay's memberDelta is compared with the commit)", () => {
  const entry = (deviceId: string, userId = 'u', role: DeviceRole = DeviceRole.USER) => ({
    deviceId,
    userId,
    role,
  });
  const delta = (added: ReturnType<typeof entry>[], removed: string[] = []): MemberDelta => ({
    added,
    removed,
  });

  it('is order-insensitive and ignores extra fields on entries', () => {
    expect(
      sameMemberDelta(
        delta([entry('a'), entry('b')], ['x', 'y']),
        delta([entry('b'), entry('a')], ['y', 'x']),
      ),
    ).toBe(true);
    const withExtra = {
      added: [{ ...entry('a'), keyPackageId: 'kp' }],
      removed: [],
    } as unknown as MemberDelta;
    expect(sameMemberDelta(withExtra, delta([entry('a')]))).toBe(true);
  });

  it('tells every difference apart', () => {
    const base = delta([entry('a')], ['x']);
    expect(sameMemberDelta(base, delta([entry('b')], ['x']))).toBe(false);
    expect(sameMemberDelta(base, delta([entry('a', 'v')], ['x']))).toBe(false);
    expect(sameMemberDelta(base, delta([entry('a', 'u', DeviceRole.GUARDIAN)], ['x']))).toBe(false);
    expect(sameMemberDelta(base, delta([entry('a')], ['y']))).toBe(false);
    expect(sameMemberDelta(base, delta([entry('a'), entry('a')], ['x']))).toBe(false); // multiplicity counts
    expect(sameMemberDelta(base, delta([], ['x']))).toBe(false);
    expect(sameMemberDelta(base, delta([entry('a')], []))).toBe(false);
  });

  it('treats any wrong shape as a mismatch, never as an exception', () => {
    const good = delta([entry('a')], ['x']);
    const garbage: unknown[] = [
      null,
      undefined,
      {},
      [],
      'text',
      { added: 'a', removed: [] },
      { added: [], removed: 'x' },
      { added: [null], removed: [] },
      { added: [{ deviceId: 1, userId: 'u', role: 'USER' }], removed: [] },
      { added: [], removed: [1] },
    ];
    for (const shape of garbage) {
      expect(sameMemberDelta(shape as MemberDelta, good)).toBe(false);
      expect(sameMemberDelta(good, shape as MemberDelta)).toBe(false);
    }
    // Two garbage values are not "the same" either.
    expect(sameMemberDelta(null as unknown as MemberDelta, null as unknown as MemberDelta)).toBe(
      false,
    );
  });
});

// --- Extensions and the GroupContext -----------------------------------------------------------------------------

describe('GroupContext extensions (review §4: the conversation id is bound into the key schedule)', () => {
  const ext = (extensionType: number, text: string): Extension => ({
    extensionType,
    extensionData: new TextEncoder().encode(text),
  });

  it('reads exactly one conversation id extension', () => {
    expect(readConversationId([conversationIdExtension('conv-1')])).toBe('conv-1');
    expect(conversationIdExtension('conv-1').extensionType).toBe(CONVERSATION_ID_EXTENSION_TYPE);
  });

  it('refuses none, two, another type, and an id outside the alphabet', async () => {
    await expectCode(() => readConversationId([]), MlsEngineErrorCode.UNSUPPORTED_EXTENSION);
    await expectCode(
      () => readConversationId([conversationIdExtension('a'), conversationIdExtension('a')]),
      MlsEngineErrorCode.UNSUPPORTED_EXTENSION,
    );
    await expectCode(
      () => readConversationId([ext(0xf0c2, 'conv-1')]),
      MlsEngineErrorCode.UNSUPPORTED_EXTENSION,
    );
    // A peer can put any bytes in the extension; we can only refuse to build one with a bad id.
    for (const bad of ['has space', '', 'x'.repeat(129)]) {
      await expectCode(
        () => readConversationId([ext(CONVERSATION_ID_EXTENSION_TYPE, bad)]),
        MlsEngineErrorCode.CONVERSATION_MISMATCH,
      );
      await expectCode(() => conversationIdExtension(bad), MlsEngineErrorCode.INVALID_ARGUMENT);
    }
    const invalidUtf8: Extension = {
      extensionType: CONVERSATION_ID_EXTENSION_TYPE,
      extensionData: Uint8Array.of(0xff, 0xfe),
    };
    await expectCode(
      () => readConversationId([invalidUtf8]),
      MlsEngineErrorCode.CONVERSATION_MISMATCH,
    );
  });

  it('compares extension lists by type and bytes, in order', () => {
    const a = [ext(1, 'x'), ext(2, 'y')];
    expect(extensionsIdentical(a, [ext(1, 'x'), ext(2, 'y')])).toBe(true);
    expect(extensionsIdentical(a, [ext(2, 'y'), ext(1, 'x')])).toBe(false);
    expect(extensionsIdentical(a, [ext(1, 'x')])).toBe(false);
    expect(extensionsIdentical(a, [ext(1, 'x'), ext(2, 'z')])).toBe(false);
    expect(extensionsIdentical([], [])).toBe(true);
  });

  it('pins cipher suite and protocol version', async () => {
    const good = {
      cipherSuite: MLS_CIPHER_SUITE_NAME,
      version: 'mls10',
    } as unknown as GroupContext;
    assertPinnedGroupContext(good);
    await expectCode(
      () =>
        assertPinnedGroupContext({
          ...good,
          cipherSuite: 'MLS_256_DHKEMX448_AES256GCM_SHA512_Ed448',
        } as unknown as GroupContext),
      MlsEngineErrorCode.SUITE_NOT_PINNED,
    );
    await expectCode(
      () => assertPinnedGroupContext({ ...good, version: 'mls11' } as unknown as GroupContext),
      MlsEngineErrorCode.SUITE_NOT_PINNED,
    );
  });
});

// --- assertSameOwner ----------------------------------------------------------------------------------------------------

describe('assertSameOwner (review §1: the role cannot change; internal ADR-117 §4)', () => {
  const me = { userId: 'kid', deviceId: 'g1', role: DeviceRole.GUARDIAN };

  it('accepts the same identity', () => {
    assertSameOwner(me, { ...me });
  });

  it('names the role change precisely', async () => {
    for (const role of [DeviceRole.USER, DeviceRole.ASSISTANT]) {
      await expectCode(() => assertSameOwner(me, { ...me, role }), MlsEngineErrorCode.ROLE_CHANGED);
    }
    await expectCode(
      () => assertSameOwner({ ...me, role: DeviceRole.USER }, me),
      MlsEngineErrorCode.ROLE_CHANGED,
    );
  });

  it('names a change of owner before a change of role', async () => {
    await expectCode(
      () => assertSameOwner(me, { ...me, deviceId: 'g2' }),
      MlsEngineErrorCode.IDENTITY_CHANGED,
    );
    await expectCode(
      () => assertSameOwner(me, { ...me, userId: 'mom' }),
      MlsEngineErrorCode.IDENTITY_CHANGED,
    );
    await expectCode(
      () => assertSameOwner(me, { userId: 'mom', deviceId: 'g1', role: DeviceRole.USER }),
      MlsEngineErrorCode.IDENTITY_CHANGED,
    );
  });
});

// --- Small tree and directory helpers -------------------------------------------------------------------------------------

describe('tree and directory helpers', () => {
  it('lists the leaves at even node indexes and finds them by leaf index', async () => {
    const world = await TestWorld.create(createTsMlsEngine);
    const { room, devices } = await buildRoom(world, 3);
    const tree = internalClientStateOf(room.state(must(devices[0], 'alice'))).ratchetTree;
    const leaves = treeLeaves(tree);
    expect(leaves.map((l) => l.leafIndex)).toEqual([0, 1, 2]);
    expect(leafAt(tree, 1)).toBe(leaves[1]?.leaf);
    expect(leafAt(tree, 7)).toBeUndefined();
  });

  it('keys a device by user and device id', () => {
    expect(deviceKey({ userId: 'a', deviceId: 'b' })).not.toBe(
      deviceKey({ userId: 'b', deviceId: 'a' }),
    );
    expect(deviceKey({ userId: 'a', deviceId: 'b' })).toBe(
      deviceKey({ userId: 'a', deviceId: 'b' }),
    );
    // No ambiguity from joining: ("a:b", "c") is not ("a", "b:c").
    expect(deviceKey({ userId: 'a-b', deviceId: 'c' })).not.toBe(
      deviceKey({ userId: 'a', deviceId: 'b-c' }),
    );
  });

  it('asks the directory once per user however often the list is looked up', async () => {
    let calls = 0;
    const world = await TestWorld.create(createTsMlsEngine);
    const directory: DeviceDirectory = {
      ...world.directory,
      deviceListOf: (userId) => {
        calls += 1;
        return Promise.resolve({ userId, version: 1, devices: [] });
      },
    };
    const lookup = new ListLookup(directory, {
      conversationId: 'conv-1',
      mode: 'live',
      pins: new Map(),
    });
    await Promise.all([lookup.get('a'), lookup.get('a'), lookup.get('b')]);
    await lookup.get('a');
    expect(calls).toBe(2);
  });
});

// --- ListLookup: live and backlog reading of the signed lists ---------------------------------------------

describe('ListLookup (live = current list, backlog = versions pinned per user)', () => {
  async function lookupFor(
    mode: 'live' | 'backlog',
    pins: [string, number][] = [],
    directory?: (world: TestWorld) => DeviceDirectory,
  ) {
    const world = await TestWorld.create(createTsMlsEngine);
    const dave = await world.device('dave', 'd1'); // dave's list is version 1
    const make = () =>
      new ListLookup(directory === undefined ? world.directory : directory(world), {
        conversationId: 'conv-1',
        mode,
        pins: new Map(pins),
      });
    const signatureKey = dave.keys.signingKey.publicKey;
    return { world, dave, make, signatureKey };
  }

  it('live: the current list decides, and the version it relied on is remembered', async () => {
    const { dave, make, signatureKey } = await lookupFor('live');
    const lookup = make();
    await expect(lookup.require(dave.keys.identity, signatureKey)).resolves.toBe(1);
    expect(lookup.seen.get('dave')).toBe(1);
  });

  it('live: a device taken off the list is refused, a wrong key is refused, a wrong role is refused', async () => {
    const { world, dave, make, signatureKey } = await lookupFor('live');
    await expectCode(
      () => make().require(dave.keys.identity, new Uint8Array(signatureKey.length)),
      MlsEngineErrorCode.LEAF_NOT_IN_SIGNED_LIST,
    );
    await expectCode(
      () => make().require({ ...dave.keys.identity, role: DeviceRole.GUARDIAN }, signatureKey),
      MlsEngineErrorCode.LEAF_NOT_IN_SIGNED_LIST,
    );
    world.unlist('dave', 'd1');
    await expectCode(
      () => make().require(dave.keys.identity, signatureKey),
      MlsEngineErrorCode.LEAF_NOT_IN_SIGNED_LIST,
    );
  });

  it('live: a list older than the pin proves nothing (rollback or a lagging directory)', async () => {
    const { dave, make, signatureKey } = await lookupFor('live', [['dave', 2]]);
    await expectCode(
      () => make().require(dave.keys.identity, signatureKey),
      MlsEngineErrorCode.LEAF_NOT_IN_SIGNED_LIST,
    );
  });

  it('backlog: a device revoked since is still accepted while a verified version at or above the pin lists it', async () => {
    const { world, dave, make, signatureKey } = await lookupFor('backlog', [['dave', 1]]);
    world.unlist('dave', 'd1'); // version 2: dave's d1 is revoked
    const lookup = make();
    await expect(lookup.require(dave.keys.identity, signatureKey)).resolves.toBe(1);
    expect(lookup.seen.get('dave')).toBe(1);
  });

  it('backlog: a device listed only BEFORE the pin is refused', async () => {
    const { world, dave, make, signatureKey } = await lookupFor('backlog', [['dave', 2]]);
    world.unlist('dave', 'd1'); // version 2
    world.device('dave', 'd2'); // version 3
    await expectCode(
      () => make().require(dave.keys.identity, signatureKey),
      MlsEngineErrorCode.LEAF_NOT_IN_SIGNED_LIST,
    );
  });

  it('refreshes once per user when a lookup misses, then looks again', async () => {
    const { world, make } = await lookupFor('live');
    const erin = await world.device('erin', 'e1');
    world.holdBack('erin');
    const e2 = await world.device('erin', 'e2'); // exists at the source, not yet verified by the directory
    const lookup = make();
    await expect(lookup.require(e2.keys.identity, e2.keys.signingKey.publicKey)).resolves.toBe(2);
    expect(world.refreshCalls).toEqual(['erin']);
    // A ghost: refreshed once, still refused, and a second ghost of the same user does not refresh again.
    const ghost = await world.device('erin', 'g1', DeviceRole.USER, { listed: false });
    await expectCode(
      () => lookup.require(ghost.keys.identity, ghost.keys.signingKey.publicKey),
      MlsEngineErrorCode.LEAF_NOT_IN_SIGNED_LIST,
    );
    await expectCode(
      () => lookup.require(ghost.keys.identity, erin.keys.signingKey.publicKey),
      MlsEngineErrorCode.LEAF_NOT_IN_SIGNED_LIST,
    );
    expect(world.refreshCalls).toEqual(['erin']);
  });

  it('a host without refresh gets the refusal; a refresh that throws makes the miss DIRECTORY_UNAVAILABLE', async () => {
    const { dave, make, signatureKey } = await lookupFor('live', [], (world) => ({
      deviceListOf: world.directory.deviceListOf,
      listedSince: world.directory.listedSince,
    }));
    await expectCode(
      () => make().require(dave.keys.identity, new Uint8Array(signatureKey.length)),
      MlsEngineErrorCode.LEAF_NOT_IN_SIGNED_LIST,
    );
    const throwing = await lookupFor('live', [], (world) => ({
      ...world.directory,
      refreshDeviceList: () => Promise.reject(new Error('relay unreachable')),
    }));
    // "I could not ask" is not "not listed": the newer list was never seen, so no verdict.
    await expectCode(
      () => throwing.make().require(throwing.dave.keys.identity, new Uint8Array(32)),
      MlsEngineErrorCode.DIRECTORY_UNAVAILABLE,
    );
  });

  it('a directory that throws or hangs is DIRECTORY_UNAVAILABLE, never a verdict on the device', async () => {
    const SHORT_TIMEOUT_MS = 20;
    const world = await TestWorld.create(createTsMlsEngine);
    const dave = await world.device('dave', 'd1');
    const key = dave.keys.signingKey.publicKey;
    const scope = {
      conversationId: 'conv-1',
      mode: 'live' as const,
      pins: new Map<string, number>(),
    };
    const hanging: DeviceDirectory = {
      ...world.directory,
      deviceListOf: () => new Promise(() => undefined),
    };
    await expectCode(
      () => new ListLookup(hanging, scope, SHORT_TIMEOUT_MS).require(dave.keys.identity, key),
      MlsEngineErrorCode.DIRECTORY_UNAVAILABLE,
    );
    const throwing: DeviceDirectory = {
      ...world.directory,
      deviceListOf: () => Promise.reject(new Error('storage offline')),
    };
    await expectCode(
      () => new ListLookup(throwing, scope).require(dave.keys.identity, key),
      MlsEngineErrorCode.DIRECTORY_UNAVAILABLE,
    );
    const backlog = { ...scope, mode: 'backlog' as const };
    const hangingSince: DeviceDirectory = {
      ...world.directory,
      listedSince: () => new Promise(() => undefined),
    };
    await expectCode(
      () =>
        new ListLookup(hangingSince, backlog, SHORT_TIMEOUT_MS).require(dave.keys.identity, key),
      MlsEngineErrorCode.DIRECTORY_UNAVAILABLE,
    );
    // The same directory answering in time is a normal lookup.
    await expect(
      new ListLookup(world.directory, scope, SHORT_TIMEOUT_MS).require(dave.keys.identity, key),
    ).resolves.toBeGreaterThan(0);
  });

  it('an ASSISTANT leaf is valid only when its entry names THIS conversation', async () => {
    const world = await TestWorld.create(createTsMlsEngine);
    const masia = await world.device('masia', 'm1', DeviceRole.ASSISTANT, {
      conversationId: 'conv-1',
    });
    const legacy = await world.device('masia', 'm2', DeviceRole.ASSISTANT); // listed without a conversation
    const lookup = (conversationId: string) =>
      new ListLookup(world.directory, { conversationId, mode: 'live', pins: new Map() });
    await expect(
      lookup('conv-1').require(masia.keys.identity, masia.keys.signingKey.publicKey),
    ).resolves.toBeGreaterThan(0);
    await expectCode(
      () => lookup('conv-2').require(masia.keys.identity, masia.keys.signingKey.publicKey),
      MlsEngineErrorCode.LEAF_NOT_IN_SIGNED_LIST,
    );
    await expectCode(
      () => lookup('conv-1').require(legacy.keys.identity, legacy.keys.signingKey.publicKey),
      MlsEngineErrorCode.LEAF_NOT_IN_SIGNED_LIST,
    );
  });
});

// --- keyServedRemovals (removals keyed by userId:deviceId) -----------------------------------------------------

describe('keyServedRemovals (the relay names devices; the commit removes userId:deviceId)', () => {
  const members = [identity('alice', 'a1'), identity('bob', 'b1'), identity('carol', 'shared')];
  const served = (removed: string[]): MemberDelta => ({ added: [], removed });

  it('resolves a served device id to the one member that has it', () => {
    const keyed = keyServedRemovals(served(['b1', 'shared']), members);
    expect([...keyed.removed].sort()).toEqual(['bob:b1', 'carol:shared']);
    expect(sameMemberDelta({ added: [], removed: ['bob:b1', 'carol:shared'] }, keyed)).toBe(true);
  });

  it('leaves an unknown or ambiguous id unmatched, however it is spelled', () => {
    const twins = [...members, identity('dave', 'shared')];
    const ambiguous = keyServedRemovals(served(['shared']), twins);
    expect(sameMemberDelta({ added: [], removed: ['carol:shared'] }, ambiguous)).toBe(false);
    expect(sameMemberDelta({ added: [], removed: ['dave:shared'] }, ambiguous)).toBe(false);
    // A lying relay that sends the keyed form itself, or an id nobody has, gets no match either.
    const forged = keyServedRemovals(served(['bob:b1', 'nobody']), members);
    expect(sameMemberDelta({ added: [], removed: ['bob:b1', 'nobody'] }, forged)).toBe(false);
  });

  it('passes garbage through for sameMemberDelta to refuse', () => {
    const garbage = null as unknown as MemberDelta;
    expect(keyServedRemovals(garbage, members)).toBe(garbage);
    const odd = { added: [], removed: [1] } as unknown as MemberDelta;
    expect(sameMemberDelta({ added: [], removed: ['1'] }, keyServedRemovals(odd, members))).toBe(
      false,
    );
  });
});

// --- Policy rules: guardian eviction and who may add Masia -------------------------------------------------

describe('mayRemoveGuardian (internal ADR-117 §4)', () => {
  async function policy() {
    const world = await TestWorld.create(createTsMlsEngine);
    world.makeAdmin('mom', 'kid');
    world.registerGuardianDevice('kid', 'g1', 'mom');
    world.registerGuardianDevice('kid', 'g2', 'mom');
    world.registerGuardianDevice('kid', 'gx', 'stranger'); // owned by someone who administers nobody
    return world.policy;
  }
  const target = identity('kid', 'g1', DeviceRole.GUARDIAN);

  it('an admin of the child may; so may a registered guardian device of that child owned by an admin', async () => {
    const p = await policy();
    expect(mayRemoveGuardian(p, identity('mom', 'm1'), target)).toBe(true);
    expect(mayRemoveGuardian(p, identity('kid', 'g2', DeviceRole.GUARDIAN), target)).toBe(true);
  });

  it('nobody else may: a friend, the child itself, an unregistered or wrongly owned guardian, another child', async () => {
    const p = await policy();
    expect(mayRemoveGuardian(p, identity('bob', 'b1'), target)).toBe(false);
    expect(mayRemoveGuardian(p, identity('kid', 'k1'), target)).toBe(false);
    expect(mayRemoveGuardian(p, identity('kid', 'g9', DeviceRole.GUARDIAN), target)).toBe(false);
    expect(mayRemoveGuardian(p, identity('kid', 'gx', DeviceRole.GUARDIAN), target)).toBe(false);
    expect(mayRemoveGuardian(p, identity('other-kid', 'g2', DeviceRole.GUARDIAN), target)).toBe(
      false,
    );
  });
});

describe('assertMayAdd (internal ADR-117 §3)', () => {
  async function policy() {
    const world = await TestWorld.create(createTsMlsEngine);
    world.makeMinor('kid');
    world.makeAdmin('mom', 'kid');
    return world.policy;
  }
  const masia = identity('masia', 'm1', DeviceRole.ASSISTANT);
  const kidRoom = [identity('kid', 'k1'), identity('bob', 'b1'), identity('mom', 'mom1')];

  it('refuses an ASSISTANT Add in a room with a minor unless the committer administers every minor', async () => {
    const p = await policy();
    const room = [...kidRoom, masia];
    assertMayAdd(p, identity('mom', 'mom1'), [masia], room);
    await expectCode(
      () => assertMayAdd(p, identity('kid', 'k1'), [masia], room),
      MlsEngineErrorCode.ASSISTANT_ADD_FORBIDDEN,
    );
    await expectCode(
      () => assertMayAdd(p, identity('bob', 'b1'), [masia], room),
      MlsEngineErrorCode.ASSISTANT_ADD_FORBIDDEN,
    );
  });

  it('a user with a GUARDIAN leaf counts as a minor even if the policy has not heard of them', async () => {
    const p = await policy();
    const room = [identity('lena', 'l1'), identity('lena', 'g1', DeviceRole.GUARDIAN), masia];
    await expectCode(
      () => assertMayAdd(p, identity('bob', 'b1'), [masia], room),
      MlsEngineErrorCode.ASSISTANT_ADD_FORBIDDEN,
    );
  });

  it('allows an ASSISTANT Add in a room without a minor, and any Add that is not Masia', async () => {
    const p = await policy();
    const adults = [identity('bob', 'b1'), identity('carol', 'c1'), masia];
    assertMayAdd(p, identity('bob', 'b1'), [masia], adults);
    assertMayAdd(
      p,
      identity('kid', 'k1'),
      [identity('dave', 'd1')],
      [...kidRoom, identity('dave', 'd1')],
    );
  });
});

// --- validateProposals: the size of a group ------------------------------------------------------------

describe('validateProposals: a group has at most MAX_GROUP_LEAVES devices', () => {
  /** A tree of `size` leaves cloned from a real one with distinct identities: enough for `validateProposals`, which reads credentials only. */
  async function fixture(size: number) {
    const world = await TestWorld.create(createTsMlsEngine);
    const { room, devices } = await buildRoom(world, 2);
    const client = internalClientStateOf(room.state(must(devices[0], 'creator')));
    const base = must(leafAt(client.ratchetTree, 0), 'leaf 0');
    const tree: RatchetTree = new Array(2 * size - 1).fill(undefined);
    for (let i = 0; i < size; i += 1) {
      const owner = identity(`user${i}`, `dev${i}`);
      tree[2 * i] = {
        nodeType: 'leaf',
        leaf: {
          ...base,
          credential: { credentialType: 'basic', identity: encodeCredentialIdentity(owner) },
        },
      };
    }
    const newcomer = await world.device('zed', 'z1');
    const bundle = await world.engine.createKeyPackage(newcomer.keys);
    const decoded = decodeMlsMessage(bundle.keyPackage, 0);
    if (decoded === undefined || decoded[0].wireformat !== 'mls_key_package') {
      throw new Error('not a KeyPackage');
    }
    const add: Proposal = { proposalType: 'add', add: { keyPackage: decoded[0].keyPackage } };
    const cs = await getCiphersuiteImpl(getCiphersuiteFromName(MLS_CIPHER_SUITE_NAME));
    const ctx: ValidatorContext = {
      directory: world.directory,
      policy: world.policy,
      nowSeconds: () => Math.floor(world.nowMs / MS),
      cipherSuite: cs,
    };
    const lists = new ListLookup(world.directory, {
      conversationId: 'conv-1',
      mode: 'live',
      pins: new Map(),
    });
    return { tree, add, ctx, lists, committer: identity('user0', 'dev0') };
  }

  it('takes the last device up to the limit', async () => {
    const { tree, add, ctx, lists, committer } = await fixture(MAX_GROUP_LEAVES - 1);
    const summary = await validateProposals(ctx, lists, tree, 0, committer, [add]);
    expect(summary.adds).toHaveLength(1);
  });

  it('refuses the device past the limit', async () => {
    const { tree, add, ctx, lists, committer } = await fixture(MAX_GROUP_LEAVES);
    await expectCode(
      () => validateProposals(ctx, lists, tree, 0, committer, [add]),
      MlsEngineErrorCode.GROUP_FULL,
    );
  });
});

// --- validateJoinedGroup: the independent re-check of a Welcome's tree (RFC 9420 §12.4.3.1) ------------------------------------

describe('validateJoinedGroup (RFC 9420 §12.4.3.1; review §1: the joiner re-verifies the tree itself)', () => {
  async function joined(size: number, bulk = false) {
    const world = await TestWorld.create(createTsMlsEngine);
    const { room, devices } = bulk
      ? await buildBulkRoom(world, size)
      : await buildRoom(world, size);
    const client = internalClientStateOf(room.state(must(devices[0], 'creator')));
    const cs = await getCiphersuiteImpl(getCiphersuiteFromName(MLS_CIPHER_SUITE_NAME));
    const ctx: ValidatorContext = {
      directory: world.directory,
      policy: world.policy,
      nowSeconds: () => Math.floor(world.nowMs / MS),
      cipherSuite: cs,
    };
    const expectedConversationId = bulk ? 'conv-big' : 'conv-1';
    /** The same group, its tree replaced, and (unless told not to) the tree hash in the GroupContext made to match. */
    const withTree = async (tree: RatchetTree, matchTreeHash = true) => ({
      tree,
      groupContext: {
        ...client.groupContext,
        treeHash: matchTreeHash ? await treeHashRoot(tree, cs.hash) : client.groupContext.treeHash,
      },
    });
    return { world, room, devices, client, ctx, expectedConversationId, withTree };
  }

  it('accepts a real group and returns its conversation id', async () => {
    const { client, ctx, expectedConversationId } = await joined(4);
    await expect(
      validateJoined(
        ctx,
        { tree: client.ratchetTree, groupContext: client.groupContext },
        expectedConversationId,
      ),
    ).resolves.toBe('conv-1');
  });

  it('refuses a Welcome for another conversation', async () => {
    const { client, ctx } = await joined(3);
    await expectCode(
      () =>
        validateJoined(
          ctx,
          { tree: client.ratchetTree, groupContext: client.groupContext },
          'conv-2',
        ),
      MlsEngineErrorCode.CONVERSATION_MISMATCH,
    );
  });

  it('refuses another suite, and a GroupContext with an extension of its own', async () => {
    const { client, ctx, expectedConversationId } = await joined(3);
    const other = {
      ...client.groupContext,
      cipherSuite: 'MLS_256_DHKEMX448_AES256GCM_SHA512_Ed448',
    } as unknown as GroupContext;
    await expectCode(
      () =>
        validateJoined(
          ctx,
          { tree: client.ratchetTree, groupContext: other },
          expectedConversationId,
        ),
      MlsEngineErrorCode.SUITE_NOT_PINNED,
    );
    const extended = {
      ...client.groupContext,
      extensions: [
        ...client.groupContext.extensions,
        { extensionType: 0xf0c2, extensionData: new Uint8Array() },
      ],
    };
    await expectCode(
      () =>
        validateJoined(
          ctx,
          { tree: client.ratchetTree, groupContext: extended },
          expectedConversationId,
        ),
      MlsEngineErrorCode.UNSUPPORTED_EXTENSION,
    );
  });

  it('refuses a tree wider than any real group, before looping over it', async () => {
    const { client, ctx, expectedConversationId } = await joined(3);
    const huge: RatchetTree = new Array(2 * MAX_GROUP_LEAVES + 1).fill(undefined);
    await expectCode(
      () =>
        validateJoined(
          ctx,
          { tree: huge, groupContext: client.groupContext },
          expectedConversationId,
        ),
      MlsEngineErrorCode.DECODE_TOO_LARGE,
    );
  });

  it('refuses a tree whose hash is not the one in the signed GroupContext', async () => {
    const { client, ctx, expectedConversationId, withTree } = await joined(4);
    const swapped = client.ratchetTree.slice();
    [swapped[2], swapped[4]] = [swapped[4], swapped[2]];
    const forged = await withTree(swapped, false);
    await expectCode(
      () => validateJoined(ctx, forged, expectedConversationId),
      MlsEngineErrorCode.WELCOME_TREE_MISMATCH,
    );

    const flipped = {
      ...client.groupContext,
      treeHash: Uint8Array.from(client.groupContext.treeHash, (b, i) => (i === 0 ? b ^ 1 : b)),
    };
    await expectCode(
      () =>
        validateJoined(
          ctx,
          { tree: client.ratchetTree, groupContext: flipped },
          expectedConversationId,
        ),
      MlsEngineErrorCode.WELCOME_TREE_MISMATCH,
    );
  });

  it('refuses a broken parent hash even when the tree hash has been made to match', async () => {
    const { client, ctx, expectedConversationId, withTree } = await joined(4);
    const tree = client.ratchetTree.slice();
    const at = tree.findIndex(
      (node) => node?.nodeType === 'parent' && node.parent.parentHash.length > 0,
    );
    const node = tree[at];
    if (node?.nodeType !== 'parent') throw new Error('the room has no parent hash to break');
    const parentHash = Uint8Array.from(node.parent.parentHash);
    parentHash[0] = (parentHash[0] ?? 0) ^ 1;
    tree[at] = { nodeType: 'parent', parent: { ...node.parent, parentHash } };

    // The control: with the old tree hash it is the hash that is wrong ...
    await expectCode(
      () =>
        validateJoined(ctx, { tree, groupContext: client.groupContext }, expectedConversationId),
      MlsEngineErrorCode.WELCOME_TREE_MISMATCH,
    );
    // ... and with a matching hash it is the parent hash chain, which only the independent check reads.
    const consistent = await withTree(tree);
    const error = await expectCodeAndMessage(() =>
      validateJoined(ctx, consistent, expectedConversationId),
    );
    expect(error).toMatch(/parent hash/);
  });

  it('refuses a leaf whose own signature does not verify, even when hashes are made to match', async () => {
    // Two devices: bob's leaf is the committer's leaf of his self-update (source 'commit'), under a single
    // parent node, so changing its signature does not touch any parent hash and the leaf rule is the one that fires.
    const { client, ctx, expectedConversationId, withTree } = await joined(2);
    const tree = client.ratchetTree.slice();
    const node = tree[2];
    if (node?.nodeType !== 'leaf' || node.leaf.leafNodeSource !== 'commit')
      throw new Error('expected the self-update leaf of the second device');
    const signature = Uint8Array.from(node.leaf.signature);
    signature[0] = (signature[0] ?? 0) ^ 1;
    tree[2] = { nodeType: 'leaf', leaf: { ...node.leaf, signature } };
    const consistent = await withTree(tree);
    const message = await expectCodeAndMessage(() =>
      validateJoined(ctx, consistent, expectedConversationId),
    );
    expect(message).toMatch(/signature of leaf 1/);
  });

  it('refuses a device that is on no signed list', async () => {
    const { world, client, ctx, expectedConversationId } = await joined(3);
    world.unlist('carol', 'c1');
    await expectCode(
      () =>
        validateJoined(
          ctx,
          { tree: client.ratchetTree, groupContext: client.groupContext },
          expectedConversationId,
        ),
      MlsEngineErrorCode.LEAF_NOT_IN_SIGNED_LIST,
    );
  });

  it('checks the leaves against the lists BEFORE it hashes the tree (no hashing for a tree full of ghosts)', async () => {
    const { world, client, ctx, expectedConversationId } = await joined(3);
    world.unlist('carol', 'c1');
    // The tree hash in the GroupContext is wrong as well: a check that hashed first would say so.
    const wrongHash = {
      ...client.groupContext,
      treeHash: Uint8Array.from(client.groupContext.treeHash, (b, i) => (i === 0 ? b ^ 1 : b)),
    };
    await expectCode(
      () =>
        validateJoined(
          ctx,
          { tree: client.ratchetTree, groupContext: wrongHash },
          expectedConversationId,
        ),
      MlsEngineErrorCode.LEAF_NOT_IN_SIGNED_LIST,
    );
  });

  it('reads a Welcome against the current lists only: a device listed in an older version is a ghost', async () => {
    const { world, client, ctx, expectedConversationId } = await joined(3);
    world.unlist('carol', 'c1'); // carol's c1 is in version 1, not in the current version 2
    const lookup = new ListLookup(world.directory, {
      conversationId: expectedConversationId,
      mode: 'live',
      pins: new Map(),
    });
    await expectCode(
      () =>
        validateJoinedGroup(
          ctx,
          { tree: client.ratchetTree, groupContext: client.groupContext },
          expectedConversationId,
          lookup,
        ),
      MlsEngineErrorCode.LEAF_NOT_IN_SIGNED_LIST,
    );
  });

  it('refuses one device in two leaves', async () => {
    const { client, ctx, expectedConversationId, withTree } = await joined(4, true);
    const tree = client.ratchetTree.slice();
    tree[4] = tree[2]; // key-package leaves carry no position, so a copy verifies; only the duplicate rule can see it
    const forged = await withTree(tree);
    await expectCode(
      () => validateJoined(ctx, forged, expectedConversationId),
      MlsEngineErrorCode.DUPLICATE_DEVICE,
    );
  });
});

/** Runs `action`, demands an `MlsEngineError`, and returns its message (for rules that share a code). */
async function expectCodeAndMessage(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
  } catch (error) {
    const named = error as { name?: string; code?: string; message?: string };
    expect(named.name).toBe('MlsEngineError');
    expect(named.code).toBe(MlsEngineErrorCode.WELCOME_TREE_MISMATCH);
    return named.message ?? '';
  }
  throw new Error('expected the action to throw');
}
