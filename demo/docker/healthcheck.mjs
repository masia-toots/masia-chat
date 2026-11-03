/* global process, console, AbortSignal, fetch -- Node globals; the repo's flat ESLint config declares none for .mjs */
// A container health probe: GET the URL given as the first argument, exit 0 on a 2xx answer.
// (The images carry node, not curl.)

const url = process.argv[2];
if (!url) {
  console.error('usage: node healthcheck.mjs <url>');
  process.exit(2);
}

try {
  const answer = await fetch(url, { signal: AbortSignal.timeout(4000) });
  process.exit(answer.ok ? 0 : 1);
} catch {
  process.exit(1);
}
