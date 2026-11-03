-- A device's key-package pool never holds the same bytes twice.
--
-- Why: a client that retries an upload (a lost response, a restart in the middle) sends the same
-- KeyPackage again. Stored twice, the second copy is handed to a second claimer, and two groups then
-- add the device with one init key: an MLS KeyPackage is single use. The upload also reported the copy
-- as "uploaded" and counted it as "available", so the client believed in a pool it did not have.
--
-- How: a unique index on (device, SHA-256 of the bytes). A hash and not the bytes themselves, because a
-- B-tree entry has a size limit that a large KeyPackage can exceed; a SHA-256 collision between two
-- packages of one device is not a case worth a thought. The index covers consumed rows too (they are
-- kept for the retention window), so a package that was already handed out cannot come back as new.
-- The upload does `INSERT ... ON CONFLICT DO NOTHING` and reports only the rows it really stored.
--
-- Prisma's schema language cannot express an expression index, so this index lives here and is
-- documented on the model; `prisma migrate` leaves indexes it cannot model alone.

-- 1. Collapse the duplicates that already exist. Within a (device, bytes) group the survivor is the
--    last-resort row (a device must keep its last resort), else the one that has been handed out
--    (consumed), else the oldest.
--    First the claim records of the rows that go are re-pointed at the survivor, so the record of
--    "this device claimed this package" (which a commit's declared Add is checked against) is kept.
INSERT INTO "key_package_claims" ("key_package_id", "claimer_device_id", "claimed_at")
SELECT r."keep_id", c."claimer_device_id", c."claimed_at"
FROM "key_package_claims" c
JOIN (
  SELECT "id",
         first_value("id") OVER (
           PARTITION BY "device_id", sha256("bytes")
           ORDER BY "last_resort" DESC, ("consumed_at" IS NOT NULL) DESC, "created_at", "id"
         ) AS "keep_id"
  FROM "key_packages"
) r ON r."id" = c."key_package_id"
WHERE r."keep_id" <> r."id"
ON CONFLICT ("key_package_id", "claimer_device_id") DO NOTHING;

-- 2. Delete the rows that lost (their claim records go with them: ON DELETE CASCADE).
DELETE FROM "key_packages" p
USING (
  SELECT "id",
         first_value("id") OVER (
           PARTITION BY "device_id", sha256("bytes")
           ORDER BY "last_resort" DESC, ("consumed_at" IS NOT NULL) DESC, "created_at", "id"
         ) AS "keep_id"
  FROM "key_packages"
) r
WHERE p."id" = r."id" AND r."keep_id" <> r."id";

-- 3. From now on the database refuses a second copy.
CREATE UNIQUE INDEX "key_packages_device_id_bytes_sha256_key"
  ON "key_packages" ("device_id", sha256("bytes"));
