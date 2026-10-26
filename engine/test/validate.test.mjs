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

const errorsOf = (dir) => validateRepo(dir, { kitDir: false }).errors.join('\n');
const WF = '.github/workflows/pr-review.yml';
const CFG = '.pr-review/config.json';

test('the example consumer validates once KIT_SHA is pinned', () => {
  const dir = repo();
  const r = validateRepo(dir, { kitDir: false });
  assert.deepEqual(r.errors, []);
  rmSync(dir, { recursive: true, force: true });
});

test('the example as shipped is rejected: KIT_SHA is not a commit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'validate-'));
  cpSync(EXAMPLE, dir, { recursive: true });
  assert.match(errorsOf(dir), /not pinned to a full commit SHA/);
});

test('config, addendum and knowledge files are required', () => {
  assert.match(errorsOf(repo(({ sub }) => sub(CFG, '"version": 1', '"version": 2'))), /config: version must be/);
  assert.match(errorsOf(repo(({ at }) => rmSync(at('.pr-review/REVIEW.md')))), /REVIEW\.md/);
  assert.match(errorsOf(repo(({ at }) => rmSync(at('.pr-review/conventions.md')))), /knowledge file conventions\.md is missing/);
});

test('every configured class has a checklist heading', () => {
  assert.match(errorsOf(repo(({ sub }) => sub('.pr-review/checklist.md', '## 4. ', '## Four. '))), /checklist\.md has no "## 4\. " heading/);
});

test('every routing link type has a section in exactly one knowledge file', () => {
  assert.match(errorsOf(repo(({ sub }) => sub('.pr-review/contract-map.md', '## tests\n', '## testing\n'))), /link type tests has no "## tests" section/);
  assert.match(errorsOf(repo(({ sub }) => sub('.pr-review/conventions.md', '# Practised conventions', '# Practised conventions\n\n## client\n'))), /link type client has a section in 2 knowledge files/);
});

test('backticked repo paths in knowledge files must exist', () => {
  assert.match(errorsOf(repo(({ at }) => rmSync(at('web/client.ts')))), /contract-map\.md: web\/client\.ts does not exist/);
});

test('project checks must exist', () => {
  assert.match(errorsOf(repo(({ at }) => rmSync(at('.pr-review/checks/routes.mjs')))), /project check checks\/routes\.mjs is missing/);
});

test('the workflow must exist and pin both actions to the same SHA', () => {
  assert.match(errorsOf(repo(({ at }) => rmSync(at(WF)))), /workflow .*pr-review\.yml is missing/);
  assert.match(errorsOf(repo(({ sub }) => sub(WF, `publish@${SHA}`, `publish@${'b'.repeat(40)}`))), /must pin the same kit SHA/);
  assert.match(errorsOf(repo(({ sub }) => sub(WF, `review@${SHA}`, 'review@main'))), /not pinned to a full commit SHA/);
});

test('the workflow must keep the trigger, guards and permissions', () => {
  assert.match(errorsOf(repo(({ sub }) => sub(WF, '  pull_request:', '  pull_request_target:'))), /pull_request_target/);
  assert.match(errorsOf(repo(({ sub }) => sub(WF, '\n      && github.event.pull_request.head.repo.full_name == github.repository', ''))), /same-repo guard/);
  assert.match(errorsOf(repo(({ sub }) => sub(WF, '!github.event.pull_request.draft\n      && ', ''))), /draft/);
  assert.match(errorsOf(repo(({ sub }) => sub(WF, 'contents: read', 'contents: write'))), /contents: write/);
  assert.match(errorsOf(repo(({ sub }) => sub(WF, 'persist-credentials: false', 'persist-credentials: true'))), /persist-credentials: false/);
  assert.match(errorsOf(repo(({ sub }) => sub(WF, 'fetch-depth: 0', 'fetch-depth: 1'))), /fetch-depth: 0/);
});

