# Canon: the open Masia messenger

What this messenger is and why it is shaped the way it is. The code says _how_; the decisions that fixed
the shape, with the alternatives we rejected, are in [`adr/`](adr/README.md).

**Status: skeleton, version 0.0.1.** The ports, the boundary and the documents exist, and so do the
client's data and hooks and the UI core of the human chats (the conversation, the channel bank, the
contacts menu, the devices list; see [section 6](#6-the-boundary-and-the-ports)). The MLS engine exists too ([section 9](#9-the-mls-engine)); the relay's storage and the
host wiring are being built to the design below (the web host runs the engine in a Worker since 2026-10-10,
[section 11](#11-the-hosts-engine-a-worker-and-what-this-device-means)). Where a statement describes something not built yet,
it says "target"; [`context.md`](context.md) has the exact state.

## How to read this canon

This file is the **spec**: what the messenger is and why it is shaped this way. It is not the place for how
(the code), for a decision with its rejected alternatives (the records in [`adr/`](adr/README.md)), for the
chronology ([`log.md`](log.md)) or for the state of the work ([`context.md`](context.md)). Where the canon
and the code disagree, one of them is wrong and is fixed in the same change.

| If you want                                                       | Go to                                |
| ----------------------------------------------------------------- | ------------------------------------ |
| The map: packages, ports, data flow, the E2EE model on one screen | [`ARCHITECTURE.md`](ARCHITECTURE.md) |
| What is built, what comes next, what is undecided                 | [`context.md`](context.md)           |
| How the project is run: plan, gates, agents, reviews, commits     | [`protocol.md`](protocol.md)         |
| Why a choice was made, what was rejected                          | [`adr/README.md`](adr/README.md)     |
| What building it taught us                                        | [`experience.md`](experience.md)     |
| What happened, in order                                           | [`log.md`](log.md)                   |

Read the one-page summary first, then only the section for the area you touch. Sections 1 to 5 are the
product and its security claims; 6 is the boundary and the ports; 7 and 8 are the licences and the library;
9 is the engine, 10 what travels inside the ciphertext, 11 how a host runs the engine;
"Honest limits" is what we do not claim. A few statements are marked as under review; those are the proposals
of [ADR 0005](adr/0005-security-review-conditions.md), not yet decided.

## In one page

- **A messenger for people**, direct chats and groups, whose text is end-to-end encrypted with MLS
  (RFC 9420). The server is a postman: it delivers ciphertext and key packages and cannot read a message.
- **Two zones**, honestly labelled: conversations with Masia (the AI assistant) are readable by the server
  and say so; conversations between people are the end-to-end zone. [Section 1](#1-two-zones)
- **Masia is a visible, opt-in member**, never a silent reader: she joins a room only when invited, shows
  in the roster, and can be removed again. [Section 2](#2-masia-is-a-visible-opt-in-member)
- **Devices are first-class**, not login tokens. A person's devices are listed in a **signed DeviceList**;
  a client accepts a new device only if it appears in that signed list. [Section 3](#3-devices)
- **A guardian device is visible to everyone** in the room, including people from other families. [Step 5](#3-devices)
- **Revoking a device is an MLS Remove first, then the session revoke**, never the other way round. [Step 7](#3-devices)
- **History is dropped at switch-on**, not migrated; nothing is silently carried over. [Section 4](#4-history-at-switch-on)
- **The web is a weaker device**, and we say so in the words of the threat, not of the mechanism. [Step 4](#3-devices)
- **MLS sits behind our own interface** and a receive-side validator that does not trust the library: it
  re-checks every commit and Welcome against the signed device lists, the roles and the removal policy.
  [Section 9](#9-the-mls-engine)
- **The package knows nothing about its host.** It talks to the world through the ports in
  `@masia/contracts`, and a CI guard fails on any other import. [Section 6](#6-the-boundary-and-the-ports)
- **The wire speaks of a household, with generic names.** Devices have roles (USER, GUARDIAN,
  ASSISTANT), a token can name whom its holder administers and guards, and one operator principal owns
  every assistant device. All of it lives in one module, `@masia/contracts/wire`.
  [Roles and principals](#roles-and-principals-the-household-model-in-the-wire)

## Why it is open

Encryption you cannot inspect is a marketing claim. Trust in a messenger such as Signal comes from code
anyone can read, and from a server that is open too, so that what it _cannot_ do is visible. We want to
make the claim "we cannot read your chat" and let you check it. So this repository is meant to be read
first: human names, decisions written down with their rejected alternatives, and the places where we are
weaker than the headline said out loud ([Honest limits](#honest-limits)).

## Vocabulary

For readers new to MLS:

- **Group**: the set of devices that can read a conversation. One conversation is one MLS group.
- **Leaf**: one device's place in the group's key tree. One device, one leaf.
- **Epoch**: the group's key state; every Add, Remove or Update starts a new epoch. A device removed in
  epoch _n_ cannot read epoch _n+1_.
- **Key package**: a one-time public bundle a device publishes so others can add it to a group.
  A **last-resort** key package is a reusable fallback so the pool can never be exhausted into a denial of
  service.
- **Commit**: the message that applies an Add, Remove or Update and starts the next epoch.
- **Self-Update**: a device refreshing its own leaf key. Post-compromise security heals only when the
  compromised leaf itself does this.

## 1. Two zones

Every conversation is in exactly one zone, and the room says which.

- **Masia's zone**: conversations with Masia herself, plus service and notification conversations. The
  server can read these, as it always could, because Masia's abilities (memory, search, tools) need the
  text. The header says "Masia reads this chat". The words "end-to-end" are never used about this zone.
- **People's zone**: direct and group conversations between people. Target: text is end-to-end encrypted by
  default.

What we claim, and what we do not:

- "End-to-end" is claimed only for people's zone, only for text, and only while no server-side Masia holds
  a key to the room.
- Until media is encrypted on the client too, the room badge speaks in parts: "text is encrypted, media we
  can read". "Encrypted by default" is not claimed before then.
- "Sealed sender" is not claimed. See [section 5](#5-what-the-relay-sees).
- "We cannot read your chat" is claimed only after the one-time switch-on, after every derived copy of the
  old plaintext has been purged ([section 4](#4-history-at-switch-on)), and with an asterisk for any copy that
  reached an LLM provider while the room was in Masia's zone.

## 2. Masia is a visible, opt-in member

- Masia is a **device with its own role** and a member of the MLS group like any other. On the wire that
  role is the generic `ASSISTANT` (one host's assistant is Masia; the host makes that mapping, the protocol
  does not; _until 2026-10-10 the wire named the role `MASIA`_). She is not a silent reader and not a
  server-side "assistant mode" flag.
- A room's "Masia mode" and her membership are one fact. Any mode other than silent means she is in the
  group; silent means she is removed. Switching her on is an MLS Add: she reads from that moment only.
  Switching her off is a Remove: she cannot read any later epoch. The mode that counts is the **effective**
  one, the mode the room acts in, never the column that stores the wish (see the phase rule below).
- Rooms that include a child default to silent. Turning her on there is a parent-level action.
- **Phase 1: she is in no end-to-end encrypted room (ADR-117 amendment (с); decision 2026-10-11).** Whatever a
  room has saved, an encrypted room acts silent: the host reports silent in its snapshots and in the room list,
  provisions no custody device for it, queues no work for her, and the web client neither claims her key
  package nor builds an Add for her. Nothing is raised as an error: the security view says "Masia is not in
  this chat", the features that need her stay off with the reason worded in the bullet on plaintext features
  below, and an `@masia` mention in such a room is sent like any line and the writer is told she joins
  encrypted chats later. There is no feature flag: the rule is one
  function in the shared package (`masiaModeForPhase`), and lifting it is a one-line change made by the plan
  that builds what is listed next.
  - _Built today:_ the effective-mode rule on the host and in the client; the silent snapshot, the empty
    "rooms that want her" answer and the absent triggers; the client leaving her out of the Add and the
    notice; the mention hint; the custody worker, which idles when no room wants her and takes a device it
    already holds out of a room that turns silent.
  - _Not built (the reason this is a phase, not a flag):_ a real guardian policy in the clients. Until the
    directory can tell ages and guardians, the client's policy treats every member as a minor and nobody as
    an administrator, so the engine would refuse every Add of her device anyway. Also not built: a single
    limit for her replies (the host and the worker disagree), sealing her reply job at rest, an atomic "take
    this message once", and a cheap room buffer. Saved modes also need a decision before the rule is lifted:
    the column's default is "active", so every encrypted room would otherwise get her silently on that day.
- The roster is honest: she appears in the member list, and every change is a system line in the thread.
- Her key is **per conversation**. The private keys live in a separate custody service, outside the
  messenger's database and API process, which hands decrypted text only to the pipeline of that one room. A
  database dump or a remote-code-execution in the messenger therefore opens no room. The header says "Masia
  is here, her key is on our server", not "end-to-end".
- Features that need plaintext (automatic translation, rules, server-side search, retrieval, reminders drawn
  from context) exist **only while she is a member**. Where she is not, those controls are absent and the UI
  explains why; they are never silently broken.
- "Ask Masia about this message" in a room she is not in needs the **same consent as membership** (a
  parent's gate for minors, an explicit dialogue for adults). It is ephemeral (no facts extracted, no
  embedding, a short-lived answer) and leaves a system line, "Alice showed a message to Masia", so everyone
  can see that content left the room. This is policy, not cryptography, and the UI never dresses it up as
  encryption.
- Self-hosting (her custody on a box you own) uses the same mechanism at a different physical address.

## 3. Devices

A device is a first-class object, not a login token.

```
Device { id, userId, name, platform, identityKeyPub, signatureKeyPub,
         role: USER | GUARDIAN | ASSISTANT, createdAt, revokedAt }
```

_Until 2026-10-10 the third role was spelled `MASIA`; it is the same role under a generic name
(architecture review round 1, M15), the credential byte is unchanged._

- `id` is stable per install and is the same device id the host already sends with every request. Session
  tokens point at the device, not the other way round: tokens rotate, and are revoked wholesale on reuse
  detection, and that must never detach an MLS leaf.
- Each device is one MLS leaf.
- A person's **DeviceList** is the list of their devices, **signed by their long-lived identity key**.
  A correspondent's client pins that key at first contact (trust on first use) and accepts only signed
  changes. A room's roster, computed from the MLS tree, is checked against the signed lists: an Add of a leaf
  that is not in the owner's signed list is **rejected by the client**. The server cannot add a device on
  anyone's behalf, which closes the "ghost device" attack by a malicious operator.
- **The list format and its verifier have ONE home** (since 2026-10-10, round 2 arch-M3; ADR-117 amendment
  (і); the encoding and the signature check moved down to the wire contracts on 2026-10-11, ADR-117 amendment
  (п), so that the relay uses the very same code): `@masia/contracts/wire` `device-list.ts`. The signed bytes
  are `deviceListSigningBytes`: a
  fixed-order JSON `{format: "mls-device-list/v1", userId, version, devices}` with the entries sorted by
  id, each `{id, role, signatureKey (base64), conversationId (ASSISTANT only)}`: the assistant binding is
  INSIDE the signed bytes. The identity key is Ed25519 (WebCrypto; raw 32-byte public key).
  `verifyDeviceListSignature` checks the signature; `@masia/messenger/mls` `device-list.ts` adds what only a
  member can judge: `verifyDeviceList(userId, served, pin)` refuses a bad signature, another owner, a version
  below the pin or the same version with other contents (rollback), and malformed entries; every member (a
  person's hub, an assistant worker, a guardian) verifies with it and nothing else.
  **The relay verifies the signature too, before it stores a version** (since 2026-10-11, ADR-117 amendment
  (п)): `POST /users/me/device-list` is checked with the same `verifyDeviceListSignature` against the
  identity key pinned for the account, in the same transaction as the write; a list that does not verify (or an
  account with no pinned key) is 422 `DEVICE_LIST_SIGNATURE_INVALID`, entries no member could accept are 422
  `DEVICE_LIST_ENTRY_INVALID`. Members still verify what they are served; the relay is not trusted for it. The
  check exists because every reader verifies the whole chain of versions from the one it pinned: one stored
  version nobody can verify would block the list for everyone, for good, and any active device of the account
  could upload it without holding the identity key.
  The assistant's **operator list** is the same format under the same verifier (since 2026-10-11, ADR-117
  amendment (н)): the operator key signs it the way a person's identity key signs theirs, each ASSISTANT entry
  carries its `conversationId` on the wire and inside the signed bytes, and there is no second format. One signed
  list holds at most 64 entries (`MAX_DEVICES_PER_USER`), so the operator serves at most 64 live assistant
  devices at a time. A hub learns the operator's key from the relay exactly as a person's (the relay pins it on the
  operator's first ASSISTANT device, since 2026-10-11, ADR-117 amendment (о)). The hub keeps a person's identity
  key in the secure store under `mls/<userId>/identity` (class `identity`; built 2026-10-10, see "The
  hub's enrolment" below). The relay keeps every version (append-only; `GET /users/{userId}/device-list/versions`,
  oldest first after the pinned one), carries `conversationId` on ASSISTANT entries only, and pins one
  identity key per account across its USER and ASSISTANT devices (`GET /users/{userId}/devices` returns it; another key
  is 409 `IDENTITY_KEY_CHANGED`; only an explicit, host-driven reset releases it). **A reset starts a new chain:**
  it also discards the account's stored list and every version of it (ADR-117 amendment (п)), so no reader is
  ever served a version signed by the released key, and the next key's first list is version 1. A member that
  pinned a version of the old chain sees a version below its pin under another key: that is the key change, to
  be shown as such. The hub's directory reads them from the
  relay (the host's `directory.ts`); every served row goes through `verifyDeviceList`.
- **The hub's enrolment (built 2026-10-10, W3c; ADR-117 amendment (л)).** It runs in the Worker, at every
  start, single-flight and idempotent (the host's `device-enrolment.ts`). (1) The device's own MLS
  signature key is made once (`mls/<userId>/<deviceId>/device`). (2) `POST /devices` carries `identityKeyPub`
  and the token's `did` is this device. The **first** device of a person makes the identity key (Ed25519,
  `mls/<userId>/identity`, stored provisionally and final once the relay has pinned it); a later device
  **never holds the private half**: it registers with the person's pinned public key and waits to be added
  by a device that does. It learns that key from the relay's own refusal: a first try under a throwaway key is
  409 `IDENTITY_KEY_CHANGED`, whose body carries the pinned `identityKeyPub`, and the second try uses it
  (ADR-117 amendment (м)). A refusal is a **state**, never a loop: `identity-key-changed` (409
  `IDENTITY_KEY_CHANGED`), `device-key-lost` (409 `DEVICE_IDENTITY_IMMUTABLE`: the id is registered with
  other keys), `device-not-yours` (403 `DEVICE_OWNED_BY_OTHER`), `device-revoked`, `transient`, and
  `identity-key-unavailable` (only if a relay breaks its contract and refuses without the pinned key). (3) A device that holds the identity key puts itself on `DeviceList v+1`
  (`POST /users/me/device-list`, signed with the identity key, the version after the stored one; a lost race
  re-reads and signs again, a few times, then `conflict`). (4) A device that is registered but not on the
  signed list shows `needs-approval` with a **16-digit code** (four groups of four; `deviceApprovalCode`, a
  digest of user, device id and signature key; sixteen because a relay that wants its own ghost approved must
  find a key whose code equals the one the person reads off the screen within the minute they take to type
  it, and eight digits fall to a laptop in seconds). A device that holds the key types it (`approve`),
  recomputes the code for every registered-but-unlisted device and approves the one that matches (`approved`,
  `bad-code`, `no-match`, `ambiguous` (two devices with one code are refused, never guessed), `not-signer`,
  `too-many-devices`, `conflict`), signs `DeviceList v+1`, and the room enrolment adds the new device to every
  room this device is in. (5) KeyPackages (`mls/<u>/<dev>/kp-pool`): at least 6 unused, topped up to 16,
  renewed daily, uploaded inside the relay's upload budget (`KEY_PACKAGE_UPLOAD_WINDOW_MS`). (6) Every list
  the hub reads for another person goes through its directory (`directory.ts`): `GET /users/{id}/devices`
  for the **pin** (trust on first use, `mls/<u>/pins`) and `GET /users/{id}/device-list/versions?afterVersion=N&limit=64`
  for the rows, each verified by `verifyDeviceList` (rollback included). A `403 NOT_A_CONTACT` is a typed
  notice ("this person does not know you as contacts yet"), not a crash. (7) A KeyPackage is claimed only for the devices the tree lacks: `POST /key-packages/claim` takes
  `deviceIds` (1 to 64, never an empty list; an unknown, revoked or foreign id is silently absent from the
  answer). The assistant's device is the one the verified operator list names for this room, so adding it to
  one room spends none of the packages of its other rooms. **Losing the only device that holds
  the identity key** makes the person a new person for cryptography: the relay lets the pinned key go only
  by the explicit, host-driven reset above, and every correspondent sees the key change.

### Roles and principals (the household model in the wire)

The open protocol is not neutral about who uses it: it carries a family's shape, and says so. Until
2026-10-10 this canon described only USER devices and left the rest to the code; the rest is below.
The values (role names, credential codes, claim names, limits) have ONE home, `@masia/contracts/wire`,
which the engine, the relay and the host all import.

- **Device roles.** Every device, and the MLS credential of its leaf, carries one role:
  - `USER` (code 1): a person's own device. Registered by that person, on their own account.
  - `GUARDIAN` (code 2): a parent's device that sits on a **child's** account and reads the child's rooms,
    visibly ([step 5](#3-devices)). Only an adult whose token lists that child in `guardianOf` may register
    it; it may be removed from a room only by an admin of that child.
  - `ASSISTANT` (code 3): an AI assistant's device, one per conversation, bound to that conversation inside
    its signed list entry ([section 2](#2-masia-is-a-visible-opt-in-member)). Adding it to a room that holds
    a minor needs a committer who administers every such minor.
- **The admin scope of a token.** The host's token names the user and the device and, for a family
  admin only, `role: FAMILY_ADMIN` with `adminOf` (the OTHER users the admin may act for, never the admin
  themself, at most 64) and `guardianOf` (the minors among them). `role` alone grants nothing; each list is
  checked by the relay against the action. The relay does not know what a family is: it knows these lists.
- **The operator principal.** One account, configured on the relay (`RELAY_OPERATOR_USER_ID`, no default:
  unset means no assistant device can be registered), owns every `ASSISTANT` device. Its device list is
  signed by an operator key that plays the part of a person's identity key, in the same format as a person's. Only a token whose subject is
  the operator may register an assistant device, on its own account, and it is the one token whose
  `adminOf` names its own subject, so that a seat can retire itself.
- **Where the names come from.** The protocol's names are generic so that any host can run it; a host
  maps them to its own product in one place (in this repository's host, `ASSISTANT` is Masia and the
  operator is `masia-operator`). ADR-117 amendment (д) records the rename.

How it works after the switch-on, in eight steps:

1. **Switch-on makes the first device the anchor.** At the moment encryption is switched on, the device the
   person is signed in on generates an **identity key** (long-lived; it signs the device list) and its own
   **MLS leaf**. It registers a `Device` (the install's existing device id, role USER) and a key package
   (plus a last-resort one) with the relay, and signs `DeviceList v1 = [this device]`. Each room is created
   as an MLS group from the leaves of every participant who has at least one device. Someone who has not
   signed in since the switch-on is added the first time they do; until then they see "This room is being
   encrypted: sign in on your phone or browser to receive the keys". No recovery key is needed in the first
   phase: history is dropped at switch-on, so there is nothing to back up. A recovery key arrives with media
   backups, on the model of Signal's Secure Backups.
2. **A second device is linked, not logged in.** The new device signs in as usual but can read **no** room
   yet; it shows "Confirm on your other device". It generates a leaf and a key package and shows a **code**
   (a fingerprint of that leaf: the hub shows 16 digits in four groups; a QR code is a target). On the existing device: Devices, Add, scan or
   type the code. That device **signs `DeviceList v+1`** with the identity key and **commits an Add of the
   new leaf into every group it belongs to** (N rooms means N commits, sent as a batch; the relay orders
   the epochs). From that epoch the new device reads everything new. It has **no old history**: that is
   forward secrecy, as in Signal. Since history is dropped at switch-on, this is the same experience as
   everywhere else, "history is where you read it". When client-side backup exists, restoring happens here.
3. **What everyone else sees.** In every room there is a **permanent system line**, not a toast: "Alice added
   a device, iPhone 17". Her correspondents' clients **block sending until one explicit OK** (the lesson of
   iMessage contact key verification: automatic, but not silent). A client accepts an Add **only if the new
   leaf is in the owner's signed DeviceList**; an Add pushed by the server or an operator without that
   signature is rejected.
4. **The web as a device.** A browser links the same way. At linking the user is warned in the words of the
   threat: "Any XSS or malicious dependency in a web app can read your messages; for anything sensitive,
   use the phone." Each stored value is wrapped by a non-extractable WebCrypto key kept in the browser's
   IndexedDB. That hides values from casual browsing only: it protects **neither** a copy of the disk (the
   wrapping key sits in the same IndexedDB as the values) **nor** against a script running in the same page
   ([section 9.7](#97-choices-made-on-purpose-and-known-limits), key storage). A strict CSP, SRI and no
   third-party scripts are the web build's target; a wrapping secret that is not on the disk and the MLS
   state in a dedicated Worker are targets too. The web is a **weaker device**, and the product says that
   instead of pretending otherwise. _Until 2026-10-10 this step said the non-extractable key "protects a
   disk image" and that the web build "ships" a strict CSP; section 9.7 had already corrected the first,
   and the second is not built._
5. **A guardian device (children).** A parent is not "another phone of the child". The parent is a `Device`
   with role GUARDIAN on the child's account, started by the family admin from the child's Devices screen.
   In every room the child is in there is a badge, "a guardian reads this room", shown to **everyone** in
   it, including correspondents from other families. Only the child's family admin can remove it; the relay
   rejects a Remove of a GUARDIAN leaf that comes from the child's own device. The point: a parent in one
   family must never read another family's child without that child's and parents' knowledge.
6. **Masia as a device.** A mode other than silent adds her `ASSISTANT` device (per conversation, key in the
   custody service) with a system line "Masia joined the room"; silent removes it. Nobody links anything;
   membership is automatic and visible ([section 2](#2-masia-is-a-visible-opt-in-member)).
7. **A lost or sold device.** From another device (or the family admin, if it was the only one): Devices,
   Sign out. That is **first a Remove of the leaf from every group** (a new epoch, so the stolen phone
   cannot read anything new), **then** the session revoke, then `DeviceList v+1` without it. Revoking the
   session alone would leave the leaf in the groups, and the stolen device would keep reading new epochs.
   If it was the person's **only** device and the identity key is lost, the next sign-in is a **new person
   to the cryptography**: a new identity key, and correspondents see "Alice's key changed, confirm"
   (a visible trust-on-first-use change, never a silent one). History on that device is lost; the account
   is not. The blast radius is bounded.
8. **Hygiene.** Every device commits its own **self-Update** when opened after at least 24 hours, and weekly.
   A device inactive for more than 90 days triggers a suggestion to its owner to remove it, never an
   automatic Remove: a phone left at the cottage must not lose its rooms.

**How a host hosts an ASSISTANT member (one host's realisation; _until 2026-10-10 "a MASIA member"_).** The
packages give the engine and the relay; keeping an assistant's leaf is the host's job, and this is the shape the
reference host chose. One system principal, the **operator**, owns every `ASSISTANT` device, and its device
list is signed by an operator
key that plays the part of a person's identity key, in the one `mls-device-list/v1` format of
[section 3](#3-devices). Each device is bound to exactly one conversation: its list entry carries the
`conversationId` inside the signed bytes, and a member's directory takes it from there. Turning the assistant back on after silent mints a new device, because a device's
keys never change on the relay. The keys live in a **custody process** of their own (its own database, every
secret sealed under a key-encryption key the main server process never loads), which talks to the relay with
the device's token and hands decrypted text to the assistant's brain over an internal channel: the server
never holds an MLS secret, and the custody process never sees the model. The host's room **mode** is the
source of truth and membership follows it. MLS lets no member add or remove itself, so the custody process
does its half and asks the members for theirs: it publishes a key package and waits for a member to commit
the Add (in a room with a minor, `mayAdd` lets only an admin of every minor do that), joins from the Welcome
and posts an encrypted "joined" notice; on silent it posts "left", **shreds** its secrets for the room, and
waits for a member to commit the Remove of the dead leaf, which opens an epoch it cannot derive. A
reconciliation pass at start-up and on a timer logs every disagreement between mode and membership and
repairs it toward the mode, never the reverse. The honest cost: whoever runs the custody process can read
the rooms the assistant was invited into, from the epoch she joined until the one that removed her.

**For the UI core.** The Devices screen shows: Add (QR or code), each device's role (USER, GUARDIAN, ASSISTANT),
its MLS status (leaf in N rooms, last self-Update) and Sign out as Remove-then-revoke. Around it: the
"Confirm on your other device" screen, and epoch system lines in the thread.

_Built today (the security-state UI, [section 6](#6-the-boundary-and-the-ports)):_ given a room, the Devices
card marks each device with its role chip, a verified check (or "not verified"), a "waiting for this device's
first key update" warning when `needsSelfUpdate` is owed, and a "current" marker on this device; the room's
other devices (another person's, a guardian's, Masia's) are listed read-only under "Devices in this room".
Those rows add no action: Sign out stays on the session rows. Add, the "confirm on your other device" screen
and the leaf and self-Update counts are target.

## 4. History at switch-on

History is **dropped**, not migrated and not backed up.

- At the one-time switch-on, a purge job erases the text **and every derived copy** of it for each direct
  and group conversation: summaries, embeddings, extracted facts, translation and prompt traces, source rows,
  and the copies held by an LLM provider. Erasing only the `text` column would leave the plaintext alive in
  the derived data, and "we cannot read your chat" would be false.
- The thread gets one system line: "Encryption is on, history before this point was deleted".
- A nightly assertion alerts if any encrypted conversation holds plaintext or derived data.
- Masia's zone is not touched.
- No recovery key exists in the first phase; there is nothing to back up. It arrives with media backups.
- All people's conversations switch **together**, direct and group. There is no staged "locked chats, then
  direct, then group" release in production.

## 5. What the relay sees

The relay sees **who talks to whom and when**, never what. We say that plainly.

- The sender authenticates with a bearer token, and delivery rows are indexed by user, so the metadata graph
  is visible to the operator. The term "sealed sender" is therefore not used. Unlinkable delivery
  credentials would be a separate decision.
- **The token is minted by the host and only verified by the relay.** It is an EdDSA (Ed25519) JWT with an
  issuer and an audience the relay is configured with (`RELAY_TOKEN_ISSUER`, `RELAY_TOKEN_AUDIENCE`; the open
  relay has no default and refuses to start without them, and _until 2026-10-10 the pair was fixed in its
  code_), valid for at most 10 minutes, naming the user and the device, and, for a family
  admin, the OTHER users that admin may act for (`adminOf`, never the admin themself) and the minors among
  them (`guardianOf`). The relay checks it with public keys alone (a short list, chosen by the token's `kid`,
  so a key can be rotated); it holds no secret that could mint one, so reading the relay's configuration or
  database does not let anyone sign in as a user. A token with another algorithm (a shared-secret one
  included), issuer, audience or key is refused with one and the same answer, whatever the cause; clocks may
  disagree by 30 seconds. **The host takes the device from the signed session, never from a request
  header:** the device id is bound to the session at sign-in and inherited by every refresh, and a device
  that has been signed out gets no token.
- **Who may register which device.** A user registers their own USER devices. A GUARDIAN device sits on the
  child's account and only an adult whose token lists that child in `guardianOf` may register it there; a
  ASSISTANT device only the operator principal may register
  ([Roles and principals](#roles-and-principals-the-household-model-in-the-wire)). A guardian's device may be removed from a
  room only by an admin of that child (the engine's rule, mirrored on the relay).
- Delivery rows of encrypted conversations are kept for a stated, short retention (30 days,
  `RELAY_BACKLOG_RETENTION_SECONDS`, one constant in `@masia/contracts/wire` that the engine and the relay
  both import), and a periodic job really deletes
  them: handshakes, envelopes, and key packages that expired or were claimed that long ago. **Sequence
  numbers never move:** each conversation keeps its own handshake and envelope counters, so deleting old rows
  never lets a number be handed out again. A page says `oldestAvailableSeq`, the first number still stored,
  so a device that was away longer than the retention knows what it missed instead of guessing.
- **A retry is answered, not duplicated.** Posting the same commit again (same bytes, same device, same epoch)
  returns the original receipt with 200; a different commit at that epoch is still a 409 conflict. An
  application message may carry a `clientMsgId`; the relay keeps it unique per sender in a room, a retry with
  it returns the original `seq` with 200, and the same id with different bytes is refused
  (`CLIENT_MSG_ID_REUSED`). Creating a group that already exists with the same parameters answers 200.
- **A removed device can finish reading.** It may still read the commit that removed it and every application
  message sent at an epoch it was a member of (before `removedAtEpoch`). Nothing later, and it can write
  nothing; once it has read that much, the relay answers 403 `REMOVED` with `removedAtEpoch`, a code distinct
  from "never a member".
- The relay accepts only commits and Welcomes. A standalone proposal is refused
  (`HANDSHAKE_KIND_UNSUPPORTED`): the engine never sends one and never accepts one.
- The relay never holds a request open: database calls have a connection, statement, lock and
  idle-in-transaction timeout, and a request that waits too long for a busy room's lock is answered 503
  `ROOM_BUSY` with `Retry-After`.
- Pushes for encrypted rooms are **generic**: they say "something new in room X" and never carry text or a
  sender name; the device fetches and decrypts locally.
- Handing out key packages is limited to accepted contacts and rate-limited per requester. Otherwise an
  attacker could drain someone's key-package pool (denial of service) or learn who exists (a presence oracle).
  The pool itself is bounded: a key package is stored with its `notAfter`, an expired one is skipped and
  purged, the newest is handed out first, each device holds at most a fixed number unclaimed, and uploads are
  rate-limited per device and per user. **An upload is idempotent**: a package the device already holds (the
  same bytes, spent or not) is skipped and not counted, so a retry after a lost answer answers `uploaded: 0`
  and a KeyPackage, which is single use, can never reach two claimers (a unique index on the device and the
  SHA-256 of the bytes; ADR-117 amendment (п)). A device list read by someone else answers
  only to the owner, an admin of the owner, or a **contact** (a party that shares or shared a room
  with the owner, or one the host introduced in the token's `reach` claim), who sees the public part only
  (id, role, public keys). The lookup budget (per calling user and per target user) exists to stop a walk
  through the user ids, so it is priced by the relationship, **after** the gate: your own directory, an
  administered user's and a room contact's cost nothing (an open client re-reads them every minute on every
  device); the operator account costs the caller's budget only; an introduced stranger costs the caller's and
  the target's; a refused stranger costs the caller's alone, so a walk cannot spend a victim's budget.
  _Built today: the limits, the one contact gate on the directory, the device list and the key-package
  claim, and the pricing above for the directory and the device list (key-package claims keep their own
  budgets, counted as before; [ADR 0005](adr/0005-security-review-conditions.md))._
- Every application message carries the epoch and the tree hash as authenticated data, so a relay that
  forks or withholds epochs is caught on the first message. **A decryption failure is a visible security
  state of the room** ("keys have diverged, check your devices"), never a spinner and never a silent retry.
  The rebase limit after a conflict is bounded. _Under review: MLS already binds the group id, the epoch and
  the content type, so the review proposes binding the conversation id, a per-sender counter and the epoch
  authenticator instead (amendment C in ADR 0005, not decided)._
- **The room says what it is, in the header and in a sheet** (`ui/security`). The badge shows the zone of
  [section 1](#1-two-zones): "Text is encrypted · media we can read", "Masia zone — the server reads this room",
  "Setting up encryption…" or "Not end-to-end encrypted". A tap opens a sheet with the explanation, **every
  guardian** (one line each, never a hidden indicator), the security code and a link to the room's devices. The
  rules the code keeps: a room with Masia in it is never shown as encrypted; a room still being set up is never
  rounded up to encrypted; a room the host has no state for shows **no** badge, because unknown must not look
  secure. The sheet also says what is not hidden: photos and files, until media is encrypted on the client too,
  and the metadata above. A guardian ribbon ("Mom sees this chat", or "N adults see this chat" beyond two)
  sits above the thread and cannot be closed. A room waiting for a key refresh shows a banner that cannot be
  dismissed and promises an order ("messages will arrive once it completes"), not a time.
  **The encrypted badge names what is not encrypted (since 2026-10-10).** It said "Text is encrypted · Masia
  is not here"; the absence of Masia is already what the zone means, and the one thing a person can still
  mistake for protected is a photo, so the badge now says "media we can read" and the sheet explains it.
  The room also says, without being asked, what it is doing: "sending…" while a commit or a message of ours
  is on its way, read-only when another tab holds it, removed, a history gap ("before {date}"), and
  "sign in again" when the relay refused this device ([section 11](#11-the-hosts-engine-a-worker-and-what-this-device-means)).
  _Built: the components, and the first host (the web app) fills the value from the engine running in a
  Worker. Guardians, device names and the epoch lines wait for the signed device lists on the host._
- **The relay orders; clients verify.** The relay stores and serves the member change a committer declares and
  checks the cleartext MLSMessage header (group id, epoch, content type) against the room. It cannot know
  whether a declared change is true; every member compares it with what the decrypted commit does and
  rejects a mismatch. See [ADR 0004](adr/0004-relay-owns-ciphertext.md).

## 6. The boundary and the ports

The messenger is a package, not an application. It does not know the host's families, people, database,
design system or world. It sees the host through ten ports in `@masia/contracts`:

| Port                | What the host supplies                                                                                    |
| ------------------- | --------------------------------------------------------------------------------------------------------- |
| `AuthSession`       | who is signed in, the stable device id, a short-lived access token for the relay                          |
| `Transport`         | requests and topic subscriptions to the relay                                                             |
| `SecureStorage`     | key material, in three access classes (`identity`, `history`, `push`)                                     |
| `PushBridge`        | content-free "something is new in room X" signals                                                         |
| `ContactsDirectory` | the host's address book: who may be addressed (the consent gate), display data, circles, groups, requests |
| `ThemeTokens`       | values for the 16 `--msg-*` CSS custom properties: the whole styling surface                              |
| `IconSet`           | a renderer for a closed list of icon names                                                                |
| `I18nBundle`        | translated strings for the closed list of `messenger.*` keys, in `uk`, `en`, `de`                         |
| `MediaUpload`       | storing a media blob and resolving its id back to a URL                                                   |
| `RichAttachment`    | a render slot for host-owned attachment kinds, such as stickers                                           |

Each port is one file in `packages/contracts/src/ports`, with an in-memory fake in `src/fakes` and a contract
suite in `src/contract-tests`. `PresenceDirectory`, the former name of `ContactsDirectory`, is a deprecated
alias kept for one release.

Rules that keep it honest:

- **Contracts are a merge condition.** Each port has a contract suite, run in this package against in-memory
  fakes and in the host against its real implementations. A host change that touches the messenger is
  mergeable only when both are green.
- **The guard is an allowlist.** `no-restricted-imports` in ESLint and dependency-cruiser in CI let each
  open package import `@masia/contracts`, its own package, node builtins and the npm dependencies it
  declares, and nothing else: the host (its apps, backend, shared packages, UI, i18n, ORM client, workers,
  tools) and any workspace package added later are a red build without being named. The client and the
  relay do not import each other. A negative-control test proves the guard still fails when it should. A
  need that seems to require an import is a missing port, so add the port. _Until 2026-10-10 the guard
  listed the host's packages and allowed everything else (architecture review round 1, M14)._
- **One wire vocabulary.** What the client and the relay must agree on byte for byte (device roles and
  the credential layout, id shape, size limits, retention, the MLS profile and the conversation-id
  extension, the AAD frame, the handshake kinds, the cleartext MLS header parser, the relay token's claims)
  lives in `@masia/contracts/wire` and is imported, never copied. _Until 2026-10-10 the engine and the
  relay each kept a copy, held together by parity tests._
- **Boundary first, repository later.** The packages live in one repository now, built so that
  `git subtree split` can turn each into its own repository with its history. Publishing is a separate,
  deliberate step.
- Stickers and the host's world stay on the host side; the messenger exposes a render slot.

**The UI core** (`@masia/messenger/ui`). The human-chat screens live in the package and draw only through
the host:

- **Words, icons, colours, media and stickers are ports.** `I18nBundle` carries one typed key per
  sentence (groups `chat`, `common`, `bank`, `circles`, `contacts`, `groups`, `devices`, `room`, `device`,
  `epoch`, `composer`, and for the security state `zone`, `guardians`, `fingerprint`, `recovery`), `IconSet`
  the 27 icon names, `ThemeTokens` the 16 `--msg-*` custom properties (the sixteenth, `--msg-warn`, is the
  caution colour of the security state),
  `MediaUpload` / `MediaReader` the picture and document URLs (`resolve` and `peek`, so a first paint can use
  what the host has cached), and `RichAttachment` the host-drawn kinds (a sticker). A screen never holds a
  hex colour, a translated sentence or a host URL.
- **Tokens are applied at the screen root** as an inline style (`themeStyle`) and read in the stylesheets as
  `var(--msg-…)`. A host may point a token at one of its own variables, so a theme switch repaints the
  messenger; anything portaled out of the root needs its own copy of the style.
- **Slots carry what a port cannot.** The contracts package has no React types, so the few components the
  messenger needs from its host (a menu, a horizontal scroller, a picture gallery, a person's chip and,
  optionally, the message input) are declared in `ui/provider/slots.ts` as the narrowest props the package
  passes. The host hands its own components in through `MessengerUiProvider`, which also carries the host
  facts that are neither a word nor a picture (the bank's window sizes, the "phone" media query, the reaction
  emoji, how an error is shown).
- **The security state is one value and one wiring point.** `ConversationSecurityState`
  (`@masia/messenger/protocol`) is a plain description of a room: end-to-end `off | pending | on`, whether
  Masia is present, the guardians, the key version and the epoch authenticator, the room's devices (role,
  verified, `needsSelfUpdate`, this device) and a recovery flag, plus what the host knows about this device
  and the room's moment (`thisDevice`, `sending`, `readOnly`, `removed`, `historyBefore`, `signInRequired`;
  [section 11](#11-the-hosts-engine-a-worker-and-what-this-device-means)). The host builds it from the engine and hands
  the UI a `SecurityStateSource` (`securityStateOf(id)` and `subscribe(id, onChange)`, snapshots stable by
  reference) through the `security` field of `MessengerUiProvider`. The UI never asks the engine. Without a
  source, or for a room it does not know, there is no badge, no ribbon and no banner.
  The epoch lines (`EpochSystemRow`: a device added or removed, Masia joined or left, a changed key, "encryption
  is on") are built and tested on their own; the thread has no system-row slot yet, so putting them between
  messages is target.
- **A screen that needs the network takes the port's shape as a prop.** The devices list receives a
  `Transport` (fetch only) and a path beneath the API root and knows no URL; which path (my sessions, or a
  family member's for the parental view) is the host's call.
- **Peers, not dependencies.** The UI imports `react`, `@mantine/core` and `@mantine/hooks` (peer
  dependencies) and `@masia/contracts`; the guard fails on anything else.
- **The host's side** is a handful of adapters, one per port, each held to the same contract suite as the
  in-memory fake (in the host application, one adapter file per port).

**The interim wire.** `Transport` has only `fetch` and `subscribe`, shaped for the relay. Until the relay
replaces the host's current JSON protocol, the messenger speaks that protocol through those two calls by a
fixed convention (`@masia/messenger/protocol`): server events arrive as JSON bytes on the topic `msg:`, the
link state as `{"connected": boolean}` on `messenger:connection` (current value first), and client commands
are POSTed to `/messenger/command`. The host adapts the convention to its own socket and API; the port did
not grow. When the relay lands, the convention and the host adapter go together.

## 7. Licenses

- `@masia/contracts` and `@masia/messenger` (including the UI core): **Apache-2.0**, so the client can be
  embedded and audited without fear.
- `@masia/relay` and `@masia/relay-server`: **AGPL-3.0-only**, so a closed fork of the server cannot exist.
  This is the same split Signal made.
- The MLS libraries under consideration (`ts-mls`: MIT, `mls-rs`: Apache-2.0 or MIT) are compatible.

## 8. The crypto library is measured, not guessed

MLS is implemented by a library; we do not write our own. First candidate: `ts-mls` (pure TypeScript: no
WASM, no `wasm-unsafe-eval` in the CSP, no Rust toolchain). Fallback: `mls-rs` compiled to WebAssembly. The
threshold is a commit on a 50-member group in under 300 ms in WebKit; the choice and the cipher suite are
recorded after the measurement, before any code depends on them. Outcome: `ts-mls` 1.6.4, pinned, behind
`MlsEngine` ([section 9](#9-the-mls-engine)); the contract suite re-runs the 300 ms budget for an Add in a
group of 50 on every test run. A younger library means a mandatory
security review before the first production byte. Rejected: libsignal (AGPL, and a pairwise ratchet where
we want native groups) and Olm/Megolm (libolm is deprecated).

**Measured and decided (2026-10-10):** `ts-mls` 1.6.4, pinned exactly, behind our own `MlsEngine` interface,
which validates every incoming commit itself; cipher suite 1; `mls-rs` compiled to WebAssembly is plan B
behind the same interface. The critical path of adding a member to a group of 50 was 128 ms in Node and 29 ms
in Chromium, against the 300 ms threshold. The numbers, the maturity risks and the invariants are in
[ADR 0003](adr/0003-ts-mls-behind-mls-engine.md); the review that set the conditions is
[ADR 0005](adr/0005-security-review-conditions.md).

**Measured in WebKit on 2026-10-10 (a desktop stand-in for the phone, not the phone).** The engine bundle ran
under `default-src 'self'; script-src 'self'` (no `unsafe-eval`, no `wasm-unsafe-eval`) in Playwright's WebKit
26.4 on Windows and, for comparison, in Chromium 148: no policy violation, no WebAssembly call, and every
lifecycle (groups of 2, 5, 50) and attack scenario green. Three caveats go with the numbers. That WebKit build
is not Apple's, and its WebCrypto has no Ed25519 or X25519, so the bench ran a pure-JS stand-in for the two
(its cost is taken out of every figure; it never ships). An Add in a group of 50 makes about 1100 WebCrypto
calls, so its latency is that count times the per-call latency of the thread it runs on. On this build's page
thread every async WebCrypto round trip waits a timer tick (about 15 ms), which makes the engine unusably slow
there; a module Worker is unaffected (0.13 to 0.22 ms per call, against 0.005 to 0.009 ms in Chromium). In the
Worker an Add took 148 ms median and 172 ms p95 (Chromium: 10.5 and 12 ms), inside 300 ms by a factor of 1.75;
the critical path (Add plus one receiver's processing) took 291 ms median and 322 ms p95, at the line; a
Welcome join about 190 ms; a newcomer's first self-update in the group of 50 about 0.9 s to create and 0.8 s
for each member to process. The budget holds on a phone only if its per-call latency stays under about 0.27 ms
(300 ms over 1100 calls), which only a device can show. Two policy facts: a `<meta>` policy does not reach a
Worker, so the Worker script must carry the policy as a response header (without it `eval` runs there); and
this WebKit does not refuse WebAssembly under `script-src 'self'`, so the policy cannot prove "no WASM" there
(the zero WebAssembly calls is shown by instrumentation instead). The bench is
`pnpm -F @masia/messenger bench:webkit`; it exits non-zero on a failed scenario or when the Add p95 passes
300 ms.

## 9. The MLS engine

`@masia/messenger/mls` is the one place MLS happens. It is **our interface** (`MlsEngine`) over **`ts-mls`
1.6.4, pinned exactly** (no range: a library that has one maintainer and no audit does not float). The rest
of the messenger depends on the interface and its data types; `createTsMlsEngine` is the first
implementation, and a second (`mls-rs` compiled to WebAssembly) can replace it behind the same file, because
the contract suite is written against the interface, not against the library.

The engine does not trust the library to validate what it receives. Every commit and Welcome is checked by
our own **receive-side validator** before the library applies it, and the library's result is checked again
afterwards. The reason is on record: the library's receive check was wrong once (a Remove-only commit with no
UpdatePath was accepted, GHSA-gwp3-968w-m7gv) and, in the pinned version, still accepts a
GroupContextExtensions-only commit with no UpdatePath (probe F8b, below).

References written as "review §N" are to the pre-code security review of the MLS layer (2026-10-10), kept
with the host's decision records; "ADR-117 §N" is internal ADR-117, the host decision that fixed the device
and role model (summarised in [adr/0001](adr/0001-e2ee-on-mls.md)); "the engine code review" is the review of
the engine's code, whose findings are recorded in [adr/0005](adr/0005-security-review-conditions.md).

### 9.1 The interface

| Group                | Methods                                                                                                                                                                                                        |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Keys and packages    | `generateSigningKeyPair`, `createKeyPackage(device)` → `{keyPackage, keyPackagePrivate}` (valid 30 days)                                                                                                       |
| Create and change    | `createGroup`, `add`, `remove`, `selfUpdate`: each returns a **new** state, the commit to post, a `pendingCommit` to store before posting, and (add) the Welcome and the member delta to declare               |
| Own commits          | `adoptPendingCommit(state, pendingCommit, relayCommit)` → adopted with the new state, or not; `encodePendingCommit`, `decodePendingCommit` (section 9.7)                                                       |
| Receive              | `processCommit({state, commit, servedMemberDelta, backlog?, acceptedAtMs?})`, `joinFromWelcome({welcome, keyPackagePrivate, expectedConversationId, expectedGroupId, expectedEpoch})`: the validator runs here |
| Application messages | `encrypt`, `decrypt` (authenticated data is always bound to the conversation id), `exporter`                                                                                                                   |
| Reading a state      | `members`, `self`, `conversationId`, `groupId`, `epoch`, `epochAuthenticator`, `isActive`, `needsSelfUpdate`                                                                                                   |
| Keeping a state      | `encodeState`, `decodeState` (size-capped, versioned: bytes of another format version are `STATE_VERSION_UNSUPPORTED`, never `STATE_CORRUPT`)                                                                  |

The host supplies, through `MlsEngineContext`, what MLS cannot know: a `DeviceDirectory` (the **verified**
signed device list of a user: the host checks its signature, version and rollback; `deviceListOf` is the
current list, `listedSince` the oldest verified version at or above a given one that lists a device, and
`refreshDeviceList` an optional "fetch the newest list now"), a `GuardianPolicy` (`isAdminOf`, `isMinor`,
`guardianOwnerOf`), a clock, and optionally how long one directory call may take (`directoryTimeoutMs`,
default `DIRECTORY_TIMEOUT_MS`, 10 s). For each call it also says what it knows about the delivery: for a commit,
the delta the relay stored (`servedMemberDelta`), whether the commit comes from the stored backlog
(`backlog`) and when the relay accepted it (`acceptedAtMs`); for a Welcome, the conversation, the group and
the epoch it expects. Section 9.7 says what the engine does with each.

### 9.2 Invariants

1. **One error type.** Every method throws `MlsEngineError` with a code from a closed list, whatever the
   input. A `TypeError` or a library error never reaches the caller. A seeded fuzz test holds the engine to
   it.
2. **Validate, then adopt.** A `GroupState` is an immutable value. A method that fails returns nothing and
   leaves the state it was given exactly as it was, so a rejected commit costs only that commit.
3. **No external join, anywhere.** There is no `joinGroupExternal`, no GroupInfo export, no external PSK and
   no external sender. A member joins by KeyPackage and Welcome; re-joining is an ordinary Add. The
   validator rejects all of it on receipt, and a test fails if the engine's source imports an external-join,
   reinit or branch entry point of the library.
4. **Size caps before decoding.** Every input is length-checked against its cap before one byte reaches a
   decoder; the cleartext header is read by our own small parser (it never trusts a claimed length). The
   plaintext cap is derived from the relay's 64 KiB envelope (`MAX_CIPHERTEXT_BYTES`) minus the largest
   group id, conversation id and extra authenticated data and a measured framing budget, so a message
   `encrypt` returns always fits the relay; `encrypt` checks its ciphertext against the envelope anyway.
5. **The cipher suite is pinned**: MLS 1.0, suite 1 (`MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519`),
   checked on the cleartext header before decoding and again inside every package and GroupContext.
6. **The conversation is part of the key schedule.** The conversation id is a GroupContext extension
   (`0xf0c1`, the private-use range of RFC 9420 §17.3), so the relay cannot swap it, and it is the first
   field of the authenticated data of every application message.
7. **The role lives in the credential** (`{userId, deviceId, role}`, one canonical byte form per identity),
   not in a leaf extension the owner could rewrite.
8. **Newcomers do a `selfUpdate` right after joining.** An Add commit carries no UpdatePath, so the newcomer's
   leaf is the only fresh key material; the engine reports it (`requiresNewcomerUpdate`,
   `requiresSelfUpdate`, `needsSelfUpdate`).
9. **The relay's `memberDelta` is a claim, not a fact.** The engine computes the delta from the decrypted
   commit and compares it with the one the relay stored (`servedMemberDelta`).
10. **A commit is a PrivateMessage.** A PublicMessage commit would show the relay who sent it and what it
    changes; the engine never sends one and refuses one on receipt.
11. **A group has at most 256 devices** (`MAX_GROUP_LEAVES`, one constant). Leaf and list checks run before
    any pass that hashes the whole tree. A Welcome's tree is counted before the library reads it. After a
    commit, parent hashes are re-checked along the committer's path only (every other node is shown
    unchanged first), so a receiver's cost per commit grows linearly with the group: in the contract
    suite's benchmark (16 self-updates in a populated group of 64 devices, desktop) about 60 to 80 ms per
    commit, slowest 75 to 105 ms. Until 2026-10-10 every chain of the tree was re-verified: 130 to 145 ms
    per commit, slowest 420 to 870 ms. Joining still verifies the whole tree once, in the library.
12. **Our own commit survives a lost acknowledgement.** Every commit we build comes with a `pendingCommit`
    (the hash of the exact bytes and the state they lead to); `adoptPendingCommit` adopts that state only
    when the relay holds exactly those bytes. The engine never processes its own commit.
13. **Every fault has its own code.** A caller's bad argument is `INVALID_ARGUMENT`; each limit has one
    code (`TOO_MANY_PROPOSALS`, `GROUP_FULL`, `DECODE_TOO_LARGE` for bytes); a directory that fails or
    hangs is `DIRECTORY_UNAVAILABLE`; stored bytes of another format version are
    `STATE_VERSION_UNSUPPORTED`. None of these is a verdict on a peer.

### 9.3 The validator: rules, reasons, tests

Every rule has its reason written next to the check in `src/mls/validator.ts`. The tests named here run in the
contract suite (`src/mls/__tests__/contract-*.ts`, entered by `ts-mls-engine.contract.test.ts`) unless a
file is named.

| Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Why                                                                                                         | Code                                                                   | Test                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An input over its cap is refused before it is read                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | review §1                                                                                                   | `DECODE_TOO_LARGE`                                                     | `robustness > size caps are checked first, and are exact` (8 tests); `message-header.test.ts`                                                                                                                                                                                                                                     |
| A plaintext at the cap, with the longest conversation id and the largest extra AAD, encrypts to at most the relay's 64 KiB envelope; `encrypt` checks every ciphertext against it                                                                                                                                                                                                                                                                                                                                    | the engine code review                                                                                      | `LIBRARY_REJECTED` (cannot happen while the derivation holds)          | `robustness > a plaintext at the cap fits the relay envelope ...` (measured framing below `PRIVATE_MESSAGE_FRAMING_BUDGET_BYTES`, round trip)                                                                                                                                                                                     |
| A length prefix is minimal and never trusted past the end of the buffer                                                                                                                                                                                                                                                                                                                                                                                                                                              | RFC 9420 §2.1.2                                                                                             | `MALFORMED_MESSAGE`                                                    | `message-header.test.ts`: non-minimal prefixes, claimed length, every truncation                                                                                                                                                                                                                                                  |
| The header parser is a copy of the relay's (the two packages may not import each other): both read every shared vector the same way, refuse every malformed one, and share caps, id alphabet, roles and wire constants. Moving the parser to a shared module is tracked, not done                                                                                                                                                                                                                                    | internal ADR-161 (summarised in [adr/0002](adr/0002-open-package-and-contracts.md)); the engine code review | n/a                                                                    | `relay-parity.test.ts` (5 tests; skipped where the relay source is absent)                                                                                                                                                                                                                                                        |
| Not MLS 1.0 / suite 1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | RFC 9420 §17.1; review §1                                                                                   | `SUITE_NOT_PINNED`                                                     | `attacks > SUITE_NOT_PINNED: another cipher suite or protocol version ...`                                                                                                                                                                                                                                                        |
| Each entry point accepts only its kind of message, and a commit is a PrivateMessage (a PublicMessage commit shows the relay its sender)                                                                                                                                                                                                                                                                                                                                                                              | review §1; the engine code review                                                                           | `UNEXPECTED_MESSAGE_KIND`                                              | `attacks > UNEXPECTED_MESSAGE_KIND: each entry point refuses the other kinds of message`; `lifecycle > PublicMessage commits are refused ...`                                                                                                                                                                                     |
| A commit is for this group and this epoch, and not our own                                                                                                                                                                                                                                                                                                                                                                                                                                                           | RFC 9420 §12.4.2                                                                                            | `GROUP_MISMATCH`, `EPOCH_MISMATCH`                                     | `attacks > EPOCH_MISMATCH ...`, `GROUP_MISMATCH ...`, `a device does not process its own commit`                                                                                                                                                                                                                                  |
| A commit that needs an UpdatePath (empty list, Update, Remove, ExternalInit, GroupContextExtensions) has one                                                                                                                                                                                                                                                                                                                                                                                                         | RFC 9420 §12.4; GHSA; probe F8b                                                                             | `PATH_REQUIRED`                                                        | `attacks > GHSA: a Remove-only commit ...` (PrivateMessage; a PublicMessage is refused before it gets that far), `F8b: a GroupContextExtensions-only commit ...`; `validator.test.ts > assertCommitShape`                                                                                                                         |
| Proposals by value only, none on their own                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | RFC 9420 §12.4; review §1                                                                                   | `PROPOSAL_BY_REFERENCE_FORBIDDEN`, `STANDALONE_PROPOSAL_FORBIDDEN`     | `attacks > a commit that names a proposal by reference ...`, `a proposal sent on its own ...`                                                                                                                                                                                                                                     |
| Only Add and Remove are used (no PSK, ReInit, Update, GroupContextExtensions, custom)                                                                                                                                                                                                                                                                                                                                                                                                                                | review §1; the conversation id is fixed                                                                     | `PROPOSAL_NOT_ALLOWED`                                                 | `attacks > PSK, ReInit and custom proposals ...`, `a GroupContextExtensions proposal is refused even with a path ...`                                                                                                                                                                                                             |
| No ExternalInit, no external commit, no external or new-member sender                                                                                                                                                                                                                                                                                                                                                                                                                                                | review §2                                                                                                   | `EXTERNAL_SENDER_FORBIDDEN`                                            | `attacks > ExternalInit inside a member commit ...`, `a real external commit ...`, `proposals from an external sender ...`                                                                                                                                                                                                        |
| A Remove names somebody else, once, in a non-blank slot                                                                                                                                                                                                                                                                                                                                                                                                                                                              | RFC 9420 §12.1.3                                                                                            | `INVALID_REMOVE`                                                       | `attacks > INVALID_REMOVE: a Remove must name somebody else, once`                                                                                                                                                                                                                                                                |
| A commit carries at most 64 Adds and 64 Removes, counted in total before any proposal is read and then per kind; a call with an empty list, a malformed id, expectation, hint or exporter argument is the caller's fault                                                                                                                                                                                                                                                                                             | the engine code review                                                                                      | `TOO_MANY_PROPOSALS`, `INVALID_ARGUMENT`                               | `attacks > INVALID_ARGUMENT / TOO_MANY_PROPOSALS ...`; `validator.test.ts > assertCommitShape > bounds the number of proposals ...`; `backlog > malformed hints from the host are refused`; `robustness > the exporter bounds its label and its length`                                                                           |
| A device is in a group once                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | relay invariant; review §1                                                                                  | `DUPLICATE_DEVICE`                                                     | `attacks > DUPLICATE_DEVICE: a device is in a group once`; `validator.test.ts > refuses one device in two leaves`                                                                                                                                                                                                                 |
| Every leaf (KeyPackage, Update, UpdatePath leaf, Welcome tree) is `(userId, deviceId, role, signatureKey)` on its owner's verified signed list                                                                                                                                                                                                                                                                                                                                                                       | review §1                                                                                                   | `LEAF_NOT_IN_SIGNED_LIST`                                              | `attacks > LEAF_NOT_IN_SIGNED_LIST: ...` (unlisted key, revoked device, ghost Add, unlisted role, ghost leaf in a Welcome)                                                                                                                                                                                                        |
| The committer's own leaf is on its owner's signed list on EVERY commit, an Add-only or Remove-only one included                                                                                                                                                                                                                                                                                                                                                                                                      | the engine code review                                                                                      | `LEAF_NOT_IN_SIGNED_LIST`                                              | `attacks > the committer is on its owner's signed list on EVERY commit` (2 tests: Add-only and Remove-only, refused when sending and by every receiver)                                                                                                                                                                           |
| A device added, used and removed while a receiver was offline still validates in the backlog that receiver replays: with `backlog` a leaf is valid if the oldest verified version at or above the version pinned for its owner lists it; live, it must be on the CURRENT list, whose version is not below the pin. One refresh and one retry per user on a miss. A directory call that fails or exceeds `directoryTimeoutMs`, and a miss after a failed refresh, is no verdict                                       | the engine code review                                                                                      | `LEAF_NOT_IN_SIGNED_LIST`, `DIRECTORY_UNAVAILABLE`                     | `backlog > a device added, used and removed while the receiver was offline`, `the backlog is not a door`, `a directory that is behind is refreshed once and asked again` (7 tests); `validator.test.ts > ListLookup` (9); `device-directory.contract.test.ts` (7)                                                                 |
| An ASSISTANT leaf is valid only if its list entry (signed by the owner) names THIS conversation: an entry for another room, or for none, is no pass                                                                                                                                                                                                                                                                                                                                                                  | ADR-117 §3; the engine code review                                                                          | `LEAF_NOT_IN_SIGNED_LIST`                                              | `attacks > a Masia leaf belongs to ONE conversation ...`; `validator.test.ts > ListLookup > an ASSISTANT leaf is valid only when its entry names THIS conversation`; `device-directory.contract.test.ts > a Masia entry is bound to its conversation`                                                                             |
| A leaf update cannot change the role (a guardian cannot drop its badge) or whose device the leaf is                                                                                                                                                                                                                                                                                                                                                                                                                  | review §1; ADR-117 §4                                                                                       | `ROLE_CHANGED`, `IDENTITY_CHANGED`                                     | `attacks > ROLE_CHANGED ...`, `IDENTITY_CHANGED ...`; `validator.test.ts > assertSameOwner`                                                                                                                                                                                                                                       |
| A leaf lists suite 1, the basic credential and our conversation extension; leaf extensions are refused                                                                                                                                                                                                                                                                                                                                                                                                               | RFC 9420 §7.2, §7.3                                                                                         | `SUITE_NOT_PINNED`, `CREDENTIAL_INVALID`, `UNSUPPORTED_EXTENSION`      | `credential.test.ts`; `attacks` (Welcome and Add cases)                                                                                                                                                                                                                                                                           |
| A KeyPackage and an UpdatePath leaf: signatures verify and the init key differs from the leaf key, on receipt as well as when sending                                                                                                                                                                                                                                                                                                                                                                                | RFC 9420 §10.1, §7.3; the engine code review                                                                | `SIGNATURE_INVALID`                                                    | `attacks > signatures and keys are verified on RECEIVE` (3 forged KeyPackages, each refused when sending and by every receiver; 1 forged UpdatePath leaf)                                                                                                                                                                         |
| A KeyPackage lifetime: a sender (or a Welcome) requires `notAfter` in `[now - 1 h, now + 90 d]`, and a sender also requires `notAfter >= now + 24 h` (`KEY_PACKAGE_MIN_REMAINING_SECONDS`), so a sender whose clock runs up to a day behind never adds a package its receivers find expired; a receiver of an Add requires `notAfter` no older than its receive floor minus 1 h (section 9.7), and the same upper bound                                                                                              | RFC 9420 §10.1; review §1; the engine code review                                                           | `LIFETIME_OUT_OF_RANGE`                                                | `attacks > LIFETIME_OUT_OF_RANGE: ...` (3 tests, one with a sender clock a day behind); `backlog > the KeyPackage window on receive` (5); `validator.test.ts > assertKeyPackageLifetime` (7)                                                                                                                                      |
| A guardian leaf is removable by an admin of that user, or by another guardian device of that user whose registered owner is such an admin (a room with no admin leaf can still evict a compromised guardian); on receipt as well as on sending                                                                                                                                                                                                                                                                       | ADR-117 §4; review §7; the engine code review                                                               | `GUARDIAN_REMOVE_FORBIDDEN`                                            | `attacks > guardian removal is policy, enforced on receive` (6 tests) and `a compromised guardian device is removable without an admin leaf` (3); `validator.test.ts > mayRemoveGuardian` (2)                                                                                                                                     |
| Adding an ASSISTANT leaf to a room that holds a minor after the commit (`isMinor`, or any GUARDIAN leaf) needs a committer who administers every such minor (until 2026-10-10 the reason was `MASIA_ADD_FORBIDDEN`)                                                                                                                                                                                                                                                                                                  | ADR-117 §3; the engine code review                                                                          | `ASSISTANT_ADD_FORBIDDEN`                                              | `attacks > Masia joins a room with a minor only by an admin of that minor` (5 tests); `validator.test.ts > assertMayAdd` (3)                                                                                                                                                                                                      |
| The relay's stored `memberDelta` equals the delta of the decrypted commit (order-insensitive). The relay names a removed device by its id only: that id is matched to the one member that has it, and an unknown, ambiguous or `userId:deviceId`-shaped id matches nobody                                                                                                                                                                                                                                            | review §4; the engine code review                                                                           | `MEMBER_DELTA_MISMATCH`                                                | `attacks > the relay's memberDelta is compared with the commit` (4 tests), `removals are keyed by user AND device`; `validator.test.ts > sameMemberDelta`, `keyServedRemovals` (3)                                                                                                                                                |
| After the library applies a commit: next epoch, same group and GroupContext extensions, tree = old tree + validated Adds - validated Removes with only the committer's leaf replaced, tree hash, every node off the committer's path unchanged, and every parent hash on that path                                                                                                                                                                                                                                   | RFC 9420 §7.9.2, §12.4.2; the engine code review                                                            | `LIBRARY_REJECTED`                                                     | `validator-outcome.test.ts` (13 tests); every happy-path test passes through it; `robustness > performance` (64 devices, under 150 ms)                                                                                                                                                                                            |
| A Welcome tree is at most 256 devices wide, counted BEFORE the library verifies anything in it (reaching it costs one HPKE open, one AEAD open and one decode bounded by the 256 KB handshake cap); each leaf (signature, structure, duplicates, current signed list) is checked next; only then the tree hash and the parent hashes. A commit that would take a group over 256 devices is refused. Until 2026-10-10 the width was counted only after the library had joined, which verifies every parent hash first | RFC 9420 §12.4.3.1; review §1; the engine code review                                                       | `WELCOME_TREE_MISMATCH`, `DECODE_TOO_LARGE`, `GROUP_FULL`              | `attacks > WELCOME_TREE_MISMATCH: a tree with a flipped parent hash or swapped leaves ...`, `DECODE_TOO_LARGE: a Welcome tree wider than MAX_GROUP_LEAVES ...`; `validator.test.ts > validateJoinedGroup` (width, list before hash, current lists only) and `validateProposals: a group has at most MAX_GROUP_LEAVES devices` (2) |
| A Welcome names the expected conversation and carries no `external_pub` or other GroupInfo extension                                                                                                                                                                                                                                                                                                                                                                                                                 | review §2, §4                                                                                               | `CONVERSATION_MISMATCH`, `UNSUPPORTED_EXTENSION`                       | `attacks > CONVERSATION_MISMATCH ...`, `UNSUPPORTED_EXTENSION: a Welcome whose GroupInfo carries external_pub ...`                                                                                                                                                                                                                |
| A Welcome is accepted only for the group and the epoch the host expects (`expectedGroupId`, `expectedEpoch`), before its tree is validated; an expectation no group can meet (empty id, negative epoch, invalid conversation id) is the caller's fault                                                                                                                                                                                                                                                               | the engine code review                                                                                      | `GROUP_MISMATCH`, `EPOCH_MISMATCH`, `INVALID_ARGUMENT`                 | `attacks > GROUP_MISMATCH / EPOCH_MISMATCH: a Welcome is accepted only for the group and epoch the host expects`                                                                                                                                                                                                                  |
| The private keys handed to `joinFromWelcome` belong to the KeyPackage (HPKE and signature round trip)                                                                                                                                                                                                                                                                                                                                                                                                                | the library does not check it                                                                               | `STATE_CORRUPT`                                                        | `robustness > valid messages, bit-flipped, truncated or extended, are refused` (its `joinFromWelcome(keyPackagePrivate)` entry); `robustness > joinFromWelcome refuses oversized KeyPackage secrets`                                                                                                                              |
| An application message is bound to the conversation (and to the caller's `aad`)                                                                                                                                                                                                                                                                                                                                                                                                                                      | review §4                                                                                                   | `AAD_MISMATCH`                                                         | `lifecycle > application data: the aad is authenticated, handed back, and a replay is refused`; `framing.test.ts`                                                                                                                                                                                                                 |
| The extra authenticated data of an application message is at most 1 KB (`MAX_AAD_EXTRA_BYTES`), on encrypt and on decrypt: it rides in the clear                                                                                                                                                                                                                                                                                                                                                                     | the engine code review                                                                                      | `DECODE_TOO_LARGE`                                                     | `attacks > extra authenticated data is capped`; `framing.test.ts`                                                                                                                                                                                                                                                                 |
| Our own commit is adopted after a lost acknowledgement only when the relay holds exactly its bytes; a commit that lost the epoch is not, and the winner is processed                                                                                                                                                                                                                                                                                                                                                 | the engine code review                                                                                      | `adopted: true` / `adopted: false`; `INVALID_ARGUMENT` (another group) | `own commits across a lost acknowledgement` (6 tests: restart, Add, 409, idempotence, refusals, versions)                                                                                                                                                                                                                         |
| Stored bytes (state, pending commit, KeyPackage secrets) carry a format version; another version is unsupported, damage is corrupt                                                                                                                                                                                                                                                                                                                                                                                   | the engine code review                                                                                      | `STATE_VERSION_UNSUPPORTED`, `STATE_CORRUPT`                           | `own commits ... > STATE_VERSION_UNSUPPORTED ...`; `framing.test.ts` (3 version tests)                                                                                                                                                                                                                                            |

Beyond the table, the contract suite also holds: a group of two and of five devices over four users stays
converged through adds, updates and a double remove; the committer and every receiver derive the same epoch
authenticator; a removed device can neither send nor commit but keeps what it had; a state survives
encode/decode at any point; 200 random buffers, 200 with a plausible header and 200 spliced onto a real
header are all refused with `MlsEngineError` only (seeded, so a failure replays); an Add in a group of 50
devices takes under 300 ms (about 45 ms measured); and a receiver processes a self-update in a populated group
of 64 devices in under 150 ms (invariant 11 has the numbers). Both timings are skipped with `MLS_SKIP_PERF=1`.

### 9.4 What we still take from the library

Not everything is re-implemented; the rest is a stated dependency, so a reviewer knows where trust remains.
The **GroupInfo signature** and the **confirmation tag** of a Welcome, and the **signature on each commit and
application message**, are verified by `ts-mls` only; so are the **HPKE and AEAD** operations and the
**message framing** (the contract suite exercises them, and the RFC vectors below check the primitives). Everything that decides **who is in the
group and what changed** is ours. Consumed secrets are not zeroised: JavaScript gives no way to promise it,
and a `GroupState` is a plain value.

### 9.5 Library controls (so a dependency bump cannot hide a change)

`ts-mls-engine.library-controls.test.ts` pins what the library does on the two known bad inputs, to the
version we ship:

- **GHSA (Remove without an UpdatePath): fixed upstream since 1.6.4** ("Update path is required"). The
  engine rule stays as defence in depth.
- **F8b (GroupContextExtensions-only commit without an UpdatePath): still accepted by the library.** The
  engine rule is the only guard. If a later version fixes it, the control test fails on purpose and this line
  is updated.

### 9.6 RFC 9420 test vectors

Run in `src/mls/__tests__/rfc9420-vectors.test.ts`, cipher suite 1 only, from fixtures committed in
`src/mls/__tests__/fixtures/rfc9420/` (the source, date and file hashes are in `PROVENANCE.json`). They
drive the same library build and the same suite implementation the engine uses, **at the library level, not
through `MlsEngine`**: a vector is one primitive or one hand-made epoch, and the opaque `GroupState` cannot be
built from raw bytes.

| Vector                                                     | Ran | What it proves                                                                                                                                                                       |
| ---------------------------------------------------------- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tree-math`                                                | yes | node width, root, left, right, parent and sibling for ten tree sizes                                                                                                                 |
| `crypto-basics`                                            | yes | RefHash, ExpandWithLabel, DeriveSecret, DeriveTreeSecret, SignWithLabel, EncryptWithLabel (RFC §5.1, §5.2, §8)                                                                       |
| `secret-tree`                                              | yes | sender data key and nonce, and every listed generation of every leaf's handshake and application ratchet (1, 8 and 32 leaves; RFC §9, §6.3.2)                                        |
| `key-schedule`                                             | yes | every secret of five epochs (joiner, welcome, sender data, encryption, exporter, epoch authenticator, ...), and the exporter; the `external_pub` field is skipped (no external join) |
| `message-protection`                                       | yes | PublicMessage and PrivateMessage unprotect for a proposal, a commit and application data; wrong keys refused                                                                         |
| `passive-client-*`                                         | no  | replays arbitrary groups (proposals by reference, PSK, ReInit, external senders and external joins): the features the engine refuses by design                                       |
| `welcome`, `treekem`, `tree-operations`, `tree-validation` | no  | need the library's group state built from raw tree bytes; the engine-level Welcome and tree checks are covered by the attack contract instead                                        |

**Interop against OpenMLS.** The vectors above stay inside one library. `src/mls/__tests__/interop/` runs
`MlsEngine` against a second, independent implementation, OpenMLS 0.9.1 (Rust, in a container with no
network), on demand (`pnpm test:interop`, needs Docker; skipped otherwise). A group made by either side admits a
member of the other by Welcome, Add, remove and self-update converge, messages flow both ways under the
conversation-bound AAD, and after every step both sides hold the same epoch authenticator and exporter secret.
The refusals are checked against what a real OpenMLS emits: a proposal by reference, a standalone proposal, an
external commit, a PublicMessage commit, a GroupContextExtensions commit, and the KeyPackage, credential,
Welcome and guardian rules. Our credential layout, the `0xf0c1` extension and the AAD frame were accepted by
OpenMLS in every scenario. One defect surfaced, in the library and not in our layout (finding F1): ts-mls
1.6.4 refused to join a valid tree in which an unmerged leaf sits under a node whose ancestor was refreshed
from the other half of the tree (RFC 9420 section 12.4.3.1 asks less of the intermediate nodes than the
library did), so an Add could leave the newcomer unable to join in a room that has held five or more devices.
The repo pins a patch of the library for it (section 9.7, "Patched library check"); with it the suite is
green, 19 of 19 scenarios. Not proven: a commit without an UpdatePath where one is required
(stock OpenMLS never builds one), other OpenMLS versions or cipher suites, offline backlog, rooms above 8
devices. Results and method: [`interop/README.md`](../src/mls/__tests__/interop/README.md).

### 9.7 Choices made on purpose, and known limits

Each choice below is a decision, not an accident; each has a test named in section 9.3.

- **Replaying a backlog (the engine code review).** A device that was offline replays the commits it missed, in
  the relay's order. It judges each commit by the list versions it relied on at the previous epoch, not by
  what the lists say today; otherwise a device that was added, used and revoked in the meantime would stall
  the replay for good. Per user the state keeps a **pin**, the highest list version an accepted commit
  relied on (saved with the state; dropped when the user leaves the room; a user nobody has seen is pinned
  at 0). With `backlog: true` a leaf is valid if the OLDEST verified version at or above its owner's pin
  lists it exactly (`DeviceDirectory.listedSince`); the oldest, so that a pin never advances further than
  the commit needs and cannot strand a later commit of the same replay. Without `backlog` (a live commit,
  and every commit this engine sends) a leaf must be on the CURRENT list, and that list may not be older
  than the pin. A miss is followed by at most one `refreshDeviceList` per user and one more lookup. A
  device that never was on any verified list, or only on one older than the pin, is refused in both modes.
- **A directory that cannot answer is not a verdict (since 2026-10-10).** Every call into the host's
  directory is bounded by `directoryTimeoutMs` (default 10 s). A call that rejects or times out, and a miss
  after a refresh that failed, is `DIRECTORY_UNAVAILABLE`: transient, the commit is retried later and the
  state has not moved. Until 2026-10-10 an error from the refresh was swallowed and the miss stood as
  `LEAF_NOT_IN_SIGNED_LIST`, which made "I could not ask" read as "not listed" and stalled a device that was
  briefly offline for good.
- **A Welcome is read against the current lists only.** A newcomer has no history to replay, so the
  backlog rule does not apply to it; a Welcome that names a device revoked since is refused and the
  inviter sends a fresh one.
- **A Masia leaf belongs to one conversation, and to a parent's decision.** The owner's signed list entry
  for an ASSISTANT device names the conversation; a leaf is valid only in that one. Adding Masia to a room that
  holds a minor is allowed only to a committer who administers every minor in it (`ASSISTANT_ADD_FORBIDDEN`),
  checked on sending and on receipt.
- **The KeyPackage window on receive (the engine code review).** A sender checks the full window `[now - 1
h, now + 90 d]` and, since 2026-10-10, a margin: it adds a package only while `notAfter >= now + 24 h`
  (`KEY_PACKAGE_MIN_REMAINING_SECONDS`), so a sender whose clock runs up to a day behind never posts a
  package its receivers find expired. A receiver cannot demand freshness: a commit may have waited at the
  relay, and the package in it may have expired since. It judges `notAfter` against a **receive floor**
  instead of `now`: `floor = max(saved floor, min(max(acceptedAtMs, now - RELAY_BACKLOG_RETENTION_SECONDS),
now))`, where `acceptedAtMs` is when the relay accepted the commit (a hint from the host; without it the
  floor is `now - RELAY_BACKLOG_RETENTION_SECONDS`). The hint is clamped to `[now - retention, now]`, so a
  lying host can make the window tighter (a liveness problem), never wider. The SAVED floor stores relay
  times only: the highest `acceptedAtMs` an adopted commit carried (never above `now` when it was read), and
  it does not move for a commit without one. Until 2026-10-10 the saved floor was the floor computed above,
  so a device whose clock ran ahead for a while kept a floor from its own wrong clock and refused honest
  backlog Adds for good. The floor only moves forward, so a clock set back does not re-admit an older
  package. The upper bound (`now + 90 d`) is not relaxed. **Host contract:** the relay deletes a handshake after
  `RELAY_BACKLOG_RETENTION_SECONDS` (30 days; the relay's constant, checked equal to the engine's export by
  a test); a commit older than that is never replayed. The relay's sequence numbers stay stable across the
  deletion, and a page's `oldestAvailableSeq` tells a device that it is behind the retention: it cannot
  replay, and re-joins (an ordinary Add). **One rule, one home** (round 2, rel-M1/M2): behind means
  `cursor + 1 < oldestAvailableSeq` (`isBehindRetention`, `@masia/messenger/protocol`), with NO exemption
  for a cursor of 0, because a joiner's cursors start at the seq it joined at (`RelayCursorAtJoin`: the
  Welcome's commit seq; `CREATOR_CURSOR` for the creator). A commit of an epoch the state has not reached
  is never stepped over: the cursor stays before it and the room stalls `REJOIN_NEEDED`. That stall is
  stored, so a reload does not retry; the outbox is dropped with it (sealed for an epoch the device never
  reaches), and a send that keeps meeting 409 without the epoch moving gives up after
  `MAX_OUTBOX_CONFLICTS` (3) into the same stall, never a loop.
- **Per-message persistence (built 2026-10-10, W3c; decision 2026-10-10, round 2 perf-M2; ADR-117 amendment (л)).**
  Before it, every sent or read message rewrote the whole room record (state, up to hundreds of KB) and the
  whole history (up to 2 MiB). Now: (1) the history is stored in append-only **segments** of at most 100
  items and 256 KiB (`mls/<u>/<dev>/history/<conv>/<n>`) beside a small manifest (`…/history/<conv>`); only
  the tail segment is rewritten per message; the total cap stays (1000 items, 2 MiB, oldest first); a
  single-blob history from an earlier build is migrated by the room's writer only. (2) The full group state
  is a **snapshot** (`…/room/<conv>`: state, pending commit, cursors, outbox), written at an epoch change,
  when a commit is pending or resolved, at a join, and every **16** messages (`SNAPSHOT_EVERY_MESSAGES`,
  own seals plus messages read; the lead chose 16 over the 32 first written here), each time under a new
  generation number `gen`. Between snapshots a small **journal** (`…/journal/<conv>`: `{gen, ownEncryptions,
  outbox}`) is written per message. A restart reads the snapshot, takes the outbox and the count from a
  journal of the same `gen` (an older one is ignored), burns that many sender-ratchet steps so no key is ever
  reused, and reads the envelopes after the snapshot's cursor again (the history merge is idempotent). The
  same compare-and-set scheme guards every record. The forward-secrecy cost, said plainly: the keys of
  messages **read** since the last snapshot stay in the stored snapshot until the next one, **at most 16
  messages**. (3) **Not built:** on Android only the wrapping key living in StrongBox, with bulk values
  AES-GCM under it in app-private storage (`KeystoreSecretStore.java`); the mobile lane owns it
  (docs/TODO.md). Until then each record still goes through the Keystore as before, only smaller and rarer.
- **Our own commits across a lost acknowledgement (a host contract, since 2026-10-10).** `add`, `remove`
  and `selfUpdate` return, beside the new state and the commit, a `pendingCommit`: the hash of the commit's
  exact bytes and the state it leads to. The host (1) stores it, with `encodePendingCommit`, atomically
  beside the current state BEFORE it posts the commit; (2) on an acknowledgement adopts `result.state` and
  deletes the pending commit; (3) after a restart, a timeout or a 409, fetches the commit the relay holds
  for that epoch and calls `adoptPendingCommit(state, pendingCommit, relayCommit)`: `adopted: true` gives
  the state to save (the relay holds exactly our bytes, or the state already is the result), `adopted:
false` means another commit won, so the host deletes the pending commit and hands the relay's commit to
  `processCommit`. It never builds a second commit while one is pending, and never discards one whose POST
  may still land: the engine refuses to process its own commit, so a pending commit dropped too early
  stalls the device at that epoch. The host keeps the commit bytes itself if it wants to re-post them.
- **Stored bytes of another version are kept (a host contract).** The state, the pending commit and the
  KeyPackage secrets each start with a format version. Bytes of a version this build does not read are
  `STATE_VERSION_UNSUPPORTED`, distinct from `STATE_CORRUPT`: the host keeps them (a matching build reads
  them) and never deletes them on that code; it may offer to re-join only when the user chooses to.
  `STATE_CORRUPT` is damage. Until 2026-10-10 an unknown version was reported as corrupt.
- **Old keys are kept for four epochs and ten generations per sender, and no longer.** The engine leaves the
  library's retention at its default: keys for the last 4 epochs, 10 generations per sender, and at most
  200 forward ratchet steps for one message. A message from an epoch older than that fails as
  `EPOCH_MISMATCH` and cannot be read afterwards. The reason: every retained key is a key a stolen device
  can read old traffic with; four epochs cover the commits that overtake a message in flight, ten
  generations the messages that overtake each other inside one epoch. A host that expects more reordering
  than that fixes the order it processes in; it does not ask the engine to keep more.
- **The host's processing order (a host contract).** Per room: commits strictly in the relay's sequence
  order, one at a time, each against the state the previous one produced; an application message only after
  every commit that precedes it; a commit from the stored backlog with `backlog: true`, a live one without.
  A commit the engine refuses is not skipped: the device is stuck at that epoch, and the host reports it
  and asks a member to add the device again (a re-join is an ordinary Add). A host retries between
  commits, never out of order. The directory it supplies is held to the same contract as the in-memory
  one by `__tests__/contract-directory.ts`, run against the host's real directory (exporting that suite to
  hosts is a target, not built).
- **Key storage is device-bound (a host contract).** What `SecureStorage` holds (the device's signature key,
  the MLS state, the push sub-key) lives on this install only. It is **not synced** to another device or to
  a cloud (no keychain sync, no cloud backup, no device-to-device transfer), and it is **gone when the app
  is uninstalled or its data is cleared**. A reinstalled app is a new device: it enrols again and reads no
  history, the same fact section 4 states for the switch-on. A synced key would turn "one device, one key"
  into "every device the account's cloud reaches", so a host that cannot promise this must say so. The port
  states the rest of the contract: a failure is never reported as an absence (`unavailable`, `corrupt`,
  `invalid`, `conflict` and `failed` are distinct, typed kinds), the size limits are the port's, `clear(prefix)`
  is the sign-out wipe, and there is **one writer per device**: where several writers can share one store (the
  tabs of a browser), a write from a writer that has not seen the latest version is refused as `conflict`
  instead of overwriting newer MLS state. Values never reach a log: the native hosts keep the platform
  bridge's call logging off in release builds and refuse to carry a value while it is on. The Masia hub's
  native hosts use the platform's hardware-backed store. On iOS each value is a Keychain item that is
  this-device-only and not synchronizable, readable only while the phone is unlocked (`identity`, `history`)
  or after its first unlock (`push`, so a push can be decrypted on a locked screen); the Keychain outlives an
  uninstall, so the app erases its own items on the first start of a fresh install. On Android each value is
  encrypted with an AES-GCM key in the Keystore (StrongBox where the phone has one, silently the TEE
  otherwise) and the file sits in a directory excluded from backup and device transfer, so an uninstall
  removes both; a Keystore key that is lost or unrecoverable makes its values `corrupt`, never absent, and is
  not replaced while a value it wrapped remains. **The web host is weaker.** A non-extractable key kept in
  the browser's IndexedDB wraps each value, and that hides values only from casual browsing (someone scrolling
  the storage in developer tools, or same-origin code that enumerates storage without knowing the format).
  It does **not** protect a copy of the disk: the browser keeps the wrapping key in the same IndexedDB, so a
  copied profile, its backup, or malware that reads it holds the key and the ciphertext together. Nor does
  it protect against script running in the same page, which can ask the browser to use that key (see
  "Honest limits"). Targets, not built: a wrapping secret that is not on the disk (a WebAuthn PRF output, or
  a half released by the server after sign-in). _The MLS state in a dedicated Worker, out of the page's
  reach, is built on the web host since 2026-10-10 ([section 11](#11-the-hosts-engine-a-worker-and-what-this-device-means))._
- **Patched library check: the unmerged leaves of a joined tree (interop finding F1).** RFC 9420 section
  12.4.3.1 says, for each entry in a parent node's `unmerged_leaves`: "Verify that the entry represents a
  non-blank leaf node that is a descendant of the parent node" and "Verify that every non-blank intermediate
  node between the leaf node and the parent node also has an entry for the leaf node in its unmerged_leaves."
  ts-mls 1.6.4 demanded more: every non-blank node on the leaf's WHOLE direct path, above the listing node
  too, had to carry the SAME list. A node refreshed by an UpdatePath from the other half of the tree has an
  empty list (legal), so a newcomer could not join a room that had held five or more devices. The repo pins a
  patch of the library (`patches/ts-mls@1.6.4.patch`, recorded in the lockfile and applied by
  `pnpm install`) that checks exactly the two RFC sentences: the nodes strictly between the leaf and the
  listing node, by membership; and the listed leaf must be non-blank AND a descendant, where the library
  accepted either one. Every other check of the library is unchanged. Test:
  `src/mls/__tests__/ratchet-tree-unmerged-leaves.test.ts` (the K1 sequence and a leaf under two refreshed
  ancestors through `MlsEngine`, and library-level controls that the patched check still refuses a missing
  intermediate entry, a non-descendant and a blank leaf); without the patch it fails with the library's own
  message. Upstream report pending; when a ts-mls release carries the fix, the patch is dropped with the
  version bump and the test stays.

Known limits:

- **A device revoked but not yet removed** can still commit in a replayed backlog while a verified version
  at or above the pin lists it. Live, it cannot. The window closes with the removal commit.
- **The newcomer's leaf is the only new key material after an Add** until it posts its `selfUpdate`. The host
  must send it promptly; `needsSelfUpdate` says when it is owed.
- **The epoch authenticator is shown, not enforced.** Two members that see a different value have forked
  groups; the engine returns the value and the host shows it. Nothing here forces the check. The UI shows the
  value as the room's "security code" (`formatEpochAuthenticator` turns the engine's bytes into eight groups of
  four hex digits, the first 16 bytes), with the key version and a hint to compare it in person or on a call.
  It does not compare, store or require it, and a room whose engine has no value yet says "not available"
  instead of showing an empty box.
- **A removed device keeps the old epochs' secrets** (it can still read what it already could). It cannot
  derive the next epoch, send or commit. The relay serves it exactly that much: the removing commit and the
  messages of the epochs it was in, then `REMOVED`.
- **Adding a minor to a room that already holds Masia is not gated by the engine.** The policy gates the
  Masia Add (above); the symmetric case is the host's room policy, and a target for the engine.
- **A device id that two users share** cannot be told apart in the relay's removal delta (it names devices
  by id only), so an honest removal of such a device is refused and stalls. Device ids are one per install
  and the host must not hand one id to two users.
- **The cost of joining is bounded by the handshake size cap (256 KB) and the 256-device limit**, not by
  anything finer: the tree is counted before the library verifies it, but reaching it takes the library's
  own first steps (one HPKE open, one AEAD open, one decode), which the join then repeats.
- **Adopting a pending commit restarts from the state it was built on.** Application messages the device
  decrypted in the old epoch between building the commit and adopting it are not in the adopted state's
  replay record; a host sends and reads nothing in a room while a commit of its own is pending.
- **The header parser existed twice until 2026-10-10** (here and in the relay), held together by a parity
  test rather than by one module. No longer a limit: there is one parser, `parseMlsHeader` in
  `@masia/contracts/wire`, which the relay calls directly and the engine wraps to map its errors onto
  `MlsErrorCode` (architecture review round 1, M14).

## 10. What travels inside the ciphertext

In an encrypted room the relay stores ciphertext and nothing else, so everything that makes a message a
message rides **inside** the encrypted bytes: its id, whether it is new text, an edit, a delete, a sticker,
a reaction or a notice, and what it replies to. The format is one small JSON object, UTF-8, sealed as one MLS
application message (`@masia/messenger/protocol`, `e2ee-payload.ts`; amendments (е) and (и) of the host's E2EE
decision record). **There is one codec:** every member speaks it — a person's client and Masia's custody
device alike (the device's `payload.ts` is an adapter over it, never a second encoder), and a cross-test
encodes on one side and decodes on the other.

- **Versioned.** Every payload carries `v` (today `1`, `E2EE_PAYLOAD_VERSION`). A higher version is
  `VERSION_UNSUPPORTED`, never a guess; unknown extra fields are ignored, so a newer sender stays readable by
  an older client within the same version.
- **Six kinds:** `text` (body, an optional reply with a short quote), `edit` and `delete` (a target id),
  `sticker` (a **catalog id only**, a motion and an optional sound preset; since 2026-10-10 no URL travels:
  each reader's host resolves the id from ITS OWN catalog and draws an id it does not know as a placeholder,
  so no member can make every reader's device fetch an address of their choosing — round 2 sec-M4, ADR-117
  amendment (і); an `imageUrl` from an older sender is ignored like any unknown field), `reaction` (a
  target id, one emoji of at most 32 characters with no spaces, and `removed: true` to take it back — one per
  person and emoji) and `notice` (an i18n key `ns:key`, never prose; a client shows only keys it knows and
  treats any other as "could not be read"). An unknown kind is `UNKNOWN_KIND`.
- **Length-capped.** The whole payload is at most 48 KiB (`E2EE_PAYLOAD_MAX_BYTES`, under the engine's
  plaintext cap so a payload the format accepts is never refused by `encrypt`); text at most 10 000
  characters, a reply quote 280, a name 120, a preset 64. Ids are wire ids.
- **Decoding never throws.** Bytes from another member are untrusted input: malformed, oversized,
  future-versioned or unknown-kind bytes come back as a typed error, and the thread shows that one message as
  "could not be read" and moves on. A fuzz test feeds the decoder random and mutated bytes and asserts
  exactly that.
- **The sender comes from the tree, never from the payload.** An edit or a delete changes its target only when
  the MLS sender of both is the same user (`canApplyE2eeChange`); a payload that claims a name or an author
  is ignored on that point. **A payload id is the sender's word, so it is never an identity on its own**: a
  reader keys what it stores by (MLS sender, payload id) and, for the same id from two senders, the first
  message stands; a member reusing another member's id can neither replace nor erase that member's message
  (round 2 sec-M3; a property test over random two-member runs in the reference host).
- **The same screens.** `e2eePayloadToEvent` turns a payload into the `msg:*` events the view-model already
  folds, so an encrypted room is drawn by the same code as any other.
- **Reactions ride inside**, keyed by the payload id — the host never sees which emoji on which message.
- **The host learns that a message exists, not what it says.** After the relay takes a `text` or `sticker`,
  the client tells the host `msg:send {text: '', e2eeEnvelopeId}`, so the inbox and the room's SYSTEM rows
  stay true; the host's `msg:new` for that envelope is the other members' signal to fetch (the relay has no
  push yet; polling stays the fallback). The announce is not a promise held in memory: the Worker keeps an **announce
  outbox** per room (`mls/<u>/<dev>/announce/<conv>`, entries `{payloadId, kind, seq}`, at most 500; no
  content), written BEFORE the room host forgets the sent message, so a page closed between the relay's 201
  and the announce loses nothing. The page replays it when a room opens, when the relay takes a message and
  when the link is up (never before the api's own history is in). An entry is removed (**acked**) when the
  api answered 2xx or when the api already shows a row with that `e2eeEnvelopeId`; one the api did not take is
  asked again after 15 seconds. The api does not deduplicate by envelope id, so a crash between its 2xx and the
  ack can show one extra row (docs/TODO.md). The host's own SYSTEM rows (`serviceMeta.e2eeNotice`) are shown in
  time order; envelope rows never are.
- **Photos and files are not inside:** media is not
  encrypted on the client yet, so an encrypted room refuses them rather than send the one thing the server
  could read, and the badge says "media we can read" ([section 5](#5-what-the-relay-sees)).

## 11. The host's engine: a Worker, and what "this device" means

The engine is a library; where it runs is the host's choice, and the choice is part of what the room
promises. The web host (the first one, wired 2026-10-10) runs it like this:

- **In its own module Worker.** Group state, keys, pending commits and the outbox live in the Worker; the
  page receives plaintext messages and a plain room snapshot (phase, epoch, security code, members,
  `sending`, `readOnly`, `removed`, `historyBefore`), never state and never a key. The Worker's script is
  served with **its own Content-Security-Policy**: same-origin scripts only, no `eval`, no frames or
  objects, network to its own origin and the relay over https. On start the Worker checks that `eval` is
  really refused and reports it; the page cannot fake it. Where no module Worker starts, the same code
  runs in the page and the sheet says the engine is **not** isolated.
- **Where the keys rest.** On the web the Worker opens the secure store (IndexedDB, wrapped) itself, so the
  bytes never pass the page. On the native app the Keychain or Keystore is reachable only from the page
  side of the bridge, so the Worker hands each record it stores to the page and the page writes it there.
  The stored state therefore passes through the page's memory on the way to and from the Keychain: the
  honest limit of a bridge. A native Worker bridge would close it (target); until then the computations are
  isolated, the stored bytes are not.
- **Where the relay requests go out (2026-11-03).** On the web and on iOS the Worker's own `fetch` reaches the
  relay directly. On the Android app it cannot: the shell serves the app from an `https://` origin that is
  the relay's own host and answers every request of that origin itself, so the Worker's `fetch` to the relay
  is given the app's `index.html` instead of the relay's JSON (the app never registered a device). Only the
  page's `fetch` is bridged to the native HTTP stack, so on the Android app the Worker hands each relay
  request to the page (`relay.fetch` in the Worker protocol, chosen by the page at `init` with
  `network: 'page'`), and the page makes it. What passes the page's memory there is the relay token (the
  page issues it anyway) and the bytes the relay sees in any case: ciphertexts, commits, public key
  packages, signed device lists. Group states and keys still never leave the Worker; a script in the page
  could read what the relay reads, not more. The second honest limit of the bridge, closed by the same
  target as the first.
- **This device, in the sheet.** `ConversationSecurityState.thisDevice` says whether the engine is isolated
  and where the keys rest (`hardware` or `browser`), and the browser line says what that store does not
  protect. A value the host does not know is absent; nothing is rounded up.
- **One writer per room.** Two tabs of one browser share one store. A Web Lock per room picks the writer and
  every write is compare-and-set, so a tab that loses (the lock, or a write) turns **read-only**: it shows
  the room, keeps what is typed in its queue, says so once ("open in another tab"), and takes over when the
  writer closes.
- **Our own commits ([section 9.7](#97-choices-made-on-purpose-and-known-limits)).** The pending commit is
  stored before the POST; after a lost answer or a restart the host finds the relay's commit for that epoch
  and adopts or drops its own; on a 409 it processes the winner. While a commit is pending nothing is sealed
  or sent; the composer stays usable, and what is typed waits ("sending…").
- **The relay token** comes from the host's api for the signed-in device, is renewed at about two thirds of
  its lifetime (jittered, never later than 30 seconds before it ends), and a 429 or 503 is retried after
  `Retry-After`. "This device is signed out" is a **state** of the room ("sign in again"), asked once, never a
  loop. `REMOVED` is a state too (the device keeps what it read), and an `oldestAvailableSeq` gap says
  "history before {date} is on your other devices".
- **Sign-out wipes.** Everything the host keeps for an account is under that account's prefix in the secure
  store and is cleared on sign-out and when another account signs in on the device; an expired session
  (the same person) keeps it.
- **Enrolment and entering rooms run in the Worker too (W3c; worker protocol version 2).** The page tells the
  Worker the facts the api knows and the relay does not (`facts`: family, the group id the api recorded, the
  people's relay user ids, Masia's mode) and asks it to `enrol` (again), to `approve` a typed code and for the
  announce outbox (`announces`, `ackAnnounce`); the Worker answers with the events `device` (the enrolment
  state) and `room` (how entering went: `joined`, `waiting-for-creator`, `waiting-for-add`, `no-welcome`,
  `device-not-ready`, `unavailable`, `transient`, plus typed notices `not-a-contact`, `identity-changed`,
  `device-list-refused`, `masia-unavailable`). A room's group is created as a recorded intent first
  (`…/creating/<conv>`), then `PUT …/mls-group` at the api (set once; the api is the arbiter), then
  `POST /conversations/{id}/e2ee` at the relay; a crash in between resumes from the intent. Joining is by the
  Welcome addressed to one of this device's KeyPackages, reading on from the Welcome's own cursor
  (`RelayCursorAtJoin`); a joiner saves the joined room BEFORE it spends the KeyPackage's secret (a failed save
  keeps the package, so the same Welcome still opens on the next entry; nothing re-Adds a device already in
  the tree). Every member adds the devices that are on a person's verified signed list and not in
  the tree (new people, a member's new device, and, once the phase rule is lifted, Masia's custody device when the
  room's effective mode wants her; in phase 1 that last one is never asked for, see
  [section 2](#2-masia-is-a-visible-opt-in-member)), one Add commit per person, so one person's refusal does not block the next; several members may add the same
  device at once, the relay serves one commit per epoch and the loser finds nothing left to add. Unsent
  messages survive `REJOIN_NEEDED` as drafts and are sealed again once the device is added back.
- **The banner.** `E2eeRoomBanner` (above the thread) is quiet when all is well. It shows the code a new
  device waits with, one line per refusal (once per kind; never a user id or an engine code), "Try again"
  where asking again can help, and "Add a device" where this device holds the identity key. The words are the
  `messenger:e2ee.enrol.*` keys in ua, en and de.
- **Per room.** A room is end-to-end encrypted when the host's inbox says so (`e2ee: true`); every other room
  keeps the plaintext path unchanged.

## Honest limits

- The server sees metadata: who, to whom, when. Always.
- A server-side Masia in a room holds a key to it. That is trust in the Masia operator in rooms where she
  was invited, and it is stated in the header. On-premises custody is the strategic answer, not an extra.
- The web device is weaker than a phone, against scripts in its own page.
- On the native app the stored state passes the page's memory on its way to the Keychain or Keystore, and on
  the Android app so do the relay requests (the token and what the relay sees anyway); the keys and the
  group states never do ([section 11](#11-the-hosts-engine-a-worker-and-what-this-device-means)). A native
  Worker bridge is the target that closes both.
- Until media is encrypted on the client, media is readable by the operator, and the room badge says so.
- Chats with children include a guardian device by design; it is visible to everyone and is not hideable.
- The security code is shown, not enforced: nothing makes a member compare it, so a forked room is caught only
  by a person who looks ([section 9.7](#97-choices-made-on-purpose-and-known-limits)).
- Screenshot blocking on iOS is not promised (there is no API); Android's `FLAG_SECURE` works.
- Phone numbers as identifiers, federation, private-group credentials and key transparency are not built;
  key transparency is a review trigger, not a version-one promise.
- The MLS library is young, has one maintainer and has not been audited. Our validator narrows that risk
  (it decides who is in a group and what changed) and does not remove it: signatures on messages, the
  confirmation tag and the AEAD still come from the library ([section 9.4](#94-what-we-still-take-from-the-library)).
- A device that was revoked and not yet removed can still commit in a backlog that lists it in an old
  version, and a device that stays offline longer than the relay keeps its commits cannot catch up and must be
  added again ([section 9.7](#97-choices-made-on-purpose-and-known-limits)).
