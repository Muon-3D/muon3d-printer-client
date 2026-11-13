// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Muon 3D Technologies Limited
// The Muon3D account service's HTTP API (the console), as a client uses it: the token endpoint, the account, the relay
// key's endpoint proof, the printer list, a printer's access grant, the printers near this browser, an assertion for
// another Muon3D service, and sign-out. Bearer only (no /v1 route reads a cookie), JSON bodies, Unix-second times;
// errors are `{"error": "…"}` and read by parseConsoleAnswer and parseConsoleFailure, so they are the same kinds as
// every route's. Every request has a limit; a failure rejects with a PrinterFailure (errors/failure.ts).
//
// Whoever holds the instance holds the tokens it is given: a client keeps it where its tokens are (a Worker, say).
import { cleanText, printerError, type PrinterError } from '../errors/kinds.ts';
import { parseConsoleAnswer, parseConsoleFailure, protocolError } from '../errors/parse.ts';
import { fail } from '../errors/failure.ts';

/** How long a console request may take. */
export const CONSOLE_ANSWER_MS = 20_000;

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  /** Seconds the access token lasts (the console's 900). */
  expiresIn: number;
}

/**
 * A token request's outcome. `answered`: the console answered (so it is known whether a refresh token was used); a
 * network failure, an abort or a timeout is not answered, and its outcome is unknown.
 */
export type TokenOutcome = { ok: true; pair: TokenPair } | { ok: false; error: PrinterError; answered: boolean; invalidGrant: boolean; status: number | null };

export type TokenGrant =
  | { grant_type: 'authorization_code'; code: string; redirect_uri: string; code_verifier: string }
  | { grant_type: 'refresh_token'; refresh_token: string };

export interface ConsoleConfig {
  relayUrl: string;
  endpointProof: 'required' | 'optional' | null;
}

export interface Me {
  /** The account's id. */
  account: string;
  email: string | null;
  endpointId: string | null;
  /** null where the console does not say. */
  endpointProven: boolean | null;
}

export type ConsoleRole = 'owner' | 'operator' | 'viewer';

export interface ConsolePrinter {
  /** The printer's EndpointId. */
  id: string;
  /** As the console has it (cleaned for display by the client). */
  name: string;
  model: string | null;
  online: boolean;
  role: ConsoleRole;
  shared: boolean;
  /** When a share ends (Unix seconds), or null. */
  endsAt: number | null;
}

export interface AccessGrant {
  printerId: string;
  relayUrl: string;
  role: ConsoleRole;
  grantId: string;
  /** Unix seconds. */
  expiresAt: number;
}

/** A printer the console sees behind this browser's public address, linked to an account or not. */
export interface NearbyPrinter {
  /** Its EndpointId. */
  id: string;
  name: string;
  model: string | null;
  /** Some account has linked it: this one's, or another's. */
  linked: boolean;
  /** Its private addresses, for opening it on this network (nearbyHost picks the one to try first). */
  localAddrs: string[];
}

/** A signed assertion of the account for another Muon3D service (`audience`), which never sees the console's tokens. */
export interface Assertion {
  assertion: string;
  /** Unix seconds. */
  expiresAt: number;
}

export interface ConsoleApi {
  readonly origin: string;
  readonly clientId: string;
  token(grant: TokenGrant, options?: { signal?: AbortSignal }): Promise<TokenOutcome>;
  config(): Promise<ConsoleConfig>;
  me(access: string): Promise<Me>;
  /**
   * The challenge's answer as received, and the console's clock: the answer's Date header when the browser exposes it,
   * else the moment the challenge was made (its expires_at less the nonce's lifetime), so a computer whose clock is off
   * still proves its key (the console enforces the expiry and single use itself).
   */
  challenge(access: string): Promise<{ answer: unknown; date: string | number | null }>;
  putEndpoint(access: string, proof: { endpoint_id: string; nonce: string; signature: string }): Promise<{ endpointId: string; proven: boolean }>;
  printers(access: string): Promise<ConsolePrinter[]>;
  access(access: string, printer: string): Promise<AccessGrant>;
  /** The printers near this browser, as the console sees them. No sign-in needed. */
  nearby(): Promise<NearbyPrinter[]>;
  assertion(access: string, audience: string): Promise<Assertion>;
  signOut(access: string): Promise<void>;
}

export interface ConsoleApiOptions {
  /** The console's origin. */
  origin: string;
  /** The client's id in the console's registry (sent with every token request). */
  clientId: string;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  answerMs?: number;
}

const record = (value: unknown): Record<string, unknown> | null => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null);
const str = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
const HEX32_RE = /^[0-9a-f]{64}$/;
const ROLES: readonly ConsoleRole[] = ['owner', 'operator', 'viewer'];
const roleOf = (value: unknown): ConsoleRole | null => ((ROLES as readonly unknown[]).includes(value) ? (value as ConsoleRole) : null);

