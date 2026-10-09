// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isSafeName, MAX_NAME_BYTES, unsafeNameReason } from './names.ts';

describe('the safe-name rule', () => {
  // Moonraker stores an upload under filename.strip() and a .ufp upload as .gcode (file_manager.py,
  // _parse_upload_args): a name it would change is refused, so the name checked is the name written.
  it('takes the names the slicer gives its plates', () => {
    for (const name of ['3DBenchy_0.2mm_PLA_Muon3D M1_44m38s.gcode', 'Würfel (2).gcode', 'plate 1 – Ω.gcode', '😀.gcode', 'a&print=true.gcode', 'model.ufp.gcode']) {
      assert.equal(unsafeNameReason(name), null, name);
    }
  });

  it('refuses what would leave the root, break the header, or arrive changed', () => {
    const cases: [string, RegExp][] = [
      ['', /empty/],
      ['   ', /empty/],
      [' leading space.gcode', /white space/],
      ['trailing space.gcode ', /white space/],
      ['\u00a0cube.gcode', /white space/],
      ['cube.gcode\u3000', /white space/],
      ['\ufeffcube.gcode', /white space/],
      ['.', /not a file name/],
      ['..', /not a file name/],
      ['plates/cube.gcode', /slash/],
      ['../config/printer.cfg', /slash/],
      ['..\\config\\printer.cfg', /backslash/],
      ['a"b.gcode', /double quote/],
      ['a;b.gcode', /semicolon/],
      ['a\nb.gcode', /control/],
      ['a\u0000b.gcode', /control/],
      ['a\u007fb.gcode', /control/],
      ['a\u0085b.gcode', /control/],
      ['a\ud800b.gcode', /Unicode/],
      ['a\udc00.gcode', /Unicode/],
      [`${'x'.repeat(MAX_NAME_BYTES - 6)}.gcode0`, /255 bytes/],
      [`${'é'.repeat(126)}.gcode`, /255 bytes/],
      ['cube.ufp', /\.ufp/],
      ['x.UFP', /\.ufp/],
    ];
    for (const [name, reason] of cases) {
      assert.match(unsafeNameReason(name) ?? '', reason, JSON.stringify(name));
      assert.equal(isSafeName(name), false, JSON.stringify(name));
    }
  });

  it('counts the limit in UTF-8 bytes', () => {
    assert.equal(isSafeName(`${'x'.repeat(MAX_NAME_BYTES - 6)}.gcode`), true);
    assert.equal(isSafeName(`${'é'.repeat(124)}.gcode`), true, '248 + 6 bytes');
  });
});
