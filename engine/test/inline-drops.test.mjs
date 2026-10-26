import './helpers/rp.mjs';
// Round 3: inline.json entries are validated before any cap, every drop is
// counted, a dropped Critical/High comment is announced in the summary, the
// real prior-security-file check runs in the pre-filter, a secret straddling
// the body cap never survives as a fragment, only a 422 is retried, and a
// comment the guard deleted is not reported as posted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_ENTRIES, MAX_INLINE, newDrops, postInlineReview, readInline, selectInline } from '../lib/inline-post.mjs';
import { runInline } from '../lib/inline-stage.mjs';
import { opaqueId } from '../lib/ledger.mjs';
import { fileId } from '../lib/fileids.mjs';
import { publish } from '../publish.mjs';

const FAKE_SK = 'sk' + '_live_' + 'A'.repeat(20);
const HEAD = 'c'.repeat(40);
const BASE = 'd'.repeat(40);
const OLD = 'e'.repeat(40);
const RUN = '2026-10-25T10:00:00Z';
const KEY = 'test-id-key';
const A = 'regroup/mobile/src/a.ts';
const B = 'regroup/mobile/src/b.ts';
const SEC_FILE = 'regroup/functions/src/callable/payments.ts';

const finding = (slug, over = {}) => ({
  slug, class: 9, severity: 'High', confidence: 'high', security: false, package: 'regroup/mobile', area: 'data',
  title: `Breaks ${slug}`, feature: 'Feed', locations: [{ file: A, line: 3, side: 'changed' }], why: 'w', fix: 'x', ...over,
});
const HIGH = finding(`c9:${A}:load`);
const HIGH_B = finding(`c9:${B}:save`, { locations: [{ file: B, line: 2, side: 'changed' }] });
const LOW = finding(`c9:${A}:minor`, { severity: 'Low' });
const entry = (slug, over = {}) => ({ slug, path: A, line: 3, side: 'RIGHT', body: 'This breaks the feed.', ...over });
const priorSec = { id: opaqueId(`c1:${SEC_FILE}:charge`, KEY), severity: 'High', status: 'open', security: true, runsSinceResolved: 0, fileIds: [fileId(SEC_FILE, KEY)] };
const snap = (over = {}) => ({ lastReviewedSha: OLD, lastBaseSha: BASE, ledger: [], linkTypesSeen: [], runLinkTypes: [], inlineSlugs: [], tier: 'full', maxTurns: 60, headSha: HEAD, baseSha: BASE, pr: 7, changedFiles: [A, B, SEC_FILE], prDiffAvailable: true, ...over });

function quiet(fn) {
  const orig = console.log;
  const logs = [];
  console.log = (m) => logs.push(String(m));
  return fn().then((v) => ({ v, logs }), (e) => { throw e; }).finally(() => { console.log = orig; });
}

// Posted comments become visible to the later listing, as on GitHub, so the guard sees them.
async function run({ findings = [HIGH], inline = [entry(HIGH.slug)], inlineText, snapshot = snap(), fail } = {}) {
  const live = [];
  const calls = [];
  let summary = null;
  const request = async (method, path, body) => {
    calls.push({ method, path, body });
    const code = fail?.(method, path, body);
    if (code) throw Object.assign(new Error('x'), { status: code });
    if (method === 'GET') return { head: { sha: HEAD } };
    for (const c of body?.comments ?? []) {
      live.push({ id: 100 + live.length, user: { login: 'github-actions[bot]' }, body: c.body, path: c.path, commit_id: HEAD, original_commit_id: HEAD, created_at: '2026-10-25T10:06:00Z' });
    }
    return null;
  };
  const deps = {
    listIssueComments: async () => [],
    upsertSummary: async (repo, pr, b) => { summary = b; },
    deliverAdvisories: async () => ({ delivered: true, resolvedIds: [] }),
    listReviewComments: async () => [...live],
    request,
    report: () => {},
  };
  const findingsText = JSON.stringify({ reviewedSha: HEAD, findings, resolvedSlugs: [], complete: true });
  await quiet(() => publish({ repo: 'o/r', pr: 7, snapshot, findingsText, inlineText: inlineText ?? JSON.stringify(inline), narrative: '', outcome: 'success', headSha: HEAD, baseSha: BASE, idKey: KEY, runStartedAt: RUN }, deps));
  return { calls, summary, live, posts: calls.filter((c) => c.method === 'POST') };
}

