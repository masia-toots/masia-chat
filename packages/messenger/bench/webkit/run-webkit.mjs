#!/usr/bin/env node
// run-webkit: runs the MLS engine bench page in real WebKit (and Chromium, for comparison).
//
//   node bench/webkit/run-webkit.mjs [--only=webkit|chromium] [--no-build] [--out=<dir>] [--timeout-min=<n>]
//   pnpm -F @masia/messenger bench:webkit
//
// What it does: builds the page with Vite (bench/webkit/index.html, strict CSP meta tag), serves
// the build from a loopback port, drives each browser with Playwright until `window.__results.done`,
// and writes, per browser: results.<name>.json, screenshot.<name>.png and console.<name>.txt (not .log: those are git-ignored), plus
// summary.txt. Exit code 1 when any scenario fails, a gate fails (CSP violation, WASM, eval not
// blocked, missing WebCrypto), or the WebKit p95 of "Add in a group of 50" exceeds the 300 ms budget.
// That p95 is the worst over the page's runs and the module Worker's run, with the cost of the bench's
// Ed25519 / X25519 stand-in taken out (where the browser lacks them). Where the page's own thread pays a
// timer tick per WebCrypto round trip (Playwright's WebKit on Windows does), the page skips the group of 50
// and only the Worker's run counts: the summary says so.
//
// No dependency is added to this package: Playwright and Vite are borrowed from whichever workspace
// of the repository already has them installed (or from here, if this package ever gets its own).
// WebKit here is Playwright's WebKit build for the host OS. It is the real JavaScriptCore and WebCore,
// but NOT an iPhone: see "what this does not prove" in the canon.

import { spawnSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { arch, cpus, platform, release, totalmem } from 'node:os';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, '..', '..');
const DIST = join(HERE, 'dist');
const VITE_CONFIG = join(HERE, 'vite.config.mjs');

const ADD_BUDGET_MS = 300;
const DEFAULT_TIMEOUT_MIN = 60;
const POLICY = "default-src 'self'; script-src 'self'";
const LOOPBACK = '127.0.0.1';
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};
/** A page with nothing on it, for the cross-origin-isolation probe (served with COOP/COEP when asked). */
const PROBE_PAGE = '/__probe.html';

// --- Arguments ---------------------------------------------------------------------------------------

const args = process.argv.slice(2);
const flag = (name) => args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
const flagValue = (name) => flag(name)?.split('=').slice(1).join('=');

const only = flagValue('only');
const names = only === undefined ? ['webkit', 'chromium'] : only.split(',');
const skipBuild = flag('no-build') !== undefined;
/** `--curves=js`: use the bench's JavaScript Ed25519 / X25519 even where the browser has them (to cross-check it). */
const forceCurves = flagValue('curves') === 'js';
const timeoutMs = Number(flagValue('timeout-min') ?? DEFAULT_TIMEOUT_MIN) * 60_000;

function findRepoRoot(from) {
  for (let dir = from; ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    if (dirname(dir) === dir) return undefined;
  }
}
const REPO_ROOT = findRepoRoot(PKG);
const today = new Date().toISOString().slice(0, 10);
const outDir = resolve(
  flagValue('out') ??
    (REPO_ROOT === undefined ? join(HERE, 'results') : join(REPO_ROOT, '.artifacts', `${today}-mls-webkit`)),
);

// --- Finding Playwright and Vite -----------------------------------------------------------------------

function workspaceDirs() {
  const dirs = [PKG];
  if (REPO_ROOT === undefined) return dirs;
  for (const group of ['apps', 'backend', 'packages', 'tools']) {
    const base = join(REPO_ROOT, group);
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base)) {
      const dir = join(base, name);
      if (existsSync(join(dir, 'package.json'))) dirs.push(dir);
    }
  }
  return dirs;
}

/** The install directory of `name` as seen from the first workspace that can resolve it. */
function findPackage(name) {
  const forced = flagValue('tools-from');
  for (const dir of forced === undefined ? workspaceDirs() : [resolve(forced)]) {
    try {
      const manifest = createRequire(join(dir, 'package.json')).resolve(`${name}/package.json`);
      return { dir: dirname(manifest), from: dir };
    } catch {
      /* not installed there */
    }
  }
  return undefined;
}

function need(name) {
  const found = findPackage(name);
  if (found === undefined) {
    console.error(`run-webkit: no workspace has "${name}" installed, so there is nothing to borrow.`);
    console.error('Install it in a workspace that already depends on it (do not add it to this package).');
    process.exit(2);
  }
  return found;
}

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

