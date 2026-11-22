# Masia messenger playground

One command, two browser tabs, an end-to-end encrypted chat through a relay that runs on your machine. It is
the open messenger core ([`@masia/messenger`](../packages/messenger/README.md)) with the thinnest host that
can run it: no account system, no assistant, no cloud.

## Try it

You need Docker with Compose v2. The first build takes a couple of minutes; later starts take seconds.

```sh
git clone <repository-url>
cd demo
docker compose up --build
```

Then:

1. Open <http://localhost:8080> in a tab and join with a name, say `Ada`.
2. Open the same address in a second tab (or a private window) and join as `Bo`.
3. In either tab, pick the other person from the list and write. The message appears in the other tab within
   a few seconds (the page asks the relay every 2.5 seconds; messages have no push channel in this playground,
   only calls ride a live stream).
4. Press **Call** in the chat's header to call the other tab: see [Call the other tab](#call-the-other-tab).

Port 8080 taken? `DEMO_PORT=8081 docker compose up --build`. Stop with Ctrl-C. `docker compose down -v`
removes the containers, the token keys and the database.

A tab is one person. Its keys live in that tab's memory and nowhere else, so **reloading the tab makes you a
new person**: join again and you are a fresh device with a fresh history. The old you disappears from the
other tab's list after about two and a half minutes.

Alone in the playground, the contact list is empty and shows a short "people you could write to" block. It is
filled from [`contacts.json`](contacts.json), which mirrors [`MAINTAINERS.md`](../MAINTAINERS.md). Add
`?lang=uk` or `?lang=de` to the address to see that block in Ukrainian or German; the rest of the page is
English only here.

## Call the other tab

A one-to-one audio call between the two tabs, on the messenger's own call engine and call screen
([`calls.md`](../packages/messenger/docs/calls.md)).

1. Open the chat in both tabs and wait until the status line above it is gone.
2. Press **Call** in one tab. The other tab shows the incoming call (there is no ring sound: keep it in view,
   or side by side). Press **Answer** there.
3. Both tabs show the live call, the other person's name and **Verified through the encrypted chat**. Each tab
   hears the other's microphone; with both tabs on one machine, wear headphones or mute one side. **Mute** and
   **Hang up** do what they say; the screen folds into a pill if you want the chat back while you talk.

**Call** appears only once the chat's room is open on this tab with both people in it; until then there is no
button at all. When it is there but cannot be pressed, the reason is written beside it: "Calls are getting
ready…" (the tab's call engine is not up yet), a call is already on, the microphone is blocked, or the call
channel is not connected. The compose file switches the relay's call channel on (`RELAY_CALLS_ENABLED=true`); a
relay has it off by default, and against such a relay **Call** stays off with "The call channel is not connected.
Is it switched on in the relay?".

The relay passes a call's signals only between the two tabs of a call one of them rang. A call that only rings is
forgotten after ten minutes with no signal. Once it is answered, the relay keeps it through four hours of quiet (a
live call goes quiet on the channel once the sound flows), so the hang-up still reaches the other tab, and the
hang-up closes the call at the relay: nothing more of it passes. A call quiet for longer than four hours loses its
hang-up at the relay, and the other tab ends the call when the sound stops (at most about half a minute later).

### Known limits

- **Three tabs in one browser can stall.** Each tab keeps one live stream open to the relay for calls (two for a
  moment, while it renews it), and a browser opens at most six HTTP/1.1 connections to one host, across all its
  tabs. With three or more playground tabs in one browser, the streams can take every connection, and messages and
  calls stop until a tab is closed. Use two tabs per browser; put a third person in another browser.
- **A refused token is not replaced at once.** The call channel uses the relay token the tab already holds. When
  the relay refuses it (`401`), the channel tries again later with the same token; it does not ask for a new one.
  The tab renews its token shortly before it expires, or when the chat's own requests are refused, and calls work
  again from then.
