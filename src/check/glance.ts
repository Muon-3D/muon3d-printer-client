// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Muon 3D Technologies Limited
// A printer at a glance: the Klipper objects a client's one status subscription asks for, the status kept up to date
// from the subscription's updates, and the fields the send checks read. No words.

/** The M1's model name in the profile set and in G-code (`printer_model`). */
export const MUON_M1 = 'Muon3D M1';

/** Whether a printer is an M1, whose missing plate and toolhead reports count as off. */
export const isM1 = (model: string | null): boolean => model === MUON_M1;

/** Klipper's objects and, for each, the fields to read (null: all of them). */
export type StatusObjects = Readonly<Record<string, readonly string[] | null>>;
/** Klipper's objects' fields, as an answer or a notification carries them. */
export type PrinterStatus = Record<string, Record<string, unknown>>;

/** The status connection: opening, open, broken off after it was open (it reconnects), or never reachable. */
export type ConnectionState = 'connecting' | 'open' | 'lost' | 'offline';

/**
 * What a subscription delivers, for its printer only. `status`: the whole set after (re)subscribing (`full`), then
 * only what changed. `gcode`: a console line. `connection`: the status connection's state. `klippy`: Klipper went
 * away or is back.
 */
export type StatusUpdate =
  | { kind: 'status'; status: PrinterStatus; eventtime: number | null; full: boolean }
  | { kind: 'gcode'; line: string; receivedAt: number }
  | { kind: 'connection'; state: ConnectionState; error?: unknown }
  | { kind: 'klippy'; state: 'ready' | 'disconnected' | 'shutdown' };

export const MARK_OBJECT = 'gcode_macro _PRINT_START_MARK';
export const TOOLHEAD_MCU = 'mcu toolhead';
export const FILAMENT_SENSOR = 'filament_switch_sensor filament_sensor_toolhead';

/** The glance set: what a printer's subscription asks for. */
export const GLANCE_OBJECTS: StatusObjects = Object.freeze({
  webhooks: null,
  print_stats: null,
  virtual_sdcard: null,
  display_status: null,
  toolhead: ['homed_axes'],
  heater_bed: ['temperature', 'target'],
  extruder: ['temperature', 'target'],
  bed_removal_detector: ['bedRemoved'],
  [TOOLHEAD_MCU]: ['non_critical_disconnected'],
  [FILAMENT_SENSOR]: ['filament_detected'],
  [MARK_OBJECT]: ['seq', 'phase', 'phase_t'],
});

/** The printer's status as last known: the subscription's full answer, with each change merged in. */
export interface StatusView {
  connection: ConnectionState;
  status: PrinterStatus;
  /** Whether a full status has arrived since the connection (re)opened. */
  complete: boolean;
}

export const EMPTY_VIEW: StatusView = Object.freeze({ connection: 'connecting', status: {}, complete: false });

/** The view after a subscription's update (a console line changes nothing here). */
export function applyUpdate(view: StatusView, update: StatusUpdate): StatusView {
  switch (update.kind) {
    case 'status': {
      if (update.full) return { connection: view.connection, status: structuredClone(update.status), complete: true };
      const status: PrinterStatus = { ...view.status };
      for (const [object, fields] of Object.entries(update.status)) status[object] = { ...status[object], ...fields };
      return { ...view, status };
    }
    case 'connection':
      return update.state === 'open' ? { ...view, connection: 'open' } : { connection: update.state, status: view.status, complete: false };
    case 'klippy':
      // Klipper gone: what it said no longer holds; its webhooks state says so until the subscription is renewed.
      if (update.state === 'ready') return view;
      return { ...view, status: { ...view.status, webhooks: { ...view.status.webhooks, state: update.state } } };
    case 'gcode':
      return view;
  }
}

export interface Heater {
  temperature: number;
  target: number;
}

/** The start macro's status (`seq`; `phase` and `phase_t` on newer Klipper). */
export interface MarkStatus {
  seq: number | null;
  phase: string | null;
  phaseT: number | null;
}

/** What the checks read. A null field is one the printer did not report. */
export interface Glance {
  /** webhooks.state: ready, startup, shutdown, error, disconnected. */
  klippy: string | null;
  /** print_stats.state: standby, printing, paused, complete, cancelled, error. */
  state: string | null;
  filename: string;
  message: string;
  filamentUsed: number | null;
  printDuration: number | null;
  /** 0–1 of the file printed (virtual_sdcard, else display_status). */
  progress: number | null;
  displayMessage: string | null;
  homedAxes: string;
  bed: Heater | null;
  hotend: Heater | null;
  bedRemoved: boolean | null;
  toolheadDisconnected: boolean | null;
  filamentDetected: boolean | null;
  /** null when the printer has no start macro status (the object is absent). */
  mark: MarkStatus | null;
}

/** A finite number, or null. */
export const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const bool = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null);

function heater(value: Record<string, unknown> | undefined): Heater | null {
  const temperature = num(value?.temperature);
  return temperature === null ? null : { temperature, target: num(value?.target) ?? 0 };
}

/** The glance of a status. */
export function readGlance(status: PrinterStatus): Glance {
  const ps = status.print_stats;
  const mark = status[MARK_OBJECT];
  return {
    klippy: str(status.webhooks?.state),
    state: str(ps?.state),
    filename: str(ps?.filename) ?? '',
    message: str(ps?.message) ?? '',
    filamentUsed: num(ps?.filament_used),
    printDuration: num(ps?.print_duration),
    progress: num(status.virtual_sdcard?.progress) ?? num(status.display_status?.progress),
    displayMessage: str(status.display_status?.message),
    homedAxes: str(status.toolhead?.homed_axes) ?? '',
    bed: heater(status.heater_bed),
    hotend: heater(status.extruder),
    bedRemoved: bool(status.bed_removal_detector?.bedRemoved),
    toolheadDisconnected: bool(status[TOOLHEAD_MCU]?.non_critical_disconnected),
    filamentDetected: bool(status[FILAMENT_SENSOR]?.filament_detected),
    mark: mark ? { seq: num(mark.seq), phase: str(mark.phase), phaseT: num(mark.phase_t) } : null,
  };
}

/** Whether the plate is off: on an M1 a missing report counts as off, as the printer's own check does. */
export const plateRemoved = (glance: Glance, model: string | null): boolean => glance.bedRemoved === true || (isM1(model) && glance.bedRemoved === null);
/** Whether the toolhead is disconnected, with the same rule. */
export const toolheadDisconnected = (glance: Glance, model: string | null): boolean =>
  glance.toolheadDisconnected === true || (isM1(model) && glance.toolheadDisconnected === null);

/** print_stats states in which a queue entry is offered and a start is not. */
export const BUSY_STATES: readonly string[] = ['printing', 'paused'];
export const isBusy = (state: unknown): boolean => typeof state === 'string' && BUSY_STATES.includes(state);

/** print_stats states a print may start from. */
export const PRINT_STATES: readonly string[] = ['standby', 'complete', 'cancelled', 'error'];
export const canStartFrom = (state: unknown): boolean => typeof state === 'string' && PRINT_STATES.includes(state);

/** A file's path in the gcodes root as print_stats, the queue and an upload's answer name it ("a.gcode", "/a.gcode"). */
export const filePath = (path: string): string => path.replace(/^\/+/, '');
