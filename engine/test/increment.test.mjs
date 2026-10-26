import './helpers/rp.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { classify } from '../lib/tier.mjs';
import { computeIncrement } from '../lib/increment.mjs';

let root;
const g = (...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: root, encoding: 'utf8' }).trim();
const put = (p, c) => { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), c); };
const commit = (msg) => { g('add', '-A'); g('commit', '-m', msg); return g('rev-parse', 'HEAD'); };
const SHAS = {};

before(() => {
  root = mkdtempSync(join(tmpdir(), 'incr-'));
  g('init', '-q', '-b', 'main');
  put('seed.txt', 's');
  SHAS.base0 = commit('base0');
  g('checkout', '-q', '-b', 'pr');
  put('recovery-api/src/callable/x.ts', 'export const x = 1;\n');
  SHAS.p1 = commit('p1');
  put('README.md', 'doc\n');
  SHAS.p2 = commit('p2');
  g('checkout', '-q', 'main');
  put('homegroups/mobile/src/a.ts', 'a\n');
  SHAS.base1 = commit('base1');
  g('checkout', '-q', 'pr');
  g('merge', '-q', '--no-edit', 'main');
  SHAS.p3 = g('rev-parse', 'HEAD');
});
after(() => rmSync(root, { recursive: true, force: true }));

const args = (o) => ({ prPaths: ['recovery-api/src/callable/x.ts'], cwd: root, ...o });

test('increment lists only files after the last reviewed sha', () => {
  const r = computeIncrement(args({ lastReviewedSha: SHAS.p1, lastBaseSha: SHAS.base0, baseSha: SHAS.base0, headSha: SHAS.p2 }));
  assert.equal(r.reachable, true);
  assert.deepEqual(r.incrementFiles, ['README.md']);
  assert.deepEqual(r.incrementDiff.map((f) => f.file), ['README.md']);
  assert.deepEqual(r.incrementLinkTypes, []);
  assert.equal(r.prDiffUnchanged, false);
});

test('whitespace-only re-indent with same base is not unchanged', () => {
  g('checkout', '-q', '-b', 'ws', SHAS.p1);
  put('recovery-api/src/callable/x.yml', 'a:\n  b: 1\n');
  const w1 = commit('w1');
  put('recovery-api/src/callable/x.yml', 'a:\n    b: 1\n');
  const w2 = commit('w2');
  const r = computeIncrement(args({ lastReviewedSha: w1, lastBaseSha: SHAS.base0, baseSha: SHAS.base0, headSha: w2 }));
  assert.deepEqual(r.incrementFiles, ['recovery-api/src/callable/x.yml']);
  assert.equal(r.prDiffUnchanged, false);
  assert.equal(classify({ ...r, lastReviewedSha: w1, linkTypesSeen: ['callable'], prFileCount: 4 }) !== 'none', true);
  assert.notEqual(classify({ ...r, lastReviewedSha: w1, linkTypesSeen: ['callable'], prFileCount: 4 }), 'base-drift');
  g('checkout', '-q', 'pr');
});

test('merge from base: increment excludes other PRs files', () => {
  const r = computeIncrement(args({ lastReviewedSha: SHAS.p2, lastBaseSha: SHAS.base0, baseSha: SHAS.base1, headSha: SHAS.p3 }));
  assert.deepEqual(r.incrementFiles, []);
  assert.deepEqual(r.incrementDiff, []);
});

test('unreachable or invalid last sha is not reachable', () => {
  for (const bad of ['f'.repeat(40), '--upload-pack=x', null]) {
    const r = computeIncrement(args({ lastReviewedSha: bad, lastBaseSha: SHAS.base0, baseSha: SHAS.base0, headSha: SHAS.p2 }));
    assert.equal(r.reachable, false);
  }
});

test('base merge with same PR patch has an unchanged PR diff and reports counterpart drift', () => {
  const r = computeIncrement(args({ lastReviewedSha: SHAS.p2, lastBaseSha: SHAS.base0, baseSha: SHAS.base1, headSha: SHAS.p3 }));
  assert.equal(r.reachable, true);
  assert.equal(r.prDiffUnchanged, true);
  assert.equal(r.baseDriftCounterpartsChanged, true);
  assert.deepEqual(r.driftFiles, ['homegroups/mobile/src/a.ts']);
});

