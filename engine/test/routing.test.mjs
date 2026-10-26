import { RP } from './helpers/rp.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matches } from '../lib/glob.mjs';
import { route } from '../lib/routing.mjs';

const table = RP.routing;

test('route: callable change', () => {
  const r = route(['regroup/functions/src/callable/payments.ts']);
  assert.ok(r.linkTypes.includes('callable'));
  for (const c of [1, 2, 3, 4, 9, 12, 13, 14]) assert.ok(r.classes.includes(c), `class ${c}`);
  assert.deepEqual(r.packages, ['regroup/functions']);
});

test('route: firestore indexes', () => {
  const r = route(['homegroups/firestore.indexes.json']);
  assert.ok(r.linkTypes.includes('firestore-indexes'));
  assert.ok(r.classes.includes(5));
});

test('route: review config', () => {
  const r = route(['.claude/pr-review/REVIEW.md']);
  assert.ok(r.linkTypes.includes('review-config'));
  assert.deepEqual(r.packages, ['repo']);
});

test('route: always includes 13 and 14; packages sorted, unique', () => {
  const r = route(['README.md', 'recovery-api/src/x.ts', 'recovery-api/src/y.ts', 'detox-recovery/app/a.ts']);
  assert.ok(r.classes.includes(13) && r.classes.includes(14));
  assert.deepEqual(r.packages, ['detox-recovery', 'recovery-api', 'repo']);
  assert.deepEqual(route([]).classes, [13, 14]);
});

test('route: regroup rules and tests', () => {
  const r = route(['regroup/mobile/firebase/firestore.rules', 'regroup/mobile/src/__tests__/a.test.ts']);
  assert.ok(r.linkTypes.includes('firestore-rules'));
  assert.ok(r.linkTypes.includes('tests'));
  assert.ok(r.classes.includes(10));
  assert.deepEqual(r.packages, ['regroup/mobile']);
});

test('matches: globs', () => {
  assert.equal(matches('regroup/mobile/src/x/y.ts', 'regroup/mobile/src/**/*.ts'), true);
  assert.equal(matches('regroup/web/a.ts', 'regroup/mobile/**'), false);
  assert.equal(matches('regroup/mobile/src/y.ts', 'regroup/mobile/src/**/*.ts'), true);
  assert.equal(matches('a/b/c.ts', '*/c.ts'), false);
  assert.equal(matches('a/c.ts', '*/c.ts'), true);
  assert.equal(matches('a/c.ts', 'a/?.ts'), true);
  assert.equal(matches('a/cc.ts', 'a/?.ts'), false);
  assert.equal(matches('a/b', 'a/b/**'), true);
});

test('routing.json: shape and required link types', () => {
  const required = ['callable','firestore-rules','firestore-indexes','firestore-trigger','storage','claims','push','deep-link','origins-config','http-export','recovery-api','shared-literals','twin-helper','config-coupling','logging','tests','review-config'];
  assert.deepEqual(table.map((e) => e.linkType), required);
  for (const e of table) {
    assert.ok(Array.isArray(e.paths) && e.paths.length > 0, e.linkType);
    assert.ok(Array.isArray(e.counterparts), e.linkType);
    assert.ok(Array.isArray(e.classes) && e.classes.every((c) => c >= 1 && c <= 14), e.linkType);
  }
});

test('route: packages and always-classes come from the given project', () => {
  const project = { config: { packages: ['apps/api', 'apps'], classes: [{ id: 2, name: 'x', always: true }] }, routing: [{ linkType: 'api', paths: ['apps/api/**'], counterparts: [], classes: [5] }] };
  const r = route(['apps/api/src/a.ts', 'apps/web/b.ts', 'c.md'], project);
  assert.deepEqual(r.packages, ['apps', 'apps/api', 'repo']);
  assert.deepEqual(r.linkTypes, ['api']);
  assert.deepEqual(r.classes, [2, 5]);
});
