// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { boundaryFor, buildUploadBody } from './build.ts';
import { checkPrintUpload, checkUpload } from './check.ts';

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const text = (s: string) => new TextEncoder().encode(s);
const vectors = JSON.parse(fs.readFileSync(new URL('./vectors/upload.json', import.meta.url), 'utf8')) as { cases: { name: string; body: string }[] };

describe('buildUploadBody', () => {
  it('writes root, checksum and the file, in that order, and nothing else', () => {
    const bytes = text('G28\nG1 X10 Y10\n');
    const built = buildUploadBody({ name: 'cube.gcode', bytes, checksum: sha256(bytes) });
    // Byte for byte the body the vectors call the builder's.
    assert.equal(new TextDecoder().decode(built.body), vectors.cases[0].body);
    assert.equal(built.boundary, `muon3d-${sha256(bytes).slice(0, 32)}`);
    assert.equal(built.contentType, `multipart/form-data; boundary=${built.boundary}`);
    assert.deepEqual(built.headers, [
      ['Content-Type', built.contentType],
      ['Content-Length', String(built.body.byteLength)],
    ]);
    const verdict = checkPrintUpload({ headers: built.headers, body: built.body });
    assert.ok(verdict.ok, verdict.ok ? '' : verdict.reason);
    assert.deepEqual(verdict.order, ['root', 'checksum', 'file']);
    assert.deepEqual(verdict.fields, { root: 'gcodes', checksum: sha256(bytes) });
    assert.equal(verdict.file.name, 'cube.gcode');
    assert.equal(verdict.file.contentType, 'application/octet-stream');
  });

  it('carries any bytes through unchanged, from a Uint8Array or an ArrayBuffer', () => {
    // Every byte value, CR LF runs and dashes included, as a binary file or a G-code file with CRLF line ends has.
    const bytes = new Uint8Array(70_000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7919) % 256;
    bytes.set(text('\r\n--\r\n--muon3d-\r\n'), 1000);
    for (const input of [bytes, bytes.buffer]) {
      const built = buildUploadBody({ name: 'binary.gcode', bytes: input, checksum: sha256(bytes) });
      const verdict = checkUpload({ headers: built.headers, body: built.body });
      assert.ok(verdict.ok, verdict.ok ? '' : verdict.reason);
      assert.deepEqual(verdict.file.bytes, bytes);
    }
  });

  it('builds the same body for the same file, every time', () => {
    const bytes = text('G1 X1\n');
    const a = buildUploadBody({ name: 'a.gcode', bytes, checksum: sha256(bytes) });
    const b = buildUploadBody({ name: 'a.gcode', bytes: bytes.slice(), checksum: sha256(bytes) });
    assert.deepEqual(a.body, b.body);
    assert.equal(a.contentType, b.contentType);
  });

  it('picks another boundary when the file contains the delimiter', () => {
    const checksum = 'ab'.repeat(32);
    const base = `muon3d-${checksum.slice(0, 32)}`;
    assert.equal(boundaryFor(text('G28\n'), checksum), base);
    assert.equal(boundaryFor(text(`G28\r\n--${base}\r\n`), checksum), `${base}-1`);
    assert.equal(boundaryFor(text(`\r\n--${base}\r\n--${base}-1`), checksum), `${base}-2`);
    // Without the CRLF before it, the boundary's text is only text.
    assert.equal(boundaryFor(text(`--${base}`), checksum), base);
    const bytes = text(`; a comment that quotes the delimiter\r\n--${base}--\r\n`);
    const built = buildUploadBody({ name: 'quote.gcode', bytes, checksum });
    assert.equal(built.boundary, `${base}-1`);
    const verdict = checkPrintUpload({ headers: built.headers, body: built.body });
    assert.ok(verdict.ok, verdict.ok ? '' : verdict.reason);
    assert.deepEqual(verdict.file.bytes, bytes);
  });

  it('builds an empty file', () => {
    const built = buildUploadBody({ name: 'empty.gcode', bytes: new Uint8Array(), checksum: sha256(new Uint8Array()) });
    const verdict = checkPrintUpload({ headers: built.headers, body: built.body });
    assert.ok(verdict.ok, verdict.ok ? '' : verdict.reason);
    assert.equal(verdict.file.bytes.byteLength, 0);
  });

  it('refuses a name that fails the safe-name rule and a checksum that is not a lowercase SHA-256', () => {
    const bytes = text('G28\n');
    for (const name of ['', '..', '../config/printer.cfg', 'a"b.gcode', 'a;b.gcode', 'a\r\nb.gcode']) {
      assert.throws(() => buildUploadBody({ name, bytes, checksum: sha256(bytes) }), RangeError, JSON.stringify(name));
    }
    for (const checksum of ['', sha256(bytes).toUpperCase(), sha256(bytes).slice(1), `${sha256(bytes)}0`, 'g'.repeat(64)]) {
      assert.throws(() => buildUploadBody({ name: 'a.gcode', bytes, checksum }), /lowercase hex/, checksum);
    }
  });
});
