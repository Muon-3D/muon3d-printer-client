// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Muon 3D Technologies Limited
// Adapted from Muon3D Fluidd (src/services/muon-cloud/__tests__/page-blocks-lan.spec.ts and src/util/__tests__/page-blocks-printer.spec.ts), written by Muon 3D.
// The local network (discovery.ts, page.ts) against a fake browser: a request declared local on an https page, a
// printer's identity and health read as Control reads them, what someone typed, whether the page may reach the
// printer at all, a page that may not reach IPv4 addresses, and the local network permission's state.
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { healthOfMoonraker } from '../printers/status.ts';
import {
  addressCandidates,
  foundPrinterOf,
  healthOfLan,
  lanFetch,
  lanIpv4Block,
  localNetworkPermission,
  mdnsHostFor,
  nearbyHost,
  pageBlocksLanIpv4,
  pageCanReach,
  pageOpenedByName,
  printerHealth,
  probe,
  probeAddress,
  resetPageBlockCheck,
  type LanEnv,
} from './discovery.ts';
import { escapeHtml, pageBlocksPrinter, printerPageUrl } from './page.ts';

const HTTPS_PAGE = { protocol: 'https:', hostname: 'control.muon3d.com', origin: 'https://control.muon3d.com' };
const HTTP_PAGE = { protocol: 'http:', hostname: '192.168.1.20', origin: 'http://192.168.1.20' };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const IDENTITY = { result: { display: 'Boxwood · 367A', name: 'boxwood', derived_name: 'boxwood', suffix: '367A', endpoint_id: 'f1f6920f'.repeat(8) } };
const objects = (webhooks: Record<string, unknown>, printStats: Record<string, unknown> = { state: 'standby' }) => ({ result: { status: { webhooks, print_stats: printStats } } });

type Route = (url: string, init: RequestInit) => Response | Promise<Response>;

/** A browser whose fetch answers by URL (anything else fails as the network does), with a clock the routes can move. */
function browser(routes: Record<string, Route>, location = HTTP_PAGE) {
  const asked: { url: string; init: RequestInit }[] = [];
  let clock = 0;
  const env: Partial<LanEnv> = {
    location,
    now: () => clock,
    fetch: async (url, init = {}) => {
      asked.push({ url, init });
      const route = routes[url];
      if (!route) throw new TypeError('Failed to fetch');
      return route(url, init);
    },
  };
  return { env, asked, advance: (ms: number) => (clock += ms) };
}

describe('lanFetch', () => {
  it('declares the request local on an https page only', async () => {
    const https = browser({ 'http://10.0.0.5/x': () => json({}) }, HTTPS_PAGE);
    await lanFetch('http://10.0.0.5/x', { method: 'POST' }, https.env);
    assert.deepEqual(https.asked[0].init, { method: 'POST', targetAddressSpace: 'local' });
    const http = browser({ 'http://10.0.0.5/x': () => json({}) });
    await lanFetch('http://10.0.0.5/x', {}, http.env);
    assert.deepEqual(http.asked[0].init, {});
  });
});

