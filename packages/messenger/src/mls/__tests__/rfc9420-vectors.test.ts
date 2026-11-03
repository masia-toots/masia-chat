import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type CiphersuiteImpl,
  type GroupContext,
  type RatchetTree,
  defaultKeyRetentionConfig,
  getCiphersuiteFromName,
  getCiphersuiteImpl,
} from 'ts-mls';
import { decodeCommit } from 'ts-mls/commit.js';
import { decryptWithLabel, encryptWithLabel } from 'ts-mls/crypto/hpke.js';
import { deriveSecret, deriveTreeSecret, expandWithLabel } from 'ts-mls/crypto/kdf.js';
import { refhash } from 'ts-mls/crypto/hash.js';
import { signWithLabel, verifyWithLabel } from 'ts-mls/crypto/signature.js';
import { decodeGroupContext, encodeGroupContext } from 'ts-mls/groupContext.js';
import { initializeEpoch, mlsExporter } from 'ts-mls/keySchedule.js';
import { unprotectPrivateMessage } from 'ts-mls/messageProtection.js';
import { unprotectPublicMessage } from 'ts-mls/messageProtectionPublic.js';
import { decodeMlsMessage } from 'ts-mls';
import { decodeProposal } from 'ts-mls/proposal.js';
import { createSecretTree, deriveKey, deriveNonce, ratchetUntil } from 'ts-mls/secretTree.js';
import {
  isLeaf,
  left,
  nodeWidth,
  parent,
  right,
  root,
  sibling,
  toNodeIndex,
} from 'ts-mls/treemath.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { MLS_CIPHER_SUITE_NAME } from '../constants.js';

/**
 * RFC 9420 TEST VECTORS (mlswg/mls-implementations, cipher suite 1; provenance and file hashes in
 * `fixtures/rfc9420/PROVENANCE.json`).
 *
 * WHAT IS COVERED, AND WHERE. The engine's surface is a group lifecycle (create, add, commit,
 * join), and a vector is a single primitive or one epoch of a hand-made group, so these tests drive
 * the same library build and the same suite implementation the engine uses (`ts-mls` through deep
 * imports, `getCiphersuiteImpl` on the pinned suite), not `MlsEngine` itself. What they prove: this
 * library, in this runtime (Node WebCrypto + the noble fallbacks), computes what RFC 9420 says.
 *
 *   tree-math          ts-mls/treemath            (node arithmetic under every tree walk)
 *   crypto-basics      ts-mls/crypto/{kdf,hash,hpke,signature}   (labelled primitives, §5.1-§5.2, §8)
 *   secret-tree        ts-mls/secretTree          (§9: sender data key/nonce, per-leaf handshake and application ratchets, 1/8/32 leaves)
 *   key-schedule       ts-mls/keySchedule         (§8: an epoch's secrets, five epochs, plus the exporter)
 *   message-protection ts-mls/messageProtection*  (§6: PublicMessage and PrivateMessage, proposal/commit/application)
 *
 * NOT REACHABLE, on purpose. The passive-client-* vectors replay arbitrary groups (arbitrary
 * credentials, proposals by reference, PSKs, ReInit, external senders and external joins): every one
 * of those is a feature the engine refuses by design (internal ADR-117, security review 2026-10-10 §1, §2).
 * `welcome`, `tree-operations`, `tree-validation`, `treekem` need the library's internal group
 * state built from raw tree bytes, which the opaque `GroupState` does not allow; the engine-level
 * Welcome and tree checks are covered by the attack contract instead.
 * The `external_pub` field of the key-schedule vectors is skipped: external join is not a feature.
 */

const FIXTURES = join(import.meta.dirname, 'fixtures', 'rfc9420');

function load<T>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as T;
}

/** The fixtures are filtered to the pinned suite, so each file holds the one vector that applies. */
function loadFirst<T>(name: string): T {
  const [first] = load<T[]>(name);
  if (first === undefined) throw new Error(`${name} has no vector for the pinned cipher suite`);
  return first;
}

const hex = (text: string): Uint8Array => Uint8Array.from(Buffer.from(text, 'hex'));
const toHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

let cs: CiphersuiteImpl;
beforeAll(async () => {
  cs = await getCiphersuiteImpl(getCiphersuiteFromName(MLS_CIPHER_SUITE_NAME));
});

// --- tree-math -------------------------------------------------------------------------------------------

interface TreeMathVector {
  n_leaves: number;
  n_nodes: number;
  root: number;
  left: (number | null)[];
  right: (number | null)[];
  parent: (number | null)[];
  sibling: (number | null)[];
}

