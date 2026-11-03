/**
 * The documentation gate (`scripts/docs-check.mjs`) and its forbidden-token rules
 * (`scripts/forbidden-tokens.mjs`), run as the CLI it is, against throwaway trees (К10b).
 *
 * What is pinned:
 *   - the maintainers' file, and only it (plus the playground's contacts file), may name people and give
 *     a contact address on the project's domain; the security policy may give the reporting address on
 *     that domain and name nobody;
 *   - the relaxation is by group: a personal mail address or a private-monorepo path in the SAME file
 *     still fails, and a name anywhere else (package docs, the playground's README, another data file
 *     of the playground) still fails;
 *   - the traces of the private working environment (the founder's nickname in Latin, the agents' session
 *     trailer, local paths with forward slashes, machine names) fail everywhere, the nickname excepted
 *     in the maintainers' file, and ordinary paths and URLs do not trip them;
 *   - a failure names the rule and the line, never the matched text;
 *   - the contracts, the relay library and the relay server are read like the package: their Markdown links
 *     must resolve and their files carry no forbidden token;
 *   - the allowance list is short and is pinned here, so adding a path is a visible, reviewed change.
 *
 * The tokens are built from char codes: this file is itself scanned by the gate it tests.
 *
 * Test by failure (planted, seen to fail, removed): `allowedGroups` matching a path by its last five
 * characters (`.json` also matched) -> "in a data file of the playground other than its contacts file"
 * and "is exactly the maintainers file and the playground contacts file, by path". The three open packages
 * left out of `EXTRA_ROOTS` -> all nine cases of "the other open packages are read too".
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = resolve(HERE, '..', '..', 'scripts');

// "a given name of a founder", "the production domain", "a personal mail host": spelled as char codes.
const word = (...codes: number[]): string => String.fromCharCode(...codes);
const PERSON = word(0x65, 0x75, 0x67, 0x65, 0x6e, 0x65);
const DOMAIN = word(0x6d, 0x61, 0x73, 0x69, 0x61, 0x2e, 0x74, 0x6f);
const PERSONAL_MAIL = word(0x40, 0x67, 0x6d, 0x61, 0x69, 0x6c);
/** A path into the private monorepo, split so no line of this file is one. */
const PRIVATE_PATH = ['spa', 'ces/notes'].join('');

let repo: string;

function put(path: string, text: string): void {
  const full = join(repo, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text);
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'docs-check-'));
  const scripts = join(repo, 'packages', 'messenger', 'scripts');
  mkdirSync(scripts, { recursive: true });
  for (const name of ['docs-check.mjs', 'forbidden-tokens.mjs']) {
    copyFileSync(join(SCRIPTS, name), join(scripts, name));
  }
  put('packages/messenger/README.md', '# A clean package\n');
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

function check(): { code: number; out: string } {
  const run = spawnSync(process.execPath, [join(repo, 'packages', 'messenger', 'scripts', 'docs-check.mjs'), '--all'], {
    encoding: 'utf8',
  });
  return { code: run.status ?? -1, out: `${run.stdout}${run.stderr}` };
}

describe('docs-check: the maintainers file', () => {
  it('a clean tree passes', () => {
    expect(check().code).toBe(0);
  });

  it('may name a person and give an address on the project domain', () => {
    put('MAINTAINERS.md', `| ${PERSON} | Lead | someone@${DOMAIN} | TBD |\n`);
    const result = check();
    expect(result.out).toContain('docs:check ok');
    expect(result.code).toBe(0);
  });

  it('a personal mail host in the same file still fails', () => {
    put('MAINTAINERS.md', `| ${PERSON} | Lead | someone${PERSONAL_MAIL}.com | TBD |\n`);
    const result = check();
    expect(result.code).toBe(1);
    expect(result.out).toContain('MAINTAINERS.md:1  forbidden token (personal mail)');
  });

  it('a path into the private monorepo in the same file still fails', () => {
    put('MAINTAINERS.md', `See ${PRIVATE_PATH} for the plan.\n`);
    const result = check();
    expect(result.code).toBe(1);
    expect(result.out).toContain('MAINTAINERS.md:1  forbidden token (path into the private monorepo)');
  });

  it('its links are still checked', () => {
    put('MAINTAINERS.md', 'See [the policy](SECURITY.md).\n');
    const result = check();
    expect(result.code).toBe(1);
    expect(result.out).toContain('MAINTAINERS.md:1  broken link: SECURITY.md');
  });
});

