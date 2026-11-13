// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Muon 3D Technologies Limited
// The account's session: the rotating refresh token and the newest access token, stored (IndexedDB in a browser,
// keyed by the console's origin, with the account it belongs to and its generation), and the refresh, which never
// presents a refresh token twice.
//
// The console keeps one access token per session: a rotation replaces it, so a token another holder (another tab)
// had stops working the moment one of them refreshes. Every holder therefore uses the newest access token, read from
// the stored session (it lasts 15 minutes, beside the refresh token that outlives it), and refreshes only when the
// stored one is about to expire or a route refused it (a 401).
//
// The console rotates with no grace period and treats a reused refresh token as theft: that session ends, with its
// children. So:
// - a refresh runs under a Web Lock, one holder at a time; inside it the stored session is read again (another holder
//   may have rotated it: its access token is taken and nothing is sent), an "in flight" marker with the token's
//   generation is written, then the token is sent;
// - an answer is recorded at once: the new pair and a cleared marker (and `{event: 'rotated', generation}` on the
//   channel), unless the session ended meanwhile (a front-channel logout removes it without the lock): then the
//   answer is nobody's. invalid_grant ends the session (and the relay key, keyAfter); any other refusal in 4xx (a 429,
//   a malformed request, a 401 invalid_client) leaves the token unused and the marker cleared;
// - an outcome that is unknown (a network failure, an abort, a timeout, a 5xx, a 2xx whose pair cannot be read, or a
//   marker a later holder finds still set because its holder died with the request in flight) discards the stored
//   refresh token, never resends it: the person signs in again, at once while the console's own session lasts. The
//   relay key is kept.
// Sign-out removes the stored session under the same lock, so no refresh elsewhere writes it back. No message on the
// channel carries a token: only what happened and the generation.
import { printerError, type PrinterError } from '../errors/kinds.ts';
import { fail, failureOf } from '../errors/failure.ts';
import type { ConsoleApi } from './api.ts';

/** The account's session as stored. */
export interface SessionRecord {
  /** The console's origin. */
  console: string;
  account: string | null;
  email: string | null;
  /** The newest refresh token, or null once it was discarded (an unknown outcome) or used up. */
  refreshToken: string | null;
  /** The session's newest access token (the only one the console still takes), and when it expires (ms). */
  accessToken: string | null;
  accessExpiresAt: number;
  /** Counts the rotations (and sign-ins) of this browser's session. */
  generation: number;
  /** A refresh with the token of this generation was sent and its outcome is not recorded: never send it again. */
  inFlight: number | null;
}

export interface SessionStore {
  read(consoleOrigin: string): Promise<SessionRecord | null>;
  write(record: SessionRecord): Promise<void>;
  remove(consoleOrigin: string): Promise<void>;
}

/** What the session tells the other token holders (and the page): never a token. */
export type ConsoleEvent = { event: 'rotated'; generation: number } | { event: 'signed-in'; generation: number } | { event: 'signed-out' };

/** What happened to the account's session, as far as the relay key is concerned. */
export type KeyEvent =
  | 'sign-out' // the person signed out
  | 'front-channel-logout' // the console's logout framed the client's logout page
  | 'invalid-grant' // POST /token answered invalid_grant
  | 'refresh-unknown' // a refresh whose outcome is unknown: its refresh token is discarded
  | 'network-error' // a request that failed on the network
  | 'unauthorised' // a 401 on a /v1 route: the access token expired, a refresh comes next
  | 'console-error'; // any other error of the console (4xx, 5xx, 429)

/** Whether the relay key survives `event`: deleted only at sign-out (either way) and on invalid_grant. */
export function keyAfter(event: KeyEvent): 'keep' | 'delete' {
  return event === 'sign-out' || event === 'front-channel-logout' || event === 'invalid-grant' ? 'delete' : 'keep';
}

/** The part of navigator.locks the refresh uses. */
export interface RefreshLocks {
  request<T>(name: string, options: { mode: 'exclusive' }, callback: () => Promise<T>): Promise<T>;
}

