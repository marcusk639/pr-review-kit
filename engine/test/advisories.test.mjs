import './helpers/rp.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deliverAdvisories } from '../advisories.mjs';
import { publish } from '../publish.mjs';
import { opaqueId } from '../lib/ledger.mjs';
import { nextPath } from '../lib/gh.mjs';

// Built at runtime so this source holds no secret-shaped literal.
const TOKEN = ['github', 'pat', 'T'.repeat(30)].join('_');
const FAKE_WHSEC = 'whsec' + '_' + 'B'.repeat(16);
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
  why: `trusts the client-sent account; sample key ${FAKE_WHSEC}`,
  fix: 'derive the account server-side',
  inlinePosted: false,
  ...over,
});

const ID = opaqueId(sec().slug, KEY);

// A recording request mock. `pages` are the GET responses in order; `fail` throws on a method.
function mock({ pages = [[]], fail = null } = {}) {
  const calls = [];
  let page = 0;
  const request = async (method, path, body, token) => {
    calls.push({ method, path, body, token });
    if (fail && (fail === true || fail === method)) {
      const err = new Error(`GitHub API ${method} ${path} failed: 403`);
      err.status = 403;
      throw err;
    }
    if (method === 'GET') return pages[page++] ?? [];
    if (method === 'POST') return { ghsa_id: 'GHSA-new', description: body.description };
    return {};
  };
  return { request, calls };
}

async function captureLogs(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try {
    return { result: await fn(), logs: lines.join('\n') };
  } finally {
    console.log = orig;
  }
}

test('no token gives no-token and makes zero requests', async () => {
  const m = mock();
  assert.deepEqual(await deliverAdvisories(REPO, 7, [sec()], '', m.request, KEY), { delivered: false, reason: 'no-token' });
  assert.equal(m.calls.length, 0);
});

test('no id key gives no-key and makes zero requests', async () => {
  const m = mock();
  assert.deepEqual(await deliverAdvisories(REPO, 7, [sec()], TOKEN, m.request, null), { delivered: false, reason: 'no-key' });
  assert.equal(m.calls.length, 0);
});

test('no security findings delivers trivially with zero requests', async () => {
  const m = mock();
  assert.deepEqual(await deliverAdvisories(REPO, 7, [], '', m.request, KEY), { delivered: true, resolvedIds: [] });
  assert.equal(m.calls.length, 0);
});

test('an existing advisory with a matching id gets one PATCH and no POST', async () => {
  const original = `old detail\n\nPull request: #3\npr-review-id: ${ID}`;
  const existing = { ghsa_id: 'GHSA-aaaa-bbbb-cccc', state: 'draft', description: original };
  const m = mock({ pages: [[{ ghsa_id: 'GHSA-other', description: 'pr-review-id: 0000000000000000' }, existing]] });
  const res = await deliverAdvisories(REPO, 7, [sec()], TOKEN, m.request, KEY);
  assert.deepEqual(res, { delivered: true, resolvedIds: [] });
  assert.equal(m.calls[0].method, 'GET');
  assert.equal(m.calls[0].path, `/repos/${REPO}/security-advisories?state=draft&per_page=100`);
  const writes = m.calls.filter((c) => c.method !== 'GET');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].method, 'PATCH');
  assert.equal(writes[0].path, `/repos/${REPO}/security-advisories/GHSA-aaaa-bbbb-cccc`);
  assert.equal(writes[0].body.description, `${original}\n\nAlso touched by #7`);
  assert.ok(m.calls.every((c) => c.token === TOKEN));
});

test('the "Also touched by" note is appended once per PR', async () => {
  const touched = { ghsa_id: 'GHSA-aaaa-bbbb-cccc', state: 'draft', description: `d\n\nPull request: #3\npr-review-id: ${ID}\n\nAlso touched by #7` };
  const own = { ghsa_id: 'GHSA-bbbb-cccc-dddd', state: 'draft', description: `d\n\nPull request: #7\npr-review-id: ${opaqueId('c4:x.ts:y', KEY)}` };
  const m = mock({ pages: [[touched, own]] });
  const res = await deliverAdvisories(REPO, 7, [sec(), sec({ slug: 'c4:x.ts:y', class: 4 })], TOKEN, m.request, KEY);
  assert.deepEqual(res, { delivered: true, resolvedIds: [] });
  assert.equal(m.calls.filter((c) => c.method !== 'GET').length, 0);
});

