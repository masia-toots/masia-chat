#!/usr/bin/env node
// docs:check — the documentation gate of the open messenger package. No dependencies.
//
//   node scripts/docs-check.mjs          check every *.md under the package (and the public extras)
//   node scripts/docs-check.mjs --all    also scan source, config and data files for forbidden tokens
//
// It fails (exit 1) when:
//   1. a relative link or a #anchor in a Markdown file does not resolve, or
//   2. a file contains a token that must never appear in the public tree (editorial rules, CLAUDE.md).
//
// The forbidden list lives in `forbidden-tokens.mjs` (written as \u-escapes on purpose, shared with the
// open-split dry run). It reports the rule's label and the line, never the matched text. One file may
// break the "no names" rules: the maintainers' file, by exact path (`PATH_ALLOWANCES` there).
//
// What it scans: the package, plus the public extras that sit beside it in the one open repo — the
// maintainers' file, the other open packages (the contracts, the relay library and the relay server), the
// playground (`demo/`) and the split tooling (`tools/open-split/`). They are public surface too, and a
// leak there would otherwise be nobody's check. An extra that does not exist (a split that leaves it out)
// is skipped.

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { forbiddenLabels } from './forbidden-tokens.mjs';

const SELF = fileURLToPath(import.meta.url);
const SCRIPTS = dirname(SELF);
const ROOT = resolve(SCRIPTS, '..');
const REPO = resolve(ROOT, '..', '..');
const SCAN_ALL = process.argv.includes('--all');

/** The checker's own files spell the rules they enforce (as escapes), so they are not scanned. */
const OWN_FILES = new Set([SELF, join(SCRIPTS, 'forbidden-tokens.mjs')]);

/** Public surface beside the package, relative to the repo root. */
const EXTRA_ROOTS = [
  'MAINTAINERS.md',
  'packages/contracts',
  'packages/relay',
  'apps/relay',
  'demo',
  'tools/open-split',
];
/**
 * The root files of the open repository, kept here until the split: a file in this directory lands at
 * the repository ROOT, so its relative links are resolved from there, not from where it sits.
 */
const OPEN_ROOT_SCAFFOLD = resolve(REPO, 'tools/open-split/scaffold');

const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.git']);
const MARKDOWN = /\.md$/i;
const SCANNED = SCAN_ALL ? /\.(md|ts|tsx|mjs|cjs|js|json|ya?ml|prisma|sql)$/i : MARKDOWN;

/** GitHub's heading anchor: lowercase, drop punctuation, spaces to hyphens, repeats get -1, -2. */
function anchorsOf(text) {
  const seen = new Map();
  const anchors = new Set();
  let fenced = false;
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) continue;
    const m = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const base = m[1]
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\p{M} _-]/gu, '')
      .replace(/ /g, '-');
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    anchors.add(n === 0 ? base : `${base}-${n}`);
  }
  return anchors;
}

/** Link targets with their line numbers; code fences and inline code are ignored. */
function linksOf(text) {
  const found = [];
  let fenced = false;
  text.split('\n').forEach((raw, i) => {
    if (/^\s*(```|~~~)/.test(raw)) fenced = !fenced;
    if (fenced) return;
    const line = raw.replace(/`[^`]*`/g, '');
    for (const m of line.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) found.push([i + 1, m[1]]);
    const ref = /^\s*\[[^\]]+\]:\s*<?(\S+?)>?\s*$/.exec(line);
    if (ref) found.push([i + 1, ref[1]]);
  });
  return found;
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (SCANNED.test(name) && !OWN_FILES.has(full)) out.push(full);
  }
  return out;
}

/** Every file to check: the package tree, then each public extra that exists (a file or a tree). */
function collect() {
  const out = walk(ROOT);
  for (const extra of EXTRA_ROOTS) {
    const full = resolve(REPO, extra);
    if (!existsSync(full)) continue;
    if (statSync(full).isDirectory()) walk(full, out);
    else if (SCANNED.test(full)) out.push(full);
  }
  return out;
}

const problems = [];
const anchorCache = new Map();
const anchorsFor = (file) => {
  if (!anchorCache.has(file)) anchorCache.set(file, anchorsOf(readFileSync(file, 'utf8')));
  return anchorCache.get(file);
};
const rel = (file) => relative(REPO, file).split('\\').join('/');
/** Where a file's relative links start: its own directory, or the repo root for a scaffold file. */
const linkBaseOf = (file) =>
  file.startsWith(OPEN_ROOT_SCAFFOLD + sep) ? resolve(REPO, relative(OPEN_ROOT_SCAFFOLD, dirname(file))) : dirname(file);

const files = collect();
let linkCount = 0;

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const where = rel(file);

  text.split('\n').forEach((line, i) => {
    for (const label of forbiddenLabels(where, line)) {
      problems.push(`${where}:${i + 1}  forbidden token (${label})`);
    }
  });

  if (!MARKDOWN.test(file)) continue;
  for (const [lineNo, target] of linksOf(text)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) continue; // external
    linkCount += 1;
    const [pathPart, anchor] = target.split('#');
    const resolved = pathPart ? resolve(linkBaseOf(file), decodeURIComponent(pathPart)) : file;
    if (!existsSync(resolved)) {
      problems.push(`${where}:${lineNo}  broken link: ${target}`);
      continue;
    }
    if (anchor && MARKDOWN.test(resolved) && statSync(resolved).isFile()) {
      if (!anchorsFor(resolved).has(decodeURIComponent(anchor).toLowerCase())) {
        problems.push(`${where}:${lineNo}  broken anchor: ${target}`);
      }
    }
  }
}

if (problems.length > 0) {
  console.error(problems.join('\n'));
  console.error(`\ndocs:check FAILED — ${problems.length} problem(s) in ${files.length} file(s).`);
  process.exit(1);
}
console.log(`docs:check ok — ${files.length} file(s), ${linkCount} relative link(s), no forbidden tokens.`);
