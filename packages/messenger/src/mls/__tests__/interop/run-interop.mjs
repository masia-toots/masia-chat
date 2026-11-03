#!/usr/bin/env node
// pnpm test:interop - builds the OpenMLS peer image, runs the interop suite against it, and writes
//   <out>/log.txt      the build and test output, after a header that names every version used
//   <out>/results.json the scenario matrix (every check with the library's own error text) + versions
// Exit code: the suite's. Needs Docker and the network for the image build (never for the run itself).
//
//   node run-interop.mjs [--out <dir>] [--skip-build] [--no-cache]
//
// No dependencies, one file. See README.md for what the run proves.

import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, '..', '..', '..', '..');
const REPO_ROOT = resolve(PACKAGE_ROOT, '..', '..');
const DEFAULT_OUT = join(REPO_ROOT, '.artifacts', '2026-10-10-mls-interop');
const IMAGE = process.env.MLS_INTEROP_IMAGE ?? 'masia-openmls-interop:dev';
const TEST_FILE = join('src', 'mls', '__tests__', 'interop', 'openmls-interop.test.ts');
const IN_IMAGE_DIR = '/opt/openmls-peer';
/** Crate versions worth naming in the result: the library under test and what it runs on. */
const REPORTED_CRATES = [
  'openmls',
  'openmls_rust_crypto',
  'openmls_basic_credential',
  'openmls_traits',
  'openmls_memory_storage',
  'hpke-rs',
  'ed25519-dalek',
];

const args = process.argv.slice(2);
const flagIndex = (name) => args.indexOf(name);
const outDir = resolve(
  flagIndex('--out') >= 0 ? (args[flagIndex('--out') + 1] ?? DEFAULT_OUT) : DEFAULT_OUT,
);
const skipBuild = args.includes('--skip-build');
const noCache = args.includes('--no-cache');

mkdirSync(outDir, { recursive: true });
const logPath = join(outDir, 'log.txt');
const rawPath = join(outDir, '.results.raw.json');
const log = createWriteStream(logPath, { encoding: 'utf8' });

function say(line) {
  process.stdout.write(`${line}\n`);
  log.write(`${line}\n`);
}