test('readInline validates every entry before capping and counts the bad ones', () => {
  const many = [{ slug: 'bad' }, ...Array.from({ length: 12 }, () => entry(HIGH.slug))];
  const r = readInline(JSON.stringify(many));
  assert.equal(r.entries.length, 12, 'a bad first entry does not push a good one out');
  assert.equal(r.invalid, 1);
  assert.deepEqual(r.invalidSlugs, ['bad']);
  assert.equal(readInline('{').malformed, true);
  assert.equal(readInline('{"a":1}').malformed, true);
  assert.equal(readInline(null).present, false);
  const huge = readInline(JSON.stringify(Array.from({ length: MAX_ENTRIES + 3 }, () => entry(HIGH.slug))));
  assert.equal(huge.entries.length, MAX_ENTRIES);
  assert.equal(huge.invalid, 3);
});

test('selectInline counts drops by reason; only path and over-cap drops are "lost"', () => {
  const drops = newDrops();
  const highs = Array.from({ length: MAX_INLINE + 2 }, (_, i) => finding(`c9:${A}:f${i}`));
  const out = selectInline({
    entries: [entry('c9:x.ts:nope'), entry(LOW.slug), entry(HIGH_B.slug, { path: 'not/changed.ts' }), ...highs.map((f) => entry(f.slug))],
    findings: [LOW, HIGH_B, ...highs],
    changedFiles: [A, B],
    postedSlugs: [],
    drops,
  });
  assert.equal(out.length, MAX_INLINE);
  assert.equal(drops.notFinding, 1);
  assert.equal(drops.ineligible, 1);
  assert.equal(drops.path, 1);
  assert.equal(drops.overCap, 2);
  assert.deepEqual(drops.lost, [HIGH_B.slug, highs[10].slug, highs[11].slug]);
});

test('a High comment outside the changed files is announced in the summary', async () => {
  const { posts, summary } = await run({ findings: [HIGH, HIGH_B], inline: [entry(HIGH.slug), entry(HIGH_B.slug, { path: 'elsewhere.ts' })] });
  assert.equal(posts.length, 1);
  assert.match(summary, /> 1 inline comment\(s\) for Critical or High findings were not posted/);
});

test('an empty changed-file list (facts failed) drops every comment and says so', async () => {
  const { posts, summary } = await run({ snapshot: snap({ changedFiles: [] }) });
  assert.equal(posts.length, 0);
  assert.match(summary, /> 1 inline comment\(s\) for Critical or High findings were not posted/);
});

test('a malformed inline.json is announced; an invalid entry naming a High finding counts as lost', async () => {
  const bad = await run({ inlineText: '[{"slug": ' });
  assert.match(bad.summary, /> inline\.json could not be read; no inline comments were posted/);
  const invalid = await run({ inline: [{ ...entry(HIGH.slug), side: 'BOTH' }] });
  assert.match(invalid.summary, /> 1 inline comment\(s\) for Critical or High findings were not posted/);
});

test('no notice when the only drops are intended (Low or not a finding)', async () => {
  const { summary } = await run({ findings: [HIGH, LOW], inline: [entry(LOW.slug), entry('c9:x.ts:nope')] });
  assert.doesNotMatch(summary, /were not posted|could not be read/);
});

test('pre-filter, end to end: a body or path naming a prior security file (hashed fileIds) is never posted', async () => {
  const snapshot = snap({ ledger: [priorSec] });
  const byBody = await run({ snapshot, inline: [entry(HIGH.slug, { body: `Same bug as ${SEC_FILE}.` })] });
  assert.equal(byBody.posts.length, 0, 'never posted, so nothing is emailed before the guard could delete it');
  const byPath = await run({ snapshot, inline: [entry(HIGH.slug, { path: SEC_FILE })] });
  assert.equal(byPath.posts.length, 0);
  const control = await run({ snapshot });
  assert.equal(control.posts.length, 1, 'an unrelated comment still posts');
});

