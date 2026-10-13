// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Muon 3D Technologies Limited
// Adapted from Muon3D Fluidd (src/services/foreign-printers/adapters/octoprint.ts and appkeys.ts), written by Muon 3D.
//
// OctoPrint from a page on another origin: OctoPrint's Settings › API › "Allow Cross Origin Resource Sharing" must be
// on, and every request carries an API key (X-Api-Key). Status is read every 3 s while anyone listens (the job and the
// printer); a printer OctoPrint is not connected to reads `error`. Uploads go to OctoPrint's local storage and,
// asked to, are selected and started at once. A key can be asked of OctoPrint itself (its Application Keys plugin):
// the person approves the request in OctoPrint, and the page polls for the answer. Its camera is the one in its
// settings (`/api/settings` webcam: the stream, else the snapshot, relative to OctoPrint's own address).
import { askJson, brandEnv, cameraUrl, emptyStatus, fraction, httpUrl, record, seconds, StatusHub, temp, text } from './live.ts';
import type { BrandAdapter, BrandCamera, BrandCapabilities, BrandEnv, BrandFile, BrandProbe, BrandStatus, BrandTarget, BrandUpload } from './types.ts';

export const OCTOPRINT_CAPABILITIES: BrandCapabilities = { upload: true, startStored: true, listFiles: true, pauseResume: true, stop: true, camera: true, queue: false };

/**
 * The camera in OctoPrint's settings (`webcam`), for OctoPrint at `host`; none when it is turned off or has no address.
 * A stream ending in .m3u8 or naming WebRTC is not MJPEG: it is offered to open, not drawn. `rotate90` turns it a
 * quarter anticlockwise.
 */
export function octoprintCameras(settings: unknown, host: string): BrandCamera[] {
  const webcam = record(record(settings).webcam);
  if (webcam.webcamEnabled === false) return [];
  const base = `http://${host}`;
  const stream = cameraUrl(webcam.streamUrl, base);
  const snapshot = cameraUrl(webcam.snapshotUrl, base);
  const pageUrl = stream ?? snapshot;
  if (!pageUrl) return [];
  const notMjpeg = stream !== null && /\.m3u8(?:$|\?)|webrtc/i.test(stream);
  const kind = stream && !notMjpeg ? 'mjpeg' : snapshot ? 'snapshot' : 'other';
  return [{ name: 'Camera', kind, url: kind === 'mjpeg' ? stream : kind === 'snapshot' ? snapshot : null, pageUrl, flipH: webcam.flipH === true, flipV: webcam.flipV === true, rotation: webcam.rotate90 === true ? 270 : 0 }];
}

/** How often the status is read while anyone listens. */
export const OCTOPRINT_POLL_MS = 3000;

/** The status from OctoPrint's `/api/printer` and `/api/job` answers (`printer` null: OctoPrint is not connected to it). */
export function octoprintStatus(printer: unknown, job: unknown): BrandStatus {
  if (printer === null) return { ...emptyStatus('error'), message: 'OctoPrint is not connected to the printer' };
  const p = record(printer);
  const state = record(p.state);
  const flags = record(state.flags);
  const temps = record(p.temperature);
  const j = record(job);
  const file = record(record(j.job).file);
  const progress = record(j.progress);
  const active = flags.printing === true || flags.paused === true || flags.pausing === true;
  return {
    ...emptyStatus(),
    state: flags.error === true || flags.closedOrError === true ? 'error' : flags.paused === true || flags.pausing === true ? 'paused' : flags.printing === true ? 'printing' : 'ready',
    message: text(state.text),
    file: text(file.path) ?? text(file.name),
    progress: active ? fraction(progress.completion, true) : null,
    secondsLeft: active ? seconds(progress.printTimeLeft) : null,
    hotend: temp(record(temps.tool0).actual, record(temps.tool0).target),
    bed: temp(record(temps.bed).actual, record(temps.bed).target),
    chamber: temp(record(temps.chamber).actual, record(temps.chamber).target),
  };
}

const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/');