describe('docs-check: the security policy', () => {
  // Gated where the split tooling keeps it; the open repository root file has the same allowance by path.
  const POLICY = 'tools/open-split/scaffold/SECURITY.md';

  it('may give the address a vulnerability is reported to, on the project domain', () => {
    put(POLICY, `Write to security@${DOMAIN} with SECURITY in the subject.\n`);
    const result = check();
    expect(result.out).toContain('docs:check ok');
    expect(result.code).toBe(0);
  });

  it('may not name a person, and may not give a personal mail address', () => {
    put(POLICY, `Write to ${PERSON} at security@${DOMAIN}.\n`);
    const named = check();
    expect(named.code).toBe(1);
    expect(named.out).toContain(`${POLICY}:1  forbidden token (founder, given name (EN forms))`);
    expect(named.out).not.toContain('(production domain)');
    put(POLICY, `Write to someone${PERSONAL_MAIL}.com.\n`);
    expect(check().out).toContain(`${POLICY}:1  forbidden token (personal mail)`);
  });

  it('a page of the package that gives the same address still fails', () => {
    put('packages/messenger/docs/notes.md', `Write to security@${DOMAIN}.\n`);
    expect(check().out).toContain('forbidden token (production domain)');
  });
});

describe('docs-check: traces of the private working environment', () => {
  // The founder's family nickname (Latin), the agents' session trailer, local paths with forward slashes
  // and the machine names: spelled so that no line of this file is one.
  const NICKNAME = word(0x7a, 0x68, 0x65, 0x6e, 0x65, 0x63, 0x68, 0x6b, 0x61);
  const TRAILER = `${word(0x63, 0x6c, 0x61, 0x75, 0x64, 0x65, 0x2d, 0x73, 0x65, 0x73, 0x73, 0x69, 0x6f, 0x6e)}: https://example.org/x`;
  const MACHINES = [word(0x79, 0x65, 0x6e, 0x6f, 0x74), word(0x73, 0x6b, 0x75, 0x6e, 0x73)];
  const FORWARD_SLASH_PATH = ['C:', 'dev', 'repo'].join('/');
  const SHELL_PATH = ['', 'c', 'dev', 'repo'].join('/');
  const DOC = 'packages/messenger/docs/notes.md';

  const labelsOf = (text: string): string => {
    put(DOC, `${text}\n`);
    return check().out;
  };

  it('each one fails in the package docs, by label and line', () => {
    expect(labelsOf(`Signed off by ${NICKNAME}.`)).toContain(`${DOC}:1  forbidden token (founder, nickname (Latin))`);
    expect(labelsOf(TRAILER)).toContain(`${DOC}:1  forbidden token (agent session trailer)`);
    expect(labelsOf(`Run it from ${FORWARD_SLASH_PATH}/x.`)).toContain(`${DOC}:1  forbidden token (local machine path)`);
    expect(labelsOf(`Run it from ${SHELL_PATH}/x.`)).toContain(`${DOC}:1  forbidden token (local machine path)`);
    for (const machine of MACHINES) {
      expect(labelsOf(`Built on ${machine}-2.`)).toContain(`${DOC}:1  forbidden token (machine name)`);
    }
  });

  it('the report never prints the matched text', () => {
    const out = labelsOf(`${NICKNAME} ${TRAILER} ${FORWARD_SLASH_PATH} ${MACHINES.join(' ')}`);
    for (const secret of [NICKNAME, TRAILER, FORWARD_SLASH_PATH, ...MACHINES]) expect(out).not.toContain(secret);
  });

  it('ordinary paths, URLs and words do not trip them', () => {
    const clean = 'See https://example.org/dev/users/ and ./src/c/dev/x, mount /var/dev/users, a "sessions" table.';
    put(DOC, `${clean}\n`);
    const result = check();
    expect(result.out).toContain('docs:check ok');
    expect(result.code).toBe(0);
  });

  it('the maintainers file may name the nickname (a person), nothing else of these', () => {
    put('MAINTAINERS.md', `| ${NICKNAME} | Lead | TBD | TBD |\n`);
    expect(check().code).toBe(0);
    put('MAINTAINERS.md', `${TRAILER}\n`);
    expect(check().out).toContain('MAINTAINERS.md:1  forbidden token (agent session trailer)');
    put('MAINTAINERS.md', `Built on ${MACHINES[0]}.\n`);
    expect(check().out).toContain('MAINTAINERS.md:1  forbidden token (machine name)');
    put('MAINTAINERS.md', `At ${FORWARD_SLASH_PATH}.\n`);
    expect(check().out).toContain('MAINTAINERS.md:1  forbidden token (local machine path)');
  });
});

