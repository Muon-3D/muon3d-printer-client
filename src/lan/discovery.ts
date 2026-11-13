// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Muon 3D Technologies Limited
// Adapted from Muon3D Fluidd (src/services/muon-cloud/discovery.ts), written by Muon 3D.
//
// Reaching Muon3D printers on the network this browser is on, one address at a time: every M1 answers
// `GET /server/muon/identity` on port 80. There is no sweep here: a client asks the addresses it has (the account
// service's `local_addrs` for a printer, a saved address, what the person typed).
//
// A page served over HTTPS may use plain HTTP and WebSockets on the local network only in Chromium, and only after the
// person allows "look for devices on your local network": Chrome asks once, at the first local request. lanFetch
// declares such a request local (`targetAddressSpace: 'local'`), which Chromium's Local Network Access wants first, and
// localNetworkPermission reads the permission's state. Other browsers block those requests as mixed content.
//
// Everything that touches the browser (fetch, the page's location, timers, the clock, the Permissions API) comes from
// a LanEnv, the browser's own by default, so it can be tested.
import type { FoundPrinter } from '../printers/directory.ts';
import type { PrinterHealth } from '../printers/status.ts';

/** What these functions use of the browser. Any part left out is the browser's own. */
export interface LanEnv {
  fetch(url: string, init?: RequestInit): Promise<Response>;
  location: { protocol: string; hostname: string; origin: string };
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /** A monotonic clock in ms (performance.now). */
  now(): number;
  permissions: { query(descriptor: { name: string }): Promise<{ state: string }> } | null;
}

interface BrowserGlobals {
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  location?: { protocol: string; hostname: string; origin: string };
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  performance?: { now(): number };
  navigator?: { permissions?: LanEnv['permissions'] };
}

/** The browser's own parts, with `over`'s in their place. */
export function lanEnv(over: Partial<LanEnv> = {}): LanEnv {
  const g = globalThis as unknown as BrowserGlobals;
  return {
    fetch: over.fetch ?? ((url, init) => (g.fetch as NonNullable<BrowserGlobals['fetch']>)(url, init)),
    location: over.location ?? g.location ?? { protocol: '', hostname: '', origin: '' },
    setTimeout: over.setTimeout ?? ((callback, ms) => g.setTimeout(callback, ms)),
    clearTimeout: over.clearTimeout ?? ((handle) => g.clearTimeout(handle)),
    now: over.now ?? (() => (g.performance ? g.performance.now() : Date.now())),
    permissions: over.permissions !== undefined ? over.permissions : (g.navigator?.permissions ?? null),
  };
}

/** How long a probe of one address waits. */
export const PROBE_TIMEOUT_MS = 3000;
/** How long a probe of an address someone typed waits. */
export const ADDRESS_TIMEOUT_MS = 8000;

/**
 * `fetch` for an address on the local network. On an HTTPS page it declares the request local, which Chromium's Local
 * Network Access needs before it lets the request through.
 */
export function lanFetch(url: string, init: RequestInit = {}, env?: Partial<LanEnv>): Promise<Response> {
  const e = lanEnv(env);
  const local = e.location.protocol === 'https:' ? { targetAddressSpace: 'local' } : {};
  return e.fetch(url, { ...init, ...local } as RequestInit);
}

/** An HTTP answer that did not succeed, with its status. */
class HttpStatusError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`HTTP ${status}`);
    this.name = 'HttpStatusError';
    this.status = status;
  }
}

/** GET `url` as JSON within `timeoutMs`: Moonraker's `result`, or the body. Rejects on a failed status (HttpStatusError). */
async function getJson(url: string, timeoutMs: number, env: LanEnv): Promise<unknown> {
  const controller = new AbortController();
  const timer = env.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await lanFetch(url, { signal: controller.signal, cache: 'no-store' }, env);
    if (!response.ok) throw new HttpStatusError(response.status);
    const body = (await response.json()) as unknown;
    const result = record(body)?.result;
    return result ?? body;
  } finally {
    env.clearTimeout(timer);
  }
}

const record = (value: unknown): Record<string, unknown> | null => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null);

