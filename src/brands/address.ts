// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Muon 3D Technologies Limited
// Which addresses a page may ask for a printer: only the local network's. A person types an address; anything that is
// not one of these is refused before a request is made, so a page that lets its policy reach plain HTTP for printers
// (an IP address cannot be named in a Content-Security-Policy) still sends nothing to the internet through this path:
//
// - IPv4: 10/8, 172.16/12, 192.168/16 (the private ranges), 169.254/16 (link-local) and 127/8 (this machine);
// - IPv6: fc00::/7 (unique local), fe80::/10 (link-local) and ::1;
// - names: `localhost`, a single label (`octopi`, which the home network's own resolver answers), and the suffixes
//   homes use: `.local` (mDNS), `.lan`, `.home`, `.home.arpa` and `.internal`.
//
// An HTTPS page needs more than this: the browser must let it reach the local network at all (Chromium, once the
// person allows it; lan/discovery.ts localNetworkPermission). That is the browser's check; this is the page's own.

/** An address on the local network, as a page connects to it. */
export interface LanAddress {
  /** The host: a name, an IPv4 address, or an IPv6 address in brackets. */
  host: string;
  /** The port typed, or null for the kind's own. */
  port: number | null;
}

const HOME_SUFFIXES = ['.local', '.lan', '.home', '.home.arpa', '.internal'];
const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

function privateIpv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b, c, d] = m.slice(1).map(Number);
  if ([a, b, c, d].some((n) => n > 255)) return false;
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

function localIpv6(host: string): boolean {
  const h = host.toLowerCase();
  if (!/^[0-9a-f:]+$/.test(h) || !h.includes(':')) return false;
  if (h === '::1') return true;
  const first = parseInt(h.split(':')[0] || '0', 16);
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
}

function localName(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (h === 'localhost') return true;
  const labels = h.split('.');
  if (!labels.every((l) => LABEL.test(l))) return false;
  if (labels.length === 1) return !/^\d+$/.test(h);
  return HOME_SUFFIXES.some((s) => h.endsWith(s) && h.length > s.length);
}

/**
 * What someone typed as a local-network address: `192.168.1.71`, `octopi.local:5000`, `http://voron.lan/`,
 * `[fe80::1]:7125`. Null for anything else: a public address, a domain on the internet, another scheme, a user name
 * or a path that is not just `/`.
 */
export function lanAddress(input: string): LanAddress | null {
  let text = input.trim();
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(text);
  if (scheme) {
    if (!/^(https?|wss?)$/i.test(scheme[1])) return null;
    text = text.slice(scheme[0].length);
  }
  text = text.replace(/\/+$/, '');
  if (!text || /[/?#@\s]/.test(text)) return null;
  let host: string;
  let portText: string | null = null;
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(text);
  if (bracketed) {
    if (!localIpv6(bracketed[1])) return null;
    host = `[${bracketed[1].toLowerCase()}]`;
    portText = bracketed[2] ?? null;
  } else {
    const colon = text.lastIndexOf(':');
    if (colon >= 0 && text.indexOf(':') === colon) {
      host = text.slice(0, colon);
      portText = text.slice(colon + 1);
      if (!/^\d+$/.test(portText)) return null;
    } else if (colon >= 0) {
      // A bare IPv6 address (no port can follow one without brackets).
      if (!localIpv6(text)) return null;
      return { host: `[${text.toLowerCase()}]`, port: null };
    } else host = text;
    host = host.toLowerCase();
    if (!privateIpv4(host) && !localName(host)) return null;
  }
  const port = portText === null ? null : Number(portText);
  if (port !== null && (port < 1 || port > 65535)) return null;
  return { host, port };
}

/** `host:port` for a URL, the port left out when it is the kind's own (or none was given). */
export function hostWithPort(address: LanAddress, ownPort: number | null = null): string {
  return address.port === null || address.port === ownPort ? address.host : `${address.host}:${address.port}`;
}

/** Whether a URL is one this page may ask for a printer (its host passes lanAddress). */
export function isLanUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (!/^(http|ws):$/.test(u.protocol) || u.username || u.password) return false;
    return lanAddress(u.host) !== null;
  } catch {
    return false;
  }
}

/**
 * Whether this browser lets a page served from `pageProtocol` reach printers on the local network at all. Over plain
 * HTTP every browser does. Over HTTPS only Chromium does, after its local network prompt; Firefox and Safari block a
 * plain-HTTP printer as mixed content before anything is sent.
 */
export function browserReachesLan(pageProtocol: string, userAgent: string): boolean {
  if (pageProtocol !== 'https:') return true;
  if (/Firefox\/|FxiOS\//.test(userAgent)) return false;
  // Every browser on iOS is WebKit underneath, Chrome's included.
  if (/iPhone|iPad|iPod/.test(userAgent)) return false;
  return /(Chrome|Chromium|Edg|OPR)\//.test(userAgent);
}
