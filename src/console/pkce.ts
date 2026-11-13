// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Muon 3D Technologies Limited
// PKCE with S256, as RFC 7636 defines it: §4.1 the verifier, §4.2 the challenge, Appendix A base64url without padding,
// Appendix B the vector the tests check. Written from the RFC. And the `state` a client sends to /authorize and checks
// on the way back.

/** base64url without padding (RFC 7636 Appendix A). */
export function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** RFC 7636 §4.1: 43 to 128 characters of the unreserved set. */
const VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;
export const isVerifier = (value: unknown): value is string => typeof value === 'string' && VERIFIER_RE.test(value);

const randomBytes = (n: number): Uint8Array => crypto.getRandomValues(new Uint8Array(n));

/** A verifier: 32 random octets, base64url (43 characters), as §4.1 recommends. */
export function newVerifier(random: (n: number) => Uint8Array = randomBytes): string {
  return base64url(random(32));
}

/** §4.2: S256, BASE64URL(SHA256(ASCII(code_verifier))). */
export async function challengeOf(verifier: string, subtle: SubtleCrypto = crypto.subtle): Promise<string> {
  if (!isVerifier(verifier)) throw new Error('A PKCE verifier is 43 to 128 unreserved characters');
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

/** A `state`: 16 random octets, base64url. */
export const newState = (random: (n: number) => Uint8Array = randomBytes): string => base64url(random(16));
