// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Muon 3D Technologies Limited
// Adapted from Muon3D Fluidd (src/services/muon-cloud/directory.ts and src/services/muon-cloud/discovery.ts), written by Muon 3D.
//
// One entry per printer, however many ways it is seen, in three sections:
//
// - account: the printers the signed-in account has. The account keeps them, so they are listed whether or not this
//   browser can see them now. One that is also on this network carries what was found there.
// - saved: printers this browser keeps that are not in the account. A saved printer that turns out to be in the account
//   is listed under account only.
// - found: what is on this network, or near it, now, and in neither section.
//
// The join key is the printer's EndpointId: the account service names a printer by it, the printer publishes it at
// `/server/muon/identity`, and the Bluetooth advertisement starts with it. An address is the fallback for software
// that predates the field, and a name the last resort: a saved printer with no EndpointId whose address is gone is tied
// to a found one by its exact display name, serial suffix and all; an account printer is tied to a found one that
// published no EndpointId when one name contains the other.
import { tileOfHealth, type PrinterHealth, type TileContext, type TileState } from './status.ts';

/** A printer the account service lists. */
export interface AccountPrinter {
  /** Its EndpointId: the account service names a printer by it. */
  id: string;
  name: string;
  /** The account service's online flag. */
  online: boolean;
  /** Its health as read through the relay (accountHealth), when it was read. */
  health?: PrinterHealth;
}

/** A printer this browser keeps. */
export interface SavedPrinter {
  /** The address it was saved at: `http://192.168.1.37`, `http://muon-walnut-8987.local`. */
  url: string;
  /** The name it was given, if any. */
  name?: string | null;
  /** The EndpointId it published when it was saved, if it did. */
  endpointId?: string | null;
  /** Its own `.local` name, when known. */
  mdnsHost?: string | null;
  /** The page is connected through this address now. */
  active?: boolean;
  /** Its health as this page's own connection to it reads it, while there is one. */
  health?: PrinterHealth;
}

/** A printer found on this network (or by the account service near it). */
export interface FoundPrinter {
  /** The address it answered on last. */
  host: string;
  /** Every address it answered on: an IP, its name, its name with `.local`. `host` alone when absent. */
  aliases?: readonly string[];
  /** What a client connects to for it: `http://192.168.1.37`. */
  url: string;
  /** "Boxwood · 367A". */
  name: string;
  /** The EndpointId it publishes, or null from older software. A match key, not proof: the relay's handshake is. */
  endpointId: string | null;
  mdnsHost?: string | null;
  /** How it answered its health check, when it was asked. */
  health?: PrinterHealth;
}

export type DirectorySection = 'account' | 'saved' | 'found';

export interface DirectoryEntry {
  /** `account:<EndpointId>`, `saved:<url>` or `found:<EndpointId or url>`: stable while the printer is listed. */
  key: string;
  section: DirectorySection;
  name: string;
  endpointId: string | null;
  health: PrinterHealth;
  /** Its address on this network now, when it answered on one. */
  host: string | null;
  account?: AccountPrinter;
  /** Saved entries for this printer: more than one when it was saved at several addresses. */
  saved: SavedPrinter[];
  found?: FoundPrinter;
}

export interface Directory {
  account: DirectoryEntry[];
  saved: DirectoryEntry[];
  found: DirectoryEntry[];
}

export interface DirectorySources {
  account: readonly AccountPrinter[];
  saved: readonly SavedPrinter[];
  found: readonly FoundPrinter[];
  /** A search is still running, so a saved printer with no answer may yet answer. */
  searching?: boolean;
}

