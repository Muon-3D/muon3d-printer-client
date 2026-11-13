// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Muon 3D Technologies Limited
// Adapted from Muon3D Fluidd (src/services/muon-cloud/centralLogin.ts and src/services/muon-cloud/api.ts), written by Muon 3D.
//
// Central sign-in at the Muon3D account service (the console), from a client's side. The page goes, top level, to
// the console's /authorize with PKCE S256 and a `state`; signed in there, the console sends it straight back to the
// client's registered redirect URI with a `code`, else with an error (`login_required` when `prompt=none` found no
// session at the console). The client checks that the answer is the one it asked for (its `state`) and from the
// console it asked (`iss`, RFC 9207), then exchanges the code with its verifier at /token (the console's API, api.ts).
//
// The console has two names, control.muon3d.com and app.muon3d.com, and names itself (`iss`) by one of them whichever
// a browser reached it by: so `iss` may be either name of the console asked (sameConsole with CONSOLE_ALIASES), and
// nothing else, not a look-alike host, not plain http, not another console.
//
// What the tab remembers across the trip (the verifier, the state, where to come back to) is kept in the tab's own
// storage (sessionStorage), passed in.
import { challengeOf, newState, newVerifier } from './pkce.ts';

/** The production console's two names: one console, with the same accounts, sessions and codes. */
export const CONSOLE_ALIASES: readonly string[] = Object.freeze(['https://control.muon3d.com', 'https://app.muon3d.com']);

const bare = (origin: string): string => origin.replace(/\/$/, '');

/**
 * Whether `a` and `b` name one console: the same origin (a trailing slash aside), or two of `aliases`, the origins
 * that are one console's names. Compared exactly: a look-alike host or another scheme is another console.
 */
export function sameConsole(a: string, b: string, aliases: readonly string[] = []): boolean {
  const x = bare(a);
  const y = bare(b);
  if (!x || !y) return false;
  const names = aliases.map(bare);
  return x === y || (names.includes(x) && names.includes(y));
}

export interface AuthorizeInput {
  consoleOrigin: string;
  /** The client's id in the console's registry. */
  clientId: string;
  /** The client's registered redirect URI, exactly. */
  redirectUri: string;
  challenge: string;
  state: string;
  /** `none`: come straight back, with `login_required` when the console has no session (asked once, never in a loop). */
  prompt?: 'none';
}

/** The console's /authorize URL for one sign-in. */
export function authorizeUrl(input: AuthorizeInput): string {
  const url = new URL('/authorize', input.consoleOrigin);
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    code_challenge: input.challenge,
    code_challenge_method: 'S256',
    state: input.state,
  });
  if (input.prompt === 'none') query.set('prompt', 'none');
  url.search = query.toString();
  return url.href;
}

/** What a tab remembers across the trip to /authorize. */
export interface PendingSignIn {
  state: string;
  verifier: string;
  redirectUri: string;
  /** The console the tab went to. */
  consoleOrigin: string;
  /** The address on this page to come back to (safeReturnTo). */
  returnTo: string;
  /** It asked with `prompt=none`. */
  silent: boolean;
}

/** A new verifier and state, and the /authorize URL that goes with them. Remember `pending` (storePendingSignIn) before going. */
export async function prepareSignIn(input: {
  consoleOrigin: string;
  clientId: string;
  redirectUri: string;
  prompt?: 'none';
  returnTo?: string;
  random?: (n: number) => Uint8Array;
  subtle?: SubtleCrypto;
}): Promise<{ url: string; pending: PendingSignIn }> {
  const verifier = newVerifier(input.random);
  const state = newState(input.random);
  const challenge = await challengeOf(verifier, input.subtle);
  const url = authorizeUrl({ consoleOrigin: input.consoleOrigin, clientId: input.clientId, redirectUri: input.redirectUri, challenge, state, prompt: input.prompt });
  const pending: PendingSignIn = {
    state,
    verifier,
    redirectUri: input.redirectUri,
    consoleOrigin: new URL(input.consoleOrigin).origin,
    returnTo: safeReturnTo(input.returnTo ?? '/'),
    silent: input.prompt === 'none',
  };
  return { url, pending };
}

/**
 * An address on this page to come back to after signing in: a path such as `/join?code=X`, never another origin
 * (`//host`, `/\host`), white space or a scheme. A hash route (`#/join?code=X`) becomes its path. Anything else is `/`.
 */
export function safeReturnTo(value: string): string {
  const path = value.startsWith('#/') ? value.slice(1) : value;
  return /^\/[^\s\\]*$/.test(path) && !path.startsWith('//') ? path : '/';
}

/** The part of Web Storage the pending sign-in uses (the tab's sessionStorage). */
export type SignInStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Where the pending sign-in is kept in the tab's storage, unless a client names its own key. */
export const PENDING_SIGN_IN_KEY = 'muon3d:sign-in:pending';

/** Keeps `pending` in the tab's storage; false when there is no storage, or it refused. */
export function storePendingSignIn(storage: SignInStorage | null | undefined, pending: PendingSignIn, key = PENDING_SIGN_IN_KEY): boolean {
  try {
    if (!storage) return false;
    storage.setItem(key, JSON.stringify(pending));
    return true;
  } catch {
    return false;
  }
}

