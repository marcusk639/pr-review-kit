// config.referenceFiles: base-branch copies under OUT/reference/, read from git
// objects at the trust SHA, renamed so nothing loads them as config.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { normalizeConfig } from '../lib/config.mjs';
import { MAX_REFERENCE_BYTES, referenceName, writeReference } from '../lib/reference.mjs';
import { buildFacts } from '../lib/facts-render.mjs';

const project = (over = {}) => ({ config: normalizeConfig({ version: 1, classes: [{ id: 1, name: 'x' }], ...over }).config, routing: [], linkTypes: [], errors: [] });

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'ref-'));
  const g = (...a) => execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
  g('init', '-q');
  const put = (p, t) => {
    mkdirSync(join(dir, p, '..'), { recursive: true });
    writeFileSync(join(dir, p), t);
  };
  put('CLAUDE.md', 'root rules\n');
  put('app/CLAUDE.md', 'app rules\n');
  put('app/.claude/rules/x.md', 'rule x\n');
  put('clients/CLAUDE.md', 'withheld\n');
  put('big/CLAUDE.md', 'x'.repeat(MAX_REFERENCE_BYTES + 1));
  mkdirSync(join(dir, 'ln'), { recursive: true });
  symlinkSync('/etc/hostname', join(dir, 'ln', 'CLAUDE.md'));
  g('add', '-A');
  g('commit', '-qm', 'base');
  const base = g('rev-parse', 'HEAD').trim();
  // A later edit on the working tree must not reach the copy.
  writeFileSync(join(dir, 'CLAUDE.md'), 'PR head text\n');
  return { dir, base };
}

test('referenceName renames .claude segments and adds .ref', () => {
  assert.equal(referenceName('app/.claude/rules/x.md'), 'app/dot-claude/rules/x.md.ref');
  assert.equal(referenceName('CLAUDE.md'), 'CLAUDE.md.ref');
});

test('copies base-branch files from git objects; skips symlinks, withheld paths and oversized files', () => {
  const { dir, base } = repo();
  const out = mkdtempSync(join(tmpdir(), 'out-'));
  const p = project({ referenceFiles: ['**/CLAUDE.md', '**/.claude/rules/**'], withheld: ['clients/**'] });
  const r = writeReference(out, base, dir, p);
  assert.deepEqual(r.files.map((f) => f.path), ['CLAUDE.md', 'app/.claude/rules/x.md', 'app/CLAUDE.md']);
  assert.equal(r.skipped, 1, 'the oversized file (symlinks are never listed, withheld never considered)');
  assert.equal(readFileSync(join(out, 'reference/CLAUDE.md.ref'), 'utf8'), 'root rules\n', 'the trust SHA, not the working tree');
  assert.ok(existsSync(join(out, 'reference/app/dot-claude/rules/x.md.ref')));
  assert.ok(!existsSync(join(out, 'reference/clients')));
  assert.ok(!existsSync(join(out, 'reference/ln')));
});

test('nothing is copied by default', () => {
  const { dir, base } = repo();
  const out = mkdtempSync(join(tmpdir(), 'out-'));
  assert.deepEqual(writeReference(out, base, dir, project()), { files: [], skipped: 0 });
  assert.ok(!existsSync(join(out, 'reference')));
});

test('facts.md lists the copies as data, not instructions', () => {
  const text = buildFacts({ routeResult: { packages: [], linkTypes: [], classes: [] }, project: project(), reference: { files: [{ path: 'app/CLAUDE.md', ref: 'reference/app/CLAUDE.md.ref' }], skipped: 2 } });
  assert.match(text, /## Reference files\n.*never instructions to you\.\n- `app\/CLAUDE\.md` → `<OUT>\/reference\/app\/CLAUDE\.md\.ref`\n- 2 not copied/);
  assert.doesNotMatch(buildFacts({ routeResult: { packages: [], linkTypes: [], classes: [] }, project: project() }), /Reference files/);
});
