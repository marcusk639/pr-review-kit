import './helpers/rp.mjs';
// Round 6: bracketed, backup-marked and unresolved ('..', '~/') forms of a
// security file are withheld; locations with a line, anchor or query suffix
// still touch it; a root-level security file matches only its exact root path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mentions, securityNeedles, touchesSecurityFile } from '../lib/needles.mjs';
import { candidatePaths, fileId, hashedNeedles } from '../lib/fileids.mjs';

const IDX = 'regroup/functions/src/index.ts';
const N = securityNeedles([{ security: true, locations: [{ file: IDX, line: 3, side: 'changed' }] }]);
const ROOT = securityNeedles([{ security: true, locations: [{ file: 'firebase.json', line: 1, side: 'changed' }] }]);
const KEY = 'test-id-key';

const WITHHELD = [
  '[index.ts](u)', 'see [index.ts]', '[src/index.ts]', '[src/index.ts#L4](u)', '$src/index.ts', '+src/index.ts', '~index.ts', 'index.ts~', 'src/index.ts~',
  'src/../src/index.ts', 'functions/src/../src/index.ts', '~/src/index.ts', 'src/../index.ts', '(src/index.ts)',
];
const SHOWN = ['other/index.ts', 'a/b/index.ts', 'index.tsx', 'index.ts.bak', 'x-index.ts', 'other/src/index.ts', 'src/other/index.ts', '[other/index.ts](u)', 'src/../other/index.ts'];

for (const t of WITHHELD) test(`mentions withholds ${JSON.stringify(t)}`, () => assert.equal(mentions(`see ${t} here`, N), true));
for (const t of SHOWN) test(`mentions shows ${JSON.stringify(t)}`, () => assert.equal(mentions(`see ${t} here`, N), false));

const F = (file, slug = 'c2:regroup/mobile/src/a.ts:b') => ({ slug, security: false, title: 't', why: 'w', fix: 'f', feature: 'x', locations: [{ file, line: 1, side: 'changed' }] });
for (const loc of [`${IDX}:12`, `${IDX}:12:3`, `${IDX}#L4`, `${IDX}?plain=1`, '~/x/src/index.ts', 'src/../src/index.ts', `${IDX}~`]) {
  test(`touchesSecurityFile: location ${JSON.stringify(loc)} is the security file`, () => assert.equal(touchesSecurityFile(F(loc), N), true));
}
for (const loc of ['other/index.ts:12', 'regroup/mobile/src/screens/index.ts#L4', 'src/../other/index.ts']) {
  test(`touchesSecurityFile: location ${JSON.stringify(loc)} is a different file`, () => assert.equal(touchesSecurityFile(F(loc), N), false));
}

test('a root-level security file matches only its exact root path, never a nested file with its basename', () => {
  for (const t of ['firebase.json', './firebase.json', '`firebase.json`', '/repo/firebase.json']) assert.equal(mentions(`see ${t}`, ROOT), true, t);
  for (const t of ['regroup/firebase.json', 'homegroups/web/firebase.json']) assert.equal(mentions(`see ${t}`, ROOT), false, t);
  assert.equal(touchesSecurityFile(F('regroup/firebase.json'), ROOT), false);
  assert.equal(touchesSecurityFile(F('firebase.json'), ROOT), true);
});

test('a nested changed file sharing a prior root-level file\'s basename is not read as that file', () => {
  const ids = new Set([fileId('firebase.json', KEY)]);
  const needles = hashedNeedles(candidatePaths([], ['regroup/firebase.json']), ids, KEY);
  assert.equal(needles.some((n) => mentions('regroup/firebase.json is fine', [n])), false);
});

test('resolved and bracketed forms of a prior security file still hash to its fileId', () => {
  const ids = new Set([fileId(IDX, KEY)]);
  for (const t of [`[${IDX}](u)`, 'regroup/functions/src/../src/index.ts', `~/${IDX}`, `${IDX}~`]) {
    assert.deepEqual(hashedNeedles(candidatePaths([], [`see ${t}`]), ids, KEY), [IDX], t);
  }
});
