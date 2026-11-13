// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Muon 3D Technologies Limited
// A client's settings for the console and the relay (config.ts): the console an https origin (http on this computer
// only when asked), the relays a list of hosts, and a relay_url bound to only when it is https on a listed host.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { consoleOriginOf, isLoopbackHost, relayHostsOf, relayUrlAllowed } from './config.ts';

describe('the console and relay settings', () => {
  it('the console is an https origin; http only on this computer, and only when asked', () => {
    assert.equal(consoleOriginOf('https://console.example/'), 'https://console.example');
    assert.equal(consoleOriginOf(' https://console.example '), 'https://console.example');
    assert.equal(consoleOriginOf('https://console.example/v1'), null);
    assert.equal(consoleOriginOf('https://console.example/?x=1'), null);
    assert.equal(consoleOriginOf('https://user:pw@console.example'), null);
    assert.equal(consoleOriginOf('http://console.example'), null);
    assert.equal(consoleOriginOf('http://127.0.0.1:9000'), null);
    assert.equal(consoleOriginOf('http://127.0.0.1:9000', { loopbackHttp: true }), 'http://127.0.0.1:9000');
    assert.equal(consoleOriginOf('http://203.0.113.5:9000', { loopbackHttp: true }), null);
    assert.equal(consoleOriginOf(42), null);
    assert.equal(consoleOriginOf('not a url'), null);
    assert.ok(isLoopbackHost('LOCALHOST') && isLoopbackHost('[::1]') && !isLoopbackHost('10.0.0.1'));
  });

  it('the relays are hosts; the console may hand out only an https relay on the list', () => {
    assert.deepEqual(relayHostsOf('relay.example, https://relay2.example ,ftp://x, relay.example'), ['relay.example', 'relay2.example']);
    assert.deepEqual(relayHostsOf(undefined), []);
    assert.equal(relayUrlAllowed('https://relay.example/', ['relay.example']), true);
    assert.equal(relayUrlAllowed('https://RELAY.example/', ['relay.example']), true);
    assert.equal(relayUrlAllowed('https://relay.invalid/?fake=abc', ['relay.invalid']), true);
    assert.equal(relayUrlAllowed('http://relay.example/', ['relay.example']), false);
    assert.equal(relayUrlAllowed('https://evil.example/', ['relay.example']), false);
    assert.equal(relayUrlAllowed('https://u:p@relay.example/', ['relay.example']), false);
    assert.equal(relayUrlAllowed(null, ['relay.example']), false);
  });
});
