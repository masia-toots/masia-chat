import { sha512 } from '@noble/hashes/sha2.js';

/**
 * A bench-only stand-in for the two WebCrypto algorithms some WebKit builds lack: Ed25519 and
 * X25519 (Safari 17 and later has both; the WebKit that Playwright ships for Windows has neither).
 * It is installed ONLY when the browser's own `crypto.subtle` refuses them (or when forced with
 * `?curves=js`, to cross-check it), and everything else (SHA-256, HMAC, HKDF, AES-GCM) stays on the
 * browser's native WebCrypto.
 *
 * What it is for: the engine's logic, its JavaScript semantics in JavaScriptCore, the CSP and the
 * Worker questions do not depend on who computes a curve operation. What it is NOT: a measurement of
 * native curve speed. It is plain BigInt arithmetic, not constant time, and slow, so the bench counts
 * the operations and the time spent inside it, and reports the remainder separately. It is not
 * production code and is never imported by the package itself.
 */

// --- Field and group constants ------------------------------------------------------------------

const P = (1n << 255n) - 19n;
const L = (1n << 252n) + 27742317777372353535851937790883648493n;
const MASK_255 = (1n << 255n) - 1n;
const A24 = 121665n;
const BASE_U = 9n;
const KEY_BYTES = 32;
const SIGNATURE_BYTES = 64;

/** PKCS#8 prefixes (RFC 8410): the 16 bytes before the 32-byte key. */
const PKCS8_ED25519 = Uint8Array.of(0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20);
const PKCS8_X25519 = Uint8Array.of(0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20);

const mod = (a: bigint): bigint => {
  const r = a % P;
  return r >= 0n ? r : r + P;
};

function pow(base: bigint, exponent: bigint): bigint {
  let result = 1n;
  let b = mod(base);
  let e = exponent;
  while (e > 0n) {
    if ((e & 1n) === 1n) result = (result * b) % P;
    b = (b * b) % P;
    e >>= 1n;
  }
  return result;
}

const inv = (a: bigint): bigint => pow(a, P - 2n);

const D = mod(-121665n * inv(121666n));
const D2 = mod(2n * D);
const SQRT_M1 = pow(2n, (P - 1n) / 4n);

function bytesToInt(bytes: Uint8Array): bigint {
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i -= 1) n = (n << 8n) | BigInt(bytes[i] ?? 0);
  return n;
}

function intToBytes(value: bigint, length: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(length));
  let n = value;
  for (let i = 0; i < length; i += 1) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

// --- Ed25519 (RFC 8032), extended coordinates -------------------------------------------------------

interface Point {
  readonly x: bigint;
  readonly y: bigint;
  readonly z: bigint;
  readonly t: bigint;
}

const IDENTITY: Point = { x: 0n, y: 1n, z: 1n, t: 0n };

function pointAdd(p: Point, q: Point): Point {
  const a = mod((p.y - p.x) * (q.y - q.x));
  const b = mod((p.y + p.x) * (q.y + q.x));
  const c = mod(p.t * D2 * q.t);
  const d = mod(2n * p.z * q.z);
  const e = b - a;
  const f = d - c;
  const g = d + c;
  const h = b + a;
  return { x: mod(e * f), y: mod(g * h), z: mod(f * g), t: mod(e * h) };
}

function pointDouble(p: Point): Point {
  const a = mod(p.x * p.x);
  const b = mod(p.y * p.y);
  const c = mod(2n * p.z * p.z);
  const d = -a;
  const e = mod((p.x + p.y) * (p.x + p.y)) - a - b;
  const g = d + b;
  const f = g - c;
  const h = d - b;
  return { x: mod(e * f), y: mod(g * h), z: mod(f * g), t: mod(e * h) };
}

function scalarMul(point: Point, scalar: bigint): Point {
  let result = IDENTITY;
  let addend = point;
  let k = scalar;
  while (k > 0n) {
    if ((k & 1n) === 1n) result = pointAdd(result, addend);
    addend = pointDouble(addend);
    k >>= 1n;
  }
  return result;
}