test('publish must run always; secrets go only to their own step', () => {
  assert.match(errorsOf(repo(({ sub }) => sub(WF, "      - name: Publish\n        if: always()\n", '      - name: Publish\n'))), /publish step must run with if: always\(\)/);
  assert.match(errorsOf(repo(({ sub }) => sub(WF, '          action_outcome:', '          claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}\n          action_outcome:'))), /claude_code_oauth_token may only be passed to the review or learn action/);
  assert.match(errorsOf(repo(({ sub }) => sub(WF, '          claude_code_oauth_token:', '          id_key: ${{ secrets.PR_REVIEW_ID_KEY }}\n          claude_code_oauth_token:'))), /id_key may only be passed to the publish action/);
  assert.match(errorsOf(repo(({ sub }) => sub(WF, '    steps:\n', '    env:\n      X: ${{ secrets.OTHER }}\n    steps:\n'))), /secret OTHER/);
});

test('a private repo must not pass advisory secrets it cannot use', () => {
  const dir = repo(({ sub }) => sub(CFG, '"visibility": "public",\n  "securityChannel": "advisory",', '"visibility": "private",\n  "securityChannel": "none",'));
  const r = validateRepo(dir, { kitDir: false });
  assert.match(r.warnings.join('\n'), /advisory_token is passed but the security channel is none/);
});

const LWF = '.github/workflows/pr-review-learn.yml';

test('the learning job must not hold a write token; the propose job holds no secret', () => {
  assert.match(errorsOf(repo(({ sub }) => sub(LWF, '    permissions:\n      contents: read\n      pull-requests: read', '    permissions:\n      contents: write\n      pull-requests: read'))), /learn job must not have write permissions/);
  assert.match(errorsOf(repo(({ sub }) => sub(LWF, '      - name: Propose\n        uses:', '      - name: Propose\n        env:\n          T: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}\n        uses:'))), /propose job must not receive secrets/);
});

test('the learning workflow pins the same kit SHA as the review workflow', () => {
  assert.match(errorsOf(repo(({ sub }) => sub(LWF, `learn@${SHA}`, `learn@${'c'.repeat(40)}`))), /learning workflow must pin the same kit SHA as the review workflow/);
});

test('project checks may not spawn processes themselves', () => {
  const dir = repo(({ at }) => writeFileSync(at('.pr-review/checks/routes.mjs'), "import { execFileSync } from 'node:child_process';\nexport default [];\n"));
  assert.match(errorsOf(dir), /checks\/routes\.mjs imports child_process; use ctx\.git or ctx\.parseOnly/);
  const dyn = repo(({ at }) => writeFileSync(at('.pr-review/checks/routes.mjs'), "const cp = await import('child_process');\nexport default [];\n"));
  assert.match(errorsOf(dyn), /imports child_process/);
});

test('a forbidden glob that matches no knowledge file is a warning', () => {
  const dir = repo(({ sub }) => sub('.pr-review/config.json', '"distill": "model"', '"distill": "model", "forbidden": ["maps/**"]'));
  assert.match(validateRepo(dir, { kitDir: false }).warnings.join(), /learning\.forbidden maps\/\*\* matches no knowledge file/);
});

test('M4: learning workflow permissions and triggers in every form', () => {
  assert.match(errorsOf(repo(({ sub }) => sub(LWF, 'concurrency:', 'permissions: write-all\n\nconcurrency:'))), /write-all/);
  assert.match(errorsOf(repo(({ sub }) => sub(LWF, 'concurrency:', 'permissions:\n  contents: write\n\nconcurrency:'))), /workflow-level write permission/);
  assert.match(errorsOf(repo(({ sub }) => sub(LWF, '    permissions:\n      contents: read\n      pull-requests: read\n      issues: read\n      id-token: write', '    permissions: { contents: write, id-token: write }'))), /learn job must not have write permissions/);
  assert.match(errorsOf(repo(({ sub }) => sub(LWF, '  workflow_dispatch:', '  workflow_dispatch:\n  push:'))), /schedule and workflow_dispatch only/);
});
