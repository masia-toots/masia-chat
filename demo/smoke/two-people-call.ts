import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { CALL_SCREEN_TEXTS } from '../src/host/call-texts.js';
import { launchChromium, type Page } from './cdp.js';

// The call smoke for a running playground: two people in two real Chromium pages (two browser contexts that
// share nothing, as two browsers would), a microphone Chromium fakes (a tone), and the relay's call channel.
// Two calls, both placed by the same person and answered by the other. In each, both reach the live call verified
// with each other, each screen names the other person, and the sound of each one ARRIVES at the other (the
// received audio's packet, byte and energy counters keep growing). The first call is ended by the caller, the
// second by the callee; each time the OTHER side must show a plain «Call ended» within a few seconds, with no
// problem on its screen, and both screens must close by themselves (a plain end does; a lost or failed call waits
// for «Close», which this smoke never presses).
//
//   DEMO_ORIGIN=http://localhost:8080 pnpm --filter @masia/demo smoke:call
//
// Chromium: DEMO_CHROMIUM, else the newest Chromium in the browser-testing cache. DEMO_SHOTS=<folder> also
// saves pictures of each call (ringing, live, and the other side's ended screen) there. The relay's call channel
// must be on, and the page must be on this machine (the playground connects a call directly only when the page is
// on loopback).
//
// Exit code 0 means every step happened; the first thing that does not happen within the time limit fails the
// run and says which step it was, with each page's errors.

const ORIGIN = process.env['DEMO_ORIGIN'] ?? 'http://127.0.0.1:8080';
const SHOTS = process.env['DEMO_SHOTS'];
const STEP_TIMEOUT_MS = 60_000;
const POLL_MS = 250;
/** How long the received audio is watched: long enough for a steady stream of packets, short enough to wait for. */
const AUDIO_WINDOW_MS = 2_000;
/**
 * How long after the hang-up both sides may take to show the end. The other side learns of it through the relay
 * within a second; a side that does not (the signal was lost, the call ends `lost` only after the media timeout)
 * must fail here, not be waited out.
 */
const PLAIN_END_MS = 5_000;
/** The end is read this often: the plain end's closing beat lasts only a couple of seconds before it closes. */
const END_POLL_MS = 100;
/** A plain end closes its screen by itself after the package's short closing beat; this is the ceiling allowed. */
const CLOSES_ITSELF_MS = 6_000;
/** The closing words of a hang-up, on both sides. */
const HANGUP_WORDS = CALL_SCREEN_TEXTS['end.ended'];

