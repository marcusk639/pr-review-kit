import './helpers/rp.mjs';
// I1: the model writes OUT/inline.json; publish validates it, pre-filters it
// with the guard's predicate and posts the survivors as one PR review.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseInline, selectInline, postInlineReview, MAX_INLINE } from '../lib/inline-post.mjs';
import { publish } from '../publish.mjs';

const FAKE_WHSEC = 'whsec' + '_' + 'A'.repeat(16);
const HEAD = 'c'.repeat(40);
const BASE = 'd'.repeat(40);
const OLD = 'e'.repeat(40);
const RUN = '2026-10-25T10:00:00Z';
const KEY = 'test-id-key';
const A = 'regroup/mobile/src/a.ts';
const B = 'regroup/mobile/src/b.ts';
const SEC_FILE = 'regroup/functions/src/callable/payments.ts';
const WORKFLOW = join(dirname(fileURLToPath(import.meta.url)), '../../../../.github/workflows/claude-code-review.yml');

const finding = (slug, over = {}) => ({
  slug, class: 9, severity: 'High', confidence: 'high', security: false, package: 'regroup/mobile', area: 'data',
  title: `Breaks ${slug}`, feature: 'Feed', locations: [{ file: A, line: 3, side: 'changed' }], why: 'w', fix: 'x', inlinePosted: false, ...over,
});
const HIGH = finding(`c9:${A}:load`);
const MED = finding(`c9:${B}:save`, { severity: 'Medium', locations: [{ file: B, line: 2, side: 'changed' }] });
const SEC = finding(`c1:${SEC_FILE}:charge`, { class: 1, security: true, locations: [{ file: SEC_FILE, line: 9, side: 'changed' }] });
const entry = (slug, over = {}) => ({ slug, path: A, line: 3, side: 'RIGHT', body: 'This breaks the feed. See b.ts:2.', ...over });

test('parseInline keeps every well-formed entry; selectInline caps at MAX_INLINE', () => {
  assert.deepEqual(parseInline('not json'), []);
  assert.deepEqual(parseInline('{"slug":"x"}'), []);
  const bad = [
    { ...entry(HIGH.slug), side: 'BOTH' },
    { ...entry(HIGH.slug), line: 0 },
    { ...entry(HIGH.slug), path: '' },
    { ...entry('not a slug') },
    { ...entry(HIGH.slug), body: '   ' },
    null,
  ];
  assert.deepEqual(parseInline(JSON.stringify(bad)), []);
  const many = Array.from({ length: 15 }, () => entry(HIGH.slug));
  assert.equal(parseInline(JSON.stringify(many)).length, 15, 'validated before any cap');
  assert.deepEqual(parseInline(JSON.stringify([{ ...entry(HIGH.slug), extra: 1 }])), [entry(HIGH.slug)]);
});

const select = (entries, over = {}) =>
  selectInline({ entries, findings: [HIGH, MED, SEC], changedFiles: [A, B, SEC_FILE], postedSlugs: [], isSecurityPath: (t) => t.includes('payments.ts'), ...over });

test('selectInline posts only Critical/High non-security findings on changed files, once', () => {
  const out = select([
    entry(HIGH.slug),
    entry(HIGH.slug), // duplicate
    entry(MED.slug, { path: B }), // Medium
    entry(SEC.slug, { path: SEC_FILE }), // security
    entry(`c9:${A}:unknown`), // no such finding
    entry(HIGH.slug, { path: 'not/in/pr.ts' }),
  ]);
  assert.deepEqual(out.map((c) => c.slug), [HIGH.slug]);
  assert.match(out[0].body, /<!-- pr-review:fp=c9:regroup\/mobile\/src\/a\.ts:load -->$/);
  assert.equal(select([entry(HIGH.slug, { path: 'not/in/pr.ts' })]).length, 0);
  assert.equal(select([entry(HIGH.slug)], { postedSlugs: [HIGH.slug] }).length, 0, 'already posted');
  assert.equal(select([entry(HIGH.slug)], { changedFiles: [] }).length, 0, 'no trusted file list: nothing posted');
});

