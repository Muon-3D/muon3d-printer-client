// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Muon 3D Technologies Limited
// The account's session (tokens.ts): the refresh never presents a refresh token twice, not after an abort once the
// request was sent, not after a holder died with it in flight, not after a 2xx it could not read; it runs one holder
// at a time under the lock, and a second holder takes the access token the first rotated (the console keeps one per
// session); invalid_grant ends the session and the key, an unknown outcome only the token, a 401 invalid_client
// neither; sign-out is not undone by a refresh in flight elsewhere; and no broadcast carries a token.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { failureOf } from '../errors/failure.ts';
import type { ConsoleApi, TokenGrant, TokenOutcome } from './api.ts';
import { createSession, idbSessionStore, keyAfter, memorySessionStore, type ConsoleEvent, type KeyEvent, type RefreshLocks, type SessionRecord } from './tokens.ts';

const CONSOLE = 'https://console.example';

// ---------------------------------------------------------------------------------------------------------------------
// An IndexedDB in this process: what idbSessionStore uses of it (open with an upgrade, one store keyed by a path,
// get, put and delete in transactions that complete after their requests), with each database shared by every
// connection to it, as two tabs share one.
// ---------------------------------------------------------------------------------------------------------------------

type Handler = ((event?: unknown) => void) | null;
interface FakeRequest {
  result: unknown;
  error: unknown;
  onsuccess: Handler;
  onerror: Handler;
  onupgradeneeded?: Handler;
}

function fakeIndexedDB(): IDBFactory {
  const databases = new Map<string, { version: number; stores: Map<string, { keyPath: string; data: Map<unknown, unknown> }> }>();
  const later = (fn: () => void) => setTimeout(fn, 0);

  function connection(db: { stores: Map<string, { keyPath: string; data: Map<unknown, unknown> }> }) {
    return {
      onversionchange: null as Handler,
      close() {},
      createObjectStore(name: string, options: { keyPath: string }) {
        db.stores.set(name, { keyPath: options.keyPath, data: new Map() });
      },
      transaction(name: string) {
        const store = db.stores.get(name);
        if (!store) throw new DOMException(`No store ${name}`, 'NotFoundError');
        let pending = 0;
        let completed = false;
        const tx = { oncomplete: null as Handler, onerror: null as Handler, onabort: null as Handler, error: null, objectStore: () => objectStore };
        const settle = () =>
          later(() => {
            if (pending === 0 && !completed) {
              completed = true;
              tx.oncomplete?.();
            }
          });
        const op = (work: () => unknown): FakeRequest => {
          pending++;
          const req: FakeRequest = { result: undefined, error: null, onsuccess: null, onerror: null };
          later(() => {
            req.result = work();
            pending--;
            req.onsuccess?.();
            settle();
          });
          return req;
        };
        const objectStore = {
          get: (key: unknown) => op(() => structuredClone(store.data.get(key))),
          put: (value: Record<string, unknown>) => op(() => void store.data.set(value[store.keyPath], structuredClone(value))),
          delete: (key: unknown) => op(() => void store.data.delete(key)),
        };
        settle();
        return tx;
      },
    };
  }

  return {
    open(name: string, version: number) {
      const req: FakeRequest = { result: undefined, error: null, onsuccess: null, onerror: null, onupgradeneeded: null };
      later(() => {
        let db = databases.get(name);
        if (!db) {
          db = { version: 0, stores: new Map() };
          databases.set(name, db);
        }
        req.result = connection(db);
        if (version > db.version) {
          const oldVersion = db.version;
          db.version = version;
          req.onupgradeneeded?.({ oldVersion });
        }
        req.onsuccess?.();
      });
      return req;
    },
  } as unknown as IDBFactory;
}

// ---------------------------------------------------------------------------------------------------------------------