const started = Date.now();
const log = (line: string) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${line}`);
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** Records every peer connection the page makes, so the smoke can read what it received. */
const PEER_RECORDER = `(() => {
  const Native = window.RTCPeerConnection;
  if (typeof Native !== 'function') return;
  const peers = [];
  Object.defineProperty(window, '__smokePeers', { value: peers });
  window.RTCPeerConnection = new Proxy(Native, {
    construct(target, args, newTarget) {
      const peer = Reflect.construct(target, args, newTarget);
      peers.push(peer);
      return peer;
    },
  });
})();`;

interface InboundAudio {
  readonly found: boolean;
  readonly packets: number;
  readonly bytes: number;
  /** Measured where the sound is played out: it grows only with sound that is heard, not with silence or bare packets. */
  readonly energy: number;
}

const READ_INBOUND_AUDIO = `(async () => {
  let found = false, packets = 0, bytes = 0, energy = 0;
  for (const peer of window.__smokePeers ?? []) {
    if (peer.connectionState === 'closed') continue;
    (await peer.getStats()).forEach((stat) => {
      if (stat.type !== 'inbound-rtp' || stat.kind !== 'audio') return;
      found = true;
      packets += stat.packetsReceived ?? 0;
      bytes += stat.bytesReceived ?? 0;
      energy += stat.totalAudioEnergy ?? 0;
    });
  }
  return { found, packets, bytes, energy };
})()`;

const testId = (id: string) => `[data-testid="${id}"]`;
const query = (selector: string) => `document.querySelector(${JSON.stringify(selector)})`;
/** What the call screen shows, whether full or folded into its pill. */
const CALL_STAGE = '.demo-call-layer [data-stage]';
const stageIs = (stage: string) => `${query(CALL_STAGE)}?.dataset.stage === ${JSON.stringify(stage)}`;
const pressable = (selector: string) => `(${query(selector)} !== null && !${query(selector)}.disabled)`;
/** A person in the people list, by name: the button that opens a chat with them. */
const personNamed = (name: string) =>
  `[...document.querySelectorAll('.circlesel__person-open')].find((b) => b.querySelector('.circlesel__person-name')?.textContent === ${JSON.stringify(name)})`;
/** A chat in this tab's list, by the other person's name. */
const chatWith = (name: string) =>
  `[...document.querySelectorAll('.demo-chats__row')].find((b) => b.dataset.peer === ${JSON.stringify(name)})`;

/** What an ending call screen shows: its stage, its closing words and a problem line, if any. */
interface EndSeen {
  readonly stage: string | null;
  readonly closing: string | null;
  readonly problem: string | null;
}

const READ_END = `({
  stage: ${query(CALL_STAGE)}?.dataset.stage ?? null,
  closing: ${query(testId('call-closing'))}?.textContent ?? null,
  problem: ${query(testId('call-problem'))}?.textContent ?? null,
})`;

/** One person in the smoke: their page and the name they signed in with. */
interface Person {
  readonly page: Page;
  readonly name: string;
}

async function waitFor(page: Page, step: string, expression: string, explain?: string): Promise<void> {
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  while (!(await page.evaluate<boolean>(`Boolean(${expression})`))) {
    if (Date.now() > deadline) {
      const why = explain === undefined ? '' : ` (${await page.evaluate<string>(explain)})`;
      throw new Error(`${page.label}: timed out waiting for: ${step}${why}`);
    }
    await sleep(POLL_MS);
  }
  log(`ok: ${page.label}: ${step}`);
}

/** Presses the element an expression finds; fails when there is none or it is disabled. */
async function press(page: Page, element: string, what: string): Promise<void> {
  const pressed = await page.evaluate<boolean>(
    `(() => { const el = ${element}; if (!el || el.disabled) return false; el.click(); return true; })()`,
  );
  if (!pressed) throw new Error(`${page.label}: nothing to press: ${what}`);
}

async function shoot(page: Page, name: string): Promise<void> {
  if (SHOTS === undefined || SHOTS === '') return;
  const folder = resolve(SHOTS);
  await mkdir(folder, { recursive: true });
  const path = join(folder, `${name}.png`);
  await page.screenshot(path);
  log(`picture: ${path}`);
}

async function signIn(page: Page, name: string): Promise<void> {
  await waitFor(page, 'the sign-in form', query(testId('login-name')));
  await page.evaluate(
    `(() => { const el = ${query(testId('login-name'))}; (el instanceof HTMLInputElement ? el : el.querySelector('input')).focus(); })()`,
  );
  await page.insertText(name);
  await waitFor(page, 'the name is typed', pressable(testId('login-join')));
  await press(page, query(testId('login-join')), 'Join');
  await waitFor(page, `signed in as ${name}`, `${query(testId('me-name'))}?.textContent === ${JSON.stringify(name)}`);
}

/** Waits until the open chat is ready and «Call» can be pressed; on time-out, says what the page shows instead. */
async function callReady(page: Page): Promise<void> {
  await waitFor(
    page,
    'the chat is ready and «Call» can be pressed',
    `${query(testId('chat-status'))} === null && ${pressable(testId('call-start'))}`,
    `[${query(testId('chat-status'))}?.textContent, ${query(testId('call-start-hint'))}?.textContent, ${query(testId('call-start'))} === null ? 'no Call button' : ''].filter(Boolean).join(' / ') || 'nothing shown'`,
  );
}

/** The call screen names the other person (the verified one), not a placeholder or this person. */
async function namesTheOther(self: Person, other: Person): Promise<void> {
  const shown = await self.page.evaluate<string | null>(`${query(testId('call-name'))}?.textContent ?? null`);
  if (shown !== other.name) throw new Error(`${self.page.label}: the call screen names «${shown}», not «${other.name}»`);
  log(`ok: ${self.page.label}: the call screen names ${other.name}`);
}

/** The sound of the other side arrives and is played: packets, bytes and audio energy all grow over the window. */
async function soundArrives(pages: readonly Page[]): Promise<void> {
  const before = await Promise.all(pages.map((page) => page.evaluate<InboundAudio>(READ_INBOUND_AUDIO)));
  await sleep(AUDIO_WINDOW_MS);
  const after = await Promise.all(pages.map((page) => page.evaluate<InboundAudio>(READ_INBOUND_AUDIO)));
  pages.forEach((page, index) => {
    const was = before[index] as InboundAudio;
    const now = after[index] as InboundAudio;
    const packets = now.packets - was.packets;
    const bytes = now.bytes - was.bytes;
    const energy = now.energy - was.energy;
    if (!now.found || packets <= 0 || bytes <= 0 || energy <= 0) {
      throw new Error(
        `${page.label}: no sound arrives from the other side (+${packets} packets, +${bytes} bytes, +${energy} energy)`,
      );
    }
    log(`ok: ${page.label}: sound arrives: +${packets} packets, +${bytes} bytes, +${energy.toFixed(4)} energy in ${AUDIO_WINDOW_MS} ms`);
  });
}

/**
 * Within `PLAIN_END_MS` of the hang-up, the screen shows the end of a hang-up: the ended stage, the hang-up's words,
 * no problem line. Anything else fails at once: other closing words (a lost or failed call), a problem, or a screen
 * that went away before its end could be read. Presses nothing.
 */
async function endsPlainly(page: Page, after: string): Promise<void> {
  const deadline = Date.now() + PLAIN_END_MS;
  for (;;) {
    const seen = await page.evaluate<EndSeen>(READ_END);
    if (seen.stage === 'ended') {
      if (seen.closing !== HANGUP_WORDS || seen.problem !== null) {
        const problem = seen.problem === null ? '' : `, with the problem «${seen.problem}»`;
        throw new Error(`${page.label}: the call did not end plainly: «${seen.closing}»${problem}`);
      }
      log(`ok: ${page.label}: «${HANGUP_WORDS}», no problem, after ${after}`);
      return;
    }
    if (seen.stage === null) throw new Error(`${page.label}: the call screen went away before its end could be read`);
    if (Date.now() > deadline) {
      throw new Error(`${page.label}: still «${seen.stage}» ${PLAIN_END_MS} ms after ${after}`);
    }
    await sleep(END_POLL_MS);
  }
}

/** The ended screen closes by itself, as only a plain end's does; «Close» is never pressed. */
async function closesItself(page: Page): Promise<void> {
  const deadline = Date.now() + CLOSES_ITSELF_MS;
  while (await page.evaluate<boolean>(`${query(CALL_STAGE)} !== null`)) {
    if (Date.now() > deadline) {
      throw new Error(`${page.label}: the ended screen did not close by itself within ${CLOSES_ITSELF_MS} ms (it waits for «Close»)`);
    }
    await sleep(POLL_MS);
  }
  log(`ok: ${page.label}: the ended screen closed by itself`);
}

/** Which side ends the call. */
type Side = 'caller' | 'callee';

/**
 * One call: placed, rung, answered, live and verified on both sides, each naming the other, sound arriving both
 * ways; then `hangsUp` ends it and both sides show a plain end and close by themselves. `shotSuffix` tells this
 * call's pictures from another's.
 */
async function oneCall(people: Readonly<Record<Side, Person>>, hangsUp: Side, shotSuffix: string): Promise<void> {
  const { caller, callee } = people;
  const pages = [caller.page, callee.page];
  log(`--- a call from ${caller.name} to ${callee.name}, ended by the ${hangsUp}`);
  await callReady(caller.page);
  await callReady(callee.page);

  await press(caller.page, query(testId('call-start')), 'Call');
  await waitFor(callee.page, 'the call rings', stageIs('ringing'));
  await shoot(callee.page, `incoming${shotSuffix}`);
  await press(callee.page, query(testId('call-answer')), 'Answer');
  await Promise.all(pages.map((page) => waitFor(page, 'the call is live', stageIs('live'))));
  await Promise.all(pages.map((page) => waitFor(page, 'verified with the other person', query(testId('call-verified')))));
  await namesTheOther(caller, callee);
  await namesTheOther(callee, caller);
  await shoot(caller.page, `live${shotSuffix}`);
  await shoot(callee.page, `live-callee${shotSuffix}`);
  await soundArrives(pages);

  const ender = people[hangsUp];
  const other = hangsUp === 'caller' ? callee : caller;
  await press(ender.page, query(testId('call-hangup')), 'Hang up');
  const after = `${ender.name} hung up`;
  // Both are read at once: the side that hung up ends at the press, the other side as the relay passes the end on.
  await Promise.all([endsPlainly(ender.page, after), endsPlainly(other.page, after)]);
  await shoot(other.page, `ended-${other.page.label}${shotSuffix}`);
  await Promise.all(pages.map(closesItself));
  await Promise.all(pages.map((page) => waitFor(page, 'back in the chat', query(testId('chat-pane')))));
}

async function main(): Promise<void> {
  const suffix = Math.random().toString(36).slice(2, 6);
  const browser = await launchChromium();
  const pages: Page[] = [];
  try {
    const caller: Person = { page: await browser.newPage('caller'), name: `Ada ${suffix}` };
    const callee: Person = { page: await browser.newPage('callee'), name: `Bo ${suffix}` };
    pages.push(caller.page, callee.page);
    for (const page of pages) {
      await page.addInitScript(PEER_RECORDER);
      await page.grant(new URL(ORIGIN).origin, ['audioCapture']);
      await page.navigate(ORIGIN);
    }
    await signIn(caller.page, caller.name);
    await signIn(callee.page, callee.name);

    await waitFor(caller.page, 'the other person is listed', personNamed(callee.name));
    await press(caller.page, personNamed(callee.name), `open a chat with ${callee.name}`);
    await waitFor(caller.page, 'the chat is open', query(testId('chat-pane')));
    await waitFor(callee.page, 'the chat arrived', chatWith(caller.name));
    await press(callee.page, chatWith(caller.name), `open the chat with ${caller.name}`);

    await oneCall({ caller, callee }, 'caller', '');
    await oneCall({ caller, callee }, 'callee', '-2');
    log('CALL SMOKE OK');
  } catch (error) {
    for (const page of pages) for (const line of page.problems()) console.error(`[${page.label}] ${line}`);
    throw error;
  } finally {
    await browser.close();
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(`CALL SMOKE FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
