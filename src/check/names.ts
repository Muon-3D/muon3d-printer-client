// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Muon 3D Technologies Limited
// SG-11, the name a plate's G-code is uploaded under. The plate's file name is made safe the way a download's is (no
// slash, backslash or control character) and by the printer's own rule, ends in .gcode, and must pass the package's
// safe-name rule (multipart/names.ts). Before the upload the printer is asked whether a file of that name exists; if
// it does, the upload is renamed (`_2`, then `_3`, before `.gcode`), unless this browser uploaded that file itself and
// it is neither queued nor loaded. So an upload never replaces a file someone else put there, and a queued job always
// prints the bytes approved for it.
//
// "This browser uploaded it" is a per-viewer record of the names uploaded to each printer (by printer key, in Web
// Storage). Without the record (private browsing, storage cleared or refused) every existing name is renamed.
import { isSafeName, MAX_NAME_BYTES } from '../multipart/names.ts';
import { filePath, isBusy } from './glance.ts';

/** The extension every upload has. */
export const GCODE_EXT = '.gcode';

/** The Web Storage key of the names this browser uploaded (`<key>:<site | embedded>:<printer key>`), unless a client names its own. */
export const UPLOADED_NAMES_KEY = 'muon3d:printer-uploads';

/** How many names the record keeps per printer (the oldest go first). */
export const MAX_RECORDED_NAMES = 200;

/** The most names tried before giving up (`_2` … `_999`). */
const MAX_SUFFIX = 999;

const encoder = new TextEncoder();

/** `text` cut to at most `bytes` UTF-8 bytes, never inside a character. */
function cutToBytes(text: string, bytes: number): string {
  let out = '';
  let used = 0;
  for (const c of text) {
    const n = encoder.encode(c).byteLength;
    if (used + n > bytes) break;
    out += c;
    used += n;
  }
  return out;
}

/** `stem` + `suffix` + .gcode, the stem shortened so the whole name fits the printer's 255 bytes. */
function fit(stem: string, suffix: string): string {
  const room = MAX_NAME_BYTES - encoder.encode(`${suffix}${GCODE_EXT}`).byteLength;
  return `${cutToBytes(stem, room).trimEnd()}${suffix}${GCODE_EXT}`;
}

