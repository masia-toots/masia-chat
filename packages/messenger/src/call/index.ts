/**
 * The 1:1 audio call (internal ADR-211): import it as `@masia/messenger/call`.
 *
 * - `call-engine.ts` — the engine: one `RTCPeerConnection` driven through the call machine, talking to the world only
 *   through ports (`CallEnginePorts`): the socket the `call:*` frames ride, the ICE servers, the binding to the MLS
 *   room (`CallBindingPort`), the microphone, the peer connection, the speaker.
 * - `audio-call-machine.ts` — one device's view of a call, a pure value machine (`audioCall`).
 * - `sdp.ts` — what the engine reads out of an SDP (the one fingerprint the tag binds, the one transport) and what it
 *   strips from one (non-relay candidates on a relay-only call).
 * - `browser-ports.ts` — the generic browser ports: the peer connection, the microphone, the request id.
 * - `call-binding-types.ts` — the binding port's types; the host's MLS worker implements the port.
 *
 * The wire contract (`call:*` events, limits, validation) and the fingerprint tag are in `@masia/contracts/wire`.
 * Nothing here imports a UI framework: the engine runs headless in Node tests and in a browser.
 */
export * from './call-engine.js';
export * from './audio-call-machine.js';
export * from './sdp.js';
export * from './browser-ports.js';
export * from './call-binding-types.js';
