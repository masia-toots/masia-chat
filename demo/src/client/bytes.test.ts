import { describe, expect, it } from 'vitest';
import { fromBase64, newMessageId, sameBytes, sha256, toBase64 } from './bytes.js';

describe('bytes', () => {
  it('round-trips through base64 at sizes around and beyond one chunk', () => {
    for (const size of [0, 1, 2, 3, 0x7fff, 0x8000, 0x8001, 70_000]) {
      const bytes = new Uint8Array(size).map((_, index) => (index * 31 + 7) % 256);
      expect(sameBytes(fromBase64(toBase64(bytes)), bytes), `size ${size}`).toBe(true);
    }
  });

  it('writes standard base64 with padding, the way the relay reads it', () => {
    expect(toBase64(new Uint8Array([104, 105]))).toBe('aGk=');
    expect(Array.from(fromBase64('aGk='))).toEqual([104, 105]);
  });

  it('compares bytes by content and length', () => {
    expect(sameBytes(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(sameBytes(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
    expect(sameBytes(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
  });

  it('hashes with SHA-256', async () => {
    const hash = await sha256(new TextEncoder().encode('abc'));
    expect(Buffer.from(hash).toString('hex')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('makes message ids that are 32 hex characters and never repeat', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newMessageId()));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{32}$/);
  });
});
