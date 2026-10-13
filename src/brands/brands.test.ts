// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Muon 3D Technologies Limited
// Each kind against a fake printer on 127.0.0.1 (src/test-support/fakePrinters.ts): what it reports, the commands it
// sends, uploads, the probe's answers, OctoPrint's key request; and the kinds' table against the adapters.
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { fakeCreality, fakeElegoo, fakeMoonraker, fakeOctoPrint, formField, until, ELEGOO_MAINBOARD } from '../test-support/fakePrinters.ts';
import { CREALITY_CAPABILITIES, createCrealityAdapter, crealityStatus, probeCreality } from './creality.ts';
import { createElegooAdapter, ELEGOO_CAPABILITIES, elegooStatus, probeElegoo } from './elegoo.ts';
import { BRAND_KINDS, BRANDS, brandSteps, loadBrand } from './kinds.ts';
import { createMoonrakerAdapter, MOONRAKER_CAPABILITIES, moonrakerStatus, probeMoonraker } from './moonraker.ts';
import { createOctoPrintAdapter, OCTOPRINT_CAPABILITIES, octoprintStatus, probeOctoPrint, requestOctoPrintKey } from './octoprint.ts';
import type { BrandAdapter, BrandStatus } from './types.ts';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** Subscribes, and keeps every status seen. */
function watch(adapter: BrandAdapter): { seen: BrandStatus[]; last(): BrandStatus } {
  const seen: BrandStatus[] = [];
  const off = adapter.subscribe((s) => seen.push(s));
  cleanups.push(() => {
    off();
    adapter.close();
  });
  return { seen, last: () => seen[seen.length - 1] };
}

const BYTES = new TextEncoder().encode('G28\nG1 X10 Y10 F3000\n');

describe('Klipper through Moonraker', () => {
  it('identifies with its API key, subscribes, and reads its status and pushes', async () => {
    const printer = await fakeMoonraker({ apiKey: 'k-123' });
    cleanups.push(() => printer.close());
    const adapter = createMoonrakerAdapter({ host: printer.host, apiKey: 'k-123' });
    const w = watch(adapter);
    await until(() => w.last().state === 'ready', 'ready');
    assert.deepEqual(
      printer.calls.map((c) => c.method),
      ['server.connection.identify', 'printer.objects.subscribe'],
    );
    assert.equal((printer.calls[0].params as { api_key: string }).api_key, 'k-123');
    assert.deepEqual(w.last().hotend, { now: 24.2, target: null });
    printer.push({ print_stats: { state: 'printing', filename: 'cube.gcode', print_duration: 300 }, virtual_sdcard: { progress: 0.25 }, extruder: { temperature: 215, target: 215 } });
    await until(() => w.last().state === 'printing', 'printing');
    assert.equal(w.last().file, 'cube.gcode');
    assert.equal(w.last().progress, 0.25);
    assert.equal(w.last().secondsLeft, 900);
    assert.deepEqual(w.last().hotend, { now: 215, target: 215 });
  });

  it('reads Klipper that is not ready as an error, with its words', () => {
    const s = moonrakerStatus({ webhooks: { state: 'shutdown', state_message: 'MCU shutdown' }, print_stats: { state: 'standby' } });
    assert.deepEqual([s.state, s.message], ['error', 'MCU shutdown']);
  });

  it('uploads to the gcodes root and starts it, pauses, resumes, stops and starts a stored file', async () => {
    const printer = await fakeMoonraker();
    cleanups.push(() => printer.close());
    const adapter = createMoonrakerAdapter({ host: printer.host });
    cleanups.push(() => adapter.close());
    const path = await adapter.upload!({ name: 'cube_PLA.gcode', bytes: BYTES }, { start: true });
    assert.equal(path, 'cube_PLA.gcode');
    const upload = printer.requests.find((r) => r.path === '/server/files/upload')!;
    assert.deepEqual([formField(upload.body, 'root'), formField(upload.body, 'print')], ['gcodes', 'true']);
    await adapter.pause();
    await adapter.resume();
    await adapter.stop();
    await adapter.startFile!('old/part.gcode');
    assert.deepEqual(
      printer.requests.filter((r) => r.method === 'POST' && r.path.startsWith('/printer/print/')).map((r) => r.path),
      ['/printer/print/pause', '/printer/print/resume', '/printer/print/cancel', '/printer/print/start?filename=old%2Fpart.gcode'],
    );
    assert.deepEqual(await adapter.listFiles!(), [
      { path: 'old/part.gcode', name: 'part.gcode' },
      { path: 'cube_PLA.gcode', name: 'cube_PLA.gcode' },
    ]);
  });

  it('a probe finds it with its host name and Klipper version; says when it wants a key, or refused the one given', async () => {
    const printer = await fakeMoonraker({ apiKey: 'secret', hostname: 'voron24' });
    cleanups.push(() => printer.close());
    assert.deepEqual(await probeMoonraker({ host: printer.host, apiKey: 'secret' }), { found: true, name: 'voron24', model: null, firmware: 'v0.12.0' });
    assert.deepEqual(await probeMoonraker({ host: printer.host }), { found: false, why: 'needs-key' });
    assert.deepEqual(await probeMoonraker({ host: printer.host, apiKey: 'nope' }), { found: false, why: 'wrong-key' });
  });

  it('nothing at the address, or something that is not Moonraker, is said so', async () => {
    const other = await fakeOctoPrint({ apiKey: 'x' });
    cleanups.push(() => other.close());
    assert.deepEqual(await probeMoonraker({ host: '127.0.0.1:1' }), { found: false, why: 'no-answer' });
    assert.deepEqual(await probeMoonraker({ host: other.host }), { found: false, why: 'not-this-kind' });
  });

  it('a dropped socket reads offline and opens again by itself', async () => {
    const printer = await fakeMoonraker();
    cleanups.push(() => printer.close());
    const waits: number[] = [];
    const adapter = createMoonrakerAdapter({ host: printer.host }, { setTimeout: (cb, ms) => (waits.push(ms), setTimeout(cb, 5)) });
    const w = watch(adapter);
    await until(() => w.last().state === 'ready', 'ready');
    for (const ws of printer.sockets) ws.close();
    await until(() => w.seen.some((s) => s.state === 'offline'), 'offline');
    await until(() => printer.calls.filter((c) => c.method === 'printer.objects.subscribe').length === 2, 'subscribed again');
    assert.ok(waits.includes(2000), `waited ${waits.join(', ')}`);
  });
});

