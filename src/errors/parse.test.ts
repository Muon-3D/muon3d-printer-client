// SPDX-License-Identifier: Apache-2.0
// One case for every row of the error table the slicer shows errors by (the source, the kind it becomes), with the
// answers as the printer, the gateway, the relay binding, the account service and a bridge host send them.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cleanText, ERROR_KINDS, isErrorKind, isPrinterError, isTerminal, needsRegrant, printerError, type PrinterError } from './kinds.ts';
import {
  answerText,
  CLOSE_CODES,
  parseBindingError,
  parseBridgeError,
  parseCloseCode,
  parseConsoleAnswer,
  parseConsoleFailure,
  parseConsolePrinter,
  parseNetworkFailure,
  parsePrinterAnswer,
  parseRpcError,
  parseSocketClose,
  parseUploadAnswer,
  parseXhrFailure,
  printerChangedError,
  protocolError,
  retryAfterSeconds,
  timeoutError,
} from './parse.ts';

/** The fields a decision reads (the message is for logs and is not compared). */
const facts = (error: PrinterError | null) => {
  if (!error) return null;
  const { message, ...rest } = error;
  assert.ok(message.length > 0);
  return rest;
};
const json = (value: unknown) => JSON.stringify(value);
const moonraker = (code: number, message: string) => json({ error: { code, message, traceback: 'Traceback (most recent call last): …' } });
const gateway = (error: string) => json({ error });
const bindingError = (kind: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(`muon-link-web: ${kind}`), { kind, ...extra });
const domError = (name: string) => Object.assign(new Error(`${name} happened`), { name });

