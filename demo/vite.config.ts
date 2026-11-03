import react from '@vitejs/plugin-react';
import { OPTIONAL_PEERS } from '@masia/messenger/bundler/optional-peers';
import { defineConfig } from 'vite';

// `pnpm dev` serves the page with hot reload and sends the two API prefixes to the playground's own
// server (`pnpm start`, port DEMO_PORT). In the compose stack there is no Vite at all: the server
// serves the built `dist/` itself.
const SERVER = `http://127.0.0.1:${process.env['DEMO_PORT'] ?? '8080'}`;

export default defineConfig({
  plugins: [react()],
  server: { port: 5180, proxy: { '/demo': SERVER, '/relay': SERVER } },
  build: {
    // One page, one script: the MLS engine, the messenger UI and React come to about 500 kB. That is the
    // size of this page, not a warning to act on.
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      // The MLS engine names optional peers (other curves, post-quantum, ChaCha) that cipher suite 1 never
      // loads; the messenger ships the one list every bundler config leaves out.
      external: OPTIONAL_PEERS,
      // One library the engine pulls in marks a call as pure in a spot Rollup cannot read, and says so on
      // every build. It changes nothing in the output; every other warning still prints.
      onwarn(warning, warn) {
        if (warning.code === 'INVALID_ANNOTATION') return;
        warn(warning);
      },
    },
  },
});