test('#7 is not mistaken for #70', async () => {
  const touched = { ghsa_id: 'GHSA-aaaa-bbbb-cccc', state: 'draft', description: `d\n\nPull request: #70\npr-review-id: ${ID}\n\nAlso touched by #71` };
  const m = mock({ pages: [[touched]] });
  await deliverAdvisories(REPO, 7, [sec()], TOKEN, m.request, KEY);
  assert.equal(m.calls.filter((c) => c.method === 'PATCH').length, 1);
});

test('a new id gets one POST with the full private detail', async () => {
  const m = mock({ pages: [[]] });
  const res = await deliverAdvisories(REPO, 7, [sec()], TOKEN, m.request, KEY);
  assert.deepEqual(res, { delivered: true, resolvedIds: [] });
  const posts = m.calls.filter((c) => c.method === 'POST');
  assert.equal(posts.length, 1);
  const { path, body } = posts[0];
  assert.equal(path, `/repos/${REPO}/security-advisories`);
  assert.equal(body.severity, 'high');
  assert.equal(body.summary, '[pr-review] regroup/functions payments (High)');
  assert.deepEqual(body.vulnerabilities, [{ package: { ecosystem: 'other', name: 'recovery-platform/regroup/functions' } }]);
  for (const s of ['Trusted client account id', `${SEC_FILE}:30`, 'derive the account server-side', 'Rent payment', '#7', `pr-review-id: ${ID}`]) {
    assert.ok(body.description.includes(s), s);
  }
  assert.ok(!body.description.includes(FAKE_WHSEC), 'secret values are redacted even privately');
});

test('two findings with the same id in one run create one advisory', async () => {
  const m = mock({ pages: [[]] });
  await deliverAdvisories(REPO, 7, [sec(), sec({ title: 'dupe' })], TOKEN, m.request, KEY);
  assert.equal(m.calls.filter((c) => c.method === 'POST').length, 1);
  assert.equal(m.calls.filter((c) => c.method === 'PATCH').length, 0);
});

test('the draft listing is followed across pages', async () => {
  const filler = Array.from({ length: 100 }, (_, i) => ({ ghsa_id: `GHSA-f${i}`, description: 'x' }));
  const page1 = Object.assign(filler, {});
  Object.defineProperty(page1, 'next', { value: `/repos/${REPO}/security-advisories?state=draft&per_page=100&after=abc` });
  const existing = { ghsa_id: 'GHSA-aaaa-bbbb-cccc', state: 'draft', description: `d\n\nPull request: #3\npr-review-id: ${ID}` };
  const m = mock({ pages: [page1, [existing]] });
  await deliverAdvisories(REPO, 7, [sec()], TOKEN, m.request, KEY);
  const gets = m.calls.filter((c) => c.method === 'GET' && c.path.includes('state=draft'));
  assert.equal(gets.length, 2);
  assert.equal(gets[1].path, page1.next);
  assert.equal(m.calls.filter((c) => c.method === 'POST').length, 0);
  assert.equal(m.calls.filter((c) => c.method === 'PATCH').length, 1);
});

test('a next link off the advisories path is never followed', async () => {
  const page1 = Array.from({ length: 100 }, () => ({ description: 'x' }));
  Object.defineProperty(page1, 'next', { value: '/user/repos' });
  const m = mock({ pages: [page1] });
  await deliverAdvisories(REPO, 7, [sec()], TOKEN, m.request, KEY);
  // One GET per state, none following the foreign link.
  assert.equal(m.calls.filter((c) => c.method === 'GET').length, 3);
  assert.ok(m.calls.filter((c) => c.method === 'GET').every((c) => c.path.startsWith(`/repos/${REPO}/security-advisories?state=`)));
});

test('nextPath keeps only same-host rel=next links', () => {
  const next = 'https://api.github.com/repos/o/r/security-advisories?after=abc&per_page=100';
  assert.equal(nextPath(`<${next}>; rel="next", <https://api.github.com/x>; rel="prev"`), '/repos/o/r/security-advisories?after=abc&per_page=100');
  assert.equal(nextPath('<https://evil.example/repos>; rel="next"'), null);
  assert.equal(nextPath(null), null);
});

