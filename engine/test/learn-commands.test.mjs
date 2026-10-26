import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runLearnCommands } from '../learn/commands.mjs';

let root;
before(() => {
  root = mkdtempSync(join(tmpdir(), 'cmds-'));
  const g = (...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: root });
  g('init', '-q', '-b', 'main');
  writeFileSync(join(root, 'docs.md'), 'see .pr-review/false-positives.md\n');
  g('add', '-A');
  g('commit', '-qm', 'c');
});

const proposed = { '.pr-review/false-positives.md': '# FP\n\n- rule   with   spaces\n' };

test('format commands rewrite the proposed files in a scratch tree; the checkout is untouched', () => {
  const fmt = `node -e "const fs=require('fs');for(const f of process.argv.slice(1))fs.writeFileSync(f,fs.readFileSync(f,'utf8').replace(/ +/g,' '))" {files}`;
  const r = runLearnCommands({ root, proposed, commands: { format: [fmt], validate: ['test -f docs.md'] } });
  assert.equal(r.ok, true);
  assert.equal(r.texts['.pr-review/false-positives.md'], '# FP\n\n- rule with spaces\n');
  assert.deepEqual(r.results.map((x) => [x.kind, x.ok]), [['format', true], ['validate', true]]);
  assert.throws(() => readFileSync(join(root, '.pr-review/false-positives.md')), 'nothing written to the checkout');
});

test('a failing validate command stops the proposal', () => {
  const r = runLearnCommands({ root, proposed, commands: { format: [], validate: ['grep -q "rule" .pr-review/false-positives.md && exit 3'] } });
  assert.equal(r.ok, false);
  assert.deepEqual(r.results.map((x) => x.ok), [false]);
});

test('commands see no secrets from the environment', () => {
  process.env.PR_REVIEW_TEST_SECRET = 'shh';
  const r = runLearnCommands({ root, proposed, commands: { validate: ['test -z "$PR_REVIEW_TEST_SECRET" && test -z "$GH_TOKEN"'] } });
  delete process.env.PR_REVIEW_TEST_SECRET;
  assert.equal(r.ok, true);
});
