-- R2-A2 (2026-10-10, internal ADR-117 amendment (к), TODO-504 (a)(c)). Additive only: two new
-- tables, each back-filled from what is already stored; nothing is dropped or rewritten.
--
-- (a) Every version of a user's signed device list, append-only. A member that pinned version N must
--     read every newer version and check the chain (canon §3), so the relay can no longer keep the
--     latest only. `device_lists` stays the CURRENT list (the add-device rule reads it); both are
--     written in one transaction.
CREATE TABLE "device_list_versions" (
    "user_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "devices_json" JSONB NOT NULL,
    "signature" BYTEA NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_list_versions_pkey" PRIMARY KEY ("user_id", "version"),
    CONSTRAINT "device_list_versions_version_check" CHECK ("version" >= 1)
);

INSERT INTO "device_list_versions" ("user_id", "version", "devices_json", "signature", "created_at")
SELECT "user_id", "version", "devices_json", "signature", "updated_at" FROM "device_lists";

-- (c) One identity key per PERSON: the key that signs their device list, pinned by the first USER
--     device they register. A USER device with another key is refused (409 IDENTITY_KEY_CHANGED); the
--     pin is released only by the explicit reset (DELETE /users/{userId}/identity-key). Back-filled
--     from each user's oldest active USER device.
CREATE TABLE "identity_keys" (
    "user_id" TEXT NOT NULL,
    "identity_key_pub" BYTEA NOT NULL,
    "pinned_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "identity_keys_pkey" PRIMARY KEY ("user_id")
);

INSERT INTO "identity_keys" ("user_id", "identity_key_pub", "pinned_at")
SELECT DISTINCT ON ("user_id") "user_id", "identity_key_pub", "created_at"
FROM "devices"
WHERE "role" = 'USER' AND "revoked_at" IS NULL
ORDER BY "user_id", "created_at", "id";
