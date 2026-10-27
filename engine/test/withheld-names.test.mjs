// P0.3 low (e): a withheld path's NAME can be sensitive (client or person
// names), so the model sees it only as a hash: diff stub headers, built-in
// facts and the model's state copy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, setActiveProject } from '../lib/config.mjs';
import { hidePath, withholdDiff } from '../lib/withheld.mjs';
import { buildFacts } from '../lib/facts-render.mjs';

const SECRET_NAME = 'docs/firm/Jane Doe offer letter.md';
setActiveProject({ dir: '/x/.pr-review', routing: [], linkTypes: [], errors: [], config: normalizeConfig({ version: 1, project: 'p', classes: [{ id: 1, name: 'x' }], withheld: ['docs/firm/**'] }).config });

test('stub headers carry a hash, never the withheld file name', () => {
  const diff = `diff --git a/${SECRET_NAME} b/${SECRET_NAME}\n--- a/${SECRET_NAME}\n+++ b/${SECRET_NAME}\n@@ -1 +1 @@\n-old\n+new salary\ndiff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-a\n+b\n`;
  const out = withholdDiff(diff);
  assert.ok(!out.includes('Jane'), 'name never shown');
  assert.ok(!out.includes('salary'), 'content never shown');
  assert.match(out, /^diff --git a\/withheld:[0-9a-f]{8} b\/withheld:[0-9a-f]{8}$/m);
  assert.match(out, /README\.md/, 'public files untouched');
});

test('built-in facts and drift lists show withheld paths only as hashes', () => {
  const facts = buildFacts({ files: [], routeResult: { packages: [], linkTypes: [], classes: [] }, tier: 'base-drift', driftFiles: [SECRET_NAME, 'src/a.ts'],
    results: [{ check: 'secrets', facts: [{ check: 'secrets', file: SECRET_NAME, line: 3, note: `possible key in ${SECRET_NAME}` }] }] });
  assert.ok(!facts.includes('Jane'), facts);
  assert.match(facts, /withheld:[0-9a-f]{8}:3/);
  assert.match(facts, /src\/a\.ts/);
  assert.equal(hidePath('src/a.ts'), 'src/a.ts');
});

test('withheld names with spaces are hidden whole when the PR changes them', async () => {
  const { setKnownPaths, hidePathsIn } = await import('../lib/withheld.mjs');
  const spaced = 'docs/firm/Comprehensive Context/TWK Fee Schedule.pdf';
  setKnownPaths([SECRET_NAME, spaced, 'src/a.ts']);
  const note = hidePathsIn(`changed ${SECRET_NAME} and ${spaced} and src/a.ts`);
  assert.ok(!/Jane|Doe|offer|Fee Schedule|Comprehensive/.test(note), note);
  assert.equal((note.match(/withheld:[0-9a-f]{8}/g) ?? []).length, 2);
  assert.match(note, /src\/a\.ts/);
  setKnownPaths([]);
});
