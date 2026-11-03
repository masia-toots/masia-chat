-- R-G2 (2026-10-11, internal ADR-117 amendment (о), TODO-518). DATA ONLY, no DDL: `identity_keys`
-- already exists (R2-A2, 20261010190000), and nothing is dropped or rewritten.
--
-- The relay pinned an identity key only for USER devices. The operator principal registers only
-- ASSISTANT devices, so `GET /users/<operator>/devices` returned `identityKeyPub: null` and a member
-- (the hub) had nothing to verify the operator's signed device list by. From now on the FIRST
-- ASSISTANT device of an account pins its key exactly like the first USER device does (same table,
-- same 409 IDENTITY_KEY_CHANGED on a later device with another key, same explicit reset).
--
-- Back-fill, the rule R2-A2 used for USER: every account that holds no pin yet and has at least one
-- ACTIVE ASSISTANT device gets the key of its OLDEST active ASSISTANT device. An account that already
-- has a pin (a USER device pinned it) keeps it; revoked devices never pin; GUARDIAN devices neither.
-- Re-running it changes nothing (the NOT EXISTS and the primary key).
INSERT INTO "identity_keys" ("user_id", "identity_key_pub", "pinned_at")
SELECT DISTINCT ON (d."user_id") d."user_id", d."identity_key_pub", d."created_at"
FROM "devices" d
WHERE d."role" = 'ASSISTANT'
  AND d."revoked_at" IS NULL
  AND NOT EXISTS (SELECT 1 FROM "identity_keys" k WHERE k."user_id" = d."user_id")
ORDER BY d."user_id", d."created_at", d."id"
ON CONFLICT ("user_id") DO NOTHING;
