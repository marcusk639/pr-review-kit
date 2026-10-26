import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeConfig } from '../lib/config.mjs';
import { countPr, mergePrecision, totals, demotedClasses, readPrecision, renderPrecision } from '../learn/precision.mjs';

const config = normalizeConfig({
  version: 1,
  project: 'p',
  classes: [{ id: 1, name: 'auth', security: true }, { id: 5, name: 'drift' }, { id: 9, name: 'silent' }],
  learning: { demote: { minVotes: 3, maxPrecision: 0.4 } },
}).config;

const rec = (cls, signal, over = {}) => ({ pr: 1, slug: `c${cls}:a.ts:x`, class: cls, linkTypes: ['api'], severity: 'Medium', security: false, signal, ...over });

test('countPr tallies up and down per class and link type, keeping protected votes apart', () => {
  const c = countPr([rec(5, 'up'), rec(5, 'down'), rec(5, 'down', { severity: 'High' }), rec(1, 'down', { security: true }), rec(5, 'text')]);
  assert.deepEqual(c.classes['5'], { up: 1, down: 1, protectedUp: 0, protectedDown: 1 });
  assert.deepEqual(c.classes['1'], { up: 0, down: 0, protectedUp: 0, protectedDown: 1 });
  assert.deepEqual(c.linkTypes.api, { up: 1, down: 1, protectedUp: 0, protectedDown: 2 });
});

test('mergePrecision replaces a PR contribution rather than adding to it', () => {
  let p = mergePrecision(null, { 1: [rec(5, 'down')] });
  p = mergePrecision(p, { 1: [rec(5, 'down'), rec(5, 'up')], 2: [rec(9, 'up', { pr: 2 })] });
  const t = totals(p);
  assert.deepEqual(t.classes['5'], { up: 1, down: 1, protectedUp: 0, protectedDown: 0 });
  assert.deepEqual(t.classes['9'], { up: 1, down: 0, protectedUp: 0, protectedDown: 0 });
});

test('PRs outside the collection window keep their counts', () => {
  const p1 = mergePrecision(null, { 7: [rec(5, 'down', { pr: 7 })] });
  const p2 = mergePrecision(p1, { 8: [rec(5, 'up', { pr: 8 })] });
  assert.deepEqual(totals(p2).classes['5'], { up: 1, down: 1, protectedUp: 0, protectedDown: 0 });
});

test('a non-security class with enough low-precision votes is demoted', () => {
  const p = mergePrecision(null, { 1: [rec(5, 'down'), rec(5, 'down'), rec(5, 'up'), rec(9, 'down'), rec(9, 'down')] });
  assert.deepEqual([...demotedClasses(p, config)], [5]);
});

test('security, Critical and High downvotes never demote a class', () => {
  const p = mergePrecision(null, { 1: [rec(9, 'down', { severity: 'High' }), rec(9, 'down', { severity: 'Critical' }), rec(9, 'down', { severity: 'High' }), rec(1, 'down'), rec(1, 'down'), rec(1, 'down')] });
  assert.deepEqual([...demotedClasses(p, config)], []);
});

test('readPrecision tolerates a missing or broken file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prec-'));
  assert.deepEqual(readPrecision(dir), { version: 1, byPr: {} });
  mkdirSync(join(dir, 'learned'));
  writeFileSync(join(dir, 'learned/precision.json'), '{x');
  assert.deepEqual(readPrecision(dir), { version: 1, byPr: {} });
});

test('renderPrecision shows per-class counts with names and the demotion mark', () => {
  const p = mergePrecision(null, { 1: [rec(5, 'down'), rec(5, 'down'), rec(5, 'up')] });
  const md = renderPrecision(p, config);
  assert.match(md, /\| 5 drift \| 1 \| 2 \| 0 \/ 0 \| 33% \| demoted \|/);
});