test('a throwing request gives api-error and logs no finding text or token', async () => {
  for (const fail of [true, 'POST']) {
    const m = mock({ pages: [[]], fail });
    const { result, logs } = await captureLogs(() => deliverAdvisories(REPO, 7, [sec()], TOKEN, m.request, KEY));
    assert.deepEqual(result, { delivered: false, reason: 'api-error' });
    assert.match(logs, /advisories failed: 403/);
    for (const s of [TOKEN, SEC_FILE, 'payments', 'Trusted client', 'derive the account', 'GHSA', ID]) assert.ok(!logs.includes(s), s);
  }
});

test('a partial failure (one created, one failed) is api-error', async () => {
  let posts = 0;
  const request = async (method, path, body) => {
    if (method === 'GET') return [];
    if (++posts === 2) throw Object.assign(new Error('boom'), { status: 422 });
    return { ghsa_id: 'GHSA-new', description: body.description };
  };
  const { result, logs } = await captureLogs(() => deliverAdvisories(REPO, 7, [sec(), sec({ slug: 'c4:x.ts:y' })], TOKEN, request, KEY));
  assert.deepEqual(result, { delivered: false, reason: 'api-error' });
  assert.match(logs, /advisories failed: 422/);
});

test('success logs counts only', async () => {
  const m = mock({ pages: [[]] });
  const { logs } = await captureLogs(() => deliverAdvisories(REPO, 7, [sec()], TOKEN, m.request, KEY));
  assert.equal(logs, 'advisories: created 1, updated 0');
});

// Wiring: publish delivers before rendering, so the pointer reflects delivery.
function runPublish(deliver, over = {}) {
  const posted = [];
  const seen = [];
  const deps = {
    listIssueComments: async () => [],
    upsertSummary: async (repo, pr, body, token) => posted.push({ body, token }),
    deliverAdvisories: async (...args) => {
      seen.push(args);
      return deliver;
    },
  };
  const snapshot = { lastReviewedSha: null, lastBaseSha: null, ledger: [], linkTypesSeen: [], inlineSlugs: [], tier: 'full', maxTurns: 60, headSha: HEAD, baseSha: HEAD, pr: 7 };
  const findingsText = JSON.stringify({ reviewedSha: HEAD, findings: [sec()], resolvedSlugs: [], complete: true });
  const input = { repo: REPO, pr: 7, snapshot, findingsText, narrative: '', outcome: 'success', headSha: HEAD, baseSha: HEAD, idKey: KEY, advisoryToken: TOKEN, ...over };
  return publish(input, deps).then(() => ({ posted, seen }));
}

test('publish passes only security findings and the advisory token to delivery', async () => {
  const { posted, seen } = await runPublish({ delivered: true });
  assert.equal(seen.length, 1);
  const [repo, pr, findings, token, , key] = seen[0];
  assert.deepEqual([repo, pr, token, key], [REPO, 7, TOKEN, KEY]);
  assert.deepEqual(findings.map((f) => f.slug), [sec().slug]);
  assert.match(posted[0].body, /Security-relevant issue \(High\) in regroup\/functions payments; details sent privately/);
  assert.ok(!posted[0].body.includes(TOKEN));
  assert.equal(posted[0].token, undefined, 'the advisory token never reaches the comment call');
});

test('failed delivery switches the public pointer to the re-run variant', async () => {
  const { posted } = await runPublish({ delivered: false, reason: 'no-token' });
  assert.match(
    posted[0].body,
    /Security-relevant issue \(High\) in regroup\/functions payments; details could not be delivered privately; re-run after fixing the advisory token/,
  );
  assert.ok(!posted[0].body.includes('details sent privately'));
});

test('a failed review never attempts delivery', async () => {
  const { seen } = await runPublish({ delivered: true }, { outcome: 'failure' });
  assert.equal(seen.length, 0);
});

test('a delivery that throws still publishes with the failure pointer', async () => {
  const posted = [];
  const deps = {
    listIssueComments: async () => [],
    upsertSummary: async (r, p, body) => posted.push(body),
    deliverAdvisories: async () => {
      throw new Error('unexpected');
    },
  };
  const snapshot = { ledger: [], tier: 'full', headSha: HEAD, baseSha: HEAD, pr: 7 };
  const findingsText = JSON.stringify({ reviewedSha: HEAD, findings: [sec()], resolvedSlugs: [], complete: true });
  await captureLogs(() => publish({ repo: REPO, pr: 7, snapshot, findingsText, narrative: '', outcome: 'success', headSha: HEAD, baseSha: HEAD, idKey: KEY, advisoryToken: TOKEN }, deps));
  assert.match(posted[0], /details could not be delivered privately/);
});
