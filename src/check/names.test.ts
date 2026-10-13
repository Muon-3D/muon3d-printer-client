// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Muon 3D Technologies Limited
// SG-11 (names.ts): the upload's name made safe, the renames (`_2`, `_3`) against a file someone else put there, a
// queued file and the loaded one, our own file replaced, the per-viewer record, and the check read through a link.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isSafeName, MAX_NAME_BYTES } from '../multipart/names.ts';
import { chooseUploadName, MAX_RECORDED_NAMES, nameCheckFor, numberedName, safeFilePart, uploadNameFor, uploadRecord, type NameCheck, type NameCheckLink, type RecordStorage } from './names.ts';

const KEY = 'a'.repeat(64);
const bytes = (s: string) => new TextEncoder().encode(s).byteLength;

/** A Web Storage for the record. */
class MemoryStorage implements RecordStorage {
  values = new Map<string, string>();
  refuse = false;
  getItem(key: string) {
    if (this.refuse) throw new Error('SecurityError');
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    if (this.refuse) throw new Error('QuotaExceededError');
    this.values.set(key, value);
  }
}

/** A printer's files, queue and loaded file, and the names this browser uploaded. */
const check = (over: { files?: string[]; queued?: string[]; loaded?: string | null; ours?: string[] } = {}): NameCheck => ({
  exists: async (name) => (over.files ?? []).includes(name),
  queued: over.queued ?? [],
  loaded: over.loaded ?? null,
  uploadedHere: (name) => (over.ours ?? []).includes(name),
});

describe('uploadNameFor', () => {
  it("keeps a plate's file name, ending in .gcode", () => {
    assert.equal(uploadNameFor('Benchy_0.2mm_PLA_Muon3D M1_44m38s.gcode'), 'Benchy_0.2mm_PLA_Muon3D M1_44m38s.gcode');
    assert.equal(uploadNameFor('Benchy'), 'Benchy.gcode');
    assert.equal(uploadNameFor('Benchy.GCODE'), 'Benchy.gcode');
  });

  it('makes it safe: no slash, backslash, quote, semicolon or control character, no dots or spaces at the ends', () => {
    const cases: [string, string][] = [
      ['../../etc/passwd', '_.._etc_passwd.gcode'],
      ['a\\b/c', 'a_b_c.gcode'],
      ['say "hi"; rm', 'say _hi__ rm.gcode'],
      ['tab\there\u0000\u0085\u007f', 'tab_here___.gcode'],
      ['  .hidden. ', 'hidden.gcode'],
      ['', 'Plate.gcode'],
      ['...', 'Plate.gcode'],
      ['.gcode', 'gcode.gcode'],
      ['lone \ud800 half', 'lone _ half.gcode'],
      ['part.ufp', 'part.ufp.gcode'],
    ];
    for (const [plate, name] of cases) {
      assert.equal(uploadNameFor(plate), name, JSON.stringify(plate));
      assert.ok(isSafeName(name), name);
    }
    assert.equal(safeFilePart('a<b>:c?'), 'a_b__c_');
  });

  it("fits the printer's 255 bytes, cutting the stem and never a character", () => {
    const name = uploadNameFor(`${'界'.repeat(200)}.gcode`);
    assert.ok(bytes(name) <= MAX_NAME_BYTES);
    assert.ok(name.endsWith('界.gcode'));
    assert.ok(isSafeName(name));
    const numbered = numberedName(name, 12);
    assert.ok(bytes(numbered) <= MAX_NAME_BYTES);
    assert.ok(numbered.endsWith('_12.gcode'));
  });
});

describe('chooseUploadName', () => {
  it('keeps a name no file has', async () => {
    assert.equal(await chooseUploadName('a.gcode', check()), 'a.gcode');
  });

  it('renames past a file someone else put there: _2, then _3, before .gcode', async () => {
    assert.equal(numberedName('a.gcode', 1), 'a.gcode');
    assert.equal(numberedName('a.gcode', 2), 'a_2.gcode');
    assert.equal(await chooseUploadName('a.gcode', check({ files: ['a.gcode'] })), 'a_2.gcode');
    assert.equal(await chooseUploadName('a.gcode', check({ files: ['a.gcode', 'a_2.gcode'] })), 'a_3.gcode');
  });

  it('replaces our own file when it is neither queued nor loaded', async () => {
    assert.equal(await chooseUploadName('a.gcode', check({ files: ['a.gcode'], ours: ['a.gcode'] })), 'a.gcode');
    assert.equal(await chooseUploadName('a.gcode', check({ files: ['a.gcode', 'a_2.gcode'], ours: ['a_2.gcode'] })), 'a_2.gcode');
  });

  it('never replaces a queued or loaded file, ours or not (a queued job prints the bytes approved for it)', async () => {
    assert.equal(await chooseUploadName('a.gcode', check({ files: ['a.gcode'], ours: ['a.gcode'], queued: ['a.gcode'] })), 'a_2.gcode');
    assert.equal(await chooseUploadName('a.gcode', check({ files: ['a.gcode'], ours: ['a.gcode'], queued: ['/a.gcode'] })), 'a_2.gcode');
    assert.equal(await chooseUploadName('a.gcode', check({ files: ['a.gcode'], ours: ['a.gcode'], loaded: 'a.gcode' })), 'a_2.gcode');
    // A queued or loaded file whose metadata the printer has not read yet answers 404: it is passed over all the same.
    assert.equal(await chooseUploadName('a.gcode', check({ queued: ['a.gcode'] })), 'a_2.gcode');
    assert.equal(await chooseUploadName('a.gcode', check({ loaded: '/a.gcode' })), 'a_2.gcode');
  });

  it('gives up when every name is taken', async () => {
    await assert.rejects(chooseUploadName('a.gcode', { ...check(), exists: async () => true }), /No free name/);
  });
});