/** A printer's address for its API: `http://<host>`. */
export function apiUrlFor(host: string): string {
  return `http://${host}`;
}

/**
 * A printer's state as read over the network:
 * - `ready`, `printing`, `paused`: Klipper is running.
 * - `error`: Klipper is shut down, in error or still starting, or the last print stopped with an error.
 * - `locked`: it answered, but wants a sign-in or refused this browser.
 */
export interface LanHealth {
  state: 'ready' | 'printing' | 'paused' | 'error' | 'locked';
  message?: string;
  checkedAt: number;
}

/** A LanHealth as a PrinterHealth (not read: `available`). */
export function healthOfLan(health: LanHealth | null | undefined): PrinterHealth {
  if (!health) return 'available';
  return health.state === 'ready' ? 'online' : health.state;
}

/** A Muon3D printer that answered at an address. */
export interface LanPrinter {
  /** The address it answered on. */
  host: string;
  /** What a client connects to for it: `http://<host>`. */
  url: string;
  /** "Boxwood · 367A". */
  name: string;
  /** The EndpointId it publishes, or null from older software. A match key, not proof: the relay's handshake is. */
  endpointId: string | null;
  /** Its own `.local` name, worked out from what it reports (mdnsHostFor). */
  mdnsHost: string | null;
  /** How it answered the health check, or undefined when nothing did. */
  health?: LanHealth;
}

/** A printer that answered, as the printer directory's FoundPrinter (with every address it answered on, when known). */
export function foundPrinterOf(printer: LanPrinter, aliases?: readonly string[]): FoundPrinter {
  return {
    host: printer.host,
    aliases: aliases?.length ? aliases : [printer.host],
    url: printer.url,
    name: printer.name,
    endpointId: printer.endpointId,
    mdnsHost: printer.mdnsHost,
    health: healthOfLan(printer.health),
  };
}

/**
 * A printer's own `.local` name from the parts `/server/muon/identity` reports. The hostname is
 * `Muon-<name>-<suffix>`, built from the serial by the same rule as its name, so it stays put when the owner renames
 * the printer: `derived_name` is the serial's name, not the owner's.
 */
export function mdnsHostFor(identity: unknown): string | null {
  const i = record(identity);
  const name = typeof i?.derived_name === 'string' ? i.derived_name.trim().toLowerCase() : '';
  const suffix = typeof i?.suffix === 'string' ? i.suffix.trim().toLowerCase() : '';
  if (!/^[a-z]+$/.test(name) || !/^[0-9a-z]+$/.test(suffix)) return null;
  return `muon-${name}-${suffix}.local`;
}

/**
 * Reads Klipper's state through the printer's Moonraker. Null means nothing answered. A printer that answers 401 or
 * 403 is there but `locked`: it wants a password, or its access rules refuse this browser. Moonraker answers 503
 * while Klippy has not connected: `error`.
 */
export async function printerHealth(apiUrl: string, options: { timeoutMs?: number; env?: Partial<LanEnv> } = {}): Promise<LanHealth | null> {
  const env = lanEnv(options.env);
  const checkedAt = Date.now();
  try {
    const result = record(await getJson(`${apiUrl}/printer/objects/query?webhooks&print_stats`, options.timeoutMs ?? PROBE_TIMEOUT_MS, env));
    const status = record(result?.status);
    const webhooks = record(status?.webhooks) ?? {};
    const job = record(status?.print_stats)?.state;
    if (webhooks.state !== 'ready') {
      const message = typeof webhooks.state_message === 'string' && webhooks.state_message ? webhooks.state_message : `Klipper ${typeof webhooks.state === 'string' ? webhooks.state : 'not running'}`;
      return { state: 'error', message, checkedAt };
    }
    if (job === 'printing') return { state: 'printing', checkedAt };
    if (job === 'paused') return { state: 'paused', checkedAt };
    if (job === 'error') return { state: 'error', message: 'The last print stopped with an error', checkedAt };
    return { state: 'ready', checkedAt };
  } catch (error) {
    const status = error instanceof HttpStatusError ? error.status : null;
    if (status === 401 || status === 403) return { state: 'locked', checkedAt };
    if (status !== null && status >= 500 && status <= 599) return { state: 'error', message: 'Klipper is not running', checkedAt };
    return null;
  }
}

