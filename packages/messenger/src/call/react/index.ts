/**
 * The 1:1 audio call in React: import it as `@masia/messenger/call/react`. A host mounts it in three pieces
 * (`docs/calls.md` § The call screen):
 *
 * - `use-audio-call.ts` — `useAudioCallHost(options)` makes the tab's one engine from the host's ports; `useAudioCall()`
 *   reads it anywhere.
 * - `audio-call-host.tsx` — `AudioCallHost`, mounted once: the screen with its timers, fold, focus and cues;
 *   `useCallView` reads the engine's snapshot for it.
 * - `audio-call-screen.tsx` — `AudioCallScreen`, the pure render, with the words (`CALL_SCREEN_TEXT_KEYS`) and icons
 *   (`CALL_ICON_NAMES`) the host supplies; `audio-call.css` beside it.
 * - `use-call-entry.ts` — `useCallEntry`, whether «Call» can be pressed now in a chat, and the honest reason when not.
 * - `call-view.ts`, `call-entry.ts` — the pure readings under them.
 */
export * from './use-audio-call.js';
export * from './audio-call-host.js';
export * from './audio-call-screen.js';
export * from './use-call-entry.js';
export * from './call-view.js';
export * from './call-entry.js';