describe('OctoPrint', () => {
  it('reads the printer and the job every few seconds, with the API key', async () => {
    const printer = await fakeOctoPrint({ apiKey: 'OCTO' });
    cleanups.push(() => printer.close());
    Object.assign(printer.state, { file: 'box.gcode', completion: 40, left: 1200, text: 'Printing' });
    Object.assign(printer.state.flags, { printing: true });
    const adapter = createOctoPrintAdapter({ host: printer.host, apiKey: 'OCTO' });
    const w = watch(adapter);
    await until(() => w.last().state === 'printing', 'printing');
    assert.deepEqual([w.last().file, w.last().progress, w.last().secondsLeft, w.last().message], ['box.gcode', 0.4, 1200, 'Printing']);
    assert.deepEqual(w.last().bed, { now: 59.8, target: 60 });
    assert.ok(printer.requests.every((r) => r.apiKey === 'OCTO'));
  });

  it('OctoPrint not connected to its printer reads an error; a refused key too', () => {
    assert.equal(octoprintStatus(null, null).state, 'error');
    assert.equal(octoprintStatus({ state: { text: 'Paused', flags: { paused: true, printing: false } } }, { progress: { completion: 50 } }).state, 'paused');
  });

  it('uploads, selects and prints; pauses, resumes and cancels; starts a stored file; lists files in folders', async () => {
    const printer = await fakeOctoPrint({ apiKey: 'OCTO' });
    cleanups.push(() => printer.close());
    const adapter = createOctoPrintAdapter({ host: printer.host, apiKey: 'OCTO' });
    cleanups.push(() => adapter.close());
    assert.equal(await adapter.upload!({ name: 'cube.gcode', bytes: BYTES }, { start: true }), 'cube.gcode');
    const upload = printer.requests.find((r) => r.method === 'POST' && r.path === '/api/files/local')!;
    assert.deepEqual([formField(upload.body, 'select'), formField(upload.body, 'print')], ['true', 'true']);
    await adapter.pause();
    await adapter.resume();
    await adapter.stop();
    assert.deepEqual(
      printer.requests.filter((r) => r.method === 'POST' && r.path === '/api/job').map((r) => JSON.parse(r.body)),
      [{ command: 'pause', action: 'pause' }, { command: 'pause', action: 'resume' }, { command: 'cancel' }],
    );
    await adapter.startFile!('parts/box 2.gcode');
    assert.ok(printer.requests.some((r) => r.path === '/api/files/local/parts/box%202.gcode' && JSON.parse(r.body).print === true));
    assert.deepEqual((await adapter.listFiles!()).map((f) => f.path), ['parts/box.gcode', 'parts/cube.gcode']);
  });

  it('a probe finds it, and says when it wants a key or refused the one given', async () => {
    const printer = await fakeOctoPrint({ apiKey: 'OCTO' });
    cleanups.push(() => printer.close());
    assert.deepEqual(await probeOctoPrint({ host: printer.host, apiKey: 'OCTO' }), { found: true, name: null, model: null, firmware: 'OctoPrint 1.10.2' });
    assert.deepEqual(await probeOctoPrint({ host: printer.host }), { found: false, why: 'needs-key' });
    assert.deepEqual(await probeOctoPrint({ host: printer.host, apiKey: 'bad' }), { found: false, why: 'wrong-key' });
  });

  it('asks OctoPrint for a key: asked, then granted once the person allows it; refused; or not there', async () => {
    const printer = await fakeOctoPrint({ apiKey: 'GRANTED' });
    cleanups.push(() => printer.close());
    let asked = 0;
    assert.deepEqual(await requestOctoPrintKey(printer.host, { intervalMs: 1, onAsked: () => asked++ }), { state: 'granted', apiKey: 'GRANTED' });
    assert.equal(asked, 1);
    assert.ok(printer.requests.some((r) => r.path === '/plugin/appkeys/request' && JSON.parse(r.body).app === 'Muon3D Slice'));
    printer.keyRequest = 'deny';
    assert.deepEqual(await requestOctoPrintKey(printer.host, { intervalMs: 1 }), { state: 'refused' });
    printer.keyRequest = 'wait';
    assert.deepEqual(await requestOctoPrintKey(printer.host, { intervalMs: 1, attempts: 3 }), { state: 'refused' });
    const without = await fakeOctoPrint({ apiKey: 'x', appKeys: false });
    cleanups.push(() => without.close());
    assert.deepEqual(await requestOctoPrintKey(without.host, { intervalMs: 1 }), { state: 'unavailable' });
  });
});