function pointNegate(p: Point): Point {
  return { x: mod(-p.x), y: p.y, z: p.z, t: mod(-p.t) };
}

function encodePoint(p: Point): Uint8Array<ArrayBuffer> {
  const zi = inv(p.z);
  const x = mod(p.x * zi);
  const y = mod(p.y * zi);
  return intToBytes(y | ((x & 1n) << 255n), KEY_BYTES);
}

function decodePoint(bytes: Uint8Array): Point | undefined {
  if (bytes.length !== KEY_BYTES) return undefined;
  const raw = bytesToInt(bytes);
  const sign = raw >> 255n;
  const y = raw & MASK_255;
  if (y >= P) return undefined;
  const y2 = mod(y * y);
  const x2 = mod((y2 - 1n) * inv(mod(D * y2 + 1n)));
  let x = pow(x2, (P + 3n) / 8n);
  if (mod(x * x - x2) !== 0n) x = mod(x * SQRT_M1);
  if (mod(x * x - x2) !== 0n) return undefined;
  if (x === 0n && sign === 1n) return undefined;
  if ((x & 1n) !== sign) x = P - x;
  return { x, y, z: 1n, t: mod(x * y) };
}

const BASE_POINT: Point = (() => {
  const by = mod(4n * inv(5n));
  const encoded = intToBytes(by, KEY_BYTES); // the sign bit of Bx is 0
  const point = decodePoint(encoded);
  if (point === undefined) throw new Error('curves: the base point does not decode');
  return point;
})();

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(parts.reduce((n, part) => n + part.length, 0)));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function expandSeed(seed: Uint8Array): { scalar: bigint; prefix: Uint8Array } {
  const h = sha512(seed);
  const a = h.slice(0, KEY_BYTES);
  a[0] = (a[0] ?? 0) & 248;
  a[31] = ((a[31] ?? 0) & 127) | 64;
  return { scalar: bytesToInt(a), prefix: h.slice(KEY_BYTES) };
}

export function ed25519PublicKey(seed: Uint8Array): Uint8Array<ArrayBuffer> {
  return encodePoint(scalarMul(BASE_POINT, expandSeed(seed).scalar));
}

export function ed25519Sign(seed: Uint8Array, publicKey: Uint8Array, message: Uint8Array): Uint8Array<ArrayBuffer> {
  const { scalar, prefix } = expandSeed(seed);
  const r = bytesToInt(sha512(concat(prefix, message))) % L;
  const rBytes = encodePoint(scalarMul(BASE_POINT, r));
  const k = bytesToInt(sha512(concat(rBytes, publicKey, message))) % L;
  const s = (r + k * scalar) % L;
  return concat(rBytes, intToBytes(s, KEY_BYTES));
}

export function ed25519Verify(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  if (signature.length !== SIGNATURE_BYTES) return false;
  const a = decodePoint(publicKey);
  if (a === undefined) return false;
  const rBytes = signature.slice(0, KEY_BYTES);
  const s = bytesToInt(signature.slice(KEY_BYTES));
  if (s >= L) return false;
  const k = bytesToInt(sha512(concat(rBytes, publicKey, message))) % L;
  const check = pointAdd(scalarMul(BASE_POINT, s), pointNegate(scalarMul(a, k)));
  const got = encodePoint(check);
  return got.length === rBytes.length && got.every((byte, i) => byte === rBytes[i]);
}

// --- X25519 (RFC 7748), Montgomery ladder ------------------------------------------------------------

