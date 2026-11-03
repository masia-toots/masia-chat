-- K2b relay hardening (security review 2026-10-10, ADR-117 §2a/§5a).
--
-- 1. GROUP_INFO leaves the handshake kinds: external joins are out of scope in phase 1 (review §2), and
--    a GroupInfo readable by every member is a surface nothing needs. The relay is not deployed yet,
--    so any GROUP_INFO row can only be test data; it is deleted so the enum can shrink. (If the last
--    row of a conversation was one, its seq could be handed out again, which is harmless pre-deploy.)
-- 2. The member changes a committer DECLARED are now stored beside the handshake (member_delta_json),
--    so every member can compare them with what the decrypted commit really does (review §4).
-- 3. key_package_claims records WHO claimed WHICH package, so a declared Add is accepted only if the
--    committer's own device claimed that package (review §4, "Lying memberDelta").
--
-- No BEGIN/COMMIT here: `prisma migrate deploy` sends the script as one simple query, which Postgres
-- runs atomically, and the test runner wraps every file in its own transaction.

-- Remove rows of the kind that is going away.
DELETE FROM "mls_handshakes" WHERE "kind"::text = 'GROUP_INFO';

-- AlterEnum
CREATE TYPE "handshake_kind_new" AS ENUM ('COMMIT', 'PROPOSAL', 'WELCOME');
ALTER TABLE "mls_handshakes" ALTER COLUMN "kind" TYPE "handshake_kind_new" USING ("kind"::text::"handshake_kind_new");
ALTER TYPE "handshake_kind" RENAME TO "handshake_kind_old";
ALTER TYPE "handshake_kind_new" RENAME TO "handshake_kind";
DROP TYPE "handshake_kind_old";

-- AlterTable
ALTER TABLE "mls_handshakes" ADD COLUMN     "member_delta_json" JSONB;

-- CreateTable
CREATE TABLE "key_package_claims" (
    "key_package_id" UUID NOT NULL,
    "claimer_device_id" TEXT NOT NULL,
    "claimed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "key_package_claims_pkey" PRIMARY KEY ("key_package_id","claimer_device_id")
);

-- CreateIndex
CREATE INDEX "key_package_claims_claimer_device_id_idx" ON "key_package_claims"("claimer_device_id");

-- AddForeignKey
ALTER TABLE "key_package_claims" ADD CONSTRAINT "key_package_claims_key_package_id_fkey" FOREIGN KEY ("key_package_id") REFERENCES "key_packages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "key_package_claims" ADD CONSTRAINT "key_package_claims_claimer_device_id_fkey" FOREIGN KEY ("claimer_device_id") REFERENCES "devices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
