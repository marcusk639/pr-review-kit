// Ledger continuity with recovery-platform's in-repo reviewer: a real summary
// comment (PR #126) must load unchanged and carry over without loss.
import { RP } from './helpers/rp.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeLedger, SUMMARY_MARKER } from '../lib/markers.mjs';
import { loadState } from '../lib/state.mjs';
import { composeBody } from '../publish.mjs';

const BODY = readFileSync(new URL('./fixtures/rp/summary-pr126.md', import.meta.url), 'utf8');
const original = decodeLedger(BODY);
const bot = { user: { login: 'github-actions[bot]' }, body: BODY };

test('the in-repo marker decodes in the kit', () => {
  assert.ok(BODY.startsWith(SUMMARY_MARKER));
  assert.match(original.lastReviewedSha, /^[0-9a-f]{40}$/);
  assert.ok(original.ledger.length > 0);
});

test('loadState reads the in-repo summary as prior state', async () => {
  const s = await loadState('o/r', 126, { listIssueComments: async () => [bot], listReviewComments: async () => [] });
  assert.equal(s.lastReviewedSha, original.lastReviewedSha);
  assert.deepEqual(s.ledger, original.ledger);
  assert.equal(s.priorUnavailable, undefined);
});

test('a kit run with nothing new carries the in-repo ledger over byte for byte (keyed or not)', () => {
  for (const idKey of [null, 'k']) {
    const state = { ...original, runLinkTypes: [], inlineSlugs: [], tier: 'none', maxTurns: 0, headSha: original.lastReviewedSha, baseSha: original.lastBaseSha, pr: 126 };
    const body = composeBody({ state, findingsText: null, narrative: null, outcome: 'skipped', headSha: original.lastReviewedSha, baseSha: original.lastBaseSha, idKey, linkTypes: RP.linkTypes });
    assert.deepEqual(decodeLedger(body).ledger, original.ledger);
  }
});