export function x25519(scalarBytes: Uint8Array, uBytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const k = scalarBytes.slice();
  k[0] = (k[0] ?? 0) & 248;
  k[31] = ((k[31] ?? 0) & 127) | 64;
  const scalar = bytesToInt(k);
  const x1 = mod(bytesToInt(uBytes) & MASK_255);
  let x2 = 1n;
  let z2 = 0n;
  let x3 = x1;
  let z3 = 1n;
  let swap = 0n;
  for (let t = 254n; t >= 0n; t -= 1n) {
    const bit = (scalar >> t) & 1n;
    swap ^= bit;
    if (swap === 1n) {
      [x2, x3] = [x3, x2];
      [z2, z3] = [z3, z2];
    }
    swap = bit;
    const a = x2 + z2;
    const aa = mod(a * a);
    const b = x2 - z2;
    const bb = mod(b * b);
    const e = aa - bb;
    const c = x3 + z3;
    const d = x3 - z3;
    const da = mod(d * a);
    const cb = mod(c * b);
    const sum = da + cb;
    const diff = da - cb;
    x3 = mod(sum * sum);
    z3 = mod(x1 * mod(diff * diff));
    x2 = mod(aa * bb);
    z2 = mod(e * (aa + A24 * e));
  }
  if (swap === 1n) {
    [x2, x3] = [x3, x2];
    [z2, z3] = [z3, z2];
  }
  return intToBytes(mod(x2 * inv(z2)), KEY_BYTES);
}

export function x25519PublicKey(secret: Uint8Array): Uint8Array<ArrayBuffer> {
  return x25519(secret, intToBytes(BASE_U, KEY_BYTES));
}

// --- The WebCrypto surface ------------------------------------------------------------------------------

type CurveName = 'Ed25519' | 'X25519';

/** What the bench reports: how often, and for how long, the stand-in ran. */
export interface CurveStats {
  ops: number;
  busyMs: number;
}

export const curveStats: CurveStats = { ops: 0, busyMs: 0 };

function counted<T>(body: () => T): T {
  const started = performance.now();
  try {
    return body();
  } finally {
    curveStats.ops += 1;
    curveStats.busyMs += performance.now() - started;
  }
}

class CurveKey {
  readonly [Symbol.toStringTag] = 'CryptoKey';
  readonly algorithm: { name: CurveName };
  readonly usages: string[];
  private publicCache: Uint8Array<ArrayBuffer> | undefined;

  constructor(
    readonly curve: CurveName,
    readonly type: 'public' | 'private',
    readonly extractable: boolean,
    usages: readonly string[],
    /** The 32-byte public key, or the 32-byte secret (seed). */
    readonly material: Uint8Array<ArrayBuffer>,
    publicKey?: Uint8Array<ArrayBuffer>,
  ) {
    this.algorithm = { name: curve };
    this.usages = [...usages];
    this.publicCache = publicKey;
  }

  /** The raw public key (computed once for a private key). */
  publicBytes(): Uint8Array<ArrayBuffer> {
    if (this.type === 'public') return this.material;
    this.publicCache ??= counted(() => (this.curve === 'Ed25519' ? ed25519PublicKey(this.material) : x25519PublicKey(this.material)));
    return this.publicCache;
  }
}

const fail = (message: string, name: string): never => {
  throw new DOMException(message, name);
};

function curveOf(algorithm: unknown): CurveName | undefined {
  const name = typeof algorithm === 'string' ? algorithm : (algorithm as { name?: unknown } | null)?.name;
  if (typeof name !== 'string') return undefined;
  const lower = name.toLowerCase();
  return lower === 'ed25519' ? 'Ed25519' : lower === 'x25519' ? 'X25519' : undefined;
}

function toBytes(data: unknown): Uint8Array<ArrayBuffer> {
  if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
  return fail('The data is not a BufferSource', 'TypeError');
}

const b64u = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');

function fromB64u(text: string): Uint8Array<ArrayBuffer> {
  const padded = text.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(text.length / 4) * 4, '=');
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

const startsWith = (bytes: Uint8Array, prefix: Uint8Array): boolean => bytes.length === prefix.length + KEY_BYTES && prefix.every((b, i) => bytes[i] === b);

function randomSecret(): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(new ArrayBuffer(KEY_BYTES)));
}

