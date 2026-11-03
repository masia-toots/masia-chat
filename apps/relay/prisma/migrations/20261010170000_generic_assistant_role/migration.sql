-- Review round 1 D (2026-10-10, internal ADR-117 amendment (d)): the wire names no product.
-- The third device role was spelled after the reference host's product; it becomes the generic
-- ASSISTANT before 1.0. A rename of the enum value, not a new one: existing rows keep their role
-- (same meaning, same credential byte code 3), and nothing else changes.
ALTER TYPE "device_role" RENAME VALUE 'MASIA' TO 'ASSISTANT';
