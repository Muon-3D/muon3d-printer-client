// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Muon 3D Technologies Limited
// The relay binding (muon-link-web, a wasm build of Muon 3D's muon-link client) as this package sees it. It is passed
// in, never imported: a client loads it (loader.ts checks a pinned copy) and hands it over.
//
// Its API: MuonEndpoint.create(relayUrl, secret) binds an endpoint to exactly one relay and starts dialling it at once
// (so the key must be registered with the account service, and proven, first); connect(printerId) resolves even when
// the printer will refuse the session (the refusal arrives as a close on the first request); a session's fetch is one
// raw HTTP/1.1 exchange with the body copied whole into wasm memory, and a policy refusal resolves as a 403;
// openWebSocket gives a socket whose next() is null at its end. It has no progress, no abort and no timeouts. Its
// errors are Errors with a `kind` (config, connect, lost, protocol, websocket, refused with a numeric `code`), which
// parseBindingError reads.
//
// Two of its rules shape every caller:
// - The request it sends is its own: a caller's framing headers (Host, Content-Length, Transfer-Encoding, Connection,
//   Upgrade, TE, Trailer, Keep-Alive, Proxy-Connection, Expect, Sec-WebSocket-*) are refused, and it adds
//   Content-Length itself. The relay printer (printer.ts) leaves them out.
// - A socket cannot tell why it ended: its next() and send() map every failure to `websocket`, with no close code. The
//   code comes with the session's next fetch or openWebSocket.

export interface BindingResponse {
  status: number;
  /** Header names and values, alternating. */
  headers: string[];
  body: Uint8Array;
}

export interface BindingSocket {
  send(text: string): Promise<void>;
  /** The next message, or null once the socket has ended. */
  next(): Promise<string | Uint8Array | null>;
  close(): Promise<void>;
}

/** One printer's session through the relay. */
export interface BindingSession {
  printerId(): string;
  fetch(method: string, path: string, headers: string[], body: Uint8Array): Promise<BindingResponse>;
  openWebSocket(path: string): Promise<BindingSocket>;
  close(): void;
}

/** This browser's endpoint, bound to one relay. */
export interface BindingEndpoint {
  endpointId(): string;
  /** The endpoint's secret key, where the binding gives it (to keep it across reloads). */
  secretKey?(): Uint8Array;
  connect(printerId: string): Promise<BindingSession>;
  close(): Promise<void>;
}

/** The binding's module, started. */
export interface Binding {
  MuonEndpoint: { create(relayUrl: string, secret: Uint8Array | null): Promise<BindingEndpoint> };
}
