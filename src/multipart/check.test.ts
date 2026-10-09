// SPDX-License-Identifier: Apache-2.0
// The gateway's upload rules against vectors/upload.json, and against bodies a browser's FormData makes: serialised
// once (what a fixed client sends) and twice (Fluidd's Iroh upload, which takes the bytes from one serialisation and
// the Content-Type from another).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { checkPrintUpload, checkUpload, type UploadRequest, type UploadVerdict } from './check.ts';

interface Vector {
  name: string;
  headers: [string, string][];
  body?: string;
  bodyBase64?: string;
  gateway: 'ok' | number;
  print: 'ok' | number;
}

const { cases } = JSON.parse(fs.readFileSync(new URL('./vectors/upload.json', import.meta.url), 'utf8')) as { cases: Vector[] };

function requestOf(vector: Vector): UploadRequest {
  const body = vector.bodyBase64 === undefined ? new TextEncoder().encode(vector.body) : new Uint8Array(Buffer.from(vector.bodyBase64, 'base64'));
  return { headers: vector.headers.map(([n, v]) => [n, v === '{length}' ? String(body.byteLength) : v]), body };
}

const outcome = (verdict: UploadVerdict) => (verdict.ok ? 'ok' : verdict.status);

async function formDataRequest(serialisations: 1 | 2): Promise<UploadRequest> {
  const form = new FormData();
  form.append('root', 'gcodes');
  form.append('checksum', 'a515612f48fac2c3870ef43324ac2096c67273fc4df8488cd3d27cb15dff2c95');
  form.append('file', new Blob(['G28\nG1 X10 Y10\n']), 'cube.gcode');
  const first = new Response(form);
  const body = new Uint8Array(await first.arrayBuffer());
  const typed = serialisations === 1 ? first : new Response(form);
  return { headers: [['Content-Type', typed.headers.get('content-type') ?? ''], ['Content-Length', String(body.byteLength)]], body };
}

describe('checkUpload (the gateway)', () => {
  for (const vector of cases) {
    it(`${vector.name}: ${vector.gateway}`, () => {
      const verdict = checkUpload(requestOf(vector));
      assert.equal(outcome(verdict), vector.gateway, verdict.ok ? '' : verdict.reason);
      if (!verdict.ok) assert.ok(verdict.reason.length > 0);
    });
  }

  it('accepts a FormData body serialised once', async () => {
    const verdict = checkUpload(await formDataRequest(1));
    assert.ok(verdict.ok, verdict.ok ? '' : verdict.reason);
    assert.equal(verdict.file.name, 'cube.gcode');
    assert.equal(new TextDecoder().decode(verdict.file.bytes), 'G28\nG1 X10 Y10\n');
  });

  it("refuses Fluidd's double FormData: the header's boundary is not the body's", async () => {
    const request = await formDataRequest(2);
    const verdict = checkUpload(request);
    assert.equal(outcome(verdict), 400);
    assert.match(verdict.ok ? '' : verdict.reason, /does not open with its boundary/);
  });

  it('reads the parts and the fields it accepted', () => {
    const vector = cases.find((c) => c.name.startsWith('a path field'));
    assert.ok(vector);
    const verdict = checkUpload(requestOf(vector));
    assert.ok(verdict.ok);
    assert.deepEqual(verdict.order, ['root', 'path', 'checksum', 'file']);
    assert.deepEqual(verdict.fields, { root: 'gcodes', path: 'plates', checksum: 'a515612f48fac2c3870ef43324ac2096c67273fc4df8488cd3d27cb15dff2c95' });
    assert.equal(verdict.boundary, 'muon3d-a515612f48fac2c3870ef43324ac2096');
  });

  it('takes headers as pairs, a record or a Headers object', () => {
    const { body } = requestOf(cases[0]);
    const type = cases[0].headers[0][1];
    for (const headers of [
      { 'Content-Type': type, 'Content-Length': String(body.byteLength) },
      new Headers({ 'content-type': type, 'content-length': String(body.byteLength) }),
    ]) {
      assert.equal(outcome(checkUpload({ headers, body })), 'ok');
    }
  });
});

describe('checkPrintUpload (the gateway, and the rules of this package)', () => {
  for (const vector of cases) {
    it(`${vector.name}: ${vector.print}`, () => {
      const verdict = checkPrintUpload(requestOf(vector));
      assert.equal(outcome(verdict), vector.print, verdict.ok ? '' : verdict.reason);
    });
  }

  it('takes a FormData body with root, checksum and file, serialised once', async () => {
    assert.equal(outcome(checkPrintUpload(await formDataRequest(1))), 'ok');
  });
});
