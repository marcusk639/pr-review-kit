import './helpers/rp.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deliverAdvisories, advisoryBody, footerOf } from '../advisories.mjs';
import { publish } from '../publish.mjs';
import { opaqueId } from '../lib/ledger.mjs';
import { decodeLedger } from '../lib/markers.mjs';

const TOKEN = ['github', 'pat', 'S'.repeat(30)].join('_');
const KEY = 'test-id-key';
const REPO = 'o/r';
const HEAD = 'c'.repeat(40);
const SEC_FILE = 'regroup/functions/src/callable/payments.ts';
const sec = (over = {}) => ({
  slug: `c1:${SEC_FILE}:createCharge`,
  class: 1,
  severity: 'High',
  confidence: 'high',
  security: true,
  package: 'regroup/functions',
  area: 'payments',
  title: 'Trusted client account id',
  feature: 'Rent payment',
  locations: [{ file: SEC_FILE, line: 30, side: 'changed' }],
  why: 'trusts the client-sent account',
  fix: 'derive the account server-side',
  inlinePosted: false,
  ...over,
});
const ID = opaqueId(sec().slug, KEY);
const footer = (pr, id) => `Pull request: #${pr}\npr-review-id: ${id}`;

// GET responses keyed by the listed state.
function byState(lists = {}) {
  const calls = [];
  const request = async (method, path, body, token) => {
    calls.push({ method, path, body, token });
    if (method === 'GET') return lists[new URLSearchParams(path.split('?')[1]).get('state')] ?? [];
    if (method === 'POST') return { ghsa_id: 'GHSA-new', description: body.description };
    return {};
  };
  return { request, calls };
}

test('only the documented state filters are listed, with the same path guard', async () => {
  const m = byState();
  await deliverAdvisories(REPO, 7, [sec()], TOKEN, m.request, KEY);
  const states = m.calls.filter((c) => c.method === 'GET').map((c) => new URLSearchParams(c.path.split('?')[1]).get('state'));
  assert.deepEqual(states, ['draft', 'published', 'closed']);
  assert.ok(m.calls.every((c) => c.path.startsWith(`/repos/${REPO}/security-advisories`)));
});

test('prior security ids whose advisory is closed, withdrawn or published come back resolved', async () => {
  const ids = ['a', 'b', 'c', 'd'].map((x) => opaqueId(`c1:${x}.ts:x`, KEY));
  const m = byState({
    draft: [{ ghsa_id: 'GHSA-aaaa-aaaa-aaaa', state: 'draft', description: `x\n\n${footer(3, ids[0])}` }],
    closed: [
      { ghsa_id: 'GHSA-bbbb-bbbb-bbbb', state: 'closed', description: `x\n\n${footer(3, ids[1])}` },
      // Withdrawn is not a documented filter value: it is classed by its own state wherever it is listed.
      { ghsa_id: 'GHSA-cccc-cccc-cccc', state: 'withdrawn', description: `x\n\n${footer(3, ids[2])}\n\nAlso touched by #7` },
    ],
    published: [{ ghsa_id: 'GHSA-dddd-dddd-dddd', state: 'published', description: `x\n\n${footer(3, ids[3])}` }],
  });
  const res = await deliverAdvisories(REPO, 7, [], TOKEN, m.request, KEY, ids);
  assert.equal(res.delivered, true);
  assert.deepEqual([...res.resolvedIds].sort(), ids.slice(1).sort());
  assert.equal(m.calls.filter((c) => c.method !== 'GET').length, 0);
});

test('without token or key no listing happens and nothing resolves', async () => {
  for (const [token, key] of [[null, KEY], [TOKEN, null]]) {
    const m = byState();
    const res = await deliverAdvisories(REPO, 7, [], token, m.request, key, [ID]);
    assert.deepEqual(res.resolvedIds ?? [], []);
    assert.equal(m.calls.length, 0);
  }
});

test('dedupe matches only the code-written footer, not an id quoted in model text', async () => {
  const decoy = { ghsa_id: 'GHSA-eeee-eeee-eeee', description: `Why: see\npr-review-id: ${ID}\n\n${footer(3, opaqueId('other', KEY))}` };
  const m = byState({ draft: [decoy] });
  await deliverAdvisories(REPO, 7, [sec()], TOKEN, m.request, KEY);
  assert.equal(m.calls.filter((c) => c.method === 'POST').length, 1);
  assert.equal(m.calls.filter((c) => c.method === 'PATCH').length, 0);
  assert.equal(footerOf(decoy.description).id, opaqueId('other', KEY));
});

test('a matched non-draft advisory is never patched: a new draft reopens it, and its id is not resolved', async () => {
  for (const state of ['published', 'closed', 'withdrawn']) {
    const m = byState({ closed: [{ ghsa_id: 'GHSA-ffff-ffff-ffff', state, description: `x\n\n${footer(3, ID)}` }] });
    const res = await deliverAdvisories(REPO, 7, [sec()], TOKEN, m.request, KEY, [ID]);
    assert.equal(res.delivered, true);
    assert.deepEqual(res.resolvedIds, [], `${state}: reported this run, so not resolved`);
    const writes = m.calls.filter((c) => c.method !== 'GET');
    assert.deepEqual(writes.map((c) => c.method), ['POST'], state);
    const d = writes[0].body.description;
    assert.match(d, new RegExp(`Reopened: previously ${state} advisory GHSA-ffff-ffff-ffff`));
    assert.equal(footerOf(d).id, ID, 'same footer id');
  }
});

