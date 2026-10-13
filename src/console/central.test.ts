// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Muon 3D Technologies Limited
// Adapted from Muon3D Fluidd (src/services/muon-cloud/__tests__/console-names.spec.ts), written by Muon 3D.
// Central sign-in (central.ts): the /authorize URL for a client, with prompt=none once; what the tab remembers across
// the trip; the answer read strictly from a callback's report or its query; and the checks before a code is
// exchanged: this tab's state, and an issuer that is the console asked under either of its names, and nothing else.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { challengeOf } from './pkce.ts';
import {
  authorizeUrl,
  checkSignInAnswer,
  CONSOLE_ALIASES,
  isAuthCallback,
  logoutForm,
  prepareSignIn,
  readSignInAnswer,
  safeReturnTo,
  sameConsole,
  signInAnswerOf,
  storePendingSignIn,
  takePendingSignIn,
  type PendingSignIn,
  type SignInStorage,
} from './central.ts';

const APP = 'https://app.muon3d.com';
const CONTROL = 'https://control.muon3d.com';
const B_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

/** A tab's sessionStorage. */
function tabStorage(): SignInStorage & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  };
}

const pending = (over: Partial<PendingSignIn> = {}): PendingSignIn => ({
  state: 'st4te',
  verifier: 'v'.repeat(43),
  redirectUri: 'https://slicer.muon3d.com/auth/callback.html',
  consoleOrigin: CONTROL,
  returnTo: '/',
  silent: false,
  ...over,
});

describe('the /authorize URL', () => {
  it("names the client, its exact redirect URI, S256 and the state; prompt=none only when asked", () => {
    const url = new URL(authorizeUrl({ consoleOrigin: 'https://console.example/', clientId: 'slicer', redirectUri: 'https://slicer.example/auth/callback.html', challenge: B_CHALLENGE, state: 'st' }));
    assert.equal(url.origin + url.pathname, 'https://console.example/authorize');
    assert.deepEqual(Object.fromEntries(url.searchParams), {
      response_type: 'code',
      client_id: 'slicer',
      redirect_uri: 'https://slicer.example/auth/callback.html',
      code_challenge: B_CHALLENGE,
      code_challenge_method: 'S256',
      state: 'st',
    });
    const silent = new URL(authorizeUrl({ consoleOrigin: CONTROL, clientId: 'fluidd', redirectUri: `${CONTROL}/`, challenge: B_CHALLENGE, state: 'st', prompt: 'none' }));
    assert.equal(silent.searchParams.get('prompt'), 'none');
    assert.equal(silent.searchParams.get('client_id'), 'fluidd');
  });

  it('prepares a sign-in: the challenge is the verifier\'s, the pending sign-in what the tab must remember', async () => {
    const { url, pending: p } = await prepareSignIn({ consoleOrigin: `${CONTROL}/`, clientId: 'slicer', redirectUri: 'http://localhost:5173/auth/callback.html', prompt: 'none', returnTo: '//evil.example' });
    const asked = new URL(url);
    assert.equal(asked.searchParams.get('code_challenge'), await challengeOf(p.verifier));
    assert.equal(asked.searchParams.get('state'), p.state);
    assert.deepEqual({ ...p, state: '', verifier: '' }, { state: '', verifier: '', redirectUri: 'http://localhost:5173/auth/callback.html', consoleOrigin: CONTROL, returnTo: '/', silent: true });
  });
});

describe('what the tab remembers', () => {
  it('is kept once and taken once', () => {
    const tab = tabStorage();
    assert.equal(storePendingSignIn(tab, pending({ returnTo: '/plate?x=1' })), true);
    assert.deepEqual(takePendingSignIn(tab), pending({ returnTo: '/plate?x=1' }));
    assert.equal(takePendingSignIn(tab), null);
  });

  it('is nothing without storage, with storage that refuses, or when it is unreadable', () => {
    assert.equal(storePendingSignIn(null, pending()), false);
    const refusing = { getItem: () => null, setItem: () => { throw new Error('QuotaExceededError'); }, removeItem: () => undefined };
    assert.equal(storePendingSignIn(refusing, pending()), false);
    const tab = tabStorage();
    tab.setItem('muon3d:sign-in:pending', '{not json');
    assert.equal(takePendingSignIn(tab), null);
    tab.setItem('muon3d:sign-in:pending', JSON.stringify({ state: 's' }));
    assert.equal(takePendingSignIn(tab), null);
    tab.setItem('k', JSON.stringify({ ...pending(), returnTo: 'https://evil.example/' }));
    assert.equal(takePendingSignIn(tab, 'k')?.returnTo, '/', 'where to come back to is a path on this page');
  });

  it('comes back only to a path on this page', () => {
    assert.equal(safeReturnTo('/join?code=X'), '/join?code=X');
    assert.equal(safeReturnTo('#/join?code=X'), '/join?code=X');
    for (const bad of ['//evil.example', '/\\evil.example', 'https://evil.example', 'javascript:alert(1)', '/a b', '']) assert.equal(safeReturnTo(bad), '/', bad);
  });
});