test('selectInline applies the guard predicate first: secrets, security paths, forced classes', () => {
  assert.equal(select([entry(HIGH.slug, { body: `key ${FAKE_WHSEC}` })]).length, 0);
  assert.equal(select([entry(HIGH.slug, { body: `same as ${SEC_FILE}` })]).length, 0);
  const forced = finding(`c4:${A}:auth`, { class: 9 });
  assert.equal(select([entry(forced.slug)], { findings: [forced] }).length, 0, 'c4 slug prefix is security');
  // A model-written marker cannot ride along: HTML comments are neutralised.
  const [c] = select([entry(HIGH.slug, { body: 'x <!-- pr-review:fp=c9:other:y -->' })]);
  assert.equal((c.body.match(/<!--/g) ?? []).length, 1);
});

function recorder(fail = () => null) {
  const calls = [];
  const request = async (method, path, body) => {
    calls.push({ method, path, body });
    const err = fail(method, path, body);
    if (err) throw Object.assign(new Error('x'), { status: err });
    return { id: calls.length };
  };
  return { calls, request };
}

test('postInlineReview posts one COMMENT review on the head; a 422 retries comment by comment', async () => {
  const [c1] = select([entry(HIGH.slug)]);
  const c2 = { ...c1, slug: 'c9:x:y', line: 99 };
  const ok = recorder();
  const res = await postInlineReview({ repo: 'o/r', pr: 7, headSha: HEAD, comments: [c1, c2], request: ok.request });
  assert.equal(ok.calls.length, 1);
  assert.equal(ok.calls[0].path, '/repos/o/r/pulls/7/reviews');
  assert.equal(ok.calls[0].body.commit_id, HEAD);
  assert.equal(ok.calls[0].body.event, 'COMMENT');
  assert.deepEqual(Object.keys(ok.calls[0].body.comments[0]).sort(), ['body', 'line', 'path', 'side']);
  assert.deepEqual(res, { posted: [c1.slug, 'c9:x:y'], failed: 0 });
  const orig = console.log;
  console.log = () => {};
  try {
    const bad = recorder((m, p, b) => (b.comments.some((c) => c.line === 99) ? 422 : null));
    const r2 = await postInlineReview({ repo: 'o/r', pr: 7, headSha: HEAD, comments: [c1, c2], request: bad.request });
    assert.deepEqual(r2, { posted: [c1.slug], failed: 1 });
    assert.equal(bad.calls.length, 3);
  } finally {
    console.log = orig;
  }
  assert.deepEqual(await postInlineReview({ repo: 'o/r', pr: 7, headSha: null, comments: [c1], request: ok.request }), { posted: [], failed: 1 }, 'no head: counted as failed, never a silent zero');
});

const snap = (over = {}) => ({ lastReviewedSha: OLD, lastBaseSha: BASE, ledger: [], linkTypesSeen: [], runLinkTypes: [], inlineSlugs: [], tier: 'full', maxTurns: 60, headSha: HEAD, baseSha: BASE, pr: 7, changedFiles: [A, B, SEC_FILE], ...over });
const gha = (id, body, over = {}) => ({ id, user: { login: 'github-actions[bot]' }, body, commit_id: HEAD, original_commit_id: HEAD, created_at: '2026-10-25T10:05:00Z', path: A, ...over });

