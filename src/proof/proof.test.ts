// SPDX-License-Identifier: Apache-2.0
// The endpoint proof: WebCrypto's Ed25519 from a seed against RFC 8032 §7.1's
// vectors; proofs checked by two verifiers that share nothing with the signer (RFC 8032 §6's reference verify,
// written out here with BigInt, and Node's OpenSSL); the guard's refusals; and the challenge's checks.
import assert from 'node:assert/strict';
import { createHash, createPublicKey, verify as nodeVerify } from 'node:crypto';
import { describe, it } from 'node:test';
import { pkcs8OfSeed, publicKeyOfSeed, signWithSeed } from './ed25519.ts';
import * as api from './index.ts';
import {
  CHALLENGE_LIFETIME_S,
  checkChallenge,
  endpointIdOf,
  endpointProofMessage,
  MAX_CLOCK_SKEW_S,
  newSeed,
  PROOF_DOMAIN,
  PROOF_MESSAGE_BYTES,
  ProofRefusal,
  proveEndpoint,
  SERVICE_CLOCK_MARGIN_S,
  serviceSeconds,
  signEndpointProof,
  toHex,
} from './proof.ts';
import { isPrinterError } from '../errors/kinds.ts';

const hex = (text: string) => Uint8Array.from(Buffer.from(text, 'hex'));

/** RFC 8032 §7.1: TEST 1, 2, 3 and SHA(abc). */
const RFC8032 = [
  {
    name: 'TEST 1',
    secret: '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60',
    public: 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
    message: '',
    signature: 'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b',
  },
  {
    name: 'TEST 2',
    secret: '4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb',
    public: '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c',
    message: '72',
    signature: '92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00',
  },
  {
    name: 'TEST 3',
    secret: 'c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7',
    public: 'fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025',
    message: 'af82',
    signature: '6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a',
  },
  {
    name: 'TEST SHA(abc)',
    secret: '833fe62409237b9d62ec77587520911e9a759cec1d19755b7da901b96dca3d42',
    public: 'ec172b93ad5e563bf4932c70e1245034c35467ef2efd4d64ebf819683467e2bf',
    message: 'ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f',
    signature: 'dc2a4459e7369633a52b1bf277839a00201009a3efbf3ecb69bea2186c26b58909351fc9ac90b3ecfdfbc7c66431e0303dca179c138ac17ad9bef1177331a704',
  },
];

// ---- RFC 8032 §6's reference implementation (verify and the public key), with BigInt ----------------------------
const P = 2n ** 255n - 19n;
const Q = 2n ** 252n + 27742317777372353535851937790883648493n;
const mod = (a: bigint, m = P) => ((a % m) + m) % m;
function powMod(base: bigint, exp: bigint, m = P): bigint {
  let result = 1n;
  let b = mod(base, m);
  for (let e = exp; e > 0n; e >>= 1n) {
    if (e & 1n) result = (result * b) % m;
    b = (b * b) % m;
  }
  return result;
}
const inv = (x: bigint) => powMod(x, P - 2n);
const D = mod(-121665n * inv(121666n));
const SQRT_M1 = powMod(2n, (P - 1n) / 4n);
type Point = [bigint, bigint, bigint, bigint];
function add(p: Point, q: Point): Point {
  const a = mod((p[1] - p[0]) * (q[1] - q[0]));
  const b = mod((p[1] + p[0]) * (q[1] + q[0]));
  const c = mod(2n * p[3] * q[3] * D);
  const d = mod(2n * p[2] * q[2]);
  const [e, f, g, h] = [b - a, d - c, d + c, b + a];
  return [mod(e * f), mod(g * h), mod(f * g), mod(e * h)];
}
function mul(s: bigint, point: Point): Point {
  let q: Point = [0n, 1n, 1n, 0n];
  let p = point;
  for (let k = s; k > 0n; k >>= 1n) {
    if (k & 1n) q = add(q, p);
    p = add(p, p);
  }
  return q;
}
const equal = (p: Point, q: Point) => mod(p[0] * q[2] - q[0] * p[2]) === 0n && mod(p[1] * q[2] - q[1] * p[2]) === 0n;
function recoverX(y: bigint, sign: bigint): bigint | null {
  if (y >= P) return null;
  const x2 = mod((y * y - 1n) * inv(D * y * y + 1n));
  if (x2 === 0n) return sign ? null : 0n;
  let x = powMod(x2, (P + 3n) / 8n);
  if (mod(x * x - x2) !== 0n) x = mod(x * SQRT_M1);
  if (mod(x * x - x2) !== 0n) return null;
  if ((x & 1n) !== sign) x = P - x;
  return x;
}
const GY = mod(4n * inv(5n));
const GX = recoverX(GY, 0n) as bigint;
const G: Point = [GX, GY, 1n, mod(GX * GY)];
const le = (bytes: Uint8Array) => bytes.reduceRight((acc, b) => (acc << 8n) | BigInt(b), 0n);
function compress(p: Point): Uint8Array {
  const zi = inv(p[2]);
  const x = mod(p[0] * zi);
  let y = mod(p[1] * zi) | ((x & 1n) << 255n);
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++, y >>= 8n) out[i] = Number(y & 0xffn);
  return out;
}
function decompress(bytes: Uint8Array): Point | null {
  let y = le(bytes);
  const sign = y >> 255n;
  y &= (1n << 255n) - 1n;
  const x = recoverX(y, sign);
  return x === null ? null : [x, y, 1n, mod(x * y)];
}
const sha512 = (...parts: Uint8Array[]) => Uint8Array.from(createHash('sha512').update(Buffer.concat(parts)).digest());
function referencePublicKey(secret: Uint8Array): Uint8Array {
  const h = sha512(secret);
  let a = le(h.subarray(0, 32));
  a &= (1n << 254n) - 8n;
  a |= 1n << 254n;
  return compress(mul(a, G));
}
function referenceVerify(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  if (publicKey.length !== 32 || signature.length !== 64) return false;
  const A = decompress(publicKey);
  const R = decompress(signature.subarray(0, 32));
  if (!A || !R) return false;
  const s = le(signature.subarray(32));
  if (s >= Q) return false;
  const h = le(sha512(signature.subarray(0, 32), publicKey, message)) % Q;
  return equal(mul(s, G), add(R, mul(h, A)));
}
/** Node's OpenSSL verifier, given the raw public key. */
function opensslVerify(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(publicKey).toString('base64url') }, format: 'jwk' });
  return nodeVerify(null, message, key, signature);
}
// -------------------------------------------------------------------------------------------------------------------