describe('uploadRecord', () => {
  it('records names per printer, apart for a client framed in another app, under the key it is given', () => {
    const storage = new MemoryStorage();
    const site = uploadRecord({ storage, key: 'my-app:printer-uploads' });
    site.add(KEY, 'a.gcode');
    site.add(KEY, '/b.gcode');
    assert.ok(site.has(KEY, 'a.gcode') && site.has(KEY, 'b.gcode') && site.has(KEY, '/a.gcode'));
    assert.ok(!site.has('b'.repeat(64), 'a.gcode'));
    assert.ok(!uploadRecord({ storage, key: 'my-app:printer-uploads', embedded: true }).has(KEY, 'a.gcode'));
    assert.deepEqual([...storage.values.keys()], [`my-app:printer-uploads:site:${KEY}`]);
    uploadRecord({ storage, embedded: true }).add(KEY, 'c.gcode');
    assert.ok([...storage.values.keys()].includes(`muon3d:printer-uploads:embedded:${KEY}`));
  });

  it('keeps the newest names, each once', () => {
    const storage = new MemoryStorage();
    const record = uploadRecord({ storage });
    for (let i = 0; i < MAX_RECORDED_NAMES + 10; i++) record.add(KEY, `p${i}.gcode`);
    record.add(KEY, 'p20.gcode');
    const names = JSON.parse(storage.values.get(`muon3d:printer-uploads:site:${KEY}`)!) as string[];
    assert.equal(names.length, MAX_RECORDED_NAMES);
    assert.equal(names.at(-1), 'p20.gcode');
    assert.equal(names.filter((n) => n === 'p20.gcode').length, 1);
    assert.ok(!record.has(KEY, 'p0.gcode'));
  });

  it('is empty, and says nothing, without storage or with storage that refuses (so every existing name is renamed)', async () => {
    const storage = new MemoryStorage();
    storage.values.set(`muon3d:printer-uploads:site:${KEY}`, 'not json');
    assert.ok(!uploadRecord({ storage }).has(KEY, 'a.gcode'));
    storage.refuse = true;
    const record = uploadRecord({ storage });
    record.add(KEY, 'a.gcode');
    assert.ok(!record.has(KEY, 'a.gcode'));
    const none = uploadRecord({ storage: null });
    none.add(KEY, 'a.gcode');
    assert.ok(!none.has(KEY, 'a.gcode'));
    // Node has no localStorage: the default is no storage.
    assert.ok(!uploadRecord().has(KEY, 'a.gcode'));
    assert.equal(await chooseUploadName('a.gcode', { ...check({ files: ['a.gcode'] }), uploadedHere: (n) => none.has(KEY, n) }), 'a_2.gcode');
  });
});

describe('nameCheckFor', () => {
  /** A printer as a link reads it: files, a queue, a print state. */
  function link(printer: { files: string[]; queue: string[]; state: string; filename: string }): NameCheckLink & { asked: string[] } {
    const asked: string[] = [];
    return {
      asked,
      ref: { key: KEY },
      call: async (op) => {
        if (op.op === 'queueStatus') return { queueState: 'ready', jobs: printer.queue.map((filename, i) => ({ filename, jobId: String(i) })) };
        asked.push(op.filename);
        return printer.files.includes(op.filename) ? { filename: op.filename, size: 1 } : null;
      },
      query: async () => ({ status: { print_stats: { state: printer.state, filename: printer.filename } } }),
    };
  }

  it("reads the printer's files, queue and loaded file, and renames around a foreign, a queued and the loaded file", async () => {
    const storage = new MemoryStorage();
    const record = uploadRecord({ storage });
    const printer = { files: ['benchy.gcode', 'mine.gcode', 'other.gcode'], queue: [] as string[], state: 'standby', filename: '' };
    // Someone else's file.
    assert.equal(await chooseUploadName('benchy.gcode', await nameCheckFor(link(printer), record)), 'benchy_2.gcode');
    // Ours (uploaded from here, recorded): replaced, until it is queued or loaded.
    record.add(KEY, 'mine.gcode');
    assert.equal(await chooseUploadName('mine.gcode', await nameCheckFor(link(printer), record)), 'mine.gcode');
    const busy = { ...printer, queue: ['mine.gcode'], state: 'printing', filename: 'other.gcode' };
    const queued = await nameCheckFor(link(busy), record);
    assert.deepEqual(queued.queued, ['mine.gcode']);
    assert.equal(queued.loaded, 'other.gcode');
    assert.equal(await chooseUploadName('mine.gcode', queued), 'mine_2.gcode');
    record.add(KEY, 'other.gcode');
    assert.equal(await chooseUploadName('other.gcode', queued), 'other_2.gcode', 'the loaded file');
    // A printer that is not printing has no loaded file, whatever print_stats still names.
    assert.equal((await nameCheckFor(link({ ...printer, state: 'complete', filename: 'other.gcode' }), record)).loaded, null);
    // A plate's name, through the whole check.
    assert.equal(await chooseUploadName(uploadNameFor('benchy'), await nameCheckFor(link(printer), record)), 'benchy_2.gcode');
  });
});