function capture(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { encoding: 'utf8' });
  if (result.error) throw new Error(`${command}: ${result.error.message}`);
  if (result.status !== 0)
    throw new Error(`${command} ${commandArgs.join(' ')}: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

/** Runs a command, teeing its output into the log; resolves with the exit code. */
function stream(command, commandArgs, options) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, commandArgs, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    const forward = (chunk) => {
      process.stdout.write(chunk);
      log.write(chunk);
    };
    child.stdout.on('data', forward);
    child.stderr.on('data', forward);
    child.on('error', rejectRun);
    child.on('close', (code) => resolveRun(code ?? 1));
  });
}

function dockerfileBaseImages() {
  const text = readFileSync(join(HERE, 'Dockerfile'), 'utf8');
  return [...text.matchAll(/^FROM\s+(\S+)/gm)].map((match) => match[1]);
}

/** `name = "x"` / `version = "y"` pairs of a Cargo.lock. */
function lockedCrates(lockText) {
  const crates = {};
  for (const block of lockText.split('[[package]]').slice(1)) {
    const name = /^name = "(.+)"$/m.exec(block)?.[1];
    const version = /^version = "(.+)"$/m.exec(block)?.[1];
    if (name !== undefined && version !== undefined) crates[name] = version;
  }
  return crates;
}

/** A package's own version (its package.json is not in every package's `exports`, so read the file). */
function packageVersion(name) {
  return JSON.parse(readFileSync(join(PACKAGE_ROOT, 'node_modules', name, 'package.json'), 'utf8'))
    .version;
}

/**
 * The patch pnpm applies to a dependency, as the lockfile records it (`patchedDependencies`):
 * `{ hash, path }`, or `null` when the version is not patched. The hash is pnpm's own digest of
 * the patch file, so a result says WHICH patched library it ran against, not only its version.
 * A line scan, not a YAML parser: the block is flat, and the runner keeps no dependencies.
 */
function lockedPatch(name, version) {
  const lock = readFileSync(join(REPO_ROOT, 'pnpm-lock.yaml'), 'utf8').split(/\r?\n/);
  const start = lock.indexOf('patchedDependencies:');
  if (start < 0) return null;
  const key = `  ${name}@${version}:`;
  for (let i = start + 1; i < lock.length && /^\s/.test(lock[i] ?? ''); i += 1) {
    if (lock[i] !== key) continue;
    const field = (label) => {
      for (let j = i + 1; j < lock.length && (lock[j] ?? '').startsWith('    '); j += 1) {
        const match = new RegExp(`^\\s+${label}: (.+)$`).exec(lock[j] ?? '');
        if (match) return match[1].trim();
      }
      return null;
    };
    return { hash: field('hash'), path: field('path') };
  }
  return null;
}

function readFromImage(path) {
  return capture('docker', [
    'run',
    '--rm',
    '--network',
    'none',
    '--entrypoint',
    'cat',
    IMAGE,
    path,
  ]);
}

function versions() {
  const dockerVersion = capture('docker', ['version', '--format', '{{.Server.Version}}']);
  const imageId = capture('docker', ['image', 'inspect', IMAGE, '--format', '{{.Id}}']);
  const tool = readFromImage(`${IN_IMAGE_DIR}/rustc-version.txt`).split('\n');
  const crates = lockedCrates(readFromImage(`${IN_IMAGE_DIR}/Cargo.lock`));
  const tsMls = packageVersion('ts-mls');
  const vitest = packageVersion('vitest');
  return {
    openmls: crates.openmls,
    openmlsCrates: Object.fromEntries(
      REPORTED_CRATES.filter((name) => crates[name] !== undefined).map((name) => [
        name,
        crates[name],
      ]),
    ),
    tsMls,
    tsMlsPatch: lockedPatch('ts-mls', tsMls),
    rustc: tool[0],
    cargo: tool[1],
    docker: dockerVersion,
    image: IMAGE,
    imageId,
    baseImages: dockerfileBaseImages(),
    node: process.version,
    vitest,
    platform: `${process.platform}-${process.arch}`,
  };
}

function vitestBin() {
  return join(PACKAGE_ROOT, 'node_modules', 'vitest', 'vitest.mjs');
}

async function main() {
  const startedAt = Date.now();
  say(`# MLS interop run, ${new Date(startedAt).toISOString()}`);
  say(`# output: ${relative(REPO_ROOT, outDir) || '.'}`);

  try {
    capture('docker', ['version', '--format', '{{.Server.Version}}']);
  } catch (error) {
    say(`Docker is not available (${error.message}). The interop suite needs it; nothing was run.`);
    return 2;
  }

  if (!skipBuild) {
    say(`# docker build ${IMAGE}`);
    const buildArgs = [
      'build',
      '--progress=plain',
      ...(noCache ? ['--no-cache'] : []),
      '-t',
      IMAGE,
      HERE,
    ];
    const built = await stream('docker', buildArgs, {});
    if (built !== 0) {
      say(`docker build failed with exit code ${built}`);
      return built;
    }
  }

  const used = versions();
  say('# versions');
  say(JSON.stringify(used, null, 2));

  say('# vitest');
  rmSync(rawPath, { force: true });
  const testStartedAt = Date.now();
  const code = await stream(process.execPath, [vitestBin(), 'run', TEST_FILE], {
    cwd: PACKAGE_ROOT,
    env: {
      ...process.env,
      MLS_INTEROP: '1',
      MLS_INTEROP_IMAGE: IMAGE,
      MLS_INTEROP_OUT: rawPath,
      NO_COLOR: '1',
      FORCE_COLOR: '0',
    },
  });
  const testMs = Date.now() - testStartedAt;

  let raw = { scenarios: [], findings: [] };
  try {
    raw = JSON.parse(readFileSync(rawPath, 'utf8'));
  } catch {
    say('the suite wrote no results file (it did not finish)');
  }
  rmSync(rawPath, { force: true });

  const count = (outcome) =>
    raw.scenarios.filter((scenario) => scenario.outcome === outcome).length;
  const checks = raw.scenarios.flatMap((scenario) => scenario.checks);
  const countChecks = (outcome) => checks.filter((check) => check.outcome === outcome).length;
  const results = {
    generatedAt: new Date().toISOString(),
    exitCode: code,
    runtimeMs: { total: Date.now() - startedAt, suite: testMs },
    versions: used,
    summary: {
      scenarios: raw.scenarios.length,
      pass: count('PASS'),
      fail: count('FAIL'),
      notTriggerable: count('NOT-TRIGGERABLE'),
      checks: checks.length,
      checksPass: countChecks('PASS'),
      checksFail: countChecks('FAIL'),
      checksNotTriggerable: countChecks('NOT-TRIGGERABLE'),
    },
    scenarios: raw.scenarios,
    findings: raw.findings,
  };
  writeFileSync(
    join(outDir, 'results.json'),
    scrub(`${JSON.stringify(results, null, 2)}\n`),
    'utf8',
  );
  say(
    `# result: ${results.summary.pass} PASS, ${results.summary.fail} FAIL, ${results.summary.notTriggerable} NOT-TRIGGERABLE scenarios; exit ${code}; suite ${testMs} ms`,
  );
  return code;
}

/** The committed artifacts carry no local paths: the checkout and the home directory are masked. */
function scrub(text) {
  const places = [
    [REPO_ROOT, '<repo>'],
    [homedir(), '<home>'],
  ];
  let masked = text;
  for (const [place, label] of places) {
    for (const form of new Set([place, place.replaceAll('\\', '/')])) {
      masked = masked.replace(new RegExp(form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), label);
    }
  }
  return masked;
}

function finish(code) {
  log.end(() => {
    writeFileSync(logPath, scrub(readFileSync(logPath, 'utf8')), 'utf8');
    process.exit(code);
  });
}

main()
  .then(finish)
  .catch((error) => {
    say(`run-interop failed: ${error.stack ?? error}`);
    finish(1);
  });