function usageSet(curve: CurveName, usages: readonly string[], isPrivate: boolean): string[] {
  const allowed = curve === 'Ed25519' ? (isPrivate ? ['sign'] : ['verify']) : isPrivate ? ['deriveKey', 'deriveBits'] : [];
  const bad = usages.filter((u) => !allowed.includes(u));
  if (bad.length > 0) fail(`Unsupported key usage for ${curve}: ${bad.join(',')}`, 'SyntaxError');
  return [...usages];
}

function generateKey(curve: CurveName, extractable: boolean, usages: readonly string[]): { publicKey: CurveKey; privateKey: CurveKey } {
  const secret = randomSecret();
  const publicBytes = counted(() => (curve === 'Ed25519' ? ed25519PublicKey(secret) : x25519PublicKey(secret)));
  const privateUsages = usages.filter((u) => (curve === 'Ed25519' ? u === 'sign' : u === 'deriveKey' || u === 'deriveBits'));
  const publicUsages = usages.filter((u) => u === 'verify');
  return {
    publicKey: new CurveKey(curve, 'public', true, publicUsages, publicBytes),
    privateKey: new CurveKey(curve, 'private', extractable, privateUsages, secret, publicBytes),
  };
}

function importKey(format: string, keyData: unknown, curve: CurveName, extractable: boolean, usages: readonly string[]): CurveKey {
  if (format === 'raw') {
    const raw = toBytes(keyData);
    if (raw.length !== KEY_BYTES) fail('Invalid raw key length', 'DataError');
    return new CurveKey(curve, 'public', extractable, usageSet(curve, usages, false), raw);
  }
  if (format === 'pkcs8') {
    const bytes = toBytes(keyData);
    if (!startsWith(bytes, curve === 'Ed25519' ? PKCS8_ED25519 : PKCS8_X25519)) fail('Invalid PKCS#8 key', 'DataError');
    return new CurveKey(curve, 'private', extractable, usageSet(curve, usages, true), bytes.slice(PKCS8_ED25519.length));
  }
  if (format === 'jwk') {
    const jwk = keyData as { kty?: string; crv?: string; x?: string; d?: string } | null;
    if (jwk === null || typeof jwk !== 'object' || jwk.kty !== 'OKP' || jwk.crv !== curve) fail('Invalid JWK', 'DataError');
    const jwkChecked = jwk as { x?: string; d?: string };
    if (jwkChecked.d !== undefined) {
      const secret = fromB64u(jwkChecked.d);
      if (secret.length !== KEY_BYTES) fail('Invalid JWK private key', 'DataError');
      const publicKey = jwkChecked.x === undefined ? undefined : fromB64u(jwkChecked.x);
      return new CurveKey(curve, 'private', extractable, usageSet(curve, usages, true), secret, publicKey);
    }
    if (jwkChecked.x === undefined) fail('Invalid JWK: no x', 'DataError');
    const raw = fromB64u(jwkChecked.x as string);
    if (raw.length !== KEY_BYTES) fail('Invalid JWK public key', 'DataError');
    return new CurveKey(curve, 'public', extractable, usageSet(curve, usages, false), raw);
  }
  return fail(`Unsupported key format: ${format}`, 'NotSupportedError');
}

function exportKey(format: string, key: CurveKey): ArrayBuffer | JsonWebKey {
  if (!key.extractable) fail('The key is not extractable', 'InvalidAccessError');
  if (format === 'raw') {
    if (key.type !== 'public') fail('Only a public key can be exported raw', 'InvalidAccessError');
    return key.material.slice().buffer;
  }
  if (format === 'pkcs8') {
    if (key.type !== 'private') fail('Only a private key can be exported as PKCS#8', 'InvalidAccessError');
    return concat(key.curve === 'Ed25519' ? PKCS8_ED25519 : PKCS8_X25519, key.material).buffer;
  }
  if (format === 'jwk') {
    const jwk: JsonWebKey = { kty: 'OKP', crv: key.curve, x: b64u(key.publicBytes()), ext: true, key_ops: [...key.usages] };
    if (key.type === 'private') jwk.d = b64u(key.material);
    return jwk;
  }
  return fail(`Unsupported key format: ${format}`, 'NotSupportedError');
}

