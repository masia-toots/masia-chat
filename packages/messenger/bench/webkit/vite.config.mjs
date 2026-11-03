// Vite config for the bench page. Plain object, no `import` from 'vite': this package does not
// depend on Vite (the runner borrows one from a workspace that does), so the config must load
// without resolving it.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// The optional `ts-mls` peers a bundle leaves out (one list for every bundler config of the engine).
import { OPTIONAL_PEERS } from '../../bundler/optional-peers.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, '..', '..');

/** @type {import('vite').UserConfig} */
export default {
  root: here,
  base: '/',
  cacheDir: resolve(here, 'dist', '.vite'),
  resolve: {
    alias: [
      // The shared test support imports `expect` from vitest; the page has no test runner.
      { find: /^vitest$/, replacement: resolve(here, 'shims', 'vitest.ts') },
      // The public entry of the MLS engine, the way a consumer imports it.
      { find: /^@masia\/messenger\/mls$/, replacement: resolve(pkg, 'src', 'mls', 'index.ts') },
    ],
  },
  build: {
    outDir: resolve(here, 'dist'),
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    minify: 'esbuild',
    modulePreload: false,
    reportCompressedSize: true,
    rollupOptions: { external: OPTIONAL_PEERS },
  },
  worker: {
    format: 'es',
    rollupOptions: { external: OPTIONAL_PEERS },
  },
};
