import './helpers/rp.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateFindings, securityPointer, safeArea } from '../lib/findings.mjs';
import { mergeLedger, sanitizeLedger, opaqueId } from '../lib/ledger.mjs';
import { fileId } from '../lib/fileids.mjs';
import { guardInlineComments } from '../lib/inline-guard.mjs';
import { composeBody, publish } from '../publish.mjs';
import { decodeLedger } from '../lib/markers.mjs';
import { WITHHELD_TITLE } from '../lib/render.mjs';

const KEY = 'test-id-key';
const HEAD = 'c'.repeat(40);
const BASE = 'd'.repeat(40);
const OLD = 'e'.repeat(40);
const SEC_FILE = 'regroup/functions/src/callable/payments.ts';
// Built at runtime so this source holds no secret-shaped literal.
const FAKE_SK = 'sk' + '_live_' + 'Z'.repeat(20);

function finding(over = {}) {
  return {
    slug: 'c9:regroup/mobile/src/a.ts:load',
    class: 9,
    severity: 'Medium',
    confidence: 'high',
    security: false,
    package: 'regroup/mobile',
    area: 'rent',
    title: 'Swallowed error',
    feature: 'Rent history',
    locations: [{ file: 'regroup/mobile/src/a.ts', line: 3, side: 'changed' }],
    why: 'catch ignores it',
    fix: 'rethrow',
    inlinePosted: false,
    ...over,
  };
}
const SEC = finding({ slug: `c1:${SEC_FILE}:createCharge`, class: 1, severity: 'High', security: true, title: 'Trusted client account', locations: [{ file: SEC_FILE, line: 30, side: 'changed' }] });
const text = (findings, reviewedSha = HEAD) => JSON.stringify({ reviewedSha, findings, resolvedSlugs: [], complete: true });

// I3
test('classes 1, 4, 7, 11 and 14 are forced security whatever the model said', () => {
  for (const cls of [1, 4, 7, 11, 14]) {
    const v = validateFindings(text([finding({ slug: `c${cls}:a.ts:x`, class: cls, security: false })]));
    assert.equal(v.value.findings[0].security, true, `class ${cls}`);
  }
  const keep = validateFindings(text([finding({ class: 9, security: false })]));
  assert.equal(keep.value.findings[0].security, false);
});

// I4
test('area is at most two lower-case [a-z0-9-] words, else general', () => {
  assert.equal(safeArea('payments'), 'payments');
  assert.equal(safeArea('Rent Payments'), 'rent payments');
  assert.equal(safeArea('stripe-webhook'), 'stripe-webhook');
  for (const bad of ['createCharge trusts accountId', 'payments.ts', 'auth: uid', 'x'.repeat(21), '', null]) assert.equal(safeArea(bad), 'general', String(bad));
  assert.equal(securityPointer({ severity: 'High', package: 'regroup/functions', area: 'trusts client accountId' }), 'Security-relevant issue (High) in regroup/functions general; details sent privately');
});

// I5
test('security ledger entries carry hashed fileIds and nothing else new', () => {
  const [e] = mergeLedger([], [SEC], [], 'full', { key: KEY });
  assert.deepEqual(Object.keys(e), ['id', 'severity', 'status', 'security', 'runsSinceResolved', 'fileIds']);
  assert.deepEqual(e.fileIds, [fileId(SEC_FILE, KEY)]);
  assert.match(e.fileIds[0], /^[0-9a-f]{16}$/);
  assert.deepEqual(mergeLedger([], [SEC], [], 'full', { key: null }), [], 'no key: no security entry');
});

test('sanitizeLedger keeps only valid fileIds, deduped and capped at 10', () => {
  const ids = Array.from({ length: 12 }, (_, i) => opaqueId(`f${i}`, KEY));
  const raw = { id: opaqueId('c1:x:y', KEY), severity: 'High', status: 'open', security: true, runsSinceResolved: 0, fileIds: [ids[0], ids[0], 'regroup/a.ts', 7, ...ids.slice(1)] };
  const [e] = sanitizeLedger([raw], KEY);
  assert.equal(e.fileIds.length, 10);
  assert.ok(e.fileIds.every((x) => /^[0-9a-f]{16}$/.test(x)));
  assert.equal(new Set(e.fileIds).size, 10);
  const [none] = sanitizeLedger([{ ...raw, fileIds: undefined }], KEY);
  assert.deepEqual(none.fileIds, []);
});

const priorSec = { id: opaqueId(SEC.slug, KEY), severity: 'High', status: 'open', security: true, runsSinceResolved: 0, fileIds: [fileId(SEC_FILE, KEY)] };
const snap = (over = {}) => ({ lastReviewedSha: OLD, lastBaseSha: BASE, ledger: [priorSec], linkTypesSeen: [], runLinkTypes: [], inlineSlugs: [], tier: 'incremental', maxTurns: 40, headSha: HEAD, baseSha: BASE, pr: 7, ...over });

test('a later non-security finding on a prior security file is withheld though the security one is not re-reported', () => {
  const near = finding({ slug: `c9:${SEC_FILE}:refund`, title: 'Refund swallow', locations: [{ file: SEC_FILE, line: 80, side: 'changed' }] });
  const narrative = `## Checked and fine\n- looked at ${SEC_FILE} again\n- callables ok`;
  const body = composeBody({ state: snap(), findingsText: text([near]), narrative, outcome: 'success', headSha: HEAD, baseSha: BASE, idKey: KEY });
  assert.ok(body.includes(WITHHELD_TITLE));
  assert.ok(!body.includes(SEC_FILE));
  assert.ok(!body.includes('payments.ts'));
  assert.ok(!body.includes('Refund swallow'));
  const m = decodeLedger(body);
  assert.ok(!JSON.stringify(m).includes('payments'), 'no plain path in the marker');
  const w = m.ledger.find((e) => e.id === opaqueId(near.slug, KEY));
  assert.equal(w.withheld, true);
  assert.deepEqual(m.ledger.find((e) => e.security).fileIds, priorSec.fileIds);
});