/** Takes the pending sign-in out of the tab's storage (it is used once): null when there is none, or it is unreadable. */
export function takePendingSignIn(storage: SignInStorage | null | undefined, key = PENDING_SIGN_IN_KEY): PendingSignIn | null {
  let text: string | null = null;
  try {
    text = storage?.getItem(key) ?? null;
    storage?.removeItem(key);
  } catch {
    return null;
  }
  if (!text) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const p = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
  if (!p) return null;
  const { state, verifier, redirectUri, consoleOrigin, returnTo, silent } = p;
  if (typeof state !== 'string' || !state || typeof verifier !== 'string' || !verifier) return null;
  if (typeof redirectUri !== 'string' || typeof consoleOrigin !== 'string') return null;
  return { state, verifier, redirectUri, consoleOrigin, returnTo: safeReturnTo(typeof returnTo === 'string' ? returnTo : '/'), silent: silent === true };
}

/** What came back from /authorize: the state, a code or an error, and the issuer. */
export interface SignInAnswer {
  state: string;
  code?: string;
  error?: string;
  errorDescription?: string;
  iss: string | null;
}

const short = (value: unknown, max: number): string | null => (typeof value === 'string' && value.length > 0 && value.length <= max ? value : null);

/** An answer, read strictly (from a callback page's report, or a query): null when it is not one. */
export function readSignInAnswer(data: unknown): SignInAnswer | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  const state = short(d.state, 256);
  if (!state) return null;
  const code = short(d.code, 2048);
  const error = short(d.error, 256);
  if (!code && !error) return null;
  const iss = short(d.iss, 512);
  if (code) return { state, code, iss };
  const description = short(d.error_description ?? d.errorDescription, 1024);
  return description ? { state, error: error as string, errorDescription: description, iss } : { state, error: error as string, iss };
}

/**
 * Whether a query string is a return from /authorize: it carries a `state` with a `code` or an `error`. A page's own
 * `code` (an invite's /join?code=) comes without one.
 */
export function isAuthCallback(search: string): boolean {
  const query = new URLSearchParams(search);
  return query.has('state') && (query.has('code') || query.has('error'));
}

/** The answer in a return's query string (`?code=…&state=…&iss=…`), or null when it is not one. */
export function signInAnswerOf(search: string): SignInAnswer | null {
  if (!isAuthCallback(search)) return null;
  return readSignInAnswer(Object.fromEntries(new URLSearchParams(search)));
}

/** What a client does with an answer. */
export type SignInOutcome =
  /** Exchange `code` with `verifier` at /token (the same `redirectUri`). */
  | { outcome: 'code'; code: string; verifier: string; redirectUri: string; returnTo: string }
  /** `prompt=none` found no session at the console: show Sign in, which asks without it. */
  | { outcome: 'signed-out'; returnTo: string }
  /**
   * Nothing to exchange: the answer is not for a sign-in this tab started (`not-started-here`), it came from another
   * console (`wrong-console`), the console refused (`console-error`, with its `error` and `description`), or it carried
   * neither a code nor an error (`no-code`).
   */
  | { outcome: 'refused'; reason: 'not-started-here' | 'wrong-console' | 'console-error' | 'no-code'; error?: string; description?: string; returnTo: string };

/**
 * Checks an answer against the sign-in this tab started: its `state` must be the one sent, and its `iss` the console
 * asked, under either of its names (`aliases`, CONSOLE_ALIASES for the production console). Only then is a code
 * exchanged, or an error believed.
 */
export function checkSignInAnswer(answer: SignInAnswer | null, pending: PendingSignIn | null, options: { aliases?: readonly string[] } = {}): SignInOutcome {
  const returnTo = safeReturnTo(pending?.returnTo ?? '/');
  if (!answer || !pending || answer.state !== pending.state) return { outcome: 'refused', reason: 'not-started-here', returnTo };
  if (answer.iss === null || !sameConsole(answer.iss, pending.consoleOrigin, options.aliases ?? [])) return { outcome: 'refused', reason: 'wrong-console', returnTo };
  if (answer.error === 'login_required' && pending.silent) return { outcome: 'signed-out', returnTo };
  if (answer.error) {
    return { outcome: 'refused', reason: 'console-error', error: answer.error, ...(answer.errorDescription ? { description: answer.errorDescription } : {}), returnTo };
  }
  if (!answer.code) return { outcome: 'refused', reason: 'no-code', returnTo };
  return { outcome: 'code', code: answer.code, verifier: pending.verifier, redirectUri: pending.redirectUri, returnTo };
}

/**
 * Signing out of the console: a form post to its /logout, which ends the browser's session there and every session
 * issued from it, loads each client's front-channel logout page, and comes back to `postLogoutRedirectUri`. The
 * client builds the form from this (a hidden form, submitted top level).
 */
export function logoutForm(input: { consoleOrigin: string; clientId: string; postLogoutRedirectUri: string }): { method: 'POST'; action: string; fields: Record<string, string> } {
  return {
    method: 'POST',
    action: new URL('/logout', input.consoleOrigin).href,
    fields: { client_id: input.clientId, post_logout_redirect_uri: input.postLogoutRedirectUri },
  };
}
