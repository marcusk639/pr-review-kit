import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadReviewProject } from '../lib/project.mjs';

test('the review project carries the classes demoted by learned precision (facts and publish alike)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rp-'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ version: 1, project: 'p', classes: [{ id: 2, name: 'x' }], learning: { demote: { minVotes: 2, maxPrecision: 0.4 } } }));
  writeFileSync(join(dir, 'routing.json'), '[]');
  mkdirSync(join(dir, 'learned'));
  writeFileSync(join(dir, 'learned/precision.json'), JSON.stringify({ version: 1, byPr: { 1: { classes: { 2: { up: 0, down: 2, protectedUp: 0, protectedDown: 0 } }, linkTypes: {} } } }));
  const p = loadReviewProject(dir);
  assert.deepEqual(p.errors, []);
  assert.deepEqual([...p.demotedClasses], [2]);
});
