import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RP } from './helpers/rp.mjs';
import { setActiveProject } from '../lib/config.mjs';
import { loadProjectChecks, runProjectChecks } from '../lib/project-checks.mjs';
import { buildFacts } from '../facts.mjs';

const FACTS = fileURLToPath(new URL('../facts.mjs', import.meta.url));
const SHA = (c) => c.repeat(40);
let tmp;
const write = (p, text) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
};

before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'factsproj-'));
});
after(() => {
  execFileSync('chmod', ['-R', 'u+w', tmp]);
  rmSync(tmp, { recursive: true, force: true });
});
afterEach(() => setActiveProject(RP));

test('project checks load only from inside the project directory', async () => {
  const dir = join(tmp, 'p1');
  write(join(dir, 'checks/ok.mjs'), "export default [{ name: 'ok-check', run: () => [{ check: 'ok-check', file: 'a.ts', note: 'n' }] }];");
  write(join(tmp, 'outside.mjs'), "export default [{ name: 'evil', run: () => [] }];");
  const { checks, errors } = await loadProjectChecks(dir, ['checks/ok.mjs', '../outside.mjs', '/etc/x.mjs', 'checks/missing.mjs']);
  assert.deepEqual(checks.map((c) => c.name), ['ok-check']);
  assert.equal(errors.length, 3);
});

test('a project check that throws or returns junk is unavailable, never fatal', async () => {
  const dir = join(tmp, 'p2');
  write(join(dir, 'checks/c.mjs'), [
    "export default [",
    "  { name: 'thrower', run: () => { throw new Error('boom'); } },",
    "  { name: 'junk', run: () => 'nope' },",
    "  { name: 'good', run: ({ files }) => files.map((f) => ({ check: 'good', file: f.file, line: 2, note: 'saw it' })) },",
    "  { name: 'bad name!', run: () => [] },",
    "];",
  ].join('\n'));
  const { checks, errors } = await loadProjectChecks(dir, ['checks/c.mjs']);
  assert.equal(errors.length, 1, 'the badly named check is rejected');
  const results = runProjectChecks(checks, { files: [{ file: 'x.ts', added: [], removed: [] }] });
  assert.deepEqual(results.map((r) => [r.check, Boolean(r.error)]), [['thrower', true], ['junk', true], ['good', false]]);
  assert.deepEqual(results[2].facts, [{ check: 'good', file: 'x.ts', line: 2, note: 'saw it' }]);
});

