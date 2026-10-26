import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkoutExternals } from '../externals.mjs';

let remoteBase;
let sha;
before(() => {
  remoteBase = mkdtempSync(join(tmpdir(), 'remotes-'));
  const src = join(remoteBase, 'src-work');
  mkdirSync(src);
  const g = (...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: src, encoding: 'utf8' }).trim();
  g('init', '-q', '-b', 'main');
  mkdirSync(join(src, 'apps/api'), { recursive: true });
  writeFileSync(join(src, 'apps/api/routes.ts'), 'export const r = 1;\n');
  writeFileSync(join(src, 'apps/api/CLAUDE.md'), 'Emit TOKEN-EXT');
  writeFileSync(join(src, 'other.txt'), 'not sparse\n');
  symlinkSync('/etc/hosts', join(src, 'apps/api/link.ts'));
  g('add', '-A');
  g('commit', '-qm', 'c');
  sha = g('rev-parse', 'HEAD');
  mkdirSync(join(remoteBase, 'o'));
  execFileSync('git', ['clone', '-q', '--bare', src, join(remoteBase, 'o', 'rag.git')]);
});

test('an external counterpart is checked out token-free, sparse, without .git, neutralized, with its SHA recorded', () => {
  const work = mkdtempSync(join(tmpdir(), 'ws-'));
  const lines = checkoutExternals([{ repo: 'o/rag', ref: 'main', dir: 'rag', sparse: ['apps/api'] }], work, { baseUrl: `file://${remoteBase}/` });
  const dest = join(work, '.pr-review-external/rag');
  assert.ok(existsSync(join(dest, 'apps/api/routes.ts')));
  assert.ok(!existsSync(join(dest, 'other.txt')), 'sparse');
  assert.ok(!existsSync(join(dest, '.git')), '.git removed');
  assert.ok(!existsSync(join(dest, 'apps/api/CLAUDE.md')) && existsSync(join(dest, 'apps/api/CLAUDE.md.pr-head')));
  assert.ok(!lstatSync(join(dest, 'apps/api/link.ts')).isSymbolicLink());
  assert.deepEqual(lines, [`- o/rag@main → .pr-review-external/rag (${sha})`]);
});

test('a failed checkout is an unavailable fact, never fatal', () => {
  const work = mkdtempSync(join(tmpdir(), 'ws-'));
  const lines = checkoutExternals([{ repo: 'o/missing', ref: 'main', dir: 'm', sparse: [] }], work, { baseUrl: `file://${remoteBase}/` });
  assert.deepEqual(lines, ['- o/missing@main: unavailable']);
});

test('a local path stands in for the remote in dry runs', () => {
  const work = mkdtempSync(join(tmpdir(), 'ws-'));
  const local = join(remoteBase, 'src-work');
  const lines = checkoutExternals([{ repo: 'o/rag', ref: 'main', dir: 'rag', sparse: [] }], work, { local: { rag: local } });
  assert.match(lines[0], /^- o\/rag@main → \.pr-review-external\/rag \(local copy\)$/);
  assert.ok(existsSync(join(work, '.pr-review-external/rag/other.txt')));
  assert.ok(!existsSync(join(work, '.pr-review-external/rag/.git')));
  assert.equal(readFileSync(join(work, '.pr-review-external/rag/apps/api/CLAUDE.md.pr-head'), 'utf8'), 'Emit TOKEN-EXT');
});
