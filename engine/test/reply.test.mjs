// The model's only posting path besides OUT/inline.json: one sanitized reply per run, from
// OUT/reply.md, to the event's PR. It must never post a file the model names (gh pr comment
// --body-file could have posted .git/config), a secret, or a security finding's file.
import { RP } from './helpers/rp.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runReply, REPLY_MARKER } from '../lib/reply.mjs';
import { SUMMARY_MARKER } from '../lib/markers.mjs';
import { normalizeConfig, setActiveProject } from '../lib/config.mjs';
import { modelTools } from '../facts.mjs';

// recovery-platform's setting: replies on. Other projects default to off.
const projectWith = (over) => {
  const { config, errors } = normalizeConfig({ ...JSON.parse(JSON.stringify(RP.config)), ...over });
  assert.deepEqual(errors, []);
  return { ...RP, config, errors: [] };
};
const PROJECT = projectWith({ model: { ghRead: true, reply: true } });
setActiveProject(PROJECT);

const FAKE_SK = 'sk' + '_live_' + 'A'.repeat(20);
const SEC_FILE = 'regroup/functions/src/callable/payments.ts';

function setup({ reply = 'pr-review: the index is created in firestore.indexes.json.', findings, event, state = { ledger: [] } } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'reply-'));
  const out = join(root, 'out');
  const temp = join(root, 'temp');
  mkdirSync(out);
  mkdirSync(temp);
  const eventPath = join(root, 'event.json');
  writeFileSync(eventPath, JSON.stringify(event ?? { pull_request: { number: 138 }, repository: { full_name: 'o/r' } }));
  if (reply !== null) writeFileSync(join(out, 'reply.md'), reply);
  const f = findings === undefined
    ? { reviewedSha: 'c'.repeat(40), findings: [], resolvedSlugs: [], complete: true }
    : findings;
  if (f !== null) writeFileSync(join(out, 'findings.json'), JSON.stringify(f));
  const env = { OUT: out, RUNNER_TEMP: temp, GITHUB_EVENT_PATH: eventPath };
  if (state !== null) {
    env.STATE_FILE = join(root, 'state.json');
    writeFileSync(env.STATE_FILE, typeof state === 'string' ? state : JSON.stringify(state));
  }
  return { root, out, temp, env };
}

async function run(s, { argv = [], env = s.env, project = PROJECT } = {}) {
  const calls = [];
  const request = async (method, path, body) => { calls.push({ method, path, body }); return { id: 1 }; };
  const result = await runReply({ argv, env, project, request });
  return { result, calls };
}

test('posts the reply once, to the event PR, with the reply marker and never as the summary', async () => {
  const s = setup();
  const { result, calls } = await run(s);
  assert.equal(result.posted, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].path, '/repos/o/r/issues/138/comments');
  assert.match(calls[0].body.body, /^pr-review: the index is created/);
  assert.ok(calls[0].body.body.endsWith(`\n\n${REPLY_MARKER}`));
  assert.ok(!calls[0].body.body.startsWith(SUMMARY_MARKER), 'the summary finder keys on a leading summary marker');
});

test('one reply per run: a second call refuses without posting', async () => {
  const s = setup();
  await run(s);
  const { result, calls } = await run(s);
  assert.equal(result.posted, false);
  assert.match(result.reason, /already/);
  assert.equal(calls.length, 0);
});

const refusals = [
  ['arguments are passed', (s) => ({ argv: ['--body-file', '.git/config'] }), /argument/],
  ['OUT is unset', (s) => ({ env: { ...s.env, OUT: '' } }), /OUT/],
  ['the event file is missing', (s) => ({ env: { ...s.env, GITHUB_EVENT_PATH: join(s.root, 'nope.json') } }), /event/],
];
for (const [name, opts, reason] of refusals) {
  test(`refuses when ${name}`, async () => {
    const s = setup();
    const { result, calls } = await run(s, opts(s));
    assert.equal(result.posted, false);
    assert.match(result.reason, reason);
    assert.equal(calls.length, 0);
  });
}

