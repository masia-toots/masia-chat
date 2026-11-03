import type { RatchetTree } from 'ts-mls';
import { getCiphersuiteFromName, getCiphersuiteImpl } from 'ts-mls';
import { validateRatchetTree } from 'ts-mls/clientState.js';
import { describe, expect, it } from 'vitest';
import { MLS_CIPHER_SUITE_NAME } from '../constants.js';
import { createTsMlsEngine } from '../index.js';
import { internalClientStateOf } from '../ts-mls-engine.js';
import { Room } from './support/room.js';
import { TestWorld, type TestDevice } from './support/world.js';

/**
 * Finding F1 of the OpenMLS interop run (`interop/README.md`): ts-mls 1.6.4 refused to join a valid
 * ratchet tree, so in a room that has held five or more devices an Add could leave the newcomer
 * unable to join. The repo pins a patch of the library (`patches/ts-mls@1.6.4.patch`); this file is
 * the test that would have caught the defect, and it fails again if the patch is lost.
 *
 * RFC 9420 section 12.4.3.1 (joining from a Welcome), "Verify the integrity of the ratchet tree":
 *
 *   "For each non-empty parent node and each entry in the node's unmerged_leaves field:
 *      o Verify that the entry represents a non-blank leaf node that is a descendant of the parent
 *        node.
 *      o Verify that every non-blank intermediate node between the leaf node and the parent node
 *        also has an entry for the leaf node in its unmerged_leaves."
 *
 * The unpatched library checked every non-blank node on the WHOLE direct path of the leaf, above the
 * naming node too, and demanded the SAME list (array equality) instead of an entry for the leaf. A
 * node above the naming node that an UpdatePath from the other half of the tree has refreshed has an
 * empty list (RFC 9420 section 7.5), which is legal; the library then refused with "non-blank
 * intermediate node must list leaf node in its unmerged_leaves". The patch walks only the nodes
 * strictly between the leaf and the naming node, tests membership, and demands both halves of the
 * first bullet: the leaf is non-blank AND the naming node is on its direct path.
 *
 * Node indexes (array layout of RFC 9420 appendix C). A leaf with leaf index n sits at node 2n; an
 * UpdatePath sets only the FILTERED direct path, so a parent whose other child is empty stays blank:
 *
 *                       7                                   15 (root once there are 9+ leaves)
 *              3                 11
 *         1         5        9        13
 *       0   2     4   6    8   10   12   14    16   18 ...
 *       A   B     C   D    E   F    G    H     I    J      (leaf 0, 1, 2, ...)
 */

const UNMERGED_MESSAGE = 'non-blank intermediate node must list leaf node in its unmerged_leaves';
const DESCENDANT_MESSAGE = 'Unmerged leaf did not represent a non-blank descendant leaf node';
/** What a tampered tree that passes the unmerged-leaves check runs into next. */
const LATER_CHECK = /Unable to verify (parent|tree) hash/;

/** Leaf indexes (what `unmerged_leaves` holds). */
const LEAF_D = 3;
const LEAF_F = 5;
const LEAF_G = 6;
const LEAF_J = 9;
/** Node indexes (positions in the tree array). */
const NODE_A_TO_D = 3;
const NODE_C_D = 5;
const NODE_ROOT_OF_8 = 7;
const NODE_E_F = 9;
const NODE_E_TO_H = 11;
const NODE_ROOT_OF_16 = 15;

const NAMES = ['b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'] as const;
type Name = 'a' | (typeof NAMES)[number];
type Cast = Readonly<Record<Name, TestDevice>>;

async function cast(world: TestWorld): Promise<Cast> {
  const people: Partial<Record<Name, TestDevice>> = {};
  for (const name of ['a', ...NAMES] as const) {
    people[name] = await world.device(`user-${name}`, `${name}1`);
  }
  return people as Cast;
}

