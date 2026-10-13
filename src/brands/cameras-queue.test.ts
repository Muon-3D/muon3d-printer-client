// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Muon 3D Technologies Limited
// The cameras each kind publishes, and Klipper's job queue, against fake printers on 127.0.0.1
// (src/test-support/fakePrinters.ts). Names and addresses used as data are .invalid names and RFC 5737 addresses,
// as the slicer's real-printer guard asks of a test that also talks to the fakes.
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { FAKE_OCTOPRINT_WEBCAM, FAKE_WEBCAM, fakeCreality, fakeElegoo, fakeMoonraker, fakeOctoPrint, until } from '../test-support/fakePrinters.ts';
import { createCrealityAdapter, crealityCameras } from './creality.ts';
import { createElegooAdapter, elegooCameras } from './elegoo.ts';
import { createMoonrakerAdapter, moonrakerCameras, moonrakerQueue } from './moonraker.ts';
import { createOctoPrintAdapter, octoprintCameras } from './octoprint.ts';
import type { BrandAdapter, BrandStatus } from './types.ts';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function watch(adapter: BrandAdapter): { last(): BrandStatus } {
  const seen: BrandStatus[] = [];
  const off = adapter.subscribe((s) => seen.push(s));
  cleanups.push(() => {
    off();
    adapter.close();
  });
  return { last: () => seen[seen.length - 1] };
}

describe("each kind's camera", () => {
  it("Klipper: Moonraker's webcam list, its addresses relative to the printer's web pages (not Moonraker's port)", () => {
    const webcams = [
      FAKE_WEBCAM,
      { name: 'Nozzle', service: 'mjpegstreamer-adaptive', stream_url: '/cam2/?action=stream', snapshot_url: '/cam2/?action=snapshot', rotation: 180 },
      { name: 'WebRTC', service: 'webrtc-camerastreamer', stream_url: 'http://voron.invalid/webcam3/webrtc', snapshot_url: '' },
      { name: 'Off', service: 'mjpegstreamer', enabled: false, stream_url: '/off/' },
      { name: 'Nowhere', service: 'mjpegstreamer', stream_url: 'javascript:alert(1)', snapshot_url: '' },
    ];
    assert.deepEqual(moonrakerCameras(webcams, 'voron.invalid:7125'), [
      { name: 'Bed', kind: 'mjpeg', url: 'http://voron.invalid/webcam/?action=stream', pageUrl: 'http://voron.invalid/webcam/?action=stream', flipH: false, flipV: true, rotation: 90 },
      { name: 'Nozzle', kind: 'snapshot', url: 'http://voron.invalid/cam2/?action=snapshot', pageUrl: 'http://voron.invalid/cam2/?action=stream', flipH: false, flipV: false, rotation: 180 },
      { name: 'WebRTC', kind: 'other', url: null, pageUrl: 'http://voron.invalid/webcam3/webrtc', flipH: false, flipV: false, rotation: 0 },
    ]);
    // A port that is not Moonraker's is the web pages' own.
    assert.equal(moonrakerCameras([FAKE_WEBCAM], 'voron.invalid:8081')[0].url, 'http://voron.invalid:8081/webcam/?action=stream');
  });

  it('Klipper: the adapter reads the list with its key', async () => {
    const printer = await fakeMoonraker({ apiKey: 'k' });
    cleanups.push(() => printer.close());
    const adapter = createMoonrakerAdapter({ host: printer.host, apiKey: 'k' });
    cleanups.push(() => adapter.close());
    const [camera] = await adapter.cameras!();
    assert.equal(camera.url, `http://${printer.host}/webcam/?action=stream`);
    assert.equal(printer.requests.find((r) => r.path === '/server/webcams/list')?.apiKey, 'k');
  });

  it("OctoPrint: the webcam in its settings; turned off, none; a stream that is not MJPEG is offered to open", async () => {
    assert.deepEqual(octoprintCameras({ webcam: FAKE_OCTOPRINT_WEBCAM }, 'octopi.invalid'), [
      { name: 'Camera', kind: 'mjpeg', url: 'http://octopi.invalid/webcam/?action=stream', pageUrl: 'http://octopi.invalid/webcam/?action=stream', flipH: false, flipV: false, rotation: 270 },
    ]);
    assert.deepEqual(octoprintCameras({ webcam: { ...FAKE_OCTOPRINT_WEBCAM, webcamEnabled: false } }, 'octopi.invalid'), []);
    assert.equal(octoprintCameras({ webcam: { streamUrl: '/hls/stream.m3u8', snapshotUrl: '' } }, 'octopi.invalid')[0].kind, 'other');
    assert.equal(octoprintCameras({ webcam: { streamUrl: '', snapshotUrl: '/snap.jpg' } }, 'octopi.invalid')[0].kind, 'snapshot');
    const printer = await fakeOctoPrint({ apiKey: 'OCTO' });
    cleanups.push(() => printer.close());
    const adapter = createOctoPrintAdapter({ host: printer.host, apiKey: 'OCTO' });
    cleanups.push(() => adapter.close());
    assert.equal((await adapter.cameras!())[0].url, `http://${printer.host}/webcam/?action=stream`);
  });

  it("Creality: a K1's MJPEG on port 8080 (its protocol names no camera); a K2 or a Hi, none", async () => {
    assert.deepEqual(crealityCameras({ model: 'K1C' }, '192.0.2.52:9999'), [{ name: 'Camera', kind: 'mjpeg', url: 'http://192.0.2.52:8080/?action=stream', pageUrl: 'http://192.0.2.52:8080/?action=stream', flipH: false, flipV: false, rotation: 0 }]);
    assert.deepEqual(crealityCameras({ model: 'K2 Plus' }, 'k2.invalid'), []);
    assert.deepEqual(crealityCameras({}, 'k1.invalid'), []);
    const printer = await fakeCreality();
    cleanups.push(() => printer.close());
    const adapter = createCrealityAdapter({ host: printer.host });
    const w = watch(adapter);
    await until(() => w.last().state === 'ready', 'telemetry');
    assert.equal((await adapter.cameras!())[0].url, 'http://127.0.0.1:8080/?action=stream');
  });

  it('Elegoo: 386 turns the stream on and answers its address, reached by the name the page uses for the printer', async () => {
    assert.equal(elegooCameras('192.0.2.60:3031/video', 'cc.invalid')[0].url, 'http://cc.invalid:3031/video');
    assert.equal(elegooCameras('http://192.0.2.60:3031/video', 'cc.invalid:3030')[0].url, 'http://cc.invalid:3031/video');
    assert.deepEqual(elegooCameras('', 'cc.invalid'), []);
    const printer = await fakeElegoo();
    cleanups.push(() => printer.close());
    const adapter = createElegooAdapter({ host: printer.host });
    const w = watch(adapter);
    await until(() => w.last().state === 'ready', 'connected');
    const [camera] = await adapter.cameras!();
    assert.equal(camera.url, `http://${printer.videoHost}/video`);
    assert.deepEqual(printer.commands.find((c) => c.Cmd === 386)?.Data, { Enable: 1 });
    printer.acks.set(386, 1);
    await assert.rejects(adapter.cameras!(), (err: { error?: { kind?: string; message?: string } }) => err.error?.kind === 'busy' && /as many viewers/.test(err.error.message ?? ''));
  });

  it('Elegoo with no camera (Ack 2): none', async () => {
    const printer = await fakeElegoo({ camera: false });
    cleanups.push(() => printer.close());
    const adapter = createElegooAdapter({ host: printer.host });
    const w = watch(adapter);
    await until(() => w.last().state === 'ready', 'connected');
    assert.deepEqual(await adapter.cameras!(), []);
  });
});