describe('RFC 9420 vectors: tree-math (Appendix C)', () => {
  const vectors = load<TreeMathVector[]>('tree-math.json');

  it('has the vectors', () => {
    expect(vectors.length).toBeGreaterThanOrEqual(10);
  });

  for (const vector of vectors) {
    it(`${vector.n_leaves} leaves: width, root, left, right, parent, sibling of all ${vector.n_nodes} nodes`, () => {
      expect(nodeWidth(vector.n_leaves)).toBe(vector.n_nodes);
      expect(root(vector.n_leaves)).toBe(vector.root);
      for (let i = 0; i < vector.n_nodes; i += 1) {
        const node = toNodeIndex(i);
        // Leaves have no children; the root has no parent and no sibling: the vectors say null there.
        if (vector.left[i] === null) {
          expect(isLeaf(node), `node ${i} has no left child but is not a leaf`).toBe(true);
        } else {
          expect(left(node), `left(${i})`).toBe(vector.left[i]);
          expect(right(node), `right(${i})`).toBe(vector.right[i]);
        }
        if (vector.parent[i] === null) {
          expect(i, `node ${i} has no parent but is not the root`).toBe(vector.root);
        } else {
          expect(parent(node, vector.n_leaves), `parent(${i})`).toBe(vector.parent[i]);
          expect(sibling(node, vector.n_leaves), `sibling(${i})`).toBe(vector.sibling[i]);
        }
      }
    });
  }
});

// --- crypto-basics ---------------------------------------------------------------------------------------------

interface CryptoBasicsVector {
  cipher_suite: number;
  ref_hash: { label: string; value: string; out: string };
  expand_with_label: {
    secret: string;
    label: string;
    context: string;
    length: number;
    out: string;
  };
  derive_secret: { secret: string; label: string; out: string };
  derive_tree_secret: {
    secret: string;
    label: string;
    generation: number;
    length: number;
    out: string;
  };
  sign_with_label: { priv: string; pub: string; content: string; label: string; signature: string };
  encrypt_with_label: {
    priv: string;
    pub: string;
    label: string;
    context: string;
    plaintext: string;
    kem_output: string;
    ciphertext: string;
  };
}

describe('RFC 9420 vectors: crypto-basics (§5.1, §5.2, §8)', () => {
  const vector = loadFirst<CryptoBasicsVector>('crypto-basics.json');

  it('RefHash', async () => {
    const { label, value, out } = vector.ref_hash;
    expect(toHex(await refhash(label, hex(value), cs.hash))).toBe(out);
  });

  it('ExpandWithLabel', async () => {
    const { secret, label, context, length, out } = vector.expand_with_label;
    expect(toHex(await expandWithLabel(hex(secret), label, hex(context), length, cs.kdf))).toBe(
      out,
    );
  });

  it('DeriveSecret', async () => {
    const { secret, label, out } = vector.derive_secret;
    expect(toHex(await deriveSecret(hex(secret), label, cs.kdf))).toBe(out);
  });

  it('DeriveTreeSecret, including a generation that does not fit a signed 32-bit integer', async () => {
    const { secret, label, generation, length, out } = vector.derive_tree_secret;
    expect(generation).toBeGreaterThan(2 ** 31);
    expect(toHex(await deriveTreeSecret(hex(secret), label, generation, length, cs.kdf))).toBe(out);
  });

  it('SignWithLabel: the vector verifies, our own signature verifies, and a changed content does not', async () => {
    const { priv, pub, content, label, signature } = vector.sign_with_label;
    expect(await verifyWithLabel(hex(pub), label, hex(content), hex(signature), cs.signature)).toBe(
      true,
    );
    const ours = await signWithLabel(hex(priv), label, hex(content), cs.signature);
    expect(await verifyWithLabel(hex(pub), label, hex(content), ours, cs.signature)).toBe(true);
    const other = hex(content);
    other[0] = (other[0] ?? 0) ^ 1;
    expect(await verifyWithLabel(hex(pub), label, other, hex(signature), cs.signature)).toBe(false);
    expect(
      await verifyWithLabel(hex(pub), 'OtherLabel', hex(content), hex(signature), cs.signature),
    ).toBe(false);
  });

  it('EncryptWithLabel: the vector decrypts, and our own encryption round-trips', async () => {
    const { priv, pub, label, context, plaintext, kem_output, ciphertext } =
      vector.encrypt_with_label;
    const privateKey = await cs.hpke.importPrivateKey(hex(priv));
    const opened = await decryptWithLabel(
      privateKey,
      label,
      hex(context),
      hex(kem_output),
      hex(ciphertext),
      cs.hpke,
    );
    expect(toHex(opened)).toBe(plaintext);

    const publicKey = await cs.hpke.importPublicKey(hex(pub));
    const sealed = await encryptWithLabel(publicKey, label, hex(context), hex(plaintext), cs.hpke);
    expect(
      toHex(
        await decryptWithLabel(privateKey, label, hex(context), sealed.enc, sealed.ct, cs.hpke),
      ),
    ).toBe(plaintext);
    // The context is bound: opening under another context fails.
    await expect(
      decryptWithLabel(privateKey, label, hex('00'), sealed.enc, sealed.ct, cs.hpke),
    ).rejects.toThrow();
  });
});

