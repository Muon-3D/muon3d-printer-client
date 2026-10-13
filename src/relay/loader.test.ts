// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Muon 3D Technologies Limited
// Loading a pinned binding (loader.ts) and the endpoint per relay (endpoint.ts): both files fetched and checked against
// the pin before anything runs, the glue imported with the pin's hash in its query and started from the checked wasm;
// and one endpoint per relay, bound with this browser's key, made once.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { failureOf } from '../errors/failure.ts';
import type { Binding, BindingEndpoint, BindingSession } from './binding.ts';
import { createEndpointHolder } from './endpoint.ts';
import { loadPinnedBinding, pinnedImportUrl, type BindingPin } from './loader.ts';

const JS = new TextEncoder().encode('export default async function init() {}');
const WASM = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const PIN: BindingPin = {
  js: 'https://slicer.example/vendor/muon-link-web/01d80c0/muon_link_web.js',
  wasm: 'https://slicer.example/vendor/muon-link-web/01d80c0/muon_link_web_bg.wasm',
  sha256: { js: sha(JS), wasm: sha(WASM) },
};

/** A binding module: started with the wasm's bytes, an endpoint that records what it was made with. */
function bindingModule(started: unknown[] = []) {
  return {
    default: async (init: unknown) => void started.push(init),
    MuonEndpoint: { create: async () => ({}) },
  };
}

const files = (over: Record<string, Uint8Array> = {}) => async (url: string) => {
  const all: Record<string, Uint8Array> = { [PIN.js]: JS, [PIN.wasm]: WASM, ...over };
  if (!all[url]) throw new Error(`404 ${url}`);
  return all[url];
};

const rejection = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (err) {
    return failureOf(err);
  }
  assert.fail('expected a rejection');
};

describe('loadPinnedBinding', () => {
  it('checks both files, imports the glue with the hash in its query, and starts the wasm from the checked bytes', async () => {
    const imported: string[] = [];
    const started: unknown[] = [];
    const binding = await loadPinnedBinding(PIN, {
      fetchBytes: files(),
      importModule: async (url) => {
        imported.push(url);
        return bindingModule(started);
      },
    });
    assert.equal(typeof binding.MuonEndpoint.create, 'function');
    assert.deepEqual(imported, [`${PIN.js}?sha256=${PIN.sha256.js}`]);
    assert.equal(pinnedImportUrl(PIN), imported[0]);
    assert.deepEqual(started, [{ module_or_path: WASM }]);
  });

  it('refuses a file that is not the pinned one before anything runs', async () => {
    let imported = 0;
    const importModule = async () => {
      imported++;
      return bindingModule();
    };
    const glue = await rejection(loadPinnedBinding(PIN, { fetchBytes: files({ [PIN.js]: new TextEncoder().encode('evil') }), importModule }));
    assert.deepEqual([glue.kind, glue.detail], ['protocol', PIN.js]);
    const wasm = await rejection(loadPinnedBinding(PIN, { fetchBytes: files({ [PIN.wasm]: new Uint8Array([1]) }), importModule }));
    assert.deepEqual([wasm.kind, wasm.detail], ['protocol', PIN.wasm]);
    assert.equal(imported, 0);
  });

  it('a pin that is not one is a bad request; a file that cannot be had, imported or started is unreachable', async () => {
    assert.equal((await rejection(loadPinnedBinding({ ...PIN, js: 'muon_link_web.js' }))).kind, 'bad-request');
    assert.equal((await rejection(loadPinnedBinding({ ...PIN, sha256: { js: 'abc', wasm: PIN.sha256.wasm } }))).kind, 'bad-request');
    assert.equal((await rejection(loadPinnedBinding(PIN, { fetchBytes: files({ [PIN.wasm]: undefined as unknown as Uint8Array }) }))).kind, 'unreachable');
    const importFails = await rejection(
      loadPinnedBinding(PIN, {
        fetchBytes: files(),
        importModule: async () => {
          throw new Error('blocked by CSP');
        },
      }),
    );
    assert.deepEqual([importFails.kind, importFails.detail], ['unreachable', 'blocked by CSP']);
    const startFails = await rejection(
      loadPinnedBinding(PIN, {
        fetchBytes: files(),
        importModule: async () => ({
          ...bindingModule(),
          default: async () => {
            throw new Error('bad wasm');
          },
        }),
      }),
    );
    assert.equal(startFails.kind, 'unreachable');
    assert.equal((await rejection(loadPinnedBinding(PIN, { fetchBytes: files(), importModule: async () => ({ default: async () => undefined }) }))).kind, 'protocol');
  });
});

describe('createEndpointHolder', () => {
  /** A binding whose endpoints record the relay and key they were made with. */
  function fakeBinding(made: { relayUrl: string; secret: Uint8Array | null }[], fail: () => boolean = () => false): Binding {
    return {
      MuonEndpoint: {
        create: async (relayUrl, secret) => {
          if (fail()) throw Object.assign(new Error('config'), { kind: 'config' });
          made.push({ relayUrl, secret });
          let closed = false;
          const endpoint: BindingEndpoint & { closed: () => boolean } = {
            endpointId: () => 'e'.repeat(64),
            secretKey: () => new Uint8Array(32).fill(7),
            connect: async (printerId) =>
              ({
                printerId: () => printerId,
                fetch: async () => ({ status: 200, headers: [], body: new TextEncoder().encode(`${relayUrl} ${printerId}`) }),
                openWebSocket: async () => {
                  throw new Error('unused');
                },
                close: () => undefined,
              }) satisfies BindingSession,
            close: async () => {
              closed = true;
            },
            closed: () => closed,
          };
          return endpoint;
        },
      },
    };
  }

  it('makes one endpoint per relay with this browser\'s key, remembers the key it used, and dials through it', async () => {
    const made: { relayUrl: string; secret: Uint8Array | null }[] = [];
    const remembered: Uint8Array[] = [];
    let loads = 0;
    const holder = createEndpointHolder({
      binding: async () => {
        loads++;
        return fakeBinding(made);
      },
      secret: () => new Uint8Array(32).fill(1),
      remember: (key) => void remembered.push(key),
    });
    const [a, b] = await Promise.all([holder.endpointFor('https://relay.example/'), holder.endpointFor('https://relay.example/')]);
    assert.equal(a, b);
    await holder.endpointFor('https://relay-2.example/');
    assert.deepEqual(made.map((m) => m.relayUrl), ['https://relay.example/', 'https://relay-2.example/']);
    assert.deepEqual([...made[0].secret!], new Array(32).fill(1));
    assert.equal(loads, 1);
    assert.equal(remembered.length, 2);
    const printer = await holder.dial({ printerId: 'p'.repeat(64), relayUrl: 'https://relay-2.example/' });
    assert.equal(await (await printer.fetch('/server/info')).text(), `https://relay-2.example/ ${'p'.repeat(64)}`);
    await holder.close();
    assert.equal(((await a) as BindingEndpoint & { closed: () => boolean }).closed(), true);
  });

  it('keeps no failure: the next ask tries again', async () => {
    const made: { relayUrl: string; secret: Uint8Array | null }[] = [];
    let attempt = 0;
    const holder = createEndpointHolder({ binding: async () => fakeBinding(made, () => ++attempt === 1), secret: async () => null });
    await assert.rejects(holder.endpointFor('https://relay.example/'), /config/);
    await new Promise((resolve) => setTimeout(resolve, 1));
    await holder.endpointFor('https://relay.example/');
    assert.equal(made.length, 1);
    assert.equal(made[0].secret, null);
  });
});