describe('the error table, row by row', () => {
  it('offline: a LAN fetch that fails on the network, a printer the console lists offline, an access grant answered 503', () => {
    assert.deepEqual(facts(parseNetworkFailure(new TypeError('Failed to fetch'))), { kind: 'offline', detail: 'Failed to fetch' });
    assert.deepEqual(facts(parseConsolePrinter({ online: false })), { kind: 'offline' });
    assert.equal(parseConsolePrinter({ online: true }), null);
    assert.deepEqual(facts(parseConsoleAnswer({ status: 503, body: gateway('printer is offline') }, { route: 'access' })), {
      kind: 'offline',
      status: 503,
      detail: 'printer is offline',
    });
  });

  it("unreachable: the binding's connect, config and protocol errors, a connect or probe timeout, an access grant answered 504", () => {
    for (const kind of ['connect', 'config', 'protocol']) {
      assert.deepEqual(facts(parseBindingError(bindingError(kind))), { kind: 'unreachable', detail: `muon-link-web: ${kind}` }, kind);
    }
    assert.equal(parseBindingError(new Error('no kind')).kind, 'unreachable');
    assert.deepEqual(facts(timeoutError('connect', 20)), { kind: 'unreachable' });
    assert.deepEqual(facts(timeoutError('probe', 10)), { kind: 'unreachable' });
    assert.deepEqual(facts(parseConsoleAnswer({ status: 504, body: gateway('the printer did not acknowledge the grant') }, { route: 'access' })), {
      kind: 'unreachable',
      status: 504,
      detail: 'the printer did not acknowledge the grant',
    });
  });

  it("lost: the binding's lost, a WebSocket that closed, an upload that broke off mid-body, the bridge's lost", () => {
    assert.equal(parseBindingError(bindingError('lost')).kind, 'lost');
    assert.equal(parseBindingError(bindingError('websocket')).kind, 'lost');
    assert.deepEqual(facts(parseSocketClose({ code: 1006, reason: '' })), { kind: 'lost' });
    assert.deepEqual(facts(parseSocketClose({ code: 1011, reason: 'server\nerror' })), { kind: 'lost', detail: 'server error' });
    assert.deepEqual(facts(parseXhrFailure('error', 65536)), { kind: 'lost' });
    assert.deepEqual(facts(parseNetworkFailure(new TypeError('network error'), { sent: 1024 })), { kind: 'lost', detail: 'network error' });
    assert.deepEqual(facts(parseBridgeError({ kind: 'lost', message: 'Walnut went away' })), { kind: 'lost', detail: 'Walnut went away' });
    // Nothing was sent yet: the printer never answered at all.
    assert.equal(parseXhrFailure('error', 0).kind, 'offline');
    // A start or a queue entry sends too little to count, and may have reached the printer: its answer was lost.
    const start = parseNetworkFailure(new TypeError('Failed to fetch'), { committed: true });
    assert.deepEqual(facts(start), { kind: 'lost', detail: 'Failed to fetch' });
    assert.match(start.message, /answer was lost/);
  });

  it('lost: a relay close that refuses nothing (a restart, a shutdown, the other side gone, a code nobody knows)', () => {
    // muon-link-web reports every close as refused with its code; 0 is the printer's endpoint closing.
    for (const code of [0, 0x0400, 0x0405, 0x0406, 0x0408, 0x0409, 0x0499]) {
      const error = parseBindingError(bindingError('refused', { code }));
      assert.deepEqual(facts(error), { kind: 'lost', detail: 'muon-link-web: refused' }, String(code));
      assert.match(error.message, new RegExp(`0x${code.toString(16).padStart(4, '0')}`));
      assert.equal(isTerminal(error), false);
    }
    assert.match(parseCloseCode(0x0405).message, /device-shutdown/);
  });

  it("printer-changed: the bridge's printer-changed, and a printer.changed event during a send", () => {
    assert.deepEqual(facts(parseBridgeError({ kind: 'printer-changed', message: 'Oak is selected' })), { kind: 'printer-changed', detail: 'Oak is selected' });
    assert.deepEqual(facts(printerChangedError()), { kind: 'printer-changed' });
  });

  it('refused, a new grant first: close codes 0x040a (unauthorised) and 0x040b (expired)', () => {
    for (const [code, refusal] of [[0x040a, 'unauthorised'], [0x040b, 'expired']] as const) {
      const error = parseBindingError(bindingError('refused', { code }));
      assert.deepEqual(facts(error), { kind: 'refused', refusal, detail: 'muon-link-web: refused' });
      assert.equal(needsRegrant(error), true);
      assert.equal(isTerminal(error), false);
    }
  });

  it('refused for good: close codes 0x0403 (revoked), 0x040c (ALPN refused), 0x0401, 0x0402 and 0x0407', () => {
    for (const [code, refusal] of [[0x0403, 'revoked'], [0x040c, 'alpn-refused']] as const) {
      const error = parseCloseCode(code);
      assert.deepEqual(facts(error), { kind: 'refused', refusal });
      assert.equal(needsRegrant(error), false);
      assert.equal(isTerminal(error), true);
    }
    for (const [code, name] of [[0x0401, 'auth-failed'], [0x0402, 'policy-denied'], [0x0407, 'version-unsupported']] as const) {
      const error = parseCloseCode(code);
      assert.deepEqual(facts(error), { kind: 'refused' });
      assert.match(error.message, new RegExp(name));
      assert.equal(isTerminal(error), true);
    }
  });

  it('busy: close code 0x0404 (at capacity)', () => {
    const error = parseBindingError(bindingError('refused', { code: 0x0404 }));
    assert.deepEqual(facts(error), { kind: 'busy', refusal: 'rate-limited', detail: 'muon-link-web: refused' });
    assert.equal(isTerminal(error), false);
  });

  it("denied with the action: Moonraker's 403 access-denied:<action>", () => {
    const body = moonraker(403, "access-denied:print: 'print' is not allowed on this printer: it needs admin.");
    assert.deepEqual(facts(parsePrinterAnswer({ status: 403, body })), {
      kind: 'denied',
      status: 403,
      action: 'print',
      detail: "'print' is not allowed on this printer: it needs admin.",
    });
    // The same refusal over the WebSocket's JSON-RPC.
    assert.deepEqual(facts(parseRpcError({ code: 403, message: "access-denied:files: 'files' is not allowed on this printer: owner unknown." })), {
      kind: 'denied',
      status: 403,
      action: 'files',
      detail: "'files' is not allowed on this printer: owner unknown.",
    });
  });

  it("denied: the gateway's policy 403 and its JSON-RPC -32001; not-allowed: the bridge's", () => {
    assert.deepEqual(facts(parsePrinterAnswer({ status: 403, body: gateway('muon-link policy refused this request: /server/muon/identity is for the owner') })), {
      kind: 'denied',
      status: 403,
      detail: '/server/muon/identity is for the owner',
    });
    const rpc = { jsonrpc: '2.0', error: { code: -32001, message: 'muon-link policy refused `printer.gcode.script`: an operator needs a local pairing' }, id: 7 };
    const denied = parseRpcError(rpc);
    assert.deepEqual(facts(denied), { kind: 'denied', status: -32001, detail: 'an operator needs a local pairing' });
    assert.match(denied.message, /printer\.gcode\.script/);
    assert.deepEqual(facts(parseRpcError({ code: -32001, message: 'muon-link policy refused this call' })), { kind: 'denied', status: -32001 });
    assert.deepEqual(facts(parseRpcError({ code: -32001, message: 'refused' })), { kind: 'denied', status: -32001, detail: 'refused' });
    assert.deepEqual(facts(parseBridgeError({ kind: 'not-allowed', message: 'printer.gcode.script is not on the read allowlist' })), {
      kind: 'not-allowed',
      detail: 'printer.gcode.script is not on the read allowlist',
    });
  });

  it("upload-refused: the gateway's upload refusals, 400, 403 and 411, and its 400 for an ambiguously framed request", () => {
    for (const status of [400, 403, 411]) {
      assert.deepEqual(facts(parsePrinterAnswer({ status, body: gateway('muon-link refused this upload: the body does not open with its boundary') })), {
        kind: 'upload-refused',
        status,
        detail: 'the body does not open with its boundary',
      });
    }
    const framing = gateway('muon-link refused an ambiguously framed request: the request has both Transfer-Encoding and Content-Length');
    assert.deepEqual(facts(parsePrinterAnswer({ status: 400, body: framing })), {
      kind: 'upload-refused',
      status: 400,
      detail: 'the request has both Transfer-Encoding and Content-Length',
    });
  });

  it('checksum: 422, whatever its text', () => {
    // Moonraker raises its 422 without a reason, so the body carries only the status's phrase.
    const body = json({ error: { code: 422, message: 'Unprocessable Entity' } });
    assert.deepEqual(facts(parsePrinterAnswer({ status: 422, body })), { kind: 'checksum', status: 422, detail: 'Unprocessable Entity' });
    assert.equal(parsePrinterAnswer({ status: 422, body: moonraker(422, 'File checksum mismatch: expected a515…, calculated 0000…') })?.kind, 'checksum');
    assert.equal(parsePrinterAnswer({ status: 422, body: '' })?.kind, 'checksum');
  });

  it("safety-pass: a 500 from the printer's G-code safety pass (exited, or timed out)", () => {
    for (const text of ['G-code safety postprocessor exited 1', 'G-code safety postprocessor timed out after 120s']) {
      assert.deepEqual(facts(parsePrinterAnswer({ status: 500, body: moonraker(500, text) })), { kind: 'safety-pass', status: 500, detail: text });
    }
    // Another 500 is the printer's own error.
    assert.equal(parsePrinterAnswer({ status: 500, body: moonraker(500, 'Internal Server Error') })?.kind, 'printer');
  });

  it('busy: 403 "File is loaded"', () => {
    assert.deepEqual(facts(parsePrinterAnswer({ status: 403, body: moonraker(403, 'File is loaded, upload not permitted') })), {
      kind: 'busy',
      status: 403,
      detail: 'File is loaded, upload not permitted',
    });
  });

  it('printer: any other error the printer answers, with its message', () => {
    assert.deepEqual(facts(parsePrinterAnswer({ status: 400, body: moonraker(400, 'No file name specifed in upload form') })), {
      kind: 'printer',
      status: 400,
      detail: 'No file name specifed in upload form',
    });
    assert.deepEqual(facts(parsePrinterAnswer({ status: 401, body: moonraker(401, 'Unauthorized') })), { kind: 'printer', status: 401, detail: 'Unauthorized' });
    assert.deepEqual(facts(parsePrinterAnswer({ status: 503, body: gateway('muon-link could not authenticate this request to Moonraker') })), {
      kind: 'printer',
      status: 503,
      detail: 'muon-link could not authenticate this request to Moonraker',
    });
    // A proxy's page in front of the printer: its title.
    const nginx = '<html>\r\n<head><title>413 Request Entity Too Large</title></head>\r\n<body><center><h1>413 Request Entity Too Large</h1></center></body></html>';
    assert.deepEqual(facts(parsePrinterAnswer({ status: 413, body: new TextEncoder().encode(nginx) })), { kind: 'printer', status: 413, detail: '413 Request Entity Too Large' });
    assert.deepEqual(facts(parseRpcError({ jsonrpc: '2.0', error: { code: 400, message: 'Printer not ready' }, id: 3 })), { kind: 'printer', status: 400, detail: 'Printer not ready' });
    assert.deepEqual(facts(parseRpcError({ code: -32601, message: 'Method not found' })), { kind: 'printer', status: -32601, detail: 'Method not found' });
    // A wording that only looks like a refusal is the printer's own error, not a denial.
    assert.equal(parsePrinterAnswer({ status: 400, body: moonraker(400, 'access-denied:print: from a 400') })?.kind, 'printer');
  });

  it('signed-out: the console\'s 401, the token endpoint\'s invalid_grant, a refresh whose outcome is unknown', () => {
    assert.deepEqual(facts(parseConsoleAnswer({ status: 401, body: gateway('your session has ended; sign in again') })), {
      kind: 'signed-out',
      status: 401,
      detail: 'your session has ended; sign in again',
    });
    assert.deepEqual(facts(parseConsoleAnswer({ status: 400, body: json({ error: 'invalid_grant', error_description: 'the refresh token was used' }) }, { route: 'token' })), {
      kind: 'signed-out',
      status: 400,
      detail: 'the refresh token was used',
    });
    assert.deepEqual(facts(parseConsoleFailure(new TypeError('Failed to fetch'), { refreshing: true })), { kind: 'signed-out', detail: 'Failed to fetch' });
    // An aborted refresh may have been sent: its token is never sent again.
    assert.deepEqual(facts(parseConsoleFailure(domError('AbortError'), { refreshing: true })), { kind: 'signed-out', detail: 'AbortError happened' });
    // Another OAuth error is the service's, not the end of the session.
    assert.equal(parseConsoleAnswer({ status: 400, body: json({ error: 'invalid_request' }) }, { route: 'token' })?.kind, 'console');
  });

  it("console: the console's other 4xx and 5xx, and 429 with Retry-After", () => {
    assert.deepEqual(facts(parseConsoleAnswer({ status: 429, body: gateway('slow down'), retryAfter: '30' })), {
      kind: 'console',
      status: 429,
      detail: 'slow down',
      retryAfterS: 30,
    });
    for (const status of [400, 404, 409, 500, 502]) {
      assert.deepEqual(facts(parseConsoleAnswer({ status, body: gateway('no') })), { kind: 'console', status, detail: 'no' }, String(status));
    }
    // 503 and 504 are the printer's only for its access grant.
    assert.equal(parseConsoleAnswer({ status: 503, body: '' })?.kind, 'console');
    assert.deepEqual(facts(parseConsoleFailure(new TypeError('Failed to fetch'))), { kind: 'console', detail: 'Failed to fetch' });
    assert.equal(parseConsoleAnswer({ status: 200, body: '{}' }), null);
  });

  it("timeout: a request's timeout signal, an XHR timeout, an answer that does not come", () => {
    assert.deepEqual(facts(parseNetworkFailure(domError('TimeoutError'))), { kind: 'timeout', detail: 'TimeoutError happened' });
    assert.deepEqual(facts(parseXhrFailure('timeout', 10)), { kind: 'timeout' });
    const start = timeoutError('answer', 150);
    assert.deepEqual(facts(start), { kind: 'timeout' });
    assert.match(start.message, /150 s/);
  });

  it("cancelled: an AbortSignal, an aborted XHR, the bridge's cancel", () => {
    assert.deepEqual(facts(parseNetworkFailure(domError('AbortError'))), { kind: 'cancelled' });
    assert.deepEqual(facts(parseXhrFailure('abort', 100)), { kind: 'cancelled' });
    assert.deepEqual(facts(parseBindingError(domError('AbortError'))), { kind: 'cancelled' });
    assert.deepEqual(facts(parseConsoleFailure(domError('AbortError'))), { kind: 'cancelled' });
    assert.deepEqual(facts(parseBridgeError({ kind: 'cancelled', message: 'cancelled' })), { kind: 'cancelled', detail: 'cancelled' });
  });
});