// --- Build -----------------------------------------------------------------------------------------------

function build(viteDir) {
  const result = spawnSync(process.execPath, [join(viteDir, 'bin', 'vite.js'), 'build', '--config', VITE_CONFIG], {
    cwd: PKG,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    console.error(result.stdout);
    console.error(result.stderr);
    console.error('run-webkit: the Vite build failed.');
    process.exit(2);
  }
  const lines = result.stdout.split('\n').filter((l) => /dist\/|built in/.test(l));
  console.log(lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, '')).join('\n'));
}

// --- Static server ----------------------------------------------------------------------------------------

function startServer({ isolated }) {
  const requests = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${LOOPBACK}`);
    const headers = { 'Cache-Control': 'no-store' };
    if (isolated) {
      headers['Cross-Origin-Opener-Policy'] = 'same-origin';
      headers['Cross-Origin-Embedder-Policy'] = 'require-corp';
    }
    const record = (status) => requests.push({ method: req.method, path: url.pathname + url.search, status });
    if (url.pathname === PROBE_PAGE) {
      res.writeHead(200, { ...headers, 'Content-Type': MIME['.html'] });
      res.end('<!doctype html><meta charset="utf-8"><title>probe</title>');
      record(200);
      return;
    }
    const pathname = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const file = resolve(DIST, `.${pathname}`);
    if (!file.startsWith(DIST + sep) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404, headers);
      res.end('not found');
      record(404);
      return;
    }
    // The Worker script carries the policy as a header, as a real deployment must: a <meta> policy
    // covers the document, not a Worker it creates. `?nocsp=1` serves the same file without it.
    if (/\/worker-[^/]*\.js$/.test(pathname) && !url.searchParams.has('nocsp') && !isolated) {
      headers['Content-Security-Policy'] = POLICY;
    }
    res.writeHead(200, { ...headers, 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
    record(200);
  });
  return new Promise((resolveStart, reject) => {
    server.once('error', reject);
    server.listen(0, LOOPBACK, () => {
      const { port } = server.address();
      resolveStart({ origin: `http://${LOOPBACK}:${port}`, requests, close: () => new Promise((done) => server.close(done)) });
    });
  });
}

// --- One browser ---------------------------------------------------------------------------------------------

async function isolationProbe(browser, origin) {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(`${origin}${PROBE_PAGE}`);
    const workerFile = readdirSync(join(DIST, 'assets')).find((f) => /^worker-.*\.js$/.test(f));
    return await page.evaluate(async (workerPath) => {
      const page = {
        crossOriginIsolated: self.crossOriginIsolated,
        sharedArrayBufferDefined: typeof SharedArrayBuffer !== 'undefined',
        sharedArrayBufferConstructible: false,
        workerSeesSharedArrayBuffer: null,
        workerCrossOriginIsolated: null,
      };
      try {
        new SharedArrayBuffer(8);
        page.sharedArrayBufferConstructible = true;
      } catch {
        /* stays false */
      }
      if (workerPath !== undefined) {
        const env = await new Promise((resolveEnv) => {
          const worker = new Worker(`/assets/${workerPath}`, { type: 'module' });
          worker.onmessage = (event) => {
            worker.terminate();
            resolveEnv(event.data?.env ?? null);
          };
          worker.onerror = () => resolveEnv(null);
          setTimeout(() => resolveEnv(null), 15000);
        });
        page.workerSeesSharedArrayBuffer = env?.sharedArrayBufferDefined ?? null;
        page.workerCrossOriginIsolated = env?.crossOriginIsolated ?? null;
      }
      return page;
    }, workerFile);
  } catch (error) {
    return { error: String(error) };
  } finally {
    await context.close();
  }
}

