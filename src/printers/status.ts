// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Muon 3D Technologies Limited
// Adapted from Muon3D Fluidd (src/services/printers-page/model.ts and src/services/muon-cloud/directory.ts), written by Muon 3D.
//
// What a printer is doing, in the words Muon3D Control shows on its Printers page, so every client says the same:
// a printer's health (what was read from it, PrinterHealth), the state its tile shows (TileState), the colour of that
// state (TileTone) and its word. A client reads health from wherever it reaches the printer (the account service and
// the relay, its own Moonraker on the network) and shows the tile state.

/** The states a printer's tile shows, in the words the page uses. */
export const TILE_STATES = ['printing', 'paused', 'ready', 'error', 'locked', 'connecting', 'unreachable', 'offline', 'new'] as const;

export type TileState = (typeof TILE_STATES)[number];

/** The colour a state is shown in: teal running, green ready, amber needs you, red fault, grey off, blue new. */
export type TileTone = 'run' | 'ok' | 'warn' | 'err' | 'off' | 'info';

const TONES: Readonly<Record<TileState, TileTone>> = {
  printing: 'run',
  paused: 'warn',
  ready: 'ok',
  error: 'err',
  locked: 'warn',
  connecting: 'off',
  unreachable: 'off',
  offline: 'off',
  new: 'info',
};

/** The words on a state's pill. */
const WORDS: Readonly<Record<TileState, string>> = {
  printing: 'Printing',
  paused: 'Paused',
  ready: 'Ready',
  error: 'Error',
  locked: 'Wants access',
  connecting: 'Connecting',
  unreachable: 'Unreachable',
  offline: 'Offline',
  new: 'New',
};

export function tileTone(state: TileState): TileTone {
  return TONES[state];
}

/** The state's word on its pill: Printing, Paused, Ready, Error, Wants access, Connecting, Unreachable, Offline, New. */
export function tileWords(state: TileState): string {
  return WORDS[state];
}

/** The pill as the page shows it: a print's progress ("42%") while printing when it is known, else the state's word. */
export function tileLabel(state: TileState, progress?: number | null): string {
  return state === 'printing' && typeof progress === 'number' && Number.isFinite(progress) ? `${Math.floor(progress)}%` : WORDS[state];
}

/** Paused and faulted printers want someone. */
export function needsYou(state: TileState): boolean {
  return state === 'paused' || state === 'error';
}

/** A group's line: "1 needs you" first when any do, "All ready", or "1 printing · 2 ready · 1 other"; "Empty". */
export function groupSummary(states: readonly TileState[]): { text: string; tone: TileTone } {
  if (!states.length) return { text: 'Empty', tone: 'off' };
  const count = (f: (s: TileState) => boolean) => states.filter(f).length;
  const needing = count(needsYou);
  const printing = count((s) => s === 'printing');
  const ready = count((s) => s === 'ready');
  if (needing) return { text: `${needing} needs you`, tone: 'warn' };
  if (ready === states.length) return { text: 'All ready', tone: 'ok' };
  const parts: string[] = [];
  if (printing) parts.push(`${printing} printing`);
  if (ready) parts.push(`${ready} ready`);
  const rest = states.length - printing - ready;
  if (rest) parts.push(`${rest} other`);
  return { text: parts.join(' · '), tone: printing ? 'run' : 'off' };
}

/** A file's name without its folders and extension: bracket_v2, not prints/bracket_v2.gcode. */
export function jobName(file: string | null | undefined): string | null {
  if (!file) return null;
  const base = file.split('/').pop() ?? file;
  return base.replace(/\.(gcode|g|gco|bgcode)$/i, '');
}

/**
 * What was read from a printer:
 * - `online`: it answered, and Klipper is ready.
 * - `printing`, `paused`: as Klipper says.
 * - `connecting`: being reached now, or nothing read yet.
 * - `searching`: no answer yet, and the search is still running.
 * - `offline`: no answer.
 * - `error`: it answered, and Klipper is not ready, or the connection failed.
 * - `locked`: it answered, and wants a sign-in or refuses this browser.
 * - `available`: found, and its state was not read.
 */
export type PrinterHealth = 'online' | 'printing' | 'paused' | 'connecting' | 'searching' | 'offline' | 'error' | 'locked' | 'available';

