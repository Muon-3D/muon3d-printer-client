// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Muon 3D Technologies Limited
// Which addresses a page may ask for a printer (address.ts): the local network's, and nothing else.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { browserReachesLan, hostWithPort, isLanUrl, lanAddress } from './address.ts';

describe('a local-network address', () => {
  it('takes private, link-local and loopback IPv4, with a port', () => {
    assert.deepEqual(lanAddress('192.168.1.71'), { host: '192.168.1.71', port: null });
    assert.deepEqual(lanAddress(' http://10.0.0.5:5000/ '), { host: '10.0.0.5', port: 5000 });
    for (const ok of ['172.16.0.1', '172.31.255.254', '169.254.10.1', '127.0.0.1:7125']) assert.ok(lanAddress(ok), ok);
  });

  it('takes local IPv6 in brackets, or bare', () => {
    assert.deepEqual(lanAddress('[fe80::1]:7125'), { host: '[fe80::1]', port: 7125 });
    assert.deepEqual(lanAddress('fd12:3456::9'), { host: '[fd12:3456::9]', port: null });
    assert.deepEqual(lanAddress('[::1]'), { host: '[::1]', port: null });
  });

  it("takes the names homes use: .local, .lan, .home, .home.arpa, .internal, a single label, localhost", () => {
    for (const ok of ['voron.local', 'OctoPi.local:80', 'printer.lan', 'k1.home', 'k1.home.arpa', 'mk4.internal', 'octopi', 'localhost:8080']) assert.ok(lanAddress(ok), ok);
    assert.equal(lanAddress('OctoPi.Local')?.host, 'octopi.local');
  });

  it('refuses the internet: public addresses, domains, other schemes, user names and paths', () => {
    for (const bad of [
      '8.8.8.8',
      '172.32.0.1',
      '100.64.0.1',
      '192.169.1.1',
      '256.1.1.1',
      '[2001:db8::1]',
      '2606:4700::1111',
      'example.com',
      'printer.example.com',
      'evil.local.example.com',
      'https://slicer.example/',
      'ftp://192.168.1.2',
      'user@192.168.1.2',
      '192.168.1.2/admin',
      '192.168.1.2?x=1',
      '.local',
      '1234',
      '192.168.1.2:0',
      '192.168.1.2:70000',
      '',
    ]) assert.equal(lanAddress(bad), null, bad);
  });

  it('writes host:port, leaving out the kind’s own port', () => {
    assert.equal(hostWithPort({ host: 'voron.local', port: 7125 }), 'voron.local:7125');
    assert.equal(hostWithPort({ host: 'k1.local', port: 9999 }, 9999), 'k1.local');
    assert.equal(hostWithPort({ host: '[fe80::1]', port: null }), '[fe80::1]');
  });

  it('checks a URL: http or ws to a local host only, no credentials in it', () => {
    assert.ok(isLanUrl('http://192.168.1.71/server/info'));
    assert.ok(isLanUrl('ws://k1.local:9999'));
    assert.equal(isLanUrl('https://192.168.1.71/'), false);
    assert.equal(isLanUrl('http://8.8.8.8/'), false);
    assert.equal(isLanUrl('http://a:b@192.168.1.71/'), false);
    assert.equal(isLanUrl('not a url'), false);
  });
});

describe('whether the browser lets a page reach the local network', () => {
  const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
  const EDGE = `${CHROME} Edg/141.0.0.0`;
  const FIREFOX = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:143.0) Gecko/20100101 Firefox/143.0';
  const SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
  const IOS_CHROME = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0 Mobile/15E148 Safari/604.1';
  it('over HTTPS: Chromium only (not on iOS, where every browser is WebKit)', () => {
    assert.equal(browserReachesLan('https:', CHROME), true);
    assert.equal(browserReachesLan('https:', EDGE), true);
    for (const ua of [FIREFOX, SAFARI, IOS_CHROME]) assert.equal(browserReachesLan('https:', ua), false, ua);
  });
  it('over plain HTTP: every browser', () => {
    for (const ua of [CHROME, FIREFOX, SAFARI]) assert.equal(browserReachesLan('http:', ua), true);
  });
});