/**
 * K1 up to the Add that failed: A adds B and C (each posts its self-update), then D WITHOUT a
 * self-update (node 3 lists D), then E, whose self-update refreshes the new root 7 from the right
 * half: the root lists nothing while node 3 still lists D.
 */
async function buildK1(world: TestWorld, people: Cast): Promise<Room> {
  const room = await Room.create(world, people.a, 'conv-k1');
  await room.add(people.a, [people.b]);
  await room.add(people.a, [people.c]);
  await room.add(people.a, [people.d], { selfUpdate: false });
  await room.add(people.a, [people.e]);
  return room;
}

/**
 * K1, then F, G and H (with self-updates) and I, whose self-update refreshes the new root 15 of a
 * 16-leaf tree. D is still named by node 3 only, under TWO refreshed ancestors: node 7 (refreshed
 * by E, F, G, H) and node 15 (refreshed by I).
 */
async function buildTwoRefreshed(world: TestWorld, people: Cast): Promise<Room> {
  const room = await buildK1(world, people);
  for (const next of [people.f, people.g, people.h, people.i]) await room.add(people.a, [next]);
  return room;
}

describe('F1: a leaf unmerged under a refreshed ancestor still admits newcomers (RFC 9420 section 12.4.3.1)', () => {
  it('K1: A adds B, C, D (no self-update), E, then F; F joins from the Welcome and messages flow both ways', async () => {
    const world = await TestWorld.create(createTsMlsEngine);
    const people = await cast(world);
    const room = await buildK1(world, people);

    // This Add is what the unpatched library refused on F's side (joinFromWelcome).
    await room.add(people.a, [people.f], { selfUpdate: false });
    room.expectConverged();

    // `send` demands that every other member reads exactly the text, from the sender.
    await room.send(people.a, 'from A, read by F among others');
    await room.send(people.f, 'from F: A, B and E must read this');
    await room.send(people.b, 'from B');
    await room.send(people.e, 'from E');
    room.expectConverged();

    // F's own self-update afterwards is an ordinary commit everybody accepts.
    await room.selfUpdate(people.f);
    room.expectConverged();
    await room.send(people.f, 'from F after its self-update');
  });

  it('a leaf unmerged under TWO refreshed ancestors: J joins a 16-leaf tree and messages flow both ways', async () => {
    const world = await TestWorld.create(createTsMlsEngine);
    const people = await cast(world);
    const room = await buildTwoRefreshed(world, people);

    await room.add(people.a, [people.j], { selfUpdate: false });
    room.expectConverged();
    await room.send(people.a, 'from A');
    await room.send(people.j, 'from J: A, B, E and I must read this');
    await room.send(people.d, 'from D, still unmerged');
    room.expectConverged();

    await room.selfUpdate(people.j);
    room.expectConverged();
  });
});

// --- Library level: the shapes are the ones claimed, and the patched check still refuses what the RFC refuses ---

type ClientState = ReturnType<typeof internalClientStateOf>;

function unmergedAt(tree: RatchetTree, node: number): number[] | undefined {
  const entry = tree[node];
  return entry?.nodeType === 'parent' ? [...entry.parent.unmergedLeaves] : undefined;
}

/** A copy of `tree` in which parent node `node` lists exactly `leaves`. */
function withUnmerged(tree: RatchetTree, node: number, leaves: readonly number[]): RatchetTree {
  return tree.map((entry, index) => {
    if (index !== node) return entry;
    if (entry?.nodeType !== 'parent') throw new Error(`node ${String(index)} is not a parent`);
    return { ...entry, parent: { ...entry.parent, unmergedLeaves: [...leaves] } };
  });
}

async function validate(state: ClientState, tree: RatchetTree): Promise<string | undefined> {
  const cs = await getCiphersuiteImpl(getCiphersuiteFromName(MLS_CIPHER_SUITE_NAME));
  const error = await validateRatchetTree(
    tree,
    state.groupContext,
    state.clientConfig.lifetimeConfig,
    state.clientConfig.authService,
    state.groupContext.treeHash,
    cs,
  );
  return error?.message;
}