// Comments publish posts show up in later listings (as on GitHub), so the
// guard sees them; run() returns them as `posted`.
async function run(over = {}, comments = []) {
  const live = [...comments];
  const r = recorder((m, p, b) => {
    for (const c of m === 'POST' ? b?.comments ?? [] : []) live.push(gha(1000 + live.length, c.body, { path: c.path, created_at: '2026-10-25T10:06:00Z' }));
    return null;
  });
  let summary = null;
  const deps = {
    listIssueComments: async () => [],
    upsertSummary: async (repo, pr, body) => { summary = body; },
    deliverAdvisories: async () => ({ delivered: true, resolvedIds: [] }),
    listReviewComments: async () => [...live],
    request: r.request,
    report: () => {},
  };
  const findingsText = JSON.stringify({ reviewedSha: HEAD, findings: [HIGH, { ...MED, inlinePosted: true }, SEC], resolvedSlugs: [], complete: true });
  const inlineText = JSON.stringify([entry(HIGH.slug), entry(MED.slug, { path: B })]);
  const orig = console.log;
  console.log = () => {};
  try {
    await publish({ repo: 'o/r', pr: 7, snapshot: snap(), findingsText, inlineText, narrative: '', outcome: 'success', headSha: HEAD, baseSha: BASE, idKey: KEY, runStartedAt: RUN, ...over }, deps);
  } finally {
    console.log = orig;
  }
  return { calls: r.calls, summary, posted: live.slice(comments.length) };
}

test('publish posts inline.json survivors as a review and marks only those findings posted', async () => {
  const { calls, summary } = await run();
  const posts = calls.filter((c) => c.method === 'POST');
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].body.comments.map((c) => c.path), [A]);
  assert.match(summary, /Breaks c9:regroup\/mobile\/src\/a\.ts:load\*\* \(confidence: high\)( \(new\))? \(inline comment posted\)/);
  assert.doesNotMatch(summary, /Breaks c9:regroup\/mobile\/src\/b\.ts:save\*\*[^\n]*inline comment posted/, "the model's inlinePosted flag is ignored");
});

test('publish does not re-post a slug that already has a github-actions[bot] fp comment', async () => {
  const { calls } = await run({}, [gha(1, `old <!-- pr-review:fp=${HIGH.slug} -->`, { created_at: '2026-10-24T10:00:00Z', original_commit_id: OLD })]);
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
});

test('on a failed run inline.json is not posted and this-run unmarked github-actions[bot] comments are deleted', async () => {
  const { calls, summary } = await run({ outcome: 'failure', findingsText: null }, [
    gha(5, 'no marker'),
    gha(6, `ok <!-- pr-review:fp=${HIGH.slug} -->`),
    gha(7, 'older, no marker', { created_at: '2026-10-24T10:00:00Z' }),
    { ...gha(8, 'model reply, no marker'), user: { login: 'claude[bot]' } },
  ]);
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0, 'nothing posted');
  assert.deepEqual(calls.filter((c) => c.method === 'DELETE').map((c) => c.path), ['/repos/o/r/pulls/comments/5']);
  assert.match(summary, /review did not complete/);
});

test('findings.json may omit inlinePosted; a non-boolean value is still rejected', async () => {
  const { validateFindings } = await import('../lib/findings.mjs');
  const { inlinePosted, ...noFlag } = HIGH;
  assert.equal(validateFindings({ reviewedSha: HEAD, findings: [noFlag], resolvedSlugs: [] }).ok, true);
  assert.equal(validateFindings({ reviewedSha: HEAD, findings: [{ ...HIGH, inlinePosted: 'yes' }], resolvedSlugs: [] }).ok, false);
});

test('selectInline drops a finding the summary would withhold (it names a security file)', () => {
  const near = finding(`c9:${A}:near`, { why: `same flow as ${SEC_FILE}` });
  const out = selectInline({ entries: [entry(near.slug)], findings: [near, SEC], changedFiles: [A, SEC_FILE], postedSlugs: [] });
  assert.deepEqual(out, []);
  const clean = finding(`c9:${A}:clean`);
  assert.equal(selectInline({ entries: [entry(clean.slug)], findings: [clean, SEC], changedFiles: [A], postedSlugs: [] }).length, 1);
});