const SEED = hex(RFC8032[0].secret);
const ENDPOINT_ID = RFC8032[0].public;
const NONCE = 'a5'.repeat(32);
const NOW = 1_800_000_000;
const challenge = (fields: Record<string, unknown> = {}) => ({ nonce: NONCE, expires_at: NOW + CHALLENGE_LIFETIME_S, domain: PROOF_DOMAIN, ...fields });

describe('Ed25519 from a seed with WebCrypto (RFC 8032 §7.1)', () => {
  for (const v of RFC8032) {
    it(`${v.name}: the public key and the signature`, async () => {
      assert.equal(toHex(await publicKeyOfSeed(hex(v.secret))), v.public);
      assert.equal(toHex(await signWithSeed(hex(v.secret), hex(v.message))), v.signature);
      // The reference implementation agrees on the vector itself.
      assert.equal(toHex(referencePublicKey(hex(v.secret))), v.public);
      assert.ok(referenceVerify(hex(v.public), hex(v.message), hex(v.signature)));
    });
  }

  it('wraps the seed as PKCS#8 with the fixed RFC 8410 head, and refuses a seed of another length', () => {
    assert.equal(toHex(pkcs8OfSeed(SEED)), `302e020100300506032b657004220420${RFC8032[0].secret}`);
    for (const length of [0, 31, 33, 64]) assert.throws(() => pkcs8OfSeed(new Uint8Array(length)), /32 bytes/);
  });

  it('endpointIdOf is the public key in lowercase hex, with no endpoint bound', async () => {
    assert.equal(await endpointIdOf(SEED), ENDPOINT_ID);
    const seed = newSeed();
    assert.equal(seed.length, 32);
    assert.equal(await endpointIdOf(seed), toHex(referencePublicKey(seed)));
    assert.notDeepEqual(newSeed(), seed);
  });

  it('a browser without Ed25519 in WebCrypto fails as the PrinterError unsupported, not as a platform exception', async () => {
    const notSupported = new Proxy(crypto.subtle, {
      get(target, prop) {
        if (prop === 'importKey') return () => Promise.reject(new DOMException('Unrecognized name.', 'NotSupportedError'));
        const value = Reflect.get(target, prop) as unknown;
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    const unsupported = (err: unknown) => isPrinterError(err) && err.kind === 'unsupported' && /NotSupportedError/.test(err.detail ?? '');
    await assert.rejects(() => endpointIdOf(SEED, notSupported), unsupported);
    await assert.rejects(() => signEndpointProof(SEED, endpointProofMessage(NONCE, ENDPOINT_ID), notSupported), unsupported);
    await assert.rejects(() => proveEndpoint(SEED, challenge(), { nowS: NOW, subtle: notSupported }), unsupported);
    await assert.rejects(() => signWithSeed(SEED, new Uint8Array(1), notSupported), unsupported);
  });
});

describe('the proof message', () => {
  it('is the domain, a NUL byte, the nonce and the EndpointId, raw (97 bytes)', () => {
    const message = endpointProofMessage(NONCE, ENDPOINT_ID);
    assert.equal(PROOF_DOMAIN, 'muon3d-console endpoint proof v1');
    assert.equal(PROOF_MESSAGE_BYTES, 97);
    assert.equal(message.length, 97);
    assert.equal(Buffer.from(message.subarray(0, 33)).toString('latin1'), 'muon3d-console endpoint proof v1\0');
    assert.equal(toHex(message.subarray(33, 65)), NONCE);
    assert.equal(toHex(message.subarray(65)), ENDPOINT_ID);
    assert.deepEqual(endpointProofMessage(hex(NONCE), hex(ENDPOINT_ID)), message);
  });

  it('takes only 32 bytes, or 64 lowercase hex digits, for the nonce and the EndpointId', () => {
    for (const bad of ['', 'A5'.repeat(32), 'a5'.repeat(31), 'a5'.repeat(33), `${'a5'.repeat(31)}zz`]) {
      assert.throws(() => endpointProofMessage(bad, ENDPOINT_ID), ProofRefusal);
      assert.throws(() => endpointProofMessage(NONCE, bad), ProofRefusal);
    }
    assert.throws(() => endpointProofMessage(new Uint8Array(31), ENDPOINT_ID), ProofRefusal);
  });
});

describe('signEndpointProof (the guard)', () => {
  it('signs its own proof message; both reference verifiers accept the signature', async () => {
    const message = endpointProofMessage(NONCE, ENDPOINT_ID);
    const signature = await signEndpointProof(SEED, message);
    assert.equal(signature.length, 64);
    assert.ok(referenceVerify(hex(ENDPOINT_ID), message, signature));
    assert.ok(opensslVerify(hex(ENDPOINT_ID), message, signature));
    // A changed nonce, EndpointId or signature does not verify.
    const other = endpointProofMessage('5a'.repeat(32), ENDPOINT_ID);
    assert.equal(referenceVerify(hex(ENDPOINT_ID), other, signature), false);
    assert.equal(opensslVerify(hex(ENDPOINT_ID), other, signature), false);
    const flipped = Uint8Array.from(signature);
    flipped[5] ^= 1;
    assert.equal(referenceVerify(hex(ENDPOINT_ID), message, flipped), false);
  });

  it('refuses anything else before the key signs', async () => {
    const good = endpointProofMessage(NONCE, ENDPOINT_ID);
    const cases: [string, Uint8Array][] = [
      ['empty', new Uint8Array()],
      ["RFC 8032's message", hex(RFC8032[1].message)],
      ['one byte short', good.subarray(0, 96)],
      ['one byte long', Uint8Array.from([...good, 0])],
      ['another key', endpointProofMessage(NONCE, RFC8032[1].public)],
      ['another domain', Uint8Array.from(good, (b, i) => (i === 0 ? b ^ 0x20 : b))],
      ['no NUL after the domain', Uint8Array.from(good, (b, i) => (i === 32 ? 0x20 : b))],
      ['the domain as a prefix of a longer text', Uint8Array.from(Buffer.concat([Buffer.from(`${PROOF_DOMAIN}v2\0`), Buffer.alloc(94)]).subarray(0, 97))],
    ];
    for (const [what, message] of cases) {
      await assert.rejects(() => signEndpointProof(SEED, message), ProofRefusal, what);
    }
    await assert.rejects(() => signEndpointProof(SEED, 'not bytes' as unknown as Uint8Array), ProofRefusal);
  });
});

describe('checkChallenge', () => {
  it('takes the service answer: domain, nonce and an expiry 300 s ahead', () => {
    assert.deepEqual(checkChallenge(challenge(), NOW), { nonce: NONCE, expires_at: NOW + 300, domain: PROOF_DOMAIN });
    // A clock a little ahead or behind the service's.
    assert.ok('nonce' in checkChallenge(challenge(), NOW + CHALLENGE_LIFETIME_S + MAX_CLOCK_SKEW_S - 1));
    assert.ok('nonce' in checkChallenge(challenge(), NOW - MAX_CLOCK_SKEW_S));
  });

  it('refuses a wrong domain, a nonce that is not 32 bytes of lowercase hex, and a missing, passed or far expiry', () => {
    const bad: [string, unknown][] = [
      ['not an object', 'nonce'],
      ['an array', [NONCE]],
      ['no domain', challenge({ domain: undefined })],
      ['another domain', challenge({ domain: 'muon3d-console endpoint proof v2' })],
      ['uppercase nonce', challenge({ nonce: NONCE.toUpperCase() })],
      ['short nonce', challenge({ nonce: 'a5'.repeat(16) })],
      ['nonce as bytes', challenge({ nonce: [...hex(NONCE)] })],
      ['no expiry', challenge({ expires_at: undefined })],
      ['expiry as text', challenge({ expires_at: String(NOW + 300) })],
      ['fractional expiry', challenge({ expires_at: NOW + 300.5 })],
      ['expired', challenge({ expires_at: NOW - MAX_CLOCK_SKEW_S })],
      ['a day ahead', challenge({ expires_at: NOW + 86_400 })],
    ];
    for (const [what, answer] of bad) {
      const result = checkChallenge(answer, NOW);
      assert.ok(!('nonce' in result), what);
      assert.equal('kind' in result && result.kind, 'protocol', what);
    }
  });

  it("reads the expiry against the service's Date when given, so a clock 15 minutes off still proves its key", async () => {
    const date = new Date(NOW * 1000).toUTCString();
    assert.equal(serviceSeconds(date), NOW);
    assert.equal(serviceSeconds(NOW), NOW);
    assert.equal(serviceSeconds('not a date'), undefined);
    assert.equal(serviceSeconds(null), undefined);
    for (const off of [-900, 900]) {
      // This computer alone refuses the challenge…
      assert.ok(!('nonce' in checkChallenge(challenge(), NOW + off)), `local clock ${off} s off`);
      // …the service's Date answers it.
      assert.ok('nonce' in checkChallenge(challenge(), NOW + off, date), `local clock ${off} s off, with the Date`);
      const proof = await proveEndpoint(SEED, challenge(), { nowS: NOW + off, serviceDate: date });
      assert.ok('signature' in proof);
    }
    // Against the service's clock, an expiry that passed or lies too far ahead is still refused.
    assert.ok(!('nonce' in checkChallenge(challenge({ expires_at: NOW - SERVICE_CLOCK_MARGIN_S }), NOW + 900, date)));
    assert.ok(!('nonce' in checkChallenge(challenge({ expires_at: NOW + CHALLENGE_LIFETIME_S + SERVICE_CLOCK_MARGIN_S + 1 }), NOW, date)));
    assert.ok('nonce' in checkChallenge(challenge({ expires_at: NOW + CHALLENGE_LIFETIME_S + SERVICE_CLOCK_MARGIN_S }), NOW, date));
    // A Date that cannot be read falls back to this computer's clock.
    assert.ok('nonce' in checkChallenge(challenge(), NOW, 'garbage'));
  });
});

describe('proveEndpoint', () => {
  it("is PUT /v1/me/endpoint's body, signed over the challenge's nonce", async () => {
    const proof = await proveEndpoint(SEED, challenge(), { nowS: NOW });
    assert.ok('signature' in proof);
    assert.deepEqual(Object.keys(proof).sort(), ['endpoint_id', 'nonce', 'signature']);
    assert.equal(proof.endpoint_id, ENDPOINT_ID);
    assert.equal(proof.nonce, NONCE);
    assert.match(proof.signature, /^[0-9a-f]{128}$/);
    const message = endpointProofMessage(NONCE, ENDPOINT_ID);
    assert.ok(referenceVerify(hex(ENDPOINT_ID), message, hex(proof.signature)));
    assert.ok(opensslVerify(hex(ENDPOINT_ID), message, hex(proof.signature)));
  });

  it('signs nothing for a challenge that fails its checks', async () => {
    let signed = 0;
    const subtle = crypto.subtle;
    const counting = new Proxy(subtle, {
      get(target, prop) {
        if (prop === 'sign') signed++;
        const value = Reflect.get(target, prop) as unknown;
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    const result = await proveEndpoint(SEED, challenge({ domain: 'another' }), { nowS: NOW, subtle: counting });
    assert.equal('kind' in result && result.kind, 'protocol');
    assert.equal(signed, 0);
  });
});

describe('the package API', () => {
  it('exports the guarded signer and never the unguarded one', () => {
    assert.equal(typeof api.signEndpointProof, 'function');
    assert.equal(typeof api.proveEndpoint, 'function');
    assert.equal('signWithSeed' in api, false);
    assert.equal('publicKeyOfSeed' in api, false);
  });
});