test('missing old base degrades to changed, not unchanged', () => {
  const r = computeIncrement(args({ lastReviewedSha: SHAS.p2, lastBaseSha: 'e'.repeat(40), baseSha: SHAS.base1, headSha: SHAS.p3 }));
  assert.equal(r.reachable, true);
  assert.equal(r.prDiffUnchanged, false);
});

const tierOf = (r, last, seen = ['callable']) => classify({ ...r, lastReviewedSha: last, linkTypesSeen: seen, prFileCount: 10 });

test('reverting a PR-modified file to base content stays in the increment', () => {
  g('checkout', '-q', '-B', 'rv', SHAS.base0);
  put('seed.txt', 'changed');
  const q1 = commit('q1');
  put('seed.txt', 's');
  const q2 = commit('q2');
  const r = computeIncrement(args({ prPaths: ['seed.txt'], lastReviewedSha: q1, lastBaseSha: SHAS.base0, baseSha: SHAS.base0, headSha: q2 }));
  assert.deepEqual(r.incrementFiles, ['seed.txt']);
  assert.notEqual(tierOf(r, q1), 'none');
  // merge base and revert in one push
  g('checkout', '-q', '-B', 'rv2', q1);
  g('merge', '-q', '--no-edit', 'main');
  put('seed.txt', 's');
  const q3 = commit('q3');
  const m = computeIncrement(args({ prPaths: ['seed.txt'], lastReviewedSha: q1, lastBaseSha: SHAS.base0, baseSha: SHAS.base1, headSha: q3 }));
  assert.deepEqual(m.incrementFiles, ['seed.txt']);
  assert.notEqual(tierOf(m, q1), 'none');
});

test('deleting a PR-added file stays in the increment', () => {
  g('checkout', '-q', '-B', 'del', SHAS.p2);
  g('rm', '-q', 'recovery-api/src/callable/x.ts');
  const d = commit('del');
  const r = computeIncrement(args({ lastReviewedSha: SHAS.p2, lastBaseSha: SHAS.base0, baseSha: SHAS.base0, headSha: d }));
  assert.deepEqual(r.incrementFiles, ['recovery-api/src/callable/x.ts']);
  assert.notEqual(tierOf(r, SHAS.p2), 'none');
});

test('pure base merge: none without counterpart drift, base-drift with it', () => {
  g('checkout', '-q', '-B', 'b2', SHAS.base0);
  put('other/z.txt', 'z');
  const base2 = commit('base2');
  g('checkout', '-q', '-B', 'pm', SHAS.p2);
  g('merge', '-q', '--no-edit', base2);
  const head = g('rev-parse', 'HEAD');
  const none = computeIncrement(args({ lastReviewedSha: SHAS.p2, lastBaseSha: SHAS.base0, baseSha: base2, headSha: head }));
  assert.deepEqual(none.incrementFiles, []);
  assert.equal(tierOf(none, SHAS.p2), 'none');
  const drift = computeIncrement(args({ lastReviewedSha: SHAS.p2, lastBaseSha: SHAS.base0, baseSha: SHAS.base1, headSha: SHAS.p3 }));
  assert.equal(tierOf(drift, SHAS.p2), 'base-drift');
});

test('base moved and PR content changed: diff hashes differ, tier is not none', () => {
  g('checkout', '-q', '-B', 'mv', SHAS.p3);
  put('recovery-api/src/callable/x.ts', 'export const x = 2;\n');
  const head = commit('p4');
  const r = computeIncrement(args({ lastReviewedSha: SHAS.p2, lastBaseSha: SHAS.base0, baseSha: SHAS.base1, headSha: head }));
  assert.equal(r.reachable, true);
  assert.equal(r.prDiffUnchanged, false, 'hashes of base0...p2 and base1...p4 differ');
  assert.deepEqual(r.incrementFiles, ['recovery-api/src/callable/x.ts']);
  const tier = tierOf(r, SHAS.p2);
  assert.notEqual(tier, 'none');
  assert.notEqual(tier, 'base-drift');
  g('checkout', '-q', 'pr');
});
