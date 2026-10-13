// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Muon 3D Technologies Limited
// Fake printers for the brand adapters' tests, on 127.0.0.1: a Moonraker, an OctoPrint, Creality's stock firmware
// socket and Elegoo's SDCP socket, each answering as the real one is documented to, and recording what it was asked.
// Not published (package.json `files`); Node only.
import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** The server side of a WebSocket (RFC 6455, no extensions): text frames in and out. */
export interface FakeSocket {
  send(text: string): void;
  close(): void;
  readonly protocol: string | null;
}

/** Answers an upgrade as a WebSocket; `onText` gets each text message. Null when the request is not an upgrade. */
export function acceptSocket(req: http.IncomingMessage, socket: Socket, onText: (text: string, ws: FakeSocket) => void, onClose?: () => void): FakeSocket | null {
  const key = req.headers['sec-websocket-key'];
  if (typeof key !== 'string') {
    socket.destroy();
    return null;
  }
  const accept = createHash('sha1').update(`${key}${GUID}`).digest('base64');
  socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`, '', ''].join('\r\n'));
  let buffer = Buffer.alloc(0);
  let open = true;
  const frame = (opcode: number, payload: Buffer) => {
    const length = payload.length;
    const head = length < 126 ? Buffer.from([0x80 | opcode, length]) : length < 65536 ? Buffer.from([0x80 | opcode, 126, length >> 8, length & 255]) : Buffer.concat([Buffer.from([0x80 | opcode, 127]), (() => {
      const b = Buffer.alloc(8);
      b.writeBigUInt64BE(BigInt(length));
      return b;
    })()]);
    return Buffer.concat([head, payload]);
  };
  const ws: FakeSocket = {
    protocol: null,
    send(text) {
      if (open) socket.write(frame(1, Buffer.from(text, 'utf8')));
    },
    close() {
      if (!open) return;
      open = false;
      socket.write(frame(8, Buffer.alloc(0)));
      socket.end();
    },
  };
  socket.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 2) return;
      const opcode = buffer[0] & 0x0f;
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        length = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      const masked = (buffer[1] & 0x80) !== 0;
      const maskAt = offset;
      if (masked) offset += 4;
      if (buffer.length < offset + length) return;
      const payload = Buffer.from(buffer.subarray(offset, offset + length));
      if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= buffer[maskAt + (i % 4)];
      buffer = buffer.subarray(offset + length);
      if (opcode === 8) {
        ws.close();
        return;
      }
      if (opcode === 9) socket.write(frame(10, payload));
      else if (opcode === 1) onText(payload.toString('utf8'), ws);
    }
  });
  socket.on('close', () => {
    open = false;
    onClose?.();
  });
  socket.on('error', () => {});
  return ws;
}

export interface Recorded {
  method: string;
  path: string;
  apiKey: string | null;
  origin: string | null;
  /** The body as text (latin1), for a multipart body's field values. */
  body: string;
}

/** A multipart field's value (not a file's). */
export function formField(body: string, name: string): string | null {
  const m = new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)\\r\\n`).exec(body);
  return m ? m[1] : null;
}

/** A multipart file's name and size. */
export function formFile(body: string, name: string): { filename: string; bytes: number } | null {
  const m = new RegExp(`name="${name}"; filename="([^"]*)"\\r\\n(?:[^\\r]*\\r\\n)*\\r\\n([\\s\\S]*?)\\r\\n--`).exec(body);
  return m ? { filename: m[1], bytes: Buffer.from(m[2], 'latin1').length } : null;
}

interface Base {
  /** `127.0.0.1:<port>`. */
  host: string;
  requests: Recorded[];
  sockets: Set<FakeSocket>;
  close(): Promise<void>;
}

