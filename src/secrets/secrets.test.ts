// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Muon 3D Technologies Limited
// A printer's credentials (secrets.ts): remembered ones encrypted under a key the browser will not hand out, others in
// the page's memory only; forgetting the last remembered one deletes the key.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fakeIndexedDB } from '../test-support/fakeIdb.ts';
import { createSecretStore, idbSecretBackend, memorySecretBackend } from './secrets.ts';

describe('the secret store', () => {
  it('remembered: encrypted at rest, read back, with a key that cannot be exported', async () => {
    const backend = memorySecretBackend();
    const store = createSecretStore({ backend });
    const ref = await store.put({ apiKey: 'OCTO-123456' }, { remember: true });
    assert.match(ref, /^[0-9a-f]{32}$/);
    const stored = backend.secrets.get(ref)!;
    assert.equal(stored.iv.length, 12);
    assert.equal(Buffer.from(stored.data).toString('latin1').includes('OCTO-123456'), false, 'never in clear');
    assert.deepEqual(await store.get(ref), { apiKey: 'OCTO-123456' });
    assert.equal(await store.remembered(ref), true);
    const key = await backend.key();
    assert.equal(key?.extractable, false);
    await assert.rejects(globalThis.crypto.subtle.exportKey('raw', key!));
  });

  it('not remembered: in this page only; a new page (a new store) has nothing', async () => {
    const backend = memorySecretBackend();
    const store = createSecretStore({ backend });
    const ref = await store.put({ apiKey: 'k' }, { remember: false });
    assert.deepEqual(await store.get(ref), { apiKey: 'k' });
    assert.equal(await store.remembered(ref), false);
    assert.equal(backend.secrets.size, 0);
    assert.equal(await backend.key(), null, 'no key made for nothing');
    assert.equal(await createSecretStore({ backend }).get(ref), null);
  });

  it('forget: the secret goes, and with the last one, the key', async () => {
    const backend = memorySecretBackend();
    const store = createSecretStore({ backend });
    const a = await store.put({ apiKey: 'a' }, { remember: true });
    const b = await store.put({ apiKey: 'b' }, { remember: true });
    await store.forget(a);
    assert.equal(await store.get(a), null);
    assert.notEqual(await backend.key(), null);
    await store.forget(b);
    assert.equal(await backend.key(), null);
    assert.equal(await store.get(b), null);
  });

  it('a secret under another key (the key made again) reads as forgotten; empty values are not kept', async () => {
    const backend = memorySecretBackend();
    const store = createSecretStore({ backend });
    const ref = await store.put({ apiKey: 'x', password: '' }, { remember: true });
    assert.deepEqual(await store.get(ref), { apiKey: 'x' });
    await backend.saveKey(await globalThis.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']));
    assert.equal(await store.get(ref), null);
  });

  it('two puts at once make one key', async () => {
    const backend = memorySecretBackend();
    let made = 0;
    const subtle = globalThis.crypto.subtle;
    const counting = new Proxy(subtle, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target);
        if (prop === 'generateKey') return (...args: unknown[]) => (made++, (value as (...a: unknown[]) => unknown).apply(target, args));
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const store = createSecretStore({ backend, subtle: counting });
    await Promise.all([store.put({ apiKey: '1' }, { remember: true }), store.put({ apiKey: '2' }, { remember: true })]);
    assert.equal(made, 1);
  });

  it('in IndexedDB: the secret and its key in their own database, read back by a new page', async () => {
    const idb = fakeIndexedDB();
    const store = createSecretStore({ backend: idbSecretBackend(idb, { database: 'test-secrets' }) });
    const ref = await store.put({ apiKey: 'remembered' }, { remember: true });
    const later = createSecretStore({ backend: idbSecretBackend(idb, { database: 'test-secrets' }) });
    assert.deepEqual(await later.get(ref), { apiKey: 'remembered' });
    const stores = idb.databases.get('test-secrets')!.stores;
    assert.deepEqual([...stores.keys()].sort(), ['keys', 'secrets']);
    assert.equal(stores.get('secrets')!.data.size, 1);
    await later.forget(ref);
    assert.equal(stores.get('secrets')!.data.size, 0);
    assert.equal(stores.get('keys')!.data.size, 0);
  });
});
