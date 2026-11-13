// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Muon 3D Technologies Limited
// Adapted from Muon3D Fluidd (src/services/managed-transport/managedIrohTransport.ts and selectTransport.ts), written by Muon 3D.
//
// One printer through the relay, for as long as a client shows it: a RelayPrinter (printer.ts) dialled on the first
// request, not before, and dialled again when one fails.
//
// A connection that fails a request is assumed gone: it is dropped, and the next request dials the printer again, with
// a backoff (1 s, 2 s, 4 s, … up to 30 s between dials). A dropped connection is never reused, because a dead one fails
// every request at once. The access grant lasts hours, so a failed dial is usually the path, not the grant; but a
// printer that restarted has forgotten it, so after two failed dials in a row a new grant is asked for (`regrant`)
// before the next. A grant for another printer, or one already expired, is refused.
import { printerError } from '../errors/kinds.ts';
import { fail } from '../errors/failure.ts';
import type { PrinterSocket, RelayPrinter } from './printer.ts';

/** What a dial needs of an access grant: the printer, the relay, and when the grant ends (Unix seconds). */
export interface RelayGrant {
  printerId: string;
  relayUrl: string;
  expiresAt?: number;
}

export type RelayConnection = 'idle' | 'connecting' | 'connected' | 'unavailable' | 'closed';
/** What the connection is busy with: nothing, a request, an upload, a camera frame, an open WebSocket. */
export type RelayUsage = 'idle' | 'http' | 'upload' | 'camera' | 'websocket';

export interface RelayStatus {
  connection: RelayConnection;
  usage: RelayUsage;
}

export interface RelayTransportOptions {
  grant: RelayGrant;
  /** Dials the printer a grant names (an endpoint's connect, as createRelayPrinter). */
  dial(grant: RelayGrant): Promise<RelayPrinter>;
  /** A new grant for the same printer, for when dials keep failing with the one it has. */
  regrant?(): Promise<RelayGrant>;
  onStatus?(status: RelayStatus): void;
  /** The clock (ms) and a wait, for the backoff. */
  now?(): number;
  sleep?(ms: number): Promise<void>;
}

export interface RelayTransport {
  readonly status: RelayStatus;
  fetch(path: string, init?: RequestInit, usage?: 'http' | 'upload' | 'camera'): Promise<Response>;
  openWebSocket(path: string): Promise<PrinterSocket>;
  /** Closes the connection and every socket; requests in flight reject as `cancelled`. Final. */
  close(): void;
}

/** The longest wait between two dials of the same printer. */
export const MAX_DIAL_DELAY_MS = 30_000;
/** Dials that fail in a row before a new grant is asked for. */
export const REGRANT_AFTER_FAILURES = 2;

const closedError = () => fail(printerError('cancelled', 'The relay connection was closed'));

/** A new grant must be for the same printer, name a relay, and not have ended. */
function checkGrant(grant: RelayGrant, printerId: string, nowMs: number): RelayGrant {
  if (grant.printerId !== printerId) throw fail(printerError('protocol', 'A new access grant names another printer'));
  if (!grant.relayUrl) throw fail(printerError('protocol', 'A new access grant names no relay'));
  if (typeof grant.expiresAt === 'number' && grant.expiresAt * 1000 <= nowMs) throw fail(printerError('protocol', 'A new access grant has already ended'));
  return grant;
}

export function createRelayTransport(options: RelayTransportOptions): RelayTransport {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const printerId = options.grant.printerId;
  let grant = options.grant;
  let current: Promise<RelayPrinter> | null = null;
  let generation = 0;
  let failedDials = 0;
  let nextDialAt = 0;
  const sockets = new Set<PrinterSocket>();
  let status: RelayStatus = { connection: 'idle', usage: 'idle' };

  const update = (connection: RelayConnection, usage: RelayUsage) => {
    status = { connection, usage };
    options.onStatus?.({ ...status });
  };
  /** Read through a call: `close` changes it while a request waits. */
  const isClosed = () => status.connection === 'closed';
  const unavailableUnlessClosed = () => {
    if (!isClosed()) update('unavailable', 'idle');
  };

  async function dial(gen: number): Promise<RelayPrinter> {
    const wait = nextDialAt - now();
    if (wait > 0) await sleep(wait);
    if (gen !== generation) throw closedError();
    try {
      if (failedDials >= REGRANT_AFTER_FAILURES && options.regrant) {
        grant = checkGrant(await options.regrant(), printerId, now());
        if (gen !== generation) throw closedError();
      }
      const printer = await options.dial(grant);
      if (gen !== generation) {
        printer.close();
        throw closedError();
      }
      failedDials = 0;
      nextDialAt = 0;
      return printer;
    } catch (error) {
      if (gen === generation) {
        failedDials += 1;
        nextDialAt = now() + Math.min(MAX_DIAL_DELAY_MS, 1000 * 2 ** (failedDials - 1));
      }
      throw error;
    }
  }

  /** The connection, dialled when there is none; a failed dial is not kept, so the next request dials again. */
  function connection(): Promise<RelayPrinter> {
    if (!current) {
      const dialling = dial(generation);
      current = dialling;
      dialling.catch(() => {
        if (current === dialling) current = null;
      });
    }
    return current;
  }

  /** A request failed on `printer`: close it, so the next request dials a new one. */
  function drop(printer: Promise<RelayPrinter>): void {
    if (current !== printer) return;
    current = null;
    printer.then((p) => p.close()).catch(() => undefined);
  }

  return {
    get status() {
      return { ...status };
    },

    async fetch(path, init, usage = 'http') {
      if (isClosed()) throw closedError();
      update('connecting', usage);
      const printer = connection();
      try {
        const response = await (await printer).fetch(path, init);
        if (!isClosed()) update('connected', sockets.size ? 'websocket' : 'idle');
        return response;
      } catch (error) {
        drop(printer);
        unavailableUnlessClosed();
        throw error;
      }
    },

    async openWebSocket(path) {
      if (isClosed()) throw closedError();
      update('connecting', 'websocket');
      const printer = connection();
      try {
        const socket = await (await printer).openWebSocket(path);
        if (isClosed()) {
          socket.close();
          throw closedError();
        }
        sockets.add(socket);
        update('connected', 'websocket');
        socket.addEventListener('close', () => {
          sockets.delete(socket);
          if (!isClosed()) update('connected', sockets.size ? 'websocket' : 'idle');
        });
        return socket;
      } catch (error) {
        drop(printer);
        unavailableUnlessClosed();
        throw error;
      }
    },

    close() {
      generation += 1;
      for (const socket of sockets) socket.close();
      sockets.clear();
      current?.then((p) => p.close()).catch(() => undefined);
      current = null;
      update('closed', 'idle');
    },
  };
}
