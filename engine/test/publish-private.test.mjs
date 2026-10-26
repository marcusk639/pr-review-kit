import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { RP } from './helpers/rp.mjs';
import { normalizeConfig, setActiveProject } from '../lib/config.mjs';
import { publish } from '../publish.mjs';
import { verifyPrivateChannel } from '../lib/private-channel.mjs';
import { handleOf } from '../lib/feedback.mjs';

const HEAD = 'c'.repeat(40);
const BASE = 'd'.repeat(40);
const KEY = 'k';
const SEC = { slug: 'c1:src/auth.ts:check', class: 1, severity: 'High', confidence: 'high', security: true, package: 'api', area: 'auth', title: 'Token check skipped on retry path', feature: 'login', locations: [{ file: 'src/auth.ts', line: 4, side: 'changed' }], why: 'the retry branch returns before verify()', fix: 'verify first' };
const project = (raw) => ({ ...RP, config: normalizeConfig({ version: 1, project: 'p', classes: [{ id: 1, name: 'auth', security: true }, { id: 9, name: 'x' }], ...raw }).config, routing: [], linkTypes: [] });

afterEach(() => setActiveProject(RP));

function api({ isPrivate = true, collaborators = [{ login: 'marcus' }], fail = null } = {}) {
  return async (method, path) => {
    if (fail && path.includes(fail)) throw Object.assign(new Error('x'), { status: 403 });
    if (path === '/repos/o/r') return { private: isPrivate };
    if (path.startsWith('/repos/o/r/collaborators')) return collaborators;
    if (path === '/repos/o/r/pulls/7') return { head: { sha: HEAD } };
    return null;
  };
}

test('verifyPrivateChannel: a private repo whose collaborators are all readers', async () => {
  assert.deepEqual(await verifyPrivateChannel('o/r', ['marcus'], api()), { verified: true });
});

test('verifyPrivateChannel fails closed: public repo, unknown reader, API failure, empty list', async () => {
  assert.equal((await verifyPrivateChannel('o/r', ['marcus'], api({ isPrivate: false }))).verified, false);
  assert.equal((await verifyPrivateChannel('o/r', ['marcus'], api({ collaborators: [{ login: 'marcus' }, { login: 'guest' }] }))).verified, false);
  assert.equal((await verifyPrivateChannel('o/r', ['marcus'], api({ fail: 'collaborators' }))).verified, false);
  assert.equal((await verifyPrivateChannel('o/r', ['marcus'], api({ collaborators: [] }))).verified, false);
});

async function run(raw, { issues = { delivered: true, resolvedIds: [] }, privateRepo = 'marcus/inbox', issueToken = 'tok' } = {}) {
  setActiveProject(project(raw));
  let summary = null;
  const calls = { advisories: 0, issues: [] };
  const deps = {
    listIssueComments: async () => [],
    upsertSummary: async (repo, pr, body) => {
      summary = body;
    },
    deliverAdvisories: async () => {
      calls.advisories++;
      return { delivered: true, resolvedIds: [] };
    },
    deliverIssues: async (args) => {
      calls.issues.push(args);
      return typeof issues === 'function' ? issues(args) : issues;
    },
    listReviewComments: async () => [],
    request: api(),
    report: () => {},
  };
  const snapshot = { lastReviewedSha: null, lastBaseSha: null, ledger: [], linkTypesSeen: [], runLinkTypes: [], inlineSlugs: [], tier: 'full', maxTurns: 60, headSha: HEAD, baseSha: BASE, pr: 7, changedFiles: ['src/auth.ts'] };
  const findingsText = JSON.stringify({ reviewedSha: HEAD, findings: [SEC], resolvedSlugs: [], complete: true });
  const orig = console.log;
  console.log = () => {};
  try {
    await publish({ repo: 'o/r', pr: 7, snapshot, findingsText, inlineText: '[]', narrative: 'Checked src/auth.ts retry path.', outcome: 'success', headSha: HEAD, baseSha: BASE, idKey: KEY, runStartedAt: null, privateRepo, issueToken }, deps);
  } finally {
    console.log = orig;
  }
  return { summary, calls };
}

const PRIVATE = { visibility: 'private', securityChannel: 'private-repo-issue' };

test('private-repo-issue: the public surface shows only the pointer; details go to the inbox', async () => {
  const { summary, calls } = await run(PRIVATE);
  assert.match(summary, /Security-relevant issue \(High\) in api auth; details sent privately/);
  assert.doesNotMatch(summary, /Token check skipped|src\/auth\.ts/);
  assert.ok(!summary.includes(handleOf(SEC.slug)));
  assert.equal(calls.advisories, 0);
  assert.equal(calls.issues.length, 1);
  assert.deepEqual([calls.issues[0].target, calls.issues[0].token, calls.issues[0].readers], ['marcus/inbox', 'tok', ['o']]);
  assert.equal(calls.issues[0].findings[0].slug, SEC.slug);
});

test('private-repo-issue fails closed: undelivered details say so and stay private', async () => {
  const { summary } = await run(PRIVATE, { issues: { delivered: false } });
  assert.match(summary, /details could not be delivered privately/);
  assert.doesNotMatch(summary, /Token check skipped/);
});

test('channel none never shows detail and never tries a delivery', async () => {
  const { summary, calls } = await run({ visibility: 'private', securityChannel: 'none' });
  assert.match(summary, /details withheld: no private channel configured/);
  assert.doesNotMatch(summary, /Token check skipped/);
  assert.equal(calls.advisories + calls.issues.length, 0);
});

test('an earlier security entry does not claim private delivery on a channel that has none', async () => {
  const { renderSummary } = await import('../lib/render.mjs');
  setActiveProject(project({ visibility: 'private', securityChannel: 'none' }));
  const ledger = { lastReviewedSha: null, lastBaseSha: null, linkTypesSeen: [], ledger: [{ id: '0123456789abcdef', severity: 'High', status: 'open', security: true, runsSinceResolved: 0, fileIds: [] }] };
  const body = renderSummary({ state: { tier: 'full' }, findings: null, narrative: '', outcome: 'failure', ledger });
  assert.match(body, /Security-relevant issue \(High\) reported earlier; details not shown here/);
  setActiveProject(RP);
  assert.match(renderSummary({ state: { tier: 'full' }, findings: null, narrative: '', outcome: 'failure', ledger }), /reported earlier; details sent privately/);
});
