// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Muon 3D Technologies Limited
// The Error that carries a PrinterError (failure.ts), and the local network's two kinds: a page this browser will not
// let reach the network, and a refused permission (parseLanFailure).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fail, failureOf, PrinterFailure } from './failure.ts';
import { isTerminal, printerError } from './kinds.ts';
import { parseBridgeError, parseLanFailure } from './parse.ts';

const domError = (name: string) => Object.assign(new Error(`${name} happened`), { name });

describe('PrinterFailure', () => {
  it('carries the PrinterError through a throw, and failureOf reads it back', async () => {
    const error = printerError('busy', 'The printer is printing', { status: 403 });
    const thrown = fail(error);
    assert.ok(thrown instanceof Error);
    assert.ok(thrown instanceof PrinterFailure);
    assert.equal(thrown.name, 'PrinterFailure');
    assert.equal(thrown.message, 'The printer is printing');
    await assert.rejects(Promise.reject(thrown), (err) => failureOf(err) === error);
  });

  it('reads a PrinterError thrown as it is, another copy of the class, an abort; anything else is protocol', () => {
    const error = printerError('offline', 'gone');
    assert.equal(failureOf(error), error);
    const foreign = Object.assign(new Error('gone'), { name: 'PrinterFailure', error });
    assert.equal(failureOf(foreign), error);
    assert.equal(failureOf(domError('AbortError')).kind, 'cancelled');
    const odd = failureOf(new Error('bad\nthing'));
    assert.equal(odd.kind, 'protocol');
    assert.equal(odd.detail, 'bad thing');
    assert.equal(failureOf('a string').detail, 'a string');
    assert.equal(failureOf(Object.assign(new Error('x'), { name: 'PrinterFailure', error: { kind: 'nope' } })).kind, 'protocol');
  });
});

describe('parseLanFailure', () => {
  const failed = new TypeError('Failed to fetch');

  it('an https page asking a plain-http printer, with the permission refused: permission', () => {
    const error = parseLanFailure(failed, { pageBlocked: true, permission: 'denied' });
    assert.equal(error.kind, 'permission');
    assert.equal(error.detail, 'Failed to fetch');
  });

  it('the same page in a browser with no local network permission at all: chrome-only', () => {
    assert.equal(parseLanFailure(failed, { pageBlocked: true, permission: 'unknown' }).kind, 'chrome-only');
  });

  it('a page that is not blocked, or a permission granted or still to ask: as parseNetworkFailure reads it', () => {
    assert.equal(parseLanFailure(failed, { pageBlocked: false, permission: 'denied' }).kind, 'offline');
    assert.equal(parseLanFailure(failed, { pageBlocked: true, permission: 'granted' }).kind, 'offline');
    assert.equal(parseLanFailure(failed, { pageBlocked: true, permission: 'prompt' }).kind, 'offline');
    assert.equal(parseLanFailure(failed, { pageBlocked: false, permission: 'granted', committed: true }).kind, 'lost');
    assert.equal(parseLanFailure(failed, { pageBlocked: false, permission: 'granted', sent: 10 }).kind, 'lost');
  });

  it('an abort or a timeout is never the browser', () => {
    assert.equal(parseLanFailure(domError('AbortError'), { pageBlocked: true, permission: 'denied' }).kind, 'cancelled');
    assert.equal(parseLanFailure(domError('TimeoutError'), { pageBlocked: true, permission: 'unknown' }).kind, 'timeout');
  });

  it('both are terminal, and a bridge host may report them', () => {
    assert.equal(isTerminal(printerError('chrome-only', 'm')), true);
    assert.equal(isTerminal(printerError('permission', 'm')), true);
    assert.equal(parseBridgeError({ kind: 'chrome-only', message: 'Firefox' }).kind, 'chrome-only');
    assert.equal(parseBridgeError({ kind: 'permission', message: 'refused' }).kind, 'permission');
  });
});