/** Whether `value` holds a string shaped like a credential (a bearer token, a JWT, a long opaque token). */
function tokenShaped(value: unknown, path = ''): string | null {
  if (typeof value === 'string') {
    if (/\bbearer\s+\S/i.test(value)) return path || 'a bearer token';
    if (/^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/.test(value)) return path || 'a JWT';
    if (/^[0-9a-f]{64}$/.test(value)) return null;
    if (/^[A-Za-z0-9_\-+/=.~]{32,}$/.test(value) && !/^[0-9a-f]+$/.test(value) && !value.includes('/')) return path || 'a long opaque token';
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  for (const [k, v] of Object.entries(value)) {
    if (/token|secret|seed|password|verifier|authorization/i.test(k) && v !== null && v !== undefined && v !== '') return `${path}.${k}`;
    const found = tokenShaped(v, `${path}.${k}`);
    if (found) return found;
  }
  return null;
}

/** A Web Lock in this process: one holder at a time, the rest wait in order. */
function processLocks(): RefreshLocks & { names: string[] } {
  let tail: Promise<unknown> = Promise.resolve();
  const names: string[] = [];
  return {
    names,
    request<T>(name: string, _options: { mode: 'exclusive' }, callback: () => Promise<T>): Promise<T> {
      names.push(name);
      const run = tail.then(callback);
      tail = run.catch(() => undefined);
      return run;
    },
  };
}

/** A console's token endpoint: rotates; `next` decides each refresh's outcome. */
function consoleStub(options: { next?: (grant: TokenGrant) => Promise<TokenOutcome> | TokenOutcome } = {}) {
  const sent: TokenGrant[] = [];
  let n = 0;
  const pair = () => {
    n++;
    return { ok: true as const, pair: { accessToken: `access-${'x'.repeat(30)}-${n}`, refreshToken: `refresh-${'y'.repeat(30)}-${n}`, expiresIn: 900 } };
  };
  const api: ConsoleApi = {
    origin: CONSOLE,
    clientId: 'slicer',
    async token(grant) {
      sent.push(grant);
      if (grant.grant_type === 'refresh_token' && options.next) return options.next(grant);
      return pair();
    },
    config: async () => ({ relayUrl: 'https://relay.example/', endpointProof: 'required' }),
    me: async () => ({ account: 'acct-1', email: 'p@example.test', endpointId: null, endpointProven: null }),
    challenge: async () => ({ answer: null, date: null }),
    putEndpoint: async () => ({ endpointId: '', proven: true }),
    printers: async () => [],
    access: async () => {
      throw new Error('not here');
    },
    nearby: async () => [],
    assertion: async () => ({ assertion: 'a', expiresAt: 0 }),
    signOut: async () => {},
  };
  return { api, sent, pair };
}

function harness(over: { next?: (grant: TokenGrant) => Promise<TokenOutcome> | TokenOutcome; store?: ReturnType<typeof memorySessionStore>; locks?: RefreshLocks; lockName?: string } = {}) {
  const { api, sent, pair } = consoleStub({ next: over.next });
  const store = over.store ?? memorySessionStore();
  const locks = over.locks ?? processLocks();
  const broadcasts: ConsoleEvent[] = [];
  const ended: KeyEvent[] = [];
  let clock = 1_000_000;
  const session = createSession({
    consoleOrigin: CONSOLE,
    api,
    store,
    locks,
    lockName: over.lockName,
    channel: { postMessage: (m) => broadcasts.push(m) },
    onEnded: (e) => void ended.push(e),
    now: () => clock,
  });
  return { session, store, sent, broadcasts, ended, pair, advance: (ms: number) => (clock += ms), refreshes: () => sent.filter((g) => g.grant_type === 'refresh_token') };
}

const signedIn = (generation = 1, over: Partial<SessionRecord> = {}): SessionRecord => ({
  console: CONSOLE,
  account: 'acct-1',
  email: 'p@example.test',
  refreshToken: 'refresh-stored-0000000000000000000000',
  accessToken: null,
  accessExpiresAt: 0,
  generation,
  inFlight: null,
  ...over,
});

const failure = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (err) {
    return failureOf(err);
  }
  assert.fail('expected a failure');
};

