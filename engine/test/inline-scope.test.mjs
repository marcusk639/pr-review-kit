import './helpers/rp.mjs';
// R20, parked minors 1 and 3: which inline comments the guard may touch, the
// shared forced-security predicate, and prior security files named in a body.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateFindings, isForcedSecurity } from '../lib/findings.mjs';
import { opaqueId } from '../lib/ledger.mjs';
import { fileId } from '../lib/fileids.mjs';
import { guardInlineComments } from '../lib/inline-guard.mjs';
import { publish } from '../publish.mjs';

const KEY = 'test-id-key';
const HEAD = 'c'.repeat(40);
const BASE = 'd'.repeat(40);
const OLD = 'e'.repeat(40);
const RUN = '2026-10-25T10:00:00Z';
const SEC_FILE = 'regroup/functions/src/callable/payments.ts';
const WORKFLOW = join(dirname(fileURLToPath(import.meta.url)), '../../../../.github/workflows/claude-code-review.yml');

const bot = (id, body, over = {}) => ({
  id,
  user: { login: 'github-actions[bot]' },
  body,
  commit_id: HEAD,
  original_commit_id: HEAD,
  created_at: '2026-10-25T10:05:00Z',
  path: 'regroup/mobile/src/a.ts',
  ...over,
});

function recorder() {
  const calls = [];
  return { calls, request: async (method, path) => (calls.push({ method, path }), null) };
}
const deleted = (r) => r.calls.filter((c) => c.method === 'DELETE').map((c) => Number(c.path.split('/').pop())).sort((a, b) => a - b);

async function guard(comments, over = {}) {
  const r = recorder();
  const res = await guardInlineComments({ repo: 'o/r', comments, findings: [], headSha: HEAD, runStartedAt: RUN, request: r.request, ...over });
  return { res, ids: deleted(r) };
}

test('an older comment whose commit_id moved to HEAD is kept', async () => {
  const moved = bot(1, 'old, no marker', { original_commit_id: OLD, created_at: '2026-10-24T09:00:00Z' });
  const { ids } = await guard([moved]);
  assert.deepEqual(ids, []);
});

test('an old-sha comment created after the run start is still not this run', async () => {
  const { ids } = await guard([bot(1, 'no marker', { original_commit_id: OLD })]);
  assert.deepEqual(ids, []);
});

test('a HEAD comment created before the run start is not this run', async () => {
  const { ids } = await guard([bot(1, 'no marker', { created_at: '2026-10-25T09:59:59Z' })]);
  assert.deepEqual(ids, []);
});

test('a github-actions[bot] thread reply without a fingerprint is kept', async () => {
  const { ids } = await guard([bot(1, 'Thanks, fixed in the next commit.', { in_reply_to_id: 99 })]);
  assert.deepEqual(ids, []);
});

test('a this-run top-level comment without a fingerprint is deleted', async () => {
  const { res, ids } = await guard([bot(1, 'no marker'), bot(2, 'ok <!-- pr-review:fp=c9:regroup/mobile/src/a.ts:load -->')]);
  assert.deepEqual(ids, [1]);
  assert.deepEqual({ removed: res.removed, failed: res.failed }, { removed: 1, failed: 0 });
});

test('human comments are never touched, whatever they say', async () => {
  const human = { ...bot(1, `no marker ${SEC_FILE}`, { in_reply_to_id: null }), user: { login: 'marcus' } };
  const { ids } = await guard([human]);
  assert.deepEqual(ids, []);
});

test('without a run start or head sha nothing counts as this run', async () => {
  assert.deepEqual((await guard([bot(1, 'no marker')], { runStartedAt: null })).ids, []);
  assert.deepEqual((await guard([bot(1, 'no marker')], { headSha: null })).ids, []);
});