/** A's state right after the Add of F (no self-update) in K1: six leaves, D named by node 3, F by the root. */
async function k1State(): Promise<ClientState> {
  const world = await TestWorld.create(createTsMlsEngine);
  const people = await cast(world);
  const room = await buildK1(world, people);
  await room.add(people.a, [people.f], { selfUpdate: false });
  return internalClientStateOf(room.state(people.a));
}

describe('the patched ts-mls validateRatchetTree (library level)', () => {
  it('the K1 tree has the shape RFC 9420 allows and the unpatched library refused, and it validates', async () => {
    const state = await k1State();
    const tree = state.ratchetTree;
    expect(unmergedAt(tree, NODE_A_TO_D)).toEqual([LEAF_D]);
    expect(unmergedAt(tree, NODE_C_D)).toBeUndefined(); // blank: nothing between D and node 3
    expect(unmergedAt(tree, NODE_ROOT_OF_8)).toEqual([LEAF_F]); // refreshed by E, then F added
    expect(unmergedAt(tree, NODE_E_F)).toBeUndefined();
    expect(unmergedAt(tree, NODE_E_TO_H)).toBeUndefined();
    expect(await validate(state, tree)).toBeUndefined();
  });

  it('the two-refreshed-ancestors tree has its shape and validates', async () => {
    const world = await TestWorld.create(createTsMlsEngine);
    const people = await cast(world);
    const room = await buildTwoRefreshed(world, people);
    await room.add(people.a, [people.j], { selfUpdate: false });
    const state = internalClientStateOf(room.state(people.a));
    const tree = state.ratchetTree;
    expect(unmergedAt(tree, NODE_A_TO_D)).toEqual([LEAF_D]);
    expect(unmergedAt(tree, NODE_ROOT_OF_8)).toEqual([]);
    expect(unmergedAt(tree, NODE_ROOT_OF_16)).toEqual([LEAF_J]);
    expect(await validate(state, tree)).toBeUndefined();
  });

  it('membership, not equal lists: a naming node may list more leaves than a node between', async () => {
    const state = await k1State();
    // The root names D and F; node 3 (between D and the root) lists D only. The unmerged-leaves
    // check passes; the tampered tree then fails its hashes, which is the next check.
    const tree = withUnmerged(state.ratchetTree, NODE_ROOT_OF_8, [LEAF_D, LEAF_F]);
    const message = await validate(state, tree);
    expect(message).not.toBe(UNMERGED_MESSAGE);
    expect(message).toMatch(LATER_CHECK);
  });

  it('still refuses a non-blank node BETWEEN the leaf and the naming node that does not list the leaf', async () => {
    const state = await k1State();
    // The root names D; node 3 lies between D and the root and does not list D.
    let tree = withUnmerged(state.ratchetTree, NODE_ROOT_OF_8, [LEAF_D, LEAF_F]);
    tree = withUnmerged(tree, NODE_A_TO_D, []);
    expect(await validate(state, tree)).toBe(UNMERGED_MESSAGE);
  });

  it('refuses an entry for a leaf that is not a descendant of the naming node', async () => {
    const state = await k1State();
    // Node 3 covers A to D; F (leaf 5) is in the other half.
    const tree = withUnmerged(state.ratchetTree, NODE_A_TO_D, [LEAF_D, LEAF_F]);
    expect(await validate(state, tree)).toBe(DESCENDANT_MESSAGE);
  });

  it('refuses an entry for a blank leaf, even under the naming node', async () => {
    const state = await k1State();
    // Leaf 6 is blank (six members) and is a descendant of the root; nothing lies between them that
    // is non-blank, so only the "non-blank leaf" half of the first RFC bullet can refuse it.
    const tree = withUnmerged(state.ratchetTree, NODE_ROOT_OF_8, [LEAF_F, LEAF_G]);
    expect(await validate(state, tree)).toBe(DESCENDANT_MESSAGE);
  });
});
