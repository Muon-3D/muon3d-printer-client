// SPDX-License-Identifier: Apache-2.0
// The conformance vectors (vectors/*.json) run against this package's two sides: messages.json against the validators
// (the requests a host reads, the messages and the answers a client reads), handshake.json against connectBridge and
// createBridgeHost, and host.json's scenarios against createBridgeHost with an in-memory printer (its files, queue
// and history answered as Moonraker answers them), its requests sent over a real MessageChannel by a port that keeps
// no client rules of its own.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { printerError } from '../errors/kinds.ts';
import { connectBridge, type Timers } from './client.ts';
import { createBridgeHost, type ConfirmAnswer, type HostAdapter, type HostLogEntry } from './host.ts';
import { parseIncoming, parsePrintDecision, parseQueueAnswer, parseRequest, type BridgePrinter, type PrintMode, type Welcome } from './protocol.ts';

const load = (name: string) => JSON.parse(readFileSync(new URL(`./vectors/${name}`, import.meta.url), 'utf8'));
const messages = load('messages.json');
const handshake = load('handshake.json');
const hostCases = load('host.json');
const KEYS: Record<string, string> = messages.keys;

/** The vectors' placeholders: "$walnut", "$oak", "$nonce" and {"$bytes": n}. */
function subst(value: unknown): unknown {
  if (typeof value === 'string') {
    if (value === '$nonce') return handshake.nonce;
    if (value.startsWith('$') && KEYS[value.slice(1)]) return KEYS[value.slice(1)];
    return value;
  }
  if (Array.isArray(value)) return value.map(subst);
  if (value && typeof value === 'object') {
    const r = value as Record<string, unknown>;
    if (typeof r.$bytes === 'number') return new ArrayBuffer(r.$bytes);
    return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, subst(v)]));
  }
  return value;
}

/** Every field of `partial` equals the same field of `actual` (deeply). */
function assertPartial(actual: unknown, partial: Record<string, unknown>, what: string) {
  for (const [k, v] of Object.entries(partial)) assert.deepEqual((actual as Record<string, unknown>)?.[k], v, `${what}: ${k}`);
}

/** A window that records its listeners, for dispatching messages by hand. */
function fakeWindow() {
  const listeners = new Set<(e: MessageEvent) => void>();
  return {
    addEventListener: (_t: 'message', l: (e: MessageEvent) => void) => void listeners.add(l),
    removeEventListener: (_t: 'message', l: (e: MessageEvent) => void) => void listeners.delete(l),
    dispatch: (e: Partial<MessageEvent>) => {
      for (const l of [...listeners]) l(e as MessageEvent);
    },
    count: () => listeners.size,
  };
}

/** Timers that never fire by themselves: `fire()` runs the timeouts. */
function manualTimers() {
  const timeouts: (() => void)[] = [];
  const timers: Timers = {
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: (fn) => (timeouts.push(fn), timeouts.length),
    clearTimeout: () => {},
  };
  return { timers, fire: () => timeouts.splice(0).forEach((fn) => fn()) };
}

describe('vectors: messages', () => {
  for (const c of messages.requests) {
    it(`request: ${c.name}`, () => {
      const parsed = parseRequest(subst(c.message));
      if (c.expect === 'ignored') return assert.equal(parsed, null);
      assert.ok(parsed, 'a request');
      if (c.expect.error) {
        assert.equal(parsed.ok, false, JSON.stringify(parsed));
        if (!parsed.ok) {
          assert.equal(parsed.error.kind, c.expect.error);
          assert.equal(parsed.id, c.expect.re);
        }
        return;
      }
      assert.equal(parsed.ok, true, JSON.stringify(parsed));
      if (!parsed.ok) return;
      const expect = subst(c.expect) as Record<string, unknown>;
      const flat = { ...parsed.request, ...('params' in parsed.request && typeof parsed.request.params === 'object' ? parsed.request.params : {}) };
      assertPartial(flat, expect, c.name);
    });
  }
  for (const c of messages.incoming) {
    it(`incoming: ${c.name}`, () => {
      const parsed = parseIncoming(subst(c.message));
      if (c.expect === 'ignored') return assert.equal(parsed, null);
      assert.ok(parsed);
      const { error, ...rest } = subst(c.expect) as Record<string, unknown>;
      assertPartial(parsed, rest, c.name);
      if (error) assert.equal(parsed.kind === 'failure' && parsed.error.kind, error);
    });
  }
  for (const c of messages.answers) {
    it(`answer: ${c.name}`, () => {
      const read = c.op === 'queue.add' ? parseQueueAnswer(c.result) : parsePrintDecision(c.result, c.paths as string[], c.mode as PrintMode);
      if (c.expect === 'refused') return assert.equal(read, null);
      assert.deepEqual(read, c.expect);
    });
  }
});

