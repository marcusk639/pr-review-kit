// Static checks on the kit's composite actions: the security properties the
// reference enforced on its workflow, now carried by actions/review and
// actions/publish. (Consumer workflows are checked by validate.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../../actions/${p}`, import.meta.url), 'utf8');
const review = read('review/action.yml');
const publish = read('publish/action.yml');
const stepOf = (yml, name) => {
  const start = yml.indexOf(`- name: ${name}`);
  assert.ok(start > 0, `step ${name}`);
  const next = yml.indexOf('\n    - ', start + 1);
  return yml.slice(start, next === -1 ? undefined : next);
};
const allow = (/--allowedTools "([^"]+)"/.exec(review)?.[1] ?? '').split(',');
const deny = (/--disallowedTools "([^"]+)"/.exec(review)?.[1] ?? '').split(',');

test('Run start sets OUT, STATE_FILE and RUN_STARTED_AT through GITHUB_ENV before facts and the model', () => {
  const step = stepOf(review, 'Run start');
  assert.match(step, /echo "OUT=\$RUNNER_TEMP\/pr-review" >> "\$GITHUB_ENV"/);
  assert.match(step, /echo "STATE_FILE=\$RUNNER_TEMP\/prstate-snapshot\/state\.json" >> "\$GITHUB_ENV"/);
  assert.match(step, /RUN_STARTED_AT=\$\(date -u \+%Y-%m-%dT%H:%M:%SZ\)" >> "\$GITHUB_ENV"/);
  assert.ok(review.indexOf('- name: Run start') < review.indexOf('- name: Facts'));
  assert.ok(review.indexOf('- name: Facts') < review.indexOf('- name: Review'));
});

test('the base checkout path is cleared before the base checkout, which persists no credentials', () => {
  assert.match(stepOf(review, 'Clear base checkout path'), /run: rm -rf \.review-base\n/);
  assert.ok(review.indexOf('Clear base checkout path') < review.indexOf('Checkout base'));
  for (const yml of [review, publish]) {
    for (const m of yml.matchAll(/uses: actions\/checkout@v4\n(\s+with:\n(?:\s{8}.*\n)+)/g)) assert.match(m[1], /persist-credentials: false/);
  }
});

test('the model runs only when facts chose a tier, and never fails the action', () => {
  assert.match(review, /- name: Review\n\s+id: review\n\s+if: steps\.facts\.outputs\.tier != 'none'\n\s+continue-on-error: true/);
});

test('the model runs with --strict-mcp-config and all hooks disabled', () => {
  assert.match(review, /\n\s+--strict-mcp-config\n/);
  assert.match(review, /settings: '\{"disableAllHooks": true\}'/);
});

test('model writes and edits are allowed only under OUT; workspace and kit writes denied', () => {
  assert.deepEqual(allow, ['Read', 'Grep', 'Glob', 'Write(/${{ runner.temp }}/pr-review/**)', 'Edit(/${{ runner.temp }}/pr-review/**)']);
  assert.ok(!deny.includes('Edit'), 'no bare Edit deny (it would override the OUT allow rule)');
  for (const t of ['Write', 'Edit']) {
    assert.ok(deny.includes(`${t}(/\${{ github.workspace }}/**)`), `${t} workspace`);
    assert.ok(deny.includes(`${t}(/\${{ steps.paths.outputs.kit_root }}/**)`), `${t} kit`);
    for (const dir of ['_runner_file_commands', 'prstate-snapshot']) assert.ok(deny.includes(`${t}(/\${{ runner.temp }}/${dir}/**)`), `${t} ${dir}`);
  }
});

test('the model has no shell, network, extra edit or inline-comment tool, and cannot read .git or /proc', () => {
  for (const t of ['Bash', 'MultiEdit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'mcp__github_inline_comment__create_inline_comment']) assert.ok(deny.includes(t), t);
  assert.ok(!allow.some((t) => t.includes('inline_comment') || t === 'Bash'));
  assert.ok(deny.includes('Read(/${{ github.workspace }}/.git/**)'));
  assert.ok(deny.includes('Read(//proc/**)'));
});

test('the OAuth token reaches only the claude-code-action step', () => {
  const uses = review.match(/inputs\.claude_code_oauth_token/g) ?? [];
  assert.equal(uses.length, 1);
  assert.match(stepOf(review, 'Review'), /claude_code_oauth_token: \$\{\{ inputs\.claude_code_oauth_token \}\}/);
  assert.doesNotMatch(review, /secrets\.|id_key|advisory_token/);
});

test('publish secrets appear only in the Publish step env, with NODE_OPTIONS and BASH_ENV cleared', () => {
  const step = stepOf(publish, 'Publish');
  for (const s of ['inputs.id_key', 'inputs.advisory_token']) {
    assert.equal((publish.match(new RegExp(s.replace('.', '\\.'), 'g')) ?? []).length, 1, s);
    assert.ok(step.includes(s), `${s} in Publish`);
  }
  assert.match(step, /\n {8}NODE_OPTIONS: ""\n/);
  assert.match(step, /\n {8}BASH_ENV: ""\n/);
  const nodes = [...step.matchAll(/run: node (.*)$/gm)].map((m) => m[1]);
  assert.deepEqual(nodes, ['--no-warnings "${{ github.action_path }}/../../engine/run-publish.mjs"']);
});

test('publish clears its checkout path first and cleans OUT and the snapshot always', () => {
  assert.match(stepOf(publish, 'Clear publish checkout path'), /run: rm -rf \.review-publish\n/);
  assert.ok(publish.indexOf('Clear publish checkout path') < publish.indexOf('Checkout base'));
  assert.match(stepOf(publish, 'Cleanup'), /if: always\(\)/);
});

test('every engine path is the pinned action path, never the workspace', () => {
  assert.match(stepOf(review, 'Facts'), /run: node "\$\{\{ steps\.paths\.outputs\.kit_root \}\}\/engine\/facts\.mjs"/);
  assert.match(stepOf(review, 'Run start'), /kit_root=\$\(cd "\$\{\{ github\.action_path \}\}\/\.\.\/\.\." && pwd\)/);
});
