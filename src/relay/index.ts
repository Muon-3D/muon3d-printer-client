// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Muon 3D Technologies Limited
// The relay: the binding's shape (binding.ts), a printer through a binding session with fetch and WebSocket shaped like
// the network's (printer.ts), one printer's connection that dials again when it fails (transport.ts), this browser's
// endpoint per relay (endpoint.ts), and loading a pinned binding after checking its files (loader.ts). The binding is
// passed in, never imported. Only these are the package's API; the modules' other exports are for its tests.
export type { Binding, BindingEndpoint, BindingResponse, BindingSession, BindingSocket } from './binding.ts';
export {
  createRelayPrinter,
  encodeRequest,
  isStrippedHeader,
  STRIPPED_HEADERS,
  type PrinterSocket,
  type PrinterSocketEvent,
  type PrinterSocketListener,
  type RelayPrinter,
} from './printer.ts';
export {
  createRelayTransport,
  MAX_DIAL_DELAY_MS,
  REGRANT_AFTER_FAILURES,
  type RelayConnection,
  type RelayGrant,
  type RelayStatus,
  type RelayTransport,
  type RelayTransportOptions,
  type RelayUsage,
} from './transport.ts';
export { createEndpointHolder, type EndpointHolder, type EndpointHolderOptions } from './endpoint.ts';
export { loadPinnedBinding, pinnedImportUrl, type BindingPin, type LoadBindingOptions } from './loader.ts';
