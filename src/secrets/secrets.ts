// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Muon 3D Technologies Limited
// Adapted from Muon3D Fluidd (src/services/foreign-printers/store.ts), written by Muon 3D.
//
// A printer's credentials (an API key, a password) in this browser only, and only as long as the person chooses:
//
// - Remembered (the person ticked "Remember on this device"): encrypted with AES-GCM under a key the browser made and
//   will not hand out (non-extractable), both kept in IndexedDB. Script on the page can still ask the browser to
//   decrypt them, as it can read anything else the page keeps: the key stops a copy of the stored bytes being read
//   elsewhere, not the page itself.
// - Not remembered: in this page's memory, gone when it is closed or reloaded.
//
// Each secret is found by a random reference, which is what a client stores beside its printer. Forgetting the last
// remembered secret deletes the key too. Nothing here sends anything anywhere.

/** One remembered secret as stored: the reference, the AES-GCM nonce and the ciphertext. */
export interface StoredSecret {
  ref: string;
  iv: Uint8Array;
  data: ArrayBuffer;
}

/** Where remembered secrets and their key are kept. */
export interface SecretBackend {
  key(): Promise<CryptoKey | null>;
  saveKey(key: CryptoKey): Promise<void>;
  dropKey(): Promise<void>;
  read(ref: string): Promise<StoredSecret | null>;
  write(secret: StoredSecret): Promise<void>;
  remove(ref: string): Promise<void>;
  count(): Promise<number>;
}

export type Secret = Readonly<Record<string, string>>;

export interface SecretStore {
  /** Keeps `secret`, remembered or for this page only; resolves to its reference. */
  put(secret: Secret, options: { remember: boolean }): Promise<string>;
  /** The secret, or null when there is none (forgotten, or kept only by a page that has gone). */
  get(ref: string): Promise<Secret | null>;
  /** Whether the secret is remembered on this device. */
  remembered(ref: string): Promise<boolean>;
  forget(ref: string): Promise<void>;
}

const randomRef = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

export function createSecretStore(options: {
  backend: SecretBackend;
  subtle?: SubtleCrypto;
  random?: (length: number) => Uint8Array;
}): SecretStore {
  const { backend } = options;
  const subtle = options.subtle ?? globalThis.crypto.subtle;
  const random = options.random ?? ((n: number) => globalThis.crypto.getRandomValues(new Uint8Array(n)));
  const memory = new Map<string, Secret>();
  let making: Promise<CryptoKey> | null = null;
  const theKey = async (): Promise<CryptoKey> => {
    const existing = await backend.key();
    if (existing) return existing;
    making ??= (async () => {
      const key = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      await backend.saveKey(key);
      return key;
    })().finally(() => {
      making = null;
    });
    return making;
  };
  return {
    async put(secret, { remember }) {
      const ref = randomRef(random(16));
      const clean: Record<string, string> = {};
      for (const [k, v] of Object.entries(secret)) if (typeof v === 'string' && v) clean[k] = v;
      if (!remember) {
        memory.set(ref, clean);
        return ref;
      }
      const key = await theKey();
      const iv = random(12);
      const data = await subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, new TextEncoder().encode(JSON.stringify(clean)));
      await backend.write({ ref, iv, data });
      return ref;
    },
    async get(ref) {
      const kept = memory.get(ref);
      if (kept) return kept;
      const stored = await backend.read(ref);
      if (!stored) return null;
      const key = await backend.key();
      if (!key) return null;
      try {
        const clear = await subtle.decrypt({ name: 'AES-GCM', iv: stored.iv as BufferSource }, key, stored.data);
        const value = JSON.parse(new TextDecoder().decode(clear)) as unknown;
        if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
        return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, v]) => typeof v === 'string')) as Secret;
      } catch {
        // Not this key's (the key was made again): as good as forgotten.
        return null;
      }
    },
    async remembered(ref) {
      return !memory.has(ref) && (await backend.read(ref)) !== null;
    },
    async forget(ref) {
      memory.delete(ref);
      await backend.remove(ref);
      if ((await backend.count()) === 0) await backend.dropKey();
    },
  };
}

/** The secrets in this page's memory: for tests, and for a browser without IndexedDB. */
export function memorySecretBackend(): SecretBackend & { secrets: Map<string, StoredSecret> } {
  let key: CryptoKey | null = null;
  const secrets = new Map<string, StoredSecret>();
  return {
    secrets,
    key: async () => key,
    saveKey: async (k) => void (key = k),
    dropKey: async () => void (key = null),
    read: async (ref) => secrets.get(ref) ?? null,
    write: async (s) => void secrets.set(s.ref, s),
    remove: async (ref) => void secrets.delete(ref),
    count: async () => secrets.size,
  };
}

const KEY_ID = 'main';

/** The secrets in IndexedDB: the database `database` with two stores, `secrets` (by ref) and `keys`. */
export function idbSecretBackend(factory: IDBFactory, options: { database?: string } = {}): SecretBackend {
  const name = options.database ?? 'muon3d-printer-secrets';
  let db: Promise<IDBDatabase> | null = null;
  const open = (): Promise<IDBDatabase> =>
    (db ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(name, 1);
      request.onupgradeneeded = () => {
        const d = request.result;
        if (!d.objectStoreNames.contains('secrets')) d.createObjectStore('secrets', { keyPath: 'ref' });
        if (!d.objectStoreNames.contains('keys')) d.createObjectStore('keys', { keyPath: 'id' });
      };
      request.onsuccess = () => {
        const d = request.result;
        // Another tab's upgrade closes this connection: open again next time.
        d.onversionchange = () => {
          d.close();
          db = null;
        };
        resolve(d);
      };
      request.onerror = () => {
        db = null;
        reject(request.error);
      };
    }));
  const run = async <T>(store: 'secrets' | 'keys', mode: IDBTransactionMode, act: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> => {
    const d = await open();
    return new Promise<T | undefined>((resolve, reject) => {
      const tx = d.transaction(store, mode);
      const request = act(tx.objectStore(store));
      tx.oncomplete = () => resolve(request ? request.result : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('aborted'));
    });
  };
  return {
    async key() {
      const row = (await run<{ id: string; key: CryptoKey } | undefined>('keys', 'readonly', (s) => s.get(KEY_ID))) as { key?: CryptoKey } | undefined;
      return row?.key ?? null;
    },
    saveKey: async (key) => void (await run('keys', 'readwrite', (s) => s.put({ id: KEY_ID, key }))),
    dropKey: async () => void (await run('keys', 'readwrite', (s) => s.delete(KEY_ID))),
    async read(ref) {
      const row = (await run<StoredSecret | undefined>('secrets', 'readonly', (s) => s.get(ref))) as StoredSecret | undefined;
      return row && row.iv && row.data ? row : null;
    },
    write: async (secret) => void (await run('secrets', 'readwrite', (s) => s.put(secret))),
    remove: async (ref) => void (await run('secrets', 'readwrite', (s) => s.delete(ref))),
    count: async () => (await run<number>('secrets', 'readonly', (s) => s.count())) ?? 0,
  };
}
