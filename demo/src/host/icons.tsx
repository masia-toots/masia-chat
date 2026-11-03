import type { ReactNode } from 'react';
import type { IconSet, MessengerIconName } from '@masia/contracts';

// The playground's icons: 27 small line drawings made for this page out of plain shapes (lines, arcs,
// rectangles, circles) on a 24 by 24 grid. They are drawn here, not taken from an icon library, so
// the playground carries no third-party artwork and no licence besides its own.

const DOT = 0.9;

const GLYPHS: Readonly<Record<MessengerIconName, ReactNode>> = {
  send: (
    <>
      <path d="M4 12 L20 4 L13 20 L11 13 Z" />
      <path d="M11 13 L20 4" />
    </>
  ),
  attach: (
    <>
      <path d="M7 3 H14 L18 7 V21 H7 Z" />
      <path d="M14 3 V7 H18" />
      <path d="M10 12 H15 M10 16 H15" />
    </>
  ),
  devices: (
    <>
      <rect x="3" y="5" width="13" height="10" rx="1.5" />
      <rect x="14" y="10" width="7" height="10" rx="1.5" />
      <path d="M6 19 H11" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11 V8 A4 4 0 0 1 16 8 V11" />
      <circle cx="12" cy="16" r={DOT} />
    </>
  ),
  'lock-open': (
    <>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11 V8 A4 4 0 0 1 15.5 6.5" />
      <circle cx="12" cy="16" r={DOT} />
    </>
  ),
  warning: (
    <>
      <path d="M12 3 L22 20 H2 Z" />
      <path d="M12 9.5 V14.5" />
      <circle cx="12" cy="17.2" r={DOT} />
    </>
  ),
  masia: <path d="M12 2 L14.5 9.5 L22 12 L14.5 14.5 L12 22 L9.5 14.5 L2 12 L9.5 9.5 Z" />,
  guardian: (
    <>
      <path d="M12 3 L20 6 V12 C20 17 16 20 12 21 C8 20 4 17 4 12 V6 Z" />
      <path d="M9 12 L11.2 14.2 L15 10" />
    </>
  ),
  people: (
    <>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20 A7 7 0 0 1 19 20" />
    </>
  ),
  groups: (
    <>
      <circle cx="9" cy="9" r="3" />
      <circle cx="17" cy="10" r="2.5" />
      <path d="M3 20 A6 6 0 0 1 15 20" />
      <path d="M16 15 A5 5 0 0 1 21 20" />
    </>
  ),
  back: <path d="M15 5 L8 12 L15 19" />,
  more: (
    <>
      <circle cx="5.5" cy="12" r="1.3" />
      <circle cx="12" cy="12" r="1.3" />
      <circle cx="18.5" cy="12" r="1.3" />
    </>
  ),
  copy: (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M15 9 V6 A2 2 0 0 0 13 4 H6 A2 2 0 0 0 4 6 V13 A2 2 0 0 0 6 15 H9" />
    </>
  ),
  mood: (
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="9" cy="10" r={DOT} />
      <circle cx="15" cy="10" r={DOT} />
      <path d="M8 14.5 A5 4 0 0 0 16 14.5" />
    </>
  ),
  edit: (
    <>
      <path d="M4 20 L5 15 L16 4 L20 8 L9 19 Z" />
      <path d="M14 6 L18 10" />
    </>
  ),
  trash: (
    <>
      <path d="M4 7 H20" />
      <path d="M9 7 V4 H15 V7" />
      <path d="M6 7 L7 20 H17 L18 7" />
      <path d="M10 11 V16 M14 11 V16" />
    </>
  ),
  pin: (
    <>
      <path d="M9 3 H15 L14 10 L17 13 H7 L10 10 Z" />
      <path d="M12 13 V21" />
    </>
  ),
  chat: <path d="M4 5 H20 V16 H11 L6 20 V16 H4 Z" />,
  folder: <path d="M3 6 H10 L12 8 H21 V19 H3 Z" />,
  check: <path d="M5 12.5 L10 17 L19 7" />,
  close: <path d="M6 6 L18 18 M18 6 L6 18" />,
  chevron: <path d="M9 5 L16 12 L9 19" />,
  users: (
    <>
      <circle cx="8" cy="8" r="3" />
      <circle cx="16" cy="8" r="3" />
      <path d="M2.5 20 A5.5 5.5 0 0 1 13.5 20" />
      <path d="M10.5 20 A5.5 5.5 0 0 1 21.5 20" />
    </>
  ),
  'device-mobile': (
    <>
      <rect x="7" y="3" width="10" height="18" rx="2" />
      <path d="M11 18 H13" />
    </>
  ),
  'device-web': (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12 H21" />
      <ellipse cx="12" cy="12" rx="4" ry="9" />
    </>
  ),
  'device-desktop': (
    <>
      <rect x="3" y="4" width="18" height="12" rx="1.5" />
      <path d="M8 20 H16 M12 16 V20" />
    </>
  ),
  logout: (
    <>
      <path d="M10 4 H5 V20 H10" />
      <path d="M10 12 H21 M17 8 L21 12 L17 16" />
    </>
  ),
};

export function createIconSet(): IconSet {
  return {
    render(name, size, className) {
      const side = size ?? '1em';
      return (
        <svg
          width={side}
          height={side}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
          className={className}
        >
          {GLYPHS[name]}
        </svg>
      );
    },
  };
}
