// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Muon 3D Technologies Limited
// Adapted from Muon3D Fluidd (src/services/foreign-printers/adapters/elegoo-cc.ts), written by Muon 3D.
//
// Elegoo's SDCP v3 (the Centauri Carbon) on its WebSocket at port 3030 (or the port typed with its address),
// `/websocket`. The printer pushes its status and attributes; a request is an envelope with a command number, a
// request id and the mainboard's id, which the printer tells in everything it sends (0 status, 1 attributes, 128 start
// a stored file, 129 pause, 130 stop, 131 continue, 258 list files). An answer carries the request's id and an Ack (0: done). SDCP's file upload is not
// open to a page on another origin, so a print starts from a file already on the printer.
import { fail } from '../errors/failure.ts';
import { printerError } from '../errors/kinds.ts';
import { brandEnv, emptyStatus, fraction, keepSocket, parseJson, record, socketAnswer, StatusHub, temp, text, withPort } from './live.ts';
import type { BrandAdapter, BrandCapabilities, BrandEnv, BrandFile, BrandProbe, BrandStatus, BrandTarget } from './types.ts';

export const ELEGOO_CAPABILITIES: BrandCapabilities = { upload: false, startStored: true, listFiles: true, pauseResume: true, stop: true };

/** SDCP's own port. */
export const ELEGOO_PORT = 3030;

/** How long a command waits for its answer. */
export const COMMAND_MS = 5000;

/** The print states SDCP v3 names (PrintInfo.Status) that mean paused, and those that mean a print is under way. */
const PAUSED = new Set([5, 6]);
const UNDER_WAY = new Set([1, 2, 3, 4, 7, 10, 13, 16, 20]);

/** The status from an SDCP `Status` object. Ticks are milliseconds. */
export function elegooStatus(status: Record<string, unknown>): BrandStatus {
  const info = record(status.PrintInfo);
  const code = Number(info.Status);
  const machine = Array.isArray(status.CurrentStatus) ? Number(status.CurrentStatus[0]) : NaN;
  const state = PAUSED.has(code) ? 'paused' : UNDER_WAY.has(code) || machine === 1 ? 'printing' : 'ready';
  const elapsed = Number(info.CurrentTicks);
  const total = Number(info.TotalTicks);
  const ticks = Number.isFinite(elapsed) && Number.isFinite(total) && total > 0;
  const active = state !== 'ready';
  return {
    ...emptyStatus(),
    state,
    file: text(info.Filename),
    progress: active ? (fraction(info.Progress, true) ?? (ticks ? fraction(elapsed / total) : null)) : null,
    secondsLeft: active && ticks ? Math.max(0, (total - elapsed) / 1000) : null,
    hotend: temp(status.TempOfNozzle, status.TempTargetNozzle),
    bed: temp(status.TempOfHotbed, status.TempTargetHotbed),
    chamber: temp(status.TempOfBox, null),
  };
}

const socketUrl = (host: string) => `ws://${withPort(host, ELEGOO_PORT)}/websocket`;

interface Pending {
  cmd: number;
  resolve(data: Record<string, unknown>): void;
  reject(error: unknown): void;
  timer: unknown;
}

