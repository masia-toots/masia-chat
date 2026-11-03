import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { databaseSuite } from './support/harness.js';

const PRISMA_DIR = fileURLToPath(new URL('../../prisma/', import.meta.url));

/** Column or field names that would mean the relay stores something it can read. */
const PLAINTEXT_NAME = /(^|_)(text|plaintext|body|content|message|msg|payload)(_|$)/i;

/**
 * Columns whose name trips `PLAINTEXT_NAME` but which hold an id, not content: each is listed with
 * the reason, so a new one is a decision, not an accident. `client_msg_id` is the sender's retry key
 * (`idSchema`: a short id of a closed alphabet), chosen by the client and meaningless to the relay.
 */
const OPAQUE_ID_COLUMNS: ReadonlySet<string> = new Set(['client_msg_id']);

function schemaWithoutComments(): string {
  return readFileSync(path.join(PRISMA_DIR, 'schema.prisma'), 'utf8')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}

describe('the relay schema holds no plaintext (ADR-117: the server cannot read a message)', () => {
  it('has no field in schema.prisma named like a readable message body', () => {
    const fieldNames = schemaWithoutComments()
      .split('\n')
      .map((line) => line.trim().split(/\s+/)[0] ?? '')
      .filter((name) => /^[a-z][A-Za-z0-9]*$/.test(name));
    expect(fieldNames.length).toBeGreaterThan(10); // the parse found the fields at all
    expect(fieldNames.filter((name) => PLAINTEXT_NAME.test(name))).toEqual([]);
  });

  it('has no `text` column type anywhere', () => {
    expect(schemaWithoutComments()).not.toMatch(/@db\.(Text|VarChar|Char)\b/i);
  });

  it('stores the envelope as opaque bytes', () => {
    const envelope = /model Envelope \{([^}]*)\}/s.exec(schemaWithoutComments())?.[1] ?? '';
    expect(envelope).toMatch(/ciphertext\s+Bytes/);
  });

  it('has no GroupInfo: external joins are out of scope in phase 1 (security review 2026-10-10 §2)', () => {
    const schema = schemaWithoutComments();
    expect(schema).not.toMatch(/GROUP_INFO|groupInfo|group_info/);
    const kinds = /enum HandshakeKind \{([^}]*)\}/s.exec(schema)?.[1] ?? '';
    const names = kinds
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^[A-Z_]+$/.test(line));
    // PROPOSAL left with review round 1 (2026-10-10): proposals travel inside commits.
    expect(names).toEqual(['COMMIT', 'WELCOME']);
  });

  it('also holds in the migration SQL that is actually applied', () => {
    const migrations = readdirSync(path.join(PRISMA_DIR, 'migrations'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) =>
        readFileSync(path.join(PRISMA_DIR, 'migrations', entry.name, 'migration.sql'), 'utf8'),
      );
    expect(migrations.length).toBeGreaterThan(0);
    for (const sql of migrations) {
      expect(sql).not.toMatch(/\bTEXT\b[^,\n]*\b(body|content|message|plaintext)\b/i);
      expect(sql).not.toMatch(/"(text|plaintext|body|content|message)"\s/i);
    }
  });
});

databaseSuite('the live relay database holds no plaintext', (harness) => {
  it('has exactly the opaque columns on envelopes, and no readable-text column in any table', async () => {
    const { rows } = await harness().db.query<{ table: string; column: string; type: string }>(
      `SELECT table_name AS "table", column_name AS "column", data_type AS type
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name NOT IN ('_prisma_migrations', 'relay_test_migrations')`,
    );

    const envelopeColumns = rows
      .filter((row) => row.table === 'envelopes')
      .map((row) => row.column)
      .sort();
    expect(envelopeColumns).toEqual(
      // client_msg_id is the sender's own retry key (an opaque id), never message content.
      [
        'ciphertext',
        'client_msg_id',
        'conversation_id',
        'created_at',
        'epoch',
        'id',
        'sender_device_id',
        'seq',
      ].sort(),
    );
    expect(rows.find((row) => row.table === 'envelopes' && row.column === 'ciphertext')?.type).toBe(
      'bytea',
    );
    expect(
      rows.filter((row) => PLAINTEXT_NAME.test(row.column) && !OPAQUE_ID_COLUMNS.has(row.column)),
    ).toEqual([]);
  });

  it('knows no GROUP_INFO and no PROPOSAL handshake kind: both enums were shrunk by migrations', async () => {
    const { rows } = await harness().db.query<{ kind: string }>(
      'SELECT unnest(enum_range(NULL::handshake_kind))::text AS kind',
    );
    expect(rows.map((row) => row.kind).sort()).toEqual(['COMMIT', 'WELCOME']);
  });

  it('has the indexes retention and the readers rely on, and one envelope per (conversation, sender, clientMsgId)', async () => {
    const { rows } = await harness().db.query<{ name: string; definition: string }>(
      `SELECT indexname AS name, indexdef AS definition FROM pg_indexes WHERE schemaname = 'public'`,
    );
    const definitionOf = (name: string) => rows.find((row) => row.name === name)?.definition ?? '';
    expect(definitionOf('mls_handshakes_created_at_idx')).toMatch(/\(created_at\)/);
    expect(definitionOf('envelopes_created_at_idx')).toMatch(/\(created_at\)/);
    expect(definitionOf('envelopes_conversation_id_epoch_seq_idx')).toMatch(
      /\(conversation_id, epoch, seq\)/,
    );
    expect(definitionOf('envelopes_conversation_id_sender_device_id_client_msg_id_key')).toMatch(
      /UNIQUE INDEX .*\(conversation_id, sender_device_id, client_msg_id\)/,
    );
  });

  it('stores the declared member delta as JSON beside the opaque handshake bytes', async () => {
    const { rows } = await harness().db.query<{ type: string; nullable: string }>(
      `SELECT data_type AS type, is_nullable AS nullable FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'mls_handshakes' AND column_name = 'member_delta_json'`,
    );
    expect(rows).toEqual([{ type: 'jsonb', nullable: 'YES' }]);
  });

  it('records who claimed which key package, one row per (package, claimer)', async () => {
    const columns = await harness().db.query<{ column: string }>(
      `SELECT column_name AS "column" FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'key_package_claims'`,
    );
    expect(columns.rows.map((row) => row.column).sort()).toEqual([
      'claimed_at',
      'claimer_device_id',
      'key_package_id',
    ]);

    const key = await harness().db.query<{ columns: string[] }>(
      `SELECT array_agg(a.attname::text ORDER BY a.attname) AS columns
       FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
       WHERE i.indrelid = 'key_package_claims'::regclass AND i.indisprimary`,
    );
    expect(key.rows[0]?.columns).toEqual(['claimer_device_id', 'key_package_id']);
  });
});
