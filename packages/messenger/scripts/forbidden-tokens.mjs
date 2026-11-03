// The forbidden-token rules of the open tree: ONE list, read by `docs-check.mjs` (the package gate) and
// by `tools/open-split/dry-run.mjs` (the split report), so the two cannot disagree about what must not
// be published. No dependencies.
//
// The patterns are written as \u-escapes ON PURPOSE: this file must not be the one place in the public
// tree that spells the names it forbids. A report names the rule's label and the line, never the
// matched text.
//
// ## Groups and the per-path allowance
//
// Each rule belongs to a GROUP. A file listed in `PATH_ALLOWANCES` may use the named groups and
// nothing else: the maintainers' file names people and gives a contact address, which the editorial
// rules ("roles, not names") forbid everywhere else. The allowance is by exact repo-relative path, never
// by pattern or directory, and it relaxes only the groups listed, so a private path, a personal mail
// address or a hosting provider in the same file still fails.
//
// Adding a path here is a policy decision, not a convenience: it needs a reason in `why`, and the
// test (`src/__tests__/docs-check.test.ts`) pins the list so a change shows up in review.

/** People: the founders, their family and third parties named in private notes; the founder's handle. */
export const GROUP_PEOPLE = 'people';
/** The production domain (a maintainer's contact address lives on it). */
export const GROUP_DOMAIN = 'domain';
/** Everything else is strict everywhere: no group a path can be allowed to use. */
export const GROUP_STRICT = 'strict';

// [group, label, regex source]. Matched case-insensitively, unicode-aware.
const SOURCES = [
  // People: the founder and family are named by role in public docs ("the founder", "a family member").
  // The founder's family nickname, Latin transliteration (the Cyrillic form is the UA given name below):
  // it travels in commit trailers and logs, where only a rule can see it.
  [GROUP_PEOPLE, 'founder, nickname (Latin)', '\u007a\u0068\u0065\u006e\u0065\u0063\u0068'],
  [GROUP_PEOPLE, 'founder, given name (UA)', '\u0436\u0435\u043d\u0435\u0447'],
  [GROUP_PEOPLE, 'founder, given name (EN forms)', '\u0069\u0065\u0076\u0067\u0065\u006e'],
  [GROUP_PEOPLE, 'founder, given name (EN forms)', '\u0079\u0065\u0076\u0068\u0065\u006e'],
  [GROUP_PEOPLE, 'founder, given name (EN forms)', '\u0065\u0076\u0067\u0065\u006e'],
  [GROUP_PEOPLE, 'founder, given name (EN forms)', '\u0065\u0075\u0067\u0065\u006e\u0065'],
  [GROUP_PEOPLE, 'founder, given name (UA)', '\u0454\u0432\u0433\u0435\u043d'],
  [GROUP_PEOPLE, 'founder, surname (EN forms)', '\u0072\u0069\u0061\u0062\u0063\u0068\u0065\u006e\u006b\u006f'],
  [GROUP_PEOPLE, 'founder, surname (EN forms)', '\u0072\u0079\u0061\u0062\u0063\u0068\u0065\u006e\u006b\u006f'],
  [GROUP_PEOPLE, 'founder, surname (UA)', '\u0440\u044f\u0431\u0447\u0435\u043d\u043a'],
  [GROUP_PEOPLE, 'founder, handle', '\u006c\u006f\u0067\u0068\u0069'],
  [GROUP_PEOPLE, 'family member, given name (UA)', '\u0433\u0430\u043b\u044e\u043d'],
  [GROUP_PEOPLE, 'family member, given name (EN forms)', '\u0067\u0061\u006c\u0069\u0075\u006e'],
  [GROUP_PEOPLE, 'family member, given name (EN forms)', '\u0067\u0061\u006c\u0079\u0075\u006e'],
  [GROUP_PEOPLE, 'family member, given name (EN forms)', '\u0068\u0061\u006c\u0079\u0075\u006e'],
  [GROUP_PEOPLE, 'family member, given name (UA)', '\u043e\u043b\u0435\u043d\u043a'],
  [GROUP_PEOPLE, 'family member, given name (EN forms)', '\u006f\u006c\u0065\u006e\u006b'],
  [GROUP_PEOPLE, 'third person named in private notes (UA)', '\u043e\u043b\u0435\u0433'],
  [GROUP_PEOPLE, 'third person named in private notes (EN)', '\\b\u006f\u006c\u0065\u0067\\b'],
  [GROUP_PEOPLE, 'third person named in private notes (EN)', '\\b\u006f\u006c\u0065\u0068\\b'],
  [GROUP_STRICT, 'git identity', '\u0063\u0072\u0065\u006f\\s\u002a\u0063\u0072\u0061\u0063\u0079'],
  // Production and infrastructure.
  [GROUP_DOMAIN, 'production domain', '\u006d\u0061\u0073\u0069\u0061\\.\u0074\u006f'],
  [GROUP_STRICT, 'personal mail', '\u0040\u0067\u006d\u0061\u0069\u006c'],
  [GROUP_STRICT, 'hosting provider', '\u0068\u0065\u0074\u007a\u006e\u0065\u0072'],
  // Sibling projects of the private monorepo.
  [GROUP_STRICT, 'sibling project', '\u0064\u0075\u006f\u0064\u0061\u0074\u0061'],
  [GROUP_STRICT, 'sibling project', '\u006d\u0065\u0064\u0069\u0061\u006c\u006c\u0079'],
  [GROUP_STRICT, 'sibling substrate repo', '\u006d\u0061\u0073\u0069\u0061\u002d\u0063\u006f\u0072\u0065'],
  [GROUP_STRICT, 'sibling secrets repo', '\u006d\u0061\u0073\u0069\u0061\u002d\u0073\u0065\u0063\u0072\u0065\u0074\u0073'],
  // Paths and file kinds of the private monorepo: cite an ADR by number and summarise it instead.
  [GROUP_STRICT, 'path into the private monorepo', '(^|[^\\w.-])spaces/'],
  [GROUP_STRICT, 'path into the private monorepo', 'docs/decisions/'],
  [GROUP_STRICT, 'path into the private monorepo', '(^|[^\\w.-])(backend/api|apps/hub)'],
  [GROUP_STRICT, 'private space-file kind', '==(canon|plan|log|experience|context|protocol|research)=='],
  // A space FILE is `==kind==name.masia` or a path segment; `labels.masia` (a field access) is not one.
  [GROUP_STRICT, 'private space-file kind', '(==|/)[\\w=-]*\\.masia\\b'],
  [GROUP_STRICT, 'local machine path', '[a-z]:\\\\(dev|users)\\\\'],
  // The same paths with forward slashes (`C:/dev/...`, and the `/c/dev/...` of a POSIX shell on Windows).
  [GROUP_STRICT, 'local machine path', '[a-z]:/(dev|users)/'],
  [GROUP_STRICT, 'local machine path', '(^|[^\\w./-])/[a-z]/(dev|users)/'],
  // Traces of the private working environment: the session trailer the agents' commits carry, and the
  // names of the machines the monorepo is developed on.
  [GROUP_STRICT, 'agent session trailer', '\u0063\u006c\u0061\u0075\u0064\u0065\u002d\u0073\u0065\u0073\u0073\u0069\u006f\u006e'],
  [GROUP_STRICT, 'machine name', '\\b\u0079\u0065\u006e\u006f\u0074'],
  [GROUP_STRICT, 'machine name', '\\b\u0073\u006b\u0075\u006e\u0073'],
];