/** Letters and digits only, lower case: "Boxwood · 367A" and "Muon-boxwood-367a" both contain "boxwood367a". */
function nameKey(name: string | null | undefined): string {
  return (name ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Whether two names are the same printer's display name, letter for letter ("Boxwood · 367A" and "boxwood-367a").
 * The display name carries the serial suffix, so an exact match is safe enough to tie an old saved entry with no
 * EndpointId to its printer.
 */
export function sameExactName(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = nameKey(a);
  return !!x && x === nameKey(b);
}

/** Whether one name contains the other ("Boxwood" and "Boxwood · 367A"): the looser match for software with no EndpointId. */
export function sameNamedPrinter(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = nameKey(a);
  const y = nameKey(b);
  return !!x && !!y && (x.includes(y) || y.includes(x));
}

/** Every address a found printer answered on. */
export function addressesOf(printer: FoundPrinter): readonly string[] {
  return printer.aliases?.length ? printer.aliases : [printer.host];
}

/** The host (and port) of an address, or the address itself when it is not a URL. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** A saved printer's name: the one it was given, else its network name (muon-boxwood-367a), else its address. */
export function savedName(s: SavedPrinter): string {
  const name = (s.name ?? '').trim();
  if (name) return name;
  if (s.mdnsHost) return s.mdnsHost.replace(/\.local\.?$/i, '');
  return hostOf(s.url);
}

/** Whether a found printer is the one the account service names `id` (also called `name`). */
function sameAccountPrinter(found: FoundPrinter, id: string, name: string): boolean {
  if (found.endpointId) return found.endpointId === id;
  return sameNamedPrinter(found.name, name);
}

/** The found printer a saved entry is: by EndpointId, else by address, else (no EndpointId on either side) by exact name. */
function foundForSaved(found: readonly FoundPrinter[], s: SavedPrinter): FoundPrinter | undefined {
  if (s.endpointId) {
    const byId = found.find((f) => f.endpointId === s.endpointId);
    if (byId) return byId;
  }
  const host = hostOf(s.url);
  const byHost = found.find((f) => addressesOf(f).includes(host));
  // A saved EndpointId and a different one at that address: someone else's printer took the address.
  if (byHost && s.endpointId && byHost.endpointId && byHost.endpointId !== s.endpointId) return undefined;
  if (byHost || s.endpointId) return byHost;
  // Saved before entries recorded the EndpointId, and gone from its address: its display name, serial suffix and all,
  // is the only thing left to go by.
  return found.find((f) => sameExactName(f.name, s.name));
}

const foundHealth = (f: FoundPrinter | undefined): PrinterHealth => f?.health ?? 'available';

/** One entry per printer, in the account, saved and found sections. */
export function printerDirectory(src: DirectorySources): Directory {
  const claimedFound = new Set<FoundPrinter>();
  const claimedSaved = new Set<SavedPrinter>();

  const account: DirectoryEntry[] = src.account.map((a) => {
    const found = src.found.find((f) => !claimedFound.has(f) && sameAccountPrinter(f, a.id, a.name));
    if (found) claimedFound.add(found);
    const saved = src.saved.filter((s) => s.endpointId === a.id || (!!found && foundForSaved([found], s) === found));
    saved.forEach((s) => claimedSaved.add(s));
    let health: PrinterHealth = a.online ? (a.health ?? 'connecting') : 'offline';
    const live = saved.find((s) => s.active && s.health !== undefined);
    // The page's own connection to it says more than the relay; and one the service lost is right here.
    if (live?.health) health = live.health;
    else if (found && health === 'offline') health = foundHealth(found);
    return { key: `account:${a.id}`, section: 'account', name: a.name, endpointId: a.id, health, host: found?.host ?? null, account: a, saved, found };
  });

  const saved: DirectoryEntry[] = [];
  for (const s of src.saved) {
    if (claimedSaved.has(s)) continue;
    const found = foundForSaved(src.found, s);
    const endpointId = s.endpointId ?? found?.endpointId ?? null;
    // Saved twice (an address and a name, or two addresses): one entry.
    const same = saved.find((e) => (!!endpointId && e.endpointId === endpointId) || (!!found && e.found === found));
    if (same) {
      same.saved.push(s);
      if (s.active && s.health !== undefined) same.health = s.health;
      continue;
    }
    if (found) claimedFound.add(found);
    let health: PrinterHealth;
    if (s.active && s.health !== undefined) health = s.health;
    else if (found) health = foundHealth(found);
    else health = src.searching ? 'searching' : 'offline';
    saved.push({ key: `saved:${s.url}`, section: 'saved', name: found?.name ?? savedName(s), endpointId, health, host: found?.host ?? null, saved: [s], found });
  }

  const listed = new Set([...account, ...saved].map((e) => e.endpointId).filter((id): id is string => !!id));
  const found: DirectoryEntry[] = [];
  for (const f of src.found) {
    if (claimedFound.has(f) || (f.endpointId && listed.has(f.endpointId))) continue;
    // The same EndpointId at two addresses is one printer.
    if (f.endpointId && found.some((e) => e.endpointId === f.endpointId)) continue;
    found.push({ key: `found:${f.endpointId ?? f.url}`, section: 'found', name: f.name, endpointId: f.endpointId, health: foundHealth(f), host: f.host, saved: [], found: f });
  }

  return { account, saved, found };
}

/** The tile state of a directory entry: a found printer whose state was not read shows ready, one to set up new. */
export function tileOfEntry(entry: DirectoryEntry, context: Omit<TileContext, 'found'> = {}): TileState {
  return tileOfHealth(entry.health, { ...context, found: entry.section === 'found' });
}

/** What to change about a saved printer, from what a search found. */
export interface SavedUpdate {
  /** The saved entry's address, as saved. */
  url: string;
  changes: { endpointId?: string; mdnsHost?: string; url?: string };
}

const IPV4_HOST = /^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * Saved printers to bring up to date from what a search found: the EndpointId they lacked, their `.local` name, and
 * the address a printer saved by IP answers at now. `blocked` says this page may not reach IPv4 addresses
 * (pageBlocksLanIpv4), so a printer saved by IP moves to the `.local` name it answered at. A printer saved by name
 * keeps its name (mDNS follows it already), and the entry the page is connected through is left alone.
 */
export function savedUpdates(saved: readonly SavedPrinter[], found: readonly FoundPrinter[], blocked = false): SavedUpdate[] {
  const updates: SavedUpdate[] = [];
  for (const s of saved) {
    if (s.active) continue;
    const f = foundForSaved(found, s);
    if (!f?.endpointId) continue;
    const changes: SavedUpdate['changes'] = {};
    if (!s.endpointId) changes.endpointId = f.endpointId;
    if (f.mdnsHost && s.mdnsHost !== f.mdnsHost) changes.mdnsHost = f.mdnsHost;
    const host = hostOf(s.url);
    const addresses = addressesOf(f);
    const ipNow = addresses.find((a) => IPV4.test(a));
    const nameNow = addresses.find((a) => a.endsWith('.local'));
    if (IPV4_HOST.test(host) && ipNow && !addresses.includes(host)) changes.url = `http://${ipNow}`;
    else if (IPV4_HOST.test(host) && blocked && nameNow) changes.url = `http://${nameNow}`;
    if (Object.keys(changes).length) updates.push({ url: s.url, changes });
  }
  return updates;
}
