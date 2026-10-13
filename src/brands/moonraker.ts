// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Muon 3D Technologies Limited
// Adapted from Muon3D Fluidd (src/services/foreign-printers/adapters/moonraker.ts), written by Muon 3D.
//
// Klipper through its Moonraker, from a page on another origin: the printer's `[authorization] cors_domains` must name
// the page's origin. Status over Moonraker's WebSocket (`/websocket`: identify, with the API key where there is one,
// then subscribe), everything else over HTTP with the key as X-Api-Key. Uploads go to the gcodes root and, asked to,
// start at once (Moonraker's `print` field).
import { askJson, brandEnv, emptyStatus, fraction, httpUrl, keepSocket, parseJson, record, seconds, StatusHub, temp, text } from './live.ts';
import type { BrandAdapter, BrandCapabilities, BrandEnv, BrandFile, BrandProbe, BrandStatus, BrandTarget, BrandUpload } from './types.ts';

export const MOONRAKER_CAPABILITIES: BrandCapabilities = { upload: true, startStored: true, listFiles: true, pauseResume: true, stop: true };

/** What the status subscription asks for. */
const OBJECTS = { webhooks: ['state', 'state_message'], print_stats: null, virtual_sdcard: ['progress'], extruder: ['temperature', 'target'], heater_bed: ['temperature', 'target'] };

/** Moonraker's `result`, or the body. */
const resultOf = (body: unknown): unknown => record(body).result ?? body;

/** The status from Moonraker's merged object state. */
export function moonrakerStatus(objects: Record<string, Record<string, unknown>>): BrandStatus {
  const webhooks = objects.webhooks ?? {};
  const print = objects.print_stats ?? {};
  const job = String(print.state ?? '');
  const progress = fraction(objects.virtual_sdcard?.progress);
  const duration = seconds(print.print_duration);
  const left = duration !== null && progress !== null && progress > 0.001 ? Math.max(0, duration / progress - duration) : null;
  const klipperReady = webhooks.state === undefined || webhooks.state === 'ready';
  return {
    ...emptyStatus(),
    state: !klipperReady || job === 'error' ? 'error' : job === 'printing' ? 'printing' : job === 'paused' ? 'paused' : 'ready',
    message: !klipperReady ? (text(webhooks.state_message) ?? `Klipper is ${String(webhooks.state)}`) : text(print.message),
    file: text(print.filename),
    progress: job === 'printing' || job === 'paused' ? progress : null,
    secondsLeft: job === 'printing' || job === 'paused' ? left : null,
    hotend: temp(objects.extruder?.temperature, objects.extruder?.target),
    bed: temp(objects.heater_bed?.temperature, objects.heater_bed?.target),
  };
}

export function createMoonrakerAdapter(target: BrandTarget, env: Partial<BrandEnv> = {}): BrandAdapter {
  const e = brandEnv(env);
  const key = target.apiKey ?? null;
  const url = (path: string) => httpUrl(target.host, path);
  const hub = new StatusHub((h) => {
    const objects: Record<string, Record<string, unknown>> = {};
    let id = 1;
    const merge = (status: unknown) => {
      for (const [name, fields] of Object.entries(record(status))) objects[name] = { ...objects[name], ...record(fields) };
      h.set(moonrakerStatus(objects));
    };
    const socket = keepSocket(e, h, `ws://${target.host}/websocket`, undefined, {
      open(ws) {
        ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'server.connection.identify', params: { client_name: 'Muon3D Slice', version: '1', type: 'web', url: 'https://muon3d.com', ...(key ? { api_key: key } : {}) }, id: id++ }));
        ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'printer.objects.subscribe', params: { objects: OBJECTS }, id: id++ }));
      },
      message(data) {
        const m = record(parseJson(data));
        if (m.method === 'notify_status_update' && Array.isArray(m.params)) merge(m.params[0]);
        else if (m.method === 'notify_klippy_disconnected' || m.method === 'notify_klippy_shutdown') merge({ webhooks: { state: m.method === 'notify_klippy_shutdown' ? 'shutdown' : 'disconnected' } });
        else if (m.method === 'notify_klippy_ready') merge({ webhooks: { state: 'ready', state_message: '' } });
        else if (record(m.result).status) merge(record(m.result).status);
      },
    });
    return () => socket.end();
  });
  const post = async (path: string, body: unknown = {}) => {
    await askJson(e, url(path), { method: 'POST', body, apiKey: key });
  };
  return {
    kind: 'moonraker',
    capabilities: MOONRAKER_CAPABILITIES,
    status: () => hub.get(),
    subscribe: (listener) => hub.subscribe(listener),
    pause: () => post('/printer/print/pause'),
    resume: () => post('/printer/print/resume'),
    stop: () => post('/printer/print/cancel'),
    async upload(file: BrandUpload, options = {}) {
      const form = new FormData();
      form.append('root', 'gcodes');
      if (options.start) form.append('print', 'true');
      form.append('file', new Blob([file.bytes as BlobPart]), file.name);
      const item = record(record(resultOf(await askJson(e, url('/server/files/upload'), { body: form, apiKey: key, timeoutMs: 120_000, signal: options.signal }))).item);
      return typeof item.path === 'string' ? item.path : file.name;
    },
    async listFiles(): Promise<BrandFile[]> {
      const files = resultOf(await askJson(e, url('/server/files/list?root=gcodes'), { apiKey: key }));
      return (Array.isArray(files) ? files : []).flatMap((f) => {
        const path = text(record(f).path);
        return path ? [{ path, name: path.split('/').pop() ?? path }] : [];
      });
    },
    async startFile(path: string) {
      await post(`/printer/print/start?filename=${encodeURIComponent(path)}`);
    },
    close: () => hub.close(),
  };
}

/** Whether a Klipper printer answers at `target.host` through Moonraker, and what it says it is. */
export async function probeMoonraker(target: BrandTarget, env: Partial<BrandEnv> = {}): Promise<BrandProbe> {
  const e = brandEnv(env);
  let info: Record<string, unknown>;
  try {
    info = record(resultOf(await askJson(e, httpUrl(target.host, '/server/info'), { apiKey: target.apiKey })));
  } catch (err) {
    const error = (err as { error?: { kind?: string } }).error;
    if (error?.kind === 'denied') return { found: false, why: target.apiKey ? 'wrong-key' : 'needs-key' };
    if (error?.kind === 'offline' || error?.kind === 'timeout') return { found: false, why: 'no-answer' };
    return { found: false, why: 'not-this-kind' };
  }
  if (typeof info.klippy_state !== 'string' && typeof info.moonraker_version !== 'string') return { found: false, why: 'not-this-kind' };
  let hostname: string | null = null;
  let firmware: string | null = null;
  try {
    const printer = record(resultOf(await askJson(e, httpUrl(target.host, '/printer/info'), { apiKey: target.apiKey })));
    hostname = text(printer.hostname);
    firmware = text(printer.software_version);
  } catch {
    // Klipper may not be running: Moonraker answered, which is what matters here.
  }
  return { found: true, name: hostname, model: null, firmware: firmware ?? text(info.moonraker_version) };
}