test('facts.md states the project setup the procedure depends on', () => {
  const out = buildFacts({
    files: [],
    routeResult: { packages: [], linkTypes: [], classes: [13] },
    results: [],
    prContext: 'ctx',
    project: { ...RP, demotedClasses: new Set([9]) },
  });
  assert.match(out, /## Project\n/);
  assert.match(out, /Visibility: public; security channel: advisory/);
  assert.match(out, /- 1: Client-supplied IDs trusted for authorisation or money routing \(security\)/);
  assert.match(out, /- 13: PR text that claims things the code doesn't do \(always\)/);
  assert.match(out, /Demoted classes \(low precision; report only at high confidence, no inline comment\): 9/);
  assert.match(out, /Knowledge files: checklist\.md/);
  assert.match(out, /Inline comments: Critical, High findings only; at most 10 per run\./);
});

// End to end, offline: a temp repo with base and head commits and a base checkout.
function repoWith(baseConfig, { workflowBase, workflowHead } = {}) {
  const root = mkdtempSync(join(tmp, 'repo-'));
  const g = (...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: root, encoding: 'utf8' }).trim();
  g('init', '-q', '-b', 'main');
  write(join(root, 'src/a.ts'), 'export const a = 1;\n');
  if (workflowBase) write(join(root, '.github/workflows/pr-review.yml'), workflowBase);
  g('add', '-A');
  g('commit', '-qm', 'base');
  const base = g('rev-parse', 'HEAD');
  write(join(root, 'src/a.ts'), 'export const a = 2;\n');
  if (workflowHead) write(join(root, '.github/workflows/pr-review.yml'), workflowHead);
  g('add', '-A');
  g('commit', '-qm', 'head');
  const head = g('rev-parse', 'HEAD');
  const baseDir = join(root, '.review-base');
  mkdirSync(baseDir);
  if (baseConfig) {
    write(join(baseDir, '.pr-review/config.json'), JSON.stringify(baseConfig));
    write(join(baseDir, '.pr-review/routing.json'), JSON.stringify([{ linkType: 'api', paths: ['src/**'], counterparts: [], classes: [1] }]));
  }
  if (workflowBase) write(join(baseDir, '.github/workflows/pr-review.yml'), workflowBase);
  return { root, base, head, baseDir };
}

function runFacts({ root, base, head, baseDir }) {
  const out = join(root, '..', `out-${base.slice(0, 6)}`);
  const stateFile = join(root, '..', `snap-${base.slice(0, 6)}`, 'state.json');
  const ghOut = join(root, '..', `ghout-${base.slice(0, 6)}`);
  writeFileSync(ghOut, '');
  execFileSync('node', [FACTS], {
    cwd: root,
    env: { ...process.env, OUT: out, STATE_FILE: stateFile, GITHUB_OUTPUT: ghOut, BASE_SHA: base, HEAD_SHA: head, PR: '5', REPO: 'o/r', PR_TITLE: 'feat: x', PR_REVIEW_BASE: baseDir, PR_REVIEW_OFFLINE: '1' },
    encoding: 'utf8',
  });
  return { out, ghOutput: readFileSync(ghOut, 'utf8'), stateFile };
}

const CONFIG = { version: 1, project: 'demo', classes: [{ id: 1, name: 'one' }, { id: 2, name: 'two', always: true }] };

test('without a config on the base branch the review is skipped (tier none)', () => {
  const r = runFacts(repoWith(null));
  assert.match(r.ghOutput, /tier=none/);
  assert.match(r.ghOutput, /max_turns=0/);
});

test('an invalid base config skips the review rather than guessing', () => {
  const r = runFacts(repoWith({ ...CONFIG, bogus: true }));
  assert.match(r.ghOutput, /tier=none/);
});

test('with a config, facts writes the material, the procedure and a full-tier state', () => {
  const r = runFacts(repoWith(CONFIG));
  assert.match(r.ghOutput, /tier=full\nmax_turns=60/);
  for (const f of ['facts.md', 'state.json', 'pr.diff', 'commits.txt', 'REVIEW.md']) assert.ok(existsSync(join(r.out, f)), f);
  const facts = readFileSync(join(r.out, 'facts.md'), 'utf8');
  assert.match(facts, /## Link types\n- api/);
  assert.match(facts, /## Checklist classes\n- 1\n- 2/);
  const state = JSON.parse(readFileSync(r.stateFile, 'utf8'));
  assert.equal(state.tier, 'full');
  assert.equal(state.visibility, 'public');
  assert.match(readFileSync(join(r.out, 'REVIEW.md'), 'utf8'), /# PR review procedure/);
});

test('a changed kit pin in the PR workflow is a fact', () => {
  const wf = (c) => `jobs:\n  r:\n    steps:\n      - uses: marcusk639/pr-review-kit/actions/review@${SHA(c)}\n`;
  const r = runFacts(repoWith(CONFIG, { workflowBase: wf('a'), workflowHead: wf('b') }));
  assert.match(readFileSync(join(r.out, 'facts.md'), 'utf8'), /\[engine-pin\].*kit pin changed from aaaaaaa to bbbbbbb/);
});

test('a malformed base config never lets the model run without material', () => {
  for (const bad of [{ ...CONFIG, trust: null }, { ...CONFIG, checks: { verifyDiff: true } }, { ...CONFIG, secrets: { extraPatterns: 'x' } }]) {
    const r = runFacts(repoWith(bad));
    assert.match(r.ghOutput, /tier=none/, JSON.stringify(bad));
  }
});
