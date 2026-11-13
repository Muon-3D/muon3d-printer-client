// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Muon 3D Technologies Limited
// A printer through the relay (printer.ts) against a fake binding session: the request the binding gets (method,
// headers without the ones it frames, a body encoded once with the boundary its type names), the Response a caller
// gets back, an abort that frees the caller, and a WebSocket-shaped socket over the binding's.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { BindingResponse, BindingSession, BindingSocket } from './binding.ts';
import { createRelayPrinter, encodeRequest, isStrippedHeader, type PrinterSocketEvent } from './printer.ts';

interface Sent {
  method: string;
  path: string;
  headers: string[];
  body: Uint8Array;
}

/** A binding session that records what it was sent and answers with `answer`. */
function session(answer: (sent: Sent) => Promise<BindingResponse> | BindingResponse = () => ({ status: 200, headers: [], body: new Uint8Array() }), socket?: BindingSocket) {
  const sent: Sent[] = [];
  let closed = 0;
  const s: BindingSession = {
    printerId: () => 'a'.repeat(64),
    fetch: async (method, path, headers, body) => {
      const one = { method, path, headers, body };
      sent.push(one);
      return answer(one);
    },
    openWebSocket: async () => {
      if (!socket) throw Object.assign(new Error('refused'), { kind: 'refused', code: 0x0403 });
      return socket;
    },
    close: () => void closed++,
  };
  return { s, sent, closed: () => closed };
}

