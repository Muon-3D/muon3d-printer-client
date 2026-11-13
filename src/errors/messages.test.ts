// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Muon 3D Technologies Limited
// The words a person reads about each kind (messages.ts): the design's rows exactly, a sentence and at most one action
// for every kind, the printer's name in it (or "the printer"), and no internal words.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ERROR_KINDS, printerError, type ErrorKind, type PrinterError } from './kinds.ts';
import { ACTION_LABELS, explain } from './messages.ts';
import { parseCloseCode } from './parse.ts';

const error = (kind: ErrorKind, extra: Partial<PrinterError> = {}): PrinterError => ({ ...printerError(kind, 'for logs'), ...extra });
const ctx = { printer: 'Walnut', owner: 'Jo', lastSeen: '2 hours ago' };

describe('explain: the design rows', () => {
  const rows: [ErrorKind, string, string | undefined, string | undefined][] = [
    ['offline', "Walnut isn't connected to Muon3D", "It was last seen 2 hours ago. Check it's switched on and on Wi-Fi; it reconnects by itself.", 'Open in Control'],
    ['unreachable', 'Walnut is on, but not answering this browser', 'It may be restarting; this usually clears in a minute.', 'Try again'],
    ['lost', 'Walnut is on, but not answering this browser', 'It may be restarting; this usually clears in a minute.', 'Try again'],
    ['timeout', 'Walnut is on, but not answering this browser', 'It may be restarting; this usually clears in a minute.', 'Try again'],
    ['busy', 'Walnut is printing', undefined, 'Queue it'],
    ['not-allowed', 'You can watch Walnut, but not print on it', 'Jo can let you print from Control.', 'Ask for access'],
    ['signed-out', 'Your Muon3D sign-in has ended', undefined, 'Sign in'],
    ['chrome-only', 'Printers on your network need Chrome', "Firefox and Safari don't let a website reach printers on your network.", 'Open in Chrome'],
    ['permission', "Chrome isn't allowed to use your local network here", 'Allow it from the icon left of the address, then try again.', 'Try again'],
    ['upload-refused', 'Walnut refused the file', undefined, undefined],
  ];
  for (const [kind, title, detail, label] of rows) {
    it(kind, () => {
      const words = explain(error(kind), ctx);
      assert.equal(words.title, title);
      assert.equal(words.detail, detail);
      assert.equal(words.action?.label, label);
    });
  }
});

describe('explain: every kind', () => {
  it('has a title, at most one action with its own label, and no words for logs', () => {
    for (const kind of ERROR_KINDS) {
      const words = explain(error(kind, { detail: 'muon-link refused: secret internals' }), ctx);
      assert.ok(words.title.length > 0, kind);
      assert.ok(!/\.$/.test(words.title), `${kind}: a title has no full stop`);
      if (words.detail !== undefined) assert.match(words.detail, /\.$/, `${kind}: a detail is sentences`);
      if (words.action) assert.equal(words.action.label, ACTION_LABELS[words.action.id], kind);
      const all = `${words.title} ${words.detail ?? ''}`;
      assert.ok(!all.includes('for logs') && !all.includes('internals'), `${kind}: the PrinterError's own words stay out`);
      assert.ok(!/\b(undefined|null|NaN)\b/.test(all), `${kind}: ${all}`);
    }
  });

  it('says "the printer" without a name, and its owner without one', () => {
    assert.equal(explain(error('busy')).title, 'The printer is printing');
    assert.equal(explain(error('not-allowed')).title, 'You can watch the printer, but not print on it');
    assert.equal(explain(error('not-allowed')).detail, 'Its owner can let you print from Control.');
    assert.equal(explain(error('offline')).detail, "Check it's switched on and on Wi-Fi; it reconnects by itself.");
    assert.equal(explain(error('safety-pass')).title, "The printer's safety check stopped the file");
    assert.equal(explain(error('safety-pass'), ctx).title, "Walnut's safety check stopped the file");
  });

  it('cleans what it is given: one line, at most 64 characters, no direction marks', () => {
    const words = explain(error('busy'), { printer: 'Wal\nnut‮' });
    assert.equal(words.title, 'Wal nut is printing');
    assert.ok(explain(error('busy'), { printer: 'x'.repeat(200) }).title.length < 80);
  });

  it("tells the relay's refusals apart: a new grant, access ended, anything else", () => {
    assert.equal(explain(parseCloseCode(0x040b), ctx).action?.id, 'retry');
    const revoked = explain(parseCloseCode(0x0403), ctx);
    assert.equal(revoked.title, 'Walnut no longer lets you in');
    assert.equal(revoked.action?.id, 'ask-access');
    assert.equal(explain(parseCloseCode(0x0401), ctx).action?.id, 'open-control');
    // At capacity is busy, but not a print.
    const capacity = explain(parseCloseCode(0x0404), ctx);
    assert.equal(capacity.title, 'Walnut has too many connections right now');
    assert.equal(capacity.action?.id, 'retry');
  });

  it("says how long the account service asked to wait", () => {
    assert.equal(explain(error('console')).detail, 'Try again in a minute.');
    assert.equal(explain(error('console', { retryAfterS: 30 })).detail, 'Try again in 30 seconds.');
    assert.equal(explain(error('console', { retryAfterS: 300 })).detail, 'Try again in 5 minutes.');
  });

  it('reads a kind it does not know as protocol', () => {
    const unknown = { kind: 'exploded', message: 'x' } as unknown as PrinterError;
    assert.deepEqual(explain(unknown, ctx), explain(error('protocol'), ctx));
  });
});
