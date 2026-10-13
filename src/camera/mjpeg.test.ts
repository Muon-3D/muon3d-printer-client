// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Muon 3D Technologies Limited
// The camera reader: JPEG pictures out of a stream however it is cut, and the watch against a fake printer's camera.
// (Node's fetch does not enforce CORS: a camera that does not let a page read it is the browser test's, e2e.)
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, it } from 'node:test';
import { FAKE_JPEG, fakeMoonraker, until } from '../test-support/fakePrinters.ts';
import { jpegFrames, MAX_FRAME_BYTES, watchCamera } from './mjpeg.ts';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const part = (jpeg: Uint8Array) => Buffer.concat([Buffer.from(`--b\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`, 'latin1'), jpeg, Buffer.from('\r\n', 'latin1')]);

/** FAKE_JPEG with an APP1 segment that holds a whole thumbnail (its own FF D8 ... FF D9) after SOI. */
function withThumbnail(): Uint8Array {
  const thumbnail = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, 0x00, thumbnail.length + 2]), thumbnail]);
  return Buffer.concat([FAKE_JPEG.subarray(0, 2), app1, FAKE_JPEG.subarray(2)]);
}

describe('JPEG pictures out of a stream', () => {
  it('finds each picture however the bytes are cut, and skips the framing around them', () => {
    const stream = Buffer.concat([Buffer.from('junk before\r\n'), part(FAKE_JPEG), part(FAKE_JPEG)]);
    for (const size of [1, 7, 64, 500, stream.length]) {
      const reader = jpegFrames();
      const found: Uint8Array[] = [];
      for (let i = 0; i < stream.length; i += size) found.push(...reader.push(stream.subarray(i, i + size)));
      assert.equal(found.length, 2, `cut every ${size} bytes`);
      for (const picture of found) assert.ok(Buffer.from(picture).equals(FAKE_JPEG));
    }
  });

  it("does not end a picture at a thumbnail's end marker inside a segment", () => {
    const picture = withThumbnail();
    const [found] = jpegFrames().push(part(picture));
    assert.equal(found.length, picture.length);
  });

  it('waits for the rest of a picture, and drops one longer than any picture', () => {
    const reader = jpegFrames();
    assert.deepEqual(reader.push(FAKE_JPEG.subarray(0, 300)), []);
    assert.equal(reader.push(FAKE_JPEG.subarray(300)).length, 1);
    const huge = jpegFrames();
    huge.push(Buffer.concat([FAKE_JPEG.subarray(0, 2), Buffer.from([0xff, 0xda, 0x00, 0x02]), Buffer.alloc(MAX_FRAME_BYTES + 10, 0x11)]));
    assert.equal(huge.push(FAKE_JPEG).length, 1, 'the stream carries on after the dropped picture');
  });
});

describe('watching a camera', () => {
  it("reads an MJPEG stream's pictures, at most one per frameMs, until stop()", async () => {
    const printer = await fakeMoonraker();
    cleanups.push(() => printer.close());
    const pictures: Blob[] = [];
    const troubles: string[] = [];
    const watch = watchCamera({ kind: 'mjpeg', url: `http://${printer.host}/webcam/?action=stream` }, { onFrame: (p) => pictures.push(p), onTrouble: (t) => troubles.push(t), frameMs: 150 });
    const started = Date.now();
    await until(() => pictures.length >= 3, 'three pictures', 5000);
    watch.stop();
    const took = Date.now() - started;
    assert.equal(pictures[0].type, 'image/jpeg');
    assert.ok(Buffer.from(await pictures[0].arrayBuffer()).equals(FAKE_JPEG));
    assert.ok(took >= 280, `three pictures took ${took} ms: at most one per 150 ms`);
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(troubles, []);
  });

  it('asks a snapshot again every snapshotMs; an answer that is one picture is read as snapshots too', async () => {
    const printer = await fakeMoonraker();
    cleanups.push(() => printer.close());
    for (const kind of ['snapshot', 'mjpeg'] as const) {
      const before = printer.requests.length;
      const pictures: Blob[] = [];
      const watch = watchCamera({ kind, url: `http://${printer.host}/webcam/?action=snapshot` }, { onFrame: (p) => pictures.push(p), onTrouble: () => {}, snapshotMs: 50 });
      await until(() => pictures.length >= 3, `three snapshots (${kind})`, 5000);
      watch.stop();
      assert.ok(printer.requests.length - before >= 3);
    }
  });

  it('says why when nothing answers, or what answers is not a picture', async () => {
    const troubles: string[] = [];
    watchCamera({ kind: 'mjpeg', url: 'http://127.0.0.1:1/' }, { onFrame: () => {}, onTrouble: (t) => troubles.push(t) });
    const server = http.createServer((_req, res) => res.writeHead(200, { 'Content-Type': 'text/html' }).end('<p>login</p>'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
    watchCamera({ kind: 'snapshot', url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/` }, { onFrame: () => {}, onTrouble: (t) => troubles.push(t) });
    await until(() => troubles.length === 2, 'two troubles', 5000);
    assert.deepEqual(troubles.sort(), ['not-a-picture', 'unreachable']);
  });
});