/** A JSON body, or the text when it is not JSON. */
function bodyOf(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** How long the console's endpoint nonce lasts (the proof's CHALLENGE_LIFETIME_S). */
export const NONCE_LIFETIME_S = 300;

/**
 * When the console made a challenge, by its own clock (Unix seconds): its expires_at less the nonce's lifetime, or
 * null. The console's CORS exposes no response header, so a browser never reads its Date.
 */
export function challengeIssuedAt(value: unknown): number | null {
  const expires = record(value)?.expires_at;
  return typeof expires === 'number' && Number.isSafeInteger(expires) ? expires - NONCE_LIFETIME_S : null;
}

/** A token answer's pair, or null when it has none (or is not a bearer token). */
export function readTokenPair(value: unknown): TokenPair | null {
  const r = record(value);
  const accessToken = str(r?.access_token);
  const refreshToken = str(r?.refresh_token);
  if (!r || !accessToken || !refreshToken) return null;
  if (typeof r.token_type === 'string' && r.token_type.toLowerCase() !== 'bearer') return null;
  const expiresIn = typeof r.expires_in === 'number' && Number.isFinite(r.expires_in) && r.expires_in > 0 ? r.expires_in : 900;
  return { accessToken, refreshToken, expiresIn };
}

export function readMe(value: unknown): Me {
  const r = record(value);
  if (!r) throw fail(protocolError('GET /v1/me answered something that is not an object'));
  const account = record(r.account);
  const id = str(account?.id) ?? str(r.account) ?? str(account?.account_id);
  if (!id) throw fail(protocolError('GET /v1/me answered without an account'));
  const email = str(account?.email) ?? str(r.email);
  const endpointId = typeof r.endpoint_id === 'string' && HEX32_RE.test(r.endpoint_id) ? r.endpoint_id : null;
  const endpointProven = typeof r.endpoint_proven === 'boolean' ? r.endpoint_proven : null;
  return { account: cleanText(id, 200), email: email ? cleanText(email, 254) : null, endpointId, endpointProven };
}

/** The printer list: entries without an EndpointId, and repeats, are left out; an unknown role watches. */
export function readPrinters(value: unknown): ConsolePrinter[] {
  const list = record(value)?.printers;
  if (!Array.isArray(list)) throw fail(protocolError('GET /v1/printers answered without its printers'));
  const out: ConsolePrinter[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    const p = record(entry);
    const id = p?.id;
    if (!p || typeof id !== 'string' || !HEX32_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: typeof p.name === 'string' ? p.name : '',
      model: str(p.model),
      online: p.online === true,
      // An unknown role is not taken for a privilege: it watches.
      role: roleOf(p.role) ?? 'viewer',
      shared: p.shared === true,
      endsAt: typeof p.ends_at === 'number' && Number.isFinite(p.ends_at) ? p.ends_at : null,
    });
  }
  return out;
}

/** An access grant, which must be for `printer` and have an expiry. */
export function readGrant(value: unknown, printer: string): AccessGrant {
  const r = record(value);
  const relayUrl = str(r?.relay_url);
  const grantId = str(r?.grant_id) ?? (typeof r?.grant_id === 'number' ? String(r.grant_id) : null);
  if (!r || r.printer_id !== printer || !relayUrl || !grantId || typeof r.expires_at !== 'number') throw fail(protocolError('the access grant is not for this printer, or has no expiry'));
  return { printerId: printer, relayUrl, role: roleOf(r.role) ?? 'viewer', grantId, expiresAt: r.expires_at };
}