describe('the answer', () => {
  it("reads a callback's report: a state with a code or an error; anything else is not one", () => {
    assert.deepEqual(readSignInAnswer({ state: 's', code: 'c', iss: 'https://console.example' }), { state: 's', code: 'c', iss: 'https://console.example' });
    assert.deepEqual(readSignInAnswer({ state: 's', error: 'access_denied', iss: null }), { state: 's', error: 'access_denied', iss: null });
    assert.deepEqual(readSignInAnswer({ state: 's', error: 'access_denied', error_description: 'No.', iss: CONTROL }), { state: 's', error: 'access_denied', errorDescription: 'No.', iss: CONTROL });
    assert.equal(readSignInAnswer({ code: 'c' }), null);
    assert.equal(readSignInAnswer({ state: 's' }), null);
    assert.equal(readSignInAnswer('state=s&code=c'), null);
    assert.equal(readSignInAnswer({ state: 's', code: 'c'.repeat(3000) }), null);
  });

  it("reads a return's query; a page's own code (an invite) is not one", () => {
    assert.equal(isAuthCallback('?code=c&state=s'), true);
    assert.equal(isAuthCallback('?error=login_required&state=s'), true);
    assert.equal(isAuthCallback('?code=INVITE'), false);
    assert.deepEqual(signInAnswerOf(`?code=c0de&state=s&iss=${encodeURIComponent(CONTROL)}`), { state: 's', code: 'c0de', iss: CONTROL });
    assert.equal(signInAnswerOf('?code=INVITE'), null);
  });
});

describe('sameConsole', () => {
  it('is one console for its two names, and a host is not its look-alikes', () => {
    assert.equal(sameConsole(APP, CONTROL, CONSOLE_ALIASES), true);
    assert.equal(sameConsole(`${CONTROL}/`, APP, CONSOLE_ALIASES), true);
    assert.equal(sameConsole('http://192.168.1.37', 'http://192.168.1.37/', CONSOLE_ALIASES), true);
    assert.equal(sameConsole(APP, 'https://staging-app.muon3d.com', CONSOLE_ALIASES), false);
    assert.equal(sameConsole(CONTROL, 'https://control.muon3d.com.evil.example', CONSOLE_ALIASES), false);
    assert.equal(sameConsole(CONTROL, 'http://control.muon3d.com', CONSOLE_ALIASES), false);
    assert.equal(sameConsole('', '', CONSOLE_ALIASES), false);
  });

  it('without aliases, two names are two consoles', () => {
    assert.equal(sameConsole(APP, CONTROL), false);
    assert.equal(sameConsole(APP, `${APP}/`), true);
  });
});

describe('checkSignInAnswer', () => {
  const answer = (iss: string | null, over: Record<string, unknown> = {}) => readSignInAnswer({ state: 'st4te', code: 'c0de', iss, ...over });

  it('takes a code whose issuer is either name of the console, and no other', () => {
    for (const iss of [APP, CONTROL, `${CONTROL}/`]) {
      assert.deepEqual(checkSignInAnswer(answer(iss), pending(), { aliases: CONSOLE_ALIASES }), {
        outcome: 'code',
        code: 'c0de',
        verifier: 'v'.repeat(43),
        redirectUri: 'https://slicer.muon3d.com/auth/callback.html',
        returnTo: '/',
      });
    }
    for (const iss of ['https://evil.example', 'https://control.muon3d.com.evil.example', 'http://control.muon3d.com', 'https://staging-app.muon3d.com', null]) {
      const outcome = checkSignInAnswer(answer(iss), pending(), { aliases: CONSOLE_ALIASES });
      assert.deepEqual(outcome.outcome === 'refused' && outcome.reason, 'wrong-console', String(iss));
    }
    // Without the aliases, only the console asked.
    assert.equal(checkSignInAnswer(answer(APP), pending()).outcome, 'refused');
  });

  it('refuses an answer for a sign-in this tab did not start', () => {
    for (const [a, p] of [
      [answer(CONTROL, { state: 'other' }), pending()],
      [answer(CONTROL), null],
      [null, pending()],
    ] as const) {
      const outcome = checkSignInAnswer(a, p, { aliases: CONSOLE_ALIASES });
      assert.equal(outcome.outcome === 'refused' && outcome.reason, 'not-started-here');
    }
  });

  it('a silent try that found no session is signed out; any other error is the console refusing', () => {
    const none = readSignInAnswer({ state: 'st4te', error: 'login_required', iss: CONTROL });
    assert.deepEqual(checkSignInAnswer(none, pending({ silent: true, returnTo: '/plate' })), { outcome: 'signed-out', returnTo: '/plate' });
    assert.deepEqual(checkSignInAnswer(none, pending()), { outcome: 'refused', reason: 'console-error', error: 'login_required', returnTo: '/' });
    const denied = readSignInAnswer({ state: 'st4te', error: 'access_denied', error_description: 'Refused.', iss: CONTROL });
    assert.deepEqual(checkSignInAnswer(denied, pending()), { outcome: 'refused', reason: 'console-error', error: 'access_denied', description: 'Refused.', returnTo: '/' });
    // An error from another console is not believed either.
    const foreign = readSignInAnswer({ state: 'st4te', error: 'login_required', iss: 'https://evil.example' });
    assert.equal(checkSignInAnswer(foreign, pending({ silent: true })).outcome, 'refused');
  });
});

describe('signing out', () => {
  it("is a form post to the console's /logout, coming back to the client", () => {
    assert.deepEqual(logoutForm({ consoleOrigin: CONTROL, clientId: 'slicer', postLogoutRedirectUri: 'https://slicer.muon3d.com/' }), {
      method: 'POST',
      action: `${CONTROL}/logout`,
      fields: { client_id: 'slicer', post_logout_redirect_uri: 'https://slicer.muon3d.com/' },
    });
  });
});