describe('the session', () => {
  it('signs in with the code and its verifier; stores the refresh token and the newest access token with its expiry', async () => {
    const h = harness();
    const who = await h.session.signIn({ code: 'code-1', verifier: 'v'.repeat(43), redirectUri: 'https://slicer.example/auth/callback.html' });
    assert.deepEqual(who, { account: 'acct-1', email: 'p@example.test' });
    assert.deepEqual(h.sent[0], { grant_type: 'authorization_code', code: 'code-1', redirect_uri: 'https://slicer.example/auth/callback.html', code_verifier: 'v'.repeat(43) });
    const record = await h.store.read(CONSOLE);
    assert.ok(record?.refreshToken?.startsWith('refresh-'));
    assert.ok(record?.accessToken?.startsWith('access-'), 'every holder uses the newest access token');
    assert.equal(record?.accessExpiresAt, 1_000_000 + 900_000);
    // The access token is used until it is about to expire, then refreshed once.
    assert.ok((await h.session.access()).startsWith('access-'));
    assert.equal(h.refreshes().length, 0);
    h.advance(900_000);
    await h.session.access();
    assert.equal(h.refreshes().length, 1);
    assert.deepEqual(h.broadcasts.map((b) => b.event), ['signed-in', 'rotated']);
  });

  it('a code the console refuses is the console refusing, not a session that ended', async () => {
    const { api } = consoleStub();
    const refusing: ConsoleApi = { ...api, token: async () => ({ ok: false, error: { kind: 'signed-out', message: 'invalid_grant', detail: 'used' }, answered: true, invalidGrant: true, status: 400 }) };
    const session = createSession({ consoleOrigin: CONSOLE, api: refusing, store: memorySessionStore(), locks: processLocks(), channel: { postMessage: () => undefined } });
    const error = await failure(session.signIn({ code: 'c', verifier: 'v'.repeat(43), redirectUri: 'https://s.example/' }));
    assert.deepEqual([error.kind, error.status, error.detail], ['console', 400, 'used']);
  });

  it('rotates: each refresh presents the newest stored token once, and stores its successor', async () => {
    const h = harness({ store: memorySessionStore([signedIn()]) });
    await h.session.access();
    const first = (await h.store.read(CONSOLE))!;
    assert.equal(first.generation, 2);
    h.advance(900_000);
    await h.session.access();
    const tokens = h.refreshes().map((g) => (g as { refresh_token: string }).refresh_token);
    assert.deepEqual(tokens, ['refresh-stored-0000000000000000000000', first.refreshToken]);
    assert.equal(new Set(tokens).size, tokens.length);
  });

  it('two calls at once refresh once, under the lock the client names', async () => {
    const locks = processLocks();
    const h = harness({ store: memorySessionStore([signedIn()]), locks, lockName: 'my-app-refresh' });
    const [a, b] = await Promise.all([h.session.access(), h.session.access()]);
    assert.equal(a, b);
    assert.equal(h.refreshes().length, 1);
    assert.deepEqual(locks.names, ['my-app-refresh']);
  });

  it('a refresh aborted after it was sent discards the token: a later refresh never presents it again (signed out)', async () => {
    const h = harness({
      store: memorySessionStore([signedIn()]),
      // Sent, then the answer never comes back (an abort, a timeout, the network).
      next: () => ({ ok: false, error: { kind: 'signed-out', message: "The session's refresh has an unknown outcome" }, answered: false, invalidGrant: false, status: null }),
    });
    assert.equal((await failure(h.session.access())).kind, 'signed-out');
    assert.equal(h.refreshes().length, 1);
    const record = await h.store.read(CONSOLE);
    assert.equal(record?.refreshToken, null);
    assert.equal(record?.account, 'acct-1', 'who signed in stays, for the notice');
    assert.equal((await failure(h.session.access())).kind, 'signed-out');
    assert.equal(h.refreshes().length, 1, 'the old token is never sent again');
    // The key is kept on an unknown outcome (keyAfter).
    assert.deepEqual(h.ended, ['refresh-unknown']);
    assert.equal(keyAfter('refresh-unknown'), 'keep');
    assert.deepEqual(h.broadcasts.map((b) => b.event), ['signed-out']);
  });

  it('a 5xx answer is an unknown outcome too', async () => {
    const h = harness({ store: memorySessionStore([signedIn()]), next: () => ({ ok: false, error: { kind: 'console', message: '502' }, answered: true, invalidGrant: false, status: 502 }) });
    assert.equal((await failure(h.session.access())).kind, 'signed-out');
    assert.equal((await h.store.read(CONSOLE))?.refreshToken, null);
  });

  it('a holder that died with the request in flight (its marker still set): the next holder discards the token unsent', async () => {
    const h = harness({ store: memorySessionStore([signedIn(3, { inFlight: 3 })]) });
    assert.equal((await failure(h.session.access())).kind, 'signed-out');
    assert.equal(h.refreshes().length, 0);
    assert.equal((await h.store.read(CONSOLE))?.refreshToken, null);
  });

  it('the marker is written before the token is sent, and cleared with the answer', async () => {
    let seen: SessionRecord | null = null;
    const store = memorySessionStore([signedIn(5)]);
    const h = harness({
      store,
      next: async () => {
        seen = await store.read(CONSOLE);
        return { ok: true, pair: { accessToken: 'a'.repeat(40), refreshToken: 'r'.repeat(40), expiresIn: 900 } };
      },
    });
    await h.session.access();
    assert.equal(seen!.inFlight, 5);
    assert.equal((await store.read(CONSOLE))?.inFlight, null);
  });

  it('invalid_grant ends the session and the relay key; a 429 leaves the token unused', async () => {
    const refused = harness({ store: memorySessionStore([signedIn()]), next: () => ({ ok: false, error: { kind: 'signed-out', message: 'invalid_grant' }, answered: true, invalidGrant: true, status: 400 }) });
    assert.equal((await failure(refused.session.access())).kind, 'signed-out');
    assert.equal(await refused.store.read(CONSOLE), null);
    assert.deepEqual(refused.ended, ['invalid-grant']);
    assert.equal(keyAfter('invalid-grant'), 'delete');

    const limited = harness({ store: memorySessionStore([signedIn()]), next: () => ({ ok: false, error: { kind: 'console', message: '429', status: 429, retryAfterS: 5 }, answered: true, invalidGrant: false, status: 429 }) });
    assert.equal((await failure(limited.session.access())).kind, 'console');
    const kept = await limited.store.read(CONSOLE);
    assert.equal(kept?.refreshToken, 'refresh-stored-0000000000000000000000');
    assert.equal(kept?.inFlight, null);
    assert.deepEqual(limited.ended, []);
  });

  it('two tabs, one store and one lock: the second takes the access token the first rotated, and sends nothing', async () => {
    const factory = fakeIndexedDB();
    const shared = idbSessionStore(factory);
    await shared.write(signedIn());
    const locks = processLocks();
    const presented: string[] = [];
    const counting = (grant: TokenGrant) => {
      presented.push((grant as { refresh_token: string }).refresh_token);
      return { ok: true as const, pair: { accessToken: `access-${presented.length}`.padEnd(40, 'z'), refreshToken: `refresh-${presented.length}`.padEnd(40, 'z'), expiresIn: 900 } };
    };
    const a = harness({ store: shared as ReturnType<typeof memorySessionStore>, locks, next: counting });
    const b = harness({ store: idbSessionStore(factory) as ReturnType<typeof memorySessionStore>, locks, next: counting });
    const [ta, tb] = await Promise.all([a.session.access(), b.session.access()]);
    assert.deepEqual(presented, ['refresh-stored-0000000000000000000000']);
    assert.equal(ta, tb, 'both hold the one access token the console still takes');
    assert.equal((await shared.read(CONSOLE))?.generation, 2);
    // Expired for both: the next holder rotates with the newest refresh token, never the old one.
    a.advance(900_000);
    b.advance(900_000);
    await Promise.all([a.session.access(), b.session.access()]);
    assert.deepEqual(presented, ['refresh-stored-0000000000000000000000', 'refresh-1'.padEnd(40, 'z')]);
  });

  it('the IndexedDB store keeps a session per console in the database the client names, and reads nothing else as one', async () => {
    const factory = fakeIndexedDB();
    const store = idbSessionStore(factory, { database: 'my-app:account' });
    assert.equal(await store.read(CONSOLE), null);
    await store.write(signedIn(4, { accessToken: 'a'.repeat(40), accessExpiresAt: 5 }));
    assert.deepEqual(await idbSessionStore(factory, { database: 'my-app:account' }).read(CONSOLE), signedIn(4, { accessToken: 'a'.repeat(40), accessExpiresAt: 5 }));
    assert.equal(await idbSessionStore(factory).read(CONSOLE), null, 'another database');
    await store.remove(CONSOLE);
    assert.equal(await store.read(CONSOLE), null);
  });

  it("a console with one access token per session: one holder's refresh never makes the other refresh again", async () => {
    // A rotation replaces the session's access token; only the newest is taken.
    const store = memorySessionStore([signedIn()]);
    const locks = processLocks();
    let current: string | null = null;
    let n = 0;
    const rotate = () => {
      n++;
      current = `access-${n}`.padEnd(40, 'q');
      return { ok: true as const, pair: { accessToken: current, refreshToken: `refresh-${n}`.padEnd(40, 'q'), expiresIn: 900 } };
    };
    const a = harness({ store, locks, next: rotate });
    const b = harness({ store, locks, next: rotate });
    /** A route: 401 for any token but the session's newest; the caller drops it and asks once more. */
    const route = async (h: typeof a) => {
      const token = await h.session.access();
      if (token === current) return 'ok';
      h.session.dropAccess(token);
      return (await h.session.access()) === current ? 'ok after one retry' : '401 twice';
    };
    assert.equal(await route(a), 'ok');
    assert.equal(await route(b), 'ok');
    // a's token expires and it rotates; b still asks with what it had: it reads the newest, without a refresh.
    a.advance(900_000);
    assert.equal(await route(a), 'ok');
    assert.equal(await route(b), 'ok');
    for (let i = 0; i < 4; i++) {
      assert.equal(await route(i % 2 ? b : a), 'ok');
    }
    assert.equal(n, 2, 'one rotation at the first use, one at the expiry: none for the other holder');
  });

  it('a 2xx whose pair cannot be read is an unknown outcome: the token is discarded, never presented again', async () => {
    const h = harness({
      store: memorySessionStore([signedIn()]),
      // As createConsoleApi answers a 200 with token_type DPoP (or a field missing): not answered, the outcome unknown.
      next: () => ({ ok: false, error: { kind: 'protocol', message: 'the token answer has no access and refresh token' }, answered: false, invalidGrant: false, status: 200 }),
    });
    assert.equal((await failure(h.session.access())).kind, 'signed-out');
    assert.equal((await failure(h.session.access())).kind, 'signed-out');
    assert.equal(h.refreshes().length, 1, 'presented once');
    assert.equal((await h.store.read(CONSOLE))?.refreshToken, null);
  });

  it('a 401 invalid_client at /token leaves the token unused and the key in place (a console refusal, not a session end)', async () => {
    const h = harness({ store: memorySessionStore([signedIn()]), next: () => ({ ok: false, error: { kind: 'signed-out', message: 'The account session has ended', status: 401 }, answered: true, invalidGrant: false, status: 401 }) });
    const error = await failure(h.session.access());
    assert.equal(error.kind, 'console');
    assert.equal((await h.store.read(CONSOLE))?.refreshToken, 'refresh-stored-0000000000000000000000');
    assert.deepEqual(h.ended, []);
  });

  it('a session signed out while its refresh was on its way is not written back (a front-channel logout)', async () => {
    const store = memorySessionStore([signedIn()]);
    const h = harness({
      store,
      next: async () => {
        // The logout page removes the session without the lock.
        await store.remove(CONSOLE);
        return { ok: true, pair: { accessToken: 'a'.repeat(40), refreshToken: 'r'.repeat(40), expiresIn: 900 } };
      },
    });
    assert.equal((await failure(h.session.access())).kind, 'signed-out');
    assert.equal(await store.read(CONSOLE), null);
  });

  it("sign-out waits for another holder's refresh under the lock, and that refresh does not bring the session back", async () => {
    const store = memorySessionStore([signedIn()]);
    const locks = processLocks();
    let answer!: () => void;
    const slow = harness({
      store,
      locks,
      next: () =>
        new Promise((resolve) => {
          answer = () => resolve({ ok: true, pair: { accessToken: 'a'.repeat(40), refreshToken: 'r'.repeat(40), expiresIn: 900 } });
        }),
    });
    const other = harness({ store, locks });
    const refreshing = slow.session.access();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const signingOut = other.session.signOut();
    await new Promise((resolve) => setTimeout(resolve, 5));
    answer();
    await refreshing;
    await signingOut;
    assert.equal(await store.read(CONSOLE), null);
    assert.equal(await slow.session.who(), null);
  });

  it('sign-out ends the console session (best effort), the stored session and the key; it is broadcast', async () => {
    const h = harness({ store: memorySessionStore([signedIn()]) });
    await h.session.signOut();
    assert.equal(await h.store.read(CONSOLE), null);
    assert.deepEqual(h.ended, ['sign-out']);
    assert.equal(keyAfter('sign-out'), 'delete');
    assert.equal(h.broadcasts.at(-1)?.event, 'signed-out');
    assert.equal(await h.session.who(), null);
    assert.equal(h.session.heard({ event: 'signed-out' }), true);
    assert.equal(h.session.heard({ event: 'rotated', generation: 3 }), false);
  });

  it('no broadcast carries a token-shaped string', async () => {
    const h = harness();
    await h.session.signIn({ code: 'c', verifier: 'v'.repeat(43), redirectUri: 'https://s.example/auth/callback.html' });
    h.advance(900_000);
    await h.session.access();
    await h.session.signOut();
    assert.ok(h.broadcasts.length >= 3);
    for (const message of h.broadcasts) assert.equal(tokenShaped(message), null, JSON.stringify(message));
    assert.equal(Object.keys(h.broadcasts[1]).sort().join(), 'event,generation');
    assert.equal(tokenShaped({ token: 'x' }), '.token', 'the check itself finds a token');
  });
});