describe('printerHealth', () => {
  const at = (answer: Route) => browser({ 'http://10.0.0.5/printer/objects/query?webhooks&print_stats': answer }).env;

  it("reads Klipper's state and the print's", async () => {
    assert.equal((await printerHealth('http://10.0.0.5', { env: at(() => json(objects({ state: 'ready' }))) }))?.state, 'ready');
    assert.equal((await printerHealth('http://10.0.0.5', { env: at(() => json(objects({ state: 'ready' }, { state: 'printing' }))) }))?.state, 'printing');
    assert.equal((await printerHealth('http://10.0.0.5', { env: at(() => json(objects({ state: 'ready' }, { state: 'paused' }))) }))?.state, 'paused');
    const failed = await printerHealth('http://10.0.0.5', { env: at(() => json(objects({ state: 'ready' }, { state: 'error' }))) });
    assert.deepEqual([failed?.state, failed?.message], ['error', 'The last print stopped with an error']);
    const shutdown = await printerHealth('http://10.0.0.5', { env: at(() => json(objects({ state: 'shutdown', state_message: 'MCU lost' }))) });
    assert.deepEqual([shutdown?.state, shutdown?.message], ['error', 'MCU lost']);
    const none = await printerHealth('http://10.0.0.5', { env: at(() => json({ result: { status: {} } })) });
    assert.deepEqual([none?.state, none?.message], ['error', 'Klipper not running']);
  });

  it('401 or 403 is locked, a 5xx Klipper not running, and no answer or another status nothing', async () => {
    assert.equal((await printerHealth('http://10.0.0.5', { env: at(() => json({}, 401)) }))?.state, 'locked');
    assert.equal((await printerHealth('http://10.0.0.5', { env: at(() => json({}, 403)) }))?.state, 'locked');
    const starting = await printerHealth('http://10.0.0.5', { env: at(() => json({}, 503)) });
    assert.deepEqual([starting?.state, starting?.message], ['error', 'Klipper is not running']);
    assert.equal(await printerHealth('http://10.0.0.5', { env: at(() => json({}, 404)) }), null);
    assert.equal(await printerHealth('http://10.0.0.6', { env: at(() => json({})) }), null);
  });

  it('gives up after its limit', async () => {
    const env = at((_url, init) => new Promise<Response>((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))));
    assert.equal(await printerHealth('http://10.0.0.5', { timeoutMs: 5, env }), null);
  });

  it('agrees with healthOfMoonraker, so the network and the relay say the same', () => {
    const cases: [Parameters<typeof healthOfMoonraker>[0], Parameters<typeof healthOfLan>[0]][] = [
      [{ connected: true, klippyState: 'ready', printState: 'standby' }, { state: 'ready', checkedAt: 0 }],
      [{ connected: true, klippyState: 'ready', printState: 'printing' }, { state: 'printing', checkedAt: 0 }],
      [{ connected: true, klippyState: 'ready', printState: 'paused' }, { state: 'paused', checkedAt: 0 }],
      [{ connected: true, klippyState: 'ready', printState: 'error' }, { state: 'error', checkedAt: 0 }],
      [{ connected: true, klippyState: 'shutdown' }, { state: 'error', checkedAt: 0 }],
      [{ connected: true, httpStatus: 401 }, { state: 'locked', checkedAt: 0 }],
      [{ connected: true, httpStatus: 503 }, { state: 'error', checkedAt: 0 }],
    ];
    for (const [reading, lan] of cases) assert.equal(healthOfMoonraker(reading), healthOfLan(lan), JSON.stringify(reading));
    assert.equal(healthOfLan(null), 'available');
  });
});

