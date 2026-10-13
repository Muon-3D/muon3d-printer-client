// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Muon 3D Technologies Limited
// The send gates (gates.ts): a table of printer states against what is offered, then each gate on its own, then SG-9's
// plate clear from the print history on each route, including a printer whose print_stats has forgotten the part
// that is still on the plate.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EMPTY_VIEW, FILAMENT_SENSOR, MARK_OBJECT, MUON_M1, TOOLHEAD_MCU, type PrinterStatus, type StatusView } from './glance.ts';
import {
  evaluateGates,
  MAX_RELAY_BYTES,
  NO_PLATE_CYCLE,
  notePlate,
  notePlateHistory,
  plateClearNeed,
  samePrinter,
  type GateInput,
  type GatePrinter,
  type GateVerdict,
  type HistoryLast,
  type SlicedPlate,
  type Transport,
} from './gates.ts';

const LOCAL: GatePrinter = { key: 'a'.repeat(64), model: MUON_M1, route: 'local', role: null };
const CLOUD: GatePrinter = { ...LOCAL, key: 'b'.repeat(64), route: 'cloud', role: 'operator' };

const IDLE: PrinterStatus = {
  webhooks: { state: 'ready' },
  print_stats: { filename: '', state: 'standby', message: '', filament_used: 0 },
  virtual_sdcard: { progress: 0 },
  display_status: { message: null },
  toolhead: { homed_axes: '' },
  bed_removal_detector: { bedRemoved: false },
  [TOOLHEAD_MCU]: { non_critical_disconnected: false },
  [FILAMENT_SENSOR]: { filament_detected: true },
  [MARK_OBJECT]: { seq: 0 },
};
const view = (diff: PrinterStatus = {}, drop: string[] = []): StatusView => {
  const status: PrinterStatus = {};
  for (const [object, fields] of Object.entries(IDLE)) if (!drop.includes(object)) status[object] = { ...fields, ...diff[object] };
  return { connection: 'open', status, complete: true };
};
const PLATE: SlicedPlate = { current: true, setup: 'match', bytes: 1000, keepOut: { ok: true, checksum: '0'.repeat(64) } };

const input = (over: Partial<GateInput> = {}): GateInput => ({
  ref: LOCAL,
  view: view(),
  plates: [PLATE],
  plateClear: 'not-needed',
  ticked: false,
  starting: false,
  ...over,
});
const reasons = (verdict: GateVerdict) => verdict.failures.map((f) => `${f.gate} ${f.reason}`);
const offers = (verdict: GateVerdict) => ({ mode: verdict.mode, print: verdict.print, queue: verdict.queue, uploadOnly: verdict.uploadOnly });

describe('evaluateGates: printer states against what is offered', () => {
  const rows: [string, PrinterStatus, ReturnType<typeof offers>][] = [
    ['standby', {}, { mode: 'print', print: true, queue: false, uploadOnly: true }],
    ['complete', { print_stats: { state: 'complete' } }, { mode: 'print', print: true, queue: false, uploadOnly: true }],
    ['cancelled', { print_stats: { state: 'cancelled' } }, { mode: 'print', print: true, queue: false, uploadOnly: true }],
    ['error', { print_stats: { state: 'error' } }, { mode: 'print', print: true, queue: false, uploadOnly: true }],
    ['printing', { print_stats: { state: 'printing' } }, { mode: 'queue', print: false, queue: true, uploadOnly: true }],
    ['paused', { print_stats: { state: 'paused' } }, { mode: 'queue', print: false, queue: true, uploadOnly: true }],
    ['an unknown state', { print_stats: { state: 'mystery' } }, { mode: 'print', print: false, queue: false, uploadOnly: true }],
    ['Klipper not ready', { webhooks: { state: 'startup' } }, { mode: 'print', print: false, queue: false, uploadOnly: true }],
    ['plate removed', { bed_removal_detector: { bedRemoved: true } }, { mode: 'print', print: false, queue: false, uploadOnly: true }],
    ['toolhead disconnected', { [TOOLHEAD_MCU]: { non_critical_disconnected: true } }, { mode: 'print', print: false, queue: false, uploadOnly: true }],
    ['printing, plate removed', { print_stats: { state: 'printing' }, bed_removal_detector: { bedRemoved: true } }, { mode: 'queue', print: false, queue: false, uploadOnly: true }],
  ];
  for (const [name, diff, expected] of rows) {
    it(`${name}: ${JSON.stringify(expected)}`, () => {
      assert.deepEqual(offers(evaluateGates(input({ view: view(diff) }))), expected);
    });
  }

  it('never offers a queue entry on a printer that is not printing or paused', () => {
    for (const state of ['standby', 'complete', 'cancelled', 'error', 'mystery']) {
      assert.equal(evaluateGates(input({ view: view({ print_stats: { state } }) })).queue, false, state);
    }
  });
});

