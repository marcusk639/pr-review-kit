import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkWorkflow, checkKitPin } from '../lib/workflow-check.mjs';

const EXAMPLE = readFileSync(fileURLToPath(new URL('../../examples/consumer/.github/workflows/pr-review.yml', import.meta.url)), 'utf8');
let kit;
let SHA;
let WEAK;
before(() => {
  kit = mkdtempSync(join(tmpdir(), 'kit-'));
  const g = (...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: kit, encoding: 'utf8' }).trim();
  g('init', '-q', '-b', 'main');
  cpSync(fileURLToPath(new URL('../../actions/', import.meta.url)), join(kit, 'actions'), { recursive: true });
  g('add', '-A');
  g('commit', '-qm', 'kit');
  SHA = g('rev-parse', 'HEAD');
  g('checkout', '-q', '-b', 'side');
  const review = join(kit, 'actions/review/action.yml');
  writeFileSync(review, readFileSync(review, 'utf8').replace('--setting-sources user', ''));
  g('commit', '-qam', 'weak');
  WEAK = g('rev-parse', 'HEAD');
  g('checkout', '-q', 'main');
});

const wf = (edit = (s) => s) => edit(EXAMPLE.replaceAll('KIT_SHA', SHA));
const errs = (text) => checkWorkflow(text, { kind: 'review', securityChannel: 'advisory' }).errors.join('\n');

test('the example workflow passes', () => {
  assert.deepEqual(checkWorkflow(wf(), { kind: 'review', securityChannel: 'advisory' }).errors, []);
});

test('every uses: is pinned to a full SHA; tags and local actions are rejected', () => {
  assert.match(errs(wf((s) => s.replace(/actions\/checkout@[0-9a-f]{40}/, 'actions/checkout@v4'))), /actions\/checkout@v4 is not pinned to a full commit SHA/);
  assert.match(errs(wf((s) => s.replace(`review@${SHA}`, 'review@main'))), /review@main is not pinned/);
  assert.match(errs(wf((s) => s.replace(`marcusk639/pr-review-kit/actions/review@${SHA}`, './actions/review'))), /local action/);
});

test('secrets are checked by role, not by name', () => {
  assert.deepEqual(checkWorkflow(wf((s) => s.replace('secrets.CLAUDE_CODE_OAUTH_TOKEN', 'secrets.FIRM_CLAUDE_CODE_OAUTH_TOKEN')), { kind: 'review', securityChannel: 'advisory' }).errors, []);
  assert.match(errs(wf((s) => s.replace('          action_outcome:', '          claude_code_oauth_token: ${{ secrets.X }}\n          action_outcome:'))), /claude_code_oauth_token may only be passed to the review or learn action/);
  assert.match(errs(wf((s) => s.replace('          claude_code_oauth_token:', '          id_key: ${{ secrets.PR_REVIEW_ID_KEY }}\n          claude_code_oauth_token:'))), /id_key may only be passed to the publish action/);
  assert.match(errs(wf((s) => s.replace('    steps:\n', '    env:\n      X: ${{ secrets.OTHER }}\n    steps:\n'))), /secret OTHER is not mapped to a kit input/);
  assert.deepEqual(checkWorkflow(wf((s) => s.replace('    steps:\n', '    env:\n      GH: ${{ secrets.GITHUB_TOKEN }}\n    steps:\n')), { kind: 'review', securityChannel: 'advisory' }).errors, []);
});

test('trigger, permissions and comments are read the way GitHub reads them', () => {
  assert.deepEqual(checkWorkflow(wf((s) => s.replace(/on:\n  pull_request:\n    types: \[[^\]]+\]/, 'on: [pull_request]')), { kind: 'review', securityChannel: 'advisory' }).errors, []);
  assert.match(errs(wf((s) => s.replace('permissions:\n      contents: read', 'permissions: write-all\n    x:\n      contents: read'))), /write-all/);
  assert.match(errs(wf((s) => s.replace('concurrency:', 'permissions:\n  contents: write\n\nconcurrency:'))), /contents: write/);
  assert.match(errs(wf((s) => s.replace(/\n {6}&& github\.event\.pull_request\.head\.repo\.full_name == github\.repository/, '\n      # && github.event.pull_request.head.repo.full_name == github.repository'))), /same-repo guard/);
  assert.deepEqual(checkWorkflow(wf((s) => s.replace('if: always()', 'if: ${{ always() }}')), { kind: 'review', securityChannel: 'advisory' }).errors, []);
});

test('the kit pin must be a kit commit reachable from main that carries the sandbox', () => {
  assert.deepEqual(checkKitPin(SHA, kit), []);
  assert.match(checkKitPin('b'.repeat(40), kit).join(), /not a commit in the kit/);
  assert.match(checkKitPin(WEAK, kit).join(), /not reachable from the kit's main branch/);
});

test('a kit commit without the sandbox properties is rejected even on main', () => {
  const g = (...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: kit, encoding: 'utf8' }).trim();
  const review = join(kit, 'actions/review/action.yml');
  const orig = readFileSync(review, 'utf8');
  writeFileSync(review, orig.replace('- name: Neutralize PR head', '- name: Something else').replace(',Skill,', ','));
  g('commit', '-qam', 'weaken on main');
  const bad = g('rev-parse', 'HEAD');
  const e = checkKitPin(bad, kit).join('\n');
  assert.match(e, /neutralize/);
  assert.match(e, /Skill/);
  writeFileSync(review, orig);
  g('commit', '-qam', 'restore');
});
