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
const PRIVATE = { visibility: 'private', securityChannel: 'repo-comments', privateReaders: ['marcus'] };

afterEach(() => setActiveProject(RP));

function api({ isPrivate = true, collaborators = [{ login: 'marcus' }], fail = null } = {}) {
  const calls = [];
  const request = async (method, path) => {
    calls.push(`${method} ${path}`);
    if (fail && path.includes(fail)) throw Object.assign(new Error('x'), { status: 403 });
    if (path === '/repos/o/r') return { private: isPrivate };
    if (path.startsWith('/repos/o/r/collaborators')) return collaborators;
    if (path === '/repos/o/r/pulls/7') return { head: { sha: HEAD } };
    return null;
  };
  return { request, calls };
}

test('verifyPrivateChannel: private repo whose collaborators are all readers', async () => {
  assert.deepEqual(await verifyPrivateChannel('o/r', ['marcus'], api().request), { verified: true });
});

test('verifyPrivateChannel fails closed: public repo, unknown reader, API failure', async () => {
  assert.equal((await verifyPrivateChannel('o/r', ['marcus'], api({ isPrivate: false }).request)).verified, false);
  assert.equal((await verifyPrivateChannel('o/r', ['marcus'], api({ collaborators: [{ login: 'marcus' }, { login: 'guest' }] }).request)).verified, false);
  assert.equal((await verifyPrivateChannel('o/r', ['marcus'], api({ fail: 'collaborators' }).request)).verified, false);
  assert.equal((await verifyPrivateChannel('o/r', ['marcus'], api({ collaborators: [] }).request)).verified, false, 'an empty list is not evidence');
});

async function run(raw, apiOpts) {
  setActiveProject(project(raw));
  const a = api(apiOpts);
  let summary = null;
  let delivered = 0;
  const deps = {
    listIssueComments: async () => [],
    upsertSummary: async (repo, pr, body) => {
      summary = body;
    },
    deliverAdvisories: async () => {
      delivered++;
      return { delivered: true, resolvedIds: [] };
    },
    listReviewComments: async () => [],
    request: a.request,
    report: () => {},
  };
  const snapshot = { lastReviewedSha: null, lastBaseSha: null, ledger: [], linkTypesSeen: [], runLinkTypes: [], inlineSlugs: [], tier: 'full', maxTurns: 60, headSha: HEAD, baseSha: BASE, pr: 7, changedFiles: ['src/auth.ts'] };
  const findingsText = JSON.stringify({ reviewedSha: HEAD, findings: [SEC], resolvedSlugs: [], complete: true });
  const orig = console.log;
  console.log = () => {};
  try {
    await publish({ repo: 'o/r', pr: 7, snapshot, findingsText, inlineText: '[]', narrative: 'Checked src/auth.ts retry path.', outcome: 'success', headSha: HEAD, baseSha: BASE, idKey: KEY, runStartedAt: null }, deps);
  } finally {
    console.log = orig;
  }
  return { summary, delivered };
}

test('a verified private channel shows security findings in full, tagged, with a handle', async () => {
  const { summary, delivered } = await run(PRIVATE);
  assert.match(summary, /security-relevant: Token check skipped on retry path/);
  assert.match(summary, /src\/auth\.ts:4/);
  assert.ok(summary.includes(handleOf(SEC.slug)));
  assert.match(summary, /Checked src\/auth\.ts retry path\./, 'narrative is not withheld');
  assert.equal(delivered, 0, 'no advisory for a private repo');
});

test('an unverified private channel shows only the pointer and says why', async () => {
  const { summary, delivered } = await run(PRIVATE, { collaborators: [{ login: 'marcus' }, { login: 'guest' }] });
  assert.doesNotMatch(summary, /Token check skipped/);
  assert.doesNotMatch(summary, /src\/auth\.ts/);
  assert.match(summary, /Security-relevant issue \(High\) in api auth; details withheld: no verified private channel/);
  assert.equal(delivered, 0);
});

test('channel none never shows detail and never tries an advisory', async () => {
  const { summary, delivered } = await run({ visibility: 'private', securityChannel: 'none' });
  assert.match(summary, /details withheld: no verified private channel/);
  assert.doesNotMatch(summary, /Token check skipped/);
  assert.equal(delivered, 0);
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
