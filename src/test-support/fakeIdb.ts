// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Muon 3D Technologies Limited
// Enough of IndexedDB for the tests: databases with keyPath stores, get, put, delete and count, each answered on a
// later turn, and a transaction that completes once its requests have. Values are kept as given (a CryptoKey too).
// Not published (package.json `files`).

type Handler = ((event?: unknown) => void) | null;

interface FakeRequest {
  result: unknown;
  error: unknown;
  onsuccess: Handler;
  onerror: Handler;
  onupgradeneeded?: Handler;
}

type Store = { keyPath: string; data: Map<unknown, unknown> };

export function fakeIndexedDB(): IDBFactory & { databases: Map<string, { version: number; stores: Map<string, Store> }> } {
  const databases = new Map<string, { version: number; stores: Map<string, Store> }>();
  const later = (fn: () => void) => setTimeout(fn, 0);
  function connection(db: { stores: Map<string, Store> }) {
    return {
      onversionchange: null as Handler,
      close() {},
      objectStoreNames: { contains: (name: string) => db.stores.has(name) },
      createObjectStore(name: string, options: { keyPath: string }) {
        db.stores.set(name, { keyPath: options.keyPath, data: new Map() });
      },
      transaction(name: string) {
        const store = db.stores.get(name);
        if (!store) throw new Error(`No store ${name}`);
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
          get: (key: unknown) => op(() => store.data.get(key)),
          put: (value: Record<string, unknown>) => op(() => void store.data.set(value[store.keyPath], value)),
          delete: (key: unknown) => op(() => void store.data.delete(key)),
          count: () => op(() => store.data.size),
        };
        settle();
        return tx;
      },
    };
  }
  const factory = {
    databases,
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
          db.version = version;
          req.onupgradeneeded?.({});
        }
        req.onsuccess?.();
      });
      return req;
    },
  };
  return factory as unknown as IDBFactory & { databases: typeof databases };
}