export const RULES = SOURCES.map(([group, label, source]) => ({
  group,
  label,
  pattern: new RegExp(source, 'iu'),
}));

/**
 * The files that may break an editorial rule, and which groups they may break. Repo-relative paths with
 * forward slashes, exact match. Keep this list SHORT.
 */
export const PATH_ALLOWANCES = [
  {
    path: 'MAINTAINERS.md',
    groups: [GROUP_PEOPLE, GROUP_DOMAIN],
    why: 'The maintainers file exists to name people and give a contact address.',
  },
  {
    path: 'demo/contacts.json',
    groups: [GROUP_PEOPLE, GROUP_DOMAIN],
    why: 'The playground suggests the maintainers in its empty contacts list; this is that list.',
  },
  // The security policy names the address a vulnerability is reported to, and that address is on the
  // production domain. The domain group ONLY: no person may be named there. Two paths, one file: where it
  // lands in the open repository, and where the split tooling keeps it until then (the gate reads it there).
  {
    path: 'SECURITY.md',
    groups: [GROUP_DOMAIN],
    why: 'The security policy gives the address a vulnerability is reported to, which is on the domain.',
  },
  {
    path: 'tools/open-split/scaffold/SECURITY.md',
    groups: [GROUP_DOMAIN],
    why: 'The same file before the split: the open repository root SECURITY.md is written from this one.',
  },
];

/** The groups `relPath` (repo-relative, any slash) may use; none for a path with no allowance. */
export function allowedGroups(relPath) {
  const path = relPath.split('\\').join('/');
  const hit = PATH_ALLOWANCES.find((entry) => entry.path === path);
  return new Set(hit ? hit.groups : []);
}

/** The labels of the rules `line` breaks in the file `relPath` (an allowed group is not broken there). */
export function forbiddenLabels(relPath, line) {
  const allowed = allowedGroups(relPath);
  const labels = [];
  for (const { group, label, pattern } of RULES) {
    if (allowed.has(group)) continue;
    if (pattern.test(line)) labels.push(label);
  }
  return labels;
}
