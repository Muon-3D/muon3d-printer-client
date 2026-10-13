// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Muon 3D Technologies Limited
// Adapted from Muon3D Fluidd (src/services/muon-cloud/iroh.ts), written by Muon 3D.
//
// This browser's endpoint on the relay, made once and kept: one per relay the account service names, bound with this
// browser's relay key, so the grants the service issues for that key go on working. Every printer is dialled through
// it; a browser has no other way to a printer through the relay. Where the key is kept (and that it is registered and
// proven with the service first) is the client's: the holder only asks for it.
import type { Binding, BindingEndpoint } from './binding.ts';
import { createRelayPrinter, type RelayPrinter } from './printer.ts';
import type { RelayGrant } from './transport.ts';

export interface EndpointHolderOptions {
  /** The binding, loaded and started (loadPinnedBinding). Asked once, when the first endpoint is made. */
  binding(): Promise<Binding>;
  /** This browser's relay key (a 32-byte Ed25519 seed), or null for the binding to make one. */
  secret(): Promise<Uint8Array | null> | Uint8Array | null;
  /** The key an endpoint was made with, as the binding reports it: to keep, when the binding made it. */
  remember?(secret: Uint8Array): void | Promise<void>;
}

export interface EndpointHolder {
  /** The endpoint bound to `relayUrl`: made on the first ask, then the same one. A failure is not kept. */
  endpointFor(relayUrl: string): Promise<BindingEndpoint>;
  /** Dials the printer a grant names, through the endpoint for its relay (RelayTransportOptions.dial). */
  dial(grant: RelayGrant): Promise<RelayPrinter>;
  /** Closes every endpoint; the next ask makes a new one. */
  close(): Promise<void>;
}

export function createEndpointHolder(options: EndpointHolderOptions): EndpointHolder {
  let binding: Promise<Binding> | null = null;
  const endpoints = new Map<string, Promise<BindingEndpoint>>();

  const loaded = (): Promise<Binding> => {
    if (!binding) {
      const loading = options.binding();
      binding = loading;
      loading.catch(() => {
        if (binding === loading) binding = null;
      });
    }
    return binding;
  };

  const holder: EndpointHolder = {
    endpointFor(relayUrl) {
      let endpoint = endpoints.get(relayUrl);
      if (!endpoint) {
        const making = (async () => {
          const b = await loaded();
          const made = await b.MuonEndpoint.create(relayUrl, await options.secret());
          const key = made.secretKey?.();
          if (key && options.remember) await options.remember(key);
          return made;
        })();
        endpoint = making;
        endpoints.set(relayUrl, making);
        making.catch(() => {
          if (endpoints.get(relayUrl) === making) endpoints.delete(relayUrl);
        });
      }
      return endpoint;
    },

    async dial(grant) {
      const endpoint = await holder.endpointFor(grant.relayUrl);
      return createRelayPrinter(await endpoint.connect(grant.printerId));
    },

    async close() {
      const all = [...endpoints.values()];
      endpoints.clear();
      await Promise.all(all.map((e) => e.then((endpoint) => endpoint.close()).catch(() => undefined)));
    },
  };
  return holder;
}