describe("Klipper's job queue", () => {
  it('arrives with the status, and changes as Moonraker says; add, pause, remove and start reach it', async () => {
    const printer = await fakeMoonraker();
    cleanups.push(() => printer.close());
    const adapter = createMoonrakerAdapter({ host: printer.host });
    const w = watch(adapter);
    await until(() => w.last().queue !== undefined, 'the queue read');
    assert.deepEqual(w.last().queue, { state: 'ready', jobs: [] });
    // Paused first, so that adding does not start anything by itself.
    await adapter.queue!.pause();
    await until(() => w.last().queue?.state === 'paused', 'paused');
    await adapter.queue!.add(['a.gcode', 'b.gcode']);
    await until(() => w.last().queue?.jobs.length === 2, 'two jobs');
    assert.deepEqual(w.last().queue!.jobs.map((j) => j.filename), ['a.gcode', 'b.gcode']);
    assert.ok(w.last().queue!.jobs.every((j) => typeof j.addedAt === 'number'));
    await adapter.queue!.remove([w.last().queue!.jobs[0].id]);
    await until(() => w.last().queue?.jobs.length === 1, 'one removed');
    await adapter.queue!.start();
    await until(() => w.last().state === 'printing' && w.last().file === 'b.gcode', 'the next job started');
    assert.deepEqual(w.last().queue, { state: 'ready', jobs: [] });
    assert.ok(printer.requests.some((r) => r.method === 'DELETE' && r.path.startsWith('/server/job_queue/job?job_ids=')));
  });

  it('a printer with no [job_queue]: the queue reads null, and adding to it fails', async () => {
    const printer = await fakeMoonraker({ queue: false });
    cleanups.push(() => printer.close());
    const adapter = createMoonrakerAdapter({ host: printer.host });
    const w = watch(adapter);
    await until(() => w.last().queue !== undefined, 'the queue read');
    assert.equal(w.last().queue, null);
    await assert.rejects(adapter.queue!.add(['a.gcode']), (err: { error?: { kind?: string; status?: number } }) => err.error?.kind === 'printer' && err.error.status === 404);
  });

  it("reads Moonraker's answer strictly", () => {
    assert.equal(moonrakerQueue({}), null);
    assert.deepEqual(moonrakerQueue({ queue_state: 'loading', queued_jobs: [{ filename: 'x.gcode', job_id: '01', time_added: 2 }, { filename: '', job_id: '02' }, 'junk'] }), { state: 'loading', jobs: [{ id: '01', filename: 'x.gcode', addedAt: 2000 }] });
    assert.equal(moonrakerQueue({ queue_state: 'odd', queued_jobs: [] })!.state, 'paused');
  });
});
