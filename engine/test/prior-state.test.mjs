import './helpers/rp.mjs';
// I3: an unreadable prior state never wipes the ledger. I7: a failed summary
// update is retried once with a minimal banner that keeps the previous marker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadState } from '../lib/state.mjs';
import { publish } from '../publish.mjs';
import { SUMMARY_MARKER, decodeLedger, encodeLedger } from '../lib/markers.mjs';
import { opaqueId } from '../lib/ledger.mjs';

const KEY = 'test-id-key';
const HEAD = 'c'.repeat(40);
const BASE = 'd'.repeat(40);
const OLD = 'e'.repeat(40);
const BOT = { login: 'github-actions[bot]' };
const PRIOR = [{ id: opaqueId('c9:a.ts:x', KEY), slug: 'c9:a.ts:x', title: 'Swallowed error', severity: 'Medium', status: 'open', security: false, runsSinceResolved: 0 }];
const PAYLOAD = { lastReviewedSha: OLD, lastBaseSha: BASE, linkTypesSeen: [], ledger: PRIOR };
const BAD_MARKER = '<!-- pr-review:ledger v1 bm90IGpzb24= -->'; // base64 of "not json"
const summary = (marker) => ({ id: 1, user: BOT, body: `${SUMMARY_MARKER}\n\nold\n\n${marker}` });
const none = async () => [];
const BANNER = /prior review state unavailable; findings history preserved unchanged/;

test('loadState flags a failed comment read and an undecodable marker as priorUnavailable', async () => {
  const boom = async () => { throw Object.assign(new Error('x'), { status: 502 }); };
  const failed = await loadState('o/r', 7, { listIssueComments: boom, listReviewComments: none });
  assert.equal(failed.priorUnavailable, true);
  assert.equal(failed.priorUnavailableReason, 'comments-unreadable');
  const bad = await loadState('o/r', 7, { listIssueComments: async () => [summary(BAD_MARKER)], listReviewComments: none });
  assert.equal(bad.priorUnavailable, true);
  assert.equal(bad.priorUnavailableReason, 'marker-undecodable');
  assert.equal(bad.priorRawMarker, BAD_MARKER);
  const ok = await loadState('o/r', 7, { listIssueComments: async () => [summary(encodeLedger(PAYLOAD))], listReviewComments: none });
  assert.equal(ok.priorUnavailable, undefined);
  assert.equal(ok.lastReviewedSha, OLD);
  const empty = await loadState('o/r', 7, { listIssueComments: none, listReviewComments: none });
  assert.equal(empty.priorUnavailable, undefined, 'no summary yet is not "unavailable"');
});

const snap = (over = {}) => ({ lastReviewedSha: null, lastBaseSha: null, ledger: [], linkTypesSeen: [], runLinkTypes: [], inlineSlugs: [], tier: 'full', maxTurns: 60, headSha: HEAD, baseSha: BASE, pr: 7, priorUnavailable: true, ...over });
const findingsText = JSON.stringify({ reviewedSha: HEAD, findings: [], resolvedSlugs: [], complete: true });

async function run({ comments, snapshot = snap(), upsert } = {}) {
  const posted = [];
  const logs = [];
  const deps = {
    listIssueComments: async () => {
      if (comments instanceof Error) throw comments;
      return comments ?? [];
    },
    upsertSummary: upsert ?? (async (repo, pr, body) => posted.push(body)),
    deliverAdvisories: async () => ({ delivered: true, resolvedIds: [] }),
  };
  const orig = console.log;
  console.log = (m) => logs.push(String(m));
  try {
    await publish({ repo: 'o/r', pr: 7, snapshot, findingsText, narrative: '', outcome: 'success', headSha: HEAD, baseSha: BASE, idKey: KEY }, deps);
  } finally {
    console.log = orig;
  }
  return { posted, logs };
}

test('priorUnavailable: publish re-reads the comment and uses a decodable marker', async () => {
  const { posted } = await run({ comments: [summary(encodeLedger(PAYLOAD))] });
  assert.equal(posted.length, 1);
  assert.deepEqual(decodeLedger(posted[0]).ledger, PRIOR);
  assert.doesNotMatch(posted[0], BANNER);
});

test('priorUnavailable: an undecodable marker is re-emitted verbatim with the banner line', async () => {
  const { posted } = await run({ comments: [summary(BAD_MARKER)] });
  assert.match(posted[0], BANNER);
  assert.ok(posted[0].trimEnd().endsWith(BAD_MARKER));
});