- **A channel that stopped for good stays stopped.** When the relay answers the call stream with `403` or `404`
  (the switch is off, or the device may not call), or a newer stream of the same device takes its place, the tab
  stops asking. **Call** stays off, and calls come back only after a reload (which, as above, makes you a new
  person).

### What a call proves

The call's signals (offer, answer, ICE candidates) go through the relay; the sound goes straight from one tab
to the other over WebRTC (DTLS-SRTP). Before the call counts as live, each side sends a tag computed with a key
that only members of the chat's MLS group can derive (the group's exporter for that call), over the two DTLS
fingerprints both sides saw in the SDPs. If the relay, or anyone on the way, swapped an SDP to sit in the middle,
the tags do not match and the call ends as not verified. **Verified through the encrypted chat** means the other
end holds the chat's group at the same epoch, and the encrypted media is keyed to the fingerprints you both saw.
It names the person from the group's own member list, never from what the relay says.

`pnpm -F @masia/demo smoke:call` checks all of this in a real Chromium against a running stack: two people sign
in and make two calls. In each, one calls, the other answers, both reach the live call verified, each screen names
the other person, and the sound of each arrives at the other (the received audio's packet, byte and energy
counters grow). The caller hangs up the first call and the callee the second; each time the other side shows a
plain "Call ended" within five seconds, with no problem on its screen, and both screens close by themselves.

### What a call does not protect

- **The relay operator sees the signalling.** Who calls whom and when, both devices, and the whole SDP of each
  side: both IP addresses (the ICE candidates), the codecs and the DTLS fingerprints. The tag stops a swapped
  fingerprint; it hides none of this.
- **The path is direct.** There is no STUN and no TURN server. Each side gets the other's IP address. The
  playground uses direct candidates only when the page is on this machine (`localhost` or any `*.localhost`
  name[^localhost], any address in `127.0.0.0/8`, or `[::1]`): opened from anywhere else, an answered call ends
  before any connection is tried (no candidate is gathered, no sound is sent), with a message that there is no
  relay server. Use the playground on your own machine, or on a network you trust.
- **The relay is not checked.** Only the page's address is. The page reaches the relay through its own server's
  `/relay` door, and that server forwards to whatever `DEMO_RELAY_URL` names. If you point it at a relay someone
  else runs, they see every call's signals: both IP addresses and every SDP.
- **No rules on who may call.** There is no blocking, no quiet hours and no protection for children: anyone who
  shares a chat with you can ring you, at any hour. A real host decides who may call whom; the playground does
  not.
- **No ring sound, no push.** A call reaches a tab only while it is open and connected to the call channel.

[^localhost]: A `*.localhost` name is this machine only where it resolves to a loopback address. Some browsers
    see to that themselves; otherwise it is up to your system's resolver, and the name may lead somewhere else.
    The playground goes by the name alone.

## What is encrypted, and what is not

| | |
|---|---|
| Message text, edits, deletes, reactions, replies | **End-to-end encrypted** (MLS, RFC 9420, cipher suite 1). The relay stores padded ciphertext (short messages all come to the same size, about 383 bytes) and cannot read it. |
| Who is in a room, and when messages were sent | Visible to the relay, and by design: it routes by room, device and epoch. |
| Your name, as the other tab sees it | Not secret: the page's own server keeps the list of who is here, and the device name registered at the relay contains your name. |
| Pictures and other media | **Not end-to-end encrypted** in this design, and not part of the playground at all. |
| Keys | Generated in your tab, kept in memory, never sent anywhere. The relay gets public keys only. |

Trust in the other person's keys is **trust on first use**: the first time a tab sees someone's signed
device list it remembers it, and it refuses a different one later. There is no out-of-band check in the
playground beyond the epoch code in the room's security sheet, which you can compare in both tabs.