describe('vectors: handshake, the client', () => {
  for (const c of handshake.client) {
    it(c.name, async () => {
      const parent = { postMessage: () => {} };
      const win = fakeWindow();
      const { timers, fire } = manualTimers();
      const connecting = connectBridge({ hostOrigins: ['https://host.example'], app: 'muon3d-slicer', appVersion: 'test', parent, target: win, nonce: handshake.nonce, timers });
      for (const m of c.messages) {
        const ports = Array.from({ length: m.ports }, () => new MessageChannel().port1);
        win.dispatch({ source: (m.source === 'parent' ? parent : {}) as MessageEventSource, origin: m.origin, data: subst(m.data), ports });
      }
      fire();
      const client = await connecting;
      if (c.expect === null) return assert.equal(client, null);
      assert.ok(client, 'welcomed');
      assert.equal(client.welcome.host, c.messages[c.expect].data.host);
      assert.equal(win.count(), 0, 'no longer listening to window messages');
      client.close();
    });
  }
});

describe('vectors: handshake, the host', () => {
  for (const c of handshake.host) {
    it(c.name, () => {
      const welcomes: Welcome[] = [];
      const frameWindow = { postMessage: (m: Welcome, origin: string) => (assert.equal(origin, 'https://slicer.example'), welcomes.push(m)) };
      const win = fakeWindow();
      const host = createBridgeHost({
        frame: { window: () => frameWindow, origin: 'https://slicer.example' },
        target: win,
        host: 'reference',
        hostVersion: 'test',
        theme: 'light',
        adapter: { selected: () => null } as unknown as HostAdapter,
      });
      for (const h of c.hellos) win.dispatch({ source: (h.source === 'frame' ? frameWindow : {}) as MessageEventSource, origin: h.origin, data: h.data });
      assert.equal(welcomes.length, c.expect.welcomes);
      assert.deepEqual(
        welcomes.map((w) => w.nonce),
        c.expect.nonces,
      );
      if (c.expect.version) assert.equal(welcomes[0].version, c.expect.version);
      host.close();
    });
  }
});

// ---------------------------------------------------------------------------
// host.json: the scenarios
// ---------------------------------------------------------------------------

const FILE = new TextEncoder().encode('G28\nG1 X10 Y10\n');

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

interface HistoryJob {
  job_id: string;
  filename: string;
  status: string;
  filament_used: number;
}
/** A printer of the scenario: what the host says of it, and what the printer has (files, queue, history). */
type Live = BridgePrinter & { state: string; filename: string; files: string[]; queued: string[]; jobs: HistoryJob[]; history: boolean };
type Step = Record<string, any>;

/** The end states of a job (history status → print_stats state). */
const ENDED: Record<string, string> = { completed: 'complete', cancelled: 'cancelled', error: 'error' };