test('priorUnavailable: if the re-read fails too, the snapshot marker is re-emitted; with none, nothing is posted', async () => {
  const err = Object.assign(new Error('x'), { status: 502 });
  const { posted } = await run({ comments: err, snapshot: snap({ priorRawMarker: BAD_MARKER }) });
  assert.match(posted[0], BANNER);
  assert.ok(posted[0].trimEnd().endsWith(BAD_MARKER));
  const nothing = await run({ comments: err });
  assert.deepEqual(nothing.posted, [], 'no marker known: the old comment stays as it was');
  const forged = await run({ comments: err, snapshot: snap({ priorRawMarker: '<!-- not a marker -->' }) });
  assert.deepEqual(forged.posted, []);
});

test('a failed summary update is retried once with a minimal body keeping the previous marker', async () => {
  const bodies = [];
  const upsert = async (repo, pr, body) => {
    bodies.push(body);
    if (bodies.length === 1) throw Object.assign(new Error('x'), { status: 422 });
  };
  const { logs } = await run({ snapshot: snap({ priorUnavailable: undefined, lastReviewedSha: OLD, lastBaseSha: BASE, ledger: PRIOR }), upsert });
  assert.equal(bodies.length, 2);
  assert.ok(bodies[1].startsWith(SUMMARY_MARKER));
  assert.match(bodies[1], /⚠ summary could not be updated for `ccccccc` \(status 422\)/);
  const prev = decodeLedger(bodies[1]);
  assert.equal(prev.lastReviewedSha, OLD, 'the previous marker, not this run\'s');
  assert.deepEqual(prev.ledger, PRIOR);
  assert.ok(logs.includes('::warning::pr-review summary update failed (422)'));
});

test('a failed retry is logged by status only', async () => {
  const upsert = async () => { throw Object.assign(new Error('secret body'), { status: 403 }); };
  const { logs } = await run({ snapshot: snap({ priorUnavailable: undefined }), upsert });
  assert.ok(logs.includes('::warning::pr-review summary update failed (403)'));
  assert.ok(!logs.some((l) => l.includes('secret body')));
});

test('with the old marker re-emitted, the headline never says "No issues found"', async () => {
  const { posted } = await run({ comments: [summary(BAD_MARKER)] });
  assert.doesNotMatch(posted[0], /No issues found/);
  assert.match(posted[0], /prior findings could not be read; earlier open findings may still apply/);
  const failedSnap = snap({ priorRawMarker: BAD_MARKER });
  const deps = { listIssueComments: async () => { throw new Error('x'); }, upsertSummary: async (r, p, b) => out.push(b), deliverAdvisories: async () => ({ delivered: true, resolvedIds: [] }) };
  const out = [];
  await publish({ repo: 'o/r', pr: 7, snapshot: failedSnap, findingsText: null, narrative: '', outcome: 'failure', headSha: HEAD, baseSha: BASE, idKey: KEY }, deps);
  assert.match(out[0], /Prior findings could not be read; earlier open findings may still apply\./);
  assert.doesNotMatch(out[0], /No open findings were recorded/);
});

test('a summary missing on the re-read does not wipe a history facts saw: the old marker is re-emitted', async () => {
  const { posted } = await run({ comments: [], snapshot: snap({ priorUnavailableReason: 'marker-undecodable', priorRawMarker: BAD_MARKER }) });
  assert.equal(posted.length, 1);
  assert.ok(posted[0].endsWith(BAD_MARKER), 'old marker kept verbatim');
  assert.match(posted[0], BANNER);
  assert.doesNotMatch(posted[0], /No issues found/);
});

test('comments unreadable to facts and no summary on the re-read: a first review', async () => {
  const { posted } = await run({ comments: [], snapshot: snap({ priorUnavailableReason: 'comments-unreadable' }) });
  assert.match(posted[0], /No issues found/);
  assert.doesNotMatch(posted[0], BANNER);
});

test('tier none with an unreadable marker re-emits it instead of an empty ledger', async () => {
  const posted = [];
  const deps = { listIssueComments: async () => [summary(BAD_MARKER)], upsertSummary: async (r, p, b) => posted.push(b), deliverAdvisories: async () => ({ delivered: true, resolvedIds: [] }), report: () => {} };
  const orig = console.log;
  console.log = () => {};
  try {
    await publish({ repo: 'o/r', pr: 7, snapshot: snap({ tier: 'none', priorUnavailableReason: 'marker-undecodable', priorRawMarker: BAD_MARKER }), findingsText: null, narrative: null, outcome: 'skipped', headSha: HEAD, baseSha: BASE, idKey: KEY }, deps);
  } finally {
    console.log = orig;
  }
  assert.ok(posted[0].endsWith(BAD_MARKER));
  assert.match(posted[0], BANNER);
  assert.match(posted[0], /Prior findings could not be read/);
});
