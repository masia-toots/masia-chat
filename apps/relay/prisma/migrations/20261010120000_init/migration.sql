
-- CreateEnum
CREATE TYPE "device_role" AS ENUM ('USER', 'GUARDIAN', 'MASIA');

-- CreateEnum
CREATE TYPE "handshake_kind" AS ENUM ('COMMIT', 'PROPOSAL', 'WELCOME', 'GROUP_INFO');

-- CreateTable
CREATE TABLE "devices" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" "device_role" NOT NULL DEFAULT 'USER',
    "name" TEXT,
    "platform" TEXT,
    "identity_key_pub" BYTEA NOT NULL,
    "signature_key_pub" BYTEA NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),

    CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_lists" (
    "user_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "devices_json" JSONB NOT NULL,
    "signature" BYTEA NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_lists_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "key_packages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "device_id" TEXT NOT NULL,
    "bytes" BYTEA NOT NULL,
    "last_resort" BOOLEAN NOT NULL DEFAULT false,
    "consumed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "key_packages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_e2ee" (
    "conversation_id" TEXT NOT NULL,
    "group_id" BYTEA NOT NULL,
    "epoch" INTEGER NOT NULL,
    "tree_hash" BYTEA NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_e2ee_pkey" PRIMARY KEY ("conversation_id")
);

-- CreateTable
CREATE TABLE "mls_handshakes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "conversation_id" TEXT NOT NULL,
    "epoch" INTEGER NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" "handshake_kind" NOT NULL,
    "sender_device_id" TEXT NOT NULL,
    "bytes" BYTEA NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mls_handshakes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "envelopes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "conversation_id" TEXT NOT NULL,
    "epoch" INTEGER NOT NULL,
    "seq" INTEGER NOT NULL,
    "sender_device_id" TEXT NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "envelopes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "room_members" (
    "conversation_id" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "added_at_epoch" INTEGER NOT NULL,
    "removed_at_epoch" INTEGER,

    CONSTRAINT "room_members_pkey" PRIMARY KEY ("conversation_id","device_id")
);

-- CreateIndex
CREATE INDEX "devices_user_id_idx" ON "devices"("user_id");

-- CreateIndex
CREATE INDEX "key_packages_device_id_consumed_at_idx" ON "key_packages"("device_id", "consumed_at");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_e2ee_group_id_key" ON "conversation_e2ee"("group_id");

-- CreateIndex
CREATE UNIQUE INDEX "mls_handshakes_conversation_id_epoch_seq_key" ON "mls_handshakes"("conversation_id", "epoch", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "mls_handshakes_conversation_id_seq_key" ON "mls_handshakes"("conversation_id", "seq");

-- CreateIndex
CREATE INDEX "envelopes_conversation_id_created_at_idx" ON "envelopes"("conversation_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "envelopes_conversation_id_seq_key" ON "envelopes"("conversation_id", "seq");

-- CreateIndex
CREATE INDEX "room_members_device_id_idx" ON "room_members"("device_id");

-- AddForeignKey
ALTER TABLE "key_packages" ADD CONSTRAINT "key_packages_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mls_handshakes" ADD CONSTRAINT "mls_handshakes_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversation_e2ee"("conversation_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mls_handshakes" ADD CONSTRAINT "mls_handshakes_sender_device_id_fkey" FOREIGN KEY ("sender_device_id") REFERENCES "devices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "envelopes" ADD CONSTRAINT "envelopes_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversation_e2ee"("conversation_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "envelopes" ADD CONSTRAINT "envelopes_sender_device_id_fkey" FOREIGN KEY ("sender_device_id") REFERENCES "devices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_members" ADD CONSTRAINT "room_members_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversation_e2ee"("conversation_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_members" ADD CONSTRAINT "room_members_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Invariants the database holds itself. Prisma's schema language cannot express CHECKs, and Prisma
-- ignores them when it compares the schema with the database, so they cause no drift.

-- ADR-117 H6: the last-resort key package is NEVER consumed. A bug in the claim path must not be
-- able to drain it and lock a device out; the database refuses.
ALTER TABLE "key_packages" ADD CONSTRAINT "key_packages_last_resort_never_consumed"
    CHECK (NOT ("last_resort" AND "consumed_at" IS NOT NULL));

-- Epochs start at 0 and only grow; seq starts at 1.
ALTER TABLE "conversation_e2ee" ADD CONSTRAINT "conversation_e2ee_epoch_non_negative"
    CHECK ("epoch" >= 0);
ALTER TABLE "mls_handshakes" ADD CONSTRAINT "mls_handshakes_epoch_seq_range"
    CHECK ("epoch" >= 0 AND "seq" >= 1);
ALTER TABLE "envelopes" ADD CONSTRAINT "envelopes_epoch_seq_range"
    CHECK ("epoch" >= 0 AND "seq" >= 1);

-- A device leaves a room at a LATER epoch than the one it joined in.
ALTER TABLE "room_members" ADD CONSTRAINT "room_members_removed_after_added"
    CHECK ("removed_at_epoch" IS NULL OR "removed_at_epoch" > "added_at_epoch");

-- A device list starts at version 1 (isNextDeviceListVersion in @masia/relay).
ALTER TABLE "device_lists" ADD CONSTRAINT "device_lists_version_positive"
    CHECK ("version" >= 1);

