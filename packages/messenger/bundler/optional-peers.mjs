// What a host's bundler leaves out when it bundles the MLS engine (`@masia/messenger/mls`).
//
// `ts-mls` names optional peers (other curves, post-quantum, ChaCha) that it loads with a dynamic
// `import()` only for the cipher suites that need them. The engine uses suite 1, which needs none, so
// a bundle leaves them out instead of resolving them (they are not installed). One list for every
// bundler config that bundles the engine: the WebKit bench here and the hub's Vite config (its Worker
// bundle and its in-page fallback).

/** Module ids a bundler marks external (`rollupOptions.external`) when it bundles the engine. */
export const OPTIONAL_PEERS = [
  /^@noble\/(curves|post-quantum)(\/|$)/,
  /^@hpke\/(chacha20poly1305|hybridkem-x-wing|dhkem-x448|ml-kem)(\/|$)/,
];
