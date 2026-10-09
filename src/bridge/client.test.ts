// SPDX-License-Identifier: Apache-2.0
// The client's side of printer-bridge/1 beyond the handshake vectors: when and where it says hello, how it gives up,
// and what it makes of the answers and events on its port (capabilities, printer keys, progress, aborts, close).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { connectBridge, createClient, type PortLike, type Timers } from './client.ts';
import { LIMITS, type Welcome } from './protocol.ts';

const WALNUT = 'a'.repeat(64);
const OAK = 'b'.repeat(64);
const HOST = 'https://app.example';
const WELCOME: Welcome = {
  protocol: 'printer-bridge',
  type: 'welcome',
  version: 1,
  nonce: '0'.repeat(32),
  host: 'fluidd',
  hostVersion: '1',
  capabilities: ['printer', 'status', 'gcode', 'moonraker.read', 'files.upload', 'print'],
  theme: 'dark',
};
const walnut = { key: WALNUT, name: 'Walnut', model: 'Muon3D M1', route: 'local', role: null, online: true };
const oak = { ...walnut, key: OAK, name: 'Oak' };

/** A port whose sent messages are recorded and whose incoming ones the test delivers. */
function fakePort() {
  const sent: { message: Record<string, any>; transfer?: Transferable[] }[] = [];
  const port: PortLike & { closed: boolean } = {
    onmessage: null,
    closed: false,
    postMessage: (message, transfer) => void sent.push({ message: message as Record<string, any>, transfer }),
    close() {
      this.closed = true;
    },
  };
  return { port, sent, deliver: (data: unknown) => port.onmessage?.({ data } as MessageEvent) };
}

/** Timers run by hand: tick(ms) runs what falls due. */
function clock() {
  let now = 0;
  let nextId = 1;
  const jobs = new Map<number, { at: number; every: number | null; fn: () => void }>();
  const timers: Timers = {
    setInterval: (fn, ms) => (jobs.set(nextId, { at: now + ms, every: ms, fn }), nextId++),
    clearInterval: (h) => void jobs.delete(h as number),
    setTimeout: (fn, ms) => (jobs.set(nextId, { at: now + ms, every: null, fn }), nextId++),
    clearTimeout: (h) => void jobs.delete(h as number),
  };
  const tick = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = [...jobs.entries()].filter(([, j]) => j.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [id, job] = due;
      now = job.at;
      if (job.every) job.at += job.every;
      else jobs.delete(id);
      job.fn();
    }
    now = end;
  };
  return { timers, tick };
}

function fakeWindow() {
  const listeners = new Set<(e: MessageEvent) => void>();
  return {
    addEventListener: (_t: 'message', l: (e: MessageEvent) => void) => void listeners.add(l),
    removeEventListener: (_t: 'message', l: (e: MessageEvent) => void) => void listeners.delete(l),
    dispatch: (e: Partial<MessageEvent>) => [...listeners].forEach((l) => l(e as MessageEvent)),
    count: () => listeners.size,
  };
}