const pairs = (headers: string[]) => Object.fromEntries(headers.flatMap((h, i) => (i % 2 ? [] : [[h, headers[i + 1]]])));
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe('fetch through the relay', () => {
  it('sends the method, the path and the caller\'s headers, without the ones the binding frames or the gateway sets', async () => {
    const { s, sent } = session();
    await createRelayPrinter(s).fetch('/server/info', {
      method: 'post',
      headers: { Accept: 'application/json', Host: 'x', Authorization: 'Bearer t', 'Content-Length': '9', Connection: 'keep-alive', 'Sec-WebSocket-Key': 'k', Expect: '100-continue', 'X-Muon': '1' },
    });
    assert.equal(sent[0].method, 'POST');
    assert.equal(sent[0].path, '/server/info');
    assert.deepEqual(pairs(sent[0].headers), { accept: 'application/json', 'x-muon': '1' });
    for (const name of ['host', 'Authorization', 'content-length', 'TE', 'trailer', 'upgrade', 'proxy-connection', 'sec-websocket-version']) assert.equal(isStrippedHeader(name), true, name);
    assert.equal(isStrippedHeader('content-type'), false);
  });

  it('encodes a FormData once: the bytes sent are the ones the boundary in their type names', async () => {
    const form = new FormData();
    form.append('root', 'gcodes');
    form.append('file', new Blob(['G28\n']), 'cube.gcode');
    const encoded = await encodeRequest({ method: 'POST', body: form, headers: { 'Content-Type': 'text/plain' } });
    const type = pairs(encoded.headers)['content-type'];
    const boundary = /boundary=(.+)$/.exec(type)?.[1];
    assert.ok(boundary, type);
    assert.equal(encoded.headers.filter((h, i) => i % 2 === 0 && h === 'content-type').length, 1, "the caller's type gives way");
    const body = text(encoded.body);
    assert.ok(body.startsWith(`--${boundary}\r\n`));
    assert.ok(body.includes('name="root"\r\n\r\ngcodes\r\n'));
    assert.ok(body.trimEnd().endsWith(`--${boundary}--`));
  });

  it('sends a string as JSON unless it has a type, another body with the type its encoding gives, and bytes as they are', async () => {
    assert.deepEqual(pairs((await encodeRequest({ method: 'POST', body: '{}' })).headers), { 'content-type': 'application/json' });
    assert.deepEqual(pairs((await encodeRequest({ method: 'POST', body: 'a=1', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })).headers), {
      'content-type': 'application/x-www-form-urlencoded',
    });
    const bytes = await encodeRequest({ method: 'POST', body: new Uint8Array([1, 2, 3]) });
    assert.deepEqual([...bytes.body], [1, 2, 3]);
    assert.deepEqual(bytes.headers, []);
    assert.deepEqual(pairs((await encodeRequest({ method: 'POST', body: new URLSearchParams({ a: '1' }) })).headers), { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' });
    assert.deepEqual(pairs((await encodeRequest({ method: 'POST', body: new Blob(['x'], { type: 'text/plain' }) })).headers), { 'content-type': 'text/plain' });
    assert.deepEqual((await encodeRequest()).body.length, 0);
  });

  it("answers the printer's status, headers and body as a Response; a status with no body has none", async () => {
    const { s } = session(() => ({ status: 201, headers: ['Content-Type', 'application/json', 'X-Bad\n', 'x', 'X-Ok', 'y'], body: new TextEncoder().encode('{"item":1}') }));
    const response = await createRelayPrinter(s).fetch('/server/files/upload', { method: 'POST' });
    assert.equal(response.status, 201);
    assert.equal(response.headers.get('content-type'), 'application/json');
    assert.equal(response.headers.get('x-ok'), 'y');
    assert.deepEqual(await response.json(), { item: 1 });
    for (const status of [204, 205, 304]) {
      const empty = await createRelayPrinter(session(() => ({ status, headers: [], body: new Uint8Array([1]) })).s).fetch('/x');
      assert.equal(empty.status, status);
      assert.equal(empty.body, null);
    }
    // A policy refusal is an ordinary answer.
    assert.equal((await createRelayPrinter(session(() => ({ status: 403, headers: [], body: new Uint8Array() })).s).fetch('/x')).status, 403);
  });

  it('an abort before sending sends nothing; an abort while waiting frees the caller at once', async () => {
    const { s, sent } = session(() => new Promise(() => undefined));
    const printer = createRelayPrinter(s);
    const before = new AbortController();
    before.abort();
    await assert.rejects(printer.fetch('/x', { signal: before.signal }), (err: Error) => err.name === 'AbortError');
    assert.equal(sent.length, 0);
    const during = new AbortController();
    const waiting = printer.fetch('/x', { signal: during.signal });
    await new Promise((resolve) => setTimeout(resolve, 1));
    during.abort(new DOMException('stop', 'AbortError'));
    await assert.rejects(waiting, (err: Error) => err.name === 'AbortError');
    assert.equal(sent.length, 1);
  });

  it("rejects as the binding rejects, and closes the binding's session", async () => {
    const refused = Object.assign(new Error('refused'), { kind: 'refused', code: 0x040a });
    const { s, closed } = session(() => Promise.reject(refused));
    const printer = createRelayPrinter(s);
    await assert.rejects(printer.fetch('/x'), (err) => err === refused);
    printer.close();
    assert.equal(closed(), 1);
  });
});

describe('a WebSocket through the relay', () => {
  /** A binding socket whose messages are pushed by the test. */
  function bindingSocket() {
    const queue: { resolve: (value: string | Uint8Array | null) => void; reject: (error: Error) => void }[] = [];
    const ready: (string | Uint8Array | null | Error)[] = [];
    const sent: string[] = [];
    let closed = false;
    const inner: BindingSocket = {
      send: async (t) => {
        if (t === 'fail') throw new Error('send failed');
        sent.push(t);
      },
      next: () =>
        new Promise((resolve, reject) => {
          const item = ready.shift();
          if (item instanceof Error) reject(item);
          else if (item !== undefined) resolve(item);
          else queue.push({ resolve, reject });
        }),
      close: async () => {
        closed = true;
        queue.shift()?.resolve(null);
      },
    };
    const push = (item: string | Uint8Array | null | Error) => {
      const waiting = queue.shift();
      if (!waiting) ready.push(item);
      else if (item instanceof Error) waiting.reject(item);
      else waiting.resolve(item);
    };
    return { inner, push, sent, closed: () => closed };
  }
  const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

  it('delivers messages (bytes decoded), sends, and closes cleanly', async () => {
    const b = bindingSocket();
    const socket = await createRelayPrinter(session(undefined, b.inner).s).openWebSocket('/websocket');
    const events: [string, PrinterSocketEvent][] = [];
    for (const type of ['message', 'close', 'error'] as const) socket.addEventListener(type, (e) => events.push([type, e]));
    b.push('{"jsonrpc":"2.0"}');
    b.push(new TextEncoder().encode('bytes'));
    await tick();
    socket.send('hello');
    await tick();
    assert.deepEqual(b.sent, ['hello']);
    socket.close();
    await tick();
    assert.equal(b.closed(), true);
    assert.equal(socket.readyState, 3);
    assert.deepEqual(events, [
      ['message', { data: '{"jsonrpc":"2.0"}' }],
      ['message', { data: 'bytes' }],
      ['close', { code: 1000, reason: '', wasClean: true }],
    ]);
    socket.send('after');
    assert.deepEqual(b.sent, ['hello'], 'nothing is sent once closed');
  });

  it('a socket that fails is an error, then a close that is not clean; one that ends is a clean close', async () => {
    const b = bindingSocket();
    const socket = await createRelayPrinter(session(undefined, b.inner).s).openWebSocket('/websocket');
    const events: string[] = [];
    socket.addEventListener('error', () => events.push('error'));
    socket.addEventListener('close', (e) => events.push(`close ${e.code} ${e.reason}`));
    b.push(new Error('websocket'));
    await tick();
    assert.deepEqual(events, ['error', 'close 1006 websocket']);

    const ended = bindingSocket();
    const other = await createRelayPrinter(session(undefined, ended.inner).s).openWebSocket('/websocket');
    const closes: number[] = [];
    other.addEventListener('close', (e) => closes.push(e.code ?? 0));
    ended.push(null);
    await tick();
    assert.deepEqual(closes, [1000]);
  });

  it('a send that fails closes the socket; a listener removed hears nothing, and one that throws stops nothing', async () => {
    const b = bindingSocket();
    const socket = await createRelayPrinter(session(undefined, b.inner).s).openWebSocket('/websocket');
    const heard: string[] = [];
    const gone = () => heard.push('removed');
    socket.addEventListener('message', gone);
    socket.removeEventListener('message', gone);
    socket.addEventListener('message', () => {
      throw new Error('a bad listener');
    });
    socket.addEventListener('message', (e) => heard.push(String(e.data)));
    b.push('one');
    await tick();
    assert.deepEqual(heard, ['one']);
    socket.send('fail');
    await tick();
    assert.equal(socket.readyState, 3);
  });

  it("rejects as the binding refuses the socket", async () => {
    await assert.rejects(createRelayPrinter(session().s).openWebSocket('/websocket'), /refused/);
  });
});
