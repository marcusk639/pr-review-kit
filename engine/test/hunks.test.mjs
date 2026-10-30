// Spec addendum §4.2: facts records each changed file's RIGHT-side hunk ranges
// (added + context lines) in the trusted snapshot, so publish can check a
// suggestion's lines against the real diff instead of trusting the model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hunkRanges, MAX_HUNKS_PER_FILE, sanitizeHunkRanges } from '../lib/hunks.mjs';

const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1..2 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,3 +1,4 @@',
  ' one',
  '+two',
  ' three',
  ' four',
  '@@ -40,2 +41,3 @@ function f() {',
  ' x',
  '+y',
  ' z',
  'diff --git a/src/new.ts b/src/new.ts',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/src/new.ts',
  '@@ -0,0 +1 @@',
  '+only',
  'diff --git a/src/gone.ts b/src/gone.ts',
  'deleted file mode 100644',
  '--- a/src/gone.ts',
  '+++ /dev/null',
  '@@ -1,2 +0,0 @@',
  '-a',
  '-b',
  'diff --git a/src/old.ts b/src/moved.ts',
  'similarity index 90%',
  'rename from src/old.ts',
  'rename to src/moved.ts',
  '--- a/src/old.ts',
  '+++ b/src/moved.ts',
  '@@ -5,2 +5,0 @@',
  '-gone1',
  '-gone2',
  '@@ -9 +7,2 @@',
  '-p',
  '+q',
  '+r',
  '',
].join('\n');

test('hunkRanges: RIGHT-side [start, end] per hunk, keyed by the new path', () => {
  assert.deepEqual(hunkRanges(DIFF), {
    'src/a.ts': [[1, 4], [41, 43]],
    'src/new.ts': [[1, 1]],
    'src/moved.ts': [[7, 8]],
  });
});

test('hunkRanges: a deleted file and an empty-RIGHT hunk contribute nothing', () => {
  const r = hunkRanges(DIFF);
  assert.equal(r['src/gone.ts'], undefined);
  assert.ok(!r['src/moved.ts'].some(([s]) => s === 5));
});

test('hunkRanges: bounded per file, and empty or junk input gives {}', () => {
  const many = ['diff --git a/x.ts b/x.ts', '--- a/x.ts', '+++ b/x.ts'];
  for (let i = 0; i < MAX_HUNKS_PER_FILE + 5; i++) many.push(`@@ -${i * 10 + 1},1 +${i * 10 + 1},1 @@`, ' c');
  assert.equal(hunkRanges(many.join('\n'))['x.ts'].length, MAX_HUNKS_PER_FILE);
  assert.deepEqual(hunkRanges(''), {});
  assert.deepEqual(hunkRanges(null), {});
});

test('sanitizeHunkRanges keeps only well-formed [start, end] pairs', () => {
  const v = sanitizeHunkRanges({
    'a.ts': [[1, 4], [5, 2], [0, 3], ['1', 2], [1.5, 2], [7, 7]],
    'b.ts': 'nope',
    'c.ts': [],
  });
  assert.deepEqual(v, { 'a.ts': [[1, 4], [7, 7]] });
  assert.deepEqual(sanitizeHunkRanges(null), {});
  assert.deepEqual(sanitizeHunkRanges([[1, 2]]), {});
});

test('readPrDiff: one git diff gives the parsed files and their hunk ranges', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const { readPrDiff } = await import('../lib/hunks.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'hunks-'));
  const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q');
  writeFileSync(join(dir, 'a.ts'), Array.from({ length: 30 }, (_, i) => `line${i + 1}`).join('\n') + '\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  writeFileSync(join(dir, 'a.ts'), Array.from({ length: 30 }, (_, i) => (i === 19 ? 'changed' : `line${i + 1}`)).join('\n') + '\n');
  git('commit', '-qam', 'head');
  const head = git('rev-parse', 'HEAD');
  const r = readPrDiff(base, head, dir);
  assert.deepEqual(r.files.map((f) => f.file), ['a.ts']);
  assert.deepEqual(r.hunkRanges, { 'a.ts': [[17, 23]] });
});

test('facts takes hunkRanges from the full base...head PR diff, whatever the tier', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../facts.mjs', import.meta.url), 'utf8');
  assert.match(src, /const \{ files: prFiles, hunkRanges \} = readPrDiff\(BASE_SHA, HEAD_SHA, repoRoot\);\n\s+state\.hunkRanges = hunkRanges;/);
  assert.ok(src.indexOf('readPrDiff(BASE_SHA, HEAD_SHA') < src.indexOf('classify('), 'read before the tier is chosen');
  assert.doesNotMatch(src, /hunkRanges\s*=\s*[^;]*increment/i);
});
