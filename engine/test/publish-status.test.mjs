import { RP_DIR } from './helpers/rp.mjs';
// Round 3: publish never claims a review it did not finish, never posts for a
// head the PR has moved past, and makes every skip or failure visible
// (::warning:: plus one job-summary status line).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publish } from '../publish.mjs';
import { runPaths } from '../lib/paths.mjs';
import { SUMMARY_MARKER, decodeLedger, encodeLedger } from '../lib/markers.mjs';
import { stepSummary } from '../lib/status.mjs';

const HEAD = 'c'.repeat(40);
const NEWER = 'f'.repeat(40);
const BASE = 'd'.repeat(40);
const OLD = 'e'.repeat(40);
const KEY = 'test-id-key';
const BOT = { login: 'github-actions[bot]' };
const PUBLISH = join(dirname(fileURLToPath(import.meta.url)), '../run-publish.mjs');

const LOW = { slug: 'c9:regroup/mobile/src/a.ts:x', class: 9, severity: 'Low', confidence: 'high', security: false, package: 'regroup/mobile', area: 'data', title: 'Minor thing', feature: 'Feed', locations: [{ file: 'regroup/mobile/src/a.ts', line: 3, side: 'changed' }], why: 'w', fix: 'x' };
const SEC = { ...LOW, slug: 'c1:regroup/functions/src/pay.ts:charge', class: 1, severity: 'High', security: true, package: 'regroup/functions', area: 'payments', locations: [{ file: 'regroup/functions/src/pay.ts', line: 9, side: 'changed' }] };
const text = (over = {}) => JSON.stringify({ reviewedSha: HEAD, findings: [], resolvedSlugs: [], complete: true, ...over });
const snap = (over = {}) => ({ lastReviewedSha: OLD, lastBaseSha: BASE, ledger: [], linkTypesSeen: [], runLinkTypes: [], inlineSlugs: [], tier: 'full', maxTurns: 60, headSha: HEAD, baseSha: BASE, pr: 7, changedFiles: [], prDiffAvailable: true, unavailableChecks: [], ...over });

async function run(over = {}, depsOver = {}) {
  const posted = [];
  const logs = [];
  const reports = [];
  const calls = [];
  const deps = {
    listIssueComments: async () => [],
    upsertSummary: async (repo, pr, body) => posted.push(body),
    deliverAdvisories: async () => ({ delivered: true, resolvedIds: [] }),
    listReviewComments: async () => [],
    request: async (method, path, body) => {
      calls.push({ method, path, body });
      return method === 'GET' ? { head: { sha: HEAD } } : null;
    },
    report: (line) => reports.push(line),
    ...depsOver,
  };
  const orig = console.log;
  console.log = (m) => logs.push(String(m));
  let status;
  try {
    status = await publish({ repo: 'o/r', pr: 7, snapshot: snap(), findingsText: text(), narrative: '## Features touched\n- feed', outcome: 'success', headSha: HEAD, baseSha: BASE, idKey: KEY, ...over }, deps);
  } finally {
    console.log = orig;
  }
  return { posted, logs, reports, calls, status };
}

test('a completed review with no findings says "No issues found" and reports its status', async () => {
  const { posted, reports, status } = await run();
  assert.match(posted[0], /No issues found/);
  assert.deepEqual(reports, [status]);
  assert.match(status, /^summary updated: complete review; 0 inline comment\(s\) posted$/);
});

test('findings.json without complete: true is not a completed review', async () => {
  const { posted, status } = await run({ findingsText: text({ complete: undefined }) });
  assert.doesNotMatch(posted[0], /No issues found/);
  assert.match(posted[0], /review did not complete \(incomplete\)/);
  assert.match(status, /review did not complete \(incomplete\)/);
});

test('a missing summary.md (narrative null) is not a completed review', async () => {
  const { posted } = await run({ narrative: null });
  assert.match(posted[0], /review did not complete \(incomplete\)/);
});