// --- secret-tree ---------------------------------------------------------------------------------------------------

interface SecretTreeGeneration {
  generation: number;
  handshake_key: string;
  handshake_nonce: string;
  application_key: string;
  application_nonce: string;
}

interface SecretTreeVector {
  cipher_suite: number;
  encryption_secret: string;
  sender_data: { sender_data_secret: string; ciphertext: string; key: string; nonce: string };
  leaves: SecretTreeGeneration[][];
}

/** The vectors ask for generations far past the library's default forward-ratchet bound; lift it for the check only. */
const VECTOR_RATCHET_STEPS = 1000;

describe('RFC 9420 vectors: secret-tree (§9, §6.3.2)', () => {
  const vectors = load<SecretTreeVector[]>('secret-tree.json');

  it('has the vectors', () => {
    expect(vectors.map((vector) => vector.leaves.length)).toEqual([1, 8, 32]);
  });

  for (const vector of vectors) {
    it(`${vector.leaves.length} leaves: sender data key and nonce, then every leaf's handshake and application ratchets`, async () => {
      const { sender_data_secret, ciphertext, key, nonce } = vector.sender_data;
      const sample = hex(ciphertext).slice(0, cs.kdf.size);
      expect(
        toHex(
          await expandWithLabel(hex(sender_data_secret), 'key', sample, cs.hpke.keyLength, cs.kdf),
        ),
      ).toBe(key);
      expect(
        toHex(
          await expandWithLabel(
            hex(sender_data_secret),
            'nonce',
            sample,
            cs.hpke.nonceLength,
            cs.kdf,
          ),
        ),
      ).toBe(nonce);

      const tree = await createSecretTree(
        vector.leaves.length,
        hex(vector.encryption_secret),
        cs.kdf,
      );
      const config = {
        ...defaultKeyRetentionConfig,
        maximumForwardRatchetSteps: VECTOR_RATCHET_STEPS,
      };
      for (const [leafIndex, generations] of vector.leaves.entries()) {
        const node = tree[leafIndex * 2];
        if (node === undefined)
          throw new Error(`the secret tree has no node for leaf ${leafIndex}`);
        expect(generations.length).toBeGreaterThan(0);
        for (const entry of generations) {
          const at = `leaf ${leafIndex} generation ${entry.generation}`;
          const [handshake] = await ratchetUntil(node.handshake, entry.generation, config, cs.kdf);
          expect(
            toHex(await deriveKey(handshake.secret, entry.generation, cs)),
            `${at} handshake key`,
          ).toBe(entry.handshake_key);
          expect(
            toHex(await deriveNonce(handshake.secret, entry.generation, cs)),
            `${at} handshake nonce`,
          ).toBe(entry.handshake_nonce);
          const [application] = await ratchetUntil(
            node.application,
            entry.generation,
            config,
            cs.kdf,
          );
          expect(
            toHex(await deriveKey(application.secret, entry.generation, cs)),
            `${at} application key`,
          ).toBe(entry.application_key);
          expect(
            toHex(await deriveNonce(application.secret, entry.generation, cs)),
            `${at} application nonce`,
          ).toBe(entry.application_nonce);
        }
      }
    });
  }
});

// --- key-schedule --------------------------------------------------------------------------------------------------

interface KeyScheduleEpoch {
  tree_hash: string;
  commit_secret: string;
  psk_secret: string;
  confirmed_transcript_hash: string;
  group_context: string;
  joiner_secret: string;
  welcome_secret: string;
  init_secret: string;
  sender_data_secret: string;
  encryption_secret: string;
  exporter_secret: string;
  epoch_authenticator: string;
  external_secret: string;
  confirmation_key: string;
  membership_key: string;
  resumption_psk: string;
  exporter: { label: string; context: string; length: number; secret: string };
}

interface KeyScheduleVector {
  group_id: string;
  initial_init_secret: string;
  epochs: KeyScheduleEpoch[];
}

