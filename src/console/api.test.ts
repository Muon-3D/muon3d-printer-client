// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Muon 3D Technologies Limited
// The console's API (api.ts): the client's id on every token request; a token answer whose pair cannot be read is an
// unknown outcome (the console may have rotated); the endpoint challenge carries the console's clock even where the
// browser cannot read its Date header, so a computer whose clock is 10 minutes off still proves its key; and the
// readers keep only what they can trust.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { failureOf } from '../errors/failure.ts';
import { endpointIdOf, newSeed, PROOF_DOMAIN, proveEndpoint } from '../proof/proof.ts';
import { challengeIssuedAt, createConsoleApi, NONCE_LIFETIME_S, readGrant, readNearby, readPrinters } from './api.ts';

const ORIGIN = 'https://console.example';
const P1 = 'a1'.repeat(32);
const P2 = 'b2'.repeat(32);

/** A console answering every request with `status` and `body`, and the headers given (none exposed by default). */
function answering(status: number, body: unknown, headers: Record<string, string> = {}) {
  const asked: { url: string; init: RequestInit }[] = [];
  const api = createConsoleApi({
    origin: ORIGIN,
    clientId: 'slicer',
    fetch: async (url, init) => {
      asked.push({ url, init });
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
    },
  });
  return Object.assign(api, { asked });
}

const rejection = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (err) {
    return failureOf(err);
  }
  assert.fail('expected a rejection');
};

describe("the console's API", () => {
  it('needs the client id, and sends it with every token request, form-encoded, without cookies or redirects', async () => {
    assert.throws(() => createConsoleApi({ origin: ORIGIN, clientId: '' }), /client id/);
    const api = answering(200, { access_token: 'a'.repeat(40), refresh_token: 'r'.repeat(40), token_type: 'Bearer', expires_in: 900 });
    assert.equal(api.clientId, 'slicer');
    const outcome = await api.token({ grant_type: 'authorization_code', code: 'c0de', redirect_uri: 'https://slicer.example/auth/callback.html', code_verifier: 'v'.repeat(43) });
    assert.deepEqual(outcome, { ok: true, pair: { accessToken: 'a'.repeat(40), refreshToken: 'r'.repeat(40), expiresIn: 900 } });
    const { url, init } = api.asked[0];
    assert.equal(url, `${ORIGIN}/token`);
    assert.equal(Object.fromEntries(new URLSearchParams(String(init.body))).client_id, 'slicer');
    assert.deepEqual([init.credentials, init.redirect, init.cache], ['omit', 'error', 'no-store']);
  });

  it('a 2xx token answer without a readable pair is not answered: its outcome is unknown', async () => {
    for (const body of [{ access_token: 'a'.repeat(40), refresh_token: 'r'.repeat(40), token_type: 'DPoP' }, { access_token: 'a'.repeat(40) }, 'not json']) {
      const outcome = await answering(200, body).token({ grant_type: 'refresh_token', refresh_token: 'r'.repeat(40) });
      assert.equal(outcome.ok, false);
      assert.equal(!outcome.ok && outcome.answered, false, JSON.stringify(body));
    }
    const refused = await answering(400, { error: 'invalid_grant' }).token({ grant_type: 'refresh_token', refresh_token: 'r'.repeat(40) });
    assert.deepEqual(!refused.ok && [refused.answered, refused.invalidGrant, refused.status], [true, true, 400]);
  });

  it('a refresh that never got an answer is signed-out (its outcome unknown); a code exchange is the console', async () => {
    const down = createConsoleApi({
      origin: ORIGIN,
      clientId: 'slicer',
      fetch: async () => {
        throw new TypeError('Failed to fetch');
      },
    });
    const refresh = await down.token({ grant_type: 'refresh_token', refresh_token: 'r'.repeat(40) });
    assert.deepEqual(!refresh.ok && [refresh.error.kind, refresh.answered], ['signed-out', false]);
    const code = await down.token({ grant_type: 'authorization_code', code: 'c', redirect_uri: 'https://s.example/', code_verifier: 'v'.repeat(43) });
    assert.equal(!code.ok && code.error.kind, 'console');
  });

  it("the challenge without a Date header carries the console's clock from its expiry; a clock 10 minutes off still proves", async () => {
    const consoleNow = 1_800_000_000;
    const answer = { nonce: 'ab'.repeat(32), expires_at: consoleNow + NONCE_LIFETIME_S, domain: PROOF_DOMAIN };
    assert.equal(challengeIssuedAt(answer), consoleNow);
    assert.equal(challengeIssuedAt({ expires_at: 'soon' }), null);
    const { answer: received, date } = await answering(200, answer).challenge('a'.repeat(40));
    assert.equal(date, consoleNow);
    const seed = newSeed();
    for (const skew of [-600, 600]) {
      const proof = await proveEndpoint(seed, received, { serviceDate: date, nowS: consoleNow + skew });
      assert.ok(!('kind' in proof), `a clock ${skew} s off: ${'kind' in proof ? proof.message : ''}`);
      if (!('kind' in proof)) assert.equal(proof.endpoint_id, await endpointIdOf(seed));
    }
    // Without the console's clock, the same skew fails (the reason for it).
    assert.ok('kind' in (await proveEndpoint(seed, received, { serviceDate: null, nowS: consoleNow + 600 })));
    // An exposed Date header is still taken first.
    const dated = await answering(200, answer, { Date: 'Wed, 15 Jan 2027 08:00:00 GMT' }).challenge('a'.repeat(40));
    assert.equal(dated.date, 'Wed, 15 Jan 2027 08:00:00 GMT');
  });

  it('sends the bearer token, and rejects with the console\'s error kinds', async () => {
    const api = answering(200, { printers: [] });
    await api.printers('t0ken');
    assert.equal((api.asked[0].init.headers as Record<string, string>).Authorization, 'Bearer t0ken');
    assert.equal((await rejection(answering(401, { error: 'expired' }).printers('t'))).kind, 'signed-out');
    assert.equal((await rejection(answering(503, { error: 'printer is offline' }).access('t', P1))).kind, 'offline');
    assert.equal((await rejection(answering(504, { error: 'no answer' }).access('t', P1))).kind, 'unreachable');
    const limited = await rejection(answering(429, { error: 'slow down' }, { 'Retry-After': '7' }).me('t'));
    assert.deepEqual([limited.kind, limited.retryAfterS], ['console', 7]);
    assert.equal((await rejection(answering(200, {}).access('t', 'not-an-endpoint-id'))).kind, 'bad-request');
    assert.equal((await rejection(answering(409, { error: 'taken' }).putEndpoint('t', { endpoint_id: P1, nonce: 'n', signature: 's' }))).kind, 'protocol');
  });

  it('reads the printers near this browser without a token', async () => {
    const api = answering(200, { printers: [{ printer_id: P1, name: 'Walnut', model: 'M1', linked: true, local_addrs: ['10.42.0.1', '192.168.1.20', 7] }] });
    assert.deepEqual(await api.nearby(), [{ id: P1, name: 'Walnut', model: 'M1', linked: true, localAddrs: ['10.42.0.1', '192.168.1.20'] }]);
    assert.equal((api.asked[0].init.headers as Record<string, string>).Authorization, undefined);
    assert.equal(api.asked[0].url, `${ORIGIN}/v1/links/nearby`);
  });

  it('asks for an assertion for another service by its name', async () => {
    const api = answering(200, { assertion: 'eyJ.x.y', expires_at: 1_800_000_300 });
    assert.deepEqual(await api.assertion('t', 'models'), { assertion: 'eyJ.x.y', expiresAt: 1_800_000_300 });
    assert.deepEqual(JSON.parse(String(api.asked[0].init.body)), { audience: 'models' });
    assert.equal((await rejection(api.assertion('t', 'https://evil.example'))).kind, 'bad-request');
    assert.equal((await rejection(answering(200, { assertion: 'x' }).assertion('t', 'models'))).kind, 'protocol');
  });
});