function deriveBits(algorithm: { public?: unknown }, key: CurveKey, length: number | null): ArrayBuffer {
  const peer = algorithm.public;
  if (!(peer instanceof CurveKey) || peer.curve !== 'X25519' || peer.type !== 'public') fail('Invalid peer public key', 'InvalidAccessError');
  if (key.curve !== 'X25519' || key.type !== 'private') fail('Invalid private key', 'InvalidAccessError');
  const shared = counted(() => x25519(key.material, (peer as CurveKey).material));
  if (shared.every((b) => b === 0)) fail('The shared secret is all zero', 'OperationError');
  const bits = length === null ? KEY_BYTES * 8 : length;
  return shared.slice(0, Math.floor(bits / 8)).buffer;
}

const wrapped = {
  async generateKey(algorithm: unknown, extractable: boolean, usages: readonly string[]) {
    const curve = curveOf(algorithm) as CurveName;
    return generateKey(curve, extractable, usages);
  },
  async importKey(format: string, keyData: unknown, algorithm: unknown, extractable: boolean, usages: readonly string[]) {
    return importKey(format, keyData, curveOf(algorithm) as CurveName, extractable, usages);
  },
  async sign(_algorithm: unknown, key: CurveKey, data: unknown) {
    if (key.curve !== 'Ed25519' || key.type !== 'private') fail('Invalid signing key', 'InvalidAccessError');
    return counted(() => ed25519Sign(key.material, key.publicBytes(), toBytes(data))).buffer;
  },
  async verify(_algorithm: unknown, key: CurveKey, signature: unknown, data: unknown) {
    if (key.curve !== 'Ed25519' || key.type !== 'public') fail('Invalid verification key', 'InvalidAccessError');
    return counted(() => ed25519Verify(key.material, toBytes(data), toBytes(signature)));
  },
  async deriveBits(algorithm: { public?: unknown }, key: CurveKey, length: number | null) {
    return deriveBits(algorithm, key, length);
  },
  async exportKey(format: string, key: CurveKey) {
    return exportKey(format, key);
  },
};

const isCurveKey = (value: unknown): value is CurveKey => value instanceof CurveKey;

/** How many WebCrypto calls the engine made (every call that went through `crypto.subtle`, stand-in or native). */
export interface SubtleStats {
  calls: number;
  byMethod: Record<string, number>;
}

export const subtleStats: SubtleStats = { calls: 0, byMethod: {} };

type AnyFn = (...args: unknown[]) => unknown;

/**
 * `crypto.subtle` as the engine sees it. Every call is counted (a WebCrypto call is an asynchronous
 * round trip in every engine, so their number per operation is what an iPhone's per-call latency is
 * multiplied by). With `standIn`, Ed25519 and X25519 are answered by this module; everything else is
 * the browser's own, called with the right `this`.
 */
