// Static checks on the review action's opt-in Serena code navigation (ported
// from recovery-platform's workflow tests): gating, arguments unchanged when
// off, pinning, isolation, the stop guard publish relies on, and serena-prep.
import './helpers/rp.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { copyList, languageServers, projectCopyList, warmupFiles, WARMUP } from '../serena-prep.mjs';
import { normalizeConfig } from '../lib/config.mjs';

const read = (p) => readFileSync(new URL(`../../actions/${p}`, import.meta.url), 'utf8');
const action = read('review/action.yml');
const publish = read('publish/action.yml');
const stepText = (yml, name) => {
  const start = yml.indexOf(`- name: ${name}\n`);
  assert.ok(start > 0, `step ${name}`);
  const next = yml.indexOf('\n    - name:', start + 1);
  return yml.slice(start, next < 0 ? undefined : next);
};
const setup = stepText(action, 'Serena setup');
const review = stepText(action, 'Review');
const GATE = "if: inputs.serena == 'on' && steps.facts.outputs.tier != '' && steps.facts.outputs.tier != 'none'";
const TOOLS = ['find_symbol', 'find_referencing_symbols', 'get_symbols_overview', 'search_for_pattern'];
const at = (needle, text = setup) => {
  const i = text.indexOf(needle);
  assert.ok(i >= 0, `missing: ${needle}`);
  return i;
};

test('Serena is off unless the input is exactly on', () => {
  assert.match(action, /\n {2}serena:\n(?: {4}.*\n)+ {4}default: "off"\n/);
});

test('both Serena steps are gated on the input and a model run, never fail the job, and come after facts', () => {
  for (const name of ['Set up uv for Serena', 'Serena setup']) {
    const s = stepText(action, name);
    assert.ok(s.includes(`\n      ${GATE}\n`), `${name} gate`);
    assert.match(s, /\n {6}continue-on-error: true\n/, `${name} continue-on-error`);
  }
  assert.ok(action.indexOf('- name: Neutralize PR head') < action.indexOf('- name: Set up uv for Serena'));
  assert.ok(action.indexOf('- name: Facts') < action.indexOf('- name: Serena setup'));
  assert.ok(action.indexOf('- name: Serena setup') < action.indexOf('- name: Review\n'));
});

test('with Serena off, the Serena expressions add nothing and the deny list is untouched', () => {
  const allow = /--allowedTools "([^"]+)"/.exec(review)[1];
  assert.ok(allow.startsWith('${{ steps.facts.outputs.extra_allow }}${{ steps.serena.outputs.tools }}Read,'));
  const refs = [...review.matchAll(/steps\.serena\.outputs\.(\w+)/g)].map((m) => m[1]).sort();
  assert.deepEqual(refs, ['mcp_args', 'prompt', 'prompt', 'tools']);
  assert.match(review, /\n {10}\$\{\{ steps\.serena\.outputs\.mcp_args \}\}\n/, 'mcp_args on its own line');
  assert.match(review, /\n {10}--strict-mcp-config\n/);
  assert.doesNotMatch(/--disallowedTools "([^"]+)"/.exec(review)[1], /serena/);
  assert.doesNotMatch(allow, /mcp__serena|mcp__[^,]*\*|(^|,)\*/, 'no literal or wildcard Serena tool');
});

test('the step outputs exactly the four read-only Serena tools, written once at the end', () => {
  assert.equal(/echo "tools=([^"]+)"/.exec(setup)[1], TOOLS.map((t) => `mcp__serena__${t},`).join(''));
  assert.equal(setup.split('>> "$GITHUB_OUTPUT"').length, 2);
});

test('setup-uv and serena-agent are pinned, and setup-uv cannot be steered by PR files', () => {
  const uv = stepText(action, 'Set up uv for Serena');
  assert.match(uv, /uses: astral-sh\/setup-uv@[0-9a-f]{40}\n/);
  assert.match(uv, /\n {6}with:\n {8}version: "\d+\.\d+\.\d+"\n {8}enable-cache: false\n {8}working-directory: \.review-base\n/);
  assert.match(setup, /SERENA_VERSION: "\d+\.\d+\.\d+"\n/);
  assert.match(setup, /uv tool install --python 3\.13 "serena-agent==\$SERENA_VERSION"/);
});

