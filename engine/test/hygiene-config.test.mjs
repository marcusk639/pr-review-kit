import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { RP } from './helpers/rp.mjs';
import { normalizeConfig, setActiveProject } from '../lib/config.mjs';
import { checkPiiLogs, checkNewFileSize, checkTitleScope, checkSelfEdit, checkEnginePin } from '../hygiene.mjs';
import { redact } from '../lib/redact.mjs';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const use = (raw) => setActiveProject({ config: normalizeConfig({ version: 1, project: 'p', classes: [{ id: 1, name: 'x' }], ...raw }).config, routing: [], linkTypes: [], errors: [] });
const file = (o) => ({ file: 'src/a.ts', oldFile: 'src/a.ts', status: 'M', binary: false, added: [], removed: [], ...o });
const add = (...lines) => lines.map((text, i) => ({ line: i + 1, text }));

afterEach(() => setActiveProject(RP));

test('PII field names come from the config', () => {
  use({ checks: { piiLogs: { fields: 'clientTaxId', logCall: '\\blog\\(' } } });
  assert.equal(checkPiiLogs([file({ added: add('log(clientTaxId)') })]).length, 1);
  assert.deepEqual(checkPiiLogs([file({ added: add('console.log(email)') })]), []);
});

test('a disabled check returns no facts', () => {
  use({ checks: { piiLogs: false, newFileSize: false, titleScope: false } });
  assert.deepEqual(checkPiiLogs([file({ added: add('console.log(email)') })]), []);
  assert.deepEqual(checkTitleScope('fix(mobile): x'), []);
  const root = mkdtempSync(join(tmpdir(), 'size-'));
  writeFileSync(join(root, 'big.ts'), 'x\n'.repeat(400));
  assert.deepEqual(checkNewFileSize([file({ file: 'big.ts', status: 'A' })], root), []);
});

test('new-file size limit and pattern come from the config', () => {
  use({ checks: { newFileSize: { maxLines: 10, pattern: '\\.py$' } } });
  const root = mkdtempSync(join(tmpdir(), 'size-'));
  writeFileSync(join(root, 'a.py'), 'x\n'.repeat(11));
  writeFileSync(join(root, 'b.ts'), 'x\n'.repeat(11));
  const facts = checkNewFileSize([file({ file: 'a.py', status: 'A' }), file({ file: 'b.ts', status: 'A' })], root);
  assert.deepEqual(facts.map((f) => f.file), ['a.py']);
  assert.match(facts[0].note, /limit 10/);
});

test('bare title scopes come from the config', () => {
  use({ checks: { titleScope: { bareScopes: ['api'] } } });
  assert.equal(checkTitleScope('feat(api): x').length, 1);
  assert.deepEqual(checkTitleScope('fix(mobile): x'), []);
});

test('self-edit covers the configured review and learning workflows', () => {
  use({ workflowPath: '.github/workflows/review.yml', learnWorkflowPath: '.github/workflows/learn.yml' });
  const [wf] = checkSelfEdit([file({ file: '.github/workflows/review.yml' })]);
  assert.match(wf.note, /takes effect in this run/);
  assert.equal(checkSelfEdit([file({ file: '.github/workflows/learn.yml' })]).length, 1);
  assert.equal(checkSelfEdit([file({ file: '.pr-review/learned/lessons.json' })]).length, 1);
  assert.deepEqual(checkSelfEdit([file({ file: '.github/workflows/claude-code-review.yml' })]), []);
});

test('engine pin: a changed kit SHA in the workflow is reported, an unchanged one is not', () => {
  use({ workflowPath: '.github/workflows/review.yml' });
  const a = 'a'.repeat(40);
  const b = 'b'.repeat(40);
  const wf = (sha) => `uses: marcusk639/pr-review-kit/actions/review@${sha}\n`;
  const facts = checkEnginePin({ base: wf(a), head: wf(b) });
  assert.equal(facts.length, 1);
  assert.match(facts[0].note, /aaaaaaa.*bbbbbbb/);
  assert.deepEqual(checkEnginePin({ base: wf(a), head: wf(a) }), []);
  assert.match(checkEnginePin({ base: wf(a), head: 'uses: marcusk639/pr-review-kit/actions/review@main\n' })[0].note, /not pinned/);
  assert.deepEqual(checkEnginePin({ base: null, head: wf(a) }), []);
});

test('extra secret patterns from the config are redacted', () => {
  use({ secrets: { extraPatterns: ['snow_[A-Za-z0-9]{12,}'] } });
  assert.equal(redact('k=snow_abcdefghijklmnop'), 'k=snow_a…');
});

test('new-file size never reads through a symlinked file or directory', async () => {
  const { symlinkSync, mkdirSync } = await import('node:fs');
  const root = mkdtempSync(join(tmpdir(), 'size-'));
  const outside = mkdtempSync(join(tmpdir(), 'outside-'));
  writeFileSync(join(outside, 'big.ts'), 'x\n'.repeat(400));
  symlinkSync(join(outside, 'big.ts'), join(root, 'link.ts'));
  symlinkSync(outside, join(root, 'dir'));
  mkdirSync(join(root, 'real'));
  assert.deepEqual(checkNewFileSize([file({ file: 'link.ts', status: 'A' }), file({ file: 'dir/big.ts', status: 'A' })], root), []);
});
