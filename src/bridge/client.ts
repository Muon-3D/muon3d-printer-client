// SPDX-License-Identifier: Apache-2.0
// The client's side of printer-bridge/1 (protocol.ts): the page in the frame. connectBridge() says hello to the parent
// window until a host welcomes it, then every request, answer and event travels on the port the welcome transferred.
//
// - The hello goes to the parent window once for each allowed host origin (an exact targetOrigin, never '*': the
//   browser delivers only the copy addressed to the parent's real origin), every 500 ms until a welcome, for 10 s at
//   most. With no welcome by then the client resolves to null and the app runs with no printer.
// - A welcome counts only when it comes from the parent window, from an allowed origin, echoes this hello's nonce, picks
//   a version the hello offered, and carries exactly one port. The first such welcome wins; window messages after it
//   are not read.
// - A request names its printer, waits for one answer (a result or a failure, with progress messages before it for an
//   upload) and is refused here, unsent, when the welcome did not grant its capability. An answer that names another
//   printer than the request did is `printer-changed`. An aborted request sends `cancel` and rejects at once.
// - Events: printer.changed tells which printer the host has selected now; printer.status and printer.gcode for any
//   other printer than that one are dropped here, so a listener never sees another printer's status.
// - Requests reject with a PrinterError (errors/kinds.ts): the host's failure read as an untrusted host's, or the
//   client's own (`cancelled`, `lost` once closed, `protocol` for an answer that is not one).
import { cancelledError, protocolError } from '../errors/parse.ts';
import { printerError, type PrinterError } from '../errors/kinds.ts';
import {
  BRIDGE_VERSIONS,
  checkHostOrigins,
  helloMessage,
  HOST_EVENTS,
  LIMITS,
  makeNonce,
  OPS,
  originAllowed,
  parseBridgePrinter,
  parseIncoming,
  parseWelcome,
  type BridgeOp,
  type BridgePrinter,
  type ClientEventName,
  type HostEventName,
  type UploadStep,
  type Welcome,
} from './protocol.ts';

/** Where window messages arrive: the client's own window. */
export interface MessageTarget {
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}

/** The parent window (a WindowProxy: all a cross-origin parent exposes). */
export interface ParentWindow {
  postMessage(message: unknown, targetOrigin: string): void;
}

/** The part of MessagePort the client uses. */
export interface PortLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent) => void) | null;
  close(): void;
}

export interface Timers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realTimers: Timers = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface ConnectOptions {
  /** The exact origins of the pages allowed to host the client (checkHostOrigins). */
  hostOrigins: readonly string[];
  /** The client's name and version, for the host's logs. */
  app: string;
  appVersion: string;
  /** window.parent. */
  parent: ParentWindow;
  /** The client's own window, where the welcome arrives. */
  target: MessageTarget;
  versions?: readonly number[];
  /** Default: 16 random bytes (makeNonce). */
  nonce?: string;
  timers?: Timers;
  helloEveryMs?: number;
  helloForMs?: number;
  /** Stops saying hello (the promise resolves to null). */
  signal?: AbortSignal;
}

export interface RequestOptions {
  /** Objects to transfer with the request (an upload's bytes). */
  transfer?: Transferable[];
  /** An upload's steps, before its result. */
  onProgress?: (step: UploadStep) => void;
  /** Aborting sends `cancel` for the request and rejects it as `cancelled`. */
  signal?: AbortSignal;
}

/** An event's listener: the printer it names (null for the UI's events and for "no printer") and its data. */
export type EventListener = (printer: string | null, data: unknown) => void;

export interface BridgeClient {
  readonly welcome: Welcome;
  /** The host page's origin. */
  readonly origin: string;
  /** The printer the host has selected, as its last printer.changed (or printer.get) said; null for none. */
  readonly printer: BridgePrinter | null;
  /** Whether the welcome granted what `op` needs. */
  can(op: BridgeOp): boolean;
  /** Sends a request; resolves to its result, rejects with a PrinterError. */
  request(op: BridgeOp, params: Record<string, unknown>, options?: RequestOptions): Promise<unknown>;
  /** Listens to one of the host's events; returns the remover. */
  on(event: HostEventName, listener: EventListener): () => void;
  /** Sends one of the client's events. */
  emit(event: ClientEventName, data: unknown): void;
  /** Closes the port; every request still waiting rejects as `lost`. */
  close(): void;
}

interface Pending {
  printer: string | null;
  op: BridgeOp;
  resolve: (value: unknown) => void;
  reject: (error: PrinterError) => void;
  onProgress?: (step: UploadStep) => void;
}

/**
 * Says hello until a host welcomes the client (see the file comment). Resolves to the client, or to null when no host
 * welcomed it within `helloForMs` (or `signal` aborted). Throws when an origin is not allowed as one.
 */