function wrapSubtle(native: SubtleCrypto, standIn: boolean): SubtleCrypto {
  const cache = new Map<string | symbol, unknown>();
  const route = (name: string, native_: AnyFn, own: AnyFn | undefined, takes: (args: unknown[]) => boolean): AnyFn =>
    (...args) => {
      subtleStats.calls += 1;
      subtleStats.byMethod[name] = (subtleStats.byMethod[name] ?? 0) + 1;
      return standIn && own !== undefined && takes(args) ? own(...args) : native_(...args);
    };
  const algorithmIs = (index: number) => (args: unknown[]) => curveOf(args[index]) !== undefined;
  const keyIs = (index: number) => (args: unknown[]) => isCurveKey(args[index]);
  return new Proxy(native, {
    get(target, property) {
      const cached = cache.get(property);
      if (cached !== undefined) return cached;
      const original: unknown = Reflect.get(target, property, target);
      if (typeof original !== 'function' || typeof property !== 'string') return original;
      const bound = (original as AnyFn).bind(target);
      let made: AnyFn;
      switch (property) {
        case 'generateKey':
          made = route(property, bound, wrapped.generateKey as AnyFn, algorithmIs(0));
          break;
        case 'importKey':
          made = route(property, bound, wrapped.importKey as AnyFn, algorithmIs(2));
          break;
        case 'exportKey':
          made = route(property, bound, wrapped.exportKey as AnyFn, keyIs(1));
          break;
        case 'sign':
          made = route(property, bound, wrapped.sign as AnyFn, keyIs(1));
          break;
        case 'verify':
          made = route(property, bound, wrapped.verify as AnyFn, keyIs(1));
          break;
        case 'deriveBits':
          made = route(property, bound, wrapped.deriveBits as AnyFn, keyIs(1));
          break;
        default:
          made = route(property, bound, undefined, () => false);
      }
      cache.set(property, made);
      return made;
    },
  });
}

// --- Installation and self-test --------------------------------------------------------------------------------

/** `?curves=js` on the page (and on the Worker script) installs the stand-in even where the browser has the curves. */
export const CURVES_QUERY = 'curves';
export const CURVES_FORCED = 'js';

export interface CurveMode {
  /** `native`: the browser has both; `polyfill`: this module answers them. */
  readonly mode: 'native' | 'polyfill';
  readonly reason: string;
  readonly nativeEd25519: boolean;
  readonly nativeX25519: boolean;
  /** Known-answer tests (RFC 8032, RFC 7748) and, when the browser has the curves, a cross-check against them. */
  readonly selfTest: readonly { readonly name: string; readonly ok: boolean; readonly detail?: string }[];
}

const hex = (bytes: Uint8Array): string => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
const unhex = (text: string): Uint8Array<ArrayBuffer> => Uint8Array.from(text.match(/../g) ?? [], (h) => Number.parseInt(h, 16));

async function nativeSupports(subtle: SubtleCrypto, curve: CurveName): Promise<boolean> {
  try {
    if (curve === 'Ed25519') await subtle.generateKey('Ed25519', true, ['sign', 'verify']);
    else await subtle.generateKey('X25519', true, ['deriveBits']);
    return true;
  } catch {
    return false;
  }
}

