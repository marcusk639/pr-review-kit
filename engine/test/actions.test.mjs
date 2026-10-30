// Static checks on the kit's composite actions: the security properties the
// reference enforced on its workflow, now carried by actions/review and
// actions/publish. (Consumer workflows are checked by validate.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../../actions/${p}`, import.meta.url), 'utf8');
const review = read('review/action.yml');
const publish = read('publish/action.yml');
const learn = read('learn/action.yml');
const proposeAction = read('propose/action.yml');
const stepOf = (yml, name) => {
  const start = yml.indexOf(`- name: ${name}`);
  assert.ok(start > 0, `step ${name}`);
  const next = yml.indexOf('\n    - ', start + 1);
  return yml.slice(start, next === -1 ? undefined : next);
};
// The tool lists as they stand when facts emits no opt-in tools (config.model
// off, or facts never ran): the opt-in expressions are checked on their own below.
const EXTRA_ALLOW = '${{ steps.facts.outputs.extra_allow }}';
const SHELL_DENY = "${{ steps.facts.outputs.model_shell == 'on' && '' || 'Bash,' }}";
const rawAllow = /--allowedTools "([^"]+)"/.exec(review)?.[1] ?? '';
const rawDeny = /--disallowedTools "([^"]+)"/.exec(review)?.[1] ?? '';
const SERENA_TOOLS = '${{ steps.serena.outputs.tools }}';
const allow = rawAllow.replace(EXTRA_ALLOW, '').replace(SERENA_TOOLS, '').split(',');
const deny = rawDeny.replace(SHELL_DENY, 'Bash,').replace('${{ steps.facts.outputs.extra_deny }}', '').split(',');

test('opt-in model tools: only facts adds allow rules, and Bash is denied unless model_shell is exactly on', () => {
  assert.ok(rawAllow.startsWith(EXTRA_ALLOW), 'extra_allow is prepended, so each rule ends in its own comma');
  assert.equal(rawAllow.split(EXTRA_ALLOW).length, 2);
  assert.ok(rawDeny.startsWith(SHELL_DENY), 'an unset or other model_shell output keeps Bash denied');
  assert.equal((review.match(/steps\.facts\.outputs\.model_shell/g) ?? []).length, 1);
});