The honest limits of the design are written down in the canon, under
[Honest limits](../packages/messenger/docs/canon.md#honest-limits), and what the relay sees in
[section 5](../packages/messenger/docs/canon.md#5-what-the-relay-sees). The playground adds its own: see
"Shortcuts" below.

## What the relay sees

Look yourself while two tabs are chatting:

```sh
docker compose exec relay-db psql -U relay -d relay \
  -c "select conversation_id, epoch, seq, sender_device_id, length(ciphertext) as bytes from envelopes"
```

Rows with room, epoch, a sequence number, the sending device and the size of the ciphertext. There is no
text column anywhere in that database. The other tables are the devices (id, public keys, the name above),
their signed device lists, one-time public key packages, the MLS handshake messages (opaque bytes plus the
member changes the committer declares) and who is a member of which room.

## Shortcuts (DEMO ONLY)

Each of these is a shortcut on purpose and none belongs in a deployment:

- the web service hands a relay token to anyone who types a name: there are no accounts and no passwords;
- the token signing key is generated when the stack starts (a `keygen` service writes it into a volume) and
  disappears with `docker compose down -v`; nothing secret is in the repository;
- the database accepts connections from the compose network without a password and keeps nothing on disk;
- the page is published on `127.0.0.1` only, because anyone who reaches it can get a token;
- rooms are one-to-one (`dm_<id>_<id>`, named from the two user ids), because the relay has no "list my
  rooms" call yet: the page asks about the room of each person it knows is here;
- circles and pins live in memory; reload and they are gone;
- calls connect directly with no STUN or TURN server, and only when the page is on this machine (the relay the
  page's server forwards to is not checked); the call binding runs in the page, because the playground has no MLS worker to keep the call key in (the
  package's binding still wipes the key after each question);
- the images run TypeScript through `tsx` and are pinned by tag, not by digest.

Masia, the assistant, is not here. In the product she is an opt-in member of a room that you address with
`@masia`; the playground has no assistant, so typing that does nothing special.

## What is where

| | |
|---|---|
| `docker-compose.yml`, `docker/` | the stack: `keygen`, `relay-db`, `relay` (built from [`apps/relay`](../apps/relay), AGPL-3.0), `web` |
| `server/` | the page's server: static files, the token issuer, the list of who is here, a same-origin door to the relay |
| `src/client/` | the client runtime: sessions, enrolment, the room loop, history; it speaks the relay's wire vocabulary from `@masia/contracts/wire` |
| `src/host/` | the host adapter: the messenger's ports implemented for this page; `call*.ts(x)` and `call-frame.css` are the call's ports, words, icons and frame |
| `src/*.tsx` | the screens: join, shell |
| `smoke/two-people.ts` | the whole flow for two people against a running stack, without a browser |
| `smoke/two-people-call.ts` | a call between two people in a real Chromium against a running stack (`smoke/cdp.ts` drives the browser) |

The page imports only `@masia/messenger` and `@masia/contracts`, never the relay; a test
(`src/guardrails.test.ts`) keeps it that way.

## Develop

```sh
pnpm install
pnpm -F @masia/demo test        # unit tests
pnpm -F @masia/demo typecheck
```

`pnpm -F @masia/demo dev` serves the page with hot reload and sends `/demo` and `/relay` to the playground's
server (`pnpm -F @masia/demo start`), which needs the relay and its database (and, for calls, the relay started
with `RELAY_CALLS_ENABLED=true`); the compose stack is the easiest way to have both.

Against a running stack:

```sh
pnpm -F @masia/demo smoke         # two people chat, no browser
pnpm -F @masia/demo smoke:call    # two people call, in a headless Chromium
```

Both read `DEMO_ORIGIN` (default `http://127.0.0.1:8080`). The call smoke uses `DEMO_CHROMIUM` (a Chromium or
Chrome binary), else the newest Chromium a browser-testing tool has cached on this machine; `DEMO_SHOTS=<folder>`
also saves pictures of each call there (ringing, live, and the other side's ended screen).

## Licence and contact

Apache-2.0, like the rest of the client; the relay it talks to is AGPL-3.0. Maintainers:
[`MAINTAINERS.md`](../MAINTAINERS.md).