describe('RFC 9420 vectors: key-schedule (§8)', () => {
  const vector = loadFirst<KeyScheduleVector>('key-schedule.json');

  it('derives every secret of every epoch, chaining init_secret from one epoch to the next', async () => {
    expect(vector.epochs.length).toBeGreaterThan(1);
    let previousInitSecret = hex(vector.initial_init_secret);
    for (const [index, epoch] of vector.epochs.entries()) {
      const decoded = decodeGroupContext(hex(epoch.group_context), 0);
      if (decoded === undefined)
        throw new Error(`epoch ${index}: the GroupContext does not decode`);
      const groupContext: GroupContext = decoded[0];
      // The vector's GroupContext is what the vector's inputs say it is.
      expect(groupContext.epoch).toBe(BigInt(index));
      expect(toHex(groupContext.groupId)).toBe(vector.group_id);
      expect(toHex(groupContext.treeHash)).toBe(epoch.tree_hash);
      expect(toHex(groupContext.confirmedTranscriptHash)).toBe(epoch.confirmed_transcript_hash);
      expect(toHex(encodeGroupContext(groupContext))).toBe(epoch.group_context);

      const secrets = await initializeEpoch(
        previousInitSecret,
        hex(epoch.commit_secret),
        groupContext,
        hex(epoch.psk_secret),
        cs.kdf,
      );
      const schedule = secrets.keySchedule;
      const at = `epoch ${index}`;
      expect(toHex(secrets.joinerSecret), `${at} joiner_secret`).toBe(epoch.joiner_secret);
      expect(toHex(secrets.welcomeSecret), `${at} welcome_secret`).toBe(epoch.welcome_secret);
      expect(toHex(secrets.encryptionSecret), `${at} encryption_secret`).toBe(
        epoch.encryption_secret,
      );
      expect(toHex(schedule.senderDataSecret), `${at} sender_data_secret`).toBe(
        epoch.sender_data_secret,
      );
      expect(toHex(schedule.exporterSecret), `${at} exporter_secret`).toBe(epoch.exporter_secret);
      expect(toHex(schedule.epochAuthenticator), `${at} epoch_authenticator`).toBe(
        epoch.epoch_authenticator,
      );
      expect(toHex(schedule.externalSecret), `${at} external_secret`).toBe(epoch.external_secret);
      expect(toHex(schedule.confirmationKey), `${at} confirmation_key`).toBe(
        epoch.confirmation_key,
      );
      expect(toHex(schedule.membershipKey), `${at} membership_key`).toBe(epoch.membership_key);
      expect(toHex(schedule.resumptionPsk), `${at} resumption_psk`).toBe(epoch.resumption_psk);
      expect(toHex(schedule.initSecret), `${at} init_secret`).toBe(epoch.init_secret);

      const { label, context, length, secret } = epoch.exporter;
      const exported = await mlsExporter(schedule.exporterSecret, label, hex(context), length, cs);
      expect(toHex(exported), `${at} MLS-Exporter`).toBe(secret);

      previousInitSecret = schedule.initSecret;
    }
  });
});

// --- message-protection ----------------------------------------------------------------------------------------------

interface MessageProtectionVector {
  group_id: string;
  epoch: number;
  tree_hash: string;
  confirmed_transcript_hash: string;
  signature_pub: string;
  encryption_secret: string;
  sender_data_secret: string;
  membership_key: string;
  proposal: string;
  proposal_priv: string;
  proposal_pub: string;
  commit: string;
  commit_priv: string;
  commit_pub: string;
  application: string;
  application_priv: string;
}

/** Leaves in the vectors' group: the sender is leaf 1 of a tree of two (test-vectors.md, message-protection). */
const VECTOR_LEAVES = 2;

