import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

/**
 * The OpenMLS side of the interop test: one Docker container running `openmls-peer`, spoken to in
 * JSON lines (see `openmls-peer/src/main.rs`). Every byte string is base64 on the wire; the helpers
 * here convert at the edge so a test only sees `Uint8Array`.
 *
 * The container has no network and a read-only root: whatever it is fed, it can only talk back.
 */

const CALL_TIMEOUT_MS = 30_000;
const CLOSE_GRACE_MS = 5_000;

/** `docker run` arguments that make the peer a closed box. */
const SANDBOX_ARGS = [
  '--rm',
  '-i',
  '--network',
  'none',
  '--read-only',
  '--cap-drop',
  'ALL',
  '--security-opt',
  'no-new-privileges',
  '--memory',
  '1g',
  '--cpus',
  '2',
] as const;

/** The peer refused the command; `message` is OpenMLS's own error text (its `Debug` form). */
export class PeerRefusal extends Error {
  constructor(
    readonly command: string,
    readonly peerError: string,
  ) {
    super(`openmls-peer ${command}: ${peerError}`);
    this.name = 'PeerRefusal';
  }
}

export function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

export function fromBase64(text: string): Uint8Array {
  // A plain Uint8Array copy, never a Buffer view (the engine treats Buffers like any bytes, but a
  // Buffer's `.slice` is a view and we do not want a test to depend on that).
  return Uint8Array.from(Buffer.from(text, 'base64'));
}

/** What the peer reports about one of its groups after nearly every command. */
export interface GroupSummary {
  /** The base64 of the device's signature public key. */
  readonly client: string;
  readonly groupId: string;
  readonly epoch: number;
  readonly epochAuthenticator: string;
  readonly active: boolean;
  readonly ownLeafIndex: number;
  readonly members: readonly {
    readonly leafIndex: number;
    readonly identity: string;
    readonly signatureKey: string;
  }[];
  readonly groupContextExtensions: readonly { readonly type: number }[];
}

export interface CommitResult extends GroupSummary {
  readonly commit: string;
  readonly welcome: string | null;
}

export interface ProcessedCommit extends GroupSummary {
  readonly kind: 'commit';
  readonly hasUpdatePath: boolean;
  readonly adds: number;
  readonly removes: number;
  readonly updates: number;
  readonly proposals: number;
  readonly selfRemoved: boolean;
  readonly sender: { readonly type: string; readonly leafIndex?: number };
}

export interface ProcessedApplication {
  readonly kind: 'application';
  readonly plaintext: string;
  readonly aad: string;
  readonly sender: { readonly type: string; readonly leafIndex?: number };
}

export interface ProcessedOther {
  readonly kind:
    | 'proposal'
    | 'external_join_proposal'
    | 'own_pending_commit'
    | 'own_private_message';
  readonly sender: { readonly type: string; readonly leafIndex?: number };
}

export type Processed = ProcessedCommit | ProcessedApplication | ProcessedOther;

interface Pending {
  readonly command: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

type Reply =
  | { id: number; ok: true; result: unknown }
  | { id: number | null; ok: false; error: string };

export type PeerArgs = Readonly<Record<string, unknown>>;

export class OpenMlsPeer {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private exited: Error | undefined;
  private readonly stderrLines: string[] = [];

  private constructor(image: string) {
    this.child = spawn('docker', ['run', ...SANDBOX_ARGS, image], { stdio: 'pipe' });
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      this.onLine(line);
    });
    createInterface({ input: this.child.stderr }).on('line', (line) => {
      this.stderrLines.push(line);
    });
    this.child.on('error', (error) => {
      this.failAll(new Error(`could not start docker: ${error.message}`));
    });
    this.child.on('exit', (code, signal) => {
      const tail = this.stderrLines.slice(-5).join(' | ');
      this.failAll(new Error(`openmls-peer exited (code ${code}, signal ${signal}) ${tail}`));
    });
  }

  /** Starts a container from `image` and checks it answers. */
  static async start(image: string): Promise<OpenMlsPeer> {
    const peer = new OpenMlsPeer(image);
    await peer.call('hello');
    return peer;
  }

  private onLine(line: string): void {
    let reply: Reply;
    try {
      reply = JSON.parse(line) as Reply;
    } catch {
      this.stderrLines.push(`unparseable stdout: ${line.slice(0, 200)}`);
      return;
    }
    if (reply.id === null) return;
    const waiting = this.pending.get(reply.id);
    if (waiting === undefined) return;
    this.pending.delete(reply.id);
    clearTimeout(waiting.timer);
    if (reply.ok) waiting.resolve(reply.result);
    else waiting.reject(new PeerRefusal(waiting.command, reply.error));
  }

  private failAll(error: Error): void {
    this.exited = error;
    for (const [id, waiting] of this.pending) {
      this.pending.delete(id);
      clearTimeout(waiting.timer);
      waiting.reject(error);
    }
  }

  /** Sends one command. Rejects with `PeerRefusal` when OpenMLS refused it. */
  call<T = Record<string, unknown>>(command: string, args: PeerArgs = {}): Promise<T> {
    if (this.exited !== undefined) return Promise.reject(this.exited);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`openmls-peer ${command}: no answer in ${CALL_TIMEOUT_MS} ms`));
      }, CALL_TIMEOUT_MS);
      this.pending.set(id, {
        command,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      this.child.stdin.write(`${JSON.stringify({ id, cmd: command, ...args })}\n`);
    });
  }

  /** Like `call`, but OpenMLS's refusal comes back as a value instead of a throw. */
  async attempt<T = Record<string, unknown>>(
    command: string,
    args: PeerArgs = {},
  ): Promise<{ ok: true; result: T } | { ok: false; error: string }> {
    try {
      return { ok: true, result: await this.call<T>(command, args) };
    } catch (error) {
      if (error instanceof PeerRefusal) return { ok: false, error: error.peerError };
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.exited !== undefined) return;
    const done = new Promise<void>((resolve) => {
      this.child.once('exit', () => {
        resolve();
      });
    });
    this.child.stdin.end();
    const killer = setTimeout(() => {
      this.child.kill('SIGKILL');
    }, CLOSE_GRACE_MS);
    await done;
    clearTimeout(killer);
  }
}