describe('evaluateGates: each gate', () => {
  it('SG-1: a keep-out failure, an unknown table or a scan not yet run holds back every send, Upload only too', () => {
    const cases: [SlicedPlate['keepOut'], string][] = [
      [{ ok: false, reason: 'keep-out', message: 'm', detail: 'd' }, 'SG-1 keep-out'],
      [{ ok: false, reason: 'no-table' }, 'SG-1 keep-out-unknown'],
      [null, 'SG-1 keep-out-unchecked'],
    ];
    for (const [keepOut, reason] of cases) {
      const verdict = evaluateGates(input({ plates: [PLATE, { ...PLATE, keepOut }] }));
      assert.deepEqual(reasons(verdict), [reason]);
      assert.deepEqual(offers(verdict), { mode: 'print', print: false, queue: false, uploadOnly: false });
    }
  });

  it('SG-2 and SG-3: an out-of-date plate is Slice, another model or edited volumes are Slice for ‹printer›', () => {
    assert.deepEqual(reasons(evaluateGates(input({ plates: [{ ...PLATE, current: false }] }))), ['SG-2 not-current']);
    assert.deepEqual(reasons(evaluateGates(input({ plates: null }))), ['SG-2 not-current']);
    for (const setup of ['other-model', 'edited-keep-out', 'unknown-model'] as const) {
      const verdict = evaluateGates(input({ plates: [{ ...PLATE, setup }] }));
      assert.deepEqual(reasons(verdict), [`SG-3 ${setup}`]);
      assert.equal(verdict.uploadOnly, false);
    }
  });

  it("SG-4: a Viewer's printer is never a destination; an Operator's and an Owner's are; no role only on the printer's network", () => {
    const watch = evaluateGates(input({ ref: { ...CLOUD, role: 'viewer' } }));
    assert.equal(watch.destination, false);
    assert.deepEqual(offers(watch), { mode: 'print', print: false, queue: false, uploadOnly: false });
    assert.ok(reasons(watch).includes('SG-4 watch-only'));
    for (const role of ['operator', 'owner'] as const) assert.equal(evaluateGates(input({ ref: { ...CLOUD, role } })).print, true, role);
    assert.equal(evaluateGates(input({ ref: LOCAL })).destination, true, 'a trusted client on the network');
    // An unknown role through the relay or a host is not taken for a privilege.
    for (const route of ['cloud', 'host'] as const) {
      const unknown = evaluateGates(input({ ref: { ...CLOUD, route, role: null } }));
      assert.equal(unknown.destination, false, route);
      assert.deepEqual(reasons(unknown), ['SG-4 watch-only'], route);
      assert.equal(unknown.uploadOnly, false, route);
    }
  });

  it('SG-5: offline (or listed offline) holds everything; not connected yet too; Klipper not ready leaves Upload only', () => {
    assert.deepEqual(reasons(evaluateGates(input({ view: { ...view(), connection: 'offline' } }))), ['SG-5 offline']);
    assert.deepEqual(reasons(evaluateGates(input({ ref: CLOUD, online: false }))), ['SG-5 offline']);
    assert.deepEqual(reasons(evaluateGates(input({ view: EMPTY_VIEW }))), ['SG-5 connecting']);
    assert.deepEqual(reasons(evaluateGates(input({ view: { ...view(), connection: 'lost', complete: false } }))), ['SG-5 connecting']);
    assert.equal(evaluateGates(input({ view: EMPTY_VIEW })).uploadOnly, false);
    const notReady = evaluateGates(input({ view: view({ webhooks: { state: 'shutdown' } }) }));
    assert.deepEqual(reasons(notReady), ['SG-5 not-ready']);
    assert.equal(notReady.uploadOnly, true);
  });

  it('SG-6: no start, and no queue entry, while this tab watches its previous start on the printer', () => {
    assert.deepEqual(reasons(evaluateGates(input({ starting: true }))), ['SG-6 starting']);
    const busy = evaluateGates(input({ starting: true, view: view({ print_stats: { state: 'printing' } }) }));
    assert.deepEqual(offers(busy), { mode: 'queue', print: false, queue: false, uploadOnly: true });
  });

  it('SG-7 and SG-8: on an M1 a missing plate or toolhead report counts as off; both show', () => {
    const missing = evaluateGates(input({ view: view({}, ['bed_removal_detector', TOOLHEAD_MCU]) }));
    assert.deepEqual(reasons(missing), ['SG-7 plate-removed', 'SG-8 toolhead-disconnected']);
    assert.equal(missing.print, false);
    // A model that is not an M1 has no such objects to miss (and SG-3 decides whether it is a destination at all).
    assert.deepEqual(reasons(evaluateGates(input({ ref: { ...LOCAL, model: 'Prusa MK4S' }, view: view({}, ['bed_removal_detector', TOOLHEAD_MCU]) }))), []);
  });

  it('SG-9: Print waits for the tick; Queue and Upload only do not need it', () => {
    const ask = evaluateGates(input({ plateClear: 'ask' }));
    assert.deepEqual(reasons(ask), ['SG-9 plate-clear']);
    assert.deepEqual(offers(ask), { mode: 'print', print: false, queue: false, uploadOnly: true });
    assert.equal(ask.plateClear, 'ask');
    const ticked = evaluateGates(input({ plateClear: 'ask', ticked: true }));
    assert.equal(ticked.print, true);
    assert.equal(ticked.plateClear, 'ticked');
    const queue = evaluateGates(input({ plateClear: 'ask', view: view({ print_stats: { state: 'printing' } }) }));
    assert.equal(queue.queue, true);
    assert.equal(evaluateGates(input()).plateClear, 'not-needed');
  });

  it('SG-12: more than 128 MiB is too large through the relay, and fine on the network', () => {
    const big = [{ ...PLATE, bytes: MAX_RELAY_BYTES + 1 }];
    assert.deepEqual(reasons(evaluateGates(input({ ref: CLOUD, plates: big }))), ['SG-12 too-large']);
    assert.deepEqual(reasons(evaluateGates(input({ ref: CLOUD, plates: [{ ...PLATE, bytes: MAX_RELAY_BYTES }] }))), []);
    assert.deepEqual(reasons(evaluateGates(input({ plates: big }))), []);
  });

  it('SG-13: a step for another printer than the send is for holds everything', () => {
    assert.deepEqual(reasons(evaluateGates(input({ sendKey: CLOUD.key }))), ['SG-13 printer-changed']);
    assert.deepEqual(reasons(evaluateGates(input({ sendKey: LOCAL.key }))), []);
    assert.ok(samePrinter(LOCAL.key, LOCAL));
    assert.ok(!samePrinter(CLOUD.key, LOCAL));
  });

  it('warns of no filament without holding Print back', () => {
    const verdict = evaluateGates(input({ view: view({ [FILAMENT_SENSOR]: { filament_detected: false } }) }));
    assert.deepEqual(verdict.warnings, ['no-filament']);
    assert.equal(verdict.print, true);
    assert.deepEqual(evaluateGates(input({ view: view({}, [FILAMENT_SENSOR]) })).warnings, []);
  });

  it('lists every failing gate, in the order a sheet shows them', () => {
    const verdict = evaluateGates(
      input({
        ref: { ...CLOUD, role: 'viewer' },
        online: false,
        plates: [{ current: false, setup: 'other-model', bytes: MAX_RELAY_BYTES + 1, keepOut: null }],
        sendKey: LOCAL.key,
      }),
    );
    assert.deepEqual(reasons(verdict), ['SG-13 printer-changed', 'SG-4 watch-only', 'SG-2 not-current', 'SG-3 other-model', 'SG-1 keep-out-unchecked', 'SG-12 too-large', 'SG-5 offline']);
  });
});

