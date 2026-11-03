# 0004 — The relay owns the ciphertext, and speaks plain SQL

- **Status:** Accepted 2026-10-10.
- **Date:** 2026-10-10
- **Decided by:** the founder chose a separate relay process with its own database (gate G2 = B, 2026-10-07:
  the relay changes rarely, so a separate deployment costs little). The lead drew the consequences below the
  same day, before the relay's first line was written; the SQL decision was taken by the agent that built the
  relay and kept by the lead.
- **Builds on:** [0001](0001-e2ee-on-mls.md) §2 (what the relay may see) and
  [0002](0002-open-package-and-contracts.md) decisions 1 and 3.
- **Canon:** [`../canon.md`](../canon.md) §5 (what the relay sees).

## Problem

Where does an encrypted message live? The first sketch put a `ciphertext` column next to the plaintext one in
the host application's message table, with a database check that forbids text for encrypted rooms. Once the
relay became its own process (G2 = B), that sketch means two databases hold messages, the host's database
still has a table with a plaintext column, and the relay depends on the host's schema.

## Decision

1. **The relay owns the ciphertext.** Its own database holds: devices, signed device lists, key packages and
   their claims, conversations (group id, epoch), handshakes (commits, Welcomes, proposals), **envelopes**
   and room members. An envelope is `{conversationId, epoch, seq, senderDeviceId, ciphertext, createdAt}`.
2. **The host stores no message row for an end-to-end encrypted room.** It keeps a flag on the conversation
   (`e2ee`) and a last-activity time, updated by an internal event the relay emits. It learns that something
   happened, never what. Push for such a room is generic: "something new in room X".
3. **No plaintext column exists, by construction.** The relay's schema has none. A schema test reads the
   Prisma schema, the migration SQL and (given a database) the live catalogue, and fails the build if any
   column is named like text, body, content, message or payload; the API test also rejects a request that
   carries a `text` field. A rule that cannot be broken is better than a rule that is checked.
4. **The relay knows people only as a user id and a device id.** It does not know families, persons or roles
   beyond the device's role. The host issues a short-lived token carrying the user id, the device id and the
   scope of users an admin may act for (`adminOf`); the relay only verifies it. Verification is built; issuing
   is the host's next step. Interim tokens are HS256 with a shared secret and have no audience or issuer; the
   move to EdDSA with `aud`, `iss` and a short life is a condition before beta
   ([0005](0005-security-review-conditions.md)).
5. **One writer per epoch: the serializer.** MLS needs a single order of commits. For each conversation the
   relay takes a row lock (`SELECT … FOR UPDATE`) in one transaction, compares the epoch the client built on:
   a stale epoch gets `409 {currentEpoch}` and the client rebases; the fifth lost race in a row gets `429`.
   The next sequence number is `MAX(seq)+1` under unique constraints, so a number is never reused and an epoch
   only moves by one. The relay orders opaque bytes; **it does not validate cryptography. Clients do.**
6. **Readers are clipped to the epoch they joined in.** A new member gets no earlier envelopes (forward
   secrecy is real: there is nothing for the relay to hand over).
7. **Runtime SQL is plain `pg`; Prisma owns the schema and migrations only.** The boundary forbids a runtime
   ORM client in the open packages, and a reader can audit a few dozen visible queries faster than a generated
   client. Six `CHECK` constraints are written by hand in the migration. Tests run against a real Postgres
   (auto-created test database; skipped without one, a failure when `RELAY_TEST_REQUIRE_DB=1`); the database
   layer is never mocked.
8. **Development uses a separate database on the same development server.** How the relay is deployed,
   backed up and exposed in production is an infrastructure decision made outside this repository.

## Consequences

- A host that wants previews, search or statistics for an encrypted room must build them on the device. The
  server cannot, and that is the point.
- The history purge at the switch has a second half: after it, a nightly assertion confirms that no encrypted
  conversation in the host holds text or any derived copy (summary, embedding, extracted facts).
- Two databases, two migration histories, two backups. The cost was accepted with G2 = B.
- **The relay's epoch is not the MLS epoch.** Any member could post a garbage commit; the relay would advance,
  every client would reject it, and the room would answer `409` forever. Hence the header check and the
  declared member change in [0005](0005-security-review-conditions.md).
- The relay sees metadata: who, which room, which epoch, when, how large. "Sealed sender" is not claimed
  ([`canon.md`](../canon.md#honest-limits)).

## Rejected

- **A ciphertext column on the host's message table, with a check forbidding text.** Two homes for messages,
  a plaintext column that still exists, and a relay coupled to the host's schema.
- **The relay as a library mounted inside the host's process** (gate G2 = A). One deployment, but the server
  stays inseparable from the host and the claim "the server cannot read it" stays weaker.
- **Everything inside the host's messaging service, the boundary only on the client** (gate G2 = C). The
  server would remain closed; the openness claim would be half.
- **A runtime ORM client in the relay.** The boundary forbids it, and it adds a generate step and an opaque
  layer between the reader and the SQL.

## Review trigger

The first production deployment; any need for server-side features over encrypted rooms; the move of token
issuing into the host; a second relay operator; load that makes the row lock a bottleneck.