describe('the readers', () => {
  it('keep printers with an EndpointId, once each; an unknown role watches', () => {
    const printers = readPrinters({
      printers: [
        { id: P1, name: 'Walnut', model: 'Muon3D M1', online: true, role: 'operator', shared: false, ends_at: null },
        { id: P1, name: 'Walnut again' },
        { id: 'short', name: 'x' },
        { id: P2, name: 'Oak', online: 'yes', role: 'admin', shared: true, ends_at: 1_900_000_000 },
      ],
    });
    assert.deepEqual(printers, [
      { id: P1, name: 'Walnut', model: 'Muon3D M1', online: true, role: 'operator', shared: false, endsAt: null },
      { id: P2, name: 'Oak', model: null, online: false, role: 'viewer', shared: true, endsAt: 1_900_000_000 },
    ]);
    assert.throws(() => readPrinters({}), (err) => failureOf(err).kind === 'protocol');
    assert.throws(() => readNearby({ printers: 'none' }), (err) => failureOf(err).kind === 'protocol');
  });

  it('take a grant only for the printer asked about, with an expiry', () => {
    const grant = { printer_id: P1, relay_url: 'https://relay.example/', role: 'owner', grant_id: 12, expires_at: 1_900_000_000 };
    assert.deepEqual(readGrant(grant, P1), { printerId: P1, relayUrl: 'https://relay.example/', role: 'owner', grantId: '12', expiresAt: 1_900_000_000 });
    assert.throws(() => readGrant(grant, P2), (err) => failureOf(err).kind === 'protocol');
    assert.throws(() => readGrant({ ...grant, expires_at: undefined }, P1), (err) => failureOf(err).kind === 'protocol');
  });
});