async function serve(handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string, rec: Recorded) => void, upgrade?: (req: http.IncomingMessage, socket: Socket) => void): Promise<Base & { server: http.Server }> {
  const requests: Recorded[] = [];
  const sockets = new Set<FakeSocket>();
  const conns = new Set<Socket>();
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://fake');
      const origin = typeof req.headers.origin === 'string' ? req.headers.origin : null;
      // Every fake lets any page in (the CORS a person turns on): a test of the CORS refusal sets cors false itself.
      res.setHeader('Access-Control-Allow-Origin', origin ?? '*');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Api-Key');
      if (req.method === 'OPTIONS') {
        res.writeHead(204).end();
        return;
      }
      const rec: Recorded = { method: req.method ?? 'GET', path: `${url.pathname}${url.search}`, apiKey: typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'] : null, origin, body: Buffer.concat(chunks).toString('latin1') };
      requests.push(rec);
      handler(req, res, rec.body, rec);
    });
  });
  server.on('connection', (c: Socket) => {
    conns.add(c);
    c.on('close', () => conns.delete(c));
  });
  if (upgrade) server.on('upgrade', (req, socket) => upgrade(req, socket as Socket));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    host: `127.0.0.1:${port}`,
    requests,
    sockets,
    close: () =>
      new Promise<void>((resolve) => {
        for (const ws of sockets) ws.close();
        for (const c of conns) c.destroy();
        server.close(() => resolve());
      }),
  };
}

const json = (res: http.ServerResponse, status: number, value: unknown) => {
  res.setHeader('Content-Type', 'application/json');
  res.writeHead(status).end(JSON.stringify(value));
};

// ---- Moonraker --------------------------------------------------------------------------------------------------

export interface FakeMoonraker extends Base {
  /** What the subscription answers with, and what push() merges into. */
  objects: Record<string, Record<string, unknown>>;
  /** Sends notify_status_update to every socket. */
  push(status: Record<string, Record<string, unknown>>): void;
  /** The JSON-RPC calls the sockets made. */
  calls: Array<{ method: string; params: unknown }>;
  files: string[];
}

export async function fakeMoonraker(options: { apiKey?: string; hostname?: string } = {}): Promise<FakeMoonraker> {
  const objects: Record<string, Record<string, unknown>> = {
    webhooks: { state: 'ready', state_message: 'Printer is ready' },
    print_stats: { state: 'standby', filename: '', print_duration: 0, message: '' },
    virtual_sdcard: { progress: 0 },
    extruder: { temperature: 24.2, target: 0 },
    heater_bed: { temperature: 23.8, target: 0 },
  };
  const calls: FakeMoonraker['calls'] = [];
  const files: string[] = ['old/part.gcode'];
  const allowed = (key: string | null) => !options.apiKey || key === options.apiKey;
  /** Tells every socket what changed, as Moonraker does. */
  const notify = (status: Record<string, Record<string, unknown>>) => {
    for (const [k, v] of Object.entries(status)) objects[k] = { ...objects[k], ...v };
    for (const ws of base.sockets) ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'notify_status_update', params: [status, 2] }));
  };
  const base = await serve(
    (req, res, body, rec) => {
      const path = rec.path.split('?')[0];
      if (!allowed(rec.apiKey)) return json(res, 401, { error: { code: 401, message: 'Unauthorized' } });
      if (path === '/server/info') return json(res, 200, { result: { klippy_connected: true, klippy_state: 'ready', moonraker_version: 'v0.9.3' } });
      if (path === '/printer/info') return json(res, 200, { result: { state: 'ready', hostname: options.hostname ?? 'voron', software_version: 'v0.12.0' } });
      if (path === '/server/files/list') return json(res, 200, { result: files.map((p) => ({ path: p, size: 10, modified: 0 })) });
      if (path === '/server/files/upload' && req.method === 'POST') {
        const file = formFile(body, 'file');
        if (!file) return json(res, 400, { error: { message: 'No file' } });
        files.push(file.filename);
        if (formField(body, 'print') === 'true') notify({ print_stats: { state: 'printing', filename: file.filename, print_duration: 0 }, virtual_sdcard: { progress: 0 } });
        return json(res, 201, { result: { item: { path: file.filename, root: 'gcodes' }, print_started: formField(body, 'print') === 'true', action: 'create_file' } });
      }
      if (path.startsWith('/printer/print/') && req.method === 'POST') {
        const what = path.slice('/printer/print/'.length);
        const state = what === 'pause' ? 'paused' : what === 'resume' ? 'printing' : what === 'cancel' ? 'cancelled' : what === 'start' ? 'printing' : null;
        if (!state) return json(res, 404, { error: { message: 'Not found' } });
        notify({ print_stats: { state } });
        return json(res, 200, { result: 'ok' });
      }
      json(res, 404, { error: { code: 404, message: 'Not Found' } });
    },
    (req, socket) => {
      const ws = acceptSocket(req, socket, (t, s) => {
        const m = JSON.parse(t) as { method: string; params: unknown; id: number };
        calls.push({ method: m.method, params: m.params });
        if (m.method === 'server.connection.identify') {
          const key = (m.params as { api_key?: string }).api_key ?? null;
          if (!allowed(key)) return s.send(JSON.stringify({ jsonrpc: '2.0', error: { code: 401, message: 'Unauthorized' }, id: m.id }));
          return s.send(JSON.stringify({ jsonrpc: '2.0', result: { connection_id: 1 }, id: m.id }));
        }
        if (m.method === 'printer.objects.subscribe') return s.send(JSON.stringify({ jsonrpc: '2.0', result: { eventtime: 1, status: objects }, id: m.id }));
      });
      if (ws) base.sockets.add(ws);
    },
  );
  return {
    ...base,
    objects,
    calls,
    files,
    push: notify,
  };
}

