# 0001 — End-to-end encryption for human chats on MLS · two zones · Masia is a visible opt-in member · one build

- **Status:** Accepted (design). An independent security review of this decision was integrated on
  2026-09-09 (see [Security review](#security-review)).
- **Amended by:** [0002](0002-open-package-and-contracts.md) decision 7 — history is **dropped** at switch-on
  instead of backed up (§6 below keeps the original text; the amendment wins).
- **Date:** 2026-09-09
- **Decided by:** the founder. Gates: ambition = D, Masia in an encrypted room = A, children = A, web and
  client = A′ (see [Options](#options)). On history: "we do not have to migrate it, a backup is enough"
  (later superseded by 0002: drop).
- **Why this ADR is published:** it is the design the code in this repository implements. The ADR as written
  for the host project referred to private neighbouring decisions and to deployment details; those are
  summarised in words here or left out. Nothing about the design was changed for publication.

## Problem

The messenger this package came from is **server-readable by construction**: Masia, an LLM assistant, sees
every message (per-conversation rules rewrite the delivered text, automatic translation, retrieval over chat
history, extracted facts, reminders). Signal is the opposite pole: the server stores ciphertext and almost no
metadata, and that is why security people trust it. To make the messenger a complete, safe product, one
question has to be answered honestly: **how can Masia read a chat that the server cannot read?** The answer
"it is end-to-end encrypted, but Masia reads everything" is privacy-washing, and a security reviewer will name
it first.

## Context

- Signal in 2026: PQXDH plus a post-quantum Triple Ratchet (10/2025), Private Groups v2, Sealed Sender,
  usernames, Secure Backups (a 64-character key that Signal cannot reset). Signal deliberately does **not**
  integrate an AI assistant (its president, 2025: an agent breaks end-to-end encryption).
- `@signalapp/libsignal-client` is **AGPL-3.0**, which disqualifies it for a closed SaaS client in the app
  stores. (This repository has since chosen an open client; the rejection stands for other reasons, see
  [Rejected](#rejected).)
- **MLS (RFC 9420)** is the IETF standard for group end-to-end encryption (Webex, Wire, Discord; RCS Universal
  Profile 3.0 brings cross-platform end-to-end RCS between Apple and Google, per secondary sources 2026-05 —
  a motivation, not a design dependency). Libraries: **mls-rs** (AWS, Apache-2.0 or MIT; WebAssembly through
  `mls-rs-crypto-webcrypto`, which **constrains the cipher suite**: WebCrypto's X25519/Ed25519 support is
  uneven, so a group could be forced onto a P-256 suite, and that binds native devices too — **verify in the
  first build step, before any code**), and OpenMLS (Rust, active). There is no native JavaScript stack, so
  the options are Rust compiled to WASM, or a pure-TypeScript library (measured later, see 0002).
- Keys never live in `localStorage` or IndexedDB as the only store: iOS Keychain, Android Keystore with
  StrongBox.
- Regulation: Chat Control 2.0 is not adopted (trilogue 06/2026; the interim regime to 04/2028 excludes
  end-to-end encryption — secondary sources); UK OSA s.121 is dormant; **COPPA-2025 (from 2026-04-22): an
  external LLM API is a third-party disclosure and needs separate parental consent**. That is a protective
  _reading_, not settled fact, and **needs counsel's sign-off before it becomes the gate that decides who may
  switch Masia on**. EU DSA Art. 28 asks for safe defaults for children.
- The host already had: a per-conversation Masia mode (ACTIVE, LISTENING, SILENT), a ready-made switch for
  "is Masia in the room"; "locked" chats that were adults-only with content-hidden push; per-family envelope
  encryption of media and credentials (at rest, **not** end-to-end); a handle-based contact system (a handle
  instead of a phone number, requests with consent through two gates, children invisible to strangers); one
  conversation per pair of people; refresh-token chains with reuse detection (⚠️ on reuse **all** of a user's
  tokens are revoked, so a token **cannot** be the anchor of a device, see §2); and an on-premises Masia Mind
  option, which closes the "Masia reads" dilemma at the strategic level.

## Options

### G1 — ambition

|       | Option                                                                                             | Cost                      | Verdict    |
| ----- | -------------------------------------------------------------------------------------------------- | ------------------------- | ---------- |
| A     | T0 (trust hygiene without cryptography) plus an ADR for T1 (locked chats only)                     | weeks, then a rewrite     | rejected   |
| B     | T0 plus T1 in code at once                                                                         | 6–10 weeks of one lane    | rejected   |
| C     | T0 only                                                                                            | "tidy", not "secure"      | rejected   |
| **D** | **Target T2: every human chat is end-to-end encrypted by default; ADR for T2 now; T0 in parallel** | a heavier ADR, no rewrite | **chosen** |

### G2 — Masia in an encrypted room

|       | Option                                                                                                                      | Verdict                                                  |
| ----- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| **A** | **Masia is a VISIBLE member, opt-in (Masia mode ↔ membership), plus an "ask Masia" relay with consent where she is absent** | **chosen**                                               |
| B     | relay only; Masia is never a group member                                                                                   | rejected — automatic translation and rules vanish wholly |
| C     | Masia always everywhere (end-to-end only against outsiders)                                                                 | rejected — privacy-washing                               |

### G3 — children

|       | Option                                                                                                                  | Verdict                                           |
| ----- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| **A** | **A parent is an authorised DEVICE on the child's account, disclosed to EVERYONE in the room (role in the credential)** | **chosen**                                        |
| B     | on-device signals only, no content                                                                                      | rejected (v1) — parents see "something", not what |
| C     | children's chats without end-to-end encryption (like Messenger Kids)                                                    | rejected — two classes of citizens                |

### G4 — web and client

|        | Option                                                                                                                                                               | Verdict                                           |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| **A′** | **ONE app build (web plus a Capacitor shell); the web is a device with weaker storage and an honest warning; the messenger is the ENTRY HOOK into the full product** | **chosen**                                        |
| B      | end-to-end encryption on native only                                                                                                                                 | rejected — the first feature without web          |
| C      | a separate desktop or messenger-only client                                                                                                                          | rejected — "why would we need a separate client?" |

## Decision

### 1. Two zones, honestly labelled — and what exactly we claim

- **Masia's zone**: AI chats, the primary conversation, service and notification conversations. Server-readable
  (as before). Header badge: "Masia reads this chat". All her abilities live here without limits.
- **People's zone**: direct and group conversations. **Target: text is end-to-end encrypted by default**; the
  server is a postman (key packages, ciphertext, epoch order). The badge is on the level of the ROOM and
  honest in parts: "text is encrypted, media we can read". Until the media path (§6) ships, "encrypted by
  default" is **not** claimed.
- **Metadata is claimed honestly:** "the server sees who, to whom and when — never the content". The term
  "sealed sender" is **not** used in this design: the sender authenticates with a bearer token, and the
  message log's person and family ids and the delivery rows' recipient id are indexed foreign keys.
  Unlinkable delivery credentials (as in Signal) would be a separate decision if ever. Metadata retention
  (§2) is named, not "somehow".
- **The "end-to-end" claim is allowed ONLY for people's zone, ONLY about text, and ONLY when no server-side
  Masia holds the room key.** We never write "end-to-end" about an AI chat.

### 2. Crypto stack and models

- **MLS (RFC 9420) through `mls-rs`** compiled to WASM for the web and WebView (Vite), the same crate natively
  through a plugin if WASM in the WebView is slow on groups over 20 or the WebCrypto suite is unacceptable
  (first step: measure and record the cipher suite BEFORE code). **Not** libsignal (AGPL), **not** Olm/Megolm
  (libolm is deprecated; MLS has native groups). _Superseded in part by 0002 decision 6: the first candidate
  is now the pure-TypeScript `ts-mls`, with `mls-rs` as the measured fallback._
- **A device is a first-class model, not a token.** `Device { id (stable per install; the same device id the
host already sends with every request and stores on its refresh tokens), userId, name, platform,
identityKeyPub, signatureKeyPub, role: USER | GUARDIAN | MASIA, createdAt, revokedAt }`. A refresh token
  points at a `Device` (not the other way round): tokens rotate and are all revoked on reuse, and that must
  never detach MLS leaves. `KeyPackage { deviceId, packageBytes, lastResort Boolean, consumedAt }`.
- **A group is a conversation.** `ConversationE2ee { conversationId, groupId, epoch, treeHash }`;
  `MlsHandshake { conversationId, epoch, seq, kind, bytes }` in STRICT order — the server serialises epochs (a
  conflict returns 409, the client rebases, **with a rebase limit**, after which the UI shows a security
  state).
- **Protection against forking or withholding by the serializer:** every application message carries
  `epoch + treeHash` in its AAD, so a divergent view of the group fails on the FIRST message. **A decryption
  failure is a security event with a visible room state** ("keys have diverged — check your devices"), not a
  spinner and not a silent retry.
- **Messages.** For encrypted conversations the plaintext column is NULL (nullable, plus a CHECK constraint:
  _text IS NULL for encrypted conversations_ is a database invariant, not a convention); `ciphertext Bytes`,
  `e2eeEpoch Int`, `senderDeviceId`. The server sees the conversation id, the sender, the recipients and the
  time.
- **Key-package hygiene:** a mandatory `lastResort` package per device; packages are handed out ONLY to
  accepted contacts (the consent gate) and with a per-requester rate limit — otherwise draining the pool is a
  trivial denial of service and a presence oracle on handles.
- **Keys on the client**, split by access class: the identity/history key in iOS Keychain
  `WhenUnlockedThisDeviceOnly` (behind an optional app lock) or Android Keystore with StrongBox; the sub-key
  that decrypts a push is `AfterFirstUnlockThisDeviceOnly`. MLS state lives in SQLCipher (native) or in
  IndexedDB under a WebCrypto non-extractable key (web — see §5: that protects a disk image, **not** against
  XSS).
- **Media** (a separate path, §6): content is encrypted on the client with a per-message key (AES-256-GCM,
  AAD = messageId + conversationId), stored in object storage as an opaque blob; the key travels inside the
  MLS message.
- **Backup and recovery:** the model of Signal Secure Backups — history is encrypted **on the client** under
  a 64-character recovery key (the server does not know it and cannot reset it); free = text, paid = media.
  **The blast radius is history only, never access to the account.** Losing the key loses history — the UI
  says so at generation and at linking; a plain export to the device is a mandatory offer, not "optional".
  _Amended by 0002 decision 7: in the first phase there is no backup and no recovery key; history is dropped
  at switch-on, and the key arrives with media backups._
- **Forward secrecy** is native to epochs. **Post-compromise security is NOT "rotation once every 7 days by
  anyone":** MLS heals a compromise only when the COMPROMISED leaf itself makes an Update. So every device
  commits its own self-Update on a schedule (at least on every app open after 24 hours or more, and weekly),
  while Add and Remove start a new epoch immediately.
- **Metadata retention:** delivery rows (delivered, read) and the conversation's last-message time are a social
  graph with timestamps. The TTL for delivery rows of encrypted conversations is 30 days. A push for an
  encrypted room has a generic body; the sender's name is resolved on the client.

### 2a. Key transparency — the answer to the operator's "ghost device"

The server owns the KeyPackage directory and the serializer, so a malicious operator could publish "a new iPad
for Alice", commit an Add and read the room. The defence is not an alert in the chat but **client-side
verification of the device list:**

- every user has a long-lived **identity key** with which they SIGN their own device list
  (`DeviceList { userId, devices[], version, sig }`). A correspondent's client pins that key at first contact
  (trust on first use) and accepts only signed changes. A room's roster is computed from the MLS tree and
  checked against the signed lists — an Add of a leaf that is not in its owner's signed list is **rejected by
  the client**;
- a new device is a **permanent system line in the transcript** (not a dismissible toast), and sending to that
  room is blocked until one explicit "OK, this really is her new device" (the lesson of iMessage contact key
  verification: automatic, but not silent);
- a safety-number comparison of identity keys sits in the overflow menu for those who want it; a
  key-transparency log (as at Apple and WhatsApp) is a review trigger, not version one.

### 3. Masia in the room (G2 = A) — and where her key lives

- **Masia has her own `Device` with role MASIA — the key is NOT one for all families.** Her leaf is
  **per conversation**; the private keys live in a **separate custody service** (its own process or host,
  outside the database and the API process of the messenger; or an on-premises box) which hands only decrypted
  text to the LLM pipeline of one specific room. An RCE or a dump of the messenger's database opens no room.
  Header badge: "Masia is here — her key is on our server", not "end-to-end".
- Masia mode other than SILENT for an encrypted conversation ⇔ Masia is a member of the MLS group. Switching is
  an MLS Add or Remove (a new epoch): switched on, she reads ONLY from that moment; switched off, she cannot
  read from the next epoch. In rooms that include a child the default is **SILENT** (Masia is not a member),
  and switching her on is a parent-level action.
- **The roster is honest:** Masia is in the member list, with a system line at every change. Automatic
  translation, per-conversation rules and modified text, retrieval over the chat, server-side search, and
  reminders from context exist **only** while she is a member. Where she is not, those features are ABSENT
  from the UI.
- **The "ask Masia about this" relay** (rooms without Masia) needs **the same consent as membership:** a
  parent's gate for minor participants, an explicit dialogue for adults. The relay is **ephemeral** (no fact
  extraction, no embedding, a TTL on the answer), and **in an encrypted room it produces a system line**
  "Alice showed a message to Masia" — the other participants see that content left the room. It is policy, not
  cryptography, and the UI never dresses it up as end-to-end encryption.
- **On-premises:** Masia's custody service on a box at home — the same mechanism, a different physical address
  for the key. That is the complete "never phones home".

### 4. Children (G3 = A) — the guardian leaf is visible to EVERYONE

- A parent is added as a `Device` with role **GUARDIAN** on the child's account — a leaf in the same tree. The
  role travels in the MLS credential or extension, so **every participant of the room** (a child from another
  family and her parents) sees a permanent badge, "👁 a guardian of Alice reads this room". A silent addition
  of a guardian is rejected by the server and by clients. This closes the inverted COPPA/DSA risk: parent A
  does not read child B without B's and B's parents' knowledge.
- It is removed only by the admin of the child's family; the child cannot remove a guardian leaf (the
  serializer rejects a Remove proposal for a GUARDIAN from the child's device).

### 5. One build, the messenger is the hook (G4 = A′) — and the honest sentence about the web

- No separate client: the app runs on the web and in a Capacitor shell. On the web the browser is a full
  device with weaker storage; at linking there is a warning **in words of the threat, not of the mechanism:**
  "any XSS or malicious dependency in a web app can read your messages; for locked chats we advise the
  phone". A non-extractable WebCrypto wrapper protects a disk image, not against a script in the same page.
  So the web build has a **strict CSP** (no `unsafe-inline` or `unsafe-eval`; `wasm-unsafe-eval` only for
  MLS), SRI, and zero third-party scripts. That is an invariant a guard checks on every build.
- **The messenger is the entry point into the product:** family and friends come for the free end-to-end chat;
  the rest (Masia, tasks, knowledge, screen time) is connected at will. Free end-to-end family chat is the top
  of the funnel; Masia is paid.

### 5a. Revoking a device is an MLS Remove, otherwise it is theatre

Revoking a refresh token does **not** remove the leaf from the groups — a stolen device would keep reading new
epochs. So "sign out of a device" is (1) another device of this user (or the family admin, if it was the only
one) commits a **Remove** of its leaf from EVERY group, (2) only then the session is revoked, (3) the signed
`DeviceList` is updated (§2a). The same path serves a "This isn't me" card.

### 6. One switch for all text · history is a backup, not a migration (founder, 2026-09-09)

> **Amended by 0002 decision 7:** history is **dropped**, not backed up. The purge of text and every derived
> copy, and the system line, stand; the client-side backup, the recovery key and the 30-day window described
> in the second and third bullets are replaced by "no backup in the first phase". The text below is the
> original, kept for the record.

- **All human conversations switch TOGETHER** — direct and group, including groups where Masia is already a
  member (Masia mode other than SILENT → her device is simply one more leaf and reads from the first epoch;
  for rooms with children the default is SILENT, §3). No stages "locked, then direct, then group": locked
  chats are only the first TEST channel in development and beta. Outside the switch: **media** and **calls**
  (other paths: client-side encryption of blobs in object storage · SFrame/MLS keys for WebRTC — a separate
  decision). Until then media in an encrypted conversation goes through the host's per-family envelope with
  the honest room badge "text is encrypted, media we can read" (§1).
- **History is NOT migrated.** Original: "a backup is enough". Mechanism: before the switch each family got a
  one-time backup — **assembled and encrypted ON THE CLIENT** under a recovery key (§2; the server never
  builds the archive, or it would hold the key) — plus a mandatory offer of a plain export to the device.
  **The purge is per conversation, and only when EVERY participating family has finished its backup or
  explicitly declined** (a cross-family direct chat has two windows — family A's clock has no right to erase
  family B's un-backed-up history). A window of at least 30 days with reminders.
- **The purge erases DERIVED data, not only `text`.** Plaintext also lives in the conversation summary, the
  conversation embedding, the ids of extracted facts, memories and sources attached to each message, the
  per-recipient modified text, source rows, prompt traces in a cache, and **copies at the LLM provider**. The
  purge job enumerates and erases or re-scopes every class for the conversation; a column records the moment
  of the purge; a **nightly assertion** "no encrypted conversation has non-NULL text, summary or embedding"
  alerts the operators. The line on the privacy page after the purge: "human chats: ciphertext · who reads:
  nobody" — **with an asterisk about provider copies until a retention agreement with the provider exists**.
- Conversations start from a clean epoch; the system line is "encryption is on, history before this point is
  in the backup". The server never touches plaintext to "encrypt later" — ever.

## Consequences

- **Gone where Masia is absent:** automatic translation, rules, retrieval over the chat, server-side search of
  history, modified text, LLM moderation. This is a deliberate price; the UI explains it with a badge, not
  with silence.
- **New domains:** `Device` (first-class, roles USER/GUARDIAN/MASIA), `DeviceList` (signed), `KeyPackage`
  (plus last-resort), `ConversationE2ee`, `MlsHandshake`; an epoch serializer in the messaging service; the
  **custody service for Masia's keys** (separate process or host); a WASM build of `mls-rs` (one home for
  crypto); a native key-storage plugin for the mobile shell; the derived-data purge job; a CSP guard on the web
  build.
- **Recovery key** — a new class of support ("lost the key = lost history, not the account"); its generation
  and storage UX is a separate design step. _(Deferred by 0002.)_
- **Claims:** "we cannot read your family chat" only after the switch, after the purge of derived data, and
  with an asterisk about the provider; the privacy page shows it. Before that: "server-readable, end-to-end in
  development".
- **Security review of the ADR** — an independent critic pass was done on 2026-09-09 (below); a full
  `/security-review` is open; the threat model is to be repeated on the execution plan.

## Trade-offs

- The web as a "weaker device" rather than a ban: the XSS and dependency risk is accepted on purpose (CSP, SRI,
  zero third-party scripts, a warning in words of the threat), because the founder does not want a second
  client and features without web.
- MLS instead of "the Signal protocol": a less formally verified ratchet for pairs, but native groups, an
  IETF standard, a permissive licence. Post-quantum (ML-KEM) comes through the cipher suite when the library
  stabilises it (not a blocker); a WebCrypto suite may bind native to P-256 — measured in the first step.
- A Masia device with its key in our custody is trust in the operator of Masia in rooms where she was invited.
  It is stated honestly, the key is per conversation and outside the messenger's database, and that is why
  on-premises custody is a strategic axis and not an option "for geeks".
- The server sees metadata (who, to whom, when). Without anonymous credentials that cannot be hidden; we say
  so plainly.

## Rejected

- `@signalapp/libsignal-client` (AGPL) · self-hosting Signal-Server · federation · a phone number as an id ·
  SGX contact discovery (we use a handle plus requests with consent) · Private Groups v2 / KVAC · "sealed
  sender" as a claim without unlinkable credentials · TEE or "private processing" as a way for "Masia reads
  but nobody reads" (on the radar) · retro-encrypting history on the server · a server-built backup · a
  staged release "locked → direct → group" · migrating history into the encrypted store · Masia in all rooms
  always · one Masia key for all families · native-only end-to-end encryption · a separate client · "screenshot
  blocking on iOS" as a promise (there is no API; only detection or an overlay; Android `FLAG_SECURE` works).

## Security review

Date 2026-09-09, an independent critic pass. What changed in this ADR as a result:

| #   | Finding                                                                                                                                         | Where it went                                                                                                |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| C1  | purging `text` leaves derived data (summary · embedding · fact ids · modified text · sources · provider) → "who reads: nobody" is a false claim | §6 purge of derived data, a purge-moment column, a nightly assertion, an asterisk about the provider         |
| C2  | no key transparency → the operator adds a "ghost device"                                                                                        | §2a signed DeviceList · TOFU identity key · the client rejects a foreign Add · permanent line and send block |
| H1  | "sealed sender" is impossible with bearer tokens and indexed foreign keys                                                                       | §1 term dropped; metadata claimed honestly                                                                   |
| H2  | one server key of Masia for all families                                                                                                        | §3 per-conversation leaves · a separate custody service · badge "key on our server"                          |
| H3  | the guardian leaf is invisible to a correspondent from another family                                                                           | §4 GUARDIAN role in the credential, badge for EVERYONE                                                       |
| H4  | the "ask Masia" relay bypasses the consent gate                                                                                                 | §3 the same gate · ephemeral · system line in the room                                                       |
| H5  | the serializer can withhold or fork epochs                                                                                                      | §2 `epoch + treeHash` in AAD · decrypt-fail is a security state · rebase limit                               |
| H6  | draining KeyPackages = denial of service plus a presence oracle                                                                                 | §2 lastResort · handed out to contacts only · rate limit                                                     |
| H7  | a non-extractable key does not protect against XSS                                                                                              | §5 threat-words sentence · CSP, SRI, zero third-party scripts                                                |
| H8  | token revocation ≠ Remove of the leaf; post-compromise security not through "rotation by anyone"                                                | §5a Remove before revocation · §2 per-device self-Update                                                     |
| H9  | a server-side backup = the server holds the key; a cross-family purge erases another family's history                                           | §6 client-side archive · per-conversation purge with consent of all families · NULL plus CHECK               |
| M1  | the refresh token is a wrong anchor for a device                                                                                                | §2 first-class `Device`, the token points to it                                                              |
| M2  | one Keychain class for everything                                                                                                               | §2 split keys (history `WhenUnlocked…`, push `AfterFirstUnlock…`)                                            |
| M3  | metadata retention is not named                                                                                                                 | §2 30-day TTL for delivery rows · generic push                                                               |
| M4  | recovery-key blast radius                                                                                                                       | §2 history only, never the account; export is a mandatory offer                                              |
| M5  | media under the family envelope in a room with an end-to-end badge                                                                              | §1/§6 badge "text is encrypted, media we can read"; "encrypted by default" not claimed before the media path |
| —   | `mls-rs` WASM ⇒ cipher-suite constraint; the COPPA reading needs counsel; iOS screenshot blocking does not exist                                | Context · Rejected · a flag for legal                                                                        |

The critic's verdict: "an honest intent and the right shape (two zones · a visible member · no migration); NOT
acceptable as written — three false claims and no answer to the ghost device." All three claims and the ghost
device are closed above; the rest is plan-level.

## Review trigger

After the switch in production: re-measure WASM performance and the actual cipher suite, the share of families
with a lost recovery key, the number of "ask Masia" relays against Masia-as-member switch-ons, and the number
of Adds rejected by clients (§2a). A key-transparency log — when a second operator appears or at more than 1k
families. If Chat Control or the OSA change — return to §1 (claims) and §3 (consent).