test('without the key prior fileIds do nothing; the prior security entry is carried unchanged', () => {
  const near = finding({ slug: 'c9:regroup/mobile/src/a.ts:x' });
  const body = composeBody({ state: snap(), findingsText: text([near]), narrative: '', outcome: 'success', headSha: HEAD, baseSha: BASE, idKey: null });
  assert.deepEqual(decodeLedger(body).ledger.filter((e) => e.security), [priorSec]);
});

// Minor: trusted head for lastReviewedSha.
test('lastReviewedSha is the trusted head, not the model-written reviewedSha', () => {
  const body = composeBody({ state: snap({ ledger: [] }), findingsText: text([], 'a'.repeat(40)), narrative: '', outcome: 'success', headSha: HEAD, baseSha: BASE, idKey: KEY });
  assert.equal(decodeLedger(body).lastReviewedSha, HEAD);
  assert.match(body, /Reviewed `ccccccc`/);
});

// I2
const RUN = '2026-10-25T10:00:00Z';
const bot = (id, body, over = {}) => ({ id, user: { login: 'github-actions[bot]' }, body, commit_id: HEAD, original_commit_id: HEAD, created_at: '2026-10-25T10:05:00Z', path: 'regroup/mobile/src/a.ts', ...over });

function recorder(failIds = []) {
  const calls = [];
  const request = async (method, path) => {
    calls.push({ method, path });
    if (failIds.some((id) => path.endsWith(`/${id}`))) throw Object.assign(new Error('x'), { status: 403 });
    return null;
  };
  return { calls, request };
}

test('the inline guard deletes security, forced-class, unmarked and secret-bearing comments only', async () => {
  const comments = [
    bot(1, `bad <!-- pr-review:fp=${SEC.slug} -->`),
    bot(2, 'fine <!-- pr-review:fp=c4:regroup/mobile/src/b.ts:auth -->'),
    bot(3, 'no marker at all'),
    bot(4, `leak ${FAKE_SK} <!-- pr-review:fp=c9:regroup/mobile/src/a.ts:load -->`),
    bot(5, 'ok <!-- pr-review:fp=c9:regroup/mobile/src/a.ts:load -->'),
    bot(6, 'on a security file <!-- pr-review:fp=c9:x.ts:y -->', { path: SEC_FILE }),
    { ...bot(7, 'no marker'), user: { login: 'mallory' } },
    bot(8, 'old run, no marker', { commit_id: OLD, original_commit_id: OLD, created_at: '2026-10-24T10:00:00Z' }),
  ];
  const r = recorder();
  const res = await guardInlineComments({ repo: 'o/r', comments, findings: [SEC], headSha: HEAD, runStartedAt: RUN, isSecurityPath: (p) => p === SEC_FILE, request: r.request });
  assert.deepEqual({ removed: res.removed, failed: res.failed }, { removed: 5, failed: 0 });
  assert.deepEqual(r.calls.map((c) => c.path).sort(), [1, 2, 3, 4, 6].map((id) => `/repos/o/r/pulls/comments/${id}`).sort());
  assert.ok(r.calls.every((c) => c.method === 'DELETE'));
});

test('a failed deletion is counted and publish adds a generic summary line', async () => {
  const posted = [];
  const r = recorder([3]);
  const deps = {
    listIssueComments: async () => [],
    upsertSummary: async (repo, pr, body) => posted.push(body),
    deliverAdvisories: async () => ({ delivered: true, resolvedIds: [] }),
    listReviewComments: async () => [bot(3, `no marker, mentions ${SEC_FILE}`)],
    request: r.request,
  };
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  try {
    await publish({ repo: 'o/r', pr: 7, snapshot: snap({ ledger: [], runStartedAt: RUN }), findingsText: text([]), narrative: '', outcome: 'success', headSha: HEAD, baseSha: BASE, idKey: KEY }, deps);
  } finally {
    console.log = orig;
  }
  assert.match(posted[0], /an inline comment could not be removed automatically; please review/);
  assert.ok(!posted[0].includes(SEC_FILE));
  assert.ok(logs.some((l) => l === 'inline guard: removed 0, failed 1'));
  assert.ok(!logs.join('\n').includes(SEC_FILE));
});

// I8
test('acknowledged non-security slugs are resolved in the ledger; security entries are not', () => {
  const open = { id: opaqueId('c9:a.ts:x', KEY), slug: 'c9:a.ts:x', title: 'Swallowed error', severity: 'Medium', status: 'open', security: false, runsSinceResolved: 0 };
  const state = snap({ ledger: [open, priorSec], acknowledgedSlugs: ['c9:a.ts:x', SEC.slug, 7] });
  const body = composeBody({ state, findingsText: text([]), narrative: '', outcome: 'success', headSha: HEAD, baseSha: BASE, idKey: KEY });
  const m = decodeLedger(body);
  assert.equal(m.ledger.find((e) => e.slug === 'c9:a.ts:x').status, 'resolved');
  assert.equal(m.ledger.find((e) => e.security).status, 'open');
  assert.match(body, /Swallowed error\*\* \(Medium, resolved this review\)/);
});