export function createElegooAdapter(target: BrandTarget, env: Partial<BrandEnv> = {}): BrandAdapter {
  const e = brandEnv(env);
  let mainboard = '';
  const pending = new Map<string, Pending>();
  let send: ((data: string) => void) | null = null;
  const envelope = (cmd: number, data: Record<string, unknown>, requestId: string) =>
    JSON.stringify({ Id: '', Data: { Cmd: cmd, Data: data, RequestID: requestId, MainboardID: mainboard, TimeStamp: Math.floor(e.now() / 1000), From: 1 }, Topic: `sdcp/request/${mainboard}` });
  const failAll = () => {
    for (const p of pending.values()) {
      e.clearTimeout(p.timer);
      p.reject(fail(printerError('lost', 'The connection to the printer broke off')));
    }
    pending.clear();
  };
  const answered = (message: Record<string, unknown>) => {
    const outer = record(message.Data);
    const inner = record(outer.Data);
    const id = typeof outer.RequestID === 'string' ? outer.RequestID : null;
    const cmd = Number(outer.Cmd ?? inner.Cmd);
    const entry = (id && pending.has(id) ? [id, pending.get(id)!] : [...pending.entries()].find(([, p]) => p.cmd === cmd)) as [string, Pending] | undefined;
    if (!entry) return;
    pending.delete(entry[0]);
    e.clearTimeout(entry[1].timer);
    const ack = Number(inner.Ack ?? outer.Ack ?? 0);
    if (ack === 0) entry[1].resolve(inner);
    else entry[1].reject(fail(printerError('printer', `The printer refused command ${cmd} (Ack ${ack})`, { detail: ack === 2 ? 'File not found' : ack === 1 ? 'The printer is busy' : `Ack ${ack}` })));
  };
  const hub = new StatusHub((h) => {
    const socket = keepSocket(e, h, socketUrl(target.host), undefined, {
      open(ws) {
        h.set({ state: 'ready' });
        ws.send(envelope(1, {}, e.randomId()));
        ws.send(envelope(0, {}, e.randomId()));
      },
      message(data) {
        const m = record(parseJson(data));
        if (typeof m.MainboardID === 'string' && m.MainboardID) mainboard = m.MainboardID;
        if (m.Status) h.set(elegooStatus(record(m.Status)));
        if (typeof m.Topic === 'string' && m.Topic.startsWith('sdcp/response/')) answered(m);
      },
      down: failAll,
    });
    send = socket.send;
    return () => {
      send = null;
      failAll();
      socket.end();
    };
  });
  const command = (cmd: number, data: Record<string, unknown> = {}): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      if (!send) return reject(fail(printerError('offline', 'The printer is not connected')));
      const requestId = e.randomId();
      const timer = e.setTimeout(() => {
        if (pending.delete(requestId)) reject(fail(printerError('timeout', `The printer did not answer command ${cmd} in time`)));
      }, COMMAND_MS);
      pending.set(requestId, { cmd, resolve, reject, timer });
      try {
        send(envelope(cmd, data, requestId));
      } catch (err) {
        pending.delete(requestId);
        e.clearTimeout(timer);
        reject(err);
      }
    });
  return {
    kind: 'elegoo-sdcp',
    capabilities: ELEGOO_CAPABILITIES,
    status: () => hub.get(),
    subscribe: (listener) => hub.subscribe(listener),
    pause: async () => void (await command(129)),
    resume: async () => void (await command(131)),
    stop: async () => void (await command(130)),
    async listFiles(): Promise<BrandFile[]> {
      const data = await command(258, { Url: '/local' });
      const list = data.FileList ?? data.Files ?? [];
      return (Array.isArray(list) ? list : []).flatMap((f) => {
        const file = record(f);
        const path = text(file.name) ?? text(file.Name) ?? text(file.Path);
        // Folders have no extension.
        return path && /\.[a-z0-9]+$/i.test(path) ? [{ path, name: path.split('/').pop() ?? path }] : [];
      });
    },
    async startFile(path: string) {
      await command(128, { Filename: path.startsWith('/local/') ? path : `/local/${path.replace(/^\/+/, '')}`, StartLayer: 0 });
    },
    close: () => hub.close(),
  };
}

/** Whether an SDCP printer answers at `target.host`: its name, machine and firmware from its attributes. */
export async function probeElegoo(target: BrandTarget, env: Partial<BrandEnv> = {}): Promise<BrandProbe> {
  const e = brandEnv(env);
  let opened = false;
  const found = await socketAnswer(
    e,
    socketUrl(target.host),
    undefined,
    (ws) => {
      opened = true;
      ws.send(JSON.stringify({ Id: '', Data: { Cmd: 1, Data: {}, RequestID: e.randomId(), MainboardID: '', TimeStamp: Math.floor(e.now() / 1000), From: 1 }, Topic: 'sdcp/request/' }));
    },
    (data) => {
      const m = record(parseJson(data));
      return m.Attributes ? record(m.Attributes) : null;
    },
  );
  if (!found) return { found: false, why: opened ? 'not-this-kind' : 'no-answer' };
  return { found: true, name: text(found.Name), model: text(found.MachineName), firmware: text(found.FirmwareVersion) };
}
