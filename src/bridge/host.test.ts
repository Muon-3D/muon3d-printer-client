// SPDX-License-Identifier: Apache-2.0
// The host's side of printer-bridge/1 beyond the rule scenarios (vectors/host.json): the welcome it sends, status from
// its own feed at most 4 times a second, the order of a switch's news and its failures, console lines, the UI events,
// the client's state events, the adapter's own errors (the printer's words passed on, anything else kept in the log),
// and close(). The port delivers asynchronously: a check waits until what it expects has arrived (until), and only a
// check that something did not arrive waits a fixed time (quiet).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { printerError } from '../errors/kinds.ts';
import { createBridgeHost, type HostAdapter, type HostLogEntry, type HostStatus, type StatusFeed } from './host.ts';
import { type BridgePrinter, type Welcome } from './protocol.ts';

const WALNUT = 'a'.repeat(64);
const OAK = 'b'.repeat(64);
const FRAME_ORIGIN = 'https://slicer.example';
const printers: Record<string, BridgePrinter> = {
  walnut: { key: WALNUT, name: 'Walnut', model: 'Muon3D M1', route: 'local', role: null, online: true },
  oak: { key: OAK, name: 'Oak', model: 'Muon3D M1', route: 'local', role: null, online: true },
  // Walnut again, as the host lists it after a change of its online state or its role.
  'offline-walnut': { key: WALNUT, name: 'Walnut', model: 'Muon3D M1', route: 'local', role: null, online: false },
  'viewer-walnut': { key: WALNUT, name: 'Walnut', model: 'Muon3D M1', route: 'local', role: 'viewer', online: true },
};

