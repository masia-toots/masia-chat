/**
 * What a push notification is allowed to say: which conversation has something new, and when the
 * device heard about it. It NEVER carries message text, a sender name or any other content.
 *
 * Why: push providers see every payload. The text is fetched and decrypted locally after the
 * wake-up, so the provider (and the relay) learn only that "something happened in room X".
 */
export interface GenericPush {
  readonly conversationId: string;
  /** Epoch milliseconds at which this device received the push. */
  readonly receivedAt: number;
}

/**
 * The host's bridge from the platform push channel (APNs, FCM, Web Push) to the messenger.
 *
 * Why: receiving a push is a platform concern (entitlements, service workers, background
 * limits). The messenger only needs the content-free signal to go and fetch and decrypt.
 */
export interface PushBridge {
  /** Subscribes to generic pushes; returns the unsubscribe function. */
  onGenericPush(cb: (p: GenericPush) => void): () => void;
}
