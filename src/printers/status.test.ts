// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Muon 3D Technologies Limited
// The status words Muon3D Control shows (status.ts): its states, their tones and words, the group line, and a
// printer's health from what its Moonraker answered, on the network and through the relay.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
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
  type PrinterHealth,
} from './status.ts';

describe('tile states', () => {
  it("are Control's nine, in its order, each with its tone and its pill's word", () => {
    assert.deepEqual([...TILE_STATES], ['printing', 'paused', 'ready', 'error', 'locked', 'connecting', 'unreachable', 'offline', 'new']);
    const table = TILE_STATES.map((s) => [s, tileTone(s), tileWords(s)]);
    assert.deepEqual(table, [
      ['printing', 'run', 'Printing'],
      ['paused', 'warn', 'Paused'],
      ['ready', 'ok', 'Ready'],
      ['error', 'err', 'Error'],
      ['locked', 'warn', 'Wants access'],
      ['connecting', 'off', 'Connecting'],
      ['unreachable', 'off', 'Unreachable'],
      ['offline', 'off', 'Offline'],
      ['new', 'info', 'New'],
    ]);
  });

  it("shows a print's progress on the pill while printing", () => {
    assert.equal(tileLabel('printing', 42.9), '42%');
    assert.equal(tileLabel('printing', null), 'Printing');
    assert.equal(tileLabel('printing', Number.NaN), 'Printing');
    assert.equal(tileLabel('ready', 42), 'Ready');
  });

  it('paused and faulted printers need someone; a group says so first', () => {
    assert.deepEqual(TILE_STATES.filter(needsYou), ['paused', 'error']);
    assert.deepEqual(groupSummary([]), { text: 'Empty', tone: 'off' });
    assert.deepEqual(groupSummary(['ready', 'ready']), { text: 'All ready', tone: 'ok' });
    assert.deepEqual(groupSummary(['printing', 'ready', 'ready', 'offline']), { text: '1 printing · 2 ready · 1 other', tone: 'run' });
    assert.deepEqual(groupSummary(['ready', 'offline']), { text: '1 ready · 1 other', tone: 'off' });
    assert.deepEqual(groupSummary(['printing', 'paused', 'error']), { text: '2 needs you', tone: 'warn' });
  });

  it("names a job by its file's name, without folders or extension", () => {
    assert.equal(jobName('prints/bracket_v2.gcode'), 'bracket_v2');
    assert.equal(jobName('cube.BGCODE'), 'cube');
    assert.equal(jobName(''), null);
    assert.equal(jobName(null), null);
  });
});

describe('tileOfHealth', () => {
  it('maps each health as the Printers page does', () => {
    const healths: PrinterHealth[] = ['online', 'printing', 'paused', 'connecting', 'searching', 'offline', 'error', 'locked', 'available'];
    assert.deepEqual(
      healths.map((h) => tileOfHealth(h)),
      ['ready', 'printing', 'paused', 'connecting', 'connecting', 'offline', 'error', 'locked', 'connecting'],
    );
  });

  it('a found printer not yet read is ready; one to set up is new', () => {
    assert.equal(tileOfHealth('available', { found: true }), 'ready');
    assert.equal(tileOfHealth('online', { found: true, needsSetUp: true }), 'new');
    assert.equal(tileOfHealth('online', { needsSetUp: true }), 'ready', 'only a found printer is set up');
  });

  it('an error that is the way in failing shows unreachable, not a fault', () => {
    assert.equal(tileOfHealth('error', { wayInFailed: true }), 'unreachable');
    assert.equal(tileOfHealth('offline', { wayInFailed: true }), 'offline');
    assert.equal(tileOfHealth('error'), 'error');
  });

  it('every health has words', () => {
    assert.equal(healthWords('locked'), 'Needs access');
    assert.equal(healthWords('searching'), 'Looking for it…');
    assert.equal(healthWords('available'), 'On this network');
  });
});

describe('healthOfMoonraker', () => {
  it('401 or 403 is locked; a 5xx is Klipper not running; no answer is offline; another failure is an error', () => {
    assert.equal(healthOfMoonraker({ connected: true, httpStatus: 401 }), 'locked');
    assert.equal(healthOfMoonraker({ connected: false, httpStatus: 403 }), 'locked', 'a status is an answer');
    assert.equal(healthOfMoonraker({ connected: true, httpStatus: 503 }), 'error');
    assert.equal(healthOfMoonraker({ connected: false }), 'offline');
    assert.equal(healthOfMoonraker({ connected: true, httpStatus: 404 }), 'error');
  });

  it("then Klipper's state, then the print's", () => {
    assert.equal(healthOfMoonraker({ connected: true }), 'connecting', 'nothing read yet');
    for (const klippy of ['startup', 'shutdown', 'error', 'disconnected']) assert.equal(healthOfMoonraker({ connected: true, klippyState: klippy }), 'error', klippy);
    const ready = { connected: true, klippyState: 'ready' };
    assert.equal(healthOfMoonraker({ ...ready, printState: 'printing' }), 'printing');
    assert.equal(healthOfMoonraker({ ...ready, printState: 'paused' }), 'paused');
    assert.equal(healthOfMoonraker({ ...ready, printState: 'error' }), 'error');
    assert.equal(healthOfMoonraker({ ...ready, printState: 'klipper_shutdown' }), 'error');
    for (const state of ['standby', 'complete', 'cancelled', null, undefined]) assert.equal(healthOfMoonraker({ ...ready, printState: state }), 'online', String(state));
    assert.equal(healthOfMoonraker({ ...ready, httpStatus: 200, printState: 'printing' }), 'printing');
  });

  it("an account printer: the service's online flag first, then the relay's read; a failed way in is an error", () => {
    assert.equal(accountHealth(false, { connected: true, klippyState: 'ready', printState: 'printing' }), 'offline');
    assert.equal(accountHealth(true, null), 'connecting');
    assert.equal(accountHealth(true, { connected: false }), 'error');
    assert.equal(tileOfHealth(accountHealth(true, { connected: false }), { wayInFailed: true }), 'unreachable');
    assert.equal(accountHealth(true, { connected: true, klippyState: 'ready', printState: 'paused' }), 'paused');
    assert.equal(accountHealth(true, { connected: false, httpStatus: 401 }), 'locked');
  });
});