// ---- OctoPrint --------------------------------------------------------------------------------------------------

export interface FakeOctoPrint extends Base {
  state: { flags: Record<string, boolean>; text: string; file: string | null; completion: number | null; left: number | null; connected: boolean };
  /** How the next key request ends: approved with this key, refused, or left waiting. */
  keyRequest: 'approve' | 'deny' | 'wait';
  files: string[];
}

export async function fakeOctoPrint(options: { apiKey: string; appKeys?: boolean }): Promise<FakeOctoPrint> {
  const state: FakeOctoPrint['state'] = { flags: { operational: true, ready: true, printing: false, paused: false, error: false }, text: 'Operational', file: null, completion: null, left: null, connected: true };
  const files: string[] = ['box.gcode'];
  const tokens = new Map<string, number>();
  const fake: { keyRequest: FakeOctoPrint['keyRequest'] } = { keyRequest: 'approve' };
  const base = await serve((req, res, body, rec) => {
    const path = rec.path.split('?')[0];
    if (path === '/plugin/appkeys/probe') return options.appKeys === false ? json(res, 404, {}) : res.writeHead(204).end();
    if (path === '/plugin/appkeys/request' && req.method === 'POST') {
      const token = `token-${tokens.size + 1}`;
      tokens.set(token, 0);
      return json(res, 201, { app_token: token });
    }
    if (path.startsWith('/plugin/appkeys/request/')) {
      const token = decodeURIComponent(path.slice('/plugin/appkeys/request/'.length));
      const asked = (tokens.get(token) ?? -1) + 1;
      if (asked === 0) return json(res, 404, {});
      tokens.set(token, asked);
      if (fake.keyRequest === 'wait' || asked < 2) return json(res, 202, {});
      if (fake.keyRequest === 'deny') return json(res, 404, {});
      return json(res, 200, { api_key: options.apiKey });
    }
    if (!path.startsWith('/api/')) return json(res, 404, { error: 'Not found' });
    if (rec.apiKey !== options.apiKey) return json(res, 403, { error: 'You don\'t have the permission to access the requested resource.' });
    if (path === '/api/version') return json(res, 200, { api: '0.1', server: '1.10.2', text: 'OctoPrint 1.10.2' });
    if (path === '/api/printer') {
      if (!state.connected) return json(res, 409, { error: 'Printer is not operational' });
      return json(res, 200, { state: { text: state.text, flags: state.flags }, temperature: { tool0: { actual: 210.4, target: 210 }, bed: { actual: 59.8, target: 60 } } });
    }
    if (path === '/api/job' && req.method === 'GET') return json(res, 200, { job: { file: { name: state.file, path: state.file } }, progress: { completion: state.completion, printTimeLeft: state.left }, state: state.text });
    if (path === '/api/job' && req.method === 'POST') {
      const command = JSON.parse(body) as { command: string; action?: string };
      if (command.command === 'pause') Object.assign(state.flags, { paused: command.action === 'pause', printing: command.action !== 'pause' });
      if (command.command === 'cancel') Object.assign(state.flags, { paused: false, printing: false });
      return res.writeHead(204).end();
    }
    if (path === '/api/files/local' && req.method === 'POST') {
      const file = formFile(body, 'file');
      if (!file) return json(res, 400, { error: 'No file' });
      files.push(file.filename);
      if (formField(body, 'print') === 'true') {
        Object.assign(state.flags, { printing: true });
        Object.assign(state, { file: file.filename, completion: 0, left: 600, text: 'Printing' });
      }
      return json(res, 201, { done: true, files: { local: { name: file.filename, path: file.filename, origin: 'local' } } });
    }
    if (path === '/api/files/local' && req.method === 'GET') return json(res, 200, { files: [{ name: 'parts', type: 'folder', path: 'parts', children: files.map((f) => ({ name: f, path: `parts/${f}`, type: 'machinecode' })) }] });
    if (path.startsWith('/api/files/local/') && req.method === 'POST') {
      Object.assign(state.flags, { printing: true });
      state.file = decodeURIComponent(path.slice('/api/files/local/'.length));
      return res.writeHead(204).end();
    }
    json(res, 404, { error: 'Not found' });
  });
  const out = Object.assign(base, { state, files }) as unknown as FakeOctoPrint;
  Object.defineProperty(out, 'keyRequest', { get: () => fake.keyRequest, set: (v: FakeOctoPrint['keyRequest']) => void (fake.keyRequest = v) });
  return out;
}

