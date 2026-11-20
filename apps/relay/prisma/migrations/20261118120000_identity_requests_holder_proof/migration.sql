-- ADR-218 К3b (2026-11-18): the identity transfer. Additive only: one nullable column and one new
-- table; nothing is dropped or rewritten, and no key data migrates.
--
-- (1) A device's proof that it holds its person's identity key: the identity key's Ed25519 signature
--     over the device's holder statement (`mls-identity-holder/v1`). The device posts it itself
--     (PUT /devices/me/holder-proof); the relay verifies it under the pinned key before storing it.
ALTER TABLE "devices" ADD COLUMN "holder_proof" BYTEA;

-- (2) A device asking for the identity key: `pair` (a new device the person confirms by number) or
--     `backfill` (a listed device that lacks the key). The relay stores the signed request, the two
--     pairing nonces and the key a holder SEALED to the device's one-time transfer key (HPKE
--     ciphertext only); it never opens anything. Times come from the relay's clock, so no defaults.
CREATE TYPE "identity_request_purpose" AS ENUM ('pair', 'backfill');

CREATE TABLE "identity_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "purpose" "identity_request_purpose" NOT NULL,
    "transfer_key" BYTEA NOT NULL,
    "commitment" BYTEA,
    "request_signature" BYTEA NOT NULL,
    "challenger_device_id" TEXT,
    "holder_nonce" BYTEA,
    "device_nonce" BYTEA,
    "list_version" INTEGER,
    "sealed_enc" BYTEA,
    "sealed_ct" BYTEA,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "challenged_at" TIMESTAMPTZ(3),
    "revealed_at" TIMESTAMPTZ(3),
    "approved_at" TIMESTAMPTZ(3),
    "rejected_at" TIMESTAMPTZ(3),

    CONSTRAINT "identity_requests_pkey" PRIMARY KEY ("id"),
    -- A pairing carries its commitment; a backfill never does (the signed bytes say which).
    CONSTRAINT "identity_requests_commitment_check" CHECK (("purpose" = 'pair') = ("commitment" IS NOT NULL)),
    CONSTRAINT "identity_requests_list_version_check" CHECK ("list_version" IS NULL OR "list_version" >= 1),
    -- The sealed key is stored whole or not at all.
    CONSTRAINT "identity_requests_sealed_check" CHECK (("sealed_enc" IS NULL) = ("sealed_ct" IS NULL))
);

CREATE INDEX "identity_requests_user_id_created_at_idx" ON "identity_requests"("user_id", "created_at");

CREATE INDEX "identity_requests_device_id_idx" ON "identity_requests"("device_id");

ALTER TABLE "identity_requests" ADD CONSTRAINT "identity_requests_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "identity_requests" ADD CONSTRAINT "identity_requests_challenger_device_id_fkey" FOREIGN KEY ("challenger_device_id") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;
