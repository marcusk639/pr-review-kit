import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RP } from './helpers/rp.mjs';
import { setActiveProject } from '../lib/config.mjs';
import { validateRepo } from '../validate.mjs';

const EXAMPLE = fileURLToPath(new URL('../../examples/consumer/', import.meta.url));
const SHA = 'a'.repeat(40);

afterEach(() => setActiveProject(RP));

// A copy of the example consumer with KIT_SHA pinned, then edited by `edit`.
function repo(edit = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), 'validate-'));
  cpSync(EXAMPLE, dir, { recursive: true });
  for (const wf of ['pr-review.yml', 'pr-review-learn.yml']) {
    const p = join(dir, '.github/workflows', wf);
    try {
      writeFileSync(p, readFileSync(p, 'utf8').replaceAll('KIT_SHA', SHA));
    } catch {
      // the learning workflow is optional
    }
  }
  const at = (p) => join(dir, p);
  const sub = (p, a, b) => writeFileSync(at(p), readFileSync(at(p), 'utf8').replace(a, b));
  edit({ at, sub, dir });
  return dir;
}

const errorsOf = (dir) => validateRepo(dir).errors.join('\n');
const WF = '.github/workflows/pr-review.yml';
const CFG = '.claude/pr-review/config.json';

test('the example consumer validates once KIT_SHA is pinned', () => {
  const dir = repo();
  const r = validateRepo(dir);
  assert.deepEqual(r.errors, []);
  rmSync(dir, { recursive: true, force: true });
});

test('the example as shipped is rejected: KIT_SHA is not a commit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'validate-'));
  cpSync(EXAMPLE, dir, { recursive: true });
  assert.match(errorsOf(dir), /not pinned to a full commit SHA/);
});

test('config, addendum and knowledge files are required', () => {
  assert.match(errorsOf(repo(({ sub }) => sub(CFG, '"version": 1', '"version": 2'))), /config: version must be 1/);
  assert.match(errorsOf(repo(({ at }) => rmSync(at('.claude/pr-review/REVIEW.md')))), /REVIEW\.md/);
  assert.match(errorsOf(repo(({ at }) => rmSync(at('.claude/pr-review/conventions.md')))), /knowledge file conventions\.md is missing/);
});

test('every configured class has a checklist heading', () => {
  assert.match(errorsOf(repo(({ sub }) => sub('.claude/pr-review/checklist.md', '## 4. ', '## Four. '))), /checklist\.md has no "## 4\. " heading/);
});

test('every routing link type has a section in exactly one knowledge file', () => {
  assert.match(errorsOf(repo(({ sub }) => sub('.claude/pr-review/contract-map.md', '## tests\n', '## testing\n'))), /link type tests has no "## tests" section/);
  assert.match(errorsOf(repo(({ sub }) => sub('.claude/pr-review/conventions.md', '# Practised conventions', '# Practised conventions\n\n## client\n'))), /link type client has a section in 2 knowledge files/);
});

test('backticked repo paths in knowledge files must exist', () => {
  assert.match(errorsOf(repo(({ at }) => rmSync(at('web/client.ts')))), /contract-map\.md: web\/client\.ts does not exist/);
});

test('project checks must exist', () => {
  assert.match(errorsOf(repo(({ at }) => rmSync(at('.claude/pr-review/checks/routes.mjs')))), /project check checks\/routes\.mjs is missing/);
});

test('the workflow must exist and pin both actions to the same SHA', () => {
  assert.match(errorsOf(repo(({ at }) => rmSync(at(WF)))), /workflow .*pr-review\.yml is missing/);
  assert.match(errorsOf(repo(({ sub }) => sub(WF, `publish@${SHA}`, `publish@${'b'.repeat(40)}`))), /review and publish must pin the same kit SHA/);
  assert.match(errorsOf(repo(({ sub }) => sub(WF, `review@${SHA}`, 'review@main'))), /not pinned to a full commit SHA/);
});

test('the workflow must keep the trigger, guards and permissions', () => {
  assert.match(errorsOf(repo(({ sub }) => sub(WF, '  pull_request:', '  pull_request_target:'))), /pull_request_target/);
  assert.match(errorsOf(repo(({ sub }) => sub(WF, '\n      && github.event.pull_request.head.repo.full_name == github.repository', ''))), /same-repo guard/);
  assert.match(errorsOf(repo(({ sub }) => sub(WF, '!github.event.pull_request.draft\n      && ', ''))), /draft/);
  assert.match(errorsOf(repo(({ sub }) => sub(WF, 'contents: read', 'contents: write'))), /contents: read/);
  assert.match(errorsOf(repo(({ sub }) => sub(WF, 'persist-credentials: false', 'persist-credentials: true'))), /persist-credentials: false/);
  assert.match(errorsOf(repo(({ sub }) => sub(WF, 'fetch-depth: 0', 'fetch-depth: 1'))), /fetch-depth: 0/);
});

test('publish must run always; secrets go only to their own step', () => {
  assert.match(errorsOf(repo(({ sub }) => sub(WF, "      - name: Publish\n        if: always()\n", '      - name: Publish\n'))), /publish step must run with if: always\(\)/);
  assert.match(errorsOf(repo(({ sub }) => sub(WF, '          action_outcome:', '          claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}\n          action_outcome:'))), /CLAUDE_CODE_OAUTH_TOKEN may only be passed to the review step/);
  assert.match(errorsOf(repo(({ sub }) => sub(WF, '          claude_code_oauth_token:', '          id_key: ${{ secrets.PR_REVIEW_ID_KEY }}\n          claude_code_oauth_token:'))), /PR_REVIEW_ID_KEY may only be passed to the publish step/);
  assert.match(errorsOf(repo(({ sub }) => sub(WF, '    steps:\n', '    env:\n      X: ${{ secrets.OTHER }}\n    steps:\n'))), /secret OTHER/);
});

test('a private repo must not pass advisory secrets it cannot use', () => {
  const dir = repo(({ sub }) => sub(CFG, '"visibility": "public",\n  "securityChannel": "advisory",', '"visibility": "private",\n  "securityChannel": "none",'));
  const r = validateRepo(dir);
  assert.match(r.warnings.join('\n'), /SECURITY_ADVISORY_TOKEN is passed but the security channel is none/);
});
