import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readAt, listAt } from '../lib/git-read.mjs';

let root;
let sha;
before(() => {
  root = mkdtempSync(join(tmpdir(), 'gitread-'));
  const g = (...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: root, encoding: 'utf8' }).trim();
  g('init', '-q', '-b', 'main');
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/a.ts'), 'export const a = 1;\n');
  writeFileSync(join(root, 'env.example'), 'X=1\n');
  symlinkSync('/etc/hosts', join(root, 'src/link.ts'));
  g('add', '-A');
  g('commit', '-qm', 'c');
  sha = g('rev-parse', 'HEAD');
});
after(() => rmSync(root, { recursive: true, force: true }));

test('readAt reads a committed regular file from git objects, not the working tree', () => {
  writeFileSync(join(root, 'src/a.ts'), 'changed on disk\n');
  assert.equal(readAt(sha, 'src/a.ts', root), 'export const a = 1;\n');
});

test('readAt refuses symlinks, missing paths, traversal and option-like paths', () => {
  assert.equal(readAt(sha, 'src/link.ts', root), null);
  assert.equal(readAt(sha, 'nope.ts', root), null);
  assert.equal(readAt(sha, '../x', root), null);
  assert.equal(readAt(sha, '--output=/tmp/x', root), null);
  assert.equal(readAt('not-a-sha', 'src/a.ts', root), null);
});

test('listAt lists committed regular files matching a glob, never symlinks', () => {
  assert.deepEqual(listAt(sha, 'src/**', root), ['src/a.ts']);
  assert.deepEqual(listAt(sha, '*.example', root), ['env.example']);
});

test('diffs report non-ASCII and spaced paths unquoted', async () => {
  const { prDiff } = await import('../lib/diff.mjs');
  const g = (...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: root, encoding: 'utf8' }).trim();
  writeFileSync(join(root, 'Résumé — draft.md'), 'x\n');
  g('add', 'Résumé — draft.md');
  g('commit', '-qm', 'accents');
  const next = g('rev-parse', 'HEAD');
  assert.deepEqual(prDiff(sha, next, root).map((f) => f.file), ['Résumé — draft.md']);
  assert.deepEqual(listAt(next, '*.md', root), ['Résumé — draft.md']);
});
