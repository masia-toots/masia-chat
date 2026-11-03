import { newMessageId } from '../src/client/bytes.js';
import { startRuntime, type PlaygroundRuntime } from '../src/client/runtime.js';

// A smoke test for a running playground: two people, two clients, one encrypted conversation, the same
// client code the page runs (only the DOM is missing). It signs both in, opens a chat from one side,
// waits for the other side to join, and sends a message each way, then an edit, a reaction and a delete.
//
//   DEMO_ORIGIN=http://localhost:8080 pnpm --filter @masia/demo smoke
//
// Exit code 0 means every step happened; the first thing that does not happen within the time limit
// fails the run and says which step it was.

const ORIGIN = process.env['DEMO_ORIGIN'] ?? 'http://127.0.0.1:8080';
const STEP_TIMEOUT_MS = 60_000;
const POLL_MS = 250;

const started = Date.now();
const log = (line: string) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${line}`);

async function until(step: string, condition: () => boolean): Promise<void> {
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${step}`);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  log(`ok: ${step}`);
}

function historyOf(runtime: PlaygroundRuntime, conversationId: string) {
  return runtime.roomSnapshot(conversationId)?.history ?? [];
}

function texts(runtime: PlaygroundRuntime, conversationId: string): string[] {
  return historyOf(runtime, conversationId).flatMap((item) =>
    item.payload?.kind === 'text' ? [item.payload.body] : [],
  );
}

async function main(): Promise<void> {
  const suffix = Math.random().toString(36).slice(2, 6);
  const ada = await startRuntime({ name: `Ada ${suffix}`, origin: ORIGIN, pollMs: POLL_MS });
  const bo = await startRuntime({ name: `Bo ${suffix}`, origin: ORIGIN, pollMs: POLL_MS });
  try {
    log(`signed in: ${ada.self.displayName} (${ada.self.userId}) and ${bo.self.displayName} (${bo.self.userId})`);

    await until('each tab sees the other person', () =>
      ada.getSnapshot().people.some((p) => p.userId === bo.self.userId) &&
      bo.getSnapshot().people.some((p) => p.userId === ada.self.userId),
    );

    const conversationId = ada.open(bo.self.userId);
    await until('the chat is set up on the opening side', () =>
      ada.roomSnapshot(conversationId)?.epoch !== undefined,
    );
    await until('the other side joined by its Welcome', () => bo.roomSnapshot(conversationId)?.epoch !== undefined);

    const first = newMessageId();
    await ada.send(conversationId, { kind: 'text', id: first, body: 'hello from Ada' });
    await until('Bo reads Ada\'s message', () => texts(bo, conversationId).includes('hello from Ada'));

    await bo.send(conversationId, { kind: 'text', id: newMessageId(), body: 'hello back from Bo' });
    await until('Ada reads Bo\'s message', () => texts(ada, conversationId).includes('hello back from Bo'));

    await ada.send(conversationId, { kind: 'edit', id: newMessageId(), targetId: first, body: 'hello from Ada (edited)' });
    await until('Bo receives the edit', () =>
      historyOf(bo, conversationId).some((item) => item.payload?.kind === 'edit'),
    );

    await bo.send(conversationId, { kind: 'reaction', id: newMessageId(), targetId: first, emoji: '👍' });
    await until('Ada receives the reaction', () =>
      historyOf(ada, conversationId).some((item) => item.payload?.kind === 'reaction'),
    );

    await ada.send(conversationId, { kind: 'delete', id: newMessageId(), targetId: first });
    await until('Bo receives the delete', () =>
      historyOf(bo, conversationId).some((item) => item.payload?.kind === 'delete'),
    );

    const adaRoom = ada.roomSnapshot(conversationId);
    const boRoom = bo.roomSnapshot(conversationId);
    if (adaRoom?.epoch !== boRoom?.epoch) throw new Error('the two sides disagree about the epoch');
    log(`both sides are at epoch ${String(adaRoom?.epoch)} with ${String(adaRoom?.members.length)} devices`);
    log('SMOKE OK');
  } finally {
    ada.stop();
    bo.stop();
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(`SMOKE FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
