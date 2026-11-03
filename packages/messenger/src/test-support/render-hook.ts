/**
 * Mounts a hook in a real React tree (jsdom) and hands back its latest return value.
 *
 * Why not `@testing-library/react`: the package keeps its dev dependencies to what the host
 * already ships, and a hook needs nothing more than `createRoot` + `act`.
 */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';

export interface RenderedHook<T> {
  /** The value the hook returned on its latest render. */
  readonly current: T;
  /** Re-renders the same component, as a parent re-render would. */
  rerender(): Promise<void>;
  unmount(): Promise<void>;
}

/** Lets pending promises (fake transport answers, directory reads) resolve inside `act`. */
export async function settle(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

export async function renderHook<T>(useHook: () => T): Promise<RenderedHook<T>> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.createElement('div'));
  let latest: { value: T } | undefined;

  function Probe(): null {
    latest = { value: useHook() };
    return null;
  }

  await act(async () => {
    root.render(createElement(Probe));
  });

  return {
    get current(): T {
      if (!latest) throw new Error('the hook has not rendered');
      return latest.value;
    },
    async rerender() {
      await act(async () => {
        root.render(createElement(Probe));
      });
    },
    async unmount() {
      await act(async () => {
        root.unmount();
      });
    },
  };
}
