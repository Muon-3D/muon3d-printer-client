// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Muon 3D Technologies Limited
// The glance (glance.ts): the subscription's object set, the status kept from its updates, and the fields read from
// it, with an M1's missing plate and toolhead reports counting as off.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  applyUpdate,
  canStartFrom,
  EMPTY_VIEW,
  FILAMENT_SENSOR,
  filePath,
  GLANCE_OBJECTS,
  isBusy,
  MARK_OBJECT,
  MUON_M1,
  plateRemoved,
  readGlance,
  toolheadDisconnected,
  TOOLHEAD_MCU,
  type PrinterStatus,
  type StatusUpdate,
  type StatusView,
} from './glance.ts';

/** An idle M1. */
const IDLE: PrinterStatus = {
  webhooks: { state: 'ready', state_message: 'Printer is ready' },
  print_stats: { filename: '', state: 'standby', message: '', filament_used: 0, print_duration: 0 },
  virtual_sdcard: { progress: 0, is_active: false },
  display_status: { progress: 0, message: null },
  toolhead: { homed_axes: '' },
  heater_bed: { temperature: 23.8, target: 0 },
  extruder: { temperature: 24.3, target: 0 },
  bed_removal_detector: { bedRemoved: false },
  [TOOLHEAD_MCU]: { non_critical_disconnected: false },
  [FILAMENT_SENSOR]: { filament_detected: true },
  [MARK_OBJECT]: { seq: 0 },
};

const open = (status: PrinterStatus = IDLE): StatusView => ({ connection: 'open', status, complete: true });
const changed = (diff: PrinterStatus): StatusView => {
  const status: PrinterStatus = { ...IDLE };
  for (const [object, fields] of Object.entries(diff)) status[object] = { ...IDLE[object], ...fields };
  return open(status);
};
const without = (...objects: string[]): StatusView => open(Object.fromEntries(Object.entries(IDLE).filter(([o]) => !objects.includes(o))));

describe('GLANCE_OBJECTS', () => {
  it("is the state, the heaters, the M1's plate, toolhead and filament, and the start macro's status", () => {
    assert.deepEqual(Object.keys(GLANCE_OBJECTS).sort(), [
      'bed_removal_detector',
      'display_status',
      'extruder',
      'filament_switch_sensor filament_sensor_toolhead',
      'gcode_macro _PRINT_START_MARK',
      'heater_bed',
      'mcu toolhead',
      'print_stats',
      'toolhead',
      'virtual_sdcard',
      'webhooks',
    ]);
    assert.deepEqual(GLANCE_OBJECTS[MARK_OBJECT], ['seq', 'phase', 'phase_t']);
    assert.ok(Object.isFrozen(GLANCE_OBJECTS));
  });
});

describe('applyUpdate', () => {
  it('takes the full status, merges changes into it, and leaves console lines alone', () => {
    let view = applyUpdate(EMPTY_VIEW, { kind: 'connection', state: 'open' });
    assert.equal(view.complete, false);
    view = applyUpdate(view, { kind: 'status', status: IDLE, eventtime: 1, full: true });
    assert.equal(view.complete, true);
    assert.notEqual(view.status, IDLE, 'a copy');
    view = applyUpdate(view, { kind: 'status', status: { print_stats: { state: 'printing', filename: 'a.gcode' } }, eventtime: 2, full: false });
    assert.equal(view.status.print_stats.state, 'printing');
    assert.equal(view.status.print_stats.filament_used, 0, 'the other fields stay');
    assert.equal(applyUpdate(view, { kind: 'gcode', line: '// x', receivedAt: 0 }), view);
  });

  it('marks the status incomplete when the connection breaks, until a full status arrives again', () => {
    const view = applyUpdate(open(), { kind: 'connection', state: 'lost' });
    assert.deepEqual([view.connection, view.complete], ['lost', false]);
    assert.equal(view.status.print_stats.state, 'standby', 'what was known is kept, but not trusted');
    const back = applyUpdate(view, { kind: 'connection', state: 'open' });
    assert.deepEqual([back.connection, back.complete], ['open', false]);
  });

  it("writes Klipper's leaving into webhooks, and leaves the rest to the renewed subscription", () => {
    const gone = applyUpdate(open(), { kind: 'klippy', state: 'disconnected' });
    assert.equal(gone.status.webhooks.state, 'disconnected');
    const ready: StatusUpdate = { kind: 'klippy', state: 'ready' };
    assert.equal(applyUpdate(gone, ready), gone);
  });
});

describe('readGlance', () => {
  it('reads the fields the checks use', () => {
    const glance = readGlance(
      changed({ print_stats: { state: 'printing', filename: 'a.gcode', filament_used: 12.5 }, virtual_sdcard: { progress: 0.437 }, [MARK_OBJECT]: { seq: 3, phase: 'wipe', phase_t: 101.5 } }).status,
    );
    assert.deepEqual(glance, {
      klippy: 'ready',
      state: 'printing',
      filename: 'a.gcode',
      message: '',
      filamentUsed: 12.5,
      printDuration: 0,
      progress: 0.437,
      displayMessage: null,
      homedAxes: '',
      bed: { temperature: 23.8, target: 0 },
      hotend: { temperature: 24.3, target: 0 },
      bedRemoved: false,
      toolheadDisconnected: false,
      filamentDetected: true,
      mark: { seq: 3, phase: 'wipe', phaseT: 101.5 },
    });
  });

  it('reads what the printer did not report as null', () => {
    const glance = readGlance(without('bed_removal_detector', TOOLHEAD_MCU, FILAMENT_SENSOR, 'heater_bed').status);
    assert.deepEqual([glance.bedRemoved, glance.toolheadDisconnected, glance.filamentDetected, glance.bed], [null, null, null, null]);
    assert.deepEqual(glance.mark, { seq: 0, phase: null, phaseT: null });
    assert.equal(readGlance(without(MARK_OBJECT).status).mark, null);
    assert.equal(readGlance({}).klippy, null);
    assert.equal(readGlance(changed({ virtual_sdcard: { progress: null }, display_status: { progress: 0.2 } }).status).progress, 0.2);
  });

  it("counts an M1's missing plate and toolhead reports as off, and another model's as unknown", () => {
    const missing = readGlance(without('bed_removal_detector', TOOLHEAD_MCU).status);
    assert.ok(plateRemoved(missing, MUON_M1));
    assert.ok(toolheadDisconnected(missing, MUON_M1));
    assert.ok(!plateRemoved(missing, 'Prusa MK4S'));
    assert.ok(!toolheadDisconnected(missing, null));
    assert.ok(plateRemoved(readGlance(changed({ bed_removal_detector: { bedRemoved: true } }).status), 'Prusa MK4S'));
  });

  it('knows which print states are busy, which a print starts from, and a path in the gcodes root', () => {
    assert.deepEqual(['printing', 'paused', 'standby', 1].map(isBusy), [true, true, false, false]);
    assert.deepEqual(['standby', 'complete', 'cancelled', 'error', 'printing', null].map(canStartFrom), [true, true, true, true, false, false]);
    assert.equal(filePath('//a/b.gcode'), 'a/b.gcode');
  });
});
