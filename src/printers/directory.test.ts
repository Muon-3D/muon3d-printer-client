// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Muon 3D Technologies Limited
// Adapted from Muon3D Fluidd (src/services/muon-cloud/__tests__/directory.spec.ts), written by Muon 3D.
// One entry per printer (directory.ts): the EndpointId joins first, then an address, then the exact display name; a
// printer that moved, was saved twice, or lost its address to another printer; and the saved entries to update.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { printerDirectory, savedName, savedUpdates, tileOfEntry, type AccountPrinter, type DirectorySources, type FoundPrinter, type SavedPrinter } from './directory.ts';

const BOXWOOD = 'f1f6920f'.repeat(8);
const WALNUT = '0658ae04'.repeat(8);
const CHURCHILL = 'c4c4c4c4'.repeat(8);

const found = (name: string, host: string, endpointId: string | null, fields: Partial<FoundPrinter> = {}): FoundPrinter => ({
  host,
  aliases: [host],
  url: `http://${host}`,
  name,
  endpointId,
  health: 'online',
  ...fields,
});
const saved = (url: string, fields: Partial<SavedPrinter> = {}): SavedPrinter => ({ url, name: 'Saved', ...fields });
const owned = (id: string, name: string, online = true, fields: Partial<AccountPrinter> = {}): AccountPrinter => ({ id, name, online, ...fields });
const directory = (sources: Partial<DirectorySources>) => printerDirectory({ account: [], saved: [], found: [], ...sources });

describe('one entry per printer', () => {
  it('lists Boxwood once, under account, when it is in the account, saved at an old address and found here', () => {
    const d = directory({
      account: [owned(BOXWOOD, 'Boxwood')],
      saved: [saved('http://192.168.1.153', { name: 'Boxwood', endpointId: BOXWOOD })],
      found: [found('Boxwood · 367A', '192.168.137.88', BOXWOOD)],
    });
    assert.equal(d.account.length, 1);
    assert.equal(d.saved.length, 0);
    assert.equal(d.found.length, 0);
    assert.equal(d.account[0].host, '192.168.137.88');
    assert.equal(d.account[0].key, `account:${BOXWOOD}`);
    assert.equal(d.account[0].saved.length, 1);
  });

  it('absorbs a saved entry with no EndpointId when the printer at its address is the account one', () => {
    const d = directory({ account: [owned(BOXWOOD, 'Boxwood')], saved: [saved('http://192.168.137.88')], found: [found('Boxwood · 367A', '192.168.137.88', BOXWOOD)] });
    assert.equal(d.account.length, 1);
    assert.equal(d.saved.length, 0);
  });

  it('lists a saved printer once, at its address on this network, after it moved', () => {
    const d = directory({ saved: [saved('http://192.168.1.37', { name: 'Walnut', endpointId: WALNUT })], found: [found('Walnut · 8987', '192.168.137.32', WALNUT)] });
    assert.equal(d.saved.length, 1);
    assert.equal(d.saved[0].host, '192.168.137.32');
    assert.equal(d.saved[0].health, 'online');
    assert.equal(d.saved[0].name, 'Walnut · 8987');
    assert.equal(d.found.length, 0);
  });

  it('lists the printer serving the page once, though it is saved by name and found by IP; its own connection says its health', () => {
    const page = saved('http://muon-boxwood-367a.local', { active: true, health: 'printing' });
    const f = found('Boxwood · 367A', '192.168.137.88', BOXWOOD, { aliases: ['muon-boxwood-367a.local', '192.168.137.88'] });
    const d = directory({ saved: [page], found: [f] });
    assert.equal(d.saved.length, 1);
    assert.equal(d.found.length, 0);
    assert.equal(d.saved[0].health, 'printing');
    assert.equal(d.saved[0].endpointId, BOXWOOD);
  });

  it('ties an old saved entry with no EndpointId to its printer by its full display name, once its address is gone', () => {
    const old = saved('http://192.168.1.153', { name: 'Boxwood · 367A' });
    const here = found('Boxwood · 367A', '192.168.137.88', BOXWOOD);
    const d = directory({ account: [owned(BOXWOOD, 'Boxwood')], saved: [old], found: [here] });
    assert.equal(d.account.length, 1);
    assert.equal(d.saved.length, 0);
    assert.deepEqual(savedUpdates([old], [here]), [{ url: 'http://192.168.1.153', changes: { endpointId: BOXWOOD, url: 'http://192.168.137.88' } }]);
  });

  it('does not tie an old saved entry to a printer whose name only contains its name', () => {
    const d = directory({ saved: [saved('http://192.168.1.153', { name: 'Boxwood' })], found: [found('Boxwood · 367A', '192.168.137.88', BOXWOOD)] });
    assert.equal(d.saved[0].name, 'Boxwood');
    assert.equal(d.saved[0].health, 'offline');
    assert.equal(d.found.length, 1);
  });

  it('merges two saved entries for one printer', () => {
    const d = directory({
      saved: [saved('http://muon-walnut-8987.local', { endpointId: WALNUT }), saved('http://192.168.137.32', { endpointId: WALNUT })],
      found: [found('Walnut · 8987', '192.168.137.32', WALNUT)],
    });
    assert.equal(d.saved.length, 1);
    assert.equal(d.saved[0].saved.length, 2);
  });

  it("does not take another printer at a saved printer's old address for it", () => {
    const d = directory({ saved: [saved('http://192.168.137.32', { name: 'Walnut', endpointId: WALNUT })], found: [found('Churchill · 1A2B', '192.168.137.32', CHURCHILL)] });
    assert.equal(d.saved[0].name, 'Walnut');
    assert.equal(d.saved[0].health, 'offline');
    assert.equal(d.saved[0].host, null);
    assert.deepEqual(d.found.map((e) => e.name), ['Churchill · 1A2B']);
  });

  it('a saved printer with no answer is searching while the search runs, then offline', () => {
    assert.equal(directory({ saved: [saved('http://10.0.0.9')], searching: true }).saved[0].health, 'searching');
    assert.equal(directory({ saved: [saved('http://10.0.0.9')] }).saved[0].health, 'offline');
  });

  it('an account printer found with no EndpointId (older software) joins by a name that contains the other', () => {
    const d = directory({ account: [owned(BOXWOOD, 'Boxwood')], found: [found('Boxwood · 367A', '192.168.1.5', null)] });
    assert.equal(d.account[0].host, '192.168.1.5');
    assert.equal(d.found.length, 0);
    // With an EndpointId, only the EndpointId decides.
    const other = directory({ account: [owned(BOXWOOD, 'Boxwood')], found: [found('Boxwood · 9999', '192.168.1.6', CHURCHILL)] });
    assert.equal(other.account[0].host, null);
    assert.equal(other.found.length, 1);
  });

  it('one found printer at two addresses is one entry', () => {
    const d = directory({ found: [found('Walnut · 8987', '192.168.1.37', WALNUT), found('Walnut · 8987', 'muon-walnut-8987.local', WALNUT)] });
    assert.equal(d.found.length, 1);
    assert.equal(d.found[0].key, `found:${WALNUT}`);
  });
});