describe('probe', () => {
  it('reads the identity and the health; the EndpointId and the .local name come from the identity', async () => {
    const { env } = browser({
      'http://10.0.0.5/server/muon/identity': () => json(IDENTITY),
      'http://10.0.0.5/printer/objects/query?webhooks&print_stats': () => json(objects({ state: 'ready' })),
    });
    const printer = await probe('10.0.0.5', { env });
    assert.deepEqual(printer && { ...printer, health: printer.health?.state }, {
      host: '10.0.0.5',
      url: 'http://10.0.0.5',
      name: 'Boxwood · 367A',
      endpointId: 'f1f6920f'.repeat(8),
      mdnsHost: 'muon-boxwood-367a.local',
      health: 'ready',
    });
    assert.deepEqual(foundPrinterOf(printer!), {
      host: '10.0.0.5',
      aliases: ['10.0.0.5'],
      url: 'http://10.0.0.5',
      name: 'Boxwood · 367A',
      endpointId: 'f1f6920f'.repeat(8),
      mdnsHost: 'muon-boxwood-367a.local',
      health: 'online',
    });
  });

  it('is null for an address that is not a Muon3D printer, and keeps a printer whose health did not answer', async () => {
    assert.equal(await probe('10.0.0.9', { env: browser({}).env }), null);
    assert.equal(await probe('10.0.0.9', { env: browser({ 'http://10.0.0.9/server/muon/identity': () => json({}, 404) }).env }), null);
    const { env } = browser({ 'http://10.0.0.5/server/muon/identity': () => json({ result: { name: 'oak' } }) });
    const printer = await probe('10.0.0.5', { env });
    assert.deepEqual(printer, { host: '10.0.0.5', url: 'http://10.0.0.5', name: 'oak', endpointId: null, mdnsHost: null });
  });

  it('tries what someone typed as typed, then with .local', async () => {
    assert.deepEqual(addressCandidates('muon-boxwood-367a'), ['muon-boxwood-367a', 'muon-boxwood-367a.local']);
    assert.deepEqual(addressCandidates(' http://192.168.1.5/fluidd '), ['192.168.1.5']);
    assert.deepEqual(addressCandidates('localhost'), ['localhost']);
    assert.deepEqual(addressCandidates('[::1]:7125'), ['[::1]:7125']);
    assert.deepEqual(addressCandidates('  '), []);
    const { env, asked } = browser({ 'http://boxwood.local/server/muon/identity': () => json(IDENTITY) });
    const printer = await probeAddress('boxwood', { env });
    assert.equal(printer?.host, 'boxwood.local');
    assert.deepEqual(asked.map((a) => a.url).slice(0, 2), ['http://boxwood/server/muon/identity', 'http://boxwood.local/server/muon/identity']);
  });

  it("builds the .local name from the serial's name and suffix, never from a rename", () => {
    assert.equal(mdnsHostFor({ name: 'Workshop', derived_name: 'boxwood', suffix: '367A' }), 'muon-boxwood-367a.local');
    assert.equal(mdnsHostFor({ derived_name: 'boxwood' }), null);
    assert.equal(mdnsHostFor({ derived_name: 'box wood', suffix: '367a' }), null);
    assert.equal(mdnsHostFor(null), null);
  });

  it("opens a nearby printer at an address on the owner's network, not its own hotspot's", () => {
    assert.equal(nearbyHost(['10.42.0.1', '192.168.1.20']), '192.168.1.20');
    assert.equal(nearbyHost(['10.42.0.1']), '10.42.0.1');
    assert.equal(nearbyHost([]), null);
  });
});

describe('whether the page may reach a printer', () => {
  it('a plain-http page, or an https printer, may; an https page asks once, with no-cors, and any answer will do', async () => {
    assert.equal(await pageCanReach('http://10.0.0.5', { env: browser({}).env }), true);
    assert.equal(await pageCanReach('https://printer.example', { env: browser({}, HTTPS_PAGE).env }), true);
    const reachable = browser({ 'http://10.0.0.5/server/info': () => new Response(null, { status: 401 }) }, HTTPS_PAGE);
    assert.equal(await pageCanReach('http://10.0.0.5/', { env: reachable.env }), true);
    assert.deepEqual([reachable.asked[0].init.mode, (reachable.asked[0].init as { targetAddressSpace?: string }).targetAddressSpace], ['no-cors', 'local']);
    assert.equal(await pageCanReach('http://10.0.0.6', { env: browser({}, HTTPS_PAGE).env }), false);
  });

  it('says when the browser, not the printer, is in the way, and offers the printer\'s own page', () => {
    assert.equal(pageBlocksPrinter('http://192.168.1.153', 'https:'), true);
    assert.equal(pageBlocksPrinter('http://192.168.1.153', 'http:'), false);
    assert.equal(pageBlocksPrinter('https://printer.example', 'https:'), false);
    assert.equal(printerPageUrl('http://192.168.1.153//'), 'http://192.168.1.153/');
    assert.equal(escapeHtml('http://x/"><img src=x onerror=alert(1)>'), 'http://x/&quot;&gt;&lt;img src=x onerror=alert(1)&gt;');
    assert.equal(escapeHtml("it's"), 'it&#39;s');
  });
});