describe("the upload's answer", () => {
  const stored = (extra: Record<string, unknown> = {}, item: Record<string, unknown> = {}) =>
    json({
      item: { path: 'cube.gcode', root: 'gcodes', modified: 1791000000.5, size: 16, permissions: 'rw', ...item },
      print_started: false,
      print_queued: false,
      action: 'create_file',
      ...extra,
    });

  it('is the file stored: its path in the gcodes root and its size', () => {
    assert.deepEqual(parseUploadAnswer({ status: 201, body: stored() }), { path: 'cube.gcode', size: 16 });
    assert.deepEqual(parseUploadAnswer({ status: 201, body: new TextEncoder().encode(stored({}, { path: 'cube_2.gcode' })) }), { path: 'cube_2.gcode', size: 16 });
  });

  it('reads an error as parsePrinterAnswer does', () => {
    assert.deepEqual(facts(parseUploadAnswer({ status: 403, body: moonraker(403, 'File is loaded, upload not permitted') }) as PrinterError), {
      kind: 'busy',
      status: 403,
      detail: 'File is loaded, upload not permitted',
    });
  });

  it('is protocol when it is not that answer: a 200 page, no item, another root, a print started or queued', () => {
    const page = parseUploadAnswer({ status: 200, body: '<html><head><title>Welcome to nginx!</title></head></html>' }) as PrinterError;
    assert.deepEqual(facts(page), { kind: 'protocol', detail: 'Welcome to nginx!' });
    for (const body of ['', '{}', json({ item: null }), stored({}, { path: '' }), stored({}, { size: '16' }), stored({}, { root: 'config' })]) {
      assert.equal((parseUploadAnswer({ status: 201, body }) as PrinterError).kind, 'protocol', body);
    }
    for (const flag of ['print_started', 'print_queued']) {
      const error = parseUploadAnswer({ status: 201, body: stored({ [flag]: true }) }) as PrinterError;
      assert.equal(error.kind, 'protocol');
      assert.match(error.message, /started or queued a print/);
      assert.equal(isTerminal(error), true);
    }
  });
});

