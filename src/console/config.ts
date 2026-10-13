// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Muon 3D Technologies Limited
// A client's settings for the console and the relay, read strictly: the console's origin (https; plain http on this
// computer only when a development or test build asks for it), and the relay hosts the console may hand out (a
// relay_url outside the list is refused before anything binds to it).

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Whether a host name (as URL.hostname gives it) is this computer. */
export const isLoopbackHost = (host: string): boolean => LOOPBACK.has(host.toLowerCase());

/**
 * The console's origin from a setting, or null when it is not one: https, or http on this computer when
 * `loopbackHttp` (a development server, a test build). A URL with a path, a query, credentials or a fragment is refused.
 */
export function consoleOriginOf(value: unknown, { loopbackHttp = false }: { loopbackHttp?: boolean } = {}): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) return null;
  if (url.protocol === 'https:') return url.origin;
  if (url.protocol === 'http:' && loopbackHttp && isLoopbackHost(url.hostname)) return url.origin;
  return null;
}

/** A relay list entry's host (a host name, or an https origin), lower-cased; null when it is neither. */
function relayHostOf(entry: string): string | null {
  try {
    const url = new URL(entry.includes('://') ? entry : `https://${entry}`);
    if (url.protocol !== 'https:' || url.username || url.password || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) return null;
    return url.host.toLowerCase();
  } catch {
    return null;
  }
}

/** The relay hosts of a comma-separated list; entries that are not hosts are left out, repeats once. */
export function relayHostsOf(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  const hosts = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map(relayHostOf)
    .filter((host): host is string => host !== null);
  return [...new Set(hosts)];
}

/** Whether the console's relay_url may be bound to: https, on a listed host. */
export function relayUrlAllowed(relayUrl: unknown, hosts: readonly string[]): boolean {
  if (typeof relayUrl !== 'string') return false;
  try {
    const url = new URL(relayUrl);
    return url.protocol === 'https:' && !url.username && !url.password && hosts.includes(url.host.toLowerCase());
  } catch {
    return false;
  }
}
