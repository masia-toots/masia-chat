import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  decodeMlsMessage,
  emptyPskIndex,
  getCiphersuiteFromName,
  getCiphersuiteImpl,
  processPrivateMessage,
} from 'ts-mls';
import { describe, expect, it } from 'vitest';
import { MLS_CIPHER_SUITE_NAME } from '../constants.js';
import { MlsEngineErrorCode } from '../mls-error.js';
import { createTsMlsEngine, internalClientStateOf } from '../ts-mls-engine.js';
import { expectCode } from './support/expect-code.js';
import { buildRoom, EMPTY_DELTA, pair, trio } from './support/fixtures.js';
import { createTsMlsAdversary } from './support/ts-mls-adversary.js';
import { TestWorld } from './support/world.js';

/**
 * LIBRARY CONTROLS: what the library itself does with the attacks of the attack contract, so that
 * "the engine's rule is what stopped it" is a fact and not an assumption. When a control flips (an
 * upstream fix lands), the matching engine rule becomes defense in depth: keep it, update canon.md.
 */

const SOURCE_DIR = join(import.meta.dirname, '..');
/** `import { a, b } from 'ts-mls'` and `from 'ts-mls/x.js'`: the names a source file takes from the library. */
const LIBRARY_IMPORT = /import\s*\{([^}]*)\}\s*from\s*'ts-mls[^']*'/g;

/** Entry points of the library that would let somebody join a group without being added (review §2). */
const FORBIDDEN_LIBRARY_ENTRY_POINTS = [
  'joinGroupExternal',
  'createGroupInfoWithExternalPub',
  'createGroupInfoWithExternalPubAndRatchetTree',
  'proposeAddExternal',
  'proposeExternal',
  'joinGroupFromReinit',
  'reinitGroup',
  'branchGroup',
] as const;

async function libraryAndEngine() {
  const world = await TestWorld.create(createTsMlsEngine);
  const cs = await getCiphersuiteImpl(getCiphersuiteFromName(MLS_CIPHER_SUITE_NAME));
  const adversary = await createTsMlsAdversary();
  return { world, cs, adversary };
}

function privateMessageOf(commit: Uint8Array) {
  const decoded = decodeMlsMessage(commit, 0);
  if (decoded === undefined || decoded[0].wireformat !== 'mls_private_message')
    throw new Error('not a PrivateMessage');
  return decoded[0].privateMessage;
}

describe('ts-mls 1.6.4 controls', () => {
  it('GHSA (Remove without UpdatePath): the library itself refuses it since 1.6.4, so the engine rule is defense in depth', async () => {
    const { world, cs, adversary } = await libraryAndEngine();
    const { room, devices } = await buildRoom(world, 3);
    const [alice, bob, carol] = trio(devices);
    const commit = await adversary.removeWithoutPath(
      room.state(bob),
      room.leafIndexOf(bob, carol),
      'private',
    );

    const victim = internalClientStateOf(room.state(alice));
    await expect(
      processPrivateMessage(victim, privateMessageOf(commit), emptyPskIndex, cs),
    ).rejects.toThrow(/update path is required/i);
    await expectCode(
      () =>
        world.engine.processCommit({
          state: room.state(alice),
          commit,
          servedMemberDelta: EMPTY_DELTA,
        }),
      MlsEngineErrorCode.PATH_REQUIRED,
    );
  });

  it('F8b (GroupContextExtensions without UpdatePath): the library ACCEPTS it, so the engine rule is the only guard', async () => {
    const { world, cs, adversary } = await libraryAndEngine();
    const { room, devices } = await buildRoom(world, 3);
    const [alice, bob] = pair(devices);
    const commit = await adversary.groupContextExtensionsWithoutPath(room.state(bob));

    const victim = internalClientStateOf(room.state(alice));
    const applied = await processPrivateMessage(
      victim,
      privateMessageOf(commit),
      emptyPskIndex,
      cs,
    );
    expect(applied.kind).toBe('newState'); // if this fails, upstream fixed F8b: update canon.md, keep the engine rule
    await expectCode(
      () =>
        world.engine.processCommit({
          state: room.state(alice),
          commit,
          servedMemberDelta: EMPTY_DELTA,
        }),
      MlsEngineErrorCode.PATH_REQUIRED,
    );
  });

  it('the engine source never imports an external-join, reinit or branch entry point of the library', () => {
    const sources = readdirSync(SOURCE_DIR).filter((name) => name.endsWith('.ts'));
    expect(sources.length).toBeGreaterThan(0);
    let imports = 0;
    for (const name of sources) {
      const text = readFileSync(join(SOURCE_DIR, name), 'utf8');
      const imported = [...text.matchAll(LIBRARY_IMPORT)].flatMap((match) =>
        (match[1] ?? '').split(',').map((part) => part.replace(/^\s*type\s+/, '').trim()),
      );
      imports += imported.length;
      for (const forbidden of FORBIDDEN_LIBRARY_ENTRY_POINTS) {
        expect(imported.includes(forbidden), `${name} imports ${forbidden}`).toBe(false);
      }
    }
    expect(imports, 'the scan must have found the library imports of the engine').toBeGreaterThan(
      10,
    );
  });
});
