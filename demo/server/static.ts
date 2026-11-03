import { readFile, stat } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';

// The built page, served from `dist/`. Single-page app: a path with no file behind it answers
// `index.html`, so a reload on any address works. Nothing outside `dist/` is ever readable.

const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

/** The page may load its own files and talk to its own origin, nothing else. */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "img-src 'self' data:",
  // Mantine and React write inline styles.
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const SECURITY_HEADERS = {
  'content-security-policy': CONTENT_SECURITY_POLICY,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
} as const;

const IMMUTABLE = 'public, max-age=31536000, immutable';
const REVALIDATE = 'no-cache';

/** The file inside `root` for a URL path, or `null` when it would leave `root`. Pure, for tests. */
export function resolveInside(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0] ?? '');
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const full = normalize(join(root, decoded));
  const base = root.endsWith(sep) ? root : root + sep;
  return full === root || full.startsWith(base) ? full : null;
}

async function fileAt(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export async function serveStatic(
  response: ServerResponse,
  root: string,
  urlPath: string,
  method: string,
): Promise<void> {
  const wanted = resolveInside(root, urlPath);
  if (wanted === null) {
    response.writeHead(400, SECURITY_HEADERS).end('bad path');
    return;
  }
  let path = wanted;
  const isAsset = urlPath.startsWith('/assets/');
  if (!(await fileAt(path))) {
    // A missing asset is a 404 (a stale cache must not be handed an HTML page as a script).
    if (isAsset || extname(path) !== '') {
      response.writeHead(404, SECURITY_HEADERS).end('not found');
      return;
    }
    path = join(root, 'index.html');
    if (!(await fileAt(path))) {
      response
        .writeHead(404, { ...SECURITY_HEADERS, 'content-type': 'text/plain; charset=utf-8' })
        .end('The page is not built: run `pnpm -F @masia/demo build`.');
      return;
    }
  }
  const body = await readFile(path);
  response.writeHead(200, {
    ...SECURITY_HEADERS,
    'content-type': TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream',
    'content-length': String(body.length),
    'cache-control': isAsset ? IMMUTABLE : REVALIDATE,
  });
  response.end(method === 'HEAD' ? undefined : body);
}
