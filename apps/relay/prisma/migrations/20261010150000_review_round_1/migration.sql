-- Review round 1 (2026-10-10): stable sequence numbers so retention can delete, idempotent posts,
-- key-package lifetimes, and the indexes the retention job and the readers need. Additive except for
-- the PROPOSAL kind, which leaves the relay (see 1).
--
-- 1. PROPOSAL leaves the handshake kinds: the engine commits proposals inline and refuses a
--    standalone one, so a stored proposal is something no member accepts. Rows of that kind are
--    deleted so the enum can shrink. Their seq numbers are NOT reused: the counters below start
--    from the highest seq ever stored, deleted rows included.
-- 2. Per-conversation seq counters on conversation_e2ee. Before this, the next seq was MAX(seq) + 1
--    of the rows present, so deleting the newest rows (retention, or step 1) handed the same seq out
--    twice and a reader's cursor silently skipped messages. A counter only moves forward.
-- 3. creator_device_id: what makes "open this group" safe to retry (same conversation, group and
--    creator -> the original answer instead of 409). Null on groups opened before this column.
-- 4. envelopes.client_msg_id + a unique index per (conversation, sender, id): a resent message gets
--    its original seq instead of being stored twice. Optional, so a client without it still works.
-- 5. key_packages.not_after: the package's MLS lifetime end, read from its cleartext at upload, so
--    expired packages are skipped and purged without parsing the bytes again. Null on packages
--    uploaded before this column (their lifetime is unknown; they are served as before).
-- 6. Indexes for the retention job (created_at) and for the epoch-bounded envelope reads.
--
-- No BEGIN/COMMIT here: `prisma migrate deploy` sends the script as one simple query, which Postgres
-- runs atomically, and the test runner wraps every file in its own transaction.

-- 2 (before 1, so the counters include the rows step 1 deletes)
ALTER TABLE "conversation_e2ee" ADD COLUMN "handshake_seq" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "conversation_e2ee" ADD COLUMN "envelope_seq" INTEGER NOT NULL DEFAULT 0;
UPDATE "conversation_e2ee" c SET
    "handshake_seq" = COALESCE((SELECT MAX(h."seq") FROM "mls_handshakes" h WHERE h."conversation_id" = c."conversation_id"), 0),
    "envelope_seq" = COALESCE((SELECT MAX(e."seq") FROM "envelopes" e WHERE e."conversation_id" = c."conversation_id"), 0);
ALTER TABLE "conversation_e2ee" ADD CONSTRAINT "conversation_e2ee_seq_counters_non_negative"
    CHECK ("handshake_seq" >= 0 AND "envelope_seq" >= 0);

-- 1
DELETE FROM "mls_handshakes" WHERE "kind"::text = 'PROPOSAL';
CREATE TYPE "handshake_kind_new" AS ENUM ('COMMIT', 'WELCOME');
ALTER TABLE "mls_handshakes" ALTER COLUMN "kind" TYPE "handshake_kind_new" USING ("kind"::text::"handshake_kind_new");
ALTER TYPE "handshake_kind" RENAME TO "handshake_kind_old";
ALTER TYPE "handshake_kind_new" RENAME TO "handshake_kind";
DROP TYPE "handshake_kind_old";

-- 3
ALTER TABLE "conversation_e2ee" ADD COLUMN "creator_device_id" TEXT;

-- 4
ALTER TABLE "envelopes" ADD COLUMN "client_msg_id" TEXT;
CREATE UNIQUE INDEX "envelopes_conversation_id_sender_device_id_client_msg_id_key"
    ON "envelopes"("conversation_id", "sender_device_id", "client_msg_id");

-- 5
ALTER TABLE "key_packages" ADD COLUMN "not_after" TIMESTAMPTZ(3);
CREATE INDEX "key_packages_not_after_idx" ON "key_packages"("not_after");

-- 6
CREATE INDEX "mls_handshakes_created_at_idx" ON "mls_handshakes"("created_at");
CREATE INDEX "envelopes_created_at_idx" ON "envelopes"("created_at");
CREATE INDEX "envelopes_conversation_id_epoch_seq_idx" ON "envelopes"("conversation_id", "epoch", "seq");
CREATE INDEX "key_packages_consumed_at_idx" ON "key_packages"("consumed_at");
