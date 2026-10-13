// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Muon 3D Technologies Limited
// Adapted from Muon3D Fluidd (src/services/foreign-printers/brands.ts), written by Muon 3D.
//
// The kinds a page reaches directly, as a person meets them: a name, what it asks for, what it can do from a page, and
// the steps on the printer before it can be added. None of this loads an adapter: loadBrand does, one kind at a time.
import type { BrandAdapter, BrandCapabilities, BrandEnv, BrandKey, BrandKind, BrandProbe, BrandTarget } from './types.ts';

export interface BrandInfo {
  kind: BrandKind;
  /** "Klipper (Moonraker)". */
  label: string;
  /** Which printers these are: "Voron, RatRig, Sovol, any Klipper printer". */
  examples: string;
  /** Whether it asks for an API key. */
  key: BrandKey;
  capabilities: BrandCapabilities;
  /** The port it answers on when none is typed. */
  ownPort: number;
  /** An address to show as an example in the field. */
  exampleAddress: string;
}

export const BRANDS: Readonly<Record<BrandKind, BrandInfo>> = {
  moonraker: {
    kind: 'moonraker',
    label: 'Klipper (Moonraker)',
    examples: 'Voron, RatRig, Sovol, any Klipper printer',
    key: 'optional',
    capabilities: { upload: true, startStored: true, listFiles: true, pauseResume: true, stop: true, camera: true, queue: true },
    ownPort: 80,
    exampleAddress: 'voron.local',
  },
  octoprint: {
    kind: 'octoprint',
    label: 'OctoPrint',
    examples: 'Any printer run by OctoPrint',
    key: 'required',
    capabilities: { upload: true, startStored: true, listFiles: true, pauseResume: true, stop: true, camera: true, queue: false },
    ownPort: 80,
    exampleAddress: 'octopi.local',
  },
  creality: {
    kind: 'creality',
    label: 'Creality K1, K2, Hi',
    examples: "On Creality's own firmware",
    key: 'none',
    capabilities: { upload: false, startStored: false, listFiles: false, pauseResume: true, stop: true, camera: true, queue: false },
    ownPort: 9999,
    exampleAddress: '192.168.1.52',
  },
  'elegoo-sdcp': {
    kind: 'elegoo-sdcp',
    label: 'Elegoo Centauri',
    examples: 'Centauri Carbon',
    key: 'none',
    capabilities: { upload: false, startStored: true, listFiles: true, pauseResume: true, stop: true, camera: true, queue: false },
    ownPort: 3030,
    exampleAddress: '192.168.1.60',
  },
};

export const BRAND_KINDS: readonly BrandKind[] = ['moonraker', 'octoprint', 'creality', 'elegoo-sdcp'];

export const isBrandKind = (value: unknown): value is BrandKind => typeof value === 'string' && (BRAND_KINDS as readonly string[]).includes(value);

/** The steps on the printer before it can be added from a page served from `pageOrigin`, in plain words. */
export function brandSteps(kind: BrandKind, pageOrigin: string): string[] {
  switch (kind) {
    case 'moonraker':
      return ['In Mainsail or Fluidd, open moonraker.conf.', `Under [authorization], add ${pageOrigin} to cors_domains, then restart Moonraker.`];
    case 'octoprint':
      return ['In OctoPrint, open Settings › API, tick Allow Cross Origin Resource Sharing, and save.', 'Press Ask OctoPrint for a key here, then press Allow in OctoPrint. Or paste a key from Settings › Application Keys.'];
    case 'creality':
      return ["Nothing to change on the printer. Note its address from its screen's network settings."];
    case 'elegoo-sdcp':
      return ['Nothing to change on the printer. Note its address from its network screen.'];
  }
}

/** One kind's adapter and its probe. */
export interface BrandModule {
  create(target: BrandTarget, env?: Partial<BrandEnv>): BrandAdapter;
  probe(target: BrandTarget, env?: Partial<BrandEnv>): Promise<BrandProbe>;
}

/** Loads one kind's adapter (each is its own module, so a page that never meets a kind never loads it). */
export async function loadBrand(kind: BrandKind): Promise<BrandModule> {
  switch (kind) {
    case 'moonraker': {
      const m = await import('./moonraker.ts');
      return { create: m.createMoonrakerAdapter, probe: m.probeMoonraker };
    }
    case 'octoprint': {
      const m = await import('./octoprint.ts');
      return { create: m.createOctoPrintAdapter, probe: m.probeOctoPrint };
    }
    case 'creality': {
      const m = await import('./creality.ts');
      return { create: m.createCrealityAdapter, probe: m.probeCreality };
    }
    case 'elegoo-sdcp': {
      const m = await import('./elegoo.ts');
      return { create: m.createElegooAdapter, probe: m.probeElegoo };
    }
  }
}
