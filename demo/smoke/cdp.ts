import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

// Just enough of the Chrome DevTools Protocol for the call smoke, over Node's own WebSocket: start a headless
// Chromium, open one page per person in its own browser context (two contexts share nothing, like two
// browsers), run script in a page, type into it, and take its picture. No browser-driving package: the
// playground depends on the open packages and nothing else.

/** How long Chromium may take to print its DevTools address. */
const BROWSER_START_MS = 30_000;
/** How long one protocol command may take. */
const COMMAND_TIMEOUT_MS = 30_000;
/** How long a closed browser may take to exit before it is killed. */
const EXIT_WAIT_MS = 5_000;
/** The profile folder is removed with retries: on Windows the files stay locked for a moment after exit. */
const PROFILE_RM = { maxRetries: 10, retryDelay: 200 } as const;
/** The page size the pictures are taken at: a laptop screen. */
const VIEWPORT = { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false } as const;

const DEVTOOLS_LINE = /DevTools listening on (ws:\/\/\S+)/;

/**
 * Chromium for a call with nobody at the machine: a fake microphone (a tone) with no permission prompt, and sound
 * that may play without a click.
 */
const CHROMIUM_FLAGS = [
  '--headless=new',
  '--remote-debugging-port=0',
  '--no-first-run',
  '--no-default-browser-check',
  '--use-fake-device-for-media-stream',
  '--use-fake-ui-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
] as const;

