// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Muon 3D Technologies Limited
// Printers of other kinds a page reaches directly on the local network (Klipper through Moonraker, OctoPrint, Creality's
// stock firmware, Elegoo's SDCP): the kinds as a person meets them and the steps before adding one (kinds.ts), the
// addresses a page may ask (address.ts), and loadBrand, which loads one kind's adapter. The adapters are entry points
// of their own (`./brands/moonraker`, `./brands/octoprint`, `./brands/creality`, `./brands/elegoo`): this one loads
// none of them. Only these are the package's API.
export { browserReachesLan, hostWithPort, isLanUrl, lanAddress, type LanAddress } from './address.ts';
export { BRAND_KINDS, brandSteps, BRANDS, isBrandKind, loadBrand, type BrandInfo, type BrandModule } from './kinds.ts';
export type {
  BrandAdapter,
  BrandCapabilities,
  BrandEnv,
  BrandFile,
  BrandKey,
  BrandKind,
  BrandProbe,
  BrandState,
  BrandStatus,
  BrandTarget,
  BrandTemp,
  BrandUpload,
} from './types.ts';
