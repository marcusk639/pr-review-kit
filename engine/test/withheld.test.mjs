import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { RP } from './helpers/rp.mjs';
import { normalizeConfig, setActiveProject } from '../lib/config.mjs';
import { withholdDiff, withheldDenies } from '../lib/withheld.mjs';
import { selectInline } from '../lib/inline-post.mjs';

afterEach(() => setActiveProject(RP));
const use = (withheld) => setActiveProject({ ...RP, config: normalizeConfig({ version: 1, project: 'p', classes: [{ id: 9, name: 'x' }], withheld }).config });

const DIFF = [
  'diff --git a/notes/private.md b/notes/private.md',
  'index 1..2 100644',
  '--- a/notes/private.md',
  '+++ b/notes/private.md',
  '@@ -1,1 +1,3 @@',
  ' old',
  '+client name: Jane',
  '+account 1234',
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1 +1 @@',
  '-a',
  '+b',
  '',
].join('\n');

test('withheld files keep their header but lose their content in the model diff', () => {
  use(['notes/**']);
  const out = withholdDiff(DIFF);
  assert.doesNotMatch(out, /Jane|1234|old/);
  assert.match(out, /diff --git a\/notes\/private\.md b\/notes\/private\.md\n\[content withheld by config: 2 line\(s\) added, 0 removed\]\n/);
  assert.match(out, /\+b\n/);
});

test('nothing is withheld without patterns', () => {
  use([]);
  assert.equal(withholdDiff(DIFF), DIFF);
});

test('withheld globs become read denies for the model; an unsafe one is a hard error, never dropped', () => {
  use(['notes/**']);
  assert.equal(withheldDenies('/ws'), 'Read(//ws/notes/**),Read(//ws/notes/**.pr-head)');
  use(['notes/**', 'bad,glob"x']);
  assert.throws(() => withheldDenies('/ws'));
});

test('no inline comment on a withheld path', () => {
  use(['notes/**']);
  const f = { slug: 'c9:notes/private.md:x', class: 9, severity: 'High', security: false, title: 't', why: 'w', fix: 'f', feature: 'x', locations: [{ file: 'notes/private.md', line: 1, side: 'changed' }] };
  const out = selectInline({ entries: [{ slug: f.slug, path: 'notes/private.md', line: 2, side: 'RIGHT', body: 'b' }], findings: [f], changedFiles: ['notes/private.md'], postedSlugs: [] });
  assert.deepEqual(out, []);
});

test('withheld globs the Read deny cannot express are config errors, never silently dropped', async () => {
  const { normalizeConfig: n } = await import('../lib/config.mjs');
  const base = { version: 1, project: 'p', classes: [{ id: 9, name: 'x' }] };
  for (const bad of ['Café/**', 'My Notes/**', 'a b/**', 'x,y/**', 'a"b', '../up/**', '/abs/**', 'a/**b/c']) {
    assert.match(n({ ...base, withheld: [bad] }).errors.join(), /withheld/, bad);
  }
  assert.deepEqual(n({ ...base, withheld: ['Clients/**', 'notes/*.md', 'secret-?.txt'] }).errors, []);
});

test('the diff stub and the Read deny use one semantic, and the .pr-head variant is denied too', () => {
  use(['notes/*.md']);
  assert.equal(withheldDenies('/ws'), 'Read(//ws/notes/*.md),Read(//ws/notes/*.md.pr-head)');
  const nested = DIFF.replace(/notes\/private\.md/g, 'notes/deep/private.md');
  assert.match(withholdDiff(nested), /Jane/, '* stays within one segment in both');
});