/** Where the browser-testing tool many machines already have keeps its browsers. */
function browserCache(): string {
  const given = process.env['PLAYWRIGHT_BROWSERS_PATH'];
  if (given !== undefined && given !== '') return given;
  if (process.platform === 'win32') {
    return join(process.env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local'), 'ms-playwright');
  }
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Caches', 'ms-playwright');
  return join(homedir(), '.cache', 'ms-playwright');
}

/** The binary inside one cached Chromium build, by platform. */
const BINARY_IN_BUILD: Readonly<Record<string, readonly string[]>> = {
  win32: ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe'],
  darwin: [
    'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
  ],
  linux: ['chrome-linux64/chrome', 'chrome-linux/chrome'],
};

const BUILD_DIR = /^chromium-(\d+)$/;

/** `DEMO_CHROMIUM`, else the newest Chromium in the browser cache. */
export function chromiumBinary(): string {
  const given = process.env['DEMO_CHROMIUM'];
  if (given !== undefined && given !== '') return given;
  const cache = browserCache();
  const builds = existsSync(cache)
    ? readdirSync(cache)
        .flatMap((name) => {
          const match = BUILD_DIR.exec(name);
          return match === null ? [] : [{ name, build: Number(match[1]) }];
        })
        .sort((a, b) => b.build - a.build)
    : [];
  for (const { name } of builds) {
    for (const inside of BINARY_IN_BUILD[process.platform] ?? []) {
      const path = join(cache, name, inside);
      if (existsSync(path)) return path;
    }
  }
  throw new Error('no Chromium found: set DEMO_CHROMIUM to a Chromium or Chrome binary');
}

interface CdpMessage {
  readonly id?: number;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
  readonly sessionId?: string;
  readonly result?: unknown;
  readonly error?: { readonly message: string };
}

interface EvaluateAnswer {
  readonly result: { readonly value?: unknown };
  readonly exceptionDetails?: { readonly text: string; readonly exception?: { readonly description?: string } };
}

export interface Page {
  /** Who this page is, for the log. */
  readonly label: string;
  /** Script that runs in every document of this page before the page's own. */
  addInitScript(source: string): Promise<void>;
  /** Grants permissions to an origin in this page's browser context. */
  grant(origin: string, permissions: readonly string[]): Promise<void>;
  navigate(url: string): Promise<void>;
  /** Evaluates an expression (awaiting a promise) as if the person had just clicked, and returns its value. */
  evaluate<T>(expression: string): Promise<T>;
  /** Types into whatever has the focus. */
  insertText(text: string): Promise<void>;
  screenshot(path: string): Promise<void>;
  /** The page's errors so far: uncaught exceptions and `console.error` lines. */
  problems(): readonly string[];
}

export interface Browser {
  newPage(label: string): Promise<Page>;
  close(): Promise<void>;
}

export async function launchChromium(): Promise<Browser> {
  const profile = await mkdtemp(join(tmpdir(), 'playground-call-smoke-'));
  const child = spawn(chromiumBinary(), [...CHROMIUM_FLAGS, `--user-data-dir=${profile}`, 'about:blank'], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const address = await new Promise<string>((resolve, reject) => {
    let printed = '';
    const timer = setTimeout(() => reject(new Error('Chromium did not start')), BROWSER_START_MS);
    child.stderr.on('data', (chunk: Buffer) => {
      printed += chunk.toString('utf8');
      const match = DEVTOOLS_LINE.exec(printed);
      if (match !== null) {
        clearTimeout(timer);
        resolve(match[1] as string);
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Chromium exited (${String(code)}) before it listened`));
    });
  });

  const socket = new WebSocket(address);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error('could not reach Chromium\'s DevTools')), { once: true });
  });

  let nextId = 1;
  const waiting = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  const listeners = new Set<(message: CdpMessage) => void>();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(typeof event.data === 'string' ? event.data : '{}') as CdpMessage;
    if (message.id !== undefined) {
      const answer = waiting.get(message.id);
      if (answer === undefined) return;
      waiting.delete(message.id);
      if (message.error !== undefined) answer.reject(new Error(message.error.message));
      else answer.resolve(message.result ?? {});
      return;
    }
    for (const listener of listeners) listener(message);
  });
  socket.addEventListener('close', () => {
    for (const answer of waiting.values()) answer.reject(new Error('the browser went away'));
    waiting.clear();
  });

  function send<T>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    const id = nextId;
    nextId += 1;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new Error(`${method} did not answer`));
      }, COMMAND_TIMEOUT_MS);
      waiting.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value as T);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }));
    });
  }

  async function newPage(label: string): Promise<Page> {
    const { browserContextId } = await send<{ browserContextId: string }>('Target.createBrowserContext');
    const { targetId } = await send<{ targetId: string }>('Target.createTarget', { url: 'about:blank', browserContextId });
    const { sessionId } = await send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
    const call = <T>(method: string, params: Record<string, unknown> = {}) => send<T>(method, params, sessionId);

    const seen: string[] = [];
    listeners.add((message) => {
      if (message.sessionId !== sessionId) return;
      if (message.method === 'Runtime.exceptionThrown') {
        const details = message.params?.['exceptionDetails'] as EvaluateAnswer['exceptionDetails'];
        seen.push(`uncaught: ${details?.exception?.description ?? details?.text ?? 'unknown'}`);
      }
      if (message.method === 'Runtime.consoleAPICalled' && message.params?.['type'] === 'error') {
        const args = (message.params['args'] ?? []) as readonly { value?: unknown; description?: string }[];
        seen.push(`console.error: ${args.map((arg) => arg.description ?? String(arg.value)).join(' ')}`);
      }
    });

    await call('Runtime.enable');
    await call('Page.enable');
    await call('Emulation.setDeviceMetricsOverride', { ...VIEWPORT });
    // Both pages count as focused, so neither is slowed down as a background tab.
    await call('Emulation.setFocusEmulationEnabled', { enabled: true });

    return {
      label,
      async addInitScript(source) {
        await call('Page.addScriptToEvaluateOnNewDocument', { source });
      },
      async grant(origin, permissions) {
        await send('Browser.grantPermissions', { origin, permissions, browserContextId });
      },
      async navigate(url) {
        await call('Page.navigate', { url });
      },
      async evaluate<T>(expression: string) {
        const answer = await call<EvaluateAnswer>('Runtime.evaluate', {
          expression,
          awaitPromise: true,
          returnByValue: true,
          userGesture: true,
        });
        if (answer.exceptionDetails !== undefined) {
          throw new Error(`${label}: ${answer.exceptionDetails.exception?.description ?? answer.exceptionDetails.text}`);
        }
        return answer.result.value as T;
      },
      async insertText(text) {
        await call('Input.insertText', { text });
      },
      async screenshot(path) {
        const { data } = await call<{ data: string }>('Page.captureScreenshot', { format: 'png' });
        await writeFile(path, Buffer.from(data, 'base64'));
      },
      problems: () => [...seen],
    };
  }

  async function close(): Promise<void> {
    await send('Browser.close').catch(() => undefined);
    socket.close();
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill();
          resolve();
        }, EXIT_WAIT_MS);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    await rm(profile, { recursive: true, force: true, ...PROFILE_RM }).catch(() => undefined);
  }

  return { newPage, close };
}