describe('connectBridge', () => {
  it('says hello to each allowed origin, every 500 ms, until a welcome; then stops', async () => {
    const posts: [Record<string, unknown>, string][] = [];
    const parent = { postMessage: (m: unknown, origin: string) => void posts.push([m as Record<string, unknown>, origin]) };
    const win = fakeWindow();
    const { timers, tick } = clock();
    const connecting = connectBridge({ hostOrigins: [HOST, 'http://printer.example'], app: 'muon3d-slicer', appVersion: '0.1.0', parent, target: win, timers });
    assert.deepEqual(
      posts.map(([, o]) => o),
      [HOST, 'http://printer.example'],
    );
    const hello = posts[0][0];
    assert.equal(hello.protocol, 'printer-bridge');
    assert.equal(hello.type, 'hello');
    assert.deepEqual(hello.versions, [1]);
    assert.match(String(hello.nonce), /^[0-9a-f]{32}$/);
    tick(LIMITS.helloEveryMs * 3);
    assert.equal(posts.length, 8, 'again every 500 ms');
    assert.ok(posts.every(([m]) => m.nonce === hello.nonce), 'the same nonce each time');
    const { port1 } = new MessageChannel();
    win.dispatch({ source: parent as unknown as MessageEventSource, origin: HOST, data: { ...WELCOME, nonce: hello.nonce }, ports: [port1] });
    const client = await connecting;
    assert.ok(client);
    assert.equal(client.origin, HOST);
    tick(LIMITS.helloEveryMs * 4);
    assert.equal(posts.length, 8, 'no hello after the welcome');
    assert.equal(win.count(), 0);
    client.close();
    port1.close();
  });

  it('gives up after 10 s (the app then runs with no printer)', async () => {
    const posts: unknown[] = [];
    const win = fakeWindow();
    const { timers, tick } = clock();
    const connecting = connectBridge({ hostOrigins: [HOST], app: 'a', appVersion: '1', parent: { postMessage: (m) => void posts.push(m) }, target: win, timers });
    tick(LIMITS.helloForMs);
    assert.equal(await connecting, null);
    assert.equal(posts.length, LIMITS.helloForMs / LIMITS.helloEveryMs + 1);
    assert.equal(win.count(), 0);
  });

  it("refuses '*' and anything that is not an exact origin, and with no origin says nothing", async () => {
    const parent = { postMessage: () => assert.fail('no hello') };
    const target = fakeWindow();
    assert.throws(() => connectBridge({ hostOrigins: ['*'], app: 'a', appVersion: '1', parent, target }), /cannot be '\*'/);
    assert.throws(() => connectBridge({ hostOrigins: [`${HOST}/`], app: 'a', appVersion: '1', parent, target }), /not an exact origin/);
    assert.throws(() => connectBridge({ hostOrigins: ['app.example'], app: 'a', appVersion: '1', parent, target }), /not an origin/);
    assert.equal(await connectBridge({ hostOrigins: [], app: 'a', appVersion: '1', parent, target }), null);
  });

  it('stops when its signal aborts', async () => {
    const abort = new AbortController();
    const win = fakeWindow();
    const { timers } = clock();
    const connecting = connectBridge({ hostOrigins: [HOST], app: 'a', appVersion: '1', parent: { postMessage: () => {} }, target: win, timers, signal: abort.signal });
    abort.abort();
    assert.equal(await connecting, null);
    assert.equal(win.count(), 0);
  });
});