/** Characters Windows, macOS or unzip tools refuse in a file name. */
const UNSAFE = /[<>:"/\\|?*\u0000-\u001f]/g;

/** Text as a file name: unsafe characters become "_", no leading or trailing dots; never empty ("Plate"). */
export function safeFilePart(text: string): string {
  const safe = text.replace(UNSAFE, '_').replace(/\s+/g, ' ').trim().replace(/^\.+|\.+$/g, '');
  return safe || 'Plate';
}

// What the printer's rule refuses beyond safeFilePart's: a semicolon (the gateway splits the part's header there), DEL
// and the C1 controls, and a UTF-16 surrogate without its pair.
const MORE_UNSAFE = /[;\u007f-\u009f]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/** The stem of a plate's file name: safe (safeFilePart and the printer's rule), without .gcode, never empty. */
function stemOf(plateFileName: string): string {
  const safe = safeFilePart(plateFileName.replace(MORE_UNSAFE, '_'));
  const stem = safe.replace(/\.gcode$/i, '').trim();
  return stem === '' ? 'Plate' : stem;
}

/** The name a plate's G-code is uploaded under, before the printer is asked (`Benchy_PLA_44m.gcode`). */
export function uploadNameFor(plateFileName: string): string {
  const name = fit(stemOf(plateFileName), '');
  if (!isSafeName(name)) throw new RangeError(`"${plateFileName}" cannot be made a safe file name`);
  return name;
}

/** The n-th alternative of a name: `a.gcode` → `a_2.gcode`. */
export function numberedName(name: string, n: number): string {
  return n <= 1 ? name : fit(name.replace(/\.gcode$/i, ''), `_${n}`);
}

/** What the printer and this browser know about the names on it. */
export interface NameCheck {
  /** Whether a file of that name is in the gcodes root (server.files.metadata). */
  exists(name: string): Promise<boolean>;
  /** The queue's file names. */
  queued: readonly string[];
  /** The file the printer is printing or has paused (the one Moonraker refuses to replace), or null. */
  loaded: string | null;
  /** Whether this browser uploaded that name to this printer (the record). */
  uploadedHere(name: string): boolean;
}

/**
 * The name to upload `wanted` under: the first of `wanted`, `wanted_2`, `wanted_3`, … that is neither queued nor
 * loaded and does not exist on the printer, or that this browser uploaded itself (so it may be replaced). A queued or
 * loaded name is passed over before the printer is asked: its metadata read can answer 404 for a file that is there
 * (Moonraker has not read its metadata yet), and a queue entry needs only the file.
 */
export async function chooseUploadName(wanted: string, check: NameCheck): Promise<string> {
  const queued = new Set(check.queued.map(filePath));
  const loaded = check.loaded === null ? null : filePath(check.loaded);
  for (let n = 1; n <= MAX_SUFFIX; n++) {
    const name = numberedName(wanted, n);
    if (queued.has(name) || loaded === name) continue;
    if (!(await check.exists(name)) || check.uploadedHere(name)) return name;
  }
  throw new RangeError(`No free name for "${wanted}" on the printer`);
}

/** What nameCheckFor reads of a printer: its key, three reads, through whatever route reaches it. */
export interface NameCheckLink {
  ref: { key: string };
  /** The job queue (server.job_queue.status) and a file's metadata (server.files.metadata; null when it is not there). */
  call(op: { op: 'queueStatus' } | { op: 'metadata'; filename: string }): Promise<unknown>;
  /** An objects query (printer.objects.query): `{ status: { print_stats: { state, filename } } }`. */
  query(objects: { print_stats: readonly string[] }): Promise<{ status: Record<string, Record<string, unknown> | undefined> }>;
}

/** A NameCheck read from the printer through `link` (queue and print state read once, metadata per name). */
export async function nameCheckFor(link: NameCheckLink, record: UploadRecord): Promise<NameCheck> {
  const [queue, snapshot] = await Promise.all([link.call({ op: 'queueStatus' }), link.query({ print_stats: ['state', 'filename'] })]);
  const stats = snapshot.status.print_stats ?? {};
  const loaded = isBusy(stats.state) && typeof stats.filename === 'string' && stats.filename !== '' ? stats.filename : null;
  const jobs = (queue as { jobs?: unknown } | null)?.jobs;
  const queued = Array.isArray(jobs) ? jobs.map((j) => (j as { filename?: unknown } | null)?.filename).filter((f): f is string => typeof f === 'string') : [];
  return {
    exists: async (name) => (await link.call({ op: 'metadata', filename: name })) !== null,
    queued,
    loaded,
    uploadedHere: (name) => record.has(link.ref.key, name),
  };
}

// ---------------------------------------------------------------------------
// The record of names this browser uploaded
// ---------------------------------------------------------------------------

export interface UploadRecord {
  has(printerKey: string, name: string): boolean;
  add(printerKey: string, name: string): void;
}

/** The part of Web Storage the record uses. */
export type RecordStorage = Pick<Storage, 'getItem' | 'setItem'>;

/**
 * The per-viewer record of uploaded names, in Web Storage (localStorage by default) under its own key per printer; a
 * client framed in another app (`embedded`) keeps a record apart. Every read and write is guarded: without storage
 * (none, refused, full) the record is empty and every existing name is renamed.
 */
export function uploadRecord(options: { embedded?: boolean; storage?: RecordStorage | null; key?: string } = {}): UploadRecord {
  const scope = options.embedded ? 'embedded' : 'site';
  const prefix = options.key ?? UPLOADED_NAMES_KEY;
  const storage = (): RecordStorage | null => (options.storage !== undefined ? options.storage : ((globalThis as { localStorage?: RecordStorage }).localStorage ?? null));
  const read = (printerKey: string): string[] => {
    try {
      const value: unknown = JSON.parse(storage()?.getItem(`${prefix}:${scope}:${printerKey}`) ?? '[]');
      return Array.isArray(value) ? value.filter((n): n is string => typeof n === 'string') : [];
    } catch {
      return [];
    }
  };
  return {
    has: (printerKey, name) => read(printerKey).includes(filePath(name)),
    add: (printerKey, name) => {
      const names = [...read(printerKey).filter((n) => n !== filePath(name)), filePath(name)].slice(-MAX_RECORDED_NAMES);
      try {
        storage()?.setItem(`${prefix}:${scope}:${printerKey}`, JSON.stringify(names));
      } catch {
        // No storage, or full: the next upload of this name is renamed.
      }
    },
  };
}