/** Polls `ready` until it holds; the deadline is reached only when the host failed. */
async function until(ready: () => boolean, ms = 2000) {
  const deadline = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`not within ${ms} ms`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
/** A fixed wait, for checks that something did NOT arrive: anything the host sent by now has been delivered. */
const quiet = () => new Promise((resolve) => setTimeout(resolve, 20));
const notThere = () => Promise.reject(printerError('printer', 'Moonraker answered 404', { status: 404 }));

/** A host on a fake frame and window, welcomed, with the frame's end of the port recording what it receives. */
function setup(adapterPatch: Partial<HostAdapter> = {}, options: { timers?: boolean; log?: (entry: HostLogEntry) => void } = {}) {
  let selected: string | null = 'walnut';
  let clock = 0;
  const timers: { at: number; fn: () => void }[] = [];
  const listeners = new Set<(e: MessageEvent) => void>();
  const target = { addEventListener: (_t: 'message', l: (e: MessageEvent) => void) => void listeners.add(l), removeEventListener: (_t: 'message', l: (e: MessageEvent) => void) => void listeners.delete(l) };
  let port: MessagePort | null = null;
  let welcome: Welcome | null = null;
  const frameWindow = { postMessage: (m: Welcome, _o: string, transfer: unknown[]) => ((welcome = m), (port = transfer[0] as MessagePort)) };
  const received: Record<string, any>[] = [];
  const states: unknown[] = [];
  const adapter: HostAdapter = {
    selected: () => (selected ? printers[selected] : null),
    read: async () => ({}),
    printStats: async () => ({ state: 'standby', filename: '' }),
    upload: async () => ({ path: 'a.gcode', size: 1 }),
    start: async () => {},
    queue: async () => {},
    cancelPrint: async () => {},
    confirm: async () => ({ choice: 'upload-only' }),
    status: () => null,
    ...adapterPatch,
  };
  const host = createBridgeHost({
    frame: { window: () => frameWindow, origin: FRAME_ORIGIN },
    target,
    host: 'reference',
    hostVersion: '2',
    theme: 'light',
    density: 'touch',
    adapter,
    onState: (s) => void states.push(s),
    ...(options.log ? { log: options.log } : {}),
    ...(options.timers
      ? {
          now: () => clock,
          setTimer: (fn: () => void, ms: number) => (timers.push({ at: clock + ms, fn }), timers.length),
          clearTimer: () => {},
        }
      : {}),
  });
  const hello = (nonce = '1'.repeat(32)) =>
    [...listeners].forEach((l) => l({ source: frameWindow, origin: FRAME_ORIGIN, data: { protocol: 'printer-bridge', type: 'hello', versions: [1], app: 't', appVersion: 't', nonce } } as unknown as MessageEvent));
  hello();
  const p = port as unknown as MessagePort;
  p.onmessage = (e) => void received.push(e.data);
  let id = 0;
  const send = (op: string, params: Record<string, unknown>) => (p.postMessage({ v: 1, id: ++id, op, params }), id);
  const advance = (ms: number) => {
    clock += ms;
    for (const t of timers.splice(0).sort((a, b) => a.at - b.at)) {
      if (t.at <= clock) t.fn();
      else timers.push(t);
    }
  };
  return {
    host,
    welcome: () => welcome!,
    received,
    states,
    send,
    post: (m: unknown) => p.postMessage(m),
    select: (name: string | null) => ((selected = name), host.printerChanged()),
    advance,
    hello,
    listeners,
    port: p,
    /** Closes the host and the frame's end of the port (an open port keeps Node running). */
    end: () => (host.close(), p.close()),
  };
}

/** A status feed the test drives. */
function feed(initial: HostStatus) {
  let on: ((changed: HostStatus, eventtime: number | null) => void) | null = null;
  let subscriptions = 0;
  const status: HostStatus = structuredClone(initial);
  const f: StatusFeed = {
    snapshot: () => ({ status: structuredClone(status), eventtime: 10 }),
    subscribe: (fn) => {
      subscriptions++;
      on = fn;
      return () => void (on = null);
    },
  };
  return { f, change: (c: HostStatus, t = 11) => on?.(c, t), subscribed: () => on !== null, subscriptions: () => subscriptions };
}

describe('createBridgeHost', () => {
  it('welcomes with its name, the capabilities, the theme and the density', () => {
    const t = setup();
    assert.deepEqual(t.welcome(), {
      protocol: 'printer-bridge',
      type: 'welcome',
      version: 1,
      nonce: '1'.repeat(32),
      host: 'reference',
      hostVersion: '2',
      capabilities: ['printer', 'status', 'gcode', 'moonraker.read', 'files.upload', 'print'],
      theme: 'light',
      density: 'touch',
    });
    assert.equal(t.host.connected, true);
    t.end();
  });

  it('answers printer.get with the selection, and null for none', async () => {
    const t = setup();
    t.send('printer.get', {});
    await until(() => t.received.length === 1);
    t.select(null);
    t.send('printer.get', {});
    await until(() => t.received.filter((m) => m.re).length === 2);
    const answers = t.received.filter((m) => m.re);
    assert.deepEqual(answers[0], { v: 1, re: 1, printer: WALNUT, result: { printer: printers.walnut } });
    assert.deepEqual(answers[1], { v: 1, re: 2, printer: null, result: { printer: null } });
    t.end();
  });

  it('watches status from its own feed: what was asked for, at most 4 events a second, merged', async () => {
    const s = feed({ print_stats: { state: 'standby', filename: '' }, extruder: { temperature: 24, target: 0 }, webhooks: { state: 'ready' } });
    const t = setup({ status: () => s.f }, { timers: true });
    t.send('status.watch', { printer: WALNUT, objects: { print_stats: ['state'] } });
    await until(() => t.received.length === 1);
    assert.deepEqual(t.received[0], { v: 1, re: 1, printer: WALNUT, result: { status: { print_stats: { state: 'standby' } }, eventtime: 10 } });
    // A second watch widens the same subscription; it never opens another.
    t.send('status.watch', { printer: WALNUT, objects: { extruder: null } });
    await until(() => t.received.length === 2);
    assert.deepEqual(t.received[1].result.status, { extruder: { temperature: 24, target: 0 } });
    assert.equal(s.subscriptions(), 1);
    s.change({ print_stats: { state: 'printing' } });
    s.change({ extruder: { temperature: 30 }, webhooks: { state: 'shutdown' } });
    s.change({ extruder: { temperature: 31 } }, 12);
    t.advance(249);
    await quiet();
    assert.equal(t.received.length, 2, 'nothing before 250 ms');
    t.advance(1);
    await until(() => t.received.length === 3);
    assert.deepEqual(t.received[2], { v: 1, event: 'printer.status', printer: WALNUT, data: { status: { print_stats: { state: 'printing' }, extruder: { temperature: 31 } }, eventtime: 12 } });
    s.change({ extruder: { temperature: 32 } }, 13);
    t.advance(100);
    await quiet();
    assert.equal(t.received.length, 3, 'the next one waits out the 250 ms');
    t.advance(150);
    await until(() => t.received.length === 4);
    assert.equal(t.received[3].data.status.extruder.temperature, 32);
    t.end();
  });

  it('on a switch: printer.changed first, then the old printer’s requests end with printer-changed, and its watch stops', async () => {
    const s = feed({ print_stats: { state: 'standby' } });
    let reads = 0;
    const t = setup({
      status: () => s.f,
      read: (_k, _m, _p, signal) => (reads++, new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))))),
    });
    t.send('status.watch', { printer: WALNUT, objects: { print_stats: null } });
    t.send('moonraker.read', { printer: WALNUT, method: 'server.info' });
    await until(() => reads === 1 && t.received.length === 1);
    t.select('oak');
    s.change({ print_stats: { state: 'printing' } });
    await until(() => t.received.length === 3);
    await quiet();
    const after = t.received.slice(1);
    assert.deepEqual(after[0], { v: 1, event: 'printer.changed', printer: OAK, data: { printer: printers.oak } });
    assert.equal(after[1].re, 2);
    assert.equal(after[1].error.kind, 'printer-changed');
    assert.equal(after.length, 2, 'no status of the old printer after the switch');
    assert.equal(s.subscribed(), false);
    t.end();
  });

  it('a change of role or online state keeps the same key and its watch', async () => {
    const s = feed({ print_stats: { state: 'standby' } });
    const t = setup({ status: () => s.f });
    t.send('status.watch', { printer: WALNUT, objects: { print_stats: null } });
    await until(() => t.received.length === 1);
    t.select('offline-walnut');
    await until(() => t.received.length === 2);
    assert.equal(t.received[1].event, 'printer.changed');
    assert.equal(t.received[1].data.printer.online, false);
    assert.equal(s.subscribed(), true);
    t.end();
  });

  it('ends a write the printer can no longer take (watch-only), not a read', async () => {
    let reads = 0;
    const t = setup({
      read: (_k, method, _p, signal) => {
        if (method !== 'server.info') return notThere();
        reads++;
        return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
      },
      upload: (_k, _b, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))),
    });
    const bytes = new TextEncoder().encode('G28').buffer;
    t.send('moonraker.read', { printer: WALNUT, method: 'server.info' });
    t.port.postMessage({ v: 1, id: 2, op: 'files.upload', params: { printer: WALNUT, name: 'a.gcode', size: 3, checksum: 'c'.repeat(64), bytes } }, [bytes]);
    await until(() => reads === 1 && t.received.some((m) => m.re === 2 && m.progress));
    t.select('viewer-walnut');
    await until(() => t.received.some((m) => m.re === 2 && m.error));
    assert.equal(t.received.find((m) => m.re === 2 && m.error)?.error.kind, 'not-allowed');
    await quiet();
    assert.ok(!t.received.some((m) => m.re === 1), 'the read goes on');
    t.end();
  });

  it('sends console lines of the selected printer only, 200 a message', async () => {
    const t = setup();
    t.host.gcode(OAK, ['// not selected']);
    t.host.gcode(WALNUT, Array.from({ length: 450 }, (_, i) => `line ${i}`));
    await until(() => t.received.length === 3);
    await quiet();
    assert.deepEqual(
      t.received.map((m) => [m.event, m.printer, m.data.lines.length]),
      [
        ['printer.gcode', WALNUT, 200],
        ['printer.gcode', WALNUT, 200],
        ['printer.gcode', WALNUT, 50],
      ],
    );
    t.end();
  });

  it('sends the theme and the density as they change, and passes the client’s state on', async () => {
    const t = setup();
    t.host.setTheme('dark');
    t.host.setDensity('compact');
    t.post({ v: 1, event: 'slicer.state', printer: null, data: { mode: 'preview', dirty: true, sending: null } });
    t.post({ v: 1, event: 'slicer.state', printer: null, data: 'not an object' });
    await until(() => t.received.length === 2 && t.states.length === 1);
    await quiet();
    assert.deepEqual(t.received, [
      { v: 1, event: 'ui.theme', printer: null, data: { theme: 'dark' } },
      { v: 1, event: 'ui.density', printer: null, data: { density: 'compact' } },
    ]);
    assert.deepEqual(t.states, [{ mode: 'preview', dirty: true, sending: null }]);
    // A reload is welcomed with the theme as it is now.
    t.hello('2'.repeat(32));
    assert.equal(t.welcome().theme, 'dark');
    t.end();
  });

  it("passes a printer's own refusal through, with its words", async () => {
    const t = setup({ read: async () => Promise.reject(printerError('printer', 'Moonraker answered 404', { status: 404, detail: 'Metadata not available for a.gcode' })) });
    t.send('moonraker.read', { printer: WALNUT, method: 'server.files.metadata', params: { filename: 'a.gcode' } });
    await until(() => t.received.length === 1);
    assert.deepEqual(t.received[0].error, { kind: 'printer', message: 'Metadata not available for a.gcode', status: 404 });
    t.end();
  });

  it('keeps any other error of its adapter in its log: the frame reads a fixed sentence', async () => {
    const log: HostLogEntry[] = [];
    const t = setup({ read: async () => Promise.reject(new TypeError('Failed to fetch http://walnut.example/server/info?token=s3cret')) }, { log: (e) => void log.push(e) });
    t.send('moonraker.read', { printer: WALNUT, method: 'server.info' });
    await until(() => t.received.length === 1);
    assert.deepEqual(t.received[0].error, { kind: 'printer', message: 'The host could not do it' });
    assert.doesNotMatch(JSON.stringify(t.received), /token|walnut\.example/);
    assert.ok(log.some((e) => e.kind === 'adapter-error' && /s3cret/.test(String(e.error))));
    t.end();
  });

  it('reports an upload’s steps with its printer key', async () => {
    const t = setup({
      read: notThere,
      upload: async (_k, body, { onStep }) => {
        onStep({ step: 'sending', sent: body.body.byteLength, total: body.body.byteLength });
        onStep({ step: 'checking' });
        return { path: 'a.gcode', size: 3 };
      },
    });
    const bytes = new TextEncoder().encode('G28').buffer;
    t.port.postMessage({ v: 1, id: 7, op: 'files.upload', params: { printer: WALNUT, name: 'a.gcode', size: 3, checksum: 'c'.repeat(64), bytes } }, [bytes]);
    await until(() => t.received.some((m) => 'result' in m || 'error' in m));
    assert.deepEqual(
      t.received.map((m) => m.progress?.step ?? 'result'),
      ['sending', 'sending', 'checking', 'result'],
    );
    assert.ok(t.received.every((m) => m.printer === WALNUT && m.re === 7));
    assert.equal(t.received[0].progress.sent, 0);
    t.end();
  });

  it('close() stops listening and ends the session', async () => {
    const t = setup();
    t.host.close();
    assert.equal(t.listeners.size, 0);
    assert.equal(t.host.connected, false);
    t.host.gcode(WALNUT, ['x']);
    t.host.printerChanged();
    await quiet();
    assert.deepEqual(t.received, []);
    t.end();
  });
});