describe('a page that may not reach IPv4 addresses', () => {
  const BY_NAME = { protocol: 'http:', hostname: 'muon-boxwood-367a.local', origin: 'http://muon-boxwood-367a.local' };
  const SYSTEM_INFO = {
    result: {
      system_info: {
        network: {
          ap0: { ip_addresses: [{ family: 'ipv4', address: '10.42.0.1', is_link_local: false }] },
          wlan0: {
            ip_addresses: [
              { family: 'ipv6', address: '2a0d:3344:5920:fd0d::4', is_link_local: false },
              { family: 'ipv4', address: '192.168.1.20', is_link_local: false },
            ],
          },
        },
      },
    },
  };
  const page = (ipv4: (b: { advance: (ms: number) => number }) => Promise<Response>) => {
    const b: ReturnType<typeof browser> = browser(
      {
        'http://muon-boxwood-367a.local/machine/system_info': () => json(SYSTEM_INFO),
        'http://192.168.1.20/server/muon/identity': () => ipv4(b),
      },
      BY_NAME,
    );
    return b;
  };

  beforeEach(() => resetPageBlockCheck());

  it('is a plain-http page opened by a name; not one opened by an address, over https, or on this computer', () => {
    assert.equal(pageOpenedByName({ protocol: 'http:', hostname: 'muon-boxwood-367a.local' }), true);
    assert.equal(pageOpenedByName({ protocol: 'http:', hostname: '192.168.1.20' }), false);
    assert.equal(pageOpenedByName({ protocol: 'http:', hostname: '[2a0d:3344:5920:fd0d::4]' }), false);
    assert.equal(pageOpenedByName({ protocol: 'https:', hostname: 'control.muon3d.com' }), false);
    assert.equal(pageOpenedByName({ protocol: 'http:', hostname: 'localhost' }), false);
  });

  it("is blocked when the browser refuses the page's own printer by IP at once, with that printer's own page as the way round", async () => {
    const b = page(async () => {
      throw new TypeError('Failed to fetch');
    });
    assert.deepEqual(await lanIpv4Block(b.env), { blocked: true, ownUrl: 'http://192.168.1.20/' });
  });

  it('is not blocked when the printer answers by IP, or when the failure took the network\'s time', async () => {
    assert.deepEqual(await lanIpv4Block(page(async () => json(IDENTITY)).env), { blocked: false, ownUrl: null });
    const slow = page(async (b) => {
      b.advance(2000);
      throw new TypeError('Failed to fetch');
    });
    assert.deepEqual(await lanIpv4Block(slow.env), { blocked: false, ownUrl: null });
    assert.deepEqual(await lanIpv4Block(browser({}).env), { blocked: false, ownUrl: null }, 'opened by an address');
  });

  it('is asked once per page', async () => {
    const b = page(async () => {
      throw new TypeError('Failed to fetch');
    });
    assert.equal(await pageBlocksLanIpv4(b.env), true);
    assert.equal(await pageBlocksLanIpv4(b.env), true);
    assert.equal(b.asked.length, 2);
  });
});

describe('localNetworkPermission', () => {
  const asking = (answer: () => Promise<{ state: string }>) => ({ permissions: { query: answer } });

  it("reads the permission's state", async () => {
    for (const state of ['granted', 'denied', 'prompt'] as const) assert.equal(await localNetworkPermission(asking(async () => ({ state }))), state);
  });

  it('is unknown where the browser has no such permission, or will not say', async () => {
    assert.equal(await localNetworkPermission({ permissions: null }), 'unknown');
    assert.equal(
      await localNetworkPermission(
        asking(async () => {
          throw new TypeError("The provided value 'local-network-access' is not a valid enum value of type PermissionName.");
        }),
      ),
      'unknown',
    );
    assert.equal(await localNetworkPermission(asking(async () => ({ state: 'something-new' }))), 'unknown');
  });

  it('asks for local-network-access', async () => {
    const names: string[] = [];
    await localNetworkPermission({
      permissions: {
        query: async (d) => {
          names.push(d.name);
          return { state: 'granted' };
        },
      },
    });
    assert.deepEqual(names, ['local-network-access']);
  });
});