/** The printers near this browser: entries without an EndpointId, and repeats, are left out; addresses must be text. */
export function readNearby(value: unknown): NearbyPrinter[] {
  const list = record(value)?.printers;
  if (!Array.isArray(list)) throw fail(protocolError('GET /v1/links/nearby answered without its printers'));
  const out: NearbyPrinter[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    const p = record(entry);
    const id = p?.printer_id;
    if (!p || typeof id !== 'string' || !HEX32_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    const addrs = Array.isArray(p.local_addrs) ? p.local_addrs.filter((a): a is string => typeof a === 'string' && a !== '' && a.length <= 253) : [];
    out.push({ id, name: typeof p.name === 'string' ? p.name : '', model: str(p.model), linked: p.linked === true, localAddrs: addrs });
  }
  return out;
}

export function readAssertion(value: unknown): Assertion {
  const r = record(value);
  const assertion = str(r?.assertion);
  if (!r || !assertion || typeof r.expires_at !== 'number' || !Number.isFinite(r.expires_at)) throw fail(protocolError('POST /v1/me/assertion answered without an assertion and its expiry'));
  return { assertion, expiresAt: r.expires_at };
}

export function createConsoleApi(options: ConsoleApiOptions): ConsoleApi {
  const origin = new URL(options.origin).origin;
  const clientId = options.clientId;
  if (typeof clientId !== 'string' || clientId === '') throw new TypeError('createConsoleApi needs the client id the console registered');
  const fetchFn = options.fetch ?? ((url: string, init: RequestInit) => fetch(url, init));
  const answerMs = options.answerMs ?? CONSOLE_ANSWER_MS;

  /** One exchange: the answer's status, body and headers; a network failure rejects as fetch rejected. */
  async function exchange(path: string, init: RequestInit, signal?: AbortSignal): Promise<{ status: number; body: unknown; headers: Headers }> {
    const signals = [AbortSignal.timeout(answerMs), ...(signal ? [signal] : [])];
    const res = await fetchFn(new URL(path, origin).href, { ...init, cache: 'no-store', credentials: 'omit', redirect: 'error', signal: AbortSignal.any(signals) });
    const text = await res.text();
    return { status: res.status, body: bodyOf(text), headers: res.headers };
  }

  /** A request whose 2xx answer is returned; anything else rejects with the console's error. */
  async function call(method: string, path: string, access: string | null, json?: unknown, opts: { route?: 'access' } = {}): Promise<{ body: unknown; headers: Headers }> {
    const headers: Record<string, string> = {};
    if (access) headers.Authorization = `Bearer ${access}`;
    if (json !== undefined) headers['Content-Type'] = 'application/json';
    let answer;
    try {
      answer = await exchange(path, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) });
    } catch (err) {
      throw fail(parseConsoleFailure(err));
    }
    const error = parseConsoleAnswer({ status: answer.status, body: answer.body, retryAfter: answer.headers.get('Retry-After') }, opts);
    if (error) throw fail(error);
    return answer;
  }

  return {
    origin,
    clientId,

    async token(grant, { signal } = {}) {
      const form = new URLSearchParams({ ...grant, client_id: clientId });
      let answer;
      try {
        answer = await exchange('/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() }, signal);
      } catch (err) {
        // Not answered: whether the console used the refresh token is unknown.
        return { ok: false, error: parseConsoleFailure(err, { refreshing: grant.grant_type === 'refresh_token' }), answered: false, invalidGrant: false, status: null };
      }
      const error = parseConsoleAnswer({ status: answer.status, body: answer.body, retryAfter: answer.headers.get('Retry-After') }, { route: 'token' });
      if (error) return { ok: false, error, answered: true, invalidGrant: record(answer.body)?.error === 'invalid_grant', status: answer.status };
      const pair = readTokenPair(answer.body);
      // A 2xx the pair cannot be read from: the console may have rotated the token, so its outcome is unknown.
      if (!pair) return { ok: false, error: protocolError('the token answer has no access and refresh token'), answered: false, invalidGrant: false, status: answer.status };
      return { ok: true, pair };
    },

    async config() {
      const { body } = await call('GET', '/v1/config', null);
      const r = record(body);
      const relayUrl = str(r?.relay_url);
      if (!relayUrl) throw fail(protocolError('GET /v1/config answered without a relay_url'));
      const proof = r?.endpoint_proof;
      return { relayUrl, endpointProof: proof === 'required' || proof === 'optional' ? proof : null };
    },

    async me(access) {
      return readMe((await call('GET', '/v1/me', access)).body);
    },

    async challenge(access) {
      const { body, headers } = await call('POST', '/v1/me/endpoint/challenge', access);
      return { answer: body, date: headers.get('Date') ?? challengeIssuedAt(body) };
    },

    async putEndpoint(access, proof) {
      let answer;
      try {
        answer = await call('PUT', '/v1/me/endpoint', access, proof);
      } catch (err) {
        // 409: the key is a printer's or the orchestrator's. Nothing this browser can fix: terminal.
        const error = (err as { error?: PrinterError }).error;
        if (error?.status === 409) throw fail(printerError('protocol', 'The console refused this relay key (409)', { status: 409, detail: error.detail }));
        throw err;
      }
      const r = record(answer.body);
      const endpointId = str(r?.endpoint_id);
      if (!endpointId || endpointId !== proof.endpoint_id) throw fail(protocolError('PUT /v1/me/endpoint answered another EndpointId'));
      return { endpointId, proven: r?.proven === true };
    },

    async printers(access) {
      return readPrinters((await call('GET', '/v1/printers', access)).body);
    },

    async access(access, printer) {
      if (!HEX32_RE.test(printer)) throw fail(printerError('bad-request', 'A printer is named by its EndpointId'));
      return readGrant((await call('POST', `/v1/printers/${printer}/access`, access, undefined, { route: 'access' })).body, printer);
    },

    async nearby() {
      return readNearby((await call('GET', '/v1/links/nearby', null)).body);
    },

    async assertion(access, audience) {
      if (typeof audience !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(audience)) throw fail(printerError('bad-request', 'An assertion names its audience, a service'));
      return readAssertion((await call('POST', '/v1/me/assertion', access, { audience })).body);
    },

    async signOut(access) {
      await call('POST', '/v1/auth/sign-out', access);
    },
  };
}
