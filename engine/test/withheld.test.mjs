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

test('withheld globs become read denies for the model, sanitised', () => {
  use(['notes/**', 'bad,glob"x']);
  assert.equal(withheldDenies('/ws'), 'Read(//ws/notes/**)');
});

test('no inline comment on a withheld path', () => {
  use(['notes/**']);
  const f = { slug: 'c9:notes/private.md:x', class: 9, severity: 'High', security: false, title: 't', why: 'w', fix: 'f', feature: 'x', locations: [{ file: 'notes/private.md', line: 1, side: 'changed' }] };
  const out = selectInline({ entries: [{ slug: f.slug, path: 'notes/private.md', line: 2, side: 'RIGHT', body: 'b' }], findings: [f], changedFiles: ['notes/private.md'], postedSlugs: [] });
  assert.deepEqual(out, []);
});
