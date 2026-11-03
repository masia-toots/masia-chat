import {
  type ClientState,
  type RatchetTree,
  getCiphersuiteFromName,
  getCiphersuiteImpl,
} from 'ts-mls';
import { treeHashRoot } from 'ts-mls/treeHash.js';
import { describe, expect, it } from 'vitest';
import { MLS_CIPHER_SUITE_NAME } from '../constants.js';
import { identityOf } from '../credential.js';
import { MlsEngineErrorCode } from '../mls-error.js';
import { createTsMlsEngine, internalClientStateOf } from '../ts-mls-engine.js';
import {
  ListLookup,
  type ValidatedCommit,
  type ValidatorContext,
  assertCommitOutcome,
  leafAt,
  validatePathLeaf,
} from '../validator.js';
import { thrownBy } from './support/expect-code.js';
import { buildRoom, must } from './support/fixtures.js';
import { TestWorld } from './support/world.js';

/**
 * The outcome check (`assertCommitOutcome`) is the engine's answer to "the library applied LESS or
 * MORE than the commit said" (the shape of GHSA-gwp3-968w-m7gv). The library cannot be made to do
 * that on demand, so the check is tested directly: a real before and after from a real self-update,
 * and then doctored `after` states, each of which must be thrown away as LIBRARY_REJECTED.
 */

const MS = 1000;
const COMMITTER_DEVICE = 1;
const BYSTANDER_DEVICE = 2;
const FIRST_DEVICE = 0;
const PARENT_HASH_FLIP_MASK = 1;
/** Three devices: every parent node is on the committer's path. */
const SMALL_ROOM = 3;
/**
 * Four devices, each of which self-updated once: node 5 (above leaves 2 and 3) is a non-blank parent
 * node OFF the committing device 1's direct path (nodes 1 and 3), which the commit must leave alone.
 */
const ROOM_WITH_OFF_PATH_NODE = 4;
const OFF_PATH_PARENT_NODE = 5;
const OFF_PATH_LEAF = 3;

function flippedFirstByte(bytes: Uint8Array): Uint8Array {
  const out = Uint8Array.from(bytes);
  out[0] = (out[0] ?? 0) ^ PARENT_HASH_FLIP_MASK;
  return out;
}

async function scenario(size = SMALL_ROOM) {
  const world = await TestWorld.create(createTsMlsEngine);
  const { room, devices } = await buildRoom(world, size);
  const creator = must(devices[FIRST_DEVICE], 'first device');
  const committer = must(devices[COMMITTER_DEVICE], 'committing device');
  const bystander = must(devices[BYSTANDER_DEVICE], 'bystander device');

  const before = internalClientStateOf(room.state(creator));
  await room.selfUpdate(committer);
  const after = internalClientStateOf(room.state(creator));

  const cs = await getCiphersuiteImpl(getCiphersuiteFromName(MLS_CIPHER_SUITE_NAME));
  const ctx: ValidatorContext = {
    directory: world.directory,
    policy: world.policy,
    nowSeconds: () => Math.floor(world.nowMs / MS),
    cipherSuite: cs,
  };
  const committerLeafIndex = room.leafIndexOf(creator, committer);
  const bystanderLeafIndex = room.leafIndexOf(creator, bystander);
  const pathLeaf = must(leafAt(after.ratchetTree, committerLeafIndex), 'the committer leaf');
  const pathLeafFingerprint = await validatePathLeaf(
    ctx,
    new ListLookup(world.directory, {
      conversationId: 'conv-1',
      mode: 'live',
      pins: new Map(),
    }),
    pathLeaf,
    after.groupContext.groupId,
    committerLeafIndex,
    identityOf(pathLeaf),
  );
  const validated: ValidatedCommit = {
    committerLeafIndex,
    committer: identityOf(pathLeaf),
    adds: [],
    removes: [],
    pathLeafFingerprint,
    delta: { added: [], removed: [] },
  };

  /** `after` with its tree replaced and, unless told not to, the tree hash in the GroupContext made to match. */
  const withTree = async (tree: RatchetTree, matchTreeHash = true) => ({
    tree,
    groupContext: {
      ...after.groupContext,
      treeHash: matchTreeHash ? await treeHashRoot(tree, cs.hash) : after.groupContext.treeHash,
    },
  });
  const plain = (state: ClientState) => ({
    tree: state.ratchetTree,
    groupContext: state.groupContext,
  });

  return {
    ctx,
    before: plain(before),
    after: plain(after),
    validated,
    committerLeafIndex,
    bystanderLeafIndex,
    withTree,
    cs,
  };
}