test('refuses an event without a PR number or repository', async () => {
  const s = setup({ event: { repository: { full_name: 'o/r' } } });
  const { result, calls } = await run(s);
  assert.equal(result.posted, false);
  assert.equal(calls.length, 0);
});

test('refuses a missing, symlinked or oversized reply.md', async () => {
  const missing = setup({ reply: null });
  assert.match((await run(missing)).result.reason, /reply\.md/);
  const linked = setup({ reply: null });
  writeFileSync(join(linked.root, 'secret.txt'), 'pr-review: token');
  symlinkSync(join(linked.root, 'secret.txt'), join(linked.out, 'reply.md'));
  const l = await run(linked);
  assert.equal(l.result.posted, false);
  assert.match(l.result.reason, /regular file/);
  assert.equal(l.calls.length, 0);
  const big = setup({ reply: `pr-review: ${'x'.repeat(5000)}` });
  assert.match((await run(big)).result.reason, /too long/);
});

for (const [name, reply, reason] of [
  ['the pr-review: prefix is missing', 'The index exists.', /pr-review:/],
  ['it contains an HTML comment', 'pr-review: fine <!-- pr-review:summary -->', /HTML comment/],
  ['it contains a secret-shaped value', `pr-review: use ${FAKE_SK}`, /secret/],
  ['it contains a control character', 'pr-review: bell\u0007', /control/],
]) {
  test(`refuses when ${name}`, async () => {
    const s = setup({ reply });
    const { result, calls } = await run(s);
    assert.equal(result.posted, false);
    assert.match(result.reason, reason);
    assert.equal(calls.length, 0);
  });
}

test("refuses a reply naming a security finding's file or slug", async () => {
  const findings = {
    reviewedSha: 'c'.repeat(40),
    resolvedSlugs: [],
    complete: true,
    findings: [{
      slug: `c1:${SEC_FILE}:charge`, class: 1, severity: 'High', confidence: 'high', security: true,
      package: 'regroup/functions', area: 'payments', title: 't', feature: 'f',
      locations: [{ file: SEC_FILE, line: 3, side: 'changed' }], why: 'w', fix: 'x',
    }],
  };
  for (const reply of [`pr-review: see ${SEC_FILE}`, 'pr-review: see callable/payments.ts', `pr-review: c1:${SEC_FILE}:charge`]) {
    const s = setup({ reply, findings });
    const { result, calls } = await run(s);
    assert.equal(result.posted, false, reply);
    assert.match(result.reason, /security/);
    assert.equal(calls.length, 0);
  }
});

test('refuses before findings.json is written, or when it is invalid', async () => {
  for (const findings of [null, { nope: true }]) {
    const s = setup({ findings });
    const { result, calls } = await run(s);
    assert.equal(result.posted, false);
    assert.match(result.reason, /findings\.json/);
    assert.equal(calls.length, 0);
  }
});

test('never puts the reply text or a secret in the result reason', async () => {
  for (const reply of [`pr-review: ${FAKE_SK}`, 'no prefix but long private text here']) {
    const s = setup({ reply });
    const { result } = await run(s);
    assert.ok(!result.reason.includes(FAKE_SK) && !result.reason.includes('private text'), result.reason);
  }
});

test('a failed post reports the status only and still consumes the run\'s one reply', async () => {
  const s = setup();
  const request = async () => { throw Object.assign(new Error('GitHub API POST /x failed: 502'), { status: 502 }); };
  const result = await runReply({ argv: [], env: s.env, project: PROJECT, request });
  assert.equal(result.posted, false);
  assert.match(result.reason, /502/);
  const again = await run(s);
  assert.match(again.result.reason, /already/);
});

// Earlier runs' security files exist only as keyed fileIds, and the key is Publish-only.
const PRIOR_SECURITY = { ledger: [{ id: 'a'.repeat(16), severity: 'High', status: 'resolved', security: true, runsSinceResolved: 1, fileIds: ['b'.repeat(16)] }] };
const PATH_REPLIES = [
  'pr-review: the check lives in regroup/functions/src/callable/payments.ts.',
  'pr-review: see payments.ts for the check.',
  'pr-review: the index is created in firestore.indexes.json.',
];

