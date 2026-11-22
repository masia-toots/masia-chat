import type { ReactNode } from 'react';
import type { CallIconName, CallIconRenderer } from '@masia/messenger/call/react';
import { lineIcon, MESSENGER_GLYPHS } from './icons.js';

// The call screen's icons: the same plain line drawings on the same 24 by 24 grid as the rest of the
// page (`icons.tsx`). The lock and the cross are the messenger's own; the rest are drawn here. A Record
// over the package's names, so an icon the screen adds does not compile until it is drawn.

export const CALL_GLYPHS: Readonly<Record<CallIconName, ReactNode>> = {
  // A handset, earpiece top left, mouthpiece bottom right. The red buttons turn it to lie down.
  phone: (
    <path d="M5 4 H9 L10.5 8.5 L8.5 10 A11 11 0 0 0 14 15.5 L15.5 13.5 L20 15 V19 A1 1 0 0 1 19 20 A15 15 0 0 1 4 5 A1 1 0 0 1 5 4 Z" />
  ),
  close: MESSENGER_GLYPHS.close,
  speaker: (
    <>
      <path d="M4 9 H8 L13 5 V19 L8 15 H4 Z" />
      <path d="M16.5 9 A4 4 0 0 1 16.5 15" />
      <path d="M19 6.5 A7.5 7.5 0 0 1 19 17.5" />
    </>
  ),
  mic: (
    <>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5.5 11 A6.5 6.5 0 0 0 18.5 11" />
      <path d="M12 17.5 V21 M9 21 H15" />
    </>
  ),
  'mic-off': (
    <>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5.5 11 A6.5 6.5 0 0 0 18.5 11" />
      <path d="M12 17.5 V21 M9 21 H15" />
      <path d="M4 4 L20 20" />
    </>
  ),
  // Points down, as the first host's fold mark does (its icon set's `chevron`, passed with no turn): the
  // usual sign for "put the call away", though the pill it folds into sits at the top.
  chevron: <path d="M6 9 L12 15 L18 9" />,
  lock: MESSENGER_GLYPHS.lock,
  headphones: (
    <>
      <path d="M4 15 V12 A8 8 0 0 1 20 12 V15" />
      <rect x="3" y="14" width="4" height="6" rx="1.5" />
      <rect x="17" y="14" width="4" height="6" rx="1.5" />
    </>
  ),
};

/** The call screen's `icon`. */
export const callIcon: CallIconRenderer = (name, size, rotate) =>
  lineIcon(CALL_GLYPHS[name], size, rotate === undefined ? {} : { turnDegrees: rotate });