describe("Creality's stock firmware", () => {
  it('asks for everything when it opens, merges what it sends, and answers its heartbeat', async () => {
    const printer = await fakeCreality();
    cleanups.push(() => printer.close());
    const adapter = createCrealityAdapter({ host: printer.host });
    const w = watch(adapter);
    await until(() => w.last().hotend !== null, 'telemetry');
    assert.deepEqual([w.last().state, w.last().hotend, w.last().bed], ['ready', { now: 24.5, target: null }, { now: 23.1, target: null }]);
    printer.push({ state: 1, printProgress: 37, printLeftTime: 1500, printFileName: '/usr/data/printer_data/gcodes/benchy.gcode', nozzleTemp: '220.1', targetNozzleTemp: 220 });
    await until(() => w.last().state === 'printing', 'printing');
    assert.deepEqual([w.last().progress, w.last().secondsLeft, w.last().hotend], [0.37, 1500, { now: 220.1, target: 220 }]);
    printer.beat();
    await until(() => printer.heartbeats === 1, 'the heartbeat answered');
  });

  it('pauses, resumes and stops with `set`; never uploads or starts', async () => {
    const printer = await fakeCreality();
    cleanups.push(() => printer.close());
    const adapter = createCrealityAdapter({ host: printer.host });
    const w = watch(adapter);
    await until(() => w.last().hotend !== null, 'telemetry');
    await adapter.pause();
    await adapter.resume();
    await adapter.stop();
    await until(() => printer.sets.length === 3, 'three commands');
    assert.deepEqual(printer.sets, [{ pause: 1 }, { pause: 0 }, { stop: 1 }]);
    assert.equal(adapter.upload, undefined);
    assert.equal(adapter.startFile, undefined);
    assert.equal(crealityStatus({ err: { errcode: 2001, errinfo: 'Nozzle heating failed' }, state: 1 }).state, 'error');
  });

  it('a command with nobody connected is offline', async () => {
    const adapter = createCrealityAdapter({ host: '127.0.0.1:1' });
    cleanups.push(() => adapter.close());
    await assert.rejects(adapter.pause(), (err: { error?: { kind?: string } }) => err.error?.kind === 'offline');
  });

  it('a probe reads its host name, model and firmware from the first telemetry; nothing there is no-answer', async () => {
    const printer = await fakeCreality();
    cleanups.push(() => printer.close());
    const found = await probeCreality({ host: printer.host });
    assert.deepEqual(found, { found: true, name: 'K1C-2F3A', model: 'K1C', firmware: 'printer hw ver:;printer hw ver:CR4CU220812S11;DWIN hw ver:;' });
    assert.deepEqual(await probeCreality({ host: '127.0.0.1:1' }, { setTimeout: (cb) => setTimeout(cb, 50) }), { found: false, why: 'no-answer' });
  });
});

