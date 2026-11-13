// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Muon 3D Technologies Limited
// PKCE S256 (pkce.ts) on RFC 7636's Appendix B vector, and the verifier's and the state's shapes.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { base64url, challengeOf, isVerifier, newState, newVerifier } from './pkce.ts';

// RFC 7636 Appendix B: the 32 octets, their base64url (the verifier) and the S256 challenge.
const B_OCTETS = [116, 24, 223, 180, 151, 153, 224, 37, 79, 250, 96, 125, 216, 173, 187, 186, 22, 212, 37, 77, 105, 214, 191, 240, 91, 88, 5, 88, 83, 132, 141, 121];
const B_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const B_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

describe('PKCE (RFC 7636)', () => {
  it('Appendix B: the octets give the verifier, the verifier the S256 challenge', async () => {
    assert.equal(base64url(Uint8Array.from(B_OCTETS)), B_VERIFIER);
    assert.equal(newVerifier(() => Uint8Array.from(B_OCTETS)), B_VERIFIER);
    assert.equal(await challengeOf(B_VERIFIER), B_CHALLENGE);
  });

  it('a verifier is 43 to 128 unreserved characters; anything else is refused before hashing', async () => {
    assert.equal(isVerifier(B_VERIFIER), true);
    assert.equal(isVerifier('a'.repeat(42)), false);
    assert.equal(isVerifier('a'.repeat(129)), false);
    assert.equal(isVerifier(`${'a'.repeat(42)}+`), false);
    await assert.rejects(challengeOf('short'), /43 to 128/);
    const fresh = newVerifier();
    assert.equal(fresh.length, 43);
    assert.ok(isVerifier(fresh));
    assert.notEqual(newVerifier(), fresh);
    assert.match(newState(), /^[A-Za-z0-9_-]{22}$/);
  });
});