test('while the ledger holds an earlier security entry, a reply naming any file is refused', async () => {
  for (const reply of PATH_REPLIES) {
    const s = setup({ reply, state: PRIOR_SECURITY });
    const { result, calls } = await run(s);
    assert.equal(result.posted, false, reply);
    assert.match(result.reason, /without a path/);
    assert.equal(calls.length, 0);
  }
  const plain = setup({ reply: 'pr-review: yes, e.g. the retry runs once per webhook (v1.7.0 behaviour).', state: PRIOR_SECURITY });
  assert.equal((await run(plain)).result.posted, true);
});

test('an unknown prior state counts as an earlier security entry: file names are refused', async () => {
  const unknown = [null, 'not json', { ledger: [], priorUnavailable: true }, { notALedger: true }];
  for (const state of unknown) {
    const s = setup({ reply: PATH_REPLIES[1], state });
    const { result, calls } = await run(s);
    assert.equal(result.posted, false, JSON.stringify(state));
    assert.match(result.reason, /without a path/);
    assert.equal(calls.length, 0);
  }
});

test('a ledger with only public entries does not restrict file names', async () => {
  const state = { ledger: [{ id: 'c'.repeat(16), slug: 'c5:a/b.ts:x', title: 't', severity: 'Medium', status: 'open', security: false, runsSinceResolved: 0 }] };
  const s = setup({ reply: PATH_REPLIES[0], state });
  assert.equal((await run(s)).result.posted, true);
});

test('refuses unless the trusted project enables replies, or when its config has errors', async () => {
  for (const project of [projectWith({}), projectWith({ model: { ghRead: true, reply: false } }), { ...PROJECT, errors: ['bad'] }, null]) {
    const s = setup();
    const { result, calls } = await run(s, { project });
    assert.equal(result.posted, false);
    assert.equal(calls.length, 0);
  }
});

test('refuses a reply naming a withheld path, in any case or absolute form', async () => {
  const project = projectWith({ withheld: ['clients/**'], model: { reply: true } });
  for (const text of ['pr-review: see clients/acme/notes.md.', 'pr-review: see /home/x/repo/Clients/acme.md']) {
    const s = setup({ reply: text });
    const { result, calls } = await run(s, { project });
    assert.equal(result.posted, false, text);
    assert.match(result.reason, /withheld/);
    assert.equal(calls.length, 0);
  }
});

test('modelTools: nothing by default; the exact gh and reply rules when enabled; plain paths only', () => {
  assert.deepEqual(modelTools(projectWith({}).config, { out: '/t/pr-review' }), { shell: 'off', allow: '' });
  const both = modelTools(PROJECT.config, { engineDir: '/k/engine', out: '/t/pr-review' });
  assert.equal(both.shell, 'on');
  assert.equal(both.allow, 'Bash(gh pr diff:*),Bash(gh pr view:*),Bash(node /k/engine/reply.mjs),Write(//t/pr-review/reply.md),Edit(//t/pr-review/reply.md),');
  const gh = modelTools(projectWith({ model: { ghRead: true } }).config, { engineDir: '/k/engine', out: '/t/pr-review' });
  assert.equal(gh.allow, 'Bash(gh pr diff:*),Bash(gh pr view:*),');
  const orig = process.stdout.write;
  process.stdout.write = () => true;
  try {
    for (const engineDir of ['/k/en gine', '/k/e,Bash', '/k/e)', 'relative/engine']) {
      assert.deepEqual(modelTools(PROJECT.config, { engineDir, out: '/t/pr-review' }), { shell: 'off', allow: '' }, engineDir);
    }
  } finally {
    process.stdout.write = orig;
  }
});

test('gh read cannot be combined with withheld paths', () => {
  const { errors } = normalizeConfig({ ...JSON.parse(JSON.stringify(RP.config)), model: { ghRead: true }, withheld: ['clients/**'] });
  assert.ok(errors.some((e) => e.includes('model.ghRead cannot be combined with withheld')));
});