export interface Broadcast {
  postMessage(message: ConsoleEvent): void;
}

/** How long before its expiry an access token is refreshed. */
export const ACCESS_MARGIN_MS = 30_000;

/** The Web Lock a refresh runs under, unless a client names its own. */
export const REFRESH_LOCK = 'muon3d-console-refresh';

export interface SessionOptions {
  consoleOrigin: string;
  api: ConsoleApi;
  store: SessionStore;
  locks: RefreshLocks;
  channel: Broadcast;
  /** The lock's name, shared by every holder of this session (REFRESH_LOCK by default). */
  lockName?: string;
  /** The session ended for `event` (the relay key follows keyAfter: deleted at sign-out and on invalid_grant). */
  onEnded?(event: KeyEvent): void | Promise<void>;
  now?(): number;
}

export interface SignedIn {
  account: string;
  email: string | null;
}

export interface Session {
  /** Exchanges the sign-in's code (with its verifier) at /token, then reads the account. */
  signIn(input: { code: string; verifier: string; redirectUri: string }): Promise<SignedIn>;
  /** The session's newest access token, refreshed when it is about to expire; rejects as `signed-out` when there is none. */
  access(): Promise<string>;
  /** The access token was refused (a 401 on a route): it is not used again, and the next access() refreshes. */
  dropAccess(token: string): void;
  /** Who is signed in, from the store (no request), or null. */
  who(): Promise<SignedIn | null>;
  /** POST /v1/auth/sign-out (best effort), then the session and the relay key go. */
  signOut(): Promise<void>;
  /** Another holder said what happened (the channel); returns whether this one is now signed out. */
  heard(event: ConsoleEvent): boolean;
}

const signedOut = (detail: string): PrinterError => printerError('signed-out', 'Signed out of the account', { detail });

