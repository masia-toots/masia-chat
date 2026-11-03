import type { IconSet, MessengerIconName } from '../ports/icon-set.js';

/** What the fake "draws": enough for a test to see which icon at which size was asked for. */
export interface FakeIcon {
  readonly icon: MessengerIconName;
  readonly size: number | undefined;
  readonly className: string | undefined;
}

/** In-memory `IconSet` that renders a plain descriptor instead of pixels. */
export function createFakeIconSet(): IconSet {
  return {
    render(name, size, className): FakeIcon {
      return { icon: name, size, className };
    },
  };
}
