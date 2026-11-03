import { describe, expect, it } from 'vitest';
import { createTtlCounter } from '../ttl-counter.js';

function clock(start = 1_000) {
  let at = start;
  return {
    now: () => at,
    advance(ms: number) {
      at += ms;
    },
  };
}

describe('createTtlCounter (fixed window)', () => {
  it('counts hits per key and keeps keys apart', () => {
    const time = clock();
    const counter = createTtlCounter({ ttlMs: 100, window: 'fixed', now: time.now });
    expect(counter.hit('a').count).toBe(1);
    expect(counter.hit('a').count).toBe(2);
    expect(counter.hit('b').count).toBe(1);
  });

  it('does not extend the window on later hits', () => {
    const time = clock();
    const counter = createTtlCounter({ ttlMs: 100, window: 'fixed', now: time.now });
    const first = counter.hit('a');
    time.advance(90);
    const second = counter.hit('a');
    expect(second.resetsAt).toBe(first.resetsAt);
    time.advance(20); // 110 ms after the first hit: the window has closed
    expect(counter.hit('a').count).toBe(1);
  });
});

describe('createTtlCounter (sliding window)', () => {
  it('pushes the end out on every hit, so only a pause forgets', () => {
    const time = clock();
    const counter = createTtlCounter({ ttlMs: 100, window: 'sliding', now: time.now });
    counter.hit('a');
    time.advance(90);
    expect(counter.hit('a').count).toBe(2);
    time.advance(90); // 180 ms since the first hit, only 90 since the last
    expect(counter.hit('a').count).toBe(3);
    time.advance(100);
    expect(counter.hit('a').count).toBe(1);
  });
});

describe('createTtlCounter reset and memory', () => {
  it('forgets a key on reset', () => {
    const counter = createTtlCounter({ ttlMs: 100, window: 'sliding' });
    counter.hit('a');
    counter.hit('a');
    counter.reset('a');
    expect(counter.hit('a').count).toBe(1);
  });

  it('releases expired keys so a stream of one-off keys cannot grow the map for ever', () => {
    const time = clock();
    const counter = createTtlCounter({ ttlMs: 100, window: 'fixed', now: time.now });
    for (let i = 0; i < 50; i += 1) counter.hit(`one-off-${i}`);
    expect(counter.size).toBe(50);
    time.advance(150);
    counter.hit('fresh');
    expect(counter.size).toBe(1);
  });
});