export function createSession(options: SessionOptions): Session {
  const { consoleOrigin: origin, api, store, locks, channel } = options;
  const lockName = options.lockName ?? REFRESH_LOCK;
  const now = options.now ?? Date.now;
  /** Access tokens a route refused: never taken from the store again. */
  const refused = new Set<string>();
  let refreshing: Promise<string> | null = null;

  const broadcast = (event: ConsoleEvent) => {
    try {
      channel.postMessage(event);
    } catch {
      // The channel is closed: nobody else is listening.
    }
  };

  /** The stored access token, when it is good for more than the margin and no route refused it. */
  const usable = (record: SessionRecord | null): string | null =>
    record?.refreshToken && record.accessToken && record.accessExpiresAt - ACCESS_MARGIN_MS > now() && !refused.has(record.accessToken) ? record.accessToken : null;

  /** The stored part of the end, under the lock: an unknown outcome keeps who signed in (for the notice). */
  async function forget(event: KeyEvent, record: SessionRecord | null): Promise<void> {
    if (event === 'refresh-unknown') {
      if (record) await store.write({ ...record, refreshToken: null, accessToken: null, accessExpiresAt: 0, inFlight: null });
    } else {
      await store.remove(origin);
    }
  }

  /** The rest of the end: the key follows keyAfter, the others are told. */
  async function ended(event: KeyEvent): Promise<void> {
    refused.clear();
    await options.onEnded?.(event);
    broadcast({ event: 'signed-out' });
  }

  async function refreshNow(): Promise<string> {
    return locks.request(lockName, { mode: 'exclusive' }, async () => {
      const record = await store.read(origin);
      if (!record?.refreshToken) throw fail(signedOut('there is no session to refresh'));
      // Another holder rotated while this one waited for the lock: its access token is the session's now.
      const rotated = usable(record);
      if (rotated) return rotated;
      if (record.inFlight !== null) {
        // A holder sent this token and died before it heard back: it may have been used. Never resend it.
        await forget('refresh-unknown', record);
        await ended('refresh-unknown');
        throw fail(signedOut("the session's last refresh has an unknown outcome"));
      }
      await store.write({ ...record, inFlight: record.generation });
      const outcome = await api.token({ grant_type: 'refresh_token', refresh_token: record.refreshToken });
      if (outcome.ok) {
        // A front-channel logout removes the session without the lock: an answer for a session that ended is nobody's.
        const current = await store.read(origin);
        if (!current || current.generation !== record.generation || current.refreshToken !== record.refreshToken) throw fail(signedOut('the session ended while it was refreshed'));
        const accessToken = outcome.pair.accessToken;
        const next: SessionRecord = {
          ...record,
          refreshToken: outcome.pair.refreshToken,
          accessToken,
          accessExpiresAt: now() + outcome.pair.expiresIn * 1000,
          generation: record.generation + 1,
          inFlight: null,
        };
        await store.write(next);
        refused.clear();
        broadcast({ event: 'rotated', generation: next.generation });
        return accessToken;
      }
      if (outcome.answered && outcome.invalidGrant) {
        await forget('invalid-grant', record);
        await ended('invalid-grant');
        throw fail(signedOut('the console refused the refresh token (invalid_grant)'));
      }
      if (outcome.answered && outcome.status !== null && outcome.status >= 400 && outcome.status < 500) {
        // Refused before it was used (a 429, a malformed request, the client unknown to the console): the token stands.
        await store.write({ ...record, inFlight: null });
        throw fail(outcome.status === 401 ? printerError('console', 'The console refused this client (invalid_client)', { status: 401, detail: outcome.error.detail }) : outcome.error);
      }
      await forget('refresh-unknown', record);
      await ended('refresh-unknown');
      throw fail(signedOut("the session's refresh has an unknown outcome"));
    });
  }

  const session: Session = {
    async signIn({ code, verifier, redirectUri }) {
      const outcome = await api.token({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier });
      if (!outcome.ok) {
        // A code refused is not a session ended: say the console refused it.
        const error =
          outcome.error.kind === 'signed-out' ? printerError('console', 'The console refused the sign-in code', { status: outcome.status ?? undefined, detail: outcome.error.detail }) : outcome.error;
        throw fail(error);
      }
      const accessToken = outcome.pair.accessToken;
      const accessExpiresAt = now() + outcome.pair.expiresIn * 1000;
      const me = await api.me(accessToken);
      const generation = await locks.request(lockName, { mode: 'exclusive' }, async () => {
        const before = await store.read(origin);
        const next = (before?.generation ?? 0) + 1;
        await store.write({ console: origin, account: me.account, email: me.email, refreshToken: outcome.pair.refreshToken, accessToken, accessExpiresAt, generation: next, inFlight: null });
        return next;
      });
      refused.clear();
      broadcast({ event: 'signed-in', generation });
      return { account: me.account, email: me.email };
    },

    async access() {
      const stored = usable(await store.read(origin));
      if (stored) return stored;
      refreshing ??= refreshNow().finally(() => {
        refreshing = null;
      });
      return refreshing;
    },

    dropAccess(token) {
      refused.add(token);
    },

    async who() {
      const record = await store.read(origin);
      return record?.refreshToken && record.account ? { account: record.account, email: record.email } : null;
    },

    async signOut() {
      let access: string | null = null;
      try {
        access = await session.access();
      } catch {
        // No session left to end at the console: the local one still goes.
      }
      if (access) await api.signOut(access).catch(() => undefined);
      try {
        await locks.request(lockName, { mode: 'exclusive' }, async () => forget('sign-out', await store.read(origin).catch(() => null)));
      } finally {
        await ended('sign-out');
      }
    },

    heard(event) {
      return event.event === 'signed-out';
    },
  };
  return session;
}

/** Whether a failure is `signed-out`: the session ended under it. */
export const isSignedOut = (err: unknown): boolean => failureOf(err).kind === 'signed-out';

// ---------------------------------------------------------------------------------------------------------------------
// The stores
// ---------------------------------------------------------------------------------------------------------------------