describe('the client on its port', () => {
  it('sends requests with ids and the printer key, and takes their answers', async () => {
    const { port, sent, deliver } = fakePort();
    const client = createClient(port, WELCOME, HOST);
    const read = client.request('moonraker.read', { printer: WALNUT, method: 'server.info' });
    assert.deepEqual(sent[0].message, { v: 1, id: 1, op: 'moonraker.read', params: { printer: WALNUT, method: 'server.info' } });
    deliver({ v: 1, re: 1, printer: WALNUT, result: { klippy_state: 'ready' } });
    assert.deepEqual(await read, { klippy_state: 'ready' });
    const get = client.request('printer.get', {});
    assert.equal(sent[1].message.id, 2);
    deliver({ v: 1, re: 2, printer: WALNUT, result: { printer: walnut } });
    assert.equal(((await get) as { printer: { name: string } }).printer.name, 'Walnut');
    assert.equal(client.printer?.key, WALNUT);
  });

  it('never sends an operation the welcome did not grant', async () => {
    const { port, sent } = fakePort();
    const client = createClient(port, { ...WELCOME, capabilities: ['printer'] }, HOST);
    await assert.rejects(client.request('files.upload', { printer: WALNUT }), (e: { kind: string }) => e.kind === 'unsupported');
    await assert.rejects(client.request('print.request', { printer: WALNUT }), (e: { kind: string }) => e.kind === 'unsupported');
    assert.equal(sent.length, 0);
    assert.equal(client.can('cancel'), true);
    assert.equal(client.can('printer.get'), true);
  });

  it('takes an answer that names another printer as printer-changed', async () => {
    const { port, deliver } = fakePort();
    const client = createClient(port, WELCOME, HOST);
    const read = client.request('moonraker.read', { printer: WALNUT, method: 'server.info' });
    deliver({ v: 1, re: 1, printer: OAK, result: {} });
    await assert.rejects(read, (e: { kind: string }) => e.kind === 'printer-changed');
  });

  it('reads failures as an untrusted host’s, and passes progress of its own printer on', async () => {
    const { port, deliver } = fakePort();
    const client = createClient(port, WELCOME, HOST);
    const steps: unknown[] = [];
    const upload = client.request('files.upload', { printer: WALNUT }, { onProgress: (s) => steps.push(s) });
    deliver({ v: 1, re: 1, printer: WALNUT, progress: { step: 'sending', sent: 5, total: 10 } });
    deliver({ v: 1, re: 1, printer: OAK, progress: { step: 'sending', sent: 9, total: 10 } });
    deliver({ v: 1, re: 1, printer: WALNUT, progress: { step: 'checking' } });
    deliver({ v: 1, re: 1, printer: WALNUT, error: { kind: 'safety-pass', message: 'Toolpath in the keep-out ‮zone', status: 500 } });
    await assert.rejects(upload, (e: { kind: string; detail: string; status: number }) => e.kind === 'safety-pass' && e.detail === 'Toolpath in the keep-out zone' && e.status === 500);
    assert.deepEqual(steps, [{ step: 'sending', sent: 5, total: 10 }, { step: 'checking' }]);
  });

  it('an aborted request sends cancel and rejects at once; its late answer is dropped', async () => {
    const { port, sent, deliver } = fakePort();
    const client = createClient(port, WELCOME, HOST);
    const abort = new AbortController();
    const bytes = new ArrayBuffer(4);
    const upload = client.request('files.upload', { printer: WALNUT, bytes }, { signal: abort.signal, transfer: [bytes] });
    assert.deepEqual(sent[0].transfer, [bytes]);
    abort.abort();
    await assert.rejects(upload, (e: { kind: string }) => e.kind === 'cancelled');
    assert.deepEqual(sent[1].message, { v: 1, id: 2, op: 'cancel', params: { printer: WALNUT, id: 1 } });
    deliver({ v: 1, re: 1, printer: WALNUT, result: { path: 'a.gcode', size: 4 } });
  });

  it('follows the host’s printer and drops another printer’s status and lines', () => {
    const { port, deliver } = fakePort();
    const client = createClient(port, WELCOME, HOST);
    const seen: [string, string | null][] = [];
    for (const event of ['printer.changed', 'printer.status', 'printer.gcode', 'ui.theme'] as const) client.on(event, (key) => void seen.push([event, key]));
    deliver({ v: 1, event: 'printer.status', printer: WALNUT, data: { status: {} } });
    deliver({ v: 1, event: 'printer.changed', printer: WALNUT, data: { printer: walnut } });
    deliver({ v: 1, event: 'printer.status', printer: WALNUT, data: { status: {} } });
    deliver({ v: 1, event: 'printer.gcode', printer: OAK, data: { lines: ['// not ours'] } });
    deliver({ v: 1, event: 'printer.changed', printer: OAK, data: { printer: oak } });
    deliver({ v: 1, event: 'printer.status', printer: WALNUT, data: { status: {} } });
    deliver({ v: 1, event: 'printer.gcode', printer: OAK, data: { lines: ['ok'] } });
    deliver({ v: 1, event: 'ui.theme', printer: null, data: { theme: 'light' } });
    assert.deepEqual(seen, [
      ['printer.changed', WALNUT],
      ['printer.status', WALNUT],
      ['printer.changed', OAK],
      ['printer.gcode', OAK],
      ['ui.theme', null],
    ]);
    assert.equal(client.printer?.name, 'Oak');
    // An event whose key and printer disagree, or whose printer is not one, is no printer.
    deliver({ v: 1, event: 'printer.changed', printer: WALNUT, data: { printer: oak } });
    assert.equal(client.printer, null);
  });

  it('drops events of a capability the welcome did not grant', () => {
    const { port, deliver } = fakePort();
    const client = createClient(port, { ...WELCOME, capabilities: ['printer'] }, HOST);
    const seen: string[] = [];
    client.on('printer.gcode', () => void seen.push('gcode'));
    deliver({ v: 1, event: 'printer.changed', printer: WALNUT, data: { printer: walnut } });
    deliver({ v: 1, event: 'printer.gcode', printer: WALNUT, data: { lines: ['x'] } });
    assert.deepEqual(seen, []);
  });

  it('sends its own events, and on close rejects what waits as lost', async () => {
    const { port, sent } = fakePort();
    const client = createClient(port, WELCOME, HOST);
    client.emit('slicer.state', { mode: 'prepare', dirty: false });
    assert.deepEqual(sent[0].message, { v: 1, event: 'slicer.state', printer: null, data: { mode: 'prepare', dirty: false } });
    const read = client.request('moonraker.read', { printer: WALNUT, method: 'server.info' });
    client.close();
    await assert.rejects(read, (e: { kind: string }) => e.kind === 'lost');
    assert.equal(port.closed, true);
    await assert.rejects(client.request('printer.get', {}), (e: { kind: string }) => e.kind === 'lost');
  });
});
