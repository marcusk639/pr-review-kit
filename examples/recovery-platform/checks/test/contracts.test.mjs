import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  checkExports,
  checkRegion,
  checkQueriesVsIndexes,
  checkStoragePaths,
  checkCollectionsVsRules,
  checkTwins,
  TWIN_PAIRS,
} from '../contracts.mjs';

let root;

const FILES = {
  'regroup/mobile/src/a.ts': "import { httpsCallable } from 'firebase/functions';\nhttpsCallable(fns, 'foo');\n",
  'regroup/mobile/src/services/pay.ts':
    "const c = firestore()\n  .collection('payments')\n  .where('a', '==', 1)\n  .orderBy('b');\n",
  'regroup/mobile/firebase/firestore.indexes.json': JSON.stringify({
    indexes: [{ collectionGroup: 'houses', fields: [] }],
  }),
  'regroup/mobile/firebase/firestore.rules':
    'service cloud.firestore { match /databases/{d}/documents { match /houses/{id} { allow read: if true; } } }\n',
  'regroup/mobile/firebase/storage.rules': 'service firebase.storage { match /b/{b}/o { match /avatars/{f} {} } }\n',
  'homegroups/functions/src/api/api.ts': 'export const x = 1;\n',
  'regroup/functions/src/api/api.ts': 'export const x = 1;\n',
};

before(() => {
  root = mkdtempSync(join(tmpdir(), 'contracts-'));
  for (const [p, c] of Object.entries(FILES)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), c);
  }
  const g = (...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: root, stdio: 'ignore' });
  g('init', '-q');
  g('add', '-A');
  g('commit', '-q', '-m', 'init');
});

after(() => rmSync(root, { recursive: true, force: true }));

const file = (f, lines, extra = {}) => ({
  file: f,
  oldFile: f,
  status: 'M',
  binary: false,
  added: lines.map((text, i) => ({ line: i + 1, text })),
  ...extra,
});

test('checkExports names client files that call the function', () => {
  const facts = checkExports(
    [file('regroup/functions/src/foo.ts', ["export const foo = onCall({ region: 'x' }, async () => {"])],
    root,
  );
  assert.equal(facts.length, 1);
  assert.equal(facts[0].check, 'exports');
  assert.equal(facts[0].line, 1);
  assert.match(facts[0].note, /regroup\/mobile\/src\/a\.ts/);
});

test('checkExports reports removed exports with remaining client refs', () => {
  const del = file('regroup/functions/src/foo.ts', [], {
    status: 'D',
    removed: [{ line: 3, text: 'export const foo = onCall(async () => {' }],
  });
  const facts = checkExports([del], root);
  assert.equal(facts.length, 1);
  assert.match(facts[0].note, /^export removed:/);
  assert.match(facts[0].note, /regroup\/mobile\/src\/a\.ts/);
  const re = file('regroup/functions/src/foo.ts', ['export const foo = onCall(x'], {
    removed: [{ line: 3, text: 'export const foo = onCall(y' }],
  });
  assert.ok(checkExports([re], root).every((f) => !f.note.startsWith('export removed')));
});

test('checkExports ignores non-callable exports', () => {
  assert.deepEqual(checkExports([file('r/f.ts', ['export const foo = 1;'])], root), []);
});

test('checkRegion flags region and setGlobalOptions', () => {
  const facts = checkRegion([file('regroup/functions/src/a.ts', ["  region: 'us-east1',", 'setGlobalOptions({})', 'x'])], root);
  assert.equal(facts.length, 2);
  assert.equal(facts[0].check, 'region');
});

test('checkQueriesVsIndexes flags where+orderBy with no composite index', () => {
  const facts = checkQueriesVsIndexes(
    [
      file('regroup/mobile/src/services/pay.ts', [
        "const c = firestore()",
        "  .collection('payments')",
        "  .where('a', '==', 1)",
        "  .orderBy('b');",
      ]),
    ],
    root,
  );
  assert.equal(facts.length, 1);
  assert.match(facts[0].note, /no composite index/);
  assert.match(facts[0].note, /payments/);
});

test('checkQueriesVsIndexes reports present index and skips lone where', () => {
  const lines = ["db.collection('houses')", '.where("a","==",1)', '.orderBy("b")'];
  const facts = checkQueriesVsIndexes([file('regroup/mobile/src/h.ts', lines)], root);
  assert.equal(facts.length, 1);
  assert.doesNotMatch(facts[0].note, /no composite index/);
  assert.deepEqual(checkQueriesVsIndexes([file('regroup/mobile/src/h.ts', ["db.collection('houses').where('a','==',1)"])], root), []);
});

test('checkStoragePaths flags prefix missing from storage.rules', () => {
  const facts = checkStoragePaths([file('regroup/mobile/src/s.ts', ["storage().ref('chore-evidence/x')"])], root);
  assert.equal(facts.length, 1);
  assert.match(facts[0].note, /chore-evidence/);
  assert.deepEqual(checkStoragePaths([file('regroup/mobile/src/s.ts', ["ref('avatars/x')"])], root), []);
});

test('checkCollectionsVsRules flags collection with no rule match', () => {
  const facts = checkCollectionsVsRules(
    [file('regroup/mobile/src/c.ts', ["db.collection('payments')", "db.collection('houses')"])],
    root,
  );
  assert.equal(facts.length, 1);
  assert.match(facts[0].note, /payments/);
});

test('checkTwins names the twin for either side and for renames', () => {
  const a = checkTwins([file('homegroups/functions/src/api/api.ts', ['x'])], root);
  assert.equal(a.length, 1);
  assert.match(a[0].note, /regroup\/functions\/src\/api\/api\.ts/);
  const b = checkTwins([file('regroup/functions/src/util/date.ts', [])], root);
  assert.match(b[0].note, /homegroups\/functions\/src\/utils\/date\.ts/);
  const r = checkTwins([file('regroup/functions/src/new.ts', [], { oldFile: 'regroup/functions/src/api/api.ts', status: 'R' })], root);
  assert.equal(r.length, 1);
  assert.deepEqual(checkTwins([file('regroup/functions/src/other.ts', [])], root), []);
});

test('TWIN_PAIRS paths all differ per side', () => {
  for (const [h, r] of TWIN_PAIRS) {
    assert.ok(h.startsWith('homegroups/functions/src/'));
    assert.ok(r.startsWith('regroup/functions/src/'));
  }
});

test('checkQueriesVsIndexes reports a missing or unparsable index file as unavailable', () => {
  const lines = ["db.collection('groups')", ".where('a','==',1)", ".orderBy('b')"];
  // homegroups has no index file in this fixture.
  const missing = checkQueriesVsIndexes([file('homegroups/mobile/src/g.ts', lines), file('homegroups/mobile/src/h.ts', lines)], root);
  assert.equal(missing.length, 1, 'one unavailable fact per index file');
  assert.match(missing[0].note, /unavailable/);
  assert.equal(missing[0].file, 'homegroups/firestore.indexes.json');
  const broken = mkdtempSync(join(tmpdir(), 'contracts-bad-'));
  try {
    mkdirSync(join(broken, 'regroup/mobile/firebase'), { recursive: true });
    writeFileSync(join(broken, 'regroup/mobile/firebase/firestore.indexes.json'), '{ not json');
    const bad = checkQueriesVsIndexes([file('regroup/mobile/src/h.ts', lines)], broken);
    assert.equal(bad.length, 1);
    assert.match(bad[0].note, /unavailable/);
  } finally {
    rmSync(broken, { recursive: true, force: true });
  }
});
