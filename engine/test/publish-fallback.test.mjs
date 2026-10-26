import './helpers/rp.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publish } from '../publish.mjs';
import { SUMMARY_MARKER, decodeLedger, encodeLedger } from '../lib/markers.mjs';
import { opaqueId } from '../lib/ledger.mjs';

const KEY = 'test-id-key';
const HEAD = 'c'.repeat(40);
const BASE = 'd'.repeat(40);
const OLD = 'e'.repeat(40);
const OLDBASE = 'f'.repeat(40);
const BOT = { login: 'github-actions[bot]' };

const PRIOR = [
  { id: opaqueId('c9:a.ts:x', KEY), slug: 'c9:a.ts:x', title: 'Swallowed error', severity: 'Medium', status: 'open', security: false, runsSinceResolved: 0 },
  { id: opaqueId('c1:b.ts:y', KEY), severity: 'High', status: 'open', security: true, runsSinceResolved: 0, fileIds: [] },
];
const PAYLOAD = { lastReviewedSha: OLD, lastBaseSha: OLDBASE, linkTypesSeen: ['callable'], ledger: PRIOR };
const findingsText = JSON.stringify({ reviewedSha: HEAD, findings: [], resolvedSlugs: [], complete: true });

function run(comments, over = {}) {
  const posted = [];
  const deps = {
    listIssueComments: async () => {
      if (comments instanceof Error) throw comments;
      return comments;
    },
    upsertSummary: async (repo, pr, body) => posted.push(body),
  };
  const input = { repo: 'o/r', pr: 7, snapshot: null, findingsText, narrative: '', outcome: 'success', headSha: HEAD, baseSha: BASE, idKey: KEY, ...over };
  return publish(input, deps).then(() => posted);
}

const summary = (marker, user = BOT) => ({ user, body: `${SUMMARY_MARKER}\n\nold text\n\n${marker}` });

test('success without a trusted snapshot fails closed and keeps the prior comment ledger', async () => {
  const [body] = await run([summary(encodeLedger(PAYLOAD))]);
  assert.match(body, /review did not complete \(failed\)/);
  assert.doesNotMatch(body, /No issues found/);
  const m = decodeLedger(body);
  assert.deepEqual(m.ledger, PRIOR);
  assert.equal(m.lastReviewedSha, OLD);
  assert.equal(m.lastBaseSha, OLDBASE);
  assert.deepEqual(m.linkTypesSeen, ['callable']);
});

test('an invalid snapshot (array) is treated as missing, even for tier none', async () => {
  const [body] = await run([summary(encodeLedger(PAYLOAD))], { snapshot: [{ tier: 'none' }], outcome: 'skipped' });
  assert.match(body, /review did not complete \(failed\)/);
  assert.deepEqual(decodeLedger(body).ledger, PRIOR);
});

test('comment fetch failure posts nothing, so the old marker stays', async () => {
  const posted = await run(new Error('500'));
  assert.deepEqual(posted, []);
});

test('an undecodable existing marker is re-emitted verbatim', async () => {
  const marker = '<!-- pr-review:ledger v1 bm90IGpzb24= -->';
  const [body] = await run([summary(marker)]);
  assert.match(body, /review did not complete \(failed\)/);
  assert.ok(body.trimEnd().endsWith(marker));
});

test('a summary-looking comment from another author is ignored', async () => {
  const [body] = await run([summary(encodeLedger(PAYLOAD), { login: 'mallory' })]);
  assert.deepEqual(decodeLedger(body).ledger, []);
  assert.match(body, /review did not complete \(failed\)/);
});

test('a valid snapshot never fetches the comment', async () => {
  let fetched = false;
  const posted = [];
  await publish(
    { repo: 'o/r', pr: 7, snapshot: { ...PAYLOAD, tier: 'full' }, findingsText, narrative: '', outcome: 'success', headSha: HEAD, baseSha: BASE, idKey: KEY },
    { listIssueComments: async () => { fetched = true; return []; }, upsertSummary: async (r, p, b) => posted.push(b) },
  );
  assert.equal(fetched, false);
  assert.equal(decodeLedger(posted[0]).lastReviewedSha, HEAD);
});
