// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Muon 3D Technologies Limited
// The local network: asking an address whether it is a Muon3D printer and how it is (discovery.ts), whether this page
// and this browser may reach the network at all, and the printer's own page as the way round (page.ts). No sweep of
// the network. Only these are the package's API; the modules' other exports are for its tests.
export {
  ADDRESS_TIMEOUT_MS,
  addressCandidates,
  apiUrlFor,
  foundPrinterOf,
  healthOfLan,
  lanEnv,
  lanFetch,
  lanIpv4Block,
  localNetworkPermission,
  mdnsHostFor,
  nearbyHost,
  pageBlocksLanIpv4,
  pageCanReach,
  pageOpenedByName,
  printerHealth,
  probe,
  probeAddress,
  PROBE_TIMEOUT_MS,
  resetPageBlockCheck,
  type LanEnv,
  type LanHealth,
  type LanIpv4Block,
  type LanPrinter,
} from './discovery.ts';
export { escapeHtml, pageBlocksPrinter, printerPageUrl } from './page.ts';