describe('answers that are not what the protocol says', () => {
  it('a JSON-RPC error without a code or a message is protocol, and terminal', () => {
    for (const bad of [null, 'oops', {}, { code: '403', message: 'x' }, { code: 403 }, { code: 1.5, message: 'x' }, { jsonrpc: '2.0', error: null, id: 1 }]) {
      const error = parseRpcError(bad);
      assert.equal(error.kind, 'protocol', JSON.stringify(bad));
      assert.equal(isTerminal(error), true);
    }
  });

  it("a bridge failure of a kind nobody knows, or without a message, is protocol; the host's text is cleaned", () => {
    assert.equal(parseBridgeError({ kind: 'exploded', message: 'x' }).kind, 'protocol');
    assert.equal(parseBridgeError({ kind: 'busy' }).kind, 'protocol');
    assert.equal(parseBridgeError(null).kind, 'protocol');
    const error = parseBridgeError({ kind: 'denied', message: `<b>Not\u0000 allowed</b>\n${'!'.repeat(1000)}`, status: 403, action: 'print\u202e', extra: 'ignored' });
    assert.equal(error.kind, 'denied');
    assert.equal(error.status, 403);
    assert.equal(error.detail?.length, 500);
    assert.ok(error.detail?.startsWith('<b>Not allowed</b> !!!'));
    assert.equal(error.action, 'print');
    assert.equal(parseBridgeError({ kind: 'denied', message: 'x', status: '403', action: 7 }).status, undefined);
  });

  it('protocolError names what was wrong', () => {
    assert.deepEqual(facts(protocolError('a 201 without item.path')), { kind: 'protocol' });
  });
});