/** A health's words, as the printer list's status line says them. */
export function healthWords(health: PrinterHealth): string {
  switch (health) {
    case 'online':
      return 'Online';
    case 'printing':
      return 'Printing';
    case 'paused':
      return 'Paused';
    case 'connecting':
      return 'Connecting…';
    case 'searching':
      return 'Looking for it…';
    case 'offline':
      return 'Offline';
    case 'error':
      return 'Error';
    case 'locked':
      return 'Needs access';
    case 'available':
      return 'On this network';
  }
}

/** Where the printer's tile sits, which changes what some healths show. */
export interface TileContext {
  /** Found on this network or nearby, not yet the person's: a printer whose state was not read is shown ready. */
  found?: boolean;
  /** Found, and waiting to be set up: shown new. */
  needsSetUp?: boolean;
  /**
   * The account service has it online, but this browser's way in (the relay) failed: an error there is the way in
   * failing, not the printer, and shows unreachable. Not for a printer this page reads through its own connection.
   */
  wayInFailed?: boolean;
}

/** The state a printer's tile shows for its health. */
export function tileOfHealth(health: PrinterHealth, context: TileContext = {}): TileState {
  if (context.found && context.needsSetUp) return 'new';
  if (health === 'error' && context.wayInFailed) return 'unreachable';
  switch (health) {
    case 'printing':
      return 'printing';
    case 'paused':
      return 'paused';
    case 'online':
      return 'ready';
    case 'error':
      return 'error';
    case 'locked':
      return 'locked';
    case 'offline':
      return 'offline';
    case 'available':
      return context.found ? 'ready' : 'connecting';
    default:
      return 'connecting';
  }
}

/** What a client read from a printer's Moonraker, by whichever way it reached it. */
export interface MoonrakerReading {
  /** Whether anything answered: an HTTP answer of any status, or an open socket. */
  connected: boolean;
  /** Klipper's state (webhooks.state: ready, startup, shutdown, error); null or absent while it was not read. */
  klippyState?: string | null;
  /** The print's state (print_stats.state: standby, printing, paused, complete, cancelled, error). */
  printState?: string | null;
  /** The status of the answer, when the read was an HTTP request that did not succeed. */
  httpStatus?: number | null;
}

/**
 * A printer's health from what its Moonraker answered, as Control reads it on the network and through the relay:
 * 401 or 403 is `locked` (it wants a sign-in, or its access rules refuse this browser); a 5xx is `error` (Moonraker
 * answers 503 while Klipper is not running); no answer is `offline`; any other failed answer is `error`. Then Klipper's
 * state: not read yet is `connecting`, anything but ready (shut down, in error, still starting) `error`. Then the
 * print's: printing, paused, an error (the last print stopped with one, or a Klipper state in its place) `error`, and
 * anything else `online`.
 */
export function healthOfMoonraker(input: MoonrakerReading): PrinterHealth {
  const status = typeof input.httpStatus === 'number' ? input.httpStatus : null;
  if (status === 401 || status === 403) return 'locked';
  if (status !== null && status >= 500 && status <= 599) return 'error';
  if (!input.connected && status === null) return 'offline';
  if (status !== null && (status < 200 || status > 299)) return 'error';
  const klippy = input.klippyState ?? null;
  if (klippy === null) return 'connecting';
  if (klippy !== 'ready') return 'error';
  const job = input.printState ?? null;
  if (job === 'printing') return 'printing';
  if (job === 'paused') return 'paused';
  if (job === 'error' || job?.startsWith('klipper')) return 'error';
  return 'online';
}

/**
 * An account printer's health: the account service's online flag first (not online is `offline`, whatever was read
 * before; so is a printer the service answers for as offline, such as an access grant's 503), then what was read
 * through the relay (healthOfMoonraker), `connecting` while nothing has been. Online at the service while nothing
 * answered this browser is `error`: the way in failed, not the printer, and its tile shows unreachable
 * (TileContext.wayInFailed).
 */
export function accountHealth(online: boolean, read: MoonrakerReading | null | undefined): PrinterHealth {
  if (!online) return 'offline';
  if (!read) return 'connecting';
  if (!read.connected && typeof read.httpStatus !== 'number') return 'error';
  return healthOfMoonraker(read);
}
