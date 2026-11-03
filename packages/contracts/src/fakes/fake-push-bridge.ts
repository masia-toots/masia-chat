import type { GenericPush, PushBridge } from '../ports/push-bridge.js';
import { createFakeEmitter } from './fake-emitter.js';

/** A fake push channel plus the control a test needs: make the platform deliver a push. */
export interface FakePushBridge extends PushBridge {
  push(p: GenericPush): void;
}

/** In-memory `PushBridge`. */
export function createFakePushBridge(): FakePushBridge {
  const pushes = createFakeEmitter<GenericPush>();
  return {
    onGenericPush: (cb) => pushes.add(cb),
    push: (p) => pushes.emit(p),
  };
}