describe('SG-9: plate clear from the print history', () => {
  const job = (status: string, filamentUsed: number | null, jobId = '000001'): HistoryLast => ({ available: true, job: { jobId, filename: 'a.gcode', status, filamentUsed, endTime: 1 } });
  const cycled = (history: HistoryLast) => notePlate(notePlate(notePlateHistory(NO_PLATE_CYCLE, history), true), false);

  it('asks after a job that ended with filament used, on every route', () => {
    for (const status of ['completed', 'cancelled', 'error', 'klippy_shutdown', 'interrupted']) {
      for (const transport of ['lan', 'iroh'] as Transport[]) assert.equal(plateClearNeed(job(status, 120), transport, NO_PLATE_CYCLE), 'ask', `${status} ${transport}`);
    }
  });

  it('does not ask after a job that used none, or with an empty history; asks with no history, an unread one, or one that says nothing', () => {
    assert.equal(plateClearNeed(job('cancelled', 0), 'iroh', NO_PLATE_CYCLE), 'not-needed');
    assert.equal(plateClearNeed({ available: true, job: null }, 'iroh', NO_PLATE_CYCLE), 'not-needed');
    assert.equal(plateClearNeed({ available: false, job: null }, 'lan', NO_PLATE_CYCLE), 'ask');
    assert.equal(plateClearNeed(null, 'lan', NO_PLATE_CYCLE), 'ask', 'not read yet, or the read failed');
    assert.equal(plateClearNeed(job('completed', null), 'lan', NO_PLATE_CYCLE), 'ask', 'a history that does not say how much');
  });

  it('asks while the newest job is still running in the history: it ends there after print_stats says complete', () => {
    for (const transport of ['lan', 'iroh'] as Transport[]) assert.equal(plateClearNeed(job('in_progress', 50), transport, NO_PLATE_CYCLE), 'ask', transport);
    // The print has completed, the history has not caught up: Print stays off until the tick.
    const need = plateClearNeed(job('in_progress', 50), 'lan', notePlateHistory(NO_PLATE_CYCLE, job('in_progress', 50)));
    const complete = view({ print_stats: { state: 'complete', filament_used: 50 } });
    const before = evaluateGates(input({ view: complete, plateClear: need }));
    assert.deepEqual(offers(before), { mode: 'print', print: false, queue: false, uploadOnly: true });
    assert.deepEqual(reasons(before), ['SG-9 plate-clear']);
    assert.equal(evaluateGates(input({ view: complete, plateClear: need, ticked: true })).print, true);
    // While it prints, the sheet offers Queue, which the tick does not hold back.
    assert.equal(evaluateGates(input({ view: view({ print_stats: { state: 'printing' } }), plateClear: need })).queue, true);
  });

  it('on the network, a plate cycle the page saw after it read the ended job lifts it; through the relay nothing does', () => {
    const history = job('completed', 120);
    const cycle = cycled(history);
    assert.deepEqual(cycle, { jobId: '000001', ended: true, removed: true, cycled: true });
    assert.equal(plateClearNeed(history, 'lan', cycle), 'not-needed');
    assert.equal(plateClearNeed(history, 'iroh', cycle), 'ask');
  });

  it('counts only a whole cycle (off, then on), seen after the job ended, for that same job', () => {
    const history = job('completed', 120);
    const read = notePlateHistory(NO_PLATE_CYCLE, history);
    assert.equal(plateClearNeed(history, 'lan', notePlate(read, true)), 'ask', 'off only');
    assert.equal(plateClearNeed(history, 'lan', notePlate(read, false)), 'ask', 'on only');
    assert.equal(notePlate(read, null), read, 'no report changes nothing');
    // A cycle while the job was still running does not count once it has ended.
    const running = notePlate(notePlate(notePlateHistory(NO_PLATE_CYCLE, job('in_progress', 10)), true), false);
    assert.equal(running.cycled, false);
    const endedNow = notePlateHistory(running, history);
    assert.equal(plateClearNeed(history, 'lan', endedNow), 'ask');
    // The same job read again keeps the cycle; another job starts over.
    const cycle = cycled(history);
    assert.equal(notePlateHistory(cycle, history), cycle);
    const next = job('completed', 80, '000002');
    assert.equal(plateClearNeed(next, 'lan', notePlateHistory(cycle, next)), 'ask');
    assert.equal(plateClearNeed(next, 'lan', cycle), 'ask', 'a cycle for another job');
  });

  it('a printer restarted after a print: print_stats back in standby with nothing used, and the tick still asked until the plate cycles', () => {
    // print_stats has forgotten the print; the history has not.
    const status = view({ print_stats: { state: 'standby', filament_used: 0 } });
    const history = job('completed', 1234);
    let cycle = notePlateHistory(NO_PLATE_CYCLE, history);
    const gate = (transport: Transport) => evaluateGates(input({ view: status, plateClear: plateClearNeed(history, transport, cycle) }));
    assert.equal(gate('lan').print, false);
    cycle = notePlate(cycle, true);
    assert.equal(gate('lan').print, false, 'off');
    cycle = notePlate(cycle, false);
    assert.equal(gate('lan').print, true);
    assert.equal(gate('iroh').print, false, 'remotely the cycle does not count');
  });
});
