// SPDX-License-Identifier: Apache-2.0
// Ed25519 from a 32-byte seed with WebCrypto, which browsers and Node 22+ have (no dependency). WebCrypto does not
// import a raw private key, so the seed is wrapped as PKCS#8 (RFC 8410: a fixed 16-byte DER head, then the seed), and
// the public key is read from the key's JWK export (`x`, base64url). The muon-link endpoint's secret is such a seed and
// its EndpointId this public key, so the slicer learns its EndpointId without binding an endpoint. Only proof.ts
// signs with a seed, and only behind its guard: nothing here is exported from the package.
//
// A browser with no Ed25519 in WebCrypto (Chrome before 137, Firefox before 129, Safari before 17), or with no
// WebCrypto at all (a page on plain HTTP), cannot use the relay key: that is thrown as the PrinterError `unsupported`,
// never as the platform's own exception, so every caller reads it as it reads the package's other errors.
import { printerError, type PrinterError } from '../errors/kinds.ts';

/** The DER head of a PKCS#8 Ed25519 private key (RFC 8410 §7): SEQUENCE, version 0, the Ed25519 OID, the octet string. */
export const PKCS8_ED25519_HEAD = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);

export const SEED_BYTES = 32;
export const PUBLIC_KEY_BYTES = 32;
export const SIGNATURE_BYTES = 64;

const ED25519 = { name: 'Ed25519' } as const;

/** The failure of a browser that cannot use the relay key. */
export const unsupportedKey = (detail: string): PrinterError => printerError('unsupported', 'This browser cannot use the relay key (no Ed25519 in WebCrypto)', { detail });

/** The global WebCrypto, or `unsupported` where there is none (a page on plain HTTP has no `crypto.subtle`). */
export function webCrypto(): SubtleCrypto {
  const subtle = (globalThis as { crypto?: Crypto }).crypto?.subtle;
  if (!subtle) throw unsupportedKey('crypto.subtle needs a secure context');
  return subtle;
}

/** The seed's PKCS#8 bytes as a WebCrypto key; any failure to import them (NotSupportedError first) is `unsupported`. */
async function importSeed(subtle: SubtleCrypto, der: Uint8Array<ArrayBuffer>, extractable: boolean): Promise<CryptoKey> {
  try {
    return await subtle.importKey('pkcs8', der, ED25519, extractable, ['sign']);
  } catch (err) {
    throw unsupportedKey(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  }
}

/** `seed` as a PKCS#8 Ed25519 private key's DER bytes. */
export function pkcs8OfSeed(seed: Uint8Array): Uint8Array<ArrayBuffer> {
  if (!(seed instanceof Uint8Array) || seed.length !== SEED_BYTES) throw new Error(`An Ed25519 seed is ${SEED_BYTES} bytes`);
  const der = new Uint8Array(PKCS8_ED25519_HEAD.length + SEED_BYTES);
  der.set(PKCS8_ED25519_HEAD);
  der.set(seed, PKCS8_ED25519_HEAD.length);
  return der;
}

/** base64url (RFC 4648 §5, unpadded) to bytes. */
function fromBase64Url(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error('Not base64url');
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/** The seed's public key (32 bytes). */
export async function publicKeyOfSeed(seed: Uint8Array, subtle: SubtleCrypto = webCrypto()): Promise<Uint8Array> {
  const der = pkcs8OfSeed(seed);
  try {
    // Extractable only to read the public half; this key is dropped at once and never signs.
    const key = await importSeed(subtle, der, true);
    const jwk = await subtle.exportKey('jwk', key);
    if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string') throw new Error('The key exported is not an Ed25519 key');
    const x = fromBase64Url(jwk.x);
    if (x.length !== PUBLIC_KEY_BYTES) throw new Error('The exported public key is not 32 bytes');
    return x;
  } finally {
    der.fill(0);
  }
}

/** Signs `message` with the seed's key (not extractable). Unguarded: proof.ts is its only caller. */
export async function signWithSeed(seed: Uint8Array, message: Uint8Array, subtle: SubtleCrypto = webCrypto()): Promise<Uint8Array> {
  const der = pkcs8OfSeed(seed);
  try {
    const key = await importSeed(subtle, der, false);
    const signature = new Uint8Array(await subtle.sign(ED25519, key, message as Uint8Array<ArrayBuffer>));
    if (signature.length !== SIGNATURE_BYTES) throw new Error('The signature is not 64 bytes');
    return signature;
  } finally {
    der.fill(0);
  }
}
