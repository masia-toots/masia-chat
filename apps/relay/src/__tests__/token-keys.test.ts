import { generateKeyPairSync } from 'node:crypto';
import { RELAY_TOKEN_KEY_ID_LENGTH } from '@masia/relay';
import { describe, expect, it } from 'vitest';
import { parseTokenKeyring, tokenKeyId, tokenKeyringOf } from '../token-keys.js';

const newKey = () => generateKeyPairSync('ed25519').publicKey;

describe('tokenKeyId', () => {
  it('is a fixed-length lowercase hex string derived from the key alone', () => {
    const key = newKey();
    expect(tokenKeyId(key)).toMatch(new RegExp(`^[0-9a-f]{${RELAY_TOKEN_KEY_ID_LENGTH}}$`));
    expect(tokenKeyId(key)).toBe(tokenKeyId(key));
  });

  it('tells two keys apart', () => {
    expect(tokenKeyId(newKey())).not.toBe(tokenKeyId(newKey()));
  });

  it('is pinned to a known key: the first 16 hex characters of the SHA-256 of its SPKI DER', () => {
    // If this changes, every token in flight changes its `kid`. The host derives the id the same way
    // (its contract test checks both sides against this value).
    const spki = 'MCowBQYDK2VwAyEAnMSzt1qHvQU23VzU8bhM12r10KlXVlcCAaaA6qBwZkk=';
    expect(parseTokenKeyring(spki).kids).toEqual(['05b06347631cec7a']);
  });
});

describe('tokenKeyringOf', () => {
  it('finds a key by its id and nothing else', () => {
    const first = newKey();
    const second = newKey();
    const keyring = tokenKeyringOf([first, second]);
    expect(keyring.kids).toEqual([tokenKeyId(first), tokenKeyId(second)]);
    expect(keyring.keyFor(tokenKeyId(first))?.equals(first)).toBe(true);
    expect(keyring.keyFor(tokenKeyId(second))?.equals(second)).toBe(true);
    expect(keyring.keyFor('ffffffffffffffff')).toBeUndefined();
    expect(keyring.keyFor(undefined)).toBeUndefined();
  });

  it('refuses an empty list, a repeat, a private key and a key of another algorithm', () => {
    const key = newKey();
    expect(() => tokenKeyringOf([])).toThrow('at least one');
    expect(() => tokenKeyringOf([key, key])).toThrow('twice');
    expect(() => tokenKeyringOf([generateKeyPairSync('ed25519').privateKey])).toThrow('Ed25519 public key');
    expect(() => tokenKeyringOf([generateKeyPairSync('x25519').publicKey])).toThrow('Ed25519 public key');
  });
});

describe('parseTokenKeyring', () => {
  const base64Of = (key: ReturnType<typeof newKey>) => key.export({ type: 'spki', format: 'der' }).toString('base64');

  it('reads the base64 SPKI text of one key', () => {
    const key = newKey();
    expect(parseTokenKeyring(base64Of(key)).kids).toEqual([tokenKeyId(key)]);
  });

  it('reads a list, ignoring blanks and spaces', () => {
    const first = newKey();
    const second = newKey();
    expect(parseTokenKeyring(` ${base64Of(first)} ,, ${base64Of(second)},`).kids).toEqual([
      tokenKeyId(first),
      tokenKeyId(second),
    ]);
  });

  it.each([
    ['nothing', ''],
    ['only separators', ' , ,'],
    ['text that is not base64', 'not base64 at all!'],
    ['base64 that is not a key', 'AAAA'],
  ])('refuses %s', (_label, raw) => {
    expect(() => parseTokenKeyring(raw)).toThrow();
  });

  it('says which entry is bad without repeating it', () => {
    const good = base64Of(newKey());
    const bad = 'AAAAAAAAAAAAAAAA';
    expect(() => parseTokenKeyring(`${good},${bad}`)).toThrow('key 2 is not an SPKI public key');
    try {
      parseTokenKeyring(`${good},${bad}`);
    } catch (error) {
      expect(String(error)).not.toContain(bad);
    }
  });
});
