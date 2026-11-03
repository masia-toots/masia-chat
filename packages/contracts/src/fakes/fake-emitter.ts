/**
 * A listener set with add-returns-unsubscribe semantics.
 *
 * Why one helper: three fakes (auth session, transport, push bridge) need the same
 * subscribe / unsubscribe / emit behaviour, and each hand-rolling it is how the copies drift.
 * Emitting iterates a snapshot, so a listener that unsubscribes itself mid-emit is safe.
 */
export interface FakeEmitter<T> {
  add(listener: (value: T) => void): () => void;
  emit(value: T): void;
}

export function createFakeEmitter<T>(): FakeEmitter<T> {
  const listeners = new Set<(value: T) => void>();
  return {
    add(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit(value) {
      for (const listener of [...listeners]) listener(value);
    },
  };
}
