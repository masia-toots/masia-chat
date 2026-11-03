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
   a few seconds (the page asks the relay every 2.5 seconds; there is no push channel in this playground).

Port 8080 taken? `DEMO_PORT=8081 docker compose up --build`. Stop with Ctrl-C. `docker compose down -v`
removes the containers, the token keys and the database.

A tab is one person. Its keys live in that tab's memory and nowhere else, so **reloading the tab makes you a
new person**: join again and you are a fresh device with a fresh history. The old you disappears from the
other tab's list after about two and a half minutes.

Alone in the playground, the contact list is empty and shows a short "people you could write to" block. It is
filled from [`contacts.json`](contacts.json), which mirrors [`MAINTAINERS.md`](../MAINTAINERS.md). Add
`?lang=uk` or `?lang=de` to the address to see that block in Ukrainian or German; the rest of the page is
English only here.

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
- the images run TypeScript through `tsx` and are pinned by tag, not by digest.

Masia, the assistant, is not here. In the product she is an opt-in member of a room that you address with
`@masia`; the playground has no assistant, so typing that does nothing special.

## What is where

| | |
|---|---|
| `docker-compose.yml`, `docker/` | the stack: `keygen`, `relay-db`, `relay` (built from [`apps/relay`](../apps/relay), AGPL-3.0), `web` |
| `server/` | the page's server: static files, the token issuer, the list of who is here, a same-origin door to the relay |
| `src/client/` | the client runtime: sessions, enrolment, the room loop, history; it speaks the relay's wire vocabulary from `@masia/contracts/wire` |
| `src/host/` | the host adapter: the messenger's ports implemented for this page |
| `src/*.tsx` | the screens: join, shell |
| `smoke/two-people.ts` | the whole flow for two people against a running stack, without a browser |

The page imports only `@masia/messenger` and `@masia/contracts`, never the relay; a test
(`src/guardrails.test.ts`) keeps it that way.

## Develop

```sh
pnpm install
pnpm -F @masia/demo test        # unit tests
pnpm -F @masia/demo typecheck
```

`pnpm -F @masia/demo dev` serves the page with hot reload and sends `/demo` and `/relay` to the playground's
server (`pnpm -F @masia/demo start`), which needs the relay and its database; the compose stack is the
easiest way to have both.

## Licence and contact

Apache-2.0, like the rest of the client; the relay it talks to is AGPL-3.0. Maintainers:
[`MAINTAINERS.md`](../MAINTAINERS.md).