async function selfTest(native: SubtleCrypto, hasNative: boolean): Promise<CurveMode['selfTest']> {
  const results: { name: string; ok: boolean; detail?: string }[] = [];
  const check = (name: string, ok: boolean, detail?: string) => results.push({ name, ok, ...(detail === undefined ? {} : { detail }) });
  const guard = async (name: string, body: () => Promise<boolean | undefined> | boolean | undefined) => {
    try {
      const ok = await body();
      check(name, ok !== false);
    } catch (error) {
      check(name, false, error instanceof Error ? error.message : String(error));
    }
  };

  // RFC 8032 section 7.1, test 1 (empty message) and test 2 (one byte).
  await guard('Ed25519 RFC 8032 test 1 (public key + signature)', () => {
    const seed = unhex('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60');
    const pub = ed25519PublicKey(seed);
    const sig = ed25519Sign(seed, pub, new Uint8Array(0));
    return (
      hex(pub) === 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a' &&
      hex(sig) === 'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b' &&
      ed25519Verify(pub, new Uint8Array(0), sig)
    );
  });
  await guard('Ed25519 RFC 8032 test 2 (signature) and a flipped bit is refused', () => {
    const seed = unhex('4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb');
    const pub = ed25519PublicKey(seed);
    const message = unhex('72');
    const sig = ed25519Sign(seed, pub, message);
    const bad = sig.slice();
    bad[0] = (bad[0] ?? 0) ^ 1;
    return hex(sig) === '92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00' && !ed25519Verify(pub, message, bad);
  });
  // RFC 7748 section 6.1: Alice and Bob.
  await guard('X25519 RFC 7748 section 6.1 (public keys and shared secret)', () => {
    const alice = unhex('77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a');
    const bob = unhex('5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb');
    const alicePub = x25519PublicKey(alice);
    const bobPub = x25519PublicKey(bob);
    const shared = x25519(alice, bobPub);
    return (
      hex(alicePub) === '8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a' &&
      hex(bobPub) === 'de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f' &&
      hex(shared) === '4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742' &&
      hex(x25519(bob, alicePub)) === hex(shared)
    );
  });
  if (hasNative) {
    // The browser's own curves against this module, on fresh random keys.
    await guard('cross-check against the browser: Ed25519 signatures verify both ways', async () => {
      const pair = (await native.generateKey('Ed25519', true, ['sign', 'verify'])) as CryptoKeyPair;
      const seed = new Uint8Array((await native.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer).slice(PKCS8_ED25519.length);
      const pub = new Uint8Array((await native.exportKey('raw', pair.publicKey)) as ArrayBuffer);
      const message = unhex('00010203040506070809');
      const mine = ed25519Sign(seed, ed25519PublicKey(seed), message);
      const theirs = new Uint8Array(await native.sign('Ed25519', pair.privateKey, message));
      return (
        hex(ed25519PublicKey(seed)) === hex(pub) &&
        hex(mine) === hex(theirs) &&
        (await native.verify('Ed25519', pair.publicKey, mine, message)) &&
        ed25519Verify(pub, message, theirs)
      );
    });
    await guard('cross-check against the browser: X25519 shared secrets agree', async () => {
      const a = (await native.generateKey('X25519', true, ['deriveBits'])) as CryptoKeyPair;
      const b = (await native.generateKey('X25519', true, ['deriveBits'])) as CryptoKeyPair;
      const aSecret = new Uint8Array((await native.exportKey('pkcs8', a.privateKey)) as ArrayBuffer).slice(PKCS8_X25519.length);
      const bPublic = new Uint8Array((await native.exportKey('raw', b.publicKey)) as ArrayBuffer);
      const theirs = new Uint8Array(await native.deriveBits({ name: 'X25519', public: b.publicKey }, a.privateKey, 256));
      return hex(x25519(aSecret, bPublic)) === hex(theirs);
    });
  }
  return results;
}

/**
 * Decide, once per realm (page or Worker), whether `crypto.subtle` needs the stand-in, and install it
 * when it does. `force` installs it even when the browser has both curves (used to cross-check it).
 */
export async function ensureCurves(force = false): Promise<CurveMode> {
  const native = globalThis.crypto?.subtle;
  if (native === undefined) {
    return { mode: 'native', reason: 'crypto.subtle is undefined here: nothing to wrap', nativeEd25519: false, nativeX25519: false, selfTest: [] };
  }
  const nativeEd25519 = await nativeSupports(native, 'Ed25519');
  const nativeX25519 = await nativeSupports(native, 'X25519');
  const selfTestResults = await selfTest(native, nativeEd25519 && nativeX25519);
  const standIn = force || !(nativeEd25519 && nativeX25519);
  // The counting wrapper goes in either way; the stand-in answers the curves only when it is needed.
  try {
    const proxy = wrapSubtle(native, standIn);
    Object.defineProperty(globalThis.crypto, 'subtle', { configurable: true, value: proxy });
    if (globalThis.crypto.subtle !== proxy) throw new Error('curves: crypto.subtle could not be replaced');
  } catch (error) {
    if (standIn) throw error;
  }
  if (!standIn) {
    return { mode: 'native', reason: 'the browser has Ed25519 and X25519', nativeEd25519, nativeX25519, selfTest: selfTestResults };
  }
  const reason = force ? 'forced with ?curves=js' : `the browser lacks ${[nativeEd25519 ? '' : 'Ed25519', nativeX25519 ? '' : 'X25519'].filter(Boolean).join(' and ')}`;
  return { mode: 'polyfill', reason, nativeEd25519, nativeX25519, selfTest: selfTestResults };
}
