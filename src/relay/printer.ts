// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Muon 3D Technologies Limited
// Adapted from Muon3D Fluidd (src/services/muon-cloud/iroh.ts), written by Muon 3D.
//
// A printer reached through the relay, shaped like the network: `fetch(path, init)` answers a Response, and
// `openWebSocket(path)` a WebSocket-shaped socket, both over one binding session (binding.ts). So code written for a
// printer on the network (Moonraker's HTTP API and its WebSocket) works through the relay unchanged.
//
// The request is the binding's to frame: a caller's framing headers, and the Host and Authorization the printer's
// gateway sets itself, are left out. A body is encoded once: every encoding of a FormData picks a new boundary, so
// the bytes sent and the Content-Type naming their boundary come from the same encoding. An abort frees the caller
// at once; the binding cannot stop a request already sent, so its answer is dropped.
import type { BindingSession, BindingSocket } from './binding.ts';

/** What a socket's listeners receive: a message's data, or a close's code and reason, or an error. */
export interface PrinterSocketEvent {
  data?: string;
  code?: number;
  reason?: string;
  wasClean?: boolean;
  error?: unknown;
}

export type PrinterSocketListener = (event: PrinterSocketEvent) => void;

/** The part of a WebSocket a printer client uses. */
export interface PrinterSocket {
  /** 1 open, 2 closing, 3 closed, as a WebSocket's. */
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: 'message' | 'close' | 'error', listener: PrinterSocketListener): void;
  removeEventListener(type: 'message' | 'close' | 'error', listener: PrinterSocketListener): void;
}

/** A printer as the relay reaches it. */
export interface RelayPrinter {
  fetch(path: string, init?: RequestInit): Promise<Response>;
  openWebSocket(path: string): Promise<PrinterSocket>;
  close(): void;
}

/**
 * Request headers the binding frames itself, or the printer's gateway sets itself, so a caller's are left out: Host
 * and Authorization (the gateway's own), the body's length and coding, and the hop-by-hop headers.
 */
export const STRIPPED_HEADERS: readonly string[] = Object.freeze([
  'host',
  'authorization',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'proxy-connection',
  'te',
  'trailer',
  'upgrade',
  'expect',
]);

/** Whether the binding frames a header itself (STRIPPED_HEADERS, and every Sec-WebSocket-* header). */
export const isStrippedHeader = (name: string): boolean => {
  const lower = name.toLowerCase();
  return STRIPPED_HEADERS.includes(lower) || lower.startsWith('sec-websocket-');
};

/** The error fetch rejects with when its signal aborts. */
function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The request was aborted', 'AbortError');
}

/** `sending`, or a rejection as soon as `signal` aborts: the caller is free at once, and nothing reads what comes back. */
function untilAborted<T>(sending: Promise<T>, signal: AbortSignal | null | undefined): Promise<T> {
  if (!signal) return sending;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    sending.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/** The headers and body of a request as the binding takes them: names and values alternating, the body's bytes. */
export async function encodeRequest(init: RequestInit = {}): Promise<{ method: string; headers: string[]; body: Uint8Array }> {
  const method = (init.method ?? 'GET').toUpperCase();
  const headers: string[] = [];
  const source = new Headers(init.headers ?? {});
  source.forEach((value, name) => {
    if (!isStrippedHeader(name)) headers.push(name, value);
  });
  let body = new Uint8Array();
  if (init.body !== undefined && init.body !== null) {
    // Encoded once: the bytes and the type come from the same Response.
    const encoded = new Response(init.body);
    body = new Uint8Array(await encoded.arrayBuffer());
    if (typeof FormData !== 'undefined' && init.body instanceof FormData) {
      // A multipart body's boundary lives in the type Response computed: it replaces any type the caller gave.
      const type = encoded.headers.get('content-type');
      if (type) {
        const i = headers.findIndex((h, n) => n % 2 === 0 && h.toLowerCase() === 'content-type');
        if (i >= 0) headers.splice(i, 2);
        headers.push('content-type', type);
      }
    } else if (!source.has('content-type')) {
      // Moonraker's writes take JSON: a string body without a type is sent as JSON. Any other body keeps the type its
      // encoding gives it (a URLSearchParams form, a typed Blob).
      const type = typeof init.body === 'string' ? 'application/json' : encoded.headers.get('content-type');
      if (type) headers.push('content-type', type);
    }
  }
  return { method, headers, body };
}

/** The binding's answer as a Response (a header the platform will not hold is left out). */
function responseOf(answer: { status: number; headers: string[]; body: Uint8Array }): Response {
  const headers = new Headers();
  for (let i = 0; i + 1 < answer.headers.length; i += 2) {
    try {
      headers.append(answer.headers[i], answer.headers[i + 1]);
    } catch {
      // A header name or value the platform refuses to hold.
    }
  }
  const nullBody = answer.status === 204 || answer.status === 205 || answer.status === 304;
  return new Response(nullBody ? null : (answer.body as Uint8Array<ArrayBuffer>), { status: answer.status, headers });
}

/** A WebSocket-shaped socket over a binding socket. */
class RelaySocket implements PrinterSocket {
  readyState = 1;
  private readonly listeners = new Map<string, Set<PrinterSocketListener>>();
  private readonly inner: BindingSocket;
  private readonly decoder = new TextDecoder();

  constructor(inner: BindingSocket) {
    this.inner = inner;
    void this.pump();
  }

  send(data: string): void {
    if (this.readyState !== 1) return;
    this.inner.send(data).catch((error: unknown) => this.fail(error));
  }

  close(): void {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    this.inner
      .close()
      .catch(() => undefined)
      .finally(() => this.closed(1000, ''));
  }

  addEventListener(type: 'message' | 'close' | 'error', listener: PrinterSocketListener): void {
    const set = this.listeners.get(type) ?? new Set<PrinterSocketListener>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: 'message' | 'close' | 'error', listener: PrinterSocketListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  private emit(type: string, event: PrinterSocketEvent): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      try {
        listener(event);
      } catch {
        // One listener's failure does not stop the others, or the socket.
      }
    }
  }

  private async pump(): Promise<void> {
    // Let the caller attach its listeners before the first message.
    await Promise.resolve();
    for (;;) {
      let message: string | Uint8Array | null;
      try {
        message = await this.inner.next();
      } catch (error) {
        this.fail(error);
        return;
      }
      if (this.readyState === 3) return;
      if (message === null) {
        this.closed(1000, '');
        return;
      }
      this.emit('message', { data: typeof message === 'string' ? message : this.decoder.decode(message) });
    }
  }

  private fail(error: unknown): void {
    if (this.readyState === 3) return;
    this.emit('error', { error });
    this.closed(1006, error instanceof Error ? error.message : String(error));
  }

  private closed(code: number, reason: string): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close', { code, reason, wasClean: code === 1000 });
  }
}

/** A printer through a binding session: fetch and WebSocket shaped like the network's. */
export function createRelayPrinter(session: BindingSession): RelayPrinter {
  return {
    async fetch(path, init = {}) {
      const signal = init.signal;
      if (signal?.aborted) throw abortError(signal);
      const { method, headers, body } = await encodeRequest(init);
      // Aborted while the body was read: nothing is sent.
      if (signal?.aborted) throw abortError(signal);
      return responseOf(await untilAborted(session.fetch(method, path, headers, body), signal));
    },
    async openWebSocket(path) {
      return new RelaySocket(await session.openWebSocket(path));
    },
    close() {
      session.close();
    },
  };
}
