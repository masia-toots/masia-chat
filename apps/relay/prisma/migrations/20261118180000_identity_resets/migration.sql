-- ADR-218 К5a (2026-11-18): the identity-key reset's audit row, which is also the operator's ticket.
-- Additive only: one enum, one new table and its indexes. Nothing existing is changed, and no key data
-- moves. A row is permanent: retention never deletes it.
--
-- Every reset of an account's pinned identity key writes one row, in the transaction that releases the
-- pin: the operator CLI (`apps/relay/scripts/identity-reset.ts`, actor OPERATOR) and the family-admin
-- route `DELETE /users/{userId}/identity-key` (actor FAMILY_ADMIN, with the admin's device).
--
-- An OPERATOR row names the first device: while the row is open (not pinned, not superseded), only that
-- device may pin the account's next key (`registerDevice`: 409 IDENTITY_RESET_PENDING for any other).
-- `pinned_at` closes it when the first device pins; `superseded_at` when a later reset replaces it.
CREATE TYPE "identity_reset_actor" AS ENUM ('OPERATOR', 'FAMILY_ADMIN');

CREATE TABLE "identity_resets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" TEXT NOT NULL,
    "actor" "identity_reset_actor" NOT NULL,
    "actor_device_id" TEXT,
    "reason" TEXT,
    "first_device_id" TEXT,
    "revoked_device_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "released_key_sha256" BYTEA,
    "list_versions_deleted" INTEGER NOT NULL,
    "requests_deleted" INTEGER NOT NULL,
    "holder_proofs_cleared" INTEGER NOT NULL,
    "key_packages_deleted" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "pinned_at" TIMESTAMPTZ(3),
    "superseded_at" TIMESTAMPTZ(3),

    CONSTRAINT "identity_resets_pkey" PRIMARY KEY ("id"),
    -- The operator always opens a ticket; the family-admin route never does.
    CONSTRAINT "identity_resets_ticket_check" CHECK (("actor" = 'OPERATOR') = ("first_device_id" IS NOT NULL)),
    -- A ticket is closed once, one way or the other.
    CONSTRAINT "identity_resets_closed_check" CHECK ("pinned_at" IS NULL OR "superseded_at" IS NULL),
    -- The operator's note is short, and it is required when devices are revoked past their rooms.
    CONSTRAINT "identity_resets_reason_check" CHECK (
        ("reason" IS NULL OR char_length("reason") BETWEEN 1 AND 200)
        AND (cardinality("revoked_device_ids") = 0 OR "reason" IS NOT NULL)
    )
);

CREATE INDEX "identity_resets_user_id_created_at_idx" ON "identity_resets"("user_id", "created_at");

-- At most ONE open ticket per account. A partial unique index, which the Prisma schema language cannot
-- express, so `schema.prisma` names it in a comment instead of declaring it.
CREATE UNIQUE INDEX "identity_resets_open_ticket_key" ON "identity_resets"("user_id")
    WHERE "first_device_id" IS NOT NULL AND "pinned_at" IS NULL AND "superseded_at" IS NULL;

ALTER TABLE "identity_resets" ADD CONSTRAINT "identity_resets_actor_device_id_fkey" FOREIGN KEY ("actor_device_id") REFERENCES "devices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "identity_resets" ADD CONSTRAINT "identity_resets_first_device_id_fkey" FOREIGN KEY ("first_device_id") REFERENCES "devices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