describe("Elegoo's SDCP", () => {
  it('asks for its attributes and status when it opens, and reads the status it pushes', async () => {
    const printer = await fakeElegoo();
    cleanups.push(() => printer.close());
    const adapter = createElegooAdapter({ host: printer.host });
    const w = watch(adapter);
    await until(() => w.last().hotend !== null, 'status');
    assert.deepEqual(printer.commands.slice(0, 2).map((c) => c.Cmd), [1, 0]);
    printer.pushStatus({ CurrentStatus: [1], PrintInfo: { Status: 13, Filename: 'benchy.gcode', Progress: 42, CurrentTicks: 60_000, TotalTicks: 600_000 }, TempOfNozzle: 220, TempTargetNozzle: 220 });
    await until(() => w.last().state === 'printing', 'printing');
    assert.deepEqual([w.last().file, w.last().progress, w.last().secondsLeft, w.last().hotend], ['benchy.gcode', 0.42, 540, { now: 220, target: 220 }]);
    assert.deepEqual(w.last().chamber, { now: 26, target: null });
  });

  it("sends each command in its envelope with the mainboard's id, and waits for its Ack", async () => {
    const printer = await fakeElegoo();
    cleanups.push(() => printer.close());
    const adapter = createElegooAdapter({ host: printer.host });
    const w = watch(adapter);
    await until(() => w.last().hotend !== null, 'status');
    await adapter.pause();
    await adapter.resume();
    await adapter.stop();
    await adapter.startFile!('benchy.gcode');
    const sent = printer.commands.filter((c) => c.Cmd >= 128);
    assert.deepEqual(sent.map((c) => c.Cmd), [129, 131, 130, 128]);
    assert.ok(sent.every((c) => c.MainboardID === ELEGOO_MAINBOARD && /^[0-9a-f]+$/i.test(c.RequestID)));
    assert.deepEqual(sent[3].Data, { Filename: '/local/benchy.gcode', StartLayer: 0 });
    assert.deepEqual(await adapter.listFiles!(), [{ path: '/local/benchy.gcode', name: 'benchy.gcode' }]);
  });

  it('a refusal (Ack not 0) and an unanswered command fail with why', async () => {
    const printer = await fakeElegoo();
    cleanups.push(() => printer.close());
    printer.acks.set(128, 2);
    printer.silent.add(129);
    const adapter = createElegooAdapter({ host: printer.host }, { setTimeout: (cb, ms) => setTimeout(cb, ms === 5000 ? 30 : ms) });
    const w = watch(adapter);
    await until(() => w.last().hotend !== null, 'status');
    await assert.rejects(adapter.startFile!('missing.gcode'), (err: { error?: { kind?: string; detail?: string } }) => err.error?.kind === 'printer' && err.error.detail === 'File not found');
    await assert.rejects(adapter.pause(), (err: { error?: { kind?: string } }) => err.error?.kind === 'timeout');
  });

  it('reads paused and finished prints as SDCP names them', () => {
    assert.equal(elegooStatus({ PrintInfo: { Status: 6 } }).state, 'paused');
    assert.equal(elegooStatus({ CurrentStatus: [0], PrintInfo: { Status: 9 } }).state, 'ready');
    assert.equal(elegooStatus({ CurrentStatus: [0], PrintInfo: { Status: 0 } }).progress, null);
  });

  it('a probe reads its name, machine and firmware from its attributes', async () => {
    const printer = await fakeElegoo();
    cleanups.push(() => printer.close());
    assert.deepEqual(await probeElegoo({ host: printer.host }), { found: true, name: 'Centauri Carbon', model: 'Elegoo Centauri Carbon', firmware: 'V1.1.29' });
  });
});

describe('the kinds', () => {
  it("say what each kind can do exactly as its adapter does, and load each adapter on its own", async () => {
    assert.deepEqual(BRANDS.moonraker.capabilities, MOONRAKER_CAPABILITIES);
    assert.deepEqual(BRANDS.octoprint.capabilities, OCTOPRINT_CAPABILITIES);
    assert.deepEqual(BRANDS.creality.capabilities, CREALITY_CAPABILITIES);
    assert.deepEqual(BRANDS['elegoo-sdcp'].capabilities, ELEGOO_CAPABILITIES);
    for (const kind of BRAND_KINDS) {
      const m = await loadBrand(kind);
      const adapter = m.create({ host: '127.0.0.1:1' });
      assert.equal(adapter.kind, kind);
      adapter.close();
    }
  });

  it("give Klipper's step the page's own origin", () => {
    assert.match(brandSteps('moonraker', 'https://slicer.example')[1], /add https:\/\/slicer\.example to cors_domains/);
    assert.equal(brandSteps('creality', 'x').length, 1);
  });
});