// ---- Creality ---------------------------------------------------------------------------------------------------

export interface FakeCreality extends Base {
  telemetry: Record<string, unknown>;
  /** The `set` commands it received, and the heartbeat answers. */
  sets: Array<Record<string, unknown>>;
  heartbeats: number;
  /** Sends a heartbeat to every socket. */
  beat(): void;
  push(fields: Record<string, unknown>): void;
}

export async function fakeCreality(): Promise<FakeCreality> {
  const telemetry: Record<string, unknown> = { hostname: 'K1C-2F3A', model: 'K1C', modelVersion: 'printer hw ver:;printer hw ver:CR4CU220812S11;DWIN hw ver:;', state: 0, nozzleTemp: '24.5', targetNozzleTemp: 0, bedTemp0: '23.10', targetBedTemp0: 0, printProgress: 0, printLeftTime: 0, printFileName: '', err: { errcode: 0, key: 0 } };
  const sets: Array<Record<string, unknown>> = [];
  const counter = { heartbeats: 0 };
  const base = await serve(
    (_req, res) => json(res, 404, {}),
    (req, socket) => {
      const ws = acceptSocket(req, socket, (t, s) => {
        if (t === 'ok') {
          counter.heartbeats++;
          return;
        }
        const m = JSON.parse(t) as { method: string; params: Record<string, unknown> };
        if (m.method === 'get' && m.params.ReqPrinterPara) s.send(JSON.stringify(telemetry));
        if (m.method === 'set') {
          sets.push(m.params);
          if (m.params.pause === 1) telemetry.state = 5;
          if (m.params.pause === 0) telemetry.state = 1;
          if (m.params.stop === 1) telemetry.state = 4;
          s.send(JSON.stringify({ state: telemetry.state }));
        }
      });
      if (ws) base.sockets.add(ws);
    },
  );
  const out = Object.assign(base, {
    telemetry,
    sets,
    beat() {
      for (const ws of base.sockets) ws.send(JSON.stringify({ ModeCode: 'heart_beat', msg: new Date(0).toISOString() }));
    },
    push(fields: Record<string, unknown>) {
      Object.assign(telemetry, fields);
      for (const ws of base.sockets) ws.send(JSON.stringify(fields));
    },
  }) as unknown as FakeCreality;
  Object.defineProperty(out, 'heartbeats', { get: () => counter.heartbeats });
  return out;
}