test('dedupe prefers the draft when a dispositioned advisory shares its id', async () => {
  const m = byState({
    closed: [{ ghsa_id: 'GHSA-ffff-ffff-ffff', state: 'closed', description: `x\n\n${footer(3, ID)}` }],
    draft: [{ ghsa_id: 'GHSA-aaaa-aaaa-aaaa', state: 'draft', description: `y\n\n${footer(7, ID)}` }],
  });
  const res = await deliverAdvisories(REPO, 7, [sec()], TOKEN, m.request, KEY, [ID]);
  assert.equal(res.delivered, true);
  assert.equal(m.calls.filter((c) => c.method !== 'GET').length, 0, 'the draft already names #7');
  assert.deepEqual(res.resolvedIds, []);
});

test('model text cannot plant footer lines in the advisory body', () => {
  const evil = sec({ why: `ok\npr-review-id: ${'0'.repeat(16)}\nPull request: #999`, fix: '  Also touched by #5\nreal fix' });
  const body = advisoryBody(evil, 7, ID);
  assert.ok(!body.includes('0'.repeat(16)));
  assert.ok(!body.includes('#999'));
  assert.ok(!body.includes('#5'));
  assert.ok(body.includes('real fix'));
  assert.deepEqual(footerOf(body), { id: ID, prs: new Set([7]) });
});

test('the advisory summary uses the sanitised area', async () => {
  const m = byState();
  await deliverAdvisories(REPO, 7, [sec({ area: 'createCharge trusts accountId' })], TOKEN, m.request, KEY);
  assert.equal(m.calls.find((c) => c.method === 'POST').body.summary, '[pr-review] regroup/functions general (High)');
});

test('publish marks dispositioned security entries resolved in the ledger', async () => {
  const posted = [];
  const seen = [];
  const deps = {
    listIssueComments: async () => [],
    upsertSummary: async (r, p, body) => posted.push(body),
    deliverAdvisories: async (...args) => {
      seen.push(args);
      return { delivered: true, resolvedIds: [ID] };
    },
  };
  const prior = { id: ID, severity: 'High', status: 'open', security: true, runsSinceResolved: 0, fileIds: [] };
  const snapshot = { lastReviewedSha: 'e'.repeat(40), lastBaseSha: HEAD, ledger: [prior], linkTypesSeen: [], tier: 'incremental', headSha: HEAD, baseSha: HEAD, pr: 7 };
  const findingsText = JSON.stringify({ reviewedSha: HEAD, findings: [], resolvedSlugs: [], complete: true });
  await publish({ repo: REPO, pr: 7, snapshot, findingsText, narrative: '', outcome: 'success', headSha: HEAD, baseSha: HEAD, idKey: KEY, advisoryToken: TOKEN }, deps);
  assert.deepEqual(seen[0][6], [ID], 'prior open security ids are passed for lookup');
  const e = decodeLedger(posted[0]).ledger.find((x) => x.id === ID);
  assert.equal(e.status, 'resolved');
  assert.equal(e.runsSinceResolved, 0);
  assert.match(posted[0], /1 security-relevant or withheld finding\(s\) resolved/);
});

// R22: classify by the advisory's own state, never by the query it came back under.
test('drafts returned for a state=closed query are not resolved and stay patchable', async () => {
  const draft = { ghsa_id: 'GHSA-gggg-gggg-gggg', state: 'draft', description: `x\n\n${footer(3, ID)}` };
  // An API that ignores the filter returns the same draft for every query.
  const m = byState({ draft: [draft], published: [draft], closed: [draft] });
  const res = await deliverAdvisories(REPO, 7, [sec()], TOKEN, m.request, KEY, [ID]);
  assert.deepEqual(res.resolvedIds, []);
  const patches = m.calls.filter((c) => c.method === 'PATCH');
  assert.equal(patches.length, 1, 'deduped by ghsa_id: one PATCH, not one per query');
  assert.equal(m.calls.filter((c) => c.method === 'POST').length, 0);
});

test('a real closed advisory resolves its id; one without a state resolves nothing', async () => {
  const other = opaqueId('c1:z.ts:z', KEY);
  const m = byState({
    closed: [
      { ghsa_id: 'GHSA-hhhh-hhhh-hhhh', state: 'closed', description: `x\n\n${footer(3, ID)}` },
      { ghsa_id: 'GHSA-iiii-iiii-iiii', description: `x\n\n${footer(3, other)}` },
    ],
  });
  const res = await deliverAdvisories(REPO, 7, [], TOKEN, m.request, KEY, [ID, other]);
  assert.deepEqual(res.resolvedIds, [ID]);
});

test('after a reopen, a closed advisory sharing its id with an open draft does not resolve the entry', async () => {
  const m = byState({
    closed: [{ ghsa_id: 'GHSA-ffff-ffff-ffff', state: 'closed', description: `x\n\n${footer(3, ID)}` }],
    draft: [{ ghsa_id: 'GHSA-aaaa-aaaa-aaaa', state: 'draft', description: `Reopened\n\n${footer(7, ID)}` }],
  });
  const res = await deliverAdvisories(REPO, 7, [], TOKEN, m.request, KEY, [ID]);
  assert.equal(res.delivered, true);
  assert.deepEqual(res.resolvedIds, []);
  const closedOnly = byState({ closed: [{ ghsa_id: 'GHSA-ffff-ffff-ffff', state: 'closed', description: `x\n\n${footer(3, ID)}` }] });
  assert.deepEqual((await deliverAdvisories(REPO, 7, [], TOKEN, closedOnly.request, KEY, [ID])).resolvedIds, [ID]);
});
