import './helpers/rp.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUnifiedDiff } from '../lib/diff.mjs';

const FIXTURE = `diff --git a/a.ts b/b.ts
similarity index 90%
rename from a.ts
rename to b.ts
index 1111111..2222222 100644
--- a/a.ts
+++ b/b.ts
@@ -10,3 +10,4 @@ export function f() {
 keep
+added line
 keep2
 keep3
diff --git a/gone.ts b/gone.ts
deleted file mode 100644
index 3333333..0000000
--- a/gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-one
-two
diff --git a/x.png b/x.png
index 4444444..5555555 100644
Binary files a/x.png and b/x.png differ
diff --git a/docs/a b.md b/docs/a b.md
new file mode 100644
index 0000000..6666666
--- /dev/null
+++ b/docs/a b.md
@@ -0,0 +1,2 @@
+# title
+++ not a header
`;

test('parseUnifiedDiff handles rename, delete, binary, spaces', () => {
  const files = parseUnifiedDiff(FIXTURE);
  assert.equal(files.length, 4);

  const [ren, del, bin, sp] = files;
  assert.equal(ren.status, 'R');
  assert.equal(ren.oldFile, 'a.ts');
  assert.equal(ren.file, 'b.ts');
  assert.deepEqual(ren.added, [{ line: 11, text: 'added line' }]);

  assert.equal(del.status, 'D');
  assert.equal(del.file, 'gone.ts');
  assert.deepEqual(del.added, []);

  assert.equal(bin.binary, true);
  assert.equal(bin.file, 'x.png');
  assert.deepEqual(bin.added, []);

  assert.equal(sp.file, 'docs/a b.md');
  assert.equal(sp.status, 'A');
  assert.equal(sp.binary, false);
  assert.deepEqual(sp.added, [
    { line: 1, text: '# title' },
    { line: 2, text: '++ not a header' },
  ]);
});

test('parseUnifiedDiff records removed lines with old line numbers', () => {
  const files = parseUnifiedDiff(`diff --git a/m.ts b/m.ts
--- a/m.ts
+++ b/m.ts
@@ -5,3 +5,3 @@
 keep
-old
+new
 keep
diff --git a/gone.ts b/gone.ts
deleted file mode 100644
--- a/gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-one
-two
`);
  assert.deepEqual(files[0].removed, [{ line: 6, text: 'old' }]);
  assert.deepEqual(files[1].removed, [
    { line: 1, text: 'one' },
    { line: 2, text: 'two' },
  ]);
});

// A PR can mark any file binary in .gitattributes (`-diff`); its content must
// still reach the pre-checks and the model's pr.diff.
test('prDiffText shows content of a file a PR marks -diff in .gitattributes', async () => {
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { prDiffText } = await import('../lib/diff.mjs');
  const root = mkdtempSync(join(tmpdir(), 'difftext-'));
  const g = (...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: root, encoding: 'utf8' }).trim();
  try {
    g('init', '-q', '-b', 'main');
    writeFileSync(join(root, 'seed.txt'), 's\n');
    g('add', '-A');
    g('commit', '-q', '-m', 'base');
    const base = g('rev-parse', 'HEAD');
    writeFileSync(join(root, '.gitattributes'), 'hidden.ts -diff\n');
    writeFileSync(join(root, 'hidden.ts'), 'export const hiddenValue = 1;\n');
    g('add', '-A');
    g('commit', '-q', '-m', 'pr');
    const text = prDiffText(base, g('rev-parse', 'HEAD'), root);
    assert.match(text, /\+export const hiddenValue = 1;/);
    assert.doesNotMatch(text, /Binary files/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
