// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Muon 3D Technologies Limited
// Adapted from Muon3D Fluidd (src/services/foreign-printers/adapters/base.ts), written by Muon 3D.
//
// What every adapter shares: its status and who listens to it, the connection that runs while anyone does (a socket
// that comes back after a drop, 2 s then twice as long each time up to 30 s, or a poll), and JSON over HTTP with a
// limit, its failures as PrinterErrors (`offline`: nothing answered; `timeout`; `denied`: 401 or 403; `printer`: any
// other refusal, with the printer's words).
import { fail } from '../errors/failure.ts';
import { cleanText, printerError } from '../errors/kinds.ts';
import type { BrandEnv, BrandState, BrandStatus, BrandTemp } from './types.ts';

/** How long an HTTP answer may take. */
export const ANSWER_MS = 8000;

/** The browser's parts, with `over`'s in their place. HTTP goes through `over.fetch` (a client passes lanFetch). */
export function brandEnv(over: Partial<BrandEnv> = {}): BrandEnv {
  const g = globalThis as unknown as {
    fetch: BrandEnv['fetch'];
    WebSocket: BrandEnv['WebSocket'];
    setTimeout(cb: () => void, ms: number): unknown;
    clearTimeout(h: unknown): void;
    setInterval(cb: () => void, ms: number): unknown;
    clearInterval(h: unknown): void;
    crypto?: { randomUUID?(): string };
  };
  return {
    fetch: over.fetch ?? ((url, init) => g.fetch(url, init)),
    WebSocket: over.WebSocket ?? g.WebSocket,
    setTimeout: over.setTimeout ?? ((cb, ms) => g.setTimeout(cb, ms)),
    clearTimeout: over.clearTimeout ?? ((h) => g.clearTimeout(h)),
    setInterval: over.setInterval ?? ((cb, ms) => g.setInterval(cb, ms)),
    clearInterval: over.clearInterval ?? ((h) => g.clearInterval(h)),
    now: over.now ?? (() => Date.now()),
    randomId: over.randomId ?? (() => (g.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`).replace(/-/g, '')),
  };
}

export const emptyStatus = (state: BrandState = 'connecting'): BrandStatus => ({
  state,
  message: null,
  file: null,
  progress: null,
  secondsLeft: null,
  hotend: null,
  bed: null,
  chamber: null,
});

const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)) ? Number(value) : null);

/** A temperature from a reading and its target (a target of 0 or none: not heating). */
export function temp(now: unknown, target: unknown): BrandTemp | null {
  const n = num(now);
  if (n === null) return null;
  const t = num(target);
  return { now: n, target: t !== null && t > 0 ? t : null };
}

/** 0–1 from a fraction, or (`percent`) from 0–100. */
export function fraction(value: unknown, percent = false): number | null {
  const n = num(value);
  if (n === null) return null;
  return Math.min(1, Math.max(0, percent ? n / 100 : n));
}

/** Seconds, from a number that should be one. */
export const seconds = (value: unknown): number | null => {
  const n = num(value);
  return n === null || n < 0 ? null : n;
};

export const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? cleanText(value) : null);

export const record = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

/** `http://<host><path>`. */
export const httpUrl = (host: string, path: string): string => `http://${host}${path}`;

/** The host without a port: `[fe80::1]:7125` → `[fe80::1]`, `voron.local:7125` → `voron.local`. */
export const bareHost = (host: string): string => (host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.replace(/:\d+$/, ''));

/** `host:port`: the port typed with the host, else the kind's own. */
export const withPort = (host: string, ownPort: number): string => (bareHost(host) === host ? `${host}:${ownPort}` : host);

export interface JsonAsk {
  method?: 'GET' | 'POST';
  /** A JSON body, or a FormData. */
  body?: unknown;
  apiKey?: string | null;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** An HTTP request that answers JSON (or nothing); its failures as PrinterFailures. */
export async function askJson(env: BrandEnv, url: string, ask: JsonAsk = {}): Promise<unknown> {
  const controller = new AbortController();
  const timer = env.setTimeout(() => controller.abort(), ask.timeoutMs ?? ANSWER_MS);
  const onAbort = () => controller.abort();
  ask.signal?.addEventListener('abort', onAbort, { once: true });
  const headers: Record<string, string> = {};
  if (ask.apiKey) headers['X-Api-Key'] = ask.apiKey;
  const form = typeof FormData !== 'undefined' && ask.body instanceof FormData;
  if (ask.body !== undefined && !form) headers['Content-Type'] = 'application/json';
  let response: Response;
  try {
    response = await env.fetch(url, {
      method: ask.method ?? (ask.body === undefined ? 'GET' : 'POST'),
      headers,
      body: ask.body === undefined ? undefined : form ? (ask.body as FormData) : JSON.stringify(ask.body),
      signal: controller.signal,
      cache: 'no-store',
    });
  } catch (err) {
    if (ask.signal?.aborted) throw fail(printerError('cancelled', 'Cancelled'));
    if (controller.signal.aborted) throw fail(printerError('timeout', `No answer from ${url} in time`));
    throw fail(printerError('offline', `Nothing answered at ${url}`, { detail: cleanText(err instanceof Error ? err.message : String(err)) }));
  } finally {
    env.clearTimeout(timer);
    ask.signal?.removeEventListener('abort', onAbort);
  }
  const body = await response.text().catch(() => '');
  if (response.status === 401 || response.status === 403) throw fail(printerError('denied', `The printer refused the request (${response.status})`, { status: response.status, detail: cleanText(body.slice(0, 500)) }));
  if (!response.ok) throw fail(printerError('printer', `The printer answered ${response.status}`, { status: response.status, detail: cleanText(body.slice(0, 500)) }));
  if (!body) return null;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw fail(printerError('protocol', 'The printer answered with something that is not JSON'));
  }
}

/** How long a socket waits before it opens again: 2 s, then twice as long each time, at most 30 s. */
export const RECONNECT_MS = [2000, 4000, 8000, 16000, 30000];

/**
 * The status and its listeners. `run` starts the connection when the first listener arrives and returns how to end it;
 * it ends when the last one leaves, or on close().
 */
export class StatusHub {
  private current: BrandStatus = emptyStatus();
  private readonly listeners = new Set<(status: BrandStatus) => void>();
  private end: (() => void) | null = null;
  private closed = false;
  private readonly run: (hub: StatusHub) => () => void;

  constructor(run: (hub: StatusHub) => () => void) {
    this.run = run;
  }

  get(): BrandStatus {
    return this.current;
  }

  set(patch: Partial<BrandStatus>): void {
    this.current = { ...this.current, ...patch };
    for (const listener of [...this.listeners]) listener(this.current);
  }

  subscribe(listener: (status: BrandStatus) => void): () => void {
    if (this.closed) return () => {};
    this.listeners.add(listener);
    listener(this.current);
    if (this.listeners.size === 1 && !this.end) this.end = this.run(this);
    return () => {
      if (!this.listeners.delete(listener) || this.listeners.size > 0) return;
      this.stop();
    };
  }

  private stop(): void {
    const end = this.end;
    this.end = null;
    end?.();
    this.current = emptyStatus();
  }

  close(): void {
    this.closed = true;
    this.listeners.clear();
    this.stop();
  }
}

export interface SocketHandlers {
  open(socket: WebSocket): void;
  message(data: string, socket: WebSocket): void;
  /** The socket dropped (it opens again by itself). */
  down?(): void;
}

/**
 * A WebSocket that opens again after a drop until `end` is called. The status reads `connecting` until it opens and
 * `offline` while it is down.
 */
export function keepSocket(env: BrandEnv, hub: StatusHub, url: string, protocols: string | string[] | undefined, handlers: SocketHandlers): { end(): void; send(data: string): void } {
  let socket: WebSocket | null = null;
  let timer: unknown = null;
  let attempt = 0;
  let ended = false;
  const open = () => {
    if (ended) return;
    let ws: WebSocket;
    try {
      ws = protocols === undefined ? new env.WebSocket(url) : new env.WebSocket(url, protocols);
    } catch {
      return retry();
    }
    socket = ws;
    ws.onopen = () => {
      attempt = 0;
      handlers.open(ws);
    };
    ws.onmessage = (event: MessageEvent) => {
      if (typeof event.data === 'string') handlers.message(event.data, ws);
    };
    ws.onclose = () => {
      if (socket !== ws) return;
      socket = null;
      if (ended) return;
      hub.set({ state: 'offline' });
      handlers.down?.();
      retry();
    };
    ws.onerror = () => {};
  };
  const retry = () => {
    if (ended || timer !== null) return;
    const wait = RECONNECT_MS[Math.min(attempt, RECONNECT_MS.length - 1)];
    attempt++;
    timer = env.setTimeout(() => {
      timer = null;
      open();
    }, wait);
  };
  open();
  return {
    end() {
      ended = true;
      if (timer !== null) env.clearTimeout(timer);
      timer = null;
      const ws = socket;
      socket = null;
      if (ws && ws.readyState < 2) ws.close();
    },
    send(data: string) {
      if (!socket || socket.readyState !== 1) throw fail(printerError('offline', 'The printer is not connected'));
      socket.send(data);
    },
  };
}

/**
 * Opens a socket once, sends what `hello` sends, and resolves with the first answer `pick` accepts; null when nothing
 * answers so within `timeoutMs`. For a probe: it never reconnects.
 */
export function socketAnswer<T>(env: BrandEnv, url: string, protocols: string | string[] | undefined, hello: (socket: WebSocket) => void, pick: (data: string) => T | null, timeoutMs = ANSWER_MS): Promise<T | null> {
  return new Promise((resolve) => {
    let done = false;
    let ws: WebSocket | null = null;
    const finish = (value: T | null) => {
      if (done) return;
      done = true;
      env.clearTimeout(timer);
      if (ws && ws.readyState < 2) ws.close();
      resolve(value);
    };
    const timer = env.setTimeout(() => finish(null), timeoutMs);
    try {
      ws = protocols === undefined ? new env.WebSocket(url) : new env.WebSocket(url, protocols);
    } catch {
      finish(null);
      return;
    }
    ws.onopen = () => hello(ws!);
    ws.onmessage = (event: MessageEvent) => {
      if (typeof event.data !== 'string') return;
      const value = pick(event.data);
      if (value !== null) finish(value);
    };
    ws.onclose = () => finish(null);
    ws.onerror = () => {};
  });
}

/** JSON.parse that answers null instead of throwing. */
export function parseJson(data: string): unknown {
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return null;
  }
}