test('config comes from the trust checkout; Serena indexes a copy, never the workspace', () => {
  assert.match(setup, /\n\s+cfg=\.review-base\/\.pr-review\/serena\n/);
  assert.match(setup, /--project "\$SR_HOME\/src"/);
  assert.doesNotMatch(setup, /--project "?\$\{?GITHUB_WORKSPACE/);
  assert.match(setup, /node "\$KIT_ROOT\/engine\/serena-prep\.mjs" files \\\n\s+\| sudo rsync [^\n]*--ignore-missing-args --from0 --files-from=- \.\/ "\$SR_HOME\/src\/"/);
  assert.match(setup, /node "\$KIT_ROOT\/engine\/serena-prep\.mjs" project-files \\\n\s+\| sudo rsync [^\n]*--from0 --files-from=- \.review-base\/ "\$SR_HOME\/src\/"/, 'the trust .pr-review/ copy is filtered too');
  const base = at('--files-from=- .review-base/ "$SR_HOME/src/"');
  assert.ok(at('--files-from=-') < base && base < at('sudo chown -R root:root "$SR_HOME/src"'));
  assert.ok(at('sudo chown -R root:root "$SR_HOME/src"') < at('sudo install -d -o "$SR_USER" -m 700 "$SR_HOME/src/.serena"'));
  assert.ok(at('--files-from=-') < at('sudo install -o "$SR_USER" -m 600 "$cfg/project.yml" "$SR_HOME/src/.serena/project.yml"'));
});

test('the MCP server and every Serena command run as serena-runner with an empty environment, from its home', () => {
  assert.match(setup, /SR_USER: serena-runner\n/);
  assert.match(setup, /"command": "sudo", "args": sys\.argv\[2:\]/);
  assert.match(setup, /\n {10}-n -u "\$SR_USER" -H env -i -C "\$SR_HOME" "HOME=\$SR_HOME" "PATH=\$SR_PATH" "SERENA_HOME=\$SR_HOME\/serena-home" SERENA_USAGE_REPORTING=false \\\n/);
  assert.match(setup, /run_as\(\) \{ sudo -n -u "\$SR_USER" -H env -i -C "\$SR_HOME" [^}]*SERENA_USAGE_REPORTING=false "\$@"; \}/);
  assert.match(setup, /--mode editing --log-level WARNING/);
});

test('language servers install against a throwaway project; PR code is indexed only offline, after the probes', () => {
  const warm = at('project index "$SR_HOME/ls-warmup"');
  const chmod = at('chmod 700 "$GITHUB_WORKSPACE/.git" "$RUNNER_TEMP"');
  const v4 = at('sudo iptables -I OUTPUT 1 -m owner --uid-owner "$SR_USER" -j REJECT');
  const v6 = at('sudo ip6tables -I OUTPUT 1 -m owner --uid-owner "$SR_USER" -j REJECT');
  const probes = at('curl -sS --max-time 5');
  const prIndex = at('project index "$SR_HOME/src"');
  const outputs = at('>> "$GITHUB_OUTPUT"');
  assert.ok(at('serena-prep.mjs" warmup') < warm);
  assert.ok(warm < chmod && chmod < v4 && v4 < v6 && v6 < probes && probes < prIndex && prIndex < outputs);
  assert.equal(setup.split('project index').length, 3);
  assert.doesNotMatch(setup, /-o lo|iptables -A OUTPUT/);
  for (const probe of ['reached the network', 'can resolve DNS names', 'can read the workspace .git/config', 'can list RUNNER_TEMP', 'relative to the workspace', 'can write the source copy', 'environment is not empty']) {
    assert.ok(at(probe) < prIndex, probe);
  }
  assert.match(setup, /rel_temp="\$\(realpath --relative-to="\$PWD" "\$RUNNER_TEMP"\)"/);
  assert.doesNotMatch(setup, /chmod [^\n]*\/home\/runner|setfacl/, '/home/runner is never opened up');
});

test("a trust-SHA Serena config that fails validate's rules is never installed", () => {
  const check = at('if ! node "$KIT_ROOT/engine/serena-prep.mjs" check; then');
  assert.ok(check < at('sudo useradd') && check < at('uv tool install'));
  assert.match(setup.slice(check), /^if ! node [^\n]*\n[^\n]*::warning::[^\n]*\n\s+exit 0\n/);
});