describe('docs-check: a forbidden token elsewhere still fails', () => {
  it('in the package docs', () => {
    put('packages/messenger/docs/notes.md', `Written by ${PERSON}.\n`);
    const result = check();
    expect(result.code).toBe(1);
    expect(result.out).toContain('packages/messenger/docs/notes.md:1  forbidden token (founder, given name (EN forms))');
  });

  it('in the playground README', () => {
    put('demo/README.md', `Ask ${PERSON} at someone@${DOMAIN}.\n`);
    const result = check();
    expect(result.code).toBe(1);
    expect(result.out).toContain('demo/README.md:1  forbidden token (founder, given name (EN forms))');
    expect(result.out).toContain('demo/README.md:1  forbidden token (production domain)');
  });

  it('in a data file of the playground other than its contacts file', () => {
    put('demo/other.json', `{ "name": "${PERSON}" }\n`);
    expect(check().code).toBe(1);
  });

  it('in the split tooling', () => {
    put('tools/open-split/readme.md', `${PERSON}\n`);
    expect(check().code).toBe(1);
  });

  it('the playground contacts file is the one other place a name may stand', () => {
    put('demo/contacts.json', `{ "contacts": [{ "name": "${PERSON}", "email": "someone@${DOMAIN}" }] }\n`);
    expect(check().code).toBe(0);
  });

  it('the report names the rule and the line, never the matched text', () => {
    put('demo/README.md', `Ask ${PERSON}.\n`);
    const result = check();
    expect(result.out).not.toContain(PERSON);
  });
});

describe('docs-check: the other open packages are read too', () => {
  const OPEN_PACKAGES = ['packages/contracts', 'packages/relay', 'apps/relay'] as const;

  it.each(OPEN_PACKAGES)('a name in the Markdown of %s fails', (dir) => {
    put(`${dir}/README.md`, `Written by ${PERSON}.\n`);
    const result = check();
    expect(result.code).toBe(1);
    expect(result.out).toContain(`${dir}/README.md:1  forbidden token (founder, given name (EN forms))`);
  });

  it.each(OPEN_PACKAGES)('a link in the Markdown of %s that does not resolve fails', (dir) => {
    put(`${dir}/README.md`, 'See [the notes](NOTES.md).\n');
    const result = check();
    expect(result.code).toBe(1);
    expect(result.out).toContain(`${dir}/README.md:1  broken link: NOTES.md`);
  });

  it.each(OPEN_PACKAGES)('a link in the Markdown of %s that resolves passes', (dir) => {
    put(`${dir}/README.md`, 'See [the notes](NOTES.md).\n');
    put(`${dir}/NOTES.md`, '# Notes\n');
    expect(check().code).toBe(0);
  });

  it.each(OPEN_PACKAGES)('a private path in the source of %s fails', (dir) => {
    put(`${dir}/src/index.ts`, `// see ${PRIVATE_PATH}\n`);
    const result = check();
    expect(result.code).toBe(1);
    expect(result.out).toContain(`${dir}/src/index.ts:1  forbidden token (path into the private monorepo)`);
  });
});

describe('docs-check: the allowance list', () => {
  it('is exactly the maintainers file, the playground contacts file and the security policy, by path', async () => {
    const tokens = (await import(pathToFileURL(join(SCRIPTS, 'forbidden-tokens.mjs')).href)) as {
      PATH_ALLOWANCES: { path: string; groups: string[]; why: string }[];
      allowedGroups(path: string): Set<string>;
    };
    const SECURITY_POLICY = ['SECURITY.md', 'tools/open-split/scaffold/SECURITY.md'];
    expect(tokens.PATH_ALLOWANCES.map((entry) => entry.path)).toEqual([
      'MAINTAINERS.md',
      'demo/contacts.json',
      ...SECURITY_POLICY,
    ]);
    for (const entry of tokens.PATH_ALLOWANCES) {
      // The security policy may give the reporting address (the domain) and name nobody.
      expect(entry.groups, entry.path).toEqual(SECURITY_POLICY.includes(entry.path) ? ['domain'] : ['people', 'domain']);
      expect(entry.why.length, entry.path).toBeGreaterThan(10);
    }
    // By exact path: neither a prefix, a suffix nor a backslash spelling of another file passes.
    expect(tokens.allowedGroups('MAINTAINERS.md').size).toBe(2);
    expect(tokens.allowedGroups('docs/MAINTAINERS.md').size).toBe(0);
    expect(tokens.allowedGroups('MAINTAINERS.md.bak').size).toBe(0);
    expect(tokens.allowedGroups('demo\\contacts.json').size).toBe(2);
    expect(tokens.allowedGroups('demo/contacts.json.bak').size).toBe(0);
    expect([...tokens.allowedGroups('SECURITY.md')]).toEqual(['domain']);
    expect(tokens.allowedGroups('docs/SECURITY.md').size).toBe(0);
  });
});