test('an incomplete run delivers no advisories and posts no inline comments', async () => {
  let delivered = 0;
  const { calls } = await run({ findingsText: text({ complete: false }), inlineText: '[]' }, { deliverAdvisories: async () => { delivered++; return { delivered: true, resolvedIds: [] }; } });
  assert.equal(delivered, 0);
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
});

test('facts failure or a missing pr.diff labels the review partial, never "No issues found"', async () => {
  for (const s of [snap({ unavailableChecks: ['facts'] }), snap({ prDiffAvailable: false }), snap({ prDiffTruncated: true })]) {
    const { posted, status } = await run({ snapshot: s });
    assert.doesNotMatch(posted[0], /No issues found/);
    assert.match(posted[0], /\(full, partial review\): 0 reported this run; 0 still open from earlier reviews; partial review: the pre-checks were unavailable or the PR diff was missing or truncated/);
    assert.match(status, /partial review/);
  }
  const { posted } = await run({ snapshot: snap({ unavailableChecks: ['facts'] }), findingsText: text({ findings: [LOW] }) });
  assert.match(posted[0], /1 reported this run \(1 Low\);[^\n]*partial review/);
});

test('an older snapshot without prDiffAvailable is not partial', async () => {
  const s = snap();
  delete s.prDiffAvailable;
  const { posted } = await run({ snapshot: s });
  assert.match(posted[0], /No issues found/);
});

test('a run for a head the PR has moved past posts nothing and says superseded', async () => {
  let delivered = 0;
  const gets = [];
  const { posted, status, logs } = await run({ inlineText: '[]' }, {
    request: async (method, path) => {
      gets.push(method);
      return { head: { sha: NEWER } };
    },
    deliverAdvisories: async () => { delivered++; return { delivered: true }; },
  });
  assert.equal(posted.length, 0, 'no summary written');
  assert.equal(delivered, 0);
  assert.deepEqual(gets, ['GET']);
  assert.match(status, /^superseded: the PR head moved past cccccc/);
  assert.ok(logs.some((l) => l.startsWith('::notice::pr-review superseded')));
});

test('a failed head check does not block publishing', async () => {
  const { posted } = await run({}, { request: async () => { throw Object.assign(new Error('x'), { status: 502 }); } });
  assert.equal(posted.length, 1);
});

test('no trusted state and unreadable comments: warns and reports the skip', async () => {
  const boom = async () => { throw Object.assign(new Error('x'), { status: 502 }); };
  const { posted, logs, status } = await run({ snapshot: null }, { listIssueComments: boom });
  assert.equal(posted.length, 0);
  assert.ok(logs.some((l) => l.startsWith('::warning::pr-review summary not updated: no trusted state')));
  assert.match(status, /^skipped: no trusted state/);
});

test('prior state unavailable everywhere: checked before inline posting, advisories still delivered, warned', async () => {
  const boom = async () => { throw Object.assign(new Error('x'), { status: 502 }); };
  const posts = [];
  let delivered = 0;
  const { logs, status } = await run(
    { snapshot: snap({ priorUnavailable: true, priorUnavailableReason: 'comments-unreadable' }), findingsText: text({ findings: [LOW, SEC] }), inlineText: JSON.stringify([{ slug: LOW.slug, path: 'regroup/mobile/src/a.ts', line: 3, side: 'RIGHT', body: 'b' }]) },
    {
      listIssueComments: boom,
      listReviewComments: async () => { posts.push('listed'); return []; },
      deliverAdvisories: async () => { delivered++; return { delivered: true, resolvedIds: [] }; },
    },
  );
  assert.deepEqual(posts, [], 'the inline stage never ran');
  assert.equal(delivered, 1);
  assert.ok(logs.some((l) => l === '::warning::pr-review summary not updated: prior review state unavailable'));
  assert.match(status, /^skipped: prior review state unavailable; inline comments not posted; advisories ok$/);
});