/** Polls `ready` every few milliseconds; throws once `ms` have passed (reached only when the host failed). */
async function until(ready: () => boolean, what: string, ms = 2000) {
  const deadline = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`not within ${ms} ms: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** Runs one scenario; resolves when every step has been checked. */
async function runScenario(c: { selected: string; capabilities?: string[]; printers?: unknown; steps: Step[] }) {
  const printers: Record<string, Live> = {};
  for (const [name, p] of Object.entries(hostCases.printers as Record<string, Record<string, unknown>>)) {
    printers[name] = { ...(subst(p) as BridgePrinter), state: 'standby', filename: '', files: [], queued: [], jobs: [], history: true };
  }
  const nameOf = (key: string) => Object.keys(printers).find((n) => printers[n].key === key) ?? key;
  const of = (key: string) => printers[nameOf(key)];
  let selected: string | null = c.selected;
  let clock = 1_000_000;
  let calls: string[] = [];
  let dialogs = 0;
  let asked: string | null = null;
  let dialog: Step['dialog'] = undefined;
  let during: (() => void) | null = null;
  let cancelRequest: (() => void) | null = null;
  let jobs = 0;
  const toBridge = (p: Live): BridgePrinter => {
    const { state: _s, filename: _f, files: _files, queued: _q, jobs: _j, history: _h, ...rest } = p;
    return rest;
  };
  const waitAbort = (signal: AbortSignal) => new Promise<never>((_, reject) => (signal.aborted ? reject(new Error('aborted')) : signal.addEventListener('abort', () => reject(new Error('aborted')))));
  const notThere = (what: string) => printerError('printer', `Moonraker answered 404`, { status: 404, detail: what });
  const addJob = (p: Live, filename: string) => p.jobs.push({ job_id: (++jobs).toString(16).padStart(6, '0'), filename, status: 'in_progress', filament_used: 0 });

  // The printer as Moonraker answers: its queue, its files, its history (newest first); any other read echoes itself.
  const adapter: HostAdapter = {
    selected: () => (selected ? toBridge(printers[selected]) : null),
    read: async (key, method, params) => {
      const p = of(key);
      if (method === 'server.job_queue.status') return { queued_jobs: p.queued.map((filename) => ({ filename })), queue_state: 'paused' };
      if (method === 'server.files.metadata') {
        if (!p.files.includes(params.filename as string)) throw notThere(`Metadata not available for ${params.filename}`);
        return { filename: params.filename, size: FILE.byteLength };
      }
      if (method === 'server.history.list') {
        if (!p.history) throw notThere('Method not found');
        return { count: p.jobs.length, jobs: [...p.jobs].reverse().slice(0, params.limit as number) };
      }
      return { method, params };
    },
    printStats: async (key) => ({ state: of(key).state, filename: of(key).filename }),
    upload: async (key, body, { signal, onStep }) => {
      const text = new TextDecoder().decode(body.body);
      const name = /filename="([^"]+)"/.exec(text)?.[1] ?? '?';
      calls.push(`upload ${nameOf(key)} ${name}`);
      onStep({ step: 'sending', sent: body.body.byteLength, total: body.body.byteLength });
      onStep({ step: 'checking' });
      if (during) {
        during();
        await waitAbort(signal);
      }
      if (!of(key).files.includes(name)) of(key).files.push(name);
      return { path: name, size: FILE.byteLength };
    },
    start: async (key, path) => {
      calls.push(`start ${nameOf(key)} ${path}`);
      addJob(of(key), path);
    },
    queue: async (key, paths) => {
      calls.push(`queue ${nameOf(key)} ${paths.join(',')}`);
      of(key).queued.push(...paths);
    },
    cancelPrint: async (key) => void calls.push(`cancel ${nameOf(key)}`),
    confirm: async (req): Promise<ConfirmAnswer> => {
      dialogs++;
      asked = req.plateClear;
      if (dialog === undefined) throw new Error('the dialog opened, but the step expected none');
      if (typeof dialog === 'object') {
        // While it is open: the host switches printer, a printer changes, or the frame cancels the request.
        if ('select' in dialog) selected = dialog.select;
        if (dialog.set) for (const [name, patch] of Object.entries(dialog.set as Record<string, Partial<Live>>)) Object.assign(printers[name], patch);
        if (dialog.cancel) cancelRequest?.();
        else host.printerChanged();
        return waitAbort(req.signal);
      }
      if (dialog === 'upload-only' || dialog === 'close') return { choice: 'upload-only' };
      if (dialog === 'print-unticked') return { choice: 'print', plateClear: false };
      return { choice: 'print', plateClear: dialog === 'print-ticked' || req.plateClear === 'not-needed' };
    },
    status: (key) => ({
      snapshot: () => ({ status: { print_stats: { state: printers[nameOf(key)].state } }, eventtime: 1 }),
      subscribe: () => () => {},
    }),
  };

  const frameWindow = { postMessage: (m: Welcome, _o: string, transfer: unknown[]) => void welcomed.push({ welcome: m, port: transfer[0] as MessagePort }) };
  const welcomed: { welcome: Welcome; port: MessagePort }[] = [];
  const win = fakeWindow();
  const host = createBridgeHost({
    frame: { window: () => frameWindow, origin: 'https://slicer.example' },
    target: win,
    host: 'vectors',
    hostVersion: 'test',
    theme: 'dark',
    capabilities: c.capabilities,
    adapter,
    now: () => clock,
    log: (entry) => void log.push(entry),
  });
  const log: HostLogEntry[] = [];
  let nonce = 0;
  const hello = (): RawPort => {
    win.dispatch({ source: frameWindow as unknown as MessageEventSource, origin: 'https://slicer.example', data: { protocol: 'printer-bridge', type: 'hello', versions: [1], app: 't', appVersion: 't', nonce: (++nonce).toString(16).padStart(32, '0') } });
    return rawPort(welcomed.at(-1)!.port);
  };
  let client = hello();
  const outcome = async (promise: Promise<unknown>) => promise.then((result) => ({ result }), (error) => ({ error }));

  try {
    for (const [i, step] of c.steps.entries()) {
      const what = `step ${i + 1}`;
      calls = [];
      dialogs = 0;
      asked = null;
      dialog = step.dialog;
      during = null;
      cancelRequest = null;
      if ('select' in step && !step.request && !step.upload) {
        selected = step.select;
        host.printerChanged();
        continue;
      }
      if (step.set) {
        for (const [name, patch] of Object.entries(step.set as Record<string, Partial<Live>>)) Object.assign(printers[name], patch);
        host.printerChanged();
        continue;
      }
      if (step.finish) {
        // The printer's job ends: the history keeps it with the filament it used.
        const p = printers[step.finish];
        const status = step.status ?? 'completed';
        Object.assign(p.jobs.at(-1)!, { status, filament_used: step.filament_used ?? 0 });
        p.state = ENDED[status];
        continue;
      }
      if (step.hostStart) {
        // The host prints a file from its own list, without the frame.
        const p = printers[step.hostStart.printer];
        addJob(p, step.hostStart.filename);
        Object.assign(p, { state: 'printing', filename: step.hostStart.filename });
        continue;
      }
      if (step.advance) {
        clock += step.advance;
        continue;
      }
      if (step.reload) {
        client.close();
        client = hello();
        continue;
      }
      let got: { result?: unknown; error?: unknown };
      const abort = new AbortController();
      const op = step.upload ? 'files.upload' : (step.request.op as string);
      if (step.upload) {
        const params = subst(step.upload) as { printer: string; name: string };
        if (step.during?.select) during = () => ((selected = step.during.select), host.printerChanged());
        if (step.during?.cancel) during = () => abort.abort();
        const bytes = FILE.slice().buffer;
        got = await outcome(client.request('files.upload', { printer: params.printer, name: params.name, size: FILE.byteLength, checksum: await sha256(FILE), bytes }, [bytes], abort.signal));
      } else {
        const request = subst(step.request) as { op: string; params: Record<string, unknown> };
        cancelRequest = () => abort.abort();
        got = await outcome(client.request(request.op, request.params, [], abort.signal));
      }
      // A cancel's answer comes later: the host must take the cancel, and end the request, before the next step.
      if (abort.signal.aborted) await until(() => log.some((e) => e.kind === 'refused' && e.op === op && e.error.kind === 'cancelled'), `${what}: the host ended the ${op}`);
      if (step.expect.error) {
        assert.ok(got.error, `${what}: expected ${step.expect.error}, got ${JSON.stringify(got.result)}`);
        assert.equal((got.error as { kind: string }).kind, step.expect.error, `${what}: ${JSON.stringify(got.error)}`);
      } else {
        assert.ok(!got.error, `${what}: ${JSON.stringify(got.error)}`);
        assertPartial(got.result, step.expect.result, what);
      }
      assert.deepEqual(calls, step.calls ?? [], `${what}: the adapter's writes`);
      if (step.dialog === undefined) assert.equal(dialogs, 0, `${what}: no dialog`);
      if (step.asked !== undefined) assert.equal(asked, step.asked, `${what}: the dialog's Plate is clear`);
    }
  } finally {
    client.close();
    host.close();
  }
}