/** The message of the LIBRARY_REJECTED the check must throw, so a test proves WHICH comparison fired. */
async function rejectionOf(action: () => Promise<void>): Promise<string> {
  const thrown = await thrownBy(action);
  if (thrown === undefined) expect.fail('expected LIBRARY_REJECTED, but nothing was thrown');
  const named = thrown as { name?: unknown; code?: unknown; message?: unknown };
  expect(named.name).toBe('MlsEngineError');
  expect(named.code, String(named.message)).toBe(MlsEngineErrorCode.LIBRARY_REJECTED);
  return String(named.message);
}

describe('assertCommitOutcome (RFC 9420 §7.9.2, §12.4.2; the GHSA shape: the library applied something else than was validated)', () => {
  it('accepts what a real self-update did', async () => {
    const { ctx, before, after, validated } = await scenario();
    await expect(assertCommitOutcome(ctx, before, after, validated)).resolves.toBeUndefined();
  });

  it('refuses a result that is not the next epoch of the same group', async () => {
    const { ctx, before, after, validated } = await scenario();
    const sameEpoch = {
      ...after,
      groupContext: { ...after.groupContext, epoch: before.groupContext.epoch },
    };
    expect(await rejectionOf(() => assertCommitOutcome(ctx, before, sameEpoch, validated))).toMatch(
      /epoch, group id or suite/,
    );
    const skipped = {
      ...after,
      groupContext: { ...after.groupContext, epoch: before.groupContext.epoch + 2n },
    };
    expect(await rejectionOf(() => assertCommitOutcome(ctx, before, skipped, validated))).toMatch(
      /epoch, group id or suite/,
    );
    const otherGroup = {
      ...after,
      groupContext: {
        ...after.groupContext,
        groupId: Uint8Array.from(after.groupContext.groupId, (b) => b ^ 1),
      },
    };
    expect(
      await rejectionOf(() => assertCommitOutcome(ctx, before, otherGroup, validated)),
    ).toMatch(/epoch, group id or suite/);
  });

  it('refuses a result in which the GroupContext extensions moved (the conversation binding)', async () => {
    const { ctx, before, after, validated } = await scenario();
    const stripped = { ...after, groupContext: { ...after.groupContext, extensions: [] } };
    expect(await rejectionOf(() => assertCommitOutcome(ctx, before, stripped, validated))).toMatch(
      /extensions changed/,
    );
  });

  it('refuses a result in which a leaf outside the commit changed', async () => {
    const { ctx, before, after, validated, bystanderLeafIndex, committerLeafIndex, withTree } =
      await scenario();
    const tree = after.tree.slice();
    // The bystander's leaf slot now holds somebody else's leaf: nothing in the commit touched it.
    tree[bystanderLeafIndex * 2] = after.tree[FIRST_DEVICE * 2];
    expect(bystanderLeafIndex).not.toBe(committerLeafIndex);
    const forged = await withTree(tree);
    expect(await rejectionOf(() => assertCommitOutcome(ctx, before, forged, validated))).toMatch(
      /changed without being part of the commit/,
    );
  });

  it('refuses a result in which the committer leaf is not the UpdatePath leaf that was validated', async () => {
    const { ctx, before, after, validated, committerLeafIndex, withTree } = await scenario();
    const tree = after.tree.slice();
    tree[committerLeafIndex * 2] = before.tree[committerLeafIndex * 2]; // the OLD leaf of the committer
    const forged = await withTree(tree);
    expect(await rejectionOf(() => assertCommitOutcome(ctx, before, forged, validated))).toMatch(
      /not the UpdatePath leaf/,
    );
  });

  it('refuses a result in which a validated Remove did not happen', async () => {
    const { ctx, before, after, validated, bystanderLeafIndex } = await scenario();
    const claimed: ValidatedCommit = {
      ...validated,
      removes: [{ leafIndex: bystanderLeafIndex, identity: validated.committer }],
    };
    expect(await rejectionOf(() => assertCommitOutcome(ctx, before, after, claimed))).toMatch(
      /removed leaf is still in the tree/,
    );
  });

  it('refuses a result in which a leaf appeared without an Add, or an Add did not land', async () => {
    const { ctx, before, after, validated, bystanderLeafIndex } = await scenario();
    // Before had no leaf where after has one: nothing in the validated commit adds it.
    const emptied = before.tree.slice();
    emptied[bystanderLeafIndex * 2] = undefined;
    expect(
      await rejectionOf(() =>
        assertCommitOutcome(ctx, { ...before, tree: emptied }, after, validated),
      ),
    ).toMatch(/appeared without an Add/);
    // An Add the validator accepted that is nowhere in the tree.
    const phantom: ValidatedCommit = {
      ...validated,
      adds: [{ identity: validated.committer, fingerprint: 'not-a-leaf-of-this-tree' }],
    };
    expect(await rejectionOf(() => assertCommitOutcome(ctx, before, after, phantom))).toMatch(
      /Add did not land/,
    );
  });

  it('refuses a tree hash that is not the hash of the tree', async () => {
    const { ctx, before, after, validated } = await scenario();
    const flipped = {
      ...after,
      groupContext: {
        ...after.groupContext,
        treeHash: Uint8Array.from(after.groupContext.treeHash, (b, i) => (i === 0 ? b ^ 1 : b)),
      },
    };
    expect(await rejectionOf(() => assertCommitOutcome(ctx, before, flipped, validated))).toMatch(
      /tree hash/,
    );
  });

  it('refuses a broken parent hash even when the tree hash has been made to match', async () => {
    const { ctx, before, after, validated, withTree } = await scenario();
    const tree = after.tree.slice();
    const at = tree.findIndex(
      (node) => node?.nodeType === 'parent' && node.parent.parentHash.length > 0,
    );
    const node = tree[at];
    if (node?.nodeType !== 'parent') throw new Error('the room has no parent hash to break');
    const parentHash = Uint8Array.from(node.parent.parentHash);
    parentHash[0] = (parentHash[0] ?? 0) ^ PARENT_HASH_FLIP_MASK;
    tree[at] = { nodeType: 'parent', parent: { ...node.parent, parentHash } };
    const forged = await withTree(tree);
    expect(await rejectionOf(() => assertCommitOutcome(ctx, before, forged, validated))).toMatch(
      /parent hash on the committer's path does not verify/,
    );
  });

  // The check is incremental (only the committer's chain is re-hashed), so everything it does NOT
  // re-hash must be proven unchanged. Each test below doctors one thing the chain walk never looks at.

  it("refuses a parent node off the committer's path that changed", async () => {
    const { ctx, before, after, validated, withTree } = await scenario(ROOM_WITH_OFF_PATH_NODE);
    const node = after.tree[OFF_PATH_PARENT_NODE];
    if (node?.nodeType !== 'parent') throw new Error('node 5 should be a non-blank parent node');
    const tree = after.tree.slice();
    tree[OFF_PATH_PARENT_NODE] = {
      nodeType: 'parent',
      parent: { ...node.parent, parentHash: flippedFirstByte(node.parent.parentHash) },
    };
    const forged = await withTree(tree);
    expect(await rejectionOf(() => assertCommitOutcome(ctx, before, forged, validated))).toMatch(
      /parent node 5, outside the committer's path, changed/,
    );
  });

  it("refuses a parent node off the committer's path that was blanked with no Remove below it", async () => {
    const { ctx, before, after, validated, withTree } = await scenario(ROOM_WITH_OFF_PATH_NODE);
    const tree = after.tree.slice();
    tree[OFF_PATH_PARENT_NODE] = undefined;
    const forged = await withTree(tree);
    expect(await rejectionOf(() => assertCommitOutcome(ctx, before, forged, validated))).toMatch(
      /parent node 5 was blanked/,
    );
  });

  it('refuses an untouched leaf whose parent hash changed (an unchanged chain above it relies on it)', async () => {
    const { ctx, before, after, validated, withTree } = await scenario(ROOM_WITH_OFF_PATH_NODE);
    const node = after.tree[OFF_PATH_LEAF * 2];
    if (node?.nodeType !== 'leaf' || node.leaf.leafNodeSource !== 'commit') {
      throw new Error('leaf 3 should be a commit-source leaf');
    }
    const tree = after.tree.slice();
    tree[OFF_PATH_LEAF * 2] = {
      nodeType: 'leaf',
      leaf: { ...node.leaf, parentHash: flippedFirstByte(node.leaf.parentHash) },
    };
    const forged = await withTree(tree);
    expect(await rejectionOf(() => assertCommitOutcome(ctx, before, forged, validated))).toMatch(
      /leaf 3 changed without being part of the commit/,
    );
  });

  it("accepts the real result in a room with a parent node off the committer's path", async () => {
    const { ctx, before, after, validated } = await scenario(ROOM_WITH_OFF_PATH_NODE);
    expect(after.tree[OFF_PATH_PARENT_NODE]?.nodeType).toBe('parent');
    await expect(assertCommitOutcome(ctx, before, after, validated)).resolves.toBeUndefined();
  });
});