/** Asks one address whether it is a Muon3D printer, and how it is: null when it is not one, or nothing answered. */
export async function probe(host: string, options: { timeoutMs?: number; env?: Partial<LanEnv> } = {}): Promise<LanPrinter | null> {
  const env = lanEnv(options.env);
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const url = apiUrlFor(host);
  let identity: Record<string, unknown> | null;
  try {
    identity = record(await getJson(`${url}/server/muon/identity`, timeoutMs, env));
  } catch {
    return null;
  }
  if (!identity) return null;
  const display = typeof identity.display === 'string' && identity.display ? identity.display : typeof identity.name === 'string' && identity.name ? identity.name : host;
  const endpointId = typeof identity.endpoint_id === 'string' && identity.endpoint_id ? identity.endpoint_id : null;
  const health = await printerHealth(url, { timeoutMs, env });
  return { host, url, name: display, endpointId, mdnsHost: mdnsHostFor(identity), ...(health ? { health } : {}) };
}

/**
 * What a person types into the address box: an IP address, a name such as `muon-boxwood-367a`, the same with
 * `.local`, or a full URL. A bare name is tried as typed, then with `.local`, because the printer always answers mDNS
 * but only some routers know its name.
 */
export function addressCandidates(input: string): string[] {
  const host = input
    .trim()
    .replace(/^[a-z]+:\/\//i, '')
    .replace(/\/.*$/, '');
  if (!host) return [];
  const bare = !host.includes('.') && !host.includes(':') && host.toLowerCase() !== 'localhost';
  return bare ? [host, `${host}.local`] : [host];
}

/** The printer behind what someone typed: the first candidate that answers as a Muon3D printer. */
export async function probeAddress(input: string, options: { timeoutMs?: number; env?: Partial<LanEnv> } = {}): Promise<LanPrinter | null> {
  for (const host of addressCandidates(input)) {
    const printer = await probe(host, { timeoutMs: options.timeoutMs ?? ADDRESS_TIMEOUT_MS, env: options.env });
    if (printer) return printer;
  }
  return null;
}

/**
 * Whether this page may talk to the printer at `apiUrl` at all. A page served over HTTPS asking a plain-HTTP printer
 * is mixed content: Chromium lets it through once the person allows local network access; other browsers, and a
 * refused prompt, block it before it leaves the machine. Asking first lets a client leave a blocked printer alone
 * instead of saving an address that never loads. Any HTTP answer, even an error status, means the page can reach it.
 */
export async function pageCanReach(apiUrl: string, options: { timeoutMs?: number; env?: Partial<LanEnv> } = {}): Promise<boolean> {
  const env = lanEnv(options.env);
  if (env.location.protocol !== 'https:' || !apiUrl.startsWith('http:')) return true;
  const controller = new AbortController();
  const timer = env.setTimeout(() => controller.abort(), options.timeoutMs ?? PROBE_TIMEOUT_MS);
  try {
    await lanFetch(`${apiUrl.replace(/\/+$/, '')}/server/info`, { mode: 'no-cors', signal: controller.signal, cache: 'no-store' }, env);
    return true;
  } catch {
    return false;
  } finally {
    env.clearTimeout(timer);
  }
}

/** The subnet an M1's own hotspot hands out. */
const OWN_HOTSPOT = /^10\.42\.0\.\d+$/;

/**
 * The address to open a printer the account service found nearby at. The printer reports every private IPv4 address
 * it holds, sorted, and while its hotspot is up that includes 10.42.0.1, which sorts first and which nobody on the
 * owner's network can reach. That address is the answer only when it is the only one.
 */
export function nearbyHost(localAddrs: readonly string[]): string | null {
  return localAddrs.find((a) => !OWN_HOTSPOT.test(a)) ?? localAddrs[0] ?? null;
}

const isIpv4 = (host: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(host);

/**
 * Whether this page was opened by a name (`muon-boxwood-367a.local`) over plain HTTP. That name can resolve to the
 * printer's global IPv6 address, and Chrome then treats the page as public and refuses, before anything is sent, every
 * request it makes to a private IPv4 address, such as another printer's. Reaching the other printer by its own
 * `.local` name still works: public to public.
 */
export function pageOpenedByName(loc: { protocol: string; hostname: string }): boolean {
  if (loc.protocol !== 'http:') return false;
  const host = loc.hostname;
  return !isIpv4(host) && !host.includes(':') && !host.startsWith('[') && host !== 'localhost';
}

/** A request the browser refused this fast was never sent. */
const REFUSED_WITHIN_MS = 250;

/** The page's own printer's private IPv4 address, from its Moonraker (not its hotspot's, when it has another). */
async function ownIpv4(env: LanEnv): Promise<string | null> {
  try {
    const info = record(await getJson(`${env.location.origin}/machine/system_info`, 2500, env));
    const network = record(record(info?.system_info)?.network) ?? {};
    const addresses: string[] = [];
    for (const iface of Object.values(network)) {
      const list = record(iface)?.ip_addresses;
      for (const a of Array.isArray(list) ? list : []) {
        const entry = record(a);
        if (entry?.family === 'ipv4' && !entry.is_link_local && typeof entry.address === 'string') addresses.push(entry.address);
      }
    }
    return addresses.find((a) => !OWN_HOTSPOT.test(a)) ?? addresses[0] ?? null;
  } catch {
    return null;
  }
}

/** Whether this browser refuses the page every request to a private IPv4 address, and the way round it. */
export interface LanIpv4Block {
  blocked: boolean;
  /** The page's own printer at its IPv4 address, which the person can open instead; null when not blocked. */
  ownUrl: string | null;
}

/**
 * Whether this browser refuses this page every request to a private IPv4 address (see pageOpenedByName). Asked of the
 * one printer certain to be there: the one that served the page, at its own IPv4 address. A refusal within 250 ms was
 * never sent (measured in Chrome: refused in a few ms, while the same printer answered by name).
 */
export async function lanIpv4Block(env?: Partial<LanEnv>): Promise<LanIpv4Block> {
  const e = lanEnv(env);
  if (!pageOpenedByName(e.location)) return { blocked: false, ownUrl: null };
  const ip = await ownIpv4(e);
  if (!ip) return { blocked: false, ownUrl: null };
  const started = e.now();
  try {
    await getJson(`http://${ip}/server/muon/identity`, 2500, e);
    return { blocked: false, ownUrl: null };
  } catch (error) {
    const blocked = error instanceof TypeError && e.now() - started < REFUSED_WITHIN_MS;
    return { blocked, ownUrl: blocked ? `http://${ip}/` : null };
  }
}

let blockCheck: Promise<LanIpv4Block> | null = null;

/** lanIpv4Block, asked once per page: whether this page may not reach printers by IPv4 address. */
export async function pageBlocksLanIpv4(env?: Partial<LanEnv>): Promise<boolean> {
  blockCheck ??= lanIpv4Block(env);
  return (await blockCheck).blocked;
}

/** Forgets pageBlocksLanIpv4's answer (the tests; a page that changed its address). */
export function resetPageBlockCheck(): void {
  blockCheck = null;
}

/**
 * The state of the browser's local network permission for this page: `granted`, `denied` (the person refused Chrome's
 * prompt, or a policy blocks it) or `prompt` (Chrome will ask at the first local request); `unknown` where the browser
 * has no such permission (every browser but Chromium) or will not say.
 */
export async function localNetworkPermission(env?: Partial<LanEnv>): Promise<'granted' | 'denied' | 'prompt' | 'unknown'> {
  const permissions = lanEnv(env).permissions;
  if (!permissions || typeof permissions.query !== 'function') return 'unknown';
  try {
    const status = await permissions.query({ name: 'local-network-access' });
    return status.state === 'granted' || status.state === 'denied' || status.state === 'prompt' ? status.state : 'unknown';
  } catch {
    return 'unknown';
  }
}