// Parked minor 1
test('forced security holds if either the class or the slug prefix is a security class', () => {
  assert.equal(isForcedSecurity(9, 'c4:a.ts:x'), true);
  assert.equal(isForcedSecurity(4, 'c9:a.ts:x'), true);
  assert.equal(isForcedSecurity(9, 'c9:a.ts:x'), false);
  assert.equal(isForcedSecurity(9, 'c14:a.ts:x'), true);
  assert.equal(isForcedSecurity(9, 'c1x:a.ts:x'), false);
  const f = { slug: 'c4:regroup/mobile/src/a.ts:auth', class: 9, severity: 'Medium', confidence: 'high', security: false, package: 'regroup/mobile', area: 'auth', title: 't', feature: 'f', locations: [{ file: 'regroup/mobile/src/a.ts', line: 3, side: 'changed' }], why: 'w', fix: 'x', inlinePosted: true };
  const v = validateFindings(JSON.stringify({ reviewedSha: HEAD, findings: [f], resolvedSlugs: [], complete: true }));
  assert.equal(v.value.findings[0].security, true, 'slug prefix forces security in capFinding');
});

test('the guard deletes a comment whose finding is forced security by class alone', async () => {
  const f = { slug: 'c9:regroup/mobile/src/a.ts:auth', class: 4, security: true };
  const { ids } = await guard([bot(1, 'x <!-- pr-review:fp=c9:regroup/mobile/src/a.ts:auth -->')], { findings: [f] });
  assert.deepEqual(ids, [1]);
});

// Parked minor 3
const priorSec = { id: opaqueId(`c1:${SEC_FILE}:createCharge`, KEY), severity: 'High', status: 'open', security: true, runsSinceResolved: 0, fileIds: [fileId(SEC_FILE, KEY)] };
const snap = (over = {}) => ({ lastReviewedSha: OLD, lastBaseSha: BASE, ledger: [priorSec], linkTypesSeen: [], runLinkTypes: [], inlineSlugs: [], tier: 'incremental', maxTurns: 40, headSha: HEAD, baseSha: BASE, pr: 7, ...over });

async function publishWith(comments, over = {}) {
  const r = recorder();
  const deps = {
    listIssueComments: async () => [],
    upsertSummary: async () => {},
    deliverAdvisories: async () => ({ delivered: true, resolvedIds: [] }),
    listReviewComments: async () => comments,
    request: r.request,
  };
  const findingsText = JSON.stringify({ reviewedSha: HEAD, findings: [], resolvedSlugs: [], complete: true });
  const orig = console.log;
  console.log = () => {};
  try {
    await publish({ repo: 'o/r', pr: 7, snapshot: snap(), findingsText, narrative: '', outcome: 'success', headSha: HEAD, baseSha: BASE, idKey: KEY, runStartedAt: RUN, ...over }, deps);
  } finally {
    console.log = orig;
  }
  return deleted(r);
}

test('a comment body naming a prior security file (hashed fileIds) is deleted', async () => {
  const fp = '<!-- pr-review:fp=c9:regroup/mobile/src/a.ts:load -->';
  const comments = [
    bot(1, `See also ${SEC_FILE}, same pattern. ${fp}`),
    bot(2, `See ./${SEC_FILE.replace(/\//g, '%2F')}. ${fp}`),
    bot(3, `Unrelated regroup/mobile/src/b.ts. ${fp}`),
  ];
  assert.deepEqual(await publishWith(comments), [1, 2]);
});

test('without the key a prior fileId cannot match a body', async () => {
  const fp = '<!-- pr-review:fp=c9:regroup/mobile/src/a.ts:load -->';
  assert.deepEqual(await publishWith([bot(1, `See ${SEC_FILE}. ${fp}`)], { idKey: null }), []);
});

test('publish takes the run start from its input when the snapshot lacks it', async () => {
  assert.deepEqual(await publishWith([bot(1, 'no marker')]), [1]);
  assert.deepEqual(await publishWith([bot(1, 'no marker')], { runStartedAt: null }), []);
});

// R20 run start and R21 .git read denial, as wired in the workflow.
