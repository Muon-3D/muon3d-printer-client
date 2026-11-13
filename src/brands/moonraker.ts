// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Muon 3D Technologies Limited
// Adapted from Muon3D Fluidd (src/services/foreign-printers/adapters/moonraker.ts), written by Muon 3D.
//
// Klipper through its Moonraker, from a page on another origin: the printer's `[authorization] cors_domains` must name
// the page's origin. Status over Moonraker's WebSocket (`/websocket`: identify, with the API key where there is one,
// then subscribe), everything else over HTTP with the key as X-Api-Key. Uploads go to the gcodes root and, asked to,
// start at once (Moonraker's `print` field).
//
// Its cameras are the ones Moonraker lists (`/server/webcams/list`), their addresses relative to the printer's web
// pages. Its job queue (Moonraker's `[job_queue]`): read with the status (`server.job_queue.status`, then
// `notify_job_queue_changed`), and added to, emptied, started and paused over HTTP.
import { askJson, bareHost, brandEnv, cameraUrl, emptyStatus, fraction, httpUrl, keepSocket, parseJson, record, rotationOf, seconds, StatusHub, temp, text } from './live.ts';
import type { BrandAdapter, BrandCamera, BrandCapabilities, BrandEnv, BrandFile, BrandProbe, BrandQueue, BrandStatus, BrandTarget, BrandUpload } from './types.ts';

export const MOONRAKER_CAPABILITIES: BrandCapabilities = { upload: true, startStored: true, listFiles: true, pauseResume: true, stop: true, camera: true, queue: true };

/** Moonraker's own port: a camera's relative address belongs to the printer's web pages (port 80), not to Moonraker. */
const MOONRAKER_PORT = 7125;

/** The webcam services whose stream is MJPEG, and the one a page reads a picture at a time. */
const MJPEG_SERVICES = new Set(['mjpegstreamer', 'uv4l-mjpeg', 'ipstream']);
const SNAPSHOT_SERVICES = new Set(['mjpegstreamer-adaptive']);

/** The cameras in Moonraker's webcam list, for a printer at `host` (a disabled one is left out). */
export function moonrakerCameras(webcams: unknown, host: string): BrandCamera[] {
  const base = `http://${host.endsWith(`:${MOONRAKER_PORT}`) ? bareHost(host) : host}`;
  return (Array.isArray(webcams) ? webcams : []).flatMap((w): BrandCamera[] => {
    const c = record(w);
    if (c.enabled === false) return [];
    const service = text(c.service) ?? 'mjpegstreamer';
    const stream = cameraUrl(c.stream_url, base);
    const snapshot = cameraUrl(c.snapshot_url, base);
    const pageUrl = stream ?? snapshot;
    if (!pageUrl) return [];
    const kind = SNAPSHOT_SERVICES.has(service) ? (snapshot ? 'snapshot' : 'other') : MJPEG_SERVICES.has(service) ? (stream ? 'mjpeg' : snapshot ? 'snapshot' : 'other') : 'other';
    const url = kind === 'mjpeg' ? stream : kind === 'snapshot' ? snapshot : null;
    return [{ name: text(c.name) ?? 'Camera', kind, url, pageUrl, flipH: c.flip_horizontal === true, flipV: c.flip_vertical === true, rotation: rotationOf(c.rotation) }];
  });
}

const QUEUE_STATES = new Set<BrandQueue['state']>(['ready', 'paused', 'loading', 'starting']);
const queueState = (value: unknown): BrandQueue['state'] => (QUEUE_STATES.has(value as BrandQueue['state']) ? (value as BrandQueue['state']) : 'paused');

/** The queue from Moonraker's answer (`queued_jobs`, `queue_state`); null when it is not one. */
export function moonrakerQueue(answer: unknown): BrandQueue | null {
  const r = record(answer);
  if (!Array.isArray(r.queued_jobs)) return null;
  return { state: queueState(r.queue_state), jobs: queueJobs(r.queued_jobs) };
}

function queueJobs(list: unknown[]): BrandQueue['jobs'] {
  return list.flatMap((j) => {
    const job = record(j);
    const id = text(job.job_id);
    const filename = text(job.filename);
    return id && filename ? [{ id, filename, addedAt: typeof job.time_added === 'number' ? job.time_added * 1000 : null }] : [];
  });
}

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
    let queueRequest = -1;
    const socket = keepSocket(e, h, `ws://${target.host}/websocket`, undefined, {
      open(ws) {
        ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'server.connection.identify', params: { client_name: 'Muon3D Slice', version: '1', type: 'web', url: 'https://muon3d.com', ...(key ? { api_key: key } : {}) }, id: id++ }));
        ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'printer.objects.subscribe', params: { objects: OBJECTS }, id: id++ }));
        queueRequest = id++;
        ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'server.job_queue.status', params: {}, id: queueRequest }));
      },
      message(data) {
        const m = record(parseJson(data));
        if (m.method === 'notify_status_update' && Array.isArray(m.params)) merge(m.params[0]);
        else if (m.method === 'notify_klippy_disconnected' || m.method === 'notify_klippy_shutdown') merge({ webhooks: { state: m.method === 'notify_klippy_shutdown' ? 'shutdown' : 'disconnected' } });
        else if (m.method === 'notify_klippy_ready') merge({ webhooks: { state: 'ready', state_message: '' } });
        else if (m.method === 'notify_job_queue_changed' && Array.isArray(m.params)) {
          // updated_queue is null when only the state changed.
          const change = record(m.params[0]);
          const before = h.get().queue;
          h.set({ queue: { state: queueState(change.queue_state ?? before?.state), jobs: Array.isArray(change.updated_queue) ? queueJobs(change.updated_queue) : (before?.jobs ?? []) } });
        } else if (m.id === queueRequest) h.set({ queue: m.error ? null : moonrakerQueue(m.result) });
        else if (record(m.result).status) merge(record(m.result).status);
      },
    });
    return () => socket.end();
  });
  const post = async (path: string, body: unknown = {}) => {
    await askJson(e, url(path), { method: 'POST', body, apiKey: key });
  };
  /** A queue request; its answer is the queue as it now stands. */
  const queueAsk = async (method: 'POST' | 'DELETE', path: string, body?: unknown) => {
    const queue = moonrakerQueue(resultOf(await askJson(e, url(path), { method, body: method === 'POST' ? (body ?? {}) : undefined, apiKey: key })));
    if (queue) hub.set({ queue });
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
    async cameras(): Promise<BrandCamera[]> {
      return moonrakerCameras(record(resultOf(await askJson(e, url('/server/webcams/list'), { apiKey: key }))).webcams, target.host);
    },
    queue: {
      add: (paths) => queueAsk('POST', '/server/job_queue/job', { filenames: paths, reset: false }),
      remove: (jobIds) => queueAsk('DELETE', `/server/job_queue/job?job_ids=${jobIds.map(encodeURIComponent).join(',')}`),
      start: () => queueAsk('POST', '/server/job_queue/start'),
      pause: () => queueAsk('POST', '/server/job_queue/pause'),
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