test('Run start sets OUT, STATE_FILE and RUN_STARTED_AT through GITHUB_ENV before facts and the model', () => {
  const step = stepOf(review, 'Run start');
  assert.match(step, /echo "OUT=\$RUNNER_TEMP\/pr-review" >> "\$GITHUB_ENV"/);
  assert.match(step, /echo "STATE_FILE=\$RUNNER_TEMP\/prstate-snapshot\/state\.json" >> "\$GITHUB_ENV"/);
  assert.match(step, /RUN_STARTED_AT=\$\(date -u \+%Y-%m-%dT%H:%M:%SZ\)" >> "\$GITHUB_ENV"/);
  assert.ok(review.indexOf('- name: Run start') < review.indexOf('- name: Facts'));
  assert.ok(review.indexOf('- name: Facts') < review.indexOf('- name: Review'));
});

test('the base checkout path is cleared before the base checkout, which persists no credentials', () => {
  assert.match(stepOf(review, 'Clear base checkout path'), /run: rm -rf \.review-base \.review-publish \.pr-review-external\n/);
  assert.ok(review.indexOf('Clear base checkout path') < review.indexOf('Checkout trust SHA'));
  for (const yml of [review, publish]) {
    const checkouts = [...yml.matchAll(/uses: actions\/checkout@[0-9a-f]{40}.*\n(\s+with:\n(?:\s{8}.*\n)+)/g)];
    assert.ok(checkouts.length > 0);
    for (const m of checkouts) assert.match(m[1], /persist-credentials: false/);
  }
});

test('the model runs only when facts chose a tier, and never fails the action', () => {
  assert.match(review, /- name: Review\n\s+id: review\n\s+if: steps\.facts\.outputs\.tier != '' && steps\.facts\.outputs\.tier != 'none'\n\s+continue-on-error: true/);
});

test('the model loads no project settings, no MCP servers and no hooks', () => {
  for (const yml of [review, learn]) {
    assert.match(yml, /\n\s+--setting-sources user\n/);
    assert.match(yml, /\n\s+--strict-mcp-config\n/);
    assert.match(yml, /settings: '\{"disableAllHooks": true, "claudeMdExcludes": \["\*\*\/CLAUDE\.md", "\*\*\/CLAUDE\.local\.md", "\*\*\/AGENTS\.md"\]\}'/);
  }
});

test('every action dependency is pinned to a full commit SHA and none is local', () => {
  for (const yml of [review, publish, learn, proposeAction]) {
    for (const m of yml.matchAll(/uses:\s*(\S+)/g)) {
      assert.match(m[1], /^[\w.-]+\/[\w.-]+(\/[\w./-]+)?@[0-9a-f]{40}$/, m[1]);
      assert.ok(!m[1].startsWith('./'));
    }
  }
});

test('the PR head is neutralized after the knowledge restore and before facts, externals and the model', () => {
  const order = ['- name: Restore reviewer knowledge from the trust SHA', '- name: Neutralize PR head', '- name: Facts', '- name: External counterparts', '- name: Review'].map((n) => review.indexOf(n));
  assert.ok(order.every((x) => x > 0));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.match(stepOf(review, 'Restore reviewer knowledge from the trust SHA'), /rm -rf \.claude-pr \.pr-review\n/);
});

test('one trust SHA: resolved at run start, used for the knowledge checkout and handed to publish', () => {
  assert.match(stepOf(review, 'Run start'), /TRUST_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.match(stepOf(review, 'Checkout trust SHA'), /ref: \$\{\{ steps\.paths\.outputs\.trust_sha \}\}/);
  assert.match(stepOf(review, 'Facts'), /BASE_SHA: \$\{\{ steps\.paths\.outputs\.trust_sha \}\}/);
  assert.match(review, /trust_sha:\n\s+description: .*\n\s+value: \$\{\{ steps\.paths\.outputs\.trust_sha \}\}/);
  assert.match(stepOf(publish, 'Checkout trust SHA'), /ref: \$\{\{ inputs\.trust_sha \|\| github\.event\.pull_request\.base\.sha \}\}/);
});

test('model writes and edits are allowed only under OUT; workspace and kit writes denied', () => {
  const files = ['inline.json', 'findings.json', 'summary.md'];
  assert.deepEqual(allow, ['Read', 'Grep', 'Glob', ...files.map((f) => `Write(/\${{ runner.temp }}/pr-review/${f})`), ...files.map((f) => `Edit(/\${{ runner.temp }}/pr-review/${f})`)]);
  assert.ok(deny.includes('Write(/${{ runner.temp }}/pr-review/.claude/**)'));
  for (const t of ['Skill', 'Task', 'Agent', 'mcp__github', 'Read(./.claude-pr/**)', 'Read(/${{ github.workspace }}/.claude-pr/**)', 'Read(/${{ github.workspace }}/.review-publish/**)', 'Read(~/.*)', 'Read(~/.*/**)', 'Read(/${{ runner.temp }}/_github_workflow/**)', 'Read(/${{ runner.temp }}/_github_home/**)', 'Read(~/runners/**)', 'Read(~/actions-runner/**)', 'SlashCommand']) assert.ok(deny.includes(t), t);
  assert.ok(!deny.some((t) => t.includes('/home/runner')), 'no runner-specific home path');
  assert.match(review, /\*\*\)\$\{\{ steps\.facts\.outputs\.extra_deny \}\}"/, 'withheld denies are appended');
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
  for (const s of ['inputs.id_key', 'inputs.advisory_token', 'inputs.private_repo', 'inputs.private_issue_token']) {
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
  assert.ok(publish.indexOf('Clear publish checkout path') < publish.indexOf('Checkout trust SHA'));
  assert.match(stepOf(publish, 'Cleanup'), /if: always\(\)/);
});

test('every engine path is the pinned action path, never the workspace', () => {
  assert.match(stepOf(review, 'Facts'), /run: node "\$\{\{ steps\.paths\.outputs\.kit_root \}\}\/engine\/facts\.mjs"/);
  assert.match(stepOf(review, 'Run start'), /kit_root=\$\(cd "\$\{\{ github\.action_path \}\}\/\.\.\/\.\." && pwd\)/);
});


test('the distill model has the review sandbox and cannot write the snapshot apply trusts', () => {
  const lallow = (/--allowedTools "([^"]+)"/.exec(learn)?.[1] ?? '').split(',');
  const ldeny = (/--disallowedTools "([^"]+)"/.exec(learn)?.[1] ?? '').split(',');
  assert.deepEqual(lallow, ['Read', 'Grep', 'Glob', 'Write(/${{ runner.temp }}/pr-review-learn/proposals.json)', 'Edit(/${{ runner.temp }}/pr-review-learn/proposals.json)']);
  assert.ok(ldeny.includes('Write(/${{ runner.temp }}/pr-review-learn/bundle/**)'));
  for (const t of ['Bash', 'WebFetch', 'WebSearch', 'Read(~/.*)', 'Read(~/.*/**)', 'Read(/${{ runner.temp }}/_github_home/**)', 'Read(//proc/**)', 'Read(/${{ github.workspace }}/.git/**)', 'Write(/${{ runner.temp }}/learn-snapshot/**)', 'Edit(/${{ runner.temp }}/learn-snapshot/**)', 'Write(/${{ github.workspace }}/**)']) assert.ok(ldeny.includes(t), t);
  assert.match(stepOf(learn, 'Distill'), /continue-on-error: true/);
  assert.ok(learn.indexOf('- name: Distill') < learn.indexOf('- name: Apply'));
});

test('learn and propose refuse to run anywhere but the default branch', () => {
  for (const yml of [learn, proposeAction]) {
    const step = stepOf(yml, 'Default branch only');
    assert.match(step, /REF: \$\{\{ github\.ref \}\}/);
    assert.match(step, /DEFAULT: \$\{\{ github\.event\.repository\.default_branch \}\}/);
    assert.match(step, /exit 1/);
    assert.ok(yml.indexOf('- name: Default branch only') < yml.indexOf('- name:', yml.indexOf('- name: Default branch only') + 5));
  }
});

test('learning: no write token in learn; propose runs no model and gets no Claude token', () => {
  assert.doesNotMatch(learn, /contents: write|git\/refs|pulls/);
  assert.doesNotMatch(proposeAction, /claude-code-action|claude_code_oauth_token|secrets\./);
  assert.match(stepOf(proposeAction, 'Propose'), /NODE_OPTIONS: ""/);
});
