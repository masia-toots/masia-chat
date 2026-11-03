import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONTENT_SECURITY_POLICY, resolveInside, serveStatic } from './static.js';
import { listen, type Listening } from './test-kit.js';

describe('resolveInside', () => {
  const root = join(tmpdir(), 'demo-root');

  it('maps a URL path to a file under the root and drops the query', () => {
    expect(resolveInside(root, '/assets/app.js')).toBe(join(root, 'assets', 'app.js'));
    expect(resolveInside(root, '/assets/app.js?v=1')).toBe(join(root, 'assets', 'app.js'));
    expect(resolveInside(root, '/')).toBe(root + sep);
  });

  it('refuses everything that would leave the root', () => {
    for (const path of ['/../secret', '/a/../../secret', '/%2e%2e/secret', '/%2e%2e%2fsecret', '/a%00b', '/%E0%A4%A']) {
      expect(resolveInside(root, path), path).toBeNull();
    }
  });

  it('does not mistake a sibling directory with the same prefix for the root', () => {
    expect(resolveInside(root, '/../demo-root-other/x')).toBeNull();
  });
});

describe('serveStatic', () => {
  let dir: string;
  let site: Listening;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'demo-static-'));
    await mkdir(join(dir, 'assets'));
    await writeFile(join(dir, 'index.html'), '<!doctype html><title>page</title>');
    await writeFile(join(dir, 'assets', 'app-123.js'), 'console.log(1)');
    site = await listen((request, response) => {
      void serveStatic(response, dir, request.url ?? '/', request.method ?? 'GET');
    });
  });

  afterAll(async () => {
    await site.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('serves the page at the root and at any address with no file behind it (single-page app)', async () => {
    for (const path of ['/', '/chat/anything', '/some/deep/route']) {
      const answer = await fetch(`${site.origin}${path}`);
      expect(answer.status, path).toBe(200);
      expect(answer.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(answer.headers.get('cache-control')).toBe('no-cache');
      expect(await answer.text()).toContain('<title>page</title>');
    }
  });

  it('serves an asset with its type and a long immutable cache', async () => {
    const answer = await fetch(`${site.origin}/assets/app-123.js`);
    expect(answer.status).toBe(200);
    expect(answer.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(answer.headers.get('cache-control')).toContain('immutable');
    expect(await answer.text()).toBe('console.log(1)');
  });

  it('answers 404 for a missing asset or file, never the page in its place', async () => {
    for (const path of ['/assets/gone.js', '/missing.css', '/favicon.ico']) {
      const answer = await fetch(`${site.origin}${path}`);
      expect(answer.status, path).toBe(404);
      expect(await answer.text()).not.toContain('<title>');
    }
  });

  it('puts the same security headers on every answer', async () => {
    for (const path of ['/', '/assets/app-123.js', '/assets/gone.js']) {
      const answer = await fetch(`${site.origin}${path}`);
      expect(answer.headers.get('content-security-policy'), path).toBe(CONTENT_SECURITY_POLICY);
      expect(answer.headers.get('x-content-type-options'), path).toBe('nosniff');
      expect(answer.headers.get('referrer-policy'), path).toBe('no-referrer');
    }
  });

  it('lets the page talk to its own origin only', () => {
    expect(CONTENT_SECURITY_POLICY).toContain("default-src 'self'");
    expect(CONTENT_SECURITY_POLICY).toContain("connect-src 'self'");
    expect(CONTENT_SECURITY_POLICY).toContain("frame-ancestors 'none'");
    expect(CONTENT_SECURITY_POLICY).not.toMatch(/https?:/);
    expect(CONTENT_SECURITY_POLICY).not.toContain("'unsafe-eval'");
  });

  it('answers a HEAD with the headers and no body', async () => {
    const answer = await fetch(`${site.origin}/assets/app-123.js`, { method: 'HEAD' });
    expect(answer.status).toBe(200);
    expect(answer.headers.get('content-length')).toBe(String('console.log(1)'.length));
    expect(await answer.text()).toBe('');
  });

  it('says how to build the page when there is none', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'demo-empty-'));
    const bare = await listen((request, response) => {
      void serveStatic(response, empty, request.url ?? '/', 'GET');
    });
    try {
      const answer = await fetch(`${bare.origin}/`);
      expect(answer.status).toBe(404);
      expect(await answer.text()).toContain('build');
    } finally {
      await bare.close();
      await rm(empty, { recursive: true, force: true });
    }
  });
});