test('exactly one base prompt template must override connection_prompt, or Serena stays off', () => {
  assert.match(setup, /overrides="\$\(\{ grep -lE '\^  connection_prompt:' "\$cfg"\/prompt_templates\/\*\.yml 2>\/dev\/null \|\| true; \} \| wc -l/);
  assert.match(setup, /\[ "\$overrides" != "1" \]/);
  assert.ok(at('"$cfg"/prompt_templates/*.yml "$SR_HOME/serena-home/prompt_templates/"') < at('project index "$SR_HOME/ls-warmup"'));
});

test('the Review step gives MCP time to start and says when Serena was on but did not start', () => {
  assert.match(review, /\n {6}env:\n {8}MCP_TIMEOUT: "\d+"\n/);
  assert.match(review, /inputs\.serena == 'on' && steps\.serena\.outputs\.prompt == '' && '[^']*code navigation unavailable[^']*## Not reviewed \/ limits[^']*' \|\| ''/);
});

test('Stop Serena runs always, re-kills, cleans temp space, and records ok only when nothing survives', () => {
  const stop = stepText(action, 'Stop Serena');
  assert.ok(action.indexOf('- name: Review\n') < action.indexOf('- name: Stop Serena'));
  assert.match(stop, /\n {6}if: always\(\)\n/);
  assert.match(stop, /for _ in 1 2 3 4 5; do\n(?:.*\n)*? +sudo pkill -KILL -u serena-runner \|\| true\n/);
  assert.match(stop, /sudo find \/tmp \/var\/tmp \/dev\/shm -xdev -user serena-runner -delete/);
  assert.equal(stop.split('PR_REVIEW_SERENA_STOP=ok').length, 3, 'ok when serena-runner never existed or every process is gone');
  assert.match(stop, /\n {8}exit 1\n?$/);
  assert.ok(at('echo "PR_REVIEW_SERENA_STOP=pending" >> "$GITHUB_ENV"') < at('sudo useradd'), 'pending before anything starts');
});

test('publish refuses to run its secret-bearing step unless Serena stopped', () => {
  const guard = stepText(publish, 'Serena stopped');
  assert.match(guard, /if \[ -n "\$\{PR_REVIEW_SERENA_STOP:-\}" \] && \[ "\$PR_REVIEW_SERENA_STOP" != "ok" \]; then\n[^\n]*\n {10}exit 1/);
  assert.ok(publish.indexOf('- name: Serena stopped') < publish.indexOf('- name: Publish\n'));
  assert.doesNotMatch(stepText(publish, 'Publish'), /\n {6}if:/, 'Publish runs only when every earlier step succeeded');
  assert.match(stepText(publish, 'Cleanup'), /if: always\(\)/);
});

const config = (serena, withheld = []) => normalizeConfig({ version: 1, classes: [{ id: 1, name: 'x' }], serena, withheld }).config;

test('copyList drops Serena state, the reviewer project, the action checkouts, configured dirs and withheld paths', () => {
  const c = config({ exclude: ['node_modules', 'public', 'lib', '_legacy'] }, ['clients/**']);
  const kept = ['homegroups/functions/src/index.ts', 'regroup/mobile/src/App.tsx', '.claude/rules/react.md', 'lib.ts', 'publicity/x.ts'];
  const dropped = ['.serena/project.yml', 'x/.serena/y', '.pr-review/REVIEW.md', '.review-base/x.ts', '.review-publish/y.ts', '.claude-pr/a', 'recovery-api/lib/x.js', 'regroup/web/public/x.js', 'a/node_modules/b.js', 'homegroups/_legacy/x.ts', 'clients/acme/notes.md'];
  assert.deepEqual(copyList([...kept, ...dropped, ''], c), kept);
});

test('serena.exclude takes directory names only; the default skips common build output', () => {
  assert.deepEqual(config(undefined).serena.exclude, ['node_modules', 'dist', 'build', '.next', 'coverage']);
  for (const bad of ['a/b', '..', '*', '']) {
    const { errors } = normalizeConfig({ version: 1, classes: [{ id: 1, name: 'x' }], serena: { exclude: [bad] } });
    assert.ok(errors.some((e) => e.startsWith('serena.exclude[0]')), JSON.stringify(bad));
  }
});

test('languageServers reads inline and block lists; warmupFiles covers each or fails', () => {
  assert.deepEqual(languageServers('a: 1\nlanguage_servers: ["typescript", "markdown", "yaml"]\n'), ['typescript', 'markdown', 'yaml']);
  assert.deepEqual(languageServers('language_servers:\n  - python\n  - "bash"\nnext: 1\n'), ['python', 'bash']);
  assert.deepEqual(warmupFiles(['typescript', 'yaml']), [WARMUP.typescript, WARMUP.yaml]);
  assert.throws(() => warmupFiles(['rust']), /no warmup file for language server\(s\): rust/);
  assert.throws(() => warmupFiles([]), /no language_servers/);
});

test('projectCopyList keeps the trust .pr-review/ minus Serena state and withheld paths', () => {
  const c = config(undefined, ['.pr-review/private/**']);
  const paths = ['.pr-review/REVIEW.md', '.pr-review/serena/project.yml', '.pr-review/.serena/cache', '.pr-review/private/notes.md', 'src/a.ts', ''];
  assert.deepEqual(projectCopyList(paths, c), ['.pr-review/REVIEW.md', '.pr-review/serena/project.yml']);
});

test('an existing serena-runner (a reused runner) means no Serena, and the copies never carry symlinks', () => {
  const guard = at('if id "$SR_USER" >/dev/null 2>&1; then');
  assert.ok(guard < at('sudo useradd'));
  assert.match(setup.slice(guard), /^if id [^\n]*\n[^\n]*::warning::[^\n]*\n\s+exit 0\n/);
  assert.equal(setup.split('sudo rsync -a --no-links ').length, 3, 'both copies use --no-links');
});