interface RawPort {
  request(op: string, params: Record<string, unknown>, transfer?: Transferable[], signal?: AbortSignal): Promise<unknown>;
  close(): void;
}

/**
 * The frame's end of the port, with no client rules of its own: every request reaches the host as written (the
 * package's client would refuse some before sending), so the host's own rules are what is tested. An abort sends
 * `cancel` and rejects as cancelled.
 */
function rawPort(port: MessagePort): RawPort {
  let next = 1;
  const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  port.onmessage = (e: MessageEvent) => {
    const m = e.data as { re?: number; result?: unknown; error?: unknown; progress?: unknown };
    if (typeof m.re !== 'number' || 'progress' in m) return;
    const w = waiting.get(m.re);
    waiting.delete(m.re);
    if (!w) return;
    if ('error' in m) w.reject(m.error);
    else w.resolve(m.result);
  };
  return {
    request(op, params, transfer = [], signal) {
      const id = next++;
      return new Promise((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        signal?.addEventListener('abort', () => {
          waiting.delete(id);
          port.postMessage({ v: 1, id: next++, op: 'cancel', params: { printer: params.printer, id } });
          reject({ kind: 'cancelled', message: 'Cancelled' });
        });
        port.postMessage({ v: 1, id, op, params }, transfer);
      });
    },
    close: () => port.close(),
  };
}

describe('vectors: host rules', () => {
  for (const c of hostCases.cases) it(c.name, () => runScenario(c));
});