async function runBrowser(name, playwright, server, isolatedServer) {
  const browserType = playwright[name];
  const started = Date.now();
  const browser = await browserType.launch();
  const consoleLines = [];
  const requestUrls = [];
  const failedRequests = [];
  const workers = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1100, height: 1500 } });
    const page = await context.newPage();
    const stamp = () => `+${((Date.now() - started) / 1000).toFixed(1)}s`;
    page.on('console', (message) => {
      const text = message.text();
      consoleLines.push(`${stamp()} [${message.type()}] ${text}`);
      if (text.startsWith('[beat]')) console.log(`  [${name} ${stamp()}] ${text}`);
    });
    page.on('pageerror', (error) => consoleLines.push(`${stamp()} [pageerror] ${error.message}`));
    page.on('request', (request) => requestUrls.push(request.url()));
    page.on('requestfailed', (request) => failedRequests.push(`${request.url()} ${request.failure()?.errorText ?? ''}`));
    page.on('worker', (worker) => workers.push(worker.url()));

    // 'commit', not 'load': a CPU-bound page may hold its load event back for a long time.
    await page.goto(`${server.origin}/${forceCurves ? '?curves=js' : ''}`, { waitUntil: 'commit', timeout: 60_000 });
    let last = '';
    const ticker = setInterval(async () => {
      try {
        const line = await page.evaluate(() => window.__progress ?? '');
        if (line !== last) {
          last = line;
          console.log(`  [${name} ${stamp()}] ${line}`);
        }
      } catch {
        /* page busy or gone */
      }
    }, 3000);
    try {
      await page.waitForFunction(() => window.__results?.done === true, null, { timeout: timeoutMs, polling: 1000 });
    } finally {
      clearInterval(ticker);
    }
    const results = await page.evaluate(() => JSON.parse(JSON.stringify(window.__results)));
    await page.screenshot({ path: join(outDir, `screenshot.${name}.png`), fullPage: true });

    const isolation = await isolationProbe(browser, isolatedServer.origin);
    const origin = new URL(server.origin).origin;
    results.runner = {
      browser: name,
      browserVersion: browser.version(),
      playwright: playwrightVersion,
      node: process.version,
      os: `${platform()} ${release()} ${arch()}`,
      cpu: `${cpus()[0]?.model ?? '?'} x${cpus().length}`,
      memoryGiB: Math.round(totalmem() / 2 ** 30),
      wallSeconds: Math.round((Date.now() - started) / 1000),
      origin: 'loopback http (secure context by the browser rule for loopback)',
      requestedUrls: requestUrls.filter((u) => !u.startsWith('data:') && !u.startsWith('blob:')),
      nonSameOriginRequests: requestUrls.filter((u) => !u.startsWith(origin) && !u.startsWith('data:') && !u.startsWith('blob:')),
      failedRequests,
      workerUrls: workers,
      wasmFilesRequested: requestUrls.filter((u) => /\.wasm(\?|$)/.test(u)),
      crossOriginIsolatedProbe: isolation,
    };
    await context.close();
    return { results, consoleLines };
  } finally {
    await browser.close();
  }
}

// --- Summary ----------------------------------------------------------------------------------------------------------

const fmt = (value) => (typeof value === 'number' ? value.toFixed(1) : String(value));

function perfLines(out, label, p, c) {
  const row = (title, st) => `${title} median ${fmt(st.median)} p95 ${fmt(st.p95)} [${st.samples.map(fmt).join(' ')}]`;
  out.push(`   perf ${label}: setup of the group of 50 ${p.setupMs} ms`);
  out.push(`     ${row('Add in a group of 50 (committer)', p.addGroup50)}`);
  const adj = p.adjusted;
  out.push(
    `       WebCrypto calls per sample (median): Add ${adj.addGroup50.callsMedian}, receiver ${adj.addProcessOneReceiver.callsMedian}, Welcome join ${adj.joinFromWelcome.callsMedian}, selfUpdate ${adj.selfUpdateCreate.callsMedian}/${adj.selfUpdateProcess.callsMedian}; ${p.messages.count} encrypts ${p.messages.encryptCalls}, decrypts ${p.messages.decryptCalls}`,
  );
  if (c?.mode === 'polyfill') {
    const line = (title, a) => `${title} stand-in cost taken out: median ${fmt(a.stats.median)} p95 ${fmt(a.stats.p95)} (median ${a.opsMedian} curve ops, ${fmt(a.busyMedianMs)} ms inside the stand-in)`;
    out.push(`       ${line('Add in 50', adj.addGroup50)}`);
    out.push(`       ${line('Add, one receiver', adj.addProcessOneReceiver)}`);
    out.push(`       ${line('Add critical path', adj.addCriticalPath)}`);
    out.push(`       ${line('Welcome join', adj.joinFromWelcome)}`);
    out.push(`       ${line('selfUpdate create', adj.selfUpdateCreate)}`);
    out.push(`       ${line('selfUpdate process', adj.selfUpdateProcess)}`);
  }
  out.push(`     ${row('Add, one receiver processes', p.addProcessOneReceiver)}`);
  out.push(`     ${row('Add critical path (create + one receiver)', p.addCriticalPath)}`);
  out.push(`     ${row('Welcome join (group of 51)', p.joinFromWelcome)}`);
  out.push(`     ${row('createKeyPackage', p.createKeyPackage)}`);
  out.push(`     ${row('selfUpdate create', p.selfUpdateCreate)}`);
  out.push(`     ${row('selfUpdate process', p.selfUpdateProcess)}`);
  out.push(`     encrypt 4 KB x${p.messages.count}: median ${fmt(p.encrypt4KB.median)} p95 ${fmt(p.encrypt4KB.p95)} total ${p.messages.encryptTotalMs} ms`);
  out.push(`     decrypt 4 KB x${p.messages.count}: median ${fmt(p.decrypt4KB.median)} p95 ${fmt(p.decrypt4KB.p95)} total ${p.messages.decryptTotalMs} ms`);
  out.push(`     state of 50: ${p.stateBytes} bytes, encode ${p.stateEncodeMs} ms, decode ${p.stateDecodeMs} ms`);
}

