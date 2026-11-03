// A line of text that shows for a few seconds: where the messenger's `env.notifyError` lands. A store
// with `subscribe` and `getSnapshot` (React reads it with `useSyncExternalStore`); the snapshot array
// is replaced, never edited, so an unchanged toaster hands out the same object.

export const TOAST_MS = 6_000;
/** Toasts kept at once; a burst of failures does not bury the page. */
export const TOAST_MAX = 3;

export interface Toast {
  readonly id: number;
  readonly message: string;
}

export interface Toaster {
  push(message: string): void;
  dismiss(id: number): void;
  subscribe(listener: () => void): () => void;
  getSnapshot(): readonly Toast[];
}

export function createToaster(): Toaster {
  let toasts: readonly Toast[] = [];
  let nextId = 1;
  const listeners = new Set<() => void>();
  const set = (next: readonly Toast[]): void => {
    toasts = next;
    for (const listener of listeners) listener();
  };
  const dismiss = (id: number): void => {
    if (toasts.some((toast) => toast.id === id)) set(toasts.filter((toast) => toast.id !== id));
  };
  return {
    push(message) {
      const id = nextId++;
      set([...toasts, { id, message }].slice(-TOAST_MAX));
      setTimeout(() => dismiss(id), TOAST_MS);
    },
    dismiss,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => toasts,
  };
}