test('an unexpected throw warns, posts the minimal banner with the old marker and reports it', async () => {
  const marker = encodeLedger({ lastReviewedSha: OLD, lastBaseSha: BASE, linkTypesSeen: [], ledger: [] });
  const old = { id: 1, user: BOT, body: `${SUMMARY_MARKER}\n\nold\n\n${marker}` };
  // A listing that is not an array throws inside the inline stage.
  const { posted, logs, status } = await run({}, { listIssueComments: async () => [old], listReviewComments: async () => ({}) });
  assert.ok(logs.some((l) => l === '::warning::pr-review publish failed (unknown); the summary may be stale'));
  assert.equal(posted.length, 1);
  assert.match(posted[0], /summary could not be updated for `ccccccc` \(status unknown\)/);
  assert.equal(decodeLedger(posted[0]).lastReviewedSha, OLD, 'old marker re-emitted');
  assert.equal(status, 'publish failed (unknown); minimal summary posted');
});

test('the catch-all banner is not posted when the old marker cannot be carried over', async () => {
  const old = { id: 1, user: BOT, body: `${SUMMARY_MARKER}\n\nold\n\n<!-- pr-review:ledger v1 *** -->` };
  const { posted, status } = await run({}, { listIssueComments: async () => [old], listReviewComments: async () => ({}) });
  assert.equal(posted.length, 0);
  assert.equal(status, 'publish failed (unknown)');
});

test('stepSummary appends one line to GITHUB_STEP_SUMMARY and is a no-op without it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prr-'));
  const file = join(dir, 'summary.md');
  stepSummary('summary updated: complete review', { GITHUB_STEP_SUMMARY: file });
  stepSummary('second', { GITHUB_STEP_SUMMARY: file });
  assert.equal(readFileSync(file, 'utf8'), 'pr-review: summary updated: complete review\npr-review: second\n');
  assert.doesNotThrow(() => stepSummary('x', {}));
});

test('runPaths needs both OUT and STATE_FILE', () => {
  assert.equal(runPaths({}), null);
  assert.equal(runPaths({ OUT: '/o' }), null);
  assert.equal(runPaths({ STATE_FILE: '/s' }), null);
  assert.deepEqual(runPaths({ OUT: '/o', STATE_FILE: '/s' }), { out: '/o', stateFile: '/s' });
});

test('publish main without OUT/STATE_FILE fails closed: warns, posts nothing, exits 0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prr-'));
  const summary = join(dir, 'step.md');
  cpSync(RP_DIR, join(dir, 'checkout/.claude/pr-review'), { recursive: true });
  // No network: every GitHub call fails, so the comment cannot be read either.
  const stub = 'data:text/javascript,globalThis.fetch=async()=>{throw new Error("offline")}';
  const out = execFileSync(process.execPath, ['--no-warnings', '--import', stub, PUBLISH], {
    env: { PATH: process.env.PATH, REPO: 'o/r', PR: '7', HEAD_SHA: HEAD, BASE_SHA: BASE, ACTION_OUTCOME: 'success', GITHUB_STEP_SUMMARY: summary, PR_REVIEW_PUBLISH: join(dir, 'checkout') },
    encoding: 'utf8',
  });
  assert.match(out, /::warning::pr-review OUT or STATE_FILE unset/);
  assert.match(out, /::warning::pr-review summary not updated: no trusted state/);
  assert.match(readFileSync(summary, 'utf8'), /^pr-review: skipped: no trusted state/);
});

test('the catch-all banner never creates a summary it did not find (a short listing must not cost the marker)', async () => {
  const { posted, status } = await run({}, { listIssueComments: async () => [], listReviewComments: async () => ({}) });
  assert.equal(posted.length, 0);
  assert.equal(status, 'publish failed (unknown)');
});

test('a failed head check warns and the status says the head was not verified', async () => {
  const { posted, logs, status } = await run({}, { request: async () => { throw Object.assign(new Error('x'), { status: 502 }); } });
  assert.equal(posted.length, 1);
  assert.ok(logs.some((l) => l === '::warning::pr-review head not verified (502); publishing without the stale-run check'));
  assert.match(status, /; head unverified$/);
});

