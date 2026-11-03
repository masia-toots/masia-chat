import { describe, expect, it } from 'vitest';
import { E2EE_PAYLOAD_VERSION, type E2eePayload } from '@masia/messenger/protocol';
import { mergeHistory, type HistoryItem } from './history.js';

const text = (id: string, body = id): E2eePayload => ({ v: E2EE_PAYLOAD_VERSION, kind: 'text', id, body });

function item(seq: number, senderUserId: string, payload?: E2eePayload, unreadable?: string): HistoryItem {
  return {
    seq,
    senderUserId,
    senderDeviceId: `${senderUserId}-device`,
    createdAt: '2026-10-10T12:00:00.000Z',
    ...(payload === undefined ? {} : { payload }),
    ...(unreadable === undefined ? {} : { unreadable }),
  };
}

describe('mergeHistory', () => {
  it('orders by seq whatever the order it was given', () => {
    const merged = mergeHistory([item(3, 'a', text('c'))], [item(1, 'a', text('a')), item(2, 'b', text('b'))]);
    expect(merged.map((entry) => entry.seq)).toEqual([1, 2, 3]);
  });

  it('a message seen twice replaces itself: the same sender and the same payload id are one line', () => {
    const first = item(1, 'a', text('m1', 'first'));
    const again = item(1, 'a', text('m1', 'second'));
    const merged = mergeHistory([first], [again]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toBe(again);
  });

  it('never lets one member\'s payload id replace another member\'s message', () => {
    const merged = mergeHistory([item(1, 'a', text('same', 'from a'))], [item(2, 'b', text('same', 'from b'))]);
    expect(merged.map((entry) => entry.senderUserId)).toEqual(['a', 'b']);
  });

  it('keeps every line that did not decode, one per seq', () => {
    const merged = mergeHistory(
      [item(1, 'a', undefined, 'DECRYPT_FAILED')],
      [item(2, 'a', undefined, 'DECRYPT_FAILED'), item(1, 'a', undefined, 'DECRYPT_FAILED')],
    );
    expect(merged.map((entry) => entry.seq)).toEqual([1, 2]);
  });

  it('does not change what it was given', () => {
    const existing = [item(2, 'a', text('x'))];
    const incoming = [item(1, 'a', text('y'))];
    mergeHistory(existing, incoming);
    expect(existing).toHaveLength(1);
    expect(incoming).toHaveLength(1);
  });
});