describe('the kinds', () => {
  it('are the table\'s, and only those', () => {
    assert.equal(new Set(ERROR_KINDS).size, ERROR_KINDS.length);
    assert.equal(isErrorKind('offline'), true);
    assert.equal(isErrorKind('Offline'), false);
    assert.equal(isErrorKind(undefined), false);
  });

  it('keep only the fields that have a value', () => {
    assert.deepEqual(printerError('printer', 'm', { status: 500, detail: '', action: undefined }), { kind: 'printer', message: 'm', status: 500 });
    assert.equal(isPrinterError(printerError('busy', 'm')), true);
    assert.equal(isPrinterError({ kind: 'busy' }), false);
    assert.equal(isPrinterError(new Error('x')), false);
  });

  it('say which errors end the connection for good', () => {
    const terminal = ERROR_KINDS.filter((kind) => isTerminal(printerError(kind, 'm')));
    assert.deepEqual(terminal, ['refused', 'signed-out', 'protocol', 'chrome-only', 'permission']);
    assert.equal(isTerminal(parseCloseCode(CLOSE_CODES.expired)), false);
  });
});

describe('the helpers', () => {
  it("read an answer's words from JSON, bytes, HTML or text", () => {
    assert.equal(answerText(json({ error: 'gateway words' })), 'gateway words');
    assert.equal(answerText({ error: { code: 400, message: 'moonraker words' } }), 'moonraker words');
    assert.equal(answerText(json({ message: 'plain message' })), 'plain message');
    assert.equal(answerText(new TextEncoder().encode('  just text\r\n').buffer), 'just text');
    assert.equal(answerText('<html><body>no title</body></html>'), '');
    assert.equal(answerText('{not json'), '{not json');
    assert.equal(answerText([1, 2]), '');
    assert.equal(answerText(undefined), '');
  });

  it('read Retry-After as seconds or as a date', () => {
    const now = Date.parse('2026-10-07T12:00:00Z');
    assert.equal(retryAfterSeconds('120', now), 120);
    assert.equal(retryAfterSeconds('Wed, 07 Oct 2026 12:00:30 GMT', now), 30);
    assert.equal(retryAfterSeconds('Wed, 07 Oct 2026 11:00:00 GMT', now), 0);
    assert.equal(retryAfterSeconds('soon', now), undefined);
    assert.equal(retryAfterSeconds(null, now), undefined);
  });

  it('read a close code given as a number, a bigint or a string', () => {
    assert.equal(parseCloseCode(BigInt(0x040b)).refusal, 'expired');
    assert.equal(parseCloseCode('0x040c').refusal, 'alpn-refused');
    assert.equal(parseCloseCode(1035).refusal, 'expired');
  });

  it('clean text for display: one line, no controls, at most 500 characters, never half a character', () => {
    assert.equal(cleanText(' a\r\n\tb\u0007c  '), 'a b c');
    assert.equal(cleanText('Walnut\u202e edoc.gcode\u2066'), 'Walnut edoc.gcode');
    assert.equal(cleanText('x'.repeat(600)).length, 500);
    assert.ok(cleanText('x'.repeat(600)).endsWith('…'));
    const emoji = cleanText(`${'x'.repeat(498)}😀😀`);
    assert.equal(emoji, `${'x'.repeat(498)}…`);
    assert.equal(cleanText('abc', 2), 'a…');
  });
});