test('an existing marker that does not decode to an object is never replaced by an empty ledger', async () => {
  const { encodeLedger: enc } = await import('../lib/markers.mjs');
  const arrayMarker = enc([1, 2]);
  const old = { id: 1, user: BOT, body: `${SUMMARY_MARKER}\n\nold\n\n<!-- pr-review:ledger v1 not*base64 -->` };
  const r1 = await run({ snapshot: null }, { listIssueComments: async () => [old] });
  assert.equal(r1.posted.length, 0);
  assert.match(r1.status, /^skipped: no trusted state/);
  const { loadState } = await import('../lib/state.mjs');
  for (const body of [`${SUMMARY_MARKER}\n\n${arrayMarker}`, old.body]) {
    const st = await loadState('o/r', 7, { listIssueComments: async () => [{ ...old, body }], listReviewComments: async () => [] });
    assert.equal(st.priorUnavailable, true, 'flagged, not "no history"');
  }
});

test('a re-emitted unreadable marker warns that the ledger is frozen', async () => {
  const BAD = '<!-- pr-review:ledger v1 bm90IGpzb24= -->';
  const { logs, status } = await run({ snapshot: snap({ priorUnavailable: true, priorRawMarker: BAD }) }, { listIssueComments: async () => [{ id: 1, user: BOT, body: `${SUMMARY_MARKER}\n\n${BAD}` }] });
  assert.ok(logs.some((l) => l.startsWith('::warning::pr-review ledger not updated')));
  assert.match(status, /ledger frozen \(prior state unreadable\)/);
});

test('an oversized old marker is not swapped for a new ledger: skipped with a warning', async () => {
  const huge = `<!-- pr-review:ledger v1 ${'A'.repeat(31000)} -->`;
  const { posted, status } = await run({ snapshot: snap({ priorUnavailable: true, priorRawMarker: huge }) }, { listIssueComments: async () => [] });
  assert.equal(posted.length, 0);
  assert.match(status, /^skipped: the old marker is too large to carry over/);
});

test('undelivered advisories and unposted inline comments warn and show in the status', async () => {
  const { logs, status } = await run(
    { findingsText: text({ findings: [SEC] }), inlineText: '[' },
    { deliverAdvisories: async () => ({ delivered: false, resolvedIds: [] }) },
  );
  assert.ok(logs.some((l) => l === '::warning::pr-review security advisories not delivered'));
  assert.ok(logs.some((l) => l === '::warning::pr-review 1 inline comment(s) not posted'));
  assert.match(status, /; 1 inline comment\(s\) not posted; advisories not delivered$/);
});

test('with routing.json unreadable (linkTypes null) prior link types are carried, not erased', async () => {
  const { priorPayload } = await import('../lib/prior.mjs');
  assert.deepEqual(priorPayload({ linkTypesSeen: ['callable', 7] }, KEY, null).linkTypesSeen, ['callable']);
  assert.deepEqual(priorPayload({ linkTypesSeen: ['callable', 'bogus'] }, KEY, ['callable']).linkTypesSeen, ['callable']);
});

test('publish main without a valid project config on base posts nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prr-'));
  const summary = join(dir, 'step.md');
  const stub = 'data:text/javascript,globalThis.fetch=async()=>{throw new Error("network used")}';
  const out = execFileSync(process.execPath, ['--no-warnings', '--import', stub, PUBLISH], {
    env: { PATH: process.env.PATH, REPO: 'o/r', PR: '7', HEAD_SHA: HEAD, BASE_SHA: BASE, ACTION_OUTCOME: 'success', GITHUB_STEP_SUMMARY: summary, PR_REVIEW_PUBLISH: dir },
    encoding: 'utf8',
  });
  assert.match(out, /::warning::pr-review project config missing or invalid on the base branch; nothing published/);
  assert.match(readFileSync(summary, 'utf8'), /^pr-review: skipped: project config missing or invalid/);
});