// ---- Elegoo SDCP ------------------------------------------------------------------------------------------------

export interface FakeElegoo extends Base {
  status: Record<string, unknown>;
  /** The request envelopes it received. */
  commands: Array<{ Cmd: number; Data: Record<string, unknown>; RequestID: string; MainboardID: string }>;
  /** Ack per command (0 when not set); `silent` commands get no answer. */
  acks: Map<number, number>;
  silent: Set<number>;
  pushStatus(status: Record<string, unknown>): void;
}

export const ELEGOO_MAINBOARD = '0123456789abcdef';

export async function fakeElegoo(): Promise<FakeElegoo> {
  const status: Record<string, unknown> = {
    CurrentStatus: [0],
    PrintInfo: { Status: 0, CurrentLayer: 0, TotalLayer: 0, CurrentTicks: 0, TotalTicks: 0, Filename: '', Progress: 0 },
    TempOfNozzle: 25.1,
    TempTargetNozzle: 0,
    TempOfHotbed: 24.9,
    TempTargetHotbed: 0,
    TempOfBox: 26,
  };
  const commands: FakeElegoo['commands'] = [];
  const acks = new Map<number, number>();
  const silent = new Set<number>();
  const statusMessage = () => JSON.stringify({ Status: status, MainboardID: ELEGOO_MAINBOARD, TimeStamp: 1, Topic: `sdcp/status/${ELEGOO_MAINBOARD}` });
  const base = await serve(
    (_req, res) => json(res, 404, {}),
    (req, socket) => {
      if (!(req.url ?? '').startsWith('/websocket')) return socket.destroy();
      const ws = acceptSocket(req, socket, (t, s) => {
        const m = JSON.parse(t) as { Data: FakeElegoo['commands'][number] };
        commands.push(m.Data);
        const cmd = m.Data.Cmd;
        if (cmd === 1) return s.send(JSON.stringify({ Attributes: { Name: 'Centauri Carbon', MachineName: 'Elegoo Centauri Carbon', BrandName: 'ELEGOO', FirmwareVersion: 'V1.1.29', MainboardID: ELEGOO_MAINBOARD }, MainboardID: ELEGOO_MAINBOARD, TimeStamp: 1, Topic: `sdcp/attributes/${ELEGOO_MAINBOARD}` }));
        if (cmd === 0) return s.send(statusMessage());
        if (silent.has(cmd)) return;
        const data: Record<string, unknown> = { Ack: acks.get(cmd) ?? 0 };
        if (cmd === 258) data.FileList = [{ name: '/local/benchy.gcode', usedSize: 100, type: 1 }, { name: '/local/folder', type: 0 }];
        const info = status.PrintInfo as Record<string, unknown>;
        const next = data.Ack === 0 ? ({ 128: 13, 129: 6, 131: 13, 130: 0 } as Record<number, number>)[cmd] : undefined;
        if (cmd === 128 && data.Ack === 0) Object.assign(info, { Filename: String(m.Data.Data.Filename ?? '').replace(/^\/local\//, ''), Progress: 0 });
        s.send(JSON.stringify({ Id: 'x', Data: { Cmd: cmd, Data: data, RequestID: m.Data.RequestID, MainboardID: ELEGOO_MAINBOARD, TimeStamp: 1 }, Topic: `sdcp/response/${ELEGOO_MAINBOARD}` }));
        if (next !== undefined) {
          info.Status = next;
          status.CurrentStatus = [next === 0 ? 0 : 1];
          s.send(statusMessage());
        }
      });
      if (ws) base.sockets.add(ws);
    },
  );
  return Object.assign(base, {
    status,
    commands,
    acks,
    silent,
    pushStatus(next: Record<string, unknown>) {
      Object.assign(status, next);
      for (const ws of base.sockets) ws.send(statusMessage());
    },
  }) as FakeElegoo;
}

/** Waits until `ready()` is true (polling every 10 ms), or fails after `ms`. */
export async function until(ready: () => boolean, what: string, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`not within ${ms} ms: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
