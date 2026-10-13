// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Muon 3D Technologies Limited
// Adapted from Muon3D Fluidd (src/services/printer-pages/__tests__/slug.spec.ts), written by Muon 3D.
// Printer slugs (slug.ts) and names (name.ts): the same slug Control makes for each kind of printer, never one of its
// routes or a path the printer's nginx sends to Moonraker; and a printer's name split from its serial suffix.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { printerNameParts } from './name.ts';
import { hash4, isPrinterSlug, printerPath, slugForAccountPrinter, slugForAddress, slugForIdentity, slugForMdnsHost, slugify, slugSuffix } from './slug.ts';

describe('printer slugs', () => {
  it('makes words from a display name', () => {
    assert.equal(slugify('Boxwood · 367A'), 'boxwood-367a');
    assert.equal(slugify('  Café Printer!! '), 'cafe-printer');
  });

  it('names a Muon3D printer by its name and serial suffix', () => {
    assert.equal(slugForIdentity({ name: 'boxwood', derived_name: 'boxwood', suffix: '367a' }), 'boxwood-367a');
    assert.equal(slugForIdentity({ name: 'Workshop One', derived_name: 'boxwood', suffix: '367A' }), 'workshop-one-367a');
    assert.equal(slugForIdentity({ name: 'Boxwood 367A', suffix: '367a' }), 'boxwood-367a');
    assert.equal(slugForIdentity({ derived_name: 'walnut', suffix: '8987' }), 'walnut-8987');
    assert.equal(slugForIdentity({ name: 'boxwood' }), null);
    assert.equal(slugForIdentity(null), null);
  });

  it('reads the same slug from the .local name', () => {
    assert.equal(slugForMdnsHost('muon-boxwood-367a.local'), 'boxwood-367a');
    assert.equal(slugForMdnsHost('Muon-walnut-8987.local'), 'walnut-8987');
    assert.equal(slugForMdnsHost('boxwood.local'), null);
    assert.equal(slugForMdnsHost(undefined), null);
  });

  it("names an account printer by the account service's display name", () => {
    assert.equal(slugForAccountPrinter({ id: 'f1f6920f757634a1', name: 'Boxwood · 367A' }), 'boxwood-367a');
    // Renamed without its suffix: four characters of the EndpointId.
    assert.equal(slugForAccountPrinter({ id: 'f1f6920f757634a1', name: 'Workshop printer' }), 'workshop-printer-f1f6');
  });

  it('names any other printer by its name and a hash of its address', () => {
    const a = slugForAddress('Voron', 'http://192.168.1.20');
    assert.match(a, /^voron-[a-z0-9]{4}$/);
    assert.equal(slugForAddress('Voron', 'http://192.168.1.20/'), a);
    assert.notEqual(slugForAddress('Voron', 'http://192.168.1.21'), a);
    // Fluidd's default instance name says nothing: the host does.
    assert.match(slugForAddress('fluidd', 'http://voron.local'), /^voron-local-[a-z0-9]{4}$/);
  });

  it("never starts with a path the printer's nginx sends to Moonraker", () => {
    assert.match(slugForAddress('Printer', 'http://10.0.0.5'), /^p-printer-[a-z0-9]{4}$/);
    assert.equal(slugForIdentity({ name: 'server room', suffix: 'a1b2' }), 'p-server-room-a1b2');
    assert.equal(slugForAccountPrinter({ id: 'abcd', name: 'Access 1' }), 'p-access-1-abcd');
  });

  it("always has a slug's shape, and Control's own routes never do", () => {
    for (const slug of [
      slugForIdentity({ name: 'boxwood', suffix: '367a' }),
      slugForAccountPrinter({ id: 'ffff', name: '' }),
      slugForAddress('', 'http://[::1]:7125'),
      slugForAddress('a very long printer name that goes on and on and on forever', 'http://x'),
    ]) {
      assert.equal(isPrinterSlug(slug as string), true, String(slug));
    }
    for (const route of ['jobs', 'console', 'link', 'join', 'setup', 'sign-in', 'fleet', 'welcome', 'settings', 'slicer', 'icons']) {
      assert.equal(isPrinterSlug(route), false, route);
    }
  });

  it('keeps the suffix, which a rename never changes', () => {
    assert.equal(slugSuffix('workshop-one-367a'), '367a');
    assert.equal(hash4('x').length, 4);
    assert.equal(hash4('x'), hash4('x'));
  });

  it("a printer's page in Control", () => {
    assert.equal(printerPath('boxwood-367a'), '/boxwood-367a');
    assert.equal(printerPath('boxwood-367a', '/jobs/'), '/boxwood-367a/jobs');
  });
});

describe('printer names', () => {
  it('splits a Muon3D name from its serial suffix; a typed name stays as typed', () => {
    assert.deepEqual(printerNameParts('muon-boxwood-367a'), { name: 'Boxwood', suffix: '367A' });
    assert.deepEqual(printerNameParts('boxwood-367a'), { name: 'Boxwood', suffix: '367A' });
    assert.deepEqual(printerNameParts('Boxwood · 367A'), { name: 'Boxwood', suffix: '367A' });
    assert.deepEqual(printerNameParts('muon-workshop-one-8987'), { name: 'Workshop One', suffix: '8987' });
    assert.deepEqual(printerNameParts('  My Voron  '), { name: 'My Voron', suffix: null });
    assert.deepEqual(printerNameParts('Boxwood-367A'), { name: 'Boxwood-367A', suffix: null }, 'an address is lower case');
  });
});