describe('RFC 9420 vectors: message-protection (§6)', () => {
  const vector = loadFirst<MessageProtectionVector>('message-protection.json');

  const groupContext = (): GroupContext => ({
    version: 'mls10',
    cipherSuite: MLS_CIPHER_SUITE_NAME,
    groupId: hex(vector.group_id),
    epoch: BigInt(vector.epoch),
    treeHash: hex(vector.tree_hash),
    confirmedTranscriptHash: hex(vector.confirmed_transcript_hash),
    extensions: [],
  });
  /**
   * The vectors give the sender's signature key directly, so the tree only has to show a non-blank
   * leaf at the sender's place (`unprotectPrivateMessage` checks that and then takes
   * `overrideSignatureKey`). A stand-in tree, never a group state.
   */
  const standInTree = (): RatchetTree =>
    Array.from({ length: nodeWidth(VECTOR_LEAVES) }, (_, i) =>
      i % 2 === 0 ? ({ nodeType: 'leaf' } as unknown as RatchetTree[number]) : undefined,
    );

  function messageOf(wire: string) {
    const decoded = decodeMlsMessage(hex(wire), 0);
    if (decoded === undefined) throw new Error('the vector message does not decode');
    return decoded[0];
  }

  async function openPrivate(wire: string) {
    const message = messageOf(wire);
    if (message.wireformat !== 'mls_private_message') throw new Error('expected a PrivateMessage');
    // Every private message in a vector is protected from a FRESH secret tree: generation 0 of its ratchet.
    const secretTree = await createSecretTree(VECTOR_LEAVES, hex(vector.encryption_secret), cs.kdf);
    const opened = await unprotectPrivateMessage(
      hex(vector.sender_data_secret),
      message.privateMessage,
      secretTree,
      standInTree(),
      groupContext(),
      defaultKeyRetentionConfig,
      cs,
      hex(vector.signature_pub),
    );
    return opened.content.content;
  }

  async function openPublic(wire: string) {
    const message = messageOf(wire);
    if (message.wireformat !== 'mls_public_message') throw new Error('expected a PublicMessage');
    const opened = await unprotectPublicMessage(
      hex(vector.membership_key),
      groupContext(),
      standInTree(),
      message.publicMessage,
      cs,
      hex(vector.signature_pub),
    );
    return opened.content;
  }

  const expectedProposal = () => {
    const decoded = decodeProposal(hex(vector.proposal), 0);
    if (decoded === undefined) throw new Error('the vector proposal does not decode');
    return decoded[0];
  };
  const expectedCommit = () => {
    const decoded = decodeCommit(hex(vector.commit), 0);
    if (decoded === undefined) throw new Error('the vector commit does not decode');
    return decoded[0];
  };

  it('PrivateMessage / proposal', async () => {
    const content = await openPrivate(vector.proposal_priv);
    if (content.contentType !== 'proposal') throw new Error('not a proposal');
    expect(content.proposal).toEqual(expectedProposal());
  });

  it('PrivateMessage / commit', async () => {
    const content = await openPrivate(vector.commit_priv);
    if (content.contentType !== 'commit') throw new Error('not a commit');
    expect(content.commit).toEqual(expectedCommit());
  });

  it('PrivateMessage / application', async () => {
    const content = await openPrivate(vector.application_priv);
    if (content.contentType !== 'application') throw new Error('not application data');
    expect(toHex(content.applicationData)).toBe(vector.application);
  });

  it('PublicMessage / proposal', async () => {
    const content = await openPublic(vector.proposal_pub);
    if (content.contentType !== 'proposal') throw new Error('not a proposal');
    expect(content.proposal).toEqual(expectedProposal());
  });

  it('PublicMessage / commit', async () => {
    const content = await openPublic(vector.commit_pub);
    if (content.contentType !== 'commit') throw new Error('not a commit');
    expect(content.commit).toEqual(expectedCommit());
  });

  it('refuses what the vectors do not say: a wrong signature key, a wrong membership key, a wrong sender data secret', async () => {
    const wrongKey = hex(vector.signature_pub);
    wrongKey[0] = (wrongKey[0] ?? 0) ^ 1;
    const publicMessage = messageOf(vector.commit_pub);
    const privateMessage = messageOf(vector.commit_priv);
    if (
      publicMessage.wireformat !== 'mls_public_message' ||
      privateMessage.wireformat !== 'mls_private_message'
    ) {
      throw new Error('unexpected wire formats in the vector');
    }
    await expect(
      unprotectPublicMessage(
        hex(vector.membership_key),
        groupContext(),
        standInTree(),
        publicMessage.publicMessage,
        cs,
        wrongKey,
      ),
    ).rejects.toThrow();
    const wrongMembership = hex(vector.membership_key);
    wrongMembership[0] = (wrongMembership[0] ?? 0) ^ 1;
    await expect(
      unprotectPublicMessage(
        wrongMembership,
        groupContext(),
        standInTree(),
        publicMessage.publicMessage,
        cs,
        hex(vector.signature_pub),
      ),
    ).rejects.toThrow();
    const wrongSenderData = hex(vector.sender_data_secret);
    wrongSenderData[0] = (wrongSenderData[0] ?? 0) ^ 1;
    const secretTree = await createSecretTree(VECTOR_LEAVES, hex(vector.encryption_secret), cs.kdf);
    await expect(
      unprotectPrivateMessage(
        wrongSenderData,
        privateMessage.privateMessage,
        secretTree,
        standInTree(),
        groupContext(),
        defaultKeyRetentionConfig,
        cs,
        hex(vector.signature_pub),
      ),
    ).rejects.toThrow();
  });
});
