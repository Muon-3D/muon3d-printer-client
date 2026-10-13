// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Muon 3D Technologies Limited
// The printers: the status words every client shares with Muon3D Control (status.ts), one entry per printer from the
// account, this browser and the network (directory.ts), a printer's name as shown (name.ts) and its page's address in
// Control (slug.ts). Only these are the package's API; the modules' other exports are for its tests.
export {
  accountHealth,
  groupSummary,
  healthOfMoonraker,
  healthWords,
  jobName,
  needsYou,
  TILE_STATES,
  tileLabel,
  tileOfHealth,
  tileTone,
  tileWords,
  type MoonrakerReading,
  type PrinterHealth,
  type TileContext,
  type TileState,
  type TileTone,
} from './status.ts';
export {
  addressesOf,
  hostOf,
  printerDirectory,
  sameExactName,
  sameNamedPrinter,
  savedName,
  savedUpdates,
  tileOfEntry,
  type AccountPrinter,
  type Directory,
  type DirectoryEntry,
  type DirectorySection,
  type DirectorySources,
  type FoundPrinter,
  type SavedPrinter,
  type SavedUpdate,
} from './directory.ts';
export { printerNameParts, type PrinterNameParts } from './name.ts';
export {
  hash4,
  isPrinterSlug,
  printerPath,
  ROUTE_SLUG_PATTERN,
  slugForAccountPrinter,
  slugForAddress,
  slugForIdentity,
  slugForMdnsHost,
  slugify,
  slugSuffix,
  type IdentityName,
} from './slug.ts';