test('a secret straddling the body cap drops the comment instead of leaking a fragment', async () => {
  const body = `${'x'.repeat(4000 - 12)} ${FAKE_SK}`;
  const out = selectInline({ entries: [entry(HIGH.slug, { body })], findings: [HIGH], changedFiles: [A], postedSlugs: [] });
  assert.equal(out.length, 0);
  // A long, secret-free body is cut, and the fp marker survives the cut.
  const [c] = selectInline({ entries: [entry(HIGH.slug, { body: 'y'.repeat(5000) })], findings: [HIGH], changedFiles: [A], postedSlugs: [] });
  assert.match(c.body, new RegExp(`^y{4000}\\n\\n<!-- pr-review:fp=${HIGH.slug.replace(/[.]/g, '\\.')} -->$`));
});

test('only a 422 is retried one comment at a time; a 5xx is not retried (no duplicates)', async () => {
  const comments = [entry(HIGH.slug, { body: 'a' }), entry(HIGH_B.slug, { path: B, body: 'b' })];
  for (const [code, n] of [[500, 1], [422, 3]]) {
    const calls = [];
    const request = async (m, p, b) => {
      calls.push(b);
      if (b.comments.length > 1 || code === 500) throw Object.assign(new Error('x'), { status: code });
      return null;
    };
    const { v } = await quiet(() => postInlineReview({ repo: 'o/r', pr: 7, headSha: HEAD, comments, request }));
    assert.equal(calls.length, n);
    if (code === 500) assert.deepEqual(v, { posted: [], failed: 2 });
    else assert.deepEqual(v.posted, [HIGH.slug, HIGH_B.slug]);
  }
});

test('a comment the guard deletes after posting is not reported as posted', async () => {
  let listing = 0;
  const secretAfter = { id: 9, user: { login: 'github-actions[bot]' }, body: `leaked ${FAKE_SK} <!-- pr-review:fp=${HIGH.slug} -->`, path: A, commit_id: HEAD, original_commit_id: HEAD, created_at: '2026-10-25T10:06:00Z' };
  const deleted = [];
  const deps = {
    listReviewComments: async () => (listing++ === 0 ? [] : [secretAfter]),
    request: async (method, path) => { if (method === 'DELETE') deleted.push(path); return null; },
  };
  const { v } = await quiet(() => runInline({ repo: 'o/r', pr: 7, snapshot: snap(), findings: [HIGH], inlineText: JSON.stringify([entry(HIGH.slug)]), idKey: KEY, headSha: HEAD, runStartedAt: RUN }, deps));
  assert.deepEqual(deleted, ['/repos/o/r/pulls/comments/9']);
  assert.equal(v.posted.has(HIGH.slug), false);
});

test('publish marks a posted comment, seen by the guard afterwards, as posted', async () => {
  const { summary, live } = await run();
  assert.equal(live.length, 1, 'the guard listed the posted comment');
  assert.match(summary, /\(inline comment posted\)/);
});

test('a failed inline post puts the post-failure notice in the summary and marks nothing posted', async () => {
  const { summary, posts } = await run({ fail: (m) => (m === 'POST' ? 502 : null) });
  assert.equal(posts.length, 1, 'a 502 is not retried');
  assert.match(summary, /> some inline comments could not be posted/);
  assert.doesNotMatch(summary, /\(inline comment posted\)/);
});

test('when the comment listing fails before posting, proposed comments are reported as not posted', async () => {
  const deps = { listReviewComments: async () => { throw Object.assign(new Error('x'), { status: 502 }); }, request: async () => null };
  const { v } = await quiet(() => runInline({ repo: 'o/r', pr: 7, snapshot: snap(), findings: [HIGH], inlineText: JSON.stringify([entry(HIGH.slug)]), idKey: KEY, headSha: HEAD, runStartedAt: RUN }, deps));
  assert.ok(v.notices.includes('> some inline comments could not be posted'));
  assert.equal(v.posted.size, 0);
});
