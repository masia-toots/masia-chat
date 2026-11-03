import { describe, expect, it } from 'vitest';
import type { Transport } from '../ports/transport.js';
import { bytesToNumbers, contractTitle, type ContractFactory } from './contract-support.js';

const HTTP_STATUS_MIN = 100;
const HTTP_STATUS_MAX = 599;
const CONTRACT_TOPIC = 'contract-topic';
const OTHER_TOPIC = 'contract-other-topic';

/**
 * What the suite needs beyond the port itself.
 *
 * Why: the suite cannot know which path a real relay answers or how to make it publish. The host's
 * test wiring names a path that gets an HTTP answer (any status) and a way to push bytes onto a
 * topic, as the relay would.
 */
export interface TransportContractHarness<T extends Transport> {
  readonly probePath: string;
  publish(subject: T, topic: string, bytes: Uint8Array): void | Promise<void>;
}

/** Registers the behavioural contract every `Transport` implementation must honour. */
export function describeTransportContract<T extends Transport>(
  name: string,
  factory: ContractFactory<T>,
  harness: TransportContractHarness<T>,
): void {
  describe(contractTitle('Transport', name), () => {
    it('answers a request with an HTTP status and a byte body', async () => {
      const transport = await factory();
      const response = await transport.fetch(harness.probePath);
      expect(Number.isInteger(response.status)).toBe(true);
      expect(response.status).toBeGreaterThanOrEqual(HTTP_STATUS_MIN);
      expect(response.status).toBeLessThanOrEqual(HTTP_STATUS_MAX);
      expect(response.body).toBeInstanceOf(Uint8Array);
    });

    it('delivers published bytes to a subscriber of that topic', async () => {
      const transport = await factory();
      const received: number[][] = [];
      transport.subscribe(CONTRACT_TOPIC, (bytes) => received.push(bytesToNumbers(bytes)));
      await harness.publish(transport, CONTRACT_TOPIC, Uint8Array.of(1, 2, 3));
      expect(received).toEqual([[1, 2, 3]]);
    });

    it('does not deliver bytes published on a different topic', async () => {
      const transport = await factory();
      const received: number[][] = [];
      transport.subscribe(CONTRACT_TOPIC, (bytes) => received.push(bytesToNumbers(bytes)));
      await harness.publish(transport, OTHER_TOPIC, Uint8Array.of(9));
      expect(received).toEqual([]);
    });

    it('stops delivering once the subscriber has unsubscribed', async () => {
      const transport = await factory();
      const received: number[][] = [];
      const unsubscribe = transport.subscribe(CONTRACT_TOPIC, (bytes) =>
        received.push(bytesToNumbers(bytes)),
      );
      unsubscribe();
      await harness.publish(transport, CONTRACT_TOPIC, Uint8Array.of(1));
      expect(received).toEqual([]);
    });

    it('keeps subscribers independent: one leaving does not silence another', async () => {
      const transport = await factory();
      const staying: number[][] = [];
      const leaving: number[][] = [];
      transport.subscribe(CONTRACT_TOPIC, (bytes) => staying.push(bytesToNumbers(bytes)));
      const unsubscribe = transport.subscribe(CONTRACT_TOPIC, (bytes) =>
        leaving.push(bytesToNumbers(bytes)),
      );
      unsubscribe();
      await harness.publish(transport, CONTRACT_TOPIC, Uint8Array.of(7));
      expect(staying).toEqual([[7]]);
      expect(leaving).toEqual([]);
    });
  });
}