export function createOctoPrintAdapter(target: BrandTarget, env: Partial<BrandEnv> = {}): BrandAdapter {
  const e = brandEnv(env);
  const key = target.apiKey ?? null;
  const url = (path: string) => httpUrl(target.host, path);
  const hub = new StatusHub((h) => {
    let ended = false;
    const read = async () => {
      try {
        const printer = await askJson(e, url('/api/printer'), { apiKey: key }).catch((err: unknown) => {
          // 409: OctoPrint answers, but is not connected to the printer.
          if ((err as { error?: { status?: number } }).error?.status === 409) return null;
          throw err;
        });
        const job = await askJson(e, url('/api/job'), { apiKey: key });
        if (!ended) h.set(octoprintStatus(printer, job));
      } catch (err) {
        if (ended) return;
        const kind = (err as { error?: { kind?: string } }).error?.kind;
        h.set({ ...emptyStatus(kind === 'denied' ? 'error' : 'offline'), message: kind === 'denied' ? 'OctoPrint refused the API key' : null });
      }
    };
    void read();
    const timer = e.setInterval(() => void read(), OCTOPRINT_POLL_MS);
    return () => {
      ended = true;
      e.clearInterval(timer);
    };
  });
  const job = async (body: unknown) => {
    await askJson(e, url('/api/job'), { method: 'POST', body, apiKey: key });
  };
  return {
    kind: 'octoprint',
    capabilities: OCTOPRINT_CAPABILITIES,
    status: () => hub.get(),
    subscribe: (listener) => hub.subscribe(listener),
    pause: () => job({ command: 'pause', action: 'pause' }),
    resume: () => job({ command: 'pause', action: 'resume' }),
    stop: () => job({ command: 'cancel' }),
    async upload(file: BrandUpload, options = {}) {
      const form = new FormData();
      form.append('file', new Blob([file.bytes as BlobPart]), file.name);
      if (options.start) {
        form.append('select', 'true');
        form.append('print', 'true');
      }
      const answer = record(await askJson(e, url('/api/files/local'), { body: form, apiKey: key, timeoutMs: 120_000, signal: options.signal }));
      const local = record(record(answer.files).local);
      return text(local.path) ?? text(local.name) ?? file.name;
    },
    async listFiles(): Promise<BrandFile[]> {
      const out: BrandFile[] = [];
      const walk = (entries: unknown) => {
        for (const entry of Array.isArray(entries) ? entries : []) {
          const f = record(entry);
          if (f.type === 'folder') walk(f.children);
          else if (typeof f.path === 'string') out.push({ path: f.path, name: text(f.name) ?? f.path });
        }
      };
      walk(record(await askJson(e, url('/api/files/local?recursive=true'), { apiKey: key })).files);
      return out;
    },
    async startFile(path: string) {
      await askJson(e, url(`/api/files/local/${encodePath(path)}`), { method: 'POST', body: { command: 'select', print: true }, apiKey: key });
    },
    async cameras(): Promise<BrandCamera[]> {
      return octoprintCameras(await askJson(e, url('/api/settings'), { apiKey: key }), target.host);
    },
    close: () => hub.close(),
  };
}

/** Whether OctoPrint answers at `target.host`, and its version. Without a key, or with a refused one, it says so. */
export async function probeOctoPrint(target: BrandTarget, env: Partial<BrandEnv> = {}): Promise<BrandProbe> {
  const e = brandEnv(env);
  try {
    const version = record(await askJson(e, httpUrl(target.host, '/api/version'), { apiKey: target.apiKey }));
    const server = text(version.server);
    if (!server && !text(version.text)) return { found: false, why: 'not-this-kind' };
    return { found: true, name: null, model: null, firmware: text(version.text) ?? `OctoPrint ${server}` };
  } catch (err) {
    const kind = (err as { error?: { kind?: string } }).error?.kind;
    if (kind === 'denied') return { found: false, why: target.apiKey ? 'wrong-key' : 'needs-key' };
    if (kind === 'offline' || kind === 'timeout') return { found: false, why: 'no-answer' };
    return { found: false, why: 'not-this-kind' };
  }
}

/** Where a key request stands: asked (approve it in OctoPrint), then the key, or why there is none. */
export type KeyRequest = { state: 'asked' } | { state: 'granted'; apiKey: string } | { state: 'refused' | 'unavailable' };

/**
 * Asks OctoPrint for an API key for `app` (its Application Keys plugin). `onAsked` runs once the request is made; the
 * person then approves it in OctoPrint. Polls every `intervalMs` for at most `attempts` times. `unavailable`: the
 * plugin is not there (or turned off); `refused`: the person declined, or nobody answered in time.
 */
export async function requestOctoPrintKey(
  host: string,
  options: { app?: string; onAsked?: () => void; intervalMs?: number; attempts?: number; signal?: AbortSignal; env?: Partial<BrandEnv> } = {},
): Promise<KeyRequest> {
  const e = brandEnv(options.env);
  const root = httpUrl(host, '/plugin/appkeys');
  const answer = async (path: string, init: RequestInit = {}) => e.fetch(`${root}${path}`, { ...init, cache: 'no-store', signal: options.signal });
  const probe = await answer('/probe');
  if (probe.status === 404 || !probe.ok) return { state: 'unavailable' };
  const request = await answer('/request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ app: options.app ?? 'Muon3D Slice' }) });
  if (request.status !== 201) return { state: 'unavailable' };
  const token = text(record(await request.json().catch(() => null)).app_token);
  if (!token) return { state: 'unavailable' };
  options.onAsked?.();
  const attempts = options.attempts ?? 120;
  for (let i = 0; i < attempts; i++) {
    await new Promise<void>((resolve) => e.setTimeout(resolve, options.intervalMs ?? 1000));
    if (options.signal?.aborted) return { state: 'refused' };
    const poll = await answer(`/request/${encodeURIComponent(token)}`);
    if (poll.status === 202) continue;
    if (poll.status === 200) {
      const apiKey = text(record(await poll.json().catch(() => null)).api_key);
      return apiKey ? { state: 'granted', apiKey } : { state: 'refused' };
    }
    return { state: 'refused' };
  }
  return { state: 'refused' };
}
