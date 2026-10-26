import './helpers/rp.mjs';
// Round 5: relative and non-canonical forms of a security file are withheld
// (in text and in finding locations / slug files), while other files that only
// share its basename stay public. Security file: regroup/functions/src/index.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mentions, securityNeedles, touchesSecurityFile } from '../lib/needles.mjs';
import { candidatePaths, fileId, hashedNeedles } from '../lib/fileids.mjs';

const IDX = 'regroup/functions/src/index.ts';
const SEC = { security: true, slug: `c1:${IDX}:x`, locations: [{ file: IDX, line: 3, side: 'changed' }] };
const N = securityNeedles([SEC]);
const KEY = 'test-id-key';

const WITHHELD_TEXT = [
  IDX, 'functions/src/index.ts', 'src/index.ts', 'index.ts', '`index.ts`', 'index.ts.', 'index.ts:12', '(index.ts)', 'in index.ts, the',
  './index.ts', './src/index.ts', '/src/index.ts', '../src/index.ts', '../../src/index.ts', 'src//index.ts', 'src/./index.ts',
  `./${IDX}`, `file:///x/src/index.ts`, `file://${IDX}`, `/abs/repo/${IDX}`, 'C:\\repo\\regroup\\functions\\src\\index.ts',
  'src\\index.ts', 'REGROUP/Functions/SRC/INDEX.TS', 'src/index.ts#L4', '"src/index.ts"', '@src/index.ts',
  `https://github.com/o/r/blob/main/${IDX}#L3`,
];
const SHOWN_TEXT = ['other/index.ts', 'a/b/index.ts', 'index.tsx', 'index.ts.bak', 'x-index.ts', 'my-index.ts', `${IDX}.bak`, `${IDX}x`, 'regroup/mobile/src/screens/index.ts', 'homegroups/web/src/index.tsx', '/x/other/index.ts'];

for (const t of WITHHELD_TEXT) {
  test(`mentions withholds ${JSON.stringify(t)}`, () => assert.equal(mentions(`see ${t} here`, N), true));
}
for (const t of SHOWN_TEXT) {
  test(`mentions shows ${JSON.stringify(t)}`, () => assert.equal(mentions(`see ${t} here`, N), false));
}

const F = (file, slug = 'c2:regroup/mobile/src/a.ts:b') => ({ slug, security: false, title: 't', why: 'w', fix: 'f', feature: 'x', locations: [{ file, line: 1, side: 'changed' }] });

const WITHHELD_LOC = [IDX, `./${IDX}`, `/repo/${IDX}`, `${IDX} `, ` ${IDX}`, 'regroup//functions/src/index.ts', 'src/index.ts', 'Regroup/Functions/src/index.ts', 'regroup\\functions\\src\\index.ts', 'regroup%2Ffunctions%2Fsrc%2Findex.ts', 'regroup/./functions/src/index.ts'];
const SHOWN_LOC = ['other/index.ts', 'regroup/mobile/src/screens/index.ts', `${IDX}x`, 'regroup/functions/src/index.tsx'];

for (const loc of WITHHELD_LOC) {
  test(`touchesSecurityFile: location ${JSON.stringify(loc)} is the security file`, () => assert.equal(touchesSecurityFile(F(loc), N), true));
  test(`touchesSecurityFile: slug file ${JSON.stringify(loc.trim())} is the security file`, () => assert.equal(touchesSecurityFile(F('z.ts', `c2:${loc.trim()}:b`), N), true));
}
for (const loc of SHOWN_LOC) {
  test(`touchesSecurityFile: location ${JSON.stringify(loc)} is a different file`, () => {
    assert.equal(touchesSecurityFile(F(loc), N), false);
    assert.equal(touchesSecurityFile(F('z.ts', `c2:${loc}:b`), N), false);
  });
}

test('a prior security file named non-canonically (not in changed files) still hashes to its fileId', () => {
  const ids = new Set([fileId(IDX, KEY)]);
  for (const t of [`./${IDX}`, `regroup//functions/src/index.ts`, `/home/runner/work/r/r/${IDX}`, `regroup/./functions/src/index.ts`]) {
    assert.deepEqual(hashedNeedles(candidatePaths([], [`see ${t}`]), ids, KEY), [IDX], t);
  }
  assert.deepEqual(hashedNeedles(candidatePaths([F(`/repo/${IDX}`)], []), ids, KEY), [IDX], 'absolute location');
});

test('fileId of a canonical path is unchanged by the #127 port (existing ledgers keep matching)', async () => {
  const { fileId } = await import('../lib/fileids.mjs');
  const { opaqueId } = await import('../lib/ids.mjs');
  const { normalise } = await import('../lib/needles.mjs');
  for (const p of ['regroup/functions/src/index.ts', 'a/b.ts', 'README.md']) assert.equal(fileId(p, 'k'), opaqueId(normalise(p), 'k'));
});