describe('health and tiles', () => {
  it("an account printer: the service's flag, the relay's read; one the service lost but is right here reads as here", () => {
    assert.equal(directory({ account: [owned(BOXWOOD, 'Boxwood', true)] }).account[0].health, 'connecting');
    assert.equal(directory({ account: [owned(BOXWOOD, 'Boxwood', true, { health: 'printing' })] }).account[0].health, 'printing');
    assert.equal(directory({ account: [owned(BOXWOOD, 'Boxwood', false, { health: 'printing' })] }).account[0].health, 'offline');
    const lost = directory({ account: [owned(BOXWOOD, 'Boxwood', false)], found: [found('Boxwood · 367A', '192.168.1.5', BOXWOOD, { health: 'paused' })] });
    assert.equal(lost.account[0].health, 'paused');
    const active = directory({ account: [owned(BOXWOOD, 'Boxwood', true, { health: 'error' })], saved: [saved('http://192.168.1.5', { endpointId: BOXWOOD, active: true, health: 'online' })] });
    assert.equal(active.account[0].health, 'online');
  });

  it('a found printer not read shows ready, one to set up new, a saved one not found offline', () => {
    const d = directory({ found: [found('Oak · 1111', '10.0.0.2', null, { health: undefined })], saved: [saved('http://10.0.0.3', { endpointId: WALNUT })] });
    assert.equal(tileOfEntry(d.found[0]), 'ready');
    assert.equal(tileOfEntry(d.found[0], { needsSetUp: true }), 'new');
    assert.equal(tileOfEntry(d.saved[0]), 'offline');
  });
});

describe('saved entries', () => {
  it("a saved printer's name: its own, else its network name, else its address", () => {
    assert.equal(savedName({ url: 'http://10.0.0.5', name: ' Oak ' }), 'Oak');
    assert.equal(savedName({ url: 'http://10.0.0.5', mdnsHost: 'muon-oak-1a2b.local' }), 'muon-oak-1a2b');
    assert.equal(savedName({ url: 'http://10.0.0.5:7125' }), '10.0.0.5:7125');
  });

  it('records the EndpointId and .local name, follows a printer saved by IP, and leaves the active entry alone', () => {
    const here = found('Walnut · 8987', '192.168.137.32', WALNUT, { aliases: ['192.168.137.32', 'muon-walnut-8987.local'], mdnsHost: 'muon-walnut-8987.local' });
    assert.deepEqual(savedUpdates([saved('http://192.168.1.37', { endpointId: WALNUT })], [here]), [
      { url: 'http://192.168.1.37', changes: { mdnsHost: 'muon-walnut-8987.local', url: 'http://192.168.137.32' } },
    ]);
    assert.deepEqual(savedUpdates([saved('http://192.168.1.37', { endpointId: WALNUT, active: true })], [here]), []);
    // Saved by name: mDNS follows it already.
    assert.deepEqual(savedUpdates([saved('http://muon-walnut-8987.local', { endpointId: WALNUT, mdnsHost: 'muon-walnut-8987.local' })], [here]), []);
    // A page that may not reach IPv4 addresses moves a printer saved by IP to its .local name.
    const atOldIp = found('Walnut · 8987', '192.168.1.37', WALNUT, { aliases: ['192.168.1.37', 'muon-walnut-8987.local'] });
    assert.deepEqual(savedUpdates([saved('http://192.168.1.37', { endpointId: WALNUT })], [atOldIp], true), [{ url: 'http://192.168.1.37', changes: { url: 'http://muon-walnut-8987.local' } }]);
  });
});