export function connectBridge(options: ConnectOptions): Promise<BridgeClient | null> {
  const origins = checkHostOrigins(options.hostOrigins);
  const timers = options.timers ?? realTimers;
  const nonce = options.nonce ?? makeNonce();
  const hello = helloMessage({ app: options.app, appVersion: options.appVersion, nonce, versions: options.versions ?? BRIDGE_VERSIONS });
  const { parent, target } = options;
  return new Promise((resolve) => {
    if (!origins.length || options.signal?.aborted) return resolve(null);
    let done = false;
    const finish = (client: BridgeClient | null) => {
      if (done) return;
      done = true;
      timers.clearInterval(every);
      timers.clearTimeout(giveUp);
      target.removeEventListener('message', onMessage);
      options.signal?.removeEventListener('abort', onAbort);
      resolve(client);
    };
    const onMessage = (event: MessageEvent) => {
      // Only the parent, only an allowed origin, only this hello's welcome, and exactly one port.
      if (event.source !== (parent as unknown) || !originAllowed(event.origin, origins)) return;
      const welcome = parseWelcome(event.data, hello);
      if (typeof welcome === 'string' || event.ports?.length !== 1) return;
      finish(createClient(event.ports[0] as unknown as PortLike, welcome, event.origin));
    };
    const onAbort = () => finish(null);
    const say = () => {
      for (const origin of origins) {
        try {
          parent.postMessage(hello, origin);
        } catch {
          // A parent that has gone: the timeout ends the wait.
        }
      }
    };
    target.addEventListener('message', onMessage);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const every = timers.setInterval(say, options.helloEveryMs ?? LIMITS.helloEveryMs);
    const giveUp = timers.setTimeout(() => finish(null), options.helloForMs ?? LIMITS.helloForMs);
    say();
  });
}

/** The client on a welcomed port (exported for the tests, which connect it to a host directly). */
export function createClient(port: PortLike, welcome: Welcome, origin: string): BridgeClient {
  const granted = new Set(welcome.capabilities);
  const can = (op: BridgeOp) => {
    const capability = OPS[op];
    return capability === null || granted.has(capability);
  };
  const pending = new Map<number, Pending>();
  const listeners = new Map<HostEventName, Set<EventListener>>();
  let nextId = 1;
  let closed = false;
  let printer: BridgePrinter | null = null;

  const settle = (id: number) => {
    const p = pending.get(id);
    pending.delete(id);
    return p;
  };

  const dispatch = (event: HostEventName, key: string | null, data: unknown) => {
    for (const listener of [...(listeners.get(event) ?? [])]) {
      try {
        listener(key, data);
      } catch {
        // One listener's failure is its own.
      }
    }
  };

  port.onmessage = (event: MessageEvent) => {
    if (closed) return;
    const message = parseIncoming(event.data);
    if (!message) return;
    if (message.kind === 'event') {
      const capability = HOST_EVENTS[message.event];
      if (capability !== null && !granted.has(capability)) return;
      if (message.event === 'printer.changed') {
        const next = parseBridgePrinter((message.data as { printer?: unknown } | null)?.printer ?? null);
        // The event's key and its printer must agree; a printer that is not one reads as none.
        printer = next && next.key === message.printer ? next : null;
        return dispatch('printer.changed', printer?.key ?? null, { printer });
      }
      if (message.event === 'printer.status' || message.event === 'printer.gcode') {
        if (!printer || message.printer !== printer.key) return;
      }
      return dispatch(message.event, message.printer, message.data);
    }
    const p = pending.get(message.re);
    if (!p) return;
    if (message.kind === 'progress') {
      if (message.printer === p.printer) p.onProgress?.(message.progress);
      return;
    }
    settle(message.re);
    if (message.kind === 'failure') return p.reject(message.error);
    if (p.op !== 'printer.get' && message.printer !== p.printer) {
      return p.reject(printerError('printer-changed', 'The host answered for another printer'));
    }
    if (p.op === 'printer.get') {
      const result = (message.result as { printer?: unknown } | null)?.printer;
      const next = result === null ? null : parseBridgePrinter(result);
      if (result !== null && !next) return p.reject(protocolError('printer.get answered without a printer'));
      printer = next;
      return p.resolve({ printer: next });
    }
    p.resolve(message.result);
  };

  const request = (op: BridgeOp, params: Record<string, unknown>, options: RequestOptions = {}): Promise<unknown> =>
    new Promise((resolve, reject) => {
      if (closed) return reject(printerError('lost', 'The bridge is closed'));
      if (!can(op)) return reject(printerError('unsupported', `The host did not grant ${op}`));
      if (options.signal?.aborted) return reject(cancelledError());
      const id = nextId++;
      const key = typeof params.printer === 'string' ? params.printer : null;
      const onAbort = () => {
        if (!pending.has(id)) return;
        settle(id);
        if (key && can('cancel')) {
          try {
            port.postMessage({ v: 1, id: nextId++, op: 'cancel', params: { printer: key, id } });
          } catch {
            // The port has gone; nothing to cancel.
          }
        }
        reject(cancelledError());
      };
      pending.set(id, {
        printer: key,
        op,
        onProgress: options.onProgress,
        resolve: (value) => (options.signal?.removeEventListener('abort', onAbort), resolve(value)),
        reject: (error) => (options.signal?.removeEventListener('abort', onAbort), reject(error)),
      });
      options.signal?.addEventListener('abort', onAbort, { once: true });
      try {
        port.postMessage({ v: 1, id, op, params }, options.transfer ?? []);
      } catch (err) {
        settle(id);
        options.signal?.removeEventListener('abort', onAbort);
        reject(printerError('bad-request', 'The request could not be sent', { detail: err instanceof Error ? err.message : String(err) }));
      }
    });

  return {
    welcome,
    origin,
    get printer() {
      return printer;
    },
    can,
    request,
    on(event, listener) {
      let set = listeners.get(event);
      if (!set) listeners.set(event, (set = new Set()));
      set.add(listener);
      return () => void set.delete(listener);
    },
    emit(event, data) {
      if (closed) return;
      try {
        port.postMessage({ v: 1, event, printer: null, data });
      } catch {
        // Not a structured-cloneable value, or the port has gone: an event is never more than news.
      }
    },
    close() {
      if (closed) return;
      closed = true;
      port.onmessage = null;
      port.close();
      for (const [id, p] of [...pending]) {
        pending.delete(id);
        p.reject(printerError('lost', 'The bridge closed'));
      }
      listeners.clear();
    },
  };
}