function summarize(name, results) {
  const out = [];
  const r = results.runner;
  out.push(`== ${name} ${r.browserVersion} (Playwright ${r.playwright}) on ${r.os}, ${r.cpu}`);
  out.push(`   user agent: ${results.env?.userAgent}`);
  if (results.fatal) out.push(`   FATAL: ${results.fatal}`);
  out.push(`   secure context ${results.env?.isSecureContext} · crypto.subtle ${results.crypto?.subtleDefined} · timer resolution ${results.env?.timerResolutionMs} ms`);
  const trip = (t) => (t ? `mean ${t.meanPerCallMs} ms per call over ${t.iterations} iterations of 3 calls (median iteration ${fmt(t.medianIterationMs)} ms, p95 ${fmt(t.p95IterationMs)} ms)${t.stalled ? ' -- STALLS, a timer tick per round trip' : ''}` : '?');
  out.push(`   WebCrypto round trip on the page: ${trip(results.roundTrip)}`);
  for (const k of results.skipped ?? []) out.push(`   page skipped ${k.phase}: ${k.reason}`);
  for (const a of results.crypto?.algorithms ?? []) out.push(`   native crypto ${a.ok ? 'ok  ' : 'FAIL'} ${a.name}${a.error ? ` -- ${a.error}` : ''}`);
  const c = results.curves;
  if (c) {
    out.push(`   curves: ${c.mode} (${c.reason}); stand-in ran ${c.standInOps} ops, ${c.standInBusyMs} ms inside it`);
    for (const t of c.selfTest) out.push(`     curve self-test ${t.ok ? 'ok  ' : 'FAIL'} ${t.name}${t.detail ? ` -- ${t.detail}` : ''}`);
  }
  for (const s of [...results.lifecycle, ...results.attacks]) out.push(`   ${s.ok ? 'pass' : 'FAIL'} ${s.name} (${fmt(s.ms)} ms)${s.error ? ` -- ${s.error}` : ''}`);
  for (const label of ['cold', 'warm']) {
    const p = results.perf?.[label];
    if (p) perfLines(out, `page ${label}`, p, c);
  }
  if (results.subtle) out.push(`   WebCrypto calls on the page: ${results.subtle.calls} ${JSON.stringify(results.subtle.byMethod)}`);
  out.push(`   CSP: engine violations ${results.gates?.engineCspViolations} · WASM calls ${results.gates?.engineWasmCalls} · wasm files requested ${r.wasmFilesRequested.length} · non-same-origin requests ${r.nonSameOriginRequests.length}`);
  for (const c of results.csp?.controls ?? []) out.push(`   control ${c.blocked ? 'refused' : 'ALLOWED'} ${c.name} (${c.violationEvents} violation event(s)) -- ${c.detail}`);
  for (const [label, w] of Object.entries(results.worker ?? {})) {
    out.push(`   module Worker ${label}: ${w.loaded ? 'loaded' : 'NOT loaded'}${w.error ? ` -- ${w.error}` : ''}${w.bootMs !== undefined ? ` (boot ${w.bootMs} ms)` : ''}`);
    if (w.run) {
      const run = w.run;
      out.push(`     in the Worker: curves ${run.curves.mode}; WebCrypto round trip ${trip(run.roundTrip)}`);
      out.push(`     in the Worker: ${run.lifecycle.ok ? 'lifecycle(5) pass' : `lifecycle(5) FAIL ${run.lifecycle.error}`} (${fmt(run.lifecycle.ms)} ms)`);
      if (run.lifecycleBig) out.push(`     in the Worker: ${run.lifecycleBig.ok ? 'lifecycle(50) pass' : `lifecycle(50) FAIL ${run.lifecycleBig.error}`} (${fmt(run.lifecycleBig.ms)} ms)`);
      out.push(`     in the Worker: isolated ${run.env.crossOriginIsolated} · SharedArrayBuffer ${run.env.sharedArrayBufferDefined}`);
      for (const c of run.controls) out.push(`     in the Worker: control ${c.blocked ? 'refused' : 'ALLOWED'} ${c.name}`);
      out.push(`     in the Worker: engine violations ${run.engineViolations.length} · WASM calls ${run.engineWasmCalls.length}`);
      if (run.perf) perfLines(out, `Worker (${label})`, run.perf, run.curves);
    }
  }
  out.push(`   SharedArrayBuffer here: ${JSON.stringify(results.env?.sharedArrayBuffer)} · isolated: ${results.env?.crossOriginIsolated}`);
  out.push(`   with COOP+COEP headers: ${JSON.stringify(r.crossOriginIsolatedProbe)}`);
  const g = results.gates;
  if (g) out.push(`   Add in a group of 50, budget ${g.addGroup50BudgetMs} ms: p95 ${fmt(g.addGroup50P95Ms)} ms (worst of ${g.addGroup50Sources.join(', ') || 'nothing'}; stand-in cost taken out); as measured ${fmt(g.addGroup50MeasuredP95Ms)} ms; page thread stalls: ${g.pageThreadStalls}`);
  out.push(`   gates: ${results.gates?.pass ? 'PASS' : 'FAIL'} ${(results.gates?.failures ?? []).join('; ')}`);
  return out.join('\n');
}

