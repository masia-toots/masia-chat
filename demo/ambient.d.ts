// The messenger ships its bundler list as plain `.mjs` with no typings; this is the one line that types it.
declare module '@masia/messenger/bundler/optional-peers' {
  export const OPTIONAL_PEERS: RegExp[];
}