/** A store in memory (tests, and a client that keeps no session across reloads). */
export function memorySessionStore(initial: SessionRecord[] = []): SessionStore & { records: Map<string, SessionRecord> } {
  const records = new Map(initial.map((r) => [r.console, { ...r }]));
  return {
    records,
    read: async (origin) => (records.has(origin) ? { ...(records.get(origin) as SessionRecord) } : null),
    write: async (record) => void records.set(record.console, { ...record }),
    remove: async (origin) => void records.delete(origin),
  };
}

const request = <T>(req: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

const done = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('The storage transaction was aborted'));
    tx.onerror = () => reject(tx.error);
  });

/** The database a session is kept in, unless a client names its own, and its object store. */
export const ACCOUNT_DB = 'muon3d-account';
export const SESSIONS_STORE = 'sessions';

/** Opens (creating or upgrading) the session database: version 1 creates the sessions store. */
export function openAccountDb(factory: IDBFactory, name = ACCOUNT_DB, storeName = SESSIONS_STORE): Promise<IDBDatabase> {
  const steps: readonly ((db: IDBDatabase) => void)[] = [(db) => db.createObjectStore(storeName, { keyPath: 'console' })];
  return new Promise((resolve, reject) => {
    let req: IDBOpenDBRequest;
    try {
      req = factory.open(name, steps.length);
    } catch (err) {
      reject(err);
      return;
    }
    req.onupgradeneeded = (event) => {
      for (let v = event.oldVersion; v < steps.length; v++) steps[v](req.result);
    };
    req.onerror = () => reject(req.error ?? new Error('The browser did not open its storage'));
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
  });
}

/**
 * The session in IndexedDB (`database`, ACCOUNT_DB by default; a client that already keeps sessions names its own). A
 * failure of the storage reads as `signed-out` (sign in again), never as a session.
 */
export function idbSessionStore(factory: IDBFactory, options: { database?: string; store?: string } = {}): SessionStore {
  const database = options.database ?? ACCOUNT_DB;
  const storeName = options.store ?? SESSIONS_STORE;
  let db: Promise<IDBDatabase> | null = null;
  const unreadable = (err: unknown) => fail(signedOut(`the session could not be read: ${err instanceof Error ? err.message : String(err)}`));
  async function open(mode: IDBTransactionMode): Promise<{ tx: IDBTransaction; store: IDBObjectStore }> {
    for (let attempt = 0; ; attempt++) {
      db ??= openAccountDb(factory, database, storeName).catch((err: unknown) => {
        db = null;
        throw unreadable(err);
      });
      const connection = await db;
      try {
        const tx = connection.transaction(storeName, mode);
        return { tx, store: tx.objectStore(storeName) };
      } catch (err) {
        // Closed for another tab's upgrade: open again once.
        db = null;
        if (attempt > 0) throw unreadable(err);
      }
    }
  }
  return {
    async read(origin) {
      const { store: s } = await open('readonly');
      try {
        const value = (await request(s.get(origin))) as Partial<SessionRecord> | undefined;
        if (!value || value.console !== origin) return null;
        return {
          console: origin,
          account: typeof value.account === 'string' ? value.account : null,
          email: typeof value.email === 'string' ? value.email : null,
          refreshToken: typeof value.refreshToken === 'string' && value.refreshToken ? value.refreshToken : null,
          accessToken: typeof value.accessToken === 'string' && value.accessToken ? value.accessToken : null,
          accessExpiresAt: typeof value.accessExpiresAt === 'number' && Number.isFinite(value.accessExpiresAt) ? value.accessExpiresAt : 0,
          generation: typeof value.generation === 'number' ? value.generation : 0,
          inFlight: typeof value.inFlight === 'number' ? value.inFlight : null,
        };
      } catch (err) {
        throw unreadable(err);
      }
    },
    async write(record) {
      const { tx, store: s } = await open('readwrite');
      s.put({ ...record });
      await done(tx).catch((err: unknown) => {
        throw unreadable(err);
      });
    },
    async remove(origin) {
      const { tx, store: s } = await open('readwrite');
      s.delete(origin);
      await done(tx).catch((err: unknown) => {
        throw unreadable(err);
      });
    },
  };
}