// --- Main ------------------------------------------------------------------------------------------------------------------

const vite = need('vite');
const pw = need('playwright');
const playwrightVersion = readJson(join(pw.dir, 'package.json')).version;
console.log(`run-webkit: Playwright ${playwrightVersion} from ${REPO_ROOT ? relative(REPO_ROOT, pw.from) || '.' : pw.from}, Vite from ${REPO_ROOT ? relative(REPO_ROOT, vite.from) || '.' : vite.from}`);

if (!skipBuild) build(vite.dir);
else if (!existsSync(join(DIST, 'index.html'))) {
  console.error('run-webkit: --no-build given but there is no build in bench/webkit/dist');
  process.exit(2);
}

mkdirSync(outDir, { recursive: true });
const playwright = await import(pathToFileURL(join(pw.dir, 'index.mjs')).href);
const server = await startServer({ isolated: false });
const isolatedServer = await startServer({ isolated: true });
console.log(`run-webkit: serving the build on a loopback port; output in ${outDir}`);

let failed = false;
const summaries = [];
const byBrowser = {};
for (const name of names) {
  console.log(`run-webkit: ${name} ...`);
  try {
    const { results, consoleLines } = await runBrowser(name, playwright, server, isolatedServer);
    byBrowser[name] = results;
    writeFileSync(join(outDir, `results.${name}.json`), `${JSON.stringify(results, null, 2)}\n`);
    writeFileSync(join(outDir, `console.${name}.txt`), `${consoleLines.join('\n')}\n`);
    summaries.push(summarize(name, results));
    const gates = results.gates;
    if (results.fatal !== undefined || gates === undefined || !gates.pass) {
      // The 300 ms budget is judged on WebKit only; Chromium is there for comparison.
      const onlyBudget = name !== 'webkit' && gates !== undefined && gates.failures.every((f) => f.startsWith('Add in a group of 50'));
      if (!onlyBudget) failed = true;
    }
  } catch (error) {
    failed = true;
    const message = `== ${name}: the run itself failed: ${error?.stack ?? error}`;
    console.error(message);
    summaries.push(message);
  }
}
await server.close();
await isolatedServer.close();

const webkit = byBrowser.webkit;
if (names.includes('webkit')) {
  const p95 = webkit?.gates?.addGroup50P95Ms;
  if (webkit === undefined || p95 === undefined || !(p95 <= ADD_BUDGET_MS)) failed = true;
}
const text = `${summaries.join('\n\n')}\n\nresult: ${failed ? 'FAIL' : 'PASS'}\n`;
writeFileSync(join(outDir, 'summary.txt'), text);
console.log(`\n${text}`);
process.exit(failed ? 1 : 0);
